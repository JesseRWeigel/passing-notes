#!/usr/bin/env node
/* A deterministic dump of everything src/ computes, and nothing else.
 *
 * This exists for the sabotage stage in verify.sh. Before deciding whether a check caught an
 * attack, the attack has to be shown to have changed something, and comparing this dump
 * before and after is how. It asserts nothing, so it cannot fail and hide a change.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEC_VERSION, Session, codeLengthBound, crc16, bytesToB64url } from '../src/courier.mjs';
import { cellName, countDiscs, flipsFor, initialCells, movesFor, reversi } from '../src/reversi.mjs';
import { RTC_SIGNAL_VERSION, packSignal, rtcHonesty, rtcSupported, unpackSignal } from '../src/rtc.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = [];
const say = (line) => out.push(line);

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const bound = codeLengthBound(reversi);
say(`bound ${bound.bits} ${bound.bytes} ${bound.chars}`);
say(`crc 123456789 -> ${crc16(new TextEncoder().encode('123456789')).toString(16)}`);
say(`b64 ${bytesToB64url(Uint8Array.from({ length: 32 }, (_, i) => i * 7))}`);
say(`opening black ${movesFor(initialCells(), 1).map(cellName).join(',')}`);
say(`opening white ${movesFor(initialCells(), 2).map(cellName).join(',')}`);
say(`opening discs ${JSON.stringify(countDiscs(initialCells()))}`);

for (let seed = 1; seed <= 12; seed++) {
  const next = rng(seed);
  const s = new Session(reversi);
  while (!s.over) {
    const legal = s.legalMoves();
    s.play(legal[Math.floor(next() * legal.length)]);
  }
  const board = [...s.state.cells].map((c) => '.bw'[c]).join('');
  const back = Session.fromCode(reversi, s.code);
  say(
    `seed ${seed} code=${s.code} plies=${s.history.length} digits=${s.digits.length} ` +
      `winner=${reversi.winner(s.state)} score=${JSON.stringify(reversi.score(s.state))} ` +
      `roundtrip=${back.code === s.code} board=${board}`,
  );
}

// Deterministic policy: the same one the browser harness uses, so this dump moves whenever
// the recorded game would.
{
  const s = new Session(reversi);
  while (!s.over) {
    const legal = s.legalMoves();
    s.play(s.state.turn === 1 ? legal[0] : legal[legal.length - 1]);
  }
  say(`harness code=${s.code} plies=${s.history.length} digits=${s.digits.length} winner=${reversi.winner(s.state)}`);
  say(`harness board=${[...s.state.cells].map((c) => '.bw'[c]).join('')}`);
  say(`harness auto=${s.history.filter((h) => h.kind !== 'move').map((h) => `${h.kind}:${h.by}:${h.move ?? '-'}`).join(',')}`);
}

// Replaying the committed fixture through src/, which is the leg the browser and Python both
// have to agree with.
{
  const fixture = JSON.parse(readFileSync(join(root, 'fixtures', 'recorded-game.json'), 'utf8'));
  try {
    const s = Session.fromCode(reversi, fixture.code);
    say(`fixture board=${[...s.state.cells].map((c) => '.bw'[c]).join('')}`);
    say(`fixture plies=${s.history.length} digits=${s.digits.length} winner=${reversi.winner(s.state)} score=${JSON.stringify(reversi.score(s.state))}`);
    say(`fixture decisions=${s.history.filter((h) => h.kind === 'move').map((h) => h.move).join(',')}`);
  } catch (err) {
    say(`fixture REJECTED ${err.code}: ${err.message}`);
  }
}

/* Every refusal the codec promises, exercised. Without this a change that stops a guard from
   being consulted would leave this dump identical, and the sabotage stage would have to call
   it a no-op. */
{
  const s = new Session(reversi);
  for (const move of [19, 18, 17, 21, 34]) if (!s.over && s.legalMoves().includes(move)) s.play(move);
  const good = s.code;
  const bytes = [...Uint8Array.from([1, 1])];
  const reframe = (version, gameId) => {
    const body = Uint8Array.from([version, gameId, 0x0a, 0x2b]);
    const sum = crc16(body);
    return bytesToB64url(Uint8Array.from([...body, (sum >> 8) & 255, sum & 255]));
  };
  /* Two probes below are built rather than written out, because a hand-typed constant tends to
     fail for the wrong reason. Both were added after scripts/sabotage.py reported that removing
     the guard they exercise changed nothing measurable, which meant the dump could not see the
     guard at all. A sabotage that proves nothing is a hole in the measurement, not in the code. */

  /* Spare bits set in the final character. Base64 discards them, so with the guard removed this
     decodes to the SAME bytes as the code it was built from, which is the silent-alias failure.
     The guard makes it an error instead.

     Spare bits only exist when the code's length mod 4 is 2 or 3, and `good` happened to have
     neither, so the first version of this probe quietly fell back to a placeholder and tested
     nothing. Search for a code that can carry the probe instead of assuming one, and say so
     loudly if none turns up rather than emitting a string that fails for an unrelated reason. */
  const alias = (() => {
    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const walk = new Session(reversi);
    for (let step = 0; step < 40 && !walk.over; step++) {
      walk.play(walk.legalMoves()[0]);
      const code = walk.code;
      const mod = code.length % 4;
      if (mod !== 2 && mod !== 3) continue;
      const spare = mod === 2 ? 0b1111 : 0b11;
      const last = B64.indexOf(code[code.length - 1]);
      if (last < 0 || (last & spare) !== 0) continue;
      return { code, probe: code.slice(0, -1) + B64[last | spare] };
    }
    return null;
  })();

  // An accumulator of zero. The encoder starts at the sentinel 1 and can never emit this, so it
  // must be refused. Without the sentinel check it decodes as an empty game, giving two codes
  // for one position.
  const notCanonical = (() => {
    const body = Uint8Array.from([CODEC_VERSION, reversi.id, 0]);
    const sum = crc16(body);
    return bytesToB64url(Uint8Array.from([...body, (sum >> 8) & 255, sum & 255]));
  })();

  const cases = [
    ['good', good],
    ['truncated', good.slice(0, -2)],
    ['one-char-changed', `${good.slice(0, 4)}${good[4] === 'A' ? 'B' : 'A'}${good.slice(5)}`],
    ['spare-bits-set', 'AAB'],
    ['spare-bits-alias-source', alias ? alias.code : 'NO CODE IN THIS GAME COULD CARRY THE PROBE'],
    ['spare-bits-alias', alias ? alias.probe : 'NO CODE IN THIS GAME COULD CARRY THE PROBE'],
    ['zero-accumulator', notCanonical],
    ['wrong-version', reframe(7, 1)],
    ['wrong-game', reframe(1, 7)],
    ['empty', ''],
    ['junk', '****'],
    ['too-short', 'AQ'],
  ];
  for (const [label, code] of cases) {
    try {
      const decoded = Session.fromCode(reversi, code);
      say(`decode ${label} -> ok digits=${decoded.digits.length} plies=${decoded.history.length}`);
    } catch (err) {
      say(`decode ${label} -> ${err.code}`);
    }
  }
  say(`header bytes ${bytes.join(',')}`);
  try {
    say(`tight limit -> ${new Session(reversi, { maxCodeLength: 4 }).code}`);
  } catch (err) {
    say(`tight limit -> ${err.code}`);
  }
  const long = new Session(reversi, { maxCodeLength: 4 });
  for (const move of [19, 18, 17]) if (long.legalMoves().includes(move)) long.play(move);
  try {
    say(`tight limit after moves -> ${long.code}`);
  } catch (err) {
    say(`tight limit after moves -> ${err.code} at ${err.length}`);
  }
  say(`extends own past -> ${s.extendsFrom(s.digits.slice(0, 2))}`);
  say(`extends a longer list -> ${s.extendsFrom([...s.digits, [4, 0]])}`);
  say(`extends a fork -> ${s.extendsFrom([[s.digits[0][0], (s.digits[0][1] + 1) % s.digits[0][0]]])}`);
}

