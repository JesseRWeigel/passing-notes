#!/usr/bin/env node
/* How long does the link get, and can it ever get too long to send.
 *
 * The claim this project makes is that the transport cannot silently outgrow what a chat app
 * will carry. There are two halves to proving that. The bound is arithmetic over the rules
 * and holds for every legal game. The search is empirical and shows the bound is tight enough
 * to be worth having rather than a vacuous number nobody can approach.
 *
 * It also measures what the same games cost under the encodings somebody would reach for
 * first, because "this is small" means nothing without something to be smaller than.
 *
 * Writes results/measurements.json. verify.sh checks the README against it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session, bytesToB64url, codeLengthBound } from '../src/courier.mjs';
import { flipsFor, movesFor, opponent, reversi } from '../src/reversi.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLES = 2000;
const PAGES_URL = 'https://jesserweigel.github.io/passing-notes/';

// Real places a link has to fit. Sources are cited in the README.
const CARRIERS = [
  { name: 'one GSM-7 SMS segment', limit: 160 },
  { name: 'one post on X', limit: 280 },
  { name: 'QR version 10-L, alphanumeric', limit: 395 },
  { name: 'the old Internet Explorer address bar', limit: 2083 },
];

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/* policy(legalMoves, state, random) picks one. */
function playout(seed, policy) {
  const random = rng(seed);
  const s = new Session(reversi);
  while (!s.over) s.play(policy(s.legalMoves(), s.state, random));
  return s;
}

const uniform = (legal, _state, random) => legal[Math.floor(random() * legal.length)];

const greedyFlips = (legal, state, random) => {
  let best = [];
  let most = -1;
  for (const m of legal) {
    const f = flipsFor(state.cells, m, state.turn).length;
    if (f > most) {
      most = f;
      best = [m];
    } else if (f === most) best.push(m);
  }
  return best[Math.floor(random() * best.length)];
};

/* Deliberately try to make the code long: leave the opponent as many options as possible, so
   the next digit has the largest radix available. This is the adversary for the bound. */
const widen = (legal, state, random) => {
  let best = [];
  let most = -1;
  for (const m of legal) {
    const after = reversi.apply(state, m);
    const count = movesFor(after.cells, after.turn).length || movesFor(after.cells, opponent(after.turn)).length;
    if (count > most) {
      most = count;
      best = [m];
    } else if (count === most) best.push(m);
  }
  return best[Math.floor(random() * best.length)];
};

/* ---- the encodings anybody would reach for first, over the same games ---- */

function naiveJson(session) {
  // Every ply spelled out, passes included, as a chat app would carry it.
  const moves = session.history.map((h) => (h.kind === 'pass' ? 'pass' : reversi.moveName(h.move)));
  return encodeURIComponent(JSON.stringify(moves)).length;
}

function naiveFixedWidth(session) {
  // Six bits for a cell, plus a marker value for a pass. Seven values above 63 are spare, so
  // this needs seven bits per ply once passes exist.
  const bits = session.history.length * 7;
  const bytes = Math.ceil(bits / 8) + 4;
  return Math.ceil((bytes * 4) / 3);
}

function boardStateOnly() {
  // Two bits per cell plus the side to move. Constant size, and it throws the history away,
  // so the receiver cannot check that a single move in it was legal.
  const bytes = Math.ceil((64 * 2 + 1) / 8) + 4;
  return Math.ceil((bytes * 4) / 3);
}

function longestPossibleCourier() {
  // The all-ones payload of the bound's length, to show what a code of that size looks like.
  const bound = codeLengthBound(reversi);
  const bytes = new Uint8Array(bound.bytes).fill(0xff);
  return bytesToB64url(bytes).length;
}

/* ---- run it ---- */

const bound = codeLengthBound(reversi);
const policies = [
  ['uniform random', uniform],
  ['greedy most flips', greedyFlips],
  ['widen, tries to make the code long', widen],
];

const perPolicy = [];
let overallLongest = { chars: 0 };
let totalDerived = 0;
let totalDigits = 0;
let totalPlies = 0;
let games = 0;

