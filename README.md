# passing-notes

Two people play Reversi by pasting a link back and forth in whatever chat app they already use.
There is no server, no account, no database and no hosting bill. The entire game lives in the
link.

Catalog task: `GAME-033`. One of a public catalog of build ideas:
https://github.com/JesseRWeigel/722-things-to-build

## What this is

Two things, and the second one is the durable part.

**A finished game.** `docs/index.html` is a single self-contained file. Open it from a disk, from
a USB stick, from GitHub Pages, from an email attachment. Click a square, copy the link, send it
to your opponent. They open it and see your move. No build step for the player, no network
request of any kind, no JavaScript loaded from anywhere.

**A reusable courier.** `src/courier.mjs` knows nothing about Reversi. Give it eleven functions
describing any turn-based perfect-information game and it will carry that game in a link too.
`ADAPTER.md` documents the interface and its example is executed by the test suite.

### Why the link is short

The naive approach sends the board, or the list of moves. This sends neither. A game is a
deterministic function from a move history to a position, so the history *is* the state, and a
history of *choices* compresses far better than a board does.

At each turn the player picks one of R legal moves, which is worth exactly log2(R) bits. The whole
game becomes a single integer in a mixed radix where the radices are the branching factors. Three
things fall out of that:

- **A forced move costs zero bits.** When only one move is legal, R is 1 and there is nothing to
  send: the reader re-derives it. Same for a forced pass. Measured across 6000 games, **3.0%** of
  all plies were re-derived rather than transmitted.
- **Nothing illegal can travel.** Digit *k* cannot be read without first replaying moves 0..k−1
  and generating the legal moves at that position, so a corrupted code decodes into some *other
  legal game*, or fails. There is no way to smuggle an illegal position through this channel.
- **The length is bounded in advance, by the rules.** Not estimated. Proven, before a move is
  played. See below.

### How long the link actually gets

A legal Reversi move is always an empty cell. The board starts with 60 empty cells and each
placement fills exactly one, so the k-th placement has at most 60 − k legal moves, and the product
over any legal game is at most 60 factorial. That is **274 bits** of choice in the worst case, so
a code cannot exceed **52 characters**, ever, for any legal game.

| | characters |
|---|---|
| Empty game | 7 |
| Growth | about **0.484 characters** per recorded decision |
| Longest of 6000 simulated games | 42 |
| Proven ceiling for any legal game | 52 |
| Worst possible whole link, from a GitHub Pages URL | 100 |

Across **6,000 simulated games** under three policies, including one that actively tries to make
the code long, the longest was **42 characters**. Median 35 to 40 depending on policy.

**A 2000-character limit is therefore unreachable for this game.** The worst possible link is
**100 characters**, leaving 1900 characters of headroom. Every carrier we measured against fits the worst
case, not merely the typical case:

| Carrier | Limit | Worst-case link fits |
|---|---|---|
| One GSM-7 SMS segment | 160 | yes |
| One post on X | 280 | yes |
| QR version 10-L, alphanumeric | 395 | yes |
| The old Internet Explorer address bar | 2083 | yes |

For other games on the same courier the limit is reachable, so `scripts/attack_url.mjs` measures
capacity generally. Inside a 2000-character link: 11,679 decisions at branching factor 2, 3,893 at
8, 1,977 at 60.

For comparison, on the same games: the move list as JSON needs 663 characters, a fixed 7 bits per
ply needs 76, and sending just the board (which throws the history away, so the receiver can no
longer check that any move was legal) needs 28.

## Running it

To play, open `docs/index.html` in a browser. Nothing else is required.

To work on it:

```bash
npm install                       # playwright-core, the only dependency, and it is dev-only
npx playwright install chromium
bash scripts/verify.sh            # the verify command; its exit code is the result
```

Individual pieces:

```bash
node scripts/build.mjs            # fold src/ into docs/index.html
node --test test/*.test.mjs       # the unit suite
node scripts/browser_play.mjs     # two real browsers play a whole game
node scripts/measure.mjs          # how long does the link get
node scripts/attack_url.mjs       # attack the central claim
python3 scripts/sabotage.py       # break the code and check something notices
```

## What holds

Everything in this section was measured by `scripts/attack_url.mjs`, and the numbers are checked
against the README by `scripts/check_claims.py` so they cannot go stale.

