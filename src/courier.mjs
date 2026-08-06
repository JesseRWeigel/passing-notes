/* The courier. It carries a whole game between two people with nothing in the middle.
 *
 * The idea in one paragraph. A game is a deterministic function from a move history to a
 * position, so the history IS the state, and a history of choices can be written down far
 * more tightly than a board can. At every turn the player is choosing one of R legal moves,
 * so that choice is worth exactly log2(R) bits, and the whole game is one integer in a
 * mixed radix where the radices are the branching factors. Nothing else needs to travel.
 *
 * Three consequences fall out of that, and they are the reason this file exists.
 *
 *   1. A position where only one move is legal costs ZERO bits, because R is 1. Forced moves
 *      and forced passes are re derived by the reader instead of being sent. In Reversi that
 *      is a real saving, not a curiosity, because endgames are full of them.
 *
 *   2. The reader cannot decode digit k without first replaying moves 0..k-1 and generating
 *      the legal move list at that position. So a corrupted or invented code does not decode
 *      into an illegal position. It decodes into some OTHER legal game, or it fails. There is
 *      no way to smuggle an illegal move through this channel. See the honesty note below for
 *      what this does not give you.
 *
 *   3. The length is bounded by the rules, in advance. If every ply has at most B_k legal
 *      moves then the code can never be longer than log2(prod B_k) bits, whatever the players
 *      do. For a game with a bound, a link that gets too long to send is impossible rather
 *      than unlikely. See codeLengthBound.
 *
 * HONESTY NOTE. This guarantees legality, and it does not guarantee honesty. Your opponent
 * holds the state, so they can hand you back a legal game that is not the one you played,
 * for example by rewinding to before their blunder. That is what Session.extendsFrom is for:
 * keep your own longest known digit list and refuse anything that is not an extension of it.
 * Without a shared secret there is no way to do better, and this file does not pretend to.
 *
 * A game plugs in by supplying the adapter described in ADAPTER.md. This file knows nothing
 * about Reversi.
 */

export const CODEC_VERSION = 1;

// A conservative default. See docs in README: 280 is one post on X, 160 is one GSM-7 SMS
// segment, and 2083 was the old Internet Explorer address bar limit that still shows up in
// odd places. 512 leaves room for the page URL in front of the code.
export const DEFAULT_MAX_CODE = 512;

export class CourierError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'CourierError';
    this.code = code;
    Object.assign(this, detail);
  }
}

/* ---------------------------------------------------------------- base64url

   Hand rolled so the same code runs in Node and in a browser opened from a file, with no
   atob/btoa differences and no padding to be mangled by a chat app that thinks '=' ends a
   URL. Unpadded, URL safe, and it rejects anything outside its own alphabet loudly.
*/
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_INV = (() => {
  const m = new Map();
  for (let i = 0; i < B64.length; i++) m.set(B64[i], i);
  return m;
})();

export function bytesToB64url(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    const chunk = bytes.length - i;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (chunk > 1) out += B64[(n >> 6) & 63];
    if (chunk > 2) out += B64[n & 63];
  }
  return out;
}

export function b64urlToBytes(str) {
  if (str.length % 4 === 1) {
    throw new CourierError('BAD_FORMAT', `a code cannot be ${str.length} characters long`);
  }
  const out = [];
  for (let i = 0; i < str.length; i += 4) {
    const chunk = Math.min(4, str.length - i);
    let n = 0;
    let last = 0;
    for (let j = 0; j < 4; j++) {
      const ch = j < chunk ? str[i + j] : 'A';
      const v = B64_INV.get(ch);
      if (v === undefined) {
        throw new CourierError('BAD_FORMAT', `the code contains ${JSON.stringify(ch)}, which is not part of a code`);
      }
      n = (n << 6) | v;
      if (j === chunk - 1) last = v;
    }
    // A short final group carries bits that decode to nothing: 4 spare bits after one byte,
    // 2 after two bytes. If they are not zero, this is not a string this encoder produced.
    // Left unchecked, several different codes decode to the same bytes, which turns a
    // corrupted character into a silent alias rather than a checksum failure.
    const spare = chunk === 2 ? 0b1111 : chunk === 3 ? 0b11 : 0;
    if ((last & spare) !== 0) {
      throw new CourierError('BAD_FORMAT', 'the last character of this code carries bits that cannot be part of it');
    }
    out.push((n >> 16) & 255);
    if (chunk > 2) out.push((n >> 8) & 255);
    if (chunk > 3) out.push(n & 255);
  }
  return Uint8Array.from(out);
}

