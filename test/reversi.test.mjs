/* The rules, each one tested with a case where it bites and a case where it does not.
   A test that only shows a rule rejecting something passes just as happily when the rule
   rejects everything. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLACK,
  WHITE,
  EMPTY,
  cellFromName,
  cellName,
  countDiscs,
  flipsFor,
  initialCells,
  movesFor,
  opponent,
  reversi,
} from '../src/reversi.mjs';

const at = (name) => cellFromName(name);
const named = (cells) => cells.map(cellName).sort();

function boardFrom(text) {
  // Eight rows of eight characters: . empty, B black, W white.
  const rows = text.trim().split('\n').map((r) => r.trim());
  assert.equal(rows.length, 8, 'a board picture needs eight rows');
  const cells = new Uint8Array(64);
  rows.forEach((row, r) => {
    assert.equal(row.length, 8, `row ${r} is not eight wide`);
    [...row].forEach((ch, c) => {
      cells[r * 8 + c] = ch === 'B' ? BLACK : ch === 'W' ? WHITE : EMPTY;
    });
  });
  return cells;
}

test('the opening position is the standard one', () => {
  const cells = initialCells();
  assert.equal(cells[at('d4')], WHITE);
  assert.equal(cells[at('e4')], BLACK);
  assert.equal(cells[at('d5')], BLACK);
  assert.equal(cells[at('e5')], WHITE);
  assert.deepEqual(countDiscs(cells), { black: 2, white: 2, empty: 60 });
  assert.equal(reversi.initial().turn, BLACK, 'Black moves first');
});

test('Black has exactly the four standard opening moves, White has a different four', () => {
  const cells = initialCells();
  assert.deepEqual(named(movesFor(cells, BLACK)), ['c4', 'd3', 'e6', 'f5']);
  assert.deepEqual(named(movesFor(cells, WHITE)), ['c5', 'd6', 'e3', 'f4']);
});

test('legal moves come back in ascending cell order, which the wire format depends on', () => {
  const cells = initialCells();
  const moves = movesFor(cells, BLACK);
  assert.deepEqual(moves, [...moves].sort((a, b) => a - b));
  assert.ok(moves.length > 1, 'an ordering test on a single move would prove nothing');
});

test('a move must flip something', () => {
  const cells = initialCells();
  assert.equal(flipsFor(cells, at('a1'), BLACK).length, 0, 'a far corner flips nothing');
  assert.equal(flipsFor(cells, at('c3'), BLACK).length, 0, 'a diagonal neighbour with no run flips nothing');
  assert.ok(flipsFor(cells, at('d3'), BLACK).length > 0, 'and the real opening move does flip');
  assert.throws(() => reversi.apply(reversi.initial(), at('a1')), /flips nothing/);
});

test('an occupied cell is never playable', () => {
  const cells = initialCells();
  assert.equal(flipsFor(cells, at('d4'), BLACK).length, 0);
  assert.ok(!movesFor(cells, BLACK).includes(at('d4')));
});

test('flipping works in all eight directions and stops at the bracketing disc', () => {
  // Black plays d4, the empty middle of a star: a white disc in every direction, each one
  // backed by a black disc behind it.
  const cells = boardFrom(`
    ........
    .B.B.B..
    ..WWW...
    .BW.WB..
    ..WWW...
    .B.B.B..
    ........
    ........
  `);
  const flips = flipsFor(cells, at('d4'), BLACK).map(cellName).sort();
  assert.deepEqual(flips, ['c3', 'c4', 'c5', 'd3', 'd5', 'e3', 'e4', 'e5'],
    'all eight neighbours flip, one per direction');

  // The same star with the disc backing the north direction removed, so that one direction
  // must not flip while the other seven still do.
  const gapped = boardFrom(`
    ........
    .B...B..
    ..WWW...
    .BW.WB..
    ..WWW...
    .B.B.B..
    ........
    ........
  `);
  const gappedFlips = flipsFor(gapped, at('d4'), BLACK).map(cellName).sort();
  assert.deepEqual(gappedFlips, ['c3', 'c4', 'c5', 'd5', 'e3', 'e4', 'e5'],
    'seven directions flip and the unbacked one does not');
});

test('a run of opponent discs with a hole in it does not flip', () => {
  const solid = boardFrom(`
    BWWWW.W.
    ........
    ........
    ........
    ........
    ........
    ........
    ........
  `);
  assert.equal(flipsFor(solid, at('f1'), BLACK).length, 4, 'a solid run flips');
  const holed = boardFrom(`
    BWW.W.W.
    ........
    ........
    ........
    ........
    ........
    ........
    ........
  `);
  assert.equal(flipsFor(holed, at('f1'), BLACK).length, 0, 'a run broken by an empty cell does not');
});

test('a run never wraps around the edge of the board', () => {
  // h4 is cell 31 and a5 is cell 32, adjacent in the flat array and on opposite edges of the
  // board. Stepping left from a5 must not find h4.
  const wrapping = boardFrom(`
    ........
    ........
    ........
    ......BW
    ........
    ........
    ........
    ........
  `);
  assert.equal(at('h4'), 31);
  assert.equal(at('a5'), 32);
  assert.equal(cells32Empty(wrapping), true);
  assert.equal(flipsFor(wrapping, at('a5'), BLACK).length, 0,
    'stepping left from a5 must not walk backwards into row four');

  // The identical shape one column in from the edge does flip, so the guard is not simply
  // refusing everything.
  const inner = boardFrom(`
    ........
    ........
    ........
    ........
    BW......
    ........
    ........
    ........
  `);
  assert.equal(flipsFor(inner, at('c5'), BLACK).length, 1);
});

function cells32Empty(cells) {
  return cells[32] === EMPTY;
}

/* One black disc, one white disc, side by side. White has nothing to bracket and Black can
   play c1. That makes it the smallest position where one player passes and the game goes on. */
