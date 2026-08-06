/* The courier: the frame, the checksum, the mixed radix, and every failure it promises to
   report rather than swallow. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEC_VERSION,
  CourierError,
  Session,
  advance,
  b64urlToBytes,
  bytesToB64url,
  codeLengthBound,
  crc16,
  packDigits,
  unpack,
} from '../src/courier.mjs';
import { reversi, flipsFor, cellName } from '../src/reversi.mjs';

/* A tiny deterministic generator, so a failing property test is reproducible. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function playout(seed, { greedy = false } = {}) {
  const next = rng(seed);
  const s = new Session(reversi);
  while (!s.over) {
    const legal = s.legalMoves();
    let pick = legal[Math.floor(next() * legal.length)];
    if (greedy) {
      let best = -1;
      for (const m of legal) {
        const f = flipsFor(s.state.cells, m, s.state.turn).length;
        if (f > best) {
          best = f;
          pick = m;
        }
      }
    }
    s.play(pick);
  }
  return s;
}

test('base64url round trips every byte value and rejects anything outside its alphabet', () => {
  for (let length = 0; length < 40; length++) {
    const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + length * 11) & 255);
    assert.deepEqual([...b64urlToBytes(bytesToB64url(bytes))], [...bytes], `length ${length}`);
  }
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual([...b64urlToBytes(bytesToB64url(all))], [...all]);
  const text = bytesToB64url(all);
  assert.ok(!/[+/=]/.test(text), 'the alphabet must be URL safe and unpadded');
  assert.throws(() => b64urlToBytes('AB+D'), /not part of a code/);
  assert.throws(() => b64urlToBytes('AB=D'), /not part of a code/);
  assert.throws(() => b64urlToBytes('ABCDE'), /cannot be 5 characters/);
});

test('the decoder refuses spare bits, so no two codes mean the same bytes', () => {
  // A three character group holds two bytes and two bits that decode to nothing. 'AAA' has
  // them clear, 'AAB' and 'AAC' do not, and without the check all three would decode to the
  // same two zero bytes. That would make a corrupted character a silent alias.
  assert.deepEqual([...b64urlToBytes('AAA')], [0, 0]);
  assert.throws(() => b64urlToBytes('AAB'), /bits that cannot be part of it/);
  assert.throws(() => b64urlToBytes('AAC'), /bits that cannot be part of it/);
  assert.deepEqual([...b64urlToBytes('AA')], [0]);
  assert.throws(() => b64urlToBytes('AB'), /bits that cannot be part of it/);
  // Every string this encoder emits must survive its own decoder.
  for (let length = 0; length < 40; length++) {
    const bytes = Uint8Array.from({ length }, (_, i) => (i * 91 + 7) & 255);
    assert.deepEqual([...b64urlToBytes(bytesToB64url(bytes))], [...bytes]);
  }
});

test('crc16 is the published CCITT-FALSE and it moves on a one bit change', () => {
  assert.equal(crc16(new TextEncoder().encode('123456789')), 0x29b1, 'the standard check value');
  assert.equal(crc16(Uint8Array.from([])), 0xffff);
  assert.notEqual(crc16(Uint8Array.from([1, 2, 3])), crc16(Uint8Array.from([1, 2, 2])));
});

test('a fresh session is the opening position and its code is the shortest one', () => {
  const s = new Session(reversi);
  assert.equal(s.digits.length, 0);
  assert.equal(s.history.length, 0);
  assert.equal(s.legalMoves().length, 4);
  const { version, gameId, acc } = unpack(s.code);
  assert.equal(version, CODEC_VERSION);
  assert.equal(gameId, reversi.id);
  assert.equal(acc, 1n, 'no moves means the accumulator is nothing but the sentinel');
});

test('a played game round trips to the same code, the same board and the same history', () => {
  let checked = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const played = playout(seed);
    const code = played.code;
    const back = Session.fromCode(reversi, code);
    assert.equal(back.code, code, `seed ${seed}: re-encoding a decoded game must be identical`);
    assert.deepEqual([...back.state.cells], [...played.state.cells], `seed ${seed}: board`);
    assert.equal(back.state.turn, played.state.turn);
    assert.deepEqual(back.digits, played.digits);
    assert.deepEqual(
      back.history.map((h) => `${h.kind}:${h.by}:${h.move ?? ''}`),
      played.history.map((h) => `${h.kind}:${h.by}:${h.move ?? ''}`),
      `seed ${seed}: history`,
    );
    assert.equal(back.over, true);
    checked++;
  }
  assert.equal(checked, 60);
});

test('a game part way through round trips too, not only a finished one', () => {
  const played = playout(7);
  const partial = new Session(reversi);
  const wanted = played.history.filter((h) => h.kind === 'move').slice(0, 12);
  for (const h of wanted) {
    if (partial.over) break;
    if (partial.legalMoves().includes(h.move)) partial.play(h.move);
  }
  assert.ok(partial.digits.length >= 8, 'the partial game must actually have moves in it');
  assert.equal(Session.fromCode(reversi, partial.code).code, partial.code);
  assert.equal(partial.over, false);
});

test('forced moves and passes cost nothing, and the reader plays them back', () => {
  let withForced = 0;
  let withPass = 0;
  let derived = 0;
  let decisions = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const s = playout(seed);
    const forced = s.history.filter((h) => h.kind === 'forced').length;
    const passes = s.history.filter((h) => h.kind === 'pass').length;
    if (forced > 0) withForced++;
    if (passes > 0) withPass++;
    derived += forced + passes;
    decisions += s.digits.length;
    assert.equal(s.history.length - s.digits.length, forced + passes,
      'every ply is either a recorded decision or a derived one');
    // The decoder must reproduce them from the rules alone.
    const back = Session.fromCode(reversi, s.code);
    assert.equal(back.history.filter((h) => h.kind === 'forced').length, forced);
    assert.equal(back.history.filter((h) => h.kind === 'pass').length, passes);
  }
  assert.ok(withForced > 10, `only ${withForced} of 60 games had a forced move, the sample is too thin`);
  assert.ok(withPass > 0, 'no game in the sample contained a pass');
  // Measured over these 60 games, roughly 3.4 percent of plies are derived rather than sent.
  // The floor is set well below that so it fails on a real regression and not on noise.
  assert.ok(derived > 0.02 * decisions,
    `only ${derived} derived plies against ${decisions} recorded ones, the saving is not being exercised`);
});

test('a digit is only spent where there is a real choice', () => {
  const s = playout(3);
  const replay = new Session(reversi);
  let at = 0;
  for (const h of s.history) {
    if (h.kind !== 'move') continue;
    const legal = replay.legalMoves();
    assert.ok(legal.length >= 2, 'a recorded decision always had at least two options');
    assert.equal(replay.digits.length, at);
    replay.play(h.move);
    at++;
  }
  assert.equal(replay.code, s.code);
});

test('a truncated code is refused instead of decoding into a shorter game', () => {
  const s = playout(11);
  const code = s.code;
  assert.doesNotThrow(() => Session.fromCode(reversi, code), 'the intact code must load');
  let refused = 0;
  for (let cut = 1; cut < code.length - 4; cut++) {
    const short = code.slice(0, code.length - cut);
    try {
      Session.fromCode(reversi, short);
    } catch (err) {
      assert.ok(err instanceof CourierError);
      refused++;
    }
  }
  assert.equal(refused, code.length - 5, 'every truncation must be refused');
});

test('changing one character of a code is caught by the checksum almost always, and never yields an illegal game', () => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const code = playout(23).code;
  let tried = 0;
  let caught = 0;
  const survivors = [];
  for (let i = 0; i < code.length; i++) {
    for (const ch of alphabet) {
      if (ch === code[i]) continue;
      const bad = code.slice(0, i) + ch + code.slice(i + 1);
      tried++;
      try {
        const s = Session.fromCode(reversi, bad);
        // If it decodes at all it must be a legal game, because every digit was read against
        // a freshly generated legal move list. This is the structural claim, so test it.
        survivors.push(s);
        assert.equal(Session.fromCode(reversi, s.code).code, s.code);
      } catch (err) {
        assert.ok(err instanceof CourierError, `unexpected error type: ${err}`);
        caught++;
      }
    }
  }
  assert.ok(tried > 1000, `only ${tried} single character changes were tried`);
  // A 16 bit checksum lets roughly one in 65536 through, and anything that does get through is
  // still a legal game rather than a broken board. Relative, not absolute: with this few trials
  // the expected number of survivors is well under one, so 99.9 percent is a loose floor that
  // still fails hard if the checksum stops being consulted at all.
  assert.ok(caught / tried > 0.999, `only ${((caught / tried) * 100).toFixed(2)} percent were refused`);
  for (const s of survivors) assert.ok(s.digits.every(([radix, index]) => index < radix));
});

test('a code for another game, another version, or another format is refused by name', () => {
  const s = playout(5);
  const bytes = b64urlToBytes(s.code);
  const reframe = (mutate) => {
    const body = Uint8Array.from(bytes.subarray(0, bytes.length - 2));
    mutate(body);
    const sum = crc16(body);
    return bytesToB64url(Uint8Array.from([...body, (sum >> 8) & 255, sum & 255]));
  };
  assert.throws(() => Session.fromCode(reversi, reframe((b) => { b[0] = 99; })), /format 99/);
  assert.throws(() => Session.fromCode(reversi, reframe((b) => { b[1] = 42; })), /game 42/);
  assert.throws(() => Session.fromCode(reversi, ''), /no code here/);
  assert.throws(() => Session.fromCode(reversi, 'AQ'), /at least 5 bytes/);
  assert.doesNotThrow(() => Session.fromCode(reversi, reframe(() => {})), 'reframing alone must be harmless');
});

test('a code carrying moves past the end of the game is refused', () => {
  const finished = playout(31);
  assert.equal(finished.over, true);
  const overrun = packDigits(reversi, [...finished.digits, [4, 3]]);
  assert.throws(() => Session.fromCode(reversi, overrun), /after the game ended/);
  assert.doesNotThrow(() => Session.fromCode(reversi, finished.code));
});

test('a link carries the code in the fragment and survives being pasted back whole', () => {
  const s = playout(9);
  const link = s.link('https://example.invalid/passing-notes/#g=OLDCODE');
  assert.equal(link, `https://example.invalid/passing-notes/#g=${s.code}`);
  assert.equal(Session.fromCode(reversi, link).code, s.code, 'a whole pasted link loads');
  assert.equal(Session.fromCode(reversi, `  ${s.code}\n`).code, s.code, 'stray whitespace is tolerated');
  assert.equal(Session.fromCode(reversi, s.code).code, s.code);
});

test('extendsFrom accepts a continuation and refuses a rewind or a different game', () => {
  const a = playout(13);
  const shorter = a.digits.slice(0, 10);
  assert.equal(a.extendsFrom(shorter), true, 'the past of this game is accepted');
  assert.equal(a.extendsFrom(a.digits), true, 'the same game is accepted');
  assert.equal(a.extendsFrom([...a.digits, [4, 0]]), false, 'a longer list is not our past');
  const forked = [...shorter];
  forked[9] = [forked[9][0], (forked[9][1] + 1) % forked[9][0]];
  assert.equal(a.extendsFrom(forked), false, 'a divergent history is refused');
});

test('an illegal move is refused with the move named', () => {
  const s = new Session(reversi);
  assert.throws(() => s.play(0), /a1 is not a legal move/);
  assert.doesNotThrow(() => s.play(s.legalMoves()[0]));
  const finished = playout(17);
  assert.throws(() => finished.play(0), /the game has ended/);
});

test('the code length bound is real, and no random game gets anywhere near breaking it', () => {
  const bound = codeLengthBound(reversi);
  assert.equal(bound.bits, Math.ceil(reversi.branchBoundLog2()) + 1);
  let longest = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const length = playout(seed).code.length;
    longest = Math.max(longest, length);
    assert.ok(length <= bound.chars, `seed ${seed} produced ${length} characters against a bound of ${bound.chars}`);
  }
  assert.ok(longest > 0.4 * bound.chars,
    `the longest of 200 games was ${longest} characters against a bound of ${bound.chars}, ` +
      'which would make the bound too loose to be interesting');
});

test('a code that would be too long to send is refused loudly rather than truncated', () => {
  // A synthetic game with a wide, fixed branching factor, purely to drive the guard. The
  // point of the guard is games that are not Reversi.
  const wide = {
    id: 200,
    name: 'wide',
    maxPlies: 4000,
    initial: () => ({ ply: 0 }),
    mover: (s) => (s.ply % 2) + 1,
    legalMoves: (s) => (s.ply < 600 ? Array.from({ length: 64 }, (_, i) => i) : []),
    apply: (s) => ({ ply: s.ply + 1 }),
    pass: (s) => ({ ply: s.ply + 1 }),
    isOver: (s) => s.ply >= 600,
    eq: (a, b) => a === b,
    moveName: (m) => String(m),
    branchBoundLog2: () => 600 * Math.log2(64),
  };
  const s = new Session(wide, { maxCodeLength: 512 });
  for (let i = 0; i < 600; i++) s.play(i % 64);
  assert.throws(() => s.code, (err) => {
    assert.equal(err.code, 'CODE_TOO_LONG');
    assert.ok(err.length > 512, `the refused length was ${err.length}`);
    assert.match(err.message, /Nothing was truncated/);
    return true;
  });
  assert.equal(codeLengthBound(wide).chars > 512, true, 'and the bound said so before a move was played');
  // The same game under a raised limit encodes and round trips, so the guard is a limit and
  // not a bug in the encoder.
  const roomy = packDigits(wide, s.digits, { maxCodeLength: 4000 });
  assert.ok(roomy.length > 512);
  assert.equal(Session.fromCode(wide, roomy, { maxCodeLength: 4000 }).digits.length, s.digits.length);
});

test('advance refuses to spin forever on a game that never ends', () => {
  const stuck = {
    id: 201,
    name: 'stuck',
    maxPlies: 10,
    initial: () => ({}),
    mover: () => 1,
    legalMoves: () => [],
    apply: (s) => s,
    pass: (s) => s,
    isOver: () => false,
    eq: (a, b) => a === b,
    moveName: () => 'x',
    branchBoundLog2: () => 1,
  };
  assert.throws(() => advance(stuck, stuck.initial()), /did not reach an end within 10 plies/);
});

test('packDigits refuses a digit that carries no information or is out of range', () => {
  assert.throws(() => packDigits(reversi, [[1, 0]]), /carries no information/);
  assert.throws(() => packDigits(reversi, [[4, 4]]), /outside its radix/);
  assert.doesNotThrow(() => packDigits(reversi, [[4, 3]]));
});
