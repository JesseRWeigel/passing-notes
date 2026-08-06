#!/usr/bin/env node
/* Attack the central claim, and write down what actually held.
 *
 * The claim is that the whole game state rides in a URL. That is easy to say and it hides at
 * least six separate promises, only some of which are true. This file tries to break each one
 * and records the measurement, so the README can quote a number instead of an adjective.
 *
 *   1. TRUNCATED. A chat app cuts the link short. Is the shortfall noticed, or does a prefix
 *      decode silently into a shorter game that looks perfectly legal?
 *   2. HAND EDITED. Somebody changes one character. Every position, every replacement.
 *   3. FORGED. Somebody who has read this file edits the payload AND recomputes the checksum.
 *      This is the question of whether the encoding is tamper evident or merely obfuscated.
 *   4. A DIFFERENT GAME. A code from another session, and a code from another game entirely.
 *   5. REPLAYED. An older link from this same game, which is the rewind-your-blunder attack.
 *   6. TOO LONG. How fast does the link grow, and can it reach the ~2000 characters some
 *      clients cut at.
 *
 * Nothing here asserts a policy. It measures, prints, and writes results/attacks.json.
 * verify.sh is what turns these numbers into pass or fail, so that a change in behaviour shows
 * up as a failing check rather than as a quietly different README.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Session,
  bytesToB64url,
  b64urlToBytes,
  codeLengthBound,
  crc16,
  packDigits,
} from '../src/courier.mjs';
import { reversi } from '../src/reversi.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const PAGES_URL = 'https://jesserweigel.github.io/passing-notes/';
const LINK_OVERHEAD = `${PAGES_URL}#g=`.length;
const CLIENT_URL_LIMIT = 2000;
const SAMPLES = 400;

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

/* Decode, and classify the outcome into the only three things that matter: refused, accepted
   as the game we sent, or accepted as some OTHER game. The third is the dangerous one, because
   it is the case where a corrupted link looks like a legitimate position. */
function classify(original, candidate) {
  let decoded;
  try {
    decoded = Session.fromCode(reversi, candidate);
  } catch (err) {
    return { verdict: 'refused', code: err.code };
  }
  return decoded.code === original
    ? { verdict: 'accepted-same' }
    : { verdict: 'accepted-different', digits: decoded.digits.length };
}

const report = {};
const lines = [];
const say = (line) => {
  lines.push(line);
  console.log(line);
};

/* ---------------------------------------------------------------- 1. truncation */
{
  let prefixes = 0;
  let refused = 0;
  const survivors = [];
  for (let seed = 1; seed <= SAMPLES; seed++) {
    const code = randomGame(seed).code;
    for (let n = 1; n < code.length; n++) {
      prefixes++;
      const outcome = classify(code, code.slice(0, n));
      if (outcome.verdict === 'refused') refused++;
      else survivors.push({ seed, keptChars: n, of: code.length, ...outcome });
    }
  }
  report.truncation = { games: SAMPLES, prefixes, refused, silentlyAccepted: survivors.length, survivors: survivors.slice(0, 5) };
  say(`  truncation      ${refused}/${prefixes} prefixes refused, ${survivors.length} decoded into some other game`);
}

/* ---------------------------------------------------------------- 2. one character changed */
{
  let tried = 0;
  let refused = 0;
  const survivors = [];
  for (let seed = 1; seed <= 60; seed++) {
    const code = randomGame(seed).code;
    for (let i = 0; i < code.length; i++) {
      for (const ch of ALPHABET) {
        if (ch === code[i]) continue;
        tried++;
        const outcome = classify(code, code.slice(0, i) + ch + code.slice(i + 1));
        if (outcome.verdict === 'refused') refused++;
        else survivors.push({ seed, at: i, replacedWith: ch, ...outcome });
      }
    }
  }
  report.oneCharacterChanged = {
    games: 60,
    edits: tried,
    refused,
    silentlyAccepted: survivors.length,
    survivors: survivors.slice(0, 5),
    why:
      'A single base64 character spans at most 16 consecutive payload bits, and CRC-16/CCITT ' +
      'detects every burst error of 16 bits or fewer. So this is arithmetic rather than luck.',
  };
  say(`  one char edited ${refused}/${tried} exhaustive single-character edits refused, ${survivors.length} slipped through`);
}