- **A hand-edited link is refused.** Every single-character edit at every position of complete
  game codes was tried, **133,308** of them, and all **133,308** of them were refused. This is
  arithmetic rather than luck: one base64 character spans at most 16 consecutive payload bits, and
  CRC-16/CCITT detects every burst error of 16 bits or fewer.
- **A truncated link is almost always refused.** Of **13,708 truncated prefixes** of real game
  codes, 13,707 were refused. **1** of them decoded into a different legal game. That residual is
  inherent to a 16-bit checksum, roughly one in 65,536, and it is a rate rather than a guarantee.
- **A link from a different game is refused.** The game id travels in the second byte.
- **A link the encoder could not have produced is refused.** The payload must divide back down to
  a sentinel value. Codes that fail this are well-formed base64 with a valid checksum and are
  still rejected.
- **Whitespace and full links survive**, because chat apps wrap long lines and people paste the
  whole URL. Trailing punctuation, and a client that changes the case, are refused rather than
  silently misread.
- **The page makes no network requests.** Verified in headless Chromium with the context offline,
  every network API replaced before the page's script runs, and the loaded document walked for
  anything that would fetch a subresource. Zero requests, zero resource timings.

## What does not hold

This section matters more than the one above it.

- **The encoding is not tamper-evident. It is not signed.** There is a CRC and a sentinel, and
  both are integrity checks against accidents, not authentication. There is no key anywhere in
  this format, so nothing distinguishes a code you produced from a code your opponent produced.
  In testing, **400 of 400** invented games were accepted as legitimate. An opponent does not even
  need to edit anything: they play the game they wish had happened and encode it with the same
  encoder that is sitting in their copy of the page. Do not read "base64 with a checksum" as
  anything stronger than obfuscation with a typo detector.

- **A player can rewind to undo a losing move.** An older link from the same game is a perfectly
  valid link. It decodes cleanly into the earlier position and the format raises no objection,
  because it cannot: replaying your own history is indistinguishable from having played less of
  it. The page does try. It keeps the longest game it has seen in `localStorage` and refuses a
  link that is not an extension of it. That guard is worth having and it is not authoritative:
  - it needs storage, which Chrome denies to pages opened from disk, and the page says so out
    loud when it is off,
  - it only knows games *this browser* has seen, so a fresh browser accepts a rewind silently,
  - and there is a deliberate "take it anyway" button, because sometimes you really do want to
    load an older game.

  If you want a game where rewinding is impossible, you need a referee, and a referee is a server.

- **An unrelated game of the same type decodes without complaint.** It is a legal Reversi game and
  the format has no basis to object. Only the local rewind guard notices.

- **The courier guarantees legality, not honesty.** Every position that comes back is reachable by
  legal play. Whether it is the position you actually played is a question the URL cannot answer.

- **Live mode uses the network, and says so.** The optional WebRTC transport in `src/rtc.mjs` is
  genuinely serverless in its signalling (you paste the offer and answer by hand, and the
  handshake blobs are around **630** characters against a 34-character game link). The connection
  is another matter: with no ICE servers it works only on a shared local network, and configuring
  a STUN server means talking to somebody else's machine. `rtcHonesty()` returns prose saying
  which situation the page is in, the page prints it, and `test/rtc.test.mjs` fails if it ever
  claims to be serverless while a server is configured. Two peers behind symmetric NAT cannot
  connect without a TURN relay, which is a server that carries your data. There is no WebRTC
  configuration that connects everyone with no infrastructure.

## How this is checked

Four independent legs, because a validator that shares code with the thing it validates cannot
catch that code's bugs.

1. **61 unit tests** over the codec, the rules, the adapter and the URL claims. Some of them
   assert weaknesses on purpose, so that "it is tamper-evident" cannot quietly reappear in this
   README without a test going red.
2. **A real browser.** `scripts/browser_play.mjs` runs **28 checks** in headless Chromium: two
   separate browser contexts play a complete 61-ply game by clicking cells and passing the code
   between them, then a cold page is opened on the final link, then corrupted and rewinding links
   are pasted, then two more contexts complete a WebRTC handshake. A page's entire script can fail
   to parse while every unit test passes, so the tests alone are not enough.
