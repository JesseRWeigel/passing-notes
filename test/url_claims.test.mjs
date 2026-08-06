/* What the URL actually promises, written down as tests that pass.
 *
 * Some of these assert a WEAKNESS. That is deliberate. "The encoding is tamper evident" is the
 * kind of claim that creeps back into a README months later, and the only durable way to stop
 * it is a green test that says forgery works and names the reason. If somebody later adds a
 * signature, these tests fail loudly and the README has to be rewritten, which is exactly the
 * conversation that should happen.
 *
 * scripts/attack_url.mjs measures the same ground at scale and writes results/attacks.json.
 * This file pins the individual behaviours so a failure says which one broke.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Session,
  CourierError,
  b64urlToBytes,
  bytesToB64url,
  codeLengthBound,
  crc16,
} from '../src/courier.mjs';
import { reversi } from '../src/reversi.mjs';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomGame(seed) {
  const random = rng(seed);
  const session = new Session(reversi);
  while (!session.over) {
    const legal = session.legalMoves();
    session.play(legal[Math.floor(random() * legal.length)]);
  }
  return session;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/* ------------------------------------------------------------------ what holds */

test('every single-character edit of a code is refused, across whole games', () => {
  // Not luck. One base64 character spans at most 16 consecutive payload bits, and
  // CRC-16/CCITT detects every burst error of 16 bits or fewer.
  let checked = 0;
  for (const seed of [1, 2, 3, 4, 5]) {
    const code = randomGame(seed).code;
    for (let i = 0; i < code.length; i++) {
      for (const ch of ALPHABET) {
        if (ch === code[i]) continue;
        checked++;
        assert.throws(
          () => Session.fromCode(reversi, code.slice(0, i) + ch + code.slice(i + 1)),
          CourierError,
          `a code with position ${i} changed to ${ch} was accepted`,
        );
      }
    }
  }
  assert.ok(checked > 10000, `expected a real sweep, only tried ${checked} edits`);
});

test('a code that has been cut short is refused in the overwhelming majority of cases', () => {
  let refused = 0;
  let accepted = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const code = randomGame(seed).code;
    for (let n = 1; n < code.length; n++) {
      try {
        Session.fromCode(reversi, code.slice(0, n));
        accepted++;
      } catch {
        refused++;
      }
    }
  }
  // A 16-bit checksum leaves roughly one truncation in 65536 undetected, so this is a rate
  // and not a guarantee. See the README. Asserting "all" here would be asserting luck.
  assert.ok(refused > 0);
  assert.ok(
    accepted / (refused + accepted) < 0.001,
    `${accepted} of ${refused + accepted} truncations slipped through, which is worse than the checksum should allow`,
  );
});

test('a code carrying a different game id is refused rather than misread', () => {
  const code = randomGame(3).code;
  assert.throws(
    () => Session.fromCode({ ...reversi, id: 2, name: 'something else' }, code),
    (err) => err.code === 'WRONG_GAME',
  );
});

test('nothing illegal can travel: a decoded code is always a legal game', () => {
  // Feed deliberate rubbish that survives the checksum by construction, and check that
  // whatever comes out the far side is a position reachable by legal play.
  let decoded = 0;
  for (let payload = 2; payload < 400; payload++) {
    const body = Uint8Array.from([1, 1, (payload >> 8) & 255, payload & 255]);
    const sum = crc16(body);
    const code = bytesToB64url(Uint8Array.from([...body, (sum >> 8) & 255, sum & 255]));
    let session;
    try {
      session = Session.fromCode(reversi, code);
    } catch (err) {
      assert.ok(err instanceof CourierError);
      continue;
    }
    decoded++;
    // Replaying the recorded decisions forward must reproduce the same code, which is only
    // possible if every one of them was legal at the point it was played.
    const forward = new Session(reversi);
    for (const move of session.history.filter((h) => h.kind === 'move').map((h) => h.move)) {
      if (forward.over) break;
      forward.play(move);
    }
    assert.equal(forward.code, session.code);
  }
  assert.ok(decoded > 50, `expected many of these to decode, only ${decoded} did`);
});

test('the length of a Reversi link cannot reach the 2000 character limit some clients impose', () => {
  const bound = codeLengthBound(reversi);
  const overhead = 'https://jesserweigel.github.io/passing-notes/#g='.length;
  assert.ok(bound.chars + overhead < 2000, `the worst case link is ${bound.chars + overhead} characters`);
  // And the bound is real: no sampled game may exceed it.
  for (let seed = 1; seed <= 120; seed++) {
    const code = randomGame(seed).code;
    assert.ok(code.length <= bound.chars, `seed ${seed} produced ${code.length} characters against a bound of ${bound.chars}`);
  }
});