/* CRC-16/CCITT-FALSE. Not security, just a loud complaint when a chat app truncates the link
   or somebody drops a character while copying. Without it a short code decodes silently into
   a shorter, wrong, perfectly legal game. */
export function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function bigToBytes(n) {
  if (n < 1n) throw new CourierError('INTERNAL', 'the accumulator went below its sentinel');
  const out = [];
  let v = n;
  while (v > 0n) {
    out.push(Number(v & 0xffn));
    v >>= 8n;
  }
  out.reverse();
  return Uint8Array.from(out);
}

function bytesToBig(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}

/* ---------------------------------------------------------------- the frame

   [version][gameId][payload big endian][crc16 of everything before it]
*/
export function packDigits(game, digits, { maxCodeLength = DEFAULT_MAX_CODE } = {}) {
  let acc = 1n; // the sentinel is what makes the digit count self delimiting
  for (let k = digits.length - 1; k >= 0; k--) {
    const [radix, index] = digits[k];
    if (!(radix >= 2)) {
      throw new CourierError('INTERNAL', `a digit with radix ${radix} carries no information and must not be recorded`);
    }
    if (!(index >= 0 && index < radix)) {
      throw new CourierError('INTERNAL', `digit index ${index} is outside its radix ${radix}`);
    }
    acc = acc * BigInt(radix) + BigInt(index);
  }
  const body = concat(Uint8Array.from([CODEC_VERSION, game.id]), bigToBytes(acc));
  const sum = crc16(body);
  const code = bytesToB64url(concat(body, Uint8Array.from([(sum >> 8) & 255, sum & 255])));
  if (code.length > maxCodeLength) {
    throw new CourierError(
      'CODE_TOO_LONG',
      `this game needs a ${code.length} character code and the limit is ${maxCodeLength}. ` +
        'Nothing was truncated. Raise maxCodeLength or use a different transport.',
      { length: code.length, limit: maxCodeLength },
    );
  }
  return code;
}

