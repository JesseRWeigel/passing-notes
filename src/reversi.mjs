/* Reversi, as the one finished game sitting on top of the courier.
 *
 * Standard 8x8 Othello opening and rules. Black moves first. A move must flip at least one
 * disc. A player with no legal move passes. When neither player has a legal move the game
 * ends and the player with more discs wins, equal counts being a draw.
 *
 * Two things here exist for the courier's benefit and are worth calling out.
 *
 * legalMoves returns cells in ascending index order, always. The courier writes down the
 * INDEX of the chosen move within that list, so both sides must build the list in the same
 * order or every code after the first branching position decodes into a different game.
 * The ordering is part of the wire format.
 *
 * branchBoundLog2 is a proof obligation, not an estimate. A legal move is always an empty
 * cell, and the board starts with 60 empty cells and loses exactly one per placement, so
 * the number of legal moves at the k-th placement is at most 60 - k. The product over a
 * whole game is therefore at most 60 factorial, whatever the players do.
 */

export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;

const DIRS = [-9, -8, -7, -1, 1, 7, 8, 9];
const CELLS = 64;
export const PLACEABLE = 60; // 64 cells less the four the opening puts on the board

function inBounds(from, to, step) {
  if (to < 0 || to >= CELLS) return false;
  const fromCol = from % 8;
  const toCol = to % 8;
  // A step that changes the column by more than one has wrapped around a row edge.
  if (step === -1 || step === 7 || step === -9) return toCol === fromCol - 1;
  if (step === 1 || step === -7 || step === 9) return toCol === fromCol + 1;
  return toCol === fromCol;
}

export function initialCells() {
  const cells = new Uint8Array(CELLS);
  cells[27] = WHITE;
  cells[28] = BLACK;
  cells[35] = BLACK;
  cells[36] = WHITE;
  return cells;
}

export function opponent(colour) {
  return colour === BLACK ? WHITE : BLACK;
}

/* Every disc this move would flip, in every direction. Empty means the move is not legal. */
export function flipsFor(cells, cell, colour) {
  if (cells[cell] !== EMPTY) return [];
  const foe = opponent(colour);
  const out = [];
  for (const step of DIRS) {
    const run = [];
    let at = cell;
    for (;;) {
      const next = at + step;
      if (!inBounds(at, next, step)) {
        run.length = 0;
        break;
      }
      if (cells[next] === foe) {
        run.push(next);
        at = next;
        continue;
      }
      if (cells[next] === colour && run.length > 0) break;
      run.length = 0;
      break;
    }
    for (const c of run) out.push(c);
  }
  return out;
}

export function movesFor(cells, colour) {
  const out = [];
  for (let cell = 0; cell < CELLS; cell++) {
    if (cells[cell] !== EMPTY) continue;
    if (flipsFor(cells, cell, colour).length > 0) out.push(cell);
  }
  return out;
}

export function countDiscs(cells) {
  let black = 0;
  let white = 0;
  let empty = 0;
  for (const c of cells) {
    if (c === BLACK) black++;
    else if (c === WHITE) white++;
    else empty++;
  }
  return { black, white, empty };
}

export function cellName(cell) {
  return 'abcdefgh'[cell % 8] + String(Math.floor(cell / 8) + 1);
}

export function cellFromName(name) {
  const col = 'abcdefgh'.indexOf(String(name)[0]);
  const row = Number(String(name).slice(1)) - 1;
  if (col < 0 || !(row >= 0 && row < 8)) return -1;
  return row * 8 + col;
}

const LOG2_60_FACTORIAL = (() => {
  let bits = 0;
  for (let i = 2; i <= PLACEABLE; i++) bits += Math.log2(i);
  return bits;
})();

export const reversi = {
  id: 1,
  name: 'Reversi',
  maxPlies: 200,

  initial() {
    return { cells: initialCells(), turn: BLACK };
  },

  mover(state) {
    return state.turn;
  },

  legalMoves(state) {
    return movesFor(state.cells, state.turn);
  },

  apply(state, move) {
    const flips = flipsFor(state.cells, move, state.turn);
    if (flips.length === 0) {
      throw new Error(`${cellName(move)} flips nothing, so it is not a legal move`);
    }
    const cells = Uint8Array.from(state.cells);
    cells[move] = state.turn;
    for (const c of flips) cells[c] = state.turn;
    return { cells, turn: opponent(state.turn) };
  },

  pass(state) {
    if (movesFor(state.cells, state.turn).length > 0) {
      throw new Error('a player with a legal move may not pass');
    }
    return { cells: state.cells, turn: opponent(state.turn) };
  },

  isOver(state) {
    if (movesFor(state.cells, state.turn).length > 0) return false;
    return movesFor(state.cells, opponent(state.turn)).length === 0;
  },

  eq(a, b) {
    return a === b;
  },

  moveName(move) {
    return cellName(move);
  },

  score(state) {
    return countDiscs(state.cells);
  },

  /* 0 for a draw, otherwise the winning colour. Only meaningful once isOver. */
  winner(state) {
    const { black, white } = countDiscs(state.cells);
    if (black === white) return 0;
    return black > white ? BLACK : WHITE;
  },

  branchBoundLog2() {
    return LOG2_60_FACTORIAL;
  },
};