test('whitespace and a full link survive, because chat apps insert both', () => {
  const code = randomGame(3).code;
  for (const variant of [
    `${code.slice(0, 10)} ${code.slice(10)}`,
    `${code.slice(0, 20)}\n${code.slice(20)}`,
    `  ${code}  `,
    `https://example.invalid/page#g=${code}`,
  ]) {
    assert.equal(Session.fromCode(reversi, variant).code, code);
  }
});

/* ------------------------------------------------------------------ what does not hold */

test('a raw bit flip with a repaired checksum is still refused, because of the sentinel', () => {
  // The checksum alone would not catch this: it is recomputed. What catches it is that the
  // accumulator no longer divides down to the sentinel, so the code is one the encoder could
  // never have produced. This is integrity, not authenticity. The next test is the difference.
  const original = randomGame(1).code;
  const bytes = b64urlToBytes(original);
  const body = Uint8Array.from(bytes.subarray(0, bytes.length - 2));
  body[body.length - 1] ^= 0x01;
  const sum = crc16(body);
  const forged = bytesToB64url(Uint8Array.from([...body, (sum >> 8) & 255, sum & 255]));

  assert.notEqual(forged, original);
  assert.throws(() => Session.fromCode(reversi, forged), (err) => err.code === 'NOT_CANONICAL');
});

test('WEAKNESS: the code is not tamper evident, a properly formed forgery is indistinguishable', () => {
  // The sentinel stops a careless edit. It stops nothing done by someone using the encoder,
  // and the encoder is in the page. Take the real game, change one decision, re-encode.
  // The result is canonical, checksummed, legal, and a lie.
  //
  // If this test ever fails, somebody added authentication and the README's honesty section
  // is now wrong in the good direction. Rewrite it.
  const honest = randomGame(1);
  const tampered = new Session(reversi);
  const original = honest.code;

  // Replay the real game but diverge at the first position that offered a choice.
  const decisions = honest.history.filter((h) => h.kind === 'move').map((h) => h.move);
  let diverged = false;
  for (const move of decisions) {
    if (tampered.over) break;
    const legal = tampered.legalMoves();
    if (!diverged && legal.length > 1) {
      tampered.play(legal.find((m) => m !== move));
      diverged = true;
      continue;
    }
    if (legal.includes(move)) tampered.play(move);
    else break;
  }
  assert.ok(diverged, 'the game should have offered a choice to diverge at');

  const forged = tampered.code;
  assert.notEqual(forged, original);
  // Accepted without complaint, and it round trips exactly like an honest code.
  const decoded = Session.fromCode(reversi, forged);
  assert.equal(decoded.code, forged, 'the forged code is accepted as a valid game');
  assert.notDeepEqual(decoded.digits, honest.digits, 'and it is a different game from the one played');
});

test('WEAKNESS: anyone can encode any game they like, no editing required', () => {
  const theirs = randomGame(99).code;
  const invented = randomGame(4242).code;
  assert.notEqual(invented, theirs);
  // There is no key, so a code produced by an opponent is indistinguishable from one produced
  // by you. The format cannot tell them apart and does not try.
  assert.equal(Session.fromCode(reversi, invented).code, invented);
});

test('WEAKNESS: an older link decodes cleanly, so a player can rewind a losing move', () => {
  const random = rng(11);
  const session = new Session(reversi);
  const trail = [];
  while (!session.over) {
    const legal = session.legalMoves();
    session.play(legal[Math.floor(random() * legal.length)]);
    trail.push(session.code);
  }
  const older = trail[Math.floor(trail.length / 2)];
  const rewound = Session.fromCode(reversi, older);

  assert.equal(rewound.code, older, 'the older link is a perfectly valid link');
  assert.ok(rewound.digits.length < session.digits.length);
  // The only thing that objects is a comparison the RECEIVER chooses to make, using state it
  // keeps locally. The URL carries nothing that would stop this.
  assert.equal(session.extendsFrom(rewound.digits), true, 'the old game is a prefix of the current one');
  assert.equal(rewound.extendsFrom(session.digits), false, 'so the receiver can notice, if it kept the longer game');
});

test('WEAKNESS: a stranger\'s game of the same type decodes without complaint', () => {
  const ours = randomGame(3);
  const theirs = Session.fromCode(reversi, randomGame(99).code);
  assert.ok(theirs.digits.length > 0);
  assert.equal(ours.extendsFrom(theirs.digits), false);
  // Nothing in the format objected. Only extendsFrom did, and only because the page happened
  // to be holding our game to compare against.
});

test('WEAKNESS: the rewind guard depends on storage the page may not have', () => {
  // extendsFrom is a pure function over digit lists. It cannot know anything the caller does
  // not give it, so a caller with no stored history has nothing to refuse.
  const session = randomGame(3);
  assert.equal(session.extendsFrom([]), true, 'with no stored history every link is an extension of nothing');
});