export function unpack(code) {
  const bytes = b64urlToBytes(code);
  if (bytes.length < 5) {
    throw new CourierError('BAD_FORMAT', `a code is at least 5 bytes and this one is ${bytes.length}`);
  }
  const body = bytes.subarray(0, bytes.length - 2);
  const want = (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
  const got = crc16(body);
  if (want !== got) {
    throw new CourierError(
      'CHECKSUM_MISMATCH',
      'this code did not survive the trip. It was cut short or a character was changed. ' +
        'Ask for it again rather than guessing.',
      { want, got },
    );
  }
  return { version: body[0], gameId: body[1], acc: bytesToBig(body.subarray(2)) };
}

/* ---------------------------------------------------------------- forced play

   Advance through every position that offers the mover no choice at all. A position with no
   legal move is a pass, a position with exactly one is that move. Neither carries a bit, so
   both sides derive them the same way and neither is transmitted.
*/
export function advance(game, state) {
  const auto = [];
  let s = state;
  for (let guard = 0; ; guard++) {
    if (guard > game.maxPlies) {
      throw new CourierError('NO_PROGRESS', `${game.name} did not reach an end within ${game.maxPlies} plies`);
    }
    if (game.isOver(s)) return { state: s, auto };
    const legal = game.legalMoves(s);
    if (legal.length === 0) {
      auto.push({ kind: 'pass', by: game.mover(s) });
      s = game.pass(s);
    } else if (legal.length === 1) {
      auto.push({ kind: 'forced', move: legal[0], by: game.mover(s) });
      s = game.apply(s, legal[0]);
    } else {
      return { state: s, auto };
    }
  }
}

/* ---------------------------------------------------------------- the session */
export class Session {
  constructor(game, opts = {}) {
    this.game = game;
    this.opts = opts;
    this.digits = [];
    this.history = [];
    this.state = game.initial();
    this._settle();
  }

  _settle() {
    const { state, auto } = advance(this.game, this.state);
    this.state = state;
    this.history.push(...auto);
  }

  get over() {
    return this.game.isOver(this.state);
  }

  legalMoves() {
    return this.game.isOver(this.state) ? [] : this.game.legalMoves(this.state);
  }

  play(move) {
    if (this.game.isOver(this.state)) {
      throw new CourierError('GAME_OVER', 'the game has ended, there is nothing left to play');
    }
    const legal = this.game.legalMoves(this.state);
    const index = legal.findIndex((m) => this.game.eq(m, move));
    if (index < 0) {
      throw new CourierError('ILLEGAL_MOVE', `${this.game.moveName(move)} is not a legal move here`, { move });
    }
    // A radix of one is a forced move, which advance() already played. Reaching here with
    // legal.length === 1 would mean _settle did not run, so treat it as a bug, not a digit.
    if (legal.length < 2) {
      throw new CourierError('INTERNAL', 'a forced position was left for the player to play');
    }
    const by = this.game.mover(this.state);
    this.digits.push([legal.length, index]);
    this.state = this.game.apply(this.state, legal[index]);
    this.history.push({ kind: 'move', move: legal[index], by });
    this._settle();
    return this;
  }

  get code() {
    return packDigits(this.game, this.digits, this.opts);
  }

  link(base) {
    const at = String(base).split('#')[0];
    return `${at}#g=${this.code}`;
  }

  /* True when other is this session's past, so this session may replace it. Equal counts.
     Used to refuse a link that quietly rewinds the game. */
  extendsFrom(otherDigits) {
    if (otherDigits.length > this.digits.length) return false;
    for (let i = 0; i < otherDigits.length; i++) {
      if (otherDigits[i][0] !== this.digits[i][0] || otherDigits[i][1] !== this.digits[i][1]) return false;
    }
    return true;
  }

  static fromCode(game, code, opts = {}) {
    const clean = String(code).trim().replace(/^.*#g=/s, '').replace(/\s+/g, '');
    if (clean === '') throw new CourierError('BAD_FORMAT', 'there is no code here');
    const { version, gameId, acc } = unpack(clean);
    if (version !== CODEC_VERSION) {
      throw new CourierError('BAD_VERSION', `this code is format ${version} and this page speaks format ${CODEC_VERSION}`);
    }
    if (gameId !== game.id) {
      throw new CourierError('WRONG_GAME', `this code is for game ${gameId}, not ${game.name}`);
    }
    const s = new Session(game, opts);
    let a = acc;
    while (a > 1n) {
      if (game.isOver(s.state)) {
        throw new CourierError('TRAILING_DATA', 'this code carries moves that come after the game ended');
      }
      const legal = game.legalMoves(s.state);
      const radix = BigInt(legal.length);
      const index = Number(a % radix);
      a = a / radix;
      const by = game.mover(s.state);
      s.digits.push([legal.length, index]);
      s.state = game.apply(s.state, legal[index]);
      s.history.push({ kind: 'move', move: legal[index], by });
      s._settle();
    }
    return s;
  }
}

/* ---------------------------------------------------------------- the length bound

   The point of this function is that a caller can know, before a single move is played,
   the longest link the game can ever produce. A transport that cannot carry that number is
   the wrong transport, and you find out at the start rather than at move 40.
*/
export function codeLengthBound(game) {
  const log2Product = game.branchBoundLog2();
  const bits = Math.ceil(log2Product) + 1; // +1 for the sentinel: acc < 2 * product
  const payloadBytes = Math.ceil(bits / 8);
  const bytes = payloadBytes + 4; // version, game id, two checksum bytes
  return {
    bits,
    bytes,
    chars: Math.ceil((bytes * 4) / 3),
    note: `${game.name}: at most ${bits} bits of choice in any legal game`,
  };
}
