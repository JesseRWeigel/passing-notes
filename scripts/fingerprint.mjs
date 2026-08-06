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
import { Session, codeLengthBound, crc16, bytesToB64url } from '../src/courier.mjs';
import { cellName, countDiscs, flipsFor, initialCells, movesFor, reversi } from '../src/reversi.mjs';

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
  const cases = [
    ['good', good],
    ['truncated', good.slice(0, -2)],
    ['one-char-changed', `${good.slice(0, 4)}${good[4] === 'A' ? 'B' : 'A'}${good.slice(5)}`],
    ['spare-bits-set', 'AAB'],
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

console.log(out.join('\n'));