for (const [name, policy] of policies) {
  let longest = 0;
  let shortest = Infinity;
  const lengths = [];
  let derived = 0;
  let digits = 0;
  let plies = 0;
  let decisive = 0;
  for (let seed = 1; seed <= SAMPLES; seed++) {
    const s = playout(seed, policy);
    const code = s.code;
    lengths.push(code.length);
    longest = Math.max(longest, code.length);
    shortest = Math.min(shortest, code.length);
    derived += s.history.length - s.digits.length;
    digits += s.digits.length;
    plies += s.history.length;
    if (reversi.winner(s.state) !== 0) decisive++;
    if (code.length > overallLongest.chars) {
      overallLongest = {
        chars: code.length,
        policy: name,
        seed,
        code,
        plies: s.history.length,
        digits: s.digits.length,
        naiveJson: naiveJson(s),
        naiveFixedWidth: naiveFixedWidth(s),
      };
    }
  }
  lengths.sort((a, b) => a - b);
  perPolicy.push({
    policy: name,
    games: SAMPLES,
    shortest,
    median: lengths[Math.floor(lengths.length / 2)],
    longest,
    decisiveGames: decisive,
    derivedPlies: derived,
    recordedDecisions: digits,
    totalPlies: plies,
  });
  totalDerived += derived;
  totalDigits += digits;
  totalPlies += plies;
  games += SAMPLES;
}

const linkOverhead = `${PAGES_URL}#g=`.length;
const results = {
  generatedBy: 'scripts/measure.mjs',
  samplesPerPolicy: SAMPLES,
  games,
  bound: {
    bits: bound.bits,
    bytes: bound.bytes,
    chars: bound.chars,
    linkChars: bound.chars + linkOverhead,
    worstCaseCodeLength: longestPossibleCourier(),
    reason:
      'A legal move is always an empty cell. The board starts with 60 empty cells and loses ' +
      'one per placement, so the k-th placement has at most 60 - k legal moves and the product ' +
      'over any legal game is at most 60 factorial. Passes and forced moves cost nothing.',
  },
  observed: {
    longest: overallLongest,
    perPolicy,
    derivedPlyFraction: totalDerived / totalPlies,
    derivedPlies: totalDerived,
    recordedDecisions: totalDigits,
    totalPlies,
  },
  alternatives: {
    courierLongestObserved: overallLongest.chars,
    naiveJsonAtLongest: overallLongest.naiveJson,
    naiveFixedWidthAtLongest: overallLongest.naiveFixedWidth,
    boardStateOnly: boardStateOnly(),
  },
  link: { pagesUrl: PAGES_URL, overheadChars: linkOverhead },
  carriers: CARRIERS.map((c) => ({
    ...c,
    fitsWorstCaseLink: bound.chars + linkOverhead <= c.limit,
  })),
};

mkdirSync(join(root, 'results'), { recursive: true });
writeFileSync(join(root, 'results', 'measurements.json'), `${JSON.stringify(results, null, 2)}\n`);

const pct = (x) => `${(x * 100).toFixed(1)}%`;
console.log(`  bound: ${bound.bits} bits, ${bound.bytes} bytes, ${bound.chars} characters of code`);
console.log(`         ${results.bound.linkChars} characters as a full link from ${PAGES_URL}`);
for (const p of perPolicy) {
  console.log(
    `  ${p.policy.padEnd(34)} ${p.games} games, code ${p.shortest} to ${p.longest} chars ` +
      `(median ${p.median}), ${p.decisiveGames} decisive`,
  );
}
console.log(`  longest of ${games} games: ${overallLongest.chars} chars from "${overallLongest.policy}" seed ${overallLongest.seed}`);
console.log(`         that game as JSON move names: ${overallLongest.naiveJson} chars, at 7 bits a ply: ${overallLongest.naiveFixedWidth}`);
console.log(`  ${pct(results.observed.derivedPlyFraction)} of all plies were derived by the reader, not sent`);
for (const c of results.carriers) {
  console.log(`  worst case link ${c.fitsWorstCaseLink ? 'fits' : 'DOES NOT FIT'} ${c.name} (${c.limit})`);
}