3. **A clean-room reimplementation.** `scripts/check_independent.py` re-derives the recorded game
   from its code in Python, sharing nothing with the JavaScript: a dict keyed by (row, column)
   instead of a flat typed array, Python integers instead of BigInt. `scripts/check_isolation.py`
   proves the independence by walking the import graph with the `ast` module rather than grepping
   for the word "import", and `verify.sh` then runs it again in a tree with `src/` and `docs/`
   deleted.
4. **Sabotage.** `scripts/sabotage.py` introduces 15 specific defects and requires that something
   notices. **15 of 15 sabotages** applied, changed the measured behaviour, and were caught.

### The sabotage rules

Each sabotage must clear three gates in order:

1. **Applied.** The pattern matched exactly once and the bytes on disk changed.
2. **Changed.** A behavioural fingerprint of what the code computes actually moved. If it did not,
   the sabotage touched a line nothing depends on, and that is reported as a **failure of the
   sabotage**, never as a passing check and never as a gap in the verification.
3. **Caught.** Only now does a nonzero exit from a check mean anything.

Two controls sit in front of all of it, and both caught real bugs in this harness on their first
run:

- **A null control.** The tree is copied unchanged into a second directory and must fingerprint
  identically. It failed immediately: the page fingerprint was reporting the link length, which
  includes the `file://` path, so an unchanged copy in a differently named directory measured
  differently. Gate 2 would have passed automatically for every UI sabotage.
- **A guard control.** Every check must exit 0 on clean code before it is allowed to condemn
  anything. It failed too: `node --test test/` exits nonzero on a healthy tree under Node 24,
  because a bare directory is resolved as a module. That guard had been marking every sabotage
  "caught", including ones it could not possibly see.

## Layout

```
docs/index.html            the whole game, one self-contained file, no subresources
src/courier.mjs            the game-agnostic encoder. The durable contribution
src/reversi.mjs            the rules, as one worked adapter
src/rtc.mjs                optional WebRTC live mode, with its honesty report
src/ui.mjs, page.html      the page
ADAPTER.md                 how to put a different game on the courier
scripts/verify.sh          the verify command
scripts/sabotage.py        break it on purpose, three gates and two controls
scripts/check_independent.py   clean-room replay, shares no code with src/
scripts/attack_url.mjs     attacks on the central claim
fixtures/recorded-game.json    a real browser game, replayed by three implementations
results/                   what the measurement scripts wrote. Not committed: verify regenerates it
```

## Unfinished

- **Only one game ships on the courier.** The adapter interface is documented and tested against a
  second toy game defined in `ADAPTER.md`, but nothing else has a real board UI. `src/ui.mjs` is
  written for an 8x8 grid and would need work for a game shaped differently.
- **No signatures.** Making the format tamper-evident needs a shared secret established out of
  band, which is a real design question rather than a missing function, and it would not fix the
  rewind problem either. Both are documented above rather than half-solved.
- **The rewind guard is per-browser.** It uses `localStorage` and does not survive a cleared
  profile or a second device.
- **The WebRTC mode has no reconnection.** If the data channel drops, the players fall back to
  passing links, which works but is not explained in the page.
- **Accessibility is basic.** Cells are real buttons with `aria-label`s and the board is keyboard
  reachable, but there is no screen-reader-oriented board summary and no reduced-motion handling.

## Status

`bash scripts/verify.sh`, run from a clean shell on a fresh clone:

```
passing-notes verify
node v24.13.0
python Python 3.12.3

== toolchain
  ok    node is on PATH
  ok    python3 is on PATH
  ok    git is on PATH
  ok    playwright-core is installed

== repo hygiene
  ok    no tracked file is larger than a megabyte
       checked 32 tracked files
  ok    no tracked file contains a NUL byte, which would blind the scan below
       0 files with a NUL byte
  ok    no credential-shaped strings and no absolute home paths in tracked files
       scanned 32 tracked files for 8 patterns

== build
  ok    docs/index.html is exactly what src/ produces
       docs/index.html matches src/ (49368 bytes, 4 modules inlined)

== unit tests
  ok    61 unit tests passed

== the recorded game, replayed three ways
  ok    src/ replays fixtures/recorded-game.json
               src/ replays 34 characters into 61 plies, 49-15 to black
  ok    the independent checker imports nothing from this package (proved with ast)
               check_independent.py: 2 imports, all standard library (json, sys), no call that could reach src/, docs/
  ok    the independent checker still works with src/ and docs/ deleted
               replayed 34 characters into 61 plies: 58 decisions read, 3 re-derived, 49-15 to black
       ran with no src/, no docs/, no node_modules

== measurement
  ok    link length, measured over thousands of games
         bound: 274 bits, 39 bytes, 52 characters of code
                100 characters as a full link from https://jesserweigel.github.io/passing-notes/
         uniform random                     2000 games, code 30 to 38 chars (median 35), 1929 decisive
         greedy most flips                  2000 games, code 12 to 38 chars (median 35), 1926 decisive
         widen, tries to make the code long 2000 games, code 38 to 42 chars (median 40), 1885 decisive
         longest of 6000 games: 42 chars from "widen, tries to make the code long" seed 3
                that game as JSON move names: 663 chars, at 7 bits a ply: 76
         3.0% of all plies were derived by the reader, not sent
         worst case link fits one GSM-7 SMS segment (160)
         worst case link fits one post on X (280)
         worst case link fits QR version 10-L, alphanumeric (395)
         worst case link fits the old Internet Explorer address bar (2083)
  ok    the URL claims, attacked
         truncation      13707/13708 prefixes refused, 1 decoded into some other game
         one char edited 133308/133308 exhaustive single-character edits refused, 0 slipped through
         forgery         118/400 payload edits with a repaired checksum survived the sentinel (118 as a different game)
                         400/400 invented games encoded from scratch were accepted, which needs no attack at all
         wrong game id   refused with WRONG_GAME
         stranger's game decodes cleanly (59 decisions), caught only by the local rewind guard
         replay          an older link (30 of 59 decisions) decodes cleanly; the format does not prevent a rewind
         length          0.484 chars per decision, longest seen 38, proven ceiling 52 (100 as a link)
                         a 2000 character limit is unreachable for Reversi, with 1900 characters of headroom
                         a game branching 2 ways every turn fits 11679 decisions in 2000 characters
                         a game branching 4 ways every turn fits 5839 decisions in 2000 characters
                         a game branching 8 ways every turn fits 3893 decisions in 2000 characters
                         a game branching 20 ways every turn fits 2702 decisions in 2000 characters
                         a game branching 60 ways every turn fits 1977 decisions in 2000 characters
         mangling        a trailing full stop               refused (BAD_FORMAT)
         mangling        a trailing bracket                 refused (BAD_FORMAT)
         mangling        lowercased by a client             refused (CHECKSUM_MISMATCH)
         mangling        uppercased by a client             refused (BAD_FORMAT)
         mangling        a space inserted mid-code          survives, same game
         mangling        wrapped onto two lines             survives, same game

== two real browsers
  ok    28 browser checks passed
         ok    uncaught errors on the white page: []
         ok    network API calls from the spectator page: []
         ok    uncaught errors on the spectator page: []
         ok    the page reports it has no ICE servers configured: "yes"
         ok    WebRTC is available: "yes"
         ok    the handshake blobs are 632 and 636 characters, against a 34 character game
         ok    two browsers connected peer to peer with no ICE server and no signalling server
         browser checks: 28 passed, 0 failed

== sabotage: three gates and a null control
  ok    15 of 15 sabotages applied, changed the measured output, and were caught
         NULL CONTROL: an unchanged copy of the tree must fingerprint identically
           ok    node  15b0b1be64aa42a7 matches, so the measurement is of the code
           ok    page  b9ecfd73d5e11554 matches, so the measurement is of the code
         GUARD CONTROL: every guard must exit 0 on the clean baseline
           ok    browser      exits 0 on clean code, so a nonzero exit means something
           ok    fixture      exits 0 on clean code, so a nonzero exit means something
           ok    independent  exits 0 on clean code, so a nonzero exit means something
           ok    tests        exits 0 on clean code, so a nonzero exit means something

== the README
  ok    the README says what this is, rather than carrying the scaffold
       README.md has a description, a Status section, the verify command and an honesty section
  ok    every number in the README matches something that was measured
               16 numeric claims in the README, checked against results/*.json
  ok    the Status section carries the success line this script prints
       the Status section quotes a real passing run

RESULT: PASS
```

## License

MIT. See `LICENSE`.