const PASS_POSITION = `
    BW......
    ........
    ........
    ........
    ........
    ........
    ........
    ........
  `;

test('a player with no move passes, and a player with a move may not', () => {
  const cells = boardFrom(PASS_POSITION);
  assert.equal(movesFor(cells, WHITE).length, 0, 'White has nothing to play');
  assert.deepEqual(named(movesFor(cells, BLACK)), ['c1'], 'Black still has a move');
  assert.equal(reversi.pass({ cells, turn: WHITE }).turn, BLACK);
  assert.throws(() => reversi.pass({ cells: initialCells(), turn: BLACK }), /may not pass/);
});

test('the game ends only when neither player can move', () => {
  const oneSided = boardFrom(PASS_POSITION);
  assert.equal(reversi.isOver({ cells: oneSided, turn: WHITE }), false,
    'White cannot move but Black still can, so this is a pass and not an ending');

  const done = boardFrom(`
    BB......
    BB......
    ........
    ........
    ........
    ........
    ........
    ........
  `);
  assert.equal(reversi.isOver({ cells: done, turn: WHITE }), true);
  assert.equal(reversi.isOver({ cells: done, turn: BLACK }), true);
});

test('the winner is decided by disc count, and equal counts are a draw', () => {
  const blackAhead = boardFrom(`
    BBB.....
    ........
    ........
    ........
    ........
    ........
    ........
    ......WW
  `);
  const whiteAhead = boardFrom(`
    WWW.....
    ........
    ........
    ........
    ........
    ........
    ........
    ......BB
  `);
  const level = boardFrom(`
    BB......
    ........
    ........
    ........
    ........
    ........
    ........
    ......WW
  `);
  assert.equal(reversi.winner({ cells: blackAhead, turn: BLACK }), BLACK);
  assert.equal(reversi.winner({ cells: whiteAhead, turn: BLACK }), WHITE);
  assert.equal(reversi.winner({ cells: level, turn: BLACK }), 0);
});

test('applying a move flips the discs and hands over the turn', () => {
  const before = reversi.initial();
  const after = reversi.apply(before, at('d3'));
  assert.equal(after.turn, WHITE);
  assert.equal(after.cells[at('d3')], BLACK);
  assert.equal(after.cells[at('d4')], BLACK, 'the bracketed white disc turned black');
  assert.equal(before.cells[at('d3')], EMPTY, 'the original state was not mutated');
  assert.deepEqual(countDiscs(after.cells), { black: 4, white: 1, empty: 59 });
});

test('cell names round trip and reject nonsense', () => {
  for (let cell = 0; cell < 64; cell++) assert.equal(cellFromName(cellName(cell)), cell);
  assert.equal(cellName(0), 'a1');
  assert.equal(cellName(63), 'h8');
  assert.equal(cellFromName('j1'), -1);
  assert.equal(cellFromName('a9'), -1);
});

test('opponent is an involution', () => {
  assert.equal(opponent(BLACK), WHITE);
  assert.equal(opponent(opponent(BLACK)), BLACK);
});