/* ---------------------------------------------------------------- 3. forgery with a fixed checksum

   The honest question. A checksum is not a signature, and the difference is whether an
   attacker who knows the format can produce something that verifies. */
{
  let forged = 0;
  let differentGame = 0;
  const examples = [];
  for (let seed = 1; seed <= SAMPLES; seed++) {
    const original = randomGame(seed).code;
    const bytes = b64urlToBytes(original);
    const body = Uint8Array.from(bytes.subarray(0, bytes.length - 2));
    body[body.length - 1] ^= 0x01; // one bit of the payload, then repair the checksum
    const sum = crc16(body);
    const candidate = bytesToB64url(Uint8Array.from([...body, (sum >> 8) & 255, sum & 255]));
    const outcome = classify(original, candidate);
    if (outcome.verdict !== 'refused') {
      forged++;
      if (outcome.verdict === 'accepted-different') differentGame++;
      if (examples.length < 3) examples.push({ seed, original, forged: candidate, ...outcome });
    }
  }
  /* The bit flip above is the fiddly way in, and since the sentinel check it mostly fails: a
     mangled accumulator no longer divides down to 1. That is integrity, and it is worth
     having. It is not authenticity, and the difference is this: the easy way in never fails.
     Play whatever game you wish had happened and encode it with the project's own encoder.
     There is no key anywhere, so this is not really an attack, it is ordinary use. */
  let substituted = 0;
  for (let seed = 1; seed <= SAMPLES; seed++) {
    const original = randomGame(seed).code;
    const invented = randomGame(seed + 10000).code;
    if (invented !== original && classify(original, invented).verdict === 'accepted-different') substituted++;
  }

  report.forgery = {
    bitFlipWithRepairedChecksum: {
      attempts: SAMPLES,
      accepted: forged,
      decodedToADifferentGame: differentGame,
      examples,
      note:
        'Refusals here are the sentinel, not the checksum. The checksum had already been ' +
        'repaired by the attacker. An accumulator that does not divide back down to 1 is a ' +
        'code the encoder could not have written.',
    },
    encodeAnyGameYouLike: {
      attempts: SAMPLES,
      accepted: substituted,
      note:
        'No editing required, so no integrity check can see it. Play the game you wanted and ' +
        'encode it with the same encoder. This is the one that matters.',
    },
    conclusion:
      'The CRC is a transmission check and the sentinel is a well-formedness check. Neither is ' +
      'a signature. There is no key anywhere in this format, so nothing distinguishes a code ' +
      'you produced from a code your opponent produced. It is not tamper evident, and base64 ' +
      'is not a signature. What the format does guarantee is that whatever comes back decodes ' +
      'to a LEGAL game, because every digit is read against a freshly generated move list. An ' +
      'illegal position cannot be smuggled through. A different legal position can.',
  };
  say(`  forgery         ${forged}/${SAMPLES} payload edits with a repaired checksum survived the sentinel (${differentGame} as a different game)`);
  say(`                  ${substituted}/${SAMPLES} invented games encoded from scratch were accepted, which needs no attack at all`);
}

/* ---------------------------------------------------------------- 4. somebody else's game */
{
  const ours = randomGame(3);
  const theirs = randomGame(99);
  const otherGame = { ...reversi, id: 2, name: 'a different game' };

  let wrongGameRefused = null;
  try {
    Session.fromCode(otherGame, ours.code);
  } catch (err) {
    wrongGameRefused = err.code;
  }

  // A code from an unrelated Reversi session is a perfectly legal Reversi game. Nothing in
  // the format can tell it from ours, and only the page's own memory of what it has seen can.
  const stranger = Session.fromCode(reversi, theirs.code);
  report.differentGame = {
    differentGameId: { refusedWith: wrongGameRefused },
    unrelatedSessionSameGame: {
      decodes: true,
      digits: stranger.digits.length,
      extendsOurGame: ours.extendsFrom(stranger.digits),
      note:
        'It decodes cleanly, because it is a legal game. The format cannot object. The page ' +
        'refuses it only because Session.extendsFrom compares it against the longest game the ' +
        'browser has stored, and that memory is local, optional, and overridable.',
    },
  };
  say(`  wrong game id   refused with ${wrongGameRefused}`);
  say(`  stranger's game decodes cleanly (${stranger.digits.length} decisions), caught only by the local rewind guard`);
}

