#!/usr/bin/env node
/* The third leg of the triangle.
 *
 * fixtures/recorded-game.json came out of a real browser playing a real game. Three separate
 * code paths have to reproduce it: the page itself (scripts/browser_play.mjs), a Python
 * implementation that shares nothing with this project (scripts/check_independent.py), and
 * the modules in src/, which is what this file checks. Losing any one leg would leave a way
 * for the rules to change without anything noticing.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session } from '../src/courier.mjs';
import { reversi } from '../src/reversi.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(readFileSync(join(root, 'fixtures', 'recorded-game.json'), 'utf8'));

const problems = [];
const compare = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    problems.push(`${label}: src/ gives ${JSON.stringify(got)}, the fixture records ${JSON.stringify(want)}`);
  }
};

let session;
try {
  session = Session.fromCode(reversi, fixture.code);
} catch (err) {
  console.log(`        src/ refuses the recorded code: ${err.message}`);
  process.exit(1);
}

const board = [...session.state.cells].map((c) => (c === 1 ? 'b' : c === 2 ? 'w' : '.')).join('');
const decisions = session.history.filter((h) => h.kind === 'move').map((h) => h.move);
const winner = reversi.winner(session.state);

compare('final board', board, fixture.finalBoard);
compare('score', reversi.score(session.state), { ...fixture.score, empty: 0 });
compare('winner', winner === 1 ? 'black' : winner === 2 ? 'white' : 'draw', fixture.winner);
compare('total plies', session.history.length, fixture.plies);
compare('recorded decisions', session.digits.length, fixture.recordedDecisions);
compare('derived plies', session.history.length - session.digits.length, fixture.derivedPlies);
compare('the decisions the browser clicked', decisions, fixture.decisions);
compare('re-encoding the game', session.code, fixture.code);
compare('code length', fixture.code.length, fixture.codeLength);
if (!session.over) problems.push('the recorded game does not reach an end');

// Playing the recorded decisions forward from an empty board must land in the same place,
// which is the encoder side rather than the decoder side.
const forward = new Session(reversi);
for (const move of fixture.decisions) {
  if (forward.over) break;
  try {
    forward.play(move);
  } catch (err) {
    problems.push(`replaying decision ${move} failed: ${err.message}`);
    break;
  }
}
compare('the code from replaying the clicks', forward.code, fixture.code);

console.log(
  `        src/ replays ${fixture.code.length} characters into ${session.history.length} plies, ` +
    `${fixture.score.black}-${fixture.score.white} to ${fixture.winner}`,
);
for (const problem of problems) console.log(`        ${problem}`);
process.exit(problems.length ? 1 : 0);
