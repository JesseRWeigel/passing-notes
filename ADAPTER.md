# The adapter

`src/courier.mjs` knows nothing about any particular game. It carries a game between two people
by writing down the sequence of *choices* that were made, and to do that it needs someone to
tell it what the choices are. That is the adapter: one plain object with eleven members.

`src/reversi.mjs` is the worked example. Read it alongside this.

## The eleven members

| Member | Signature | What it must do |
|---|---|---|
| `id` | number, 0 to 255 | Distinguishes this game from every other game that might send a code to the same page. It travels in the second byte, so a code from a different game is refused rather than misread. Pick one and never change it. |
| `name` | string | Used only in error messages. |
| `maxPlies` | number | A hard stop for the forced-move loop. If a position ever leads to more than this many consecutive forced plies, `advance` throws `NO_PROGRESS` rather than hanging. |
| `initial()` | `() => State` | The opening position. Must return a fresh object every call. |
| `mover(state)` | `State => Player` | Whose turn it is. Only used for the human-readable log. |
| `legalMoves(state)` | `State => Move[]` | **The load-bearing one. See below.** |
| `apply(state, move)` | `(State, Move) => State` | The position after that move. Must not mutate `state`. |
| `pass(state)` | `State => State` | The position after the mover, who has no legal move, gives up the turn. Called only when `legalMoves` returned empty. |
| `isOver(state)` | `State => boolean` | Whether the game has ended. |
| `eq(a, b)` | `(Move, Move) => boolean` | Move equality, so `Session.play` can find a move in the legal list. |
| `moveName(move)` | `Move => string` | For error messages and the log. |
| `branchBoundLog2()` | `() => number` | See "the bound" below. |

Optional, used by the Reversi page but not by the courier: `score(state)` and `winner(state)`.

## legalMoves is the wire format

The courier does not record which move you played. It records the **index of that move inside
the list `legalMoves` returned**. The reader regenerates the same list at the same position and
looks the index up.

So `legalMoves` must be a pure, deterministic, total function of the state, and it must return
moves in a **stable order that both sides compute identically**. If the order ever changes, every
code produced before the change decodes into a different game, silently, with no error, because
the indices are still in range. There is no version byte that will save you. Sort the list
explicitly and write a test that pins the order. Reversi sorts by ascending cell index and
`test/reversi.test.mjs` asserts it.

Two consequences worth knowing:

- **A forced move costs nothing.** When `legalMoves` returns exactly one move, the radix is 1 and
  the choice carries zero bits, so the courier plays it without recording anything and the reader
  re-derives it. Same for a position with no legal moves, which becomes a `pass`. Across 6000
  measured Reversi games, 3.0% of all plies were re-derived rather than sent.
- **Nothing illegal can travel.** A digit is always read against a freshly generated legal move
  list, so a corrupted code decodes into some *other legal game* or fails outright. It cannot
  decode into an illegal position. This is a guarantee about legality and not about honesty; see
  the README section on what the format does not do.

## The bound

`branchBoundLog2()` returns log base 2 of an upper bound on the product of every branching factor
in any legal game. `codeLengthBound(game)` turns that into the longest code the game can ever
produce, before a single move is played, so a caller can find out at the start whether the
transport is big enough rather than at move 40.

This is a **proof obligation, not an estimate**. Reversi's argument, in full: a legal move is
always an empty cell, the board starts with 60 empty cells, and each placement fills exactly one,
so the k-th placement has at most 60 − k legal moves and the product over any legal game is at
most 60 factorial. That gives 274 bits, 52 characters of code.

If you cannot prove a bound for your game, return `Infinity` and set `maxCodeLength` instead. The
`CODE_TOO_LONG` error then tells the player the truth at the moment it happens, which is worse
than knowing in advance but much better than emitting a link that silently does not fit.

## A minimal adapter

```js
export const countdown = {
  id: 2,
  name: 'Countdown',
  maxPlies: 40,
  initial: () => ({ left: 21, turn: 1 }),
  mover: (s) => s.turn,
  legalMoves: (s) => [1, 2, 3].filter((n) => n <= s.left),   // stable order, always ascending
  apply: (s, n) => ({ left: s.left - n, turn: s.turn === 1 ? 2 : 1 }),
  pass: (s) => ({ ...s, turn: s.turn === 1 ? 2 : 1 }),
  isOver: (s) => s.left === 0,
  eq: (a, b) => a === b,
  moveName: (n) => `take ${n}`,
  branchBoundLog2: () => 21 * Math.log2(3),                  // at most 21 turns, at most 3 ways
};
```

```js
import { Session } from './src/courier.mjs';

const game = new Session(countdown);
game.play(3).play(2);
console.log(game.code);          // the whole game, as a few characters
console.log(game.link('https://example.invalid/'));
```

## Adding it to the page

`scripts/build.mjs` inlines `src/*.mjs` into `docs/index.html` in a fixed order and rewrites the
bootstrap call at the bottom. To ship a different game, add your module to `ORDER`, pass it as
`game:` in the bootstrap, and give `src/ui.mjs` a board it can draw. The build refuses to write a
page whose script does not parse, and it refuses two modules that declare the same top-level
name, so a collision surfaces as an error rather than as a wrong page.