// A handful of flip calculations, so a change to the direction table shows up here even if
// it somehow left every full game identical.
for (const [cell, colour] of [[19, 1], [26, 1], [37, 2], [44, 2], [0, 1], [63, 2]]) {
  say(`flips ${cellName(cell)} ${colour} -> ${flipsFor(initialCells(), cell, colour).map(cellName).join(',') || 'none'}`);
}

/* rtc.mjs, exercised without a browser. The signalling codec and the honesty report are both
   pure functions, so a change to either shows up here rather than only in the browser stage. */
{
  say(`rtc version ${RTC_SIGNAL_VERSION} supported-here ${rtcSupported({})} ${rtcSupported({ RTCPeerConnection: function () {} })}`);
  for (const servers of [[], [{ urls: 'stun:example.invalid:3478' }], [{ urls: ['stun:a.invalid', 'turn:b.invalid'] }]]) {
    const honesty = rtcHonesty(servers);
    say(`rtc honesty ${servers.length} serverless=${honesty.serverless} ${honesty.summary}`);
  }
  const sample = { v: RTC_SIGNAL_VERSION, role: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' };
  // Compressed output is not required to be byte stable across zlib versions, so the
  // fingerprint records the round trip and the prefix rather than the bytes.
  const plainScope = {};
  const plain = await packSignal(sample, plainScope);
  say(`rtc packSignal uncompressed prefix=${plain[0]} chars=${plain.length}`);
  say(`rtc unpackSignal uncompressed roundtrip=${JSON.stringify(await unpackSignal(plain, plainScope)) === JSON.stringify(sample)}`);
  if (typeof globalThis.CompressionStream === 'function') {
    const packed = await packSignal(sample, globalThis);
    say(`rtc packSignal compressed prefix=${packed[0]} smaller=${packed.length < plain.length}`);
    say(`rtc unpackSignal compressed roundtrip=${JSON.stringify(await unpackSignal(packed, globalThis)) === JSON.stringify(sample)}`);
  } else {
    say('rtc compression unavailable in this runtime');
  }
  for (const [label, blob] of [['not-a-blob', 'qqqq'], ['empty', ''], ['bad-prefix', 'x' + 'AAAA']]) {
    try {
      await unpackSignal(blob, plainScope);
      say(`rtc unpackSignal ${label} -> accepted`);
    } catch (err) {
      say(`rtc unpackSignal ${label} -> refused`);
    }
  }
}

console.log(out.join('\n'));