/* ---------------------------------------------------------------- 5. replaying an older link */
{
  const random = rng(11);
  const session = new Session(reversi);
  const trail = [];
  while (!session.over) {
    const legal = session.legalMoves();
    session.play(legal[Math.floor(random() * legal.length)]);
    trail.push({ digits: session.digits.length, code: session.code });
  }
  const older = trail[Math.floor(trail.length / 2)];
  const rewound = Session.fromCode(reversi, older.code);
  report.replay = {
    finalDecisions: session.digits.length,
    replayedDecisions: rewound.digits.length,
    olderLinkDecodes: true,
    currentExtendsOlder: session.extendsFrom(rewound.digits),
    olderExtendsCurrent: rewound.extendsFrom(session.digits),
    guard: 'Session.extendsFrom, compared against a digit list held in localStorage',
    guardIsAuthoritative: false,
    conclusion:
      'A player can rewind. An older link is a valid link and it decodes into the earlier ' +
      'position with no complaint from the format. What stops it is the receiving page ' +
      'noticing that the link is not an extension of the longest game it has stored, which ' +
      'requires that the page has storage, has seen the longer game, and that the player ' +
      'does not press the override. None of that is a property of the URL.',
  };
  say(`  replay          an older link (${rewound.digits.length} of ${session.digits.length} decisions) decodes cleanly; the format does not prevent a rewind`);
}

/* ---------------------------------------------------------------- 6. how long does it get */
{
  const bound = codeLengthBound(reversi);
  let codeChars = 0;
  let decisions = 0;
  let longest = 0;
  for (let seed = 1; seed <= SAMPLES; seed++) {
    const session = randomGame(seed);
    codeChars += session.code.length - 7; // 7 is the code for a game with no decisions yet
    decisions += session.digits.length;
    longest = Math.max(longest, session.code.length);
  }

  // How many decisions of a given branching factor a 2000 character link could carry. Reversi
  // never gets near this, but the courier is a template and the next game might.
  const budget = CLIENT_URL_LIMIT - LINK_OVERHEAD;
  const capacity = [2, 4, 8, 20, 60].map((radix) => {
    let lo = 1;
    let hi = 200000;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const digits = Array.from({ length: mid }, () => [radix, radix - 1]);
      const length = packDigits({ id: 1, name: 'probe' }, digits, { maxCodeLength: Infinity }).length;
      if (length <= budget) lo = mid;
      else hi = mid - 1;
    }
    return { branchingFactor: radix, decisionsThatFit: lo };
  });

  report.length = {
    charsPerDecision: Number((codeChars / decisions).toFixed(3)),
    emptyGameCode: 7,
    longestObserved: longest,
    provenBound: bound.chars,
    provenBoundLink: bound.chars + LINK_OVERHEAD,
    clientLimit: CLIENT_URL_LIMIT,
    reachable: bound.chars + LINK_OVERHEAD > CLIENT_URL_LIMIT,
    headroom: CLIENT_URL_LIMIT - (bound.chars + LINK_OVERHEAD),
    capacityAtOtherBranchingFactors: capacity,
    note:
      'For Reversi the 2000 character limit is unreachable: the rules cap the code at ' +
      `${bound.chars} characters, so the longest link this game can produce is ` +
      `${bound.chars + LINK_OVERHEAD}. The capacity table is for other games on the same courier.`,
  };
  say(`  length          ${report.length.charsPerDecision} chars per decision, longest seen ${longest}, proven ceiling ${bound.chars} (${bound.chars + LINK_OVERHEAD} as a link)`);
  say(`                  a ${CLIENT_URL_LIMIT} character limit is unreachable for Reversi, with ${report.length.headroom} characters of headroom`);
  for (const row of capacity) {
    say(`                  a game branching ${row.branchingFactor} ways every turn fits ${row.decisionsThatFit} decisions in ${CLIENT_URL_LIMIT} characters`);
  }
}

/* ---------------------------------------------------------------- 7. what chat apps do to text */
{
  const code = randomGame(3).code;
  const mangles = [
    ['a trailing full stop', `${code}.`],
    ['a trailing bracket', `${code})`],
    ['lowercased by a client', code.toLowerCase()],
    ['uppercased by a client', code.toUpperCase()],
    ['a space inserted mid-code', `${code.slice(0, 10)} ${code.slice(10)}`],
    ['wrapped onto two lines', `${code.slice(0, 20)}\n${code.slice(20)}`],
    ['two characters transposed', `${code.slice(0, 5)}${code[6]}${code[5]}${code.slice(7)}`],
    ['percent-encoded by a client', encodeURIComponent(code)],
    ['the whole link, not just the code', `${PAGES_URL}#g=${code}`],
  ];
  report.mangling = mangles.map(([what, text]) => ({ what, ...classify(code, text) }));
  for (const row of report.mangling) {
    const verdict = row.verdict === 'refused' ? `refused (${row.code})` : row.verdict === 'accepted-same' ? 'survives, same game' : 'ACCEPTED AS A DIFFERENT GAME';
    say(`  mangling        ${row.what.padEnd(34)} ${verdict}`);
  }
}

mkdirSync(join(root, 'results'), { recursive: true });
writeFileSync(join(root, 'results', 'attacks.json'), `${JSON.stringify(report, null, 2)}\n`);
