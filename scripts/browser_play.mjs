#!/usr/bin/env node
/* Two real browsers, a file:// URL, no network, and a whole game of Reversi played by
 * copying the link between them.
 *
 * The reason this exists rather than another unit test: the page's entire script can fail to
 * parse and every module test still passes, because the tests import the modules and never
 * load the page. So this loads the page, plays sixty one plies through actual clicks, moves
 * the code between two separate browser contexts the way a person would, and asserts on the
 * finish. Then it does the same for the failures the page promises to report.
 *
 * The no network claim is proved three ways at once, because any one of them alone has a
 * hole. Every request the browser makes is recorded and must be the page itself. Every
 * network API is replaced before the page's script runs, so calling one is recorded and
 * throws. And the loaded document is walked for anything that would fetch a subresource.
 *
 *   node scripts/browser_play.mjs            check against fixtures/recorded-game.json
 *   node scripts/browser_play.mjs --record   write that fixture from this run
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = pathToFileURL(join(root, 'docs', 'index.html')).href;
const TITLE = 'Passing Notes: Reversi with no server';
const FIXTURE = join(root, 'fixtures', 'recorded-game.json');
const record = process.argv.includes('--record');

// Never print an absolute path: verify output is pasted into the README.
const short = (p) => String(p).replace(`${root}/`, '').replace(root, '.');

let pass = 0;
let fail = 0;
const ok = (m) => {
  console.log(`  ok    ${m}`);
  pass++;
};
const bad = (m) => {
  console.log(`  FAIL  ${m}`);
  fail++;
};
const eq = (got, want, what) => {
  if (JSON.stringify(got) === JSON.stringify(want)) ok(`${what}: ${JSON.stringify(got)}`);
  else bad(`${what}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
};

/* ---- find a browser, and say something useful if there is not one ---- */
const require = createRequire(join(root, 'package.json'));
let chromium = null;
let from = null;
const tried = [];
for (const candidate of [process.env.PLAYWRIGHT_CORE, join(root, 'node_modules', 'playwright-core')].filter(Boolean)) {
  try {
    const mod = await import(pathToFileURL(require.resolve(candidate)).href);
    chromium = mod.chromium ?? mod.default?.chromium ?? null;
    if (chromium) {
      from = candidate;
      break;
    }
    tried.push(`${candidate}: no chromium export`);
  } catch (err) {
    tried.push(`${candidate}: ${String(err).split('\n')[0].slice(0, 90)}`);
  }
}
if (!chromium) {
  console.error('No usable playwright-core. Tried:');
  for (const t of tried) console.error(`    ${short(t)}`);
  console.error('Install it with: npm install  (then npx playwright install chromium)');
  console.error('Without a browser nothing here is checked: the page is never loaded, no game is');
  console.error('played, and the offline claim is never tested. The unit suite covers the codec only.');
  process.exit(2);
}

let browser;
try {
  browser = await chromium.launch();
} catch (err) {
  console.error(`playwright-core is installed but the browser will not start: ${String(err).split('\n')[0]}`);
  console.error('Install the browser build with: npx playwright install chromium');
  process.exit(2);
}
console.log(`  chromium via ${short(from)}`);

/* Replace every way a page can reach the network, before the page's own script runs. A call
   is recorded and then throws, so a page that tries is both visible and broken rather than
   quietly working in some other test where the network happens to be up. */
const TRAP = `
  window.__net = [];
  const note = (what, arg) => {
    window.__net.push(what + ' ' + String(arg === undefined ? '' : arg).slice(0, 120));
    throw new Error('this page must not touch the network: ' + what);
  };
  window.fetch = (...a) => note('fetch', a[0]);
  window.XMLHttpRequest = function () { note('XMLHttpRequest'); };
  window.WebSocket = function (u) { note('WebSocket', u); };
  window.EventSource = function (u) { note('EventSource', u); };
  if (navigator.sendBeacon) navigator.sendBeacon = (u) => note('sendBeacon', u);
`;

const requests = [];
async function offlineContext() {
  const ctx = await browser.newContext({ offline: true });
  ctx.on('request', (r) => requests.push(r.url()));
  await ctx.addInitScript(TRAP);
  return ctx;
}

async function openPage(ctx) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  await page.goto(PAGE);
  page.__errors = errors;
  return page;
}

/* Every measurement below asserts it is looking at the right page first. The browser is a
   shared resource here and another agent can navigate it out from under this script. */
async function identify(page, where) {
  const title = await page.title();
  if (title !== TITLE) throw new Error(`${where}: this is not our page, the title is ${JSON.stringify(title)}`);
  const ready = await page.getAttribute('html', 'data-ready');
  if (ready !== 'yes') throw new Error(`${where}: the page script never finished, data-ready is ${JSON.stringify(ready)}`);
}

const readBoard = (page) =>
  page.$$eval('.cell', (cells) =>
    cells
      .sort((a, b) => Number(a.dataset.cell) - Number(b.dataset.cell))
      .map((c) => (c.dataset.disc === 'black' ? 'b' : c.dataset.disc === 'white' ? 'w' : '.'))
      .join(''),
  );

const legalCells = (page) =>
  page.$$eval('.cell[data-legal="yes"]', (cells) => cells.map((c) => Number(c.dataset.cell)).sort((a, b) => a - b));

const errorText = async (page) => ((await page.isVisible('#error')) ? (await page.textContent('#error')).trim() : '');

async function handOver(fromPage, toPage) {
  const code = await fromPage.inputValue('#code');
  await toPage.fill('#paste', code);
  await toPage.click('#load');
  const complaint = await errorText(toPage);
  if (complaint) throw new Error(`the receiving page refused a legitimate code: ${complaint}`);
  const got = await toPage.inputValue('#code');
  if (got !== code) throw new Error(`the receiving page holds ${got} and the sender sent ${code}`);
  return code;
}

try {
  /* ------------------------------------------------ 1. the page loads with nothing else */
  const black = await openPage(await offlineContext());
  const white = await openPage(await offlineContext());
  await identify(black, 'black');
  await identify(white, 'white');
  ok('both pages loaded from docs/index.html over file:// and ran their script');

  const audit = await black.evaluate(() => {
    const loaderSelector = [
      'script[src]', 'link[href]', 'img[src]', 'img[srcset]', 'iframe[src]', 'frame[src]',
      'source[src]', 'source[srcset]', 'video[src]', 'audio[src]', 'object[data]',
      'embed[src]', 'track[src]', 'input[type=image][src]',
    ].join(',');
    const subresources = [...document.querySelectorAll(loaderSelector)].map((el) => {
      const raw = el.getAttribute('src') || el.getAttribute('href') || el.getAttribute('data') || el.getAttribute('srcset');
      let protocol = 'unresolvable';
      try {
        protocol = new URL(raw, location.href).protocol;
      } catch { /* keep unresolvable */ }
      return { tag: el.tagName.toLowerCase(), raw, protocol };
    });
    const cssUrls = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          for (const hit of rule.cssText.match(/url\(([^)]*)\)/g) || []) cssUrls.push(hit);
        }
      } catch (err) {
        cssUrls.push(`UNREADABLE ${err.name}`);
      }
    }
    return {
      subresources,
      cssUrls,
      resourceTimings: performance.getEntriesByType('resource').map((e) => e.name),
      links: [...document.querySelectorAll('a[href]')].map((a) => a.href),
      styleSheets: document.styleSheets.length,
      inlineScripts: document.querySelectorAll('script:not([src])').length,
    };
  });
  eq(audit.subresources, [], 'elements that would load a subresource');
  eq(audit.cssUrls, [], 'url() references inside the stylesheets');
  eq(audit.resourceTimings, [], 'resources the browser actually fetched');
  if (audit.styleSheets === 1 && audit.inlineScripts === 1) {
    ok('the page is one inline stylesheet and one inline script, so there is nothing to fetch');
  } else {
    bad(`expected one inline stylesheet and one inline script, found ${audit.styleSheets} and ${audit.inlineScripts}`);
  }
  const offsiteLinks = audit.links.filter((h) => !h.startsWith('file:'));
  if (offsiteLinks.length > 0 && offsiteLinks.every((h) => h.startsWith('https://github.com/'))) {
    ok(`${offsiteLinks.length} links point offsite, all to github.com, and a link fetches nothing`);
  } else {
    bad(`unexpected offsite links: ${JSON.stringify(offsiteLinks)}`);
  }

  /* ------------------------------------------------ 2. play the whole game */
  const decisions = [];
  const codes = [];
  let turnsPlayed = 0;
  for (;;) {
    const active = (await black.textContent('#turn')) === 'black' ? black : white;
    const passive = active === black ? white : black;
    if (await active.isVisible('#outcome')) break;
    if (++turnsPlayed > 100) throw new Error('the game did not finish within 100 turns');
    const legal = await legalCells(active);
    if (legal.length === 0) throw new Error('the active page offers no legal move and is not over');
    // Deterministic and asymmetric, so the game is decisive and the fixture is stable.
    // Black takes the lowest numbered legal cell, White the highest.
    const choice = active === black ? legal[0] : legal[legal.length - 1];
    decisions.push(choice);
    await active.click(`#cell-${choice}`);
    codes.push(await handOver(active, passive));
  }
  await identify(black, 'black after the game');
  await identify(white, 'white after the game');

  const finalCode = await black.inputValue('#code');
  const finalBoard = await readBoard(black);
  const outcome = (await black.textContent('#outcome')).trim();
  const winner = await black.getAttribute('#outcome', 'data-winner');
  const score = {
    black: Number(await black.textContent('#score-black')),
    white: Number(await black.textContent('#score-white')),
  };
  const played = {
    code: finalCode,
    decisions: decisions.map(Number),
    plies: Number(await black.textContent('#ply-count')),
    recordedDecisions: Number(await black.textContent('#digit-count')),
    derivedPlies: Number(await black.textContent('#auto-count')),
    finalBoard,
    score,
    winner,
    outcome,
    codeLength: finalCode.length,
    linkLength: Number(await black.textContent('#link-length')),
  };

  if (record) {
    mkdirSync(dirname(FIXTURE), { recursive: true });
    writeFileSync(
      FIXTURE,
      `${JSON.stringify(
        {
          recordedBy: 'scripts/browser_play.mjs --record',
          policy: 'Black plays the lowest numbered legal cell, White the highest. Deterministic.',
          note: 'scripts/check_independent.py replays code and must re-derive every field below.',
          ...played,
        },
        null,
        2,
      )}\n`,
    );
    ok(`recorded fixtures/recorded-game.json (${played.plies} plies, ${outcome})`);
  } else {
    const want = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    let drift = 0;
    for (const key of ['code', 'decisions', 'plies', 'recordedDecisions', 'derivedPlies', 'finalBoard', 'score', 'winner', 'outcome', 'codeLength']) {
      if (JSON.stringify(played[key]) !== JSON.stringify(want[key])) {
        bad(`the recorded game changed at ${key}: got ${JSON.stringify(played[key])}, fixture has ${JSON.stringify(want[key])}`);
        drift++;
      }
    }
    if (drift === 0) ok(`the game in the browser matches the recorded one exactly (${outcome})`);
  }

  if (winner === 'black' && score.black > score.white && score.black + score.white === 64) {
    ok(`the game reached a terminal state: ${outcome}, ${played.plies} plies, code ${finalCode.length} chars`);
  } else {
    bad(`the finish is wrong: winner ${winner}, score ${JSON.stringify(score)}`);
  }
  if (played.derivedPlies > 0 && played.plies === played.recordedDecisions + played.derivedPlies) {
    ok(`${played.derivedPlies} of ${played.plies} plies were derived rather than sent, and the counts add up`);
  } else {
    bad(`ply accounting is wrong: ${played.recordedDecisions} + ${played.derivedPlies} != ${played.plies}`);
  }
  eq(await readBoard(white), finalBoard, 'the two browsers agree on the final board');
  eq((await white.textContent('#outcome')).trim(), outcome, 'the two browsers agree on the winner');

  /* ------------------------------------------------ 3. the refusals */
  const mid = codes[20];
  const midBoardBefore = await readBoard(white);

  const flip = (code) => {
    const at = 6;
    const other = code[at] === 'A' ? 'B' : 'A';
    return code.slice(0, at) + other + code.slice(at + 1);
  };
  await white.fill('#paste', flip(finalCode));
  await white.click('#load');
  const corruptSays = await errorText(white);
  if (/did not survive the trip|cannot be part of it/.test(corruptSays) && (await readBoard(white)) === midBoardBefore) {
    ok(`a code with one character changed is refused and the board does not move: "${corruptSays.slice(0, 60)}..."`);
  } else {
    bad(`a corrupted code was not refused cleanly: ${JSON.stringify(corruptSays)}`);
  }

  await white.fill('#paste', 'this is not a code at all');
  await white.click('#load');
  const junkSays = await errorText(white);
  if (junkSays !== '' && (await readBoard(white)) === midBoardBefore) {
    ok(`rubbish is refused: "${junkSays.slice(0, 60)}..."`);
  } else {
    bad('rubbish was accepted');
  }

  const storageOn = (await white.textContent('#storage-state')) === 'on';
  await white.fill('#paste', mid);
  await white.click('#load');
  const rewindSays = await errorText(white);
  if (!storageOn) {
    bad('this browser allows no storage for a file:// page, so the rewind guard could not be tested');
  } else if (/not a continuation/.test(rewindSays) && (await white.isVisible('#pending'))) {
    ok(`a link that rewinds the game is refused: "${rewindSays.slice(0, 70)}..."`);
    await white.click('#accept-anyway');
    const after = await errorText(white);
    const rewoundCode = await white.inputValue('#code');
    if (after === '' && rewoundCode === mid) ok('and taking it deliberately works, so the guard is a guard and not a wall');
    else bad(`the deliberate override did not load the game: ${JSON.stringify(after)} / ${rewoundCode}`);
  } else {
    bad(`a rewinding link was not refused: ${JSON.stringify(rewindSays)}`);
  }

  // A fresh page, given the final link, must show the finished game. This is the path a
  // person actually uses, and it is the one the fragment has to survive.
  const spectator = await openPage(await offlineContext());
  await spectator.goto(`${PAGE}#g=${finalCode}`);
  await identify(spectator, 'spectator');
  eq(await readBoard(spectator), finalBoard, 'a cold page opened on the link shows the same final board');
  eq((await spectator.textContent('#outcome')).trim(), outcome, 'and the same winner');

  /* ------------------------------------------------ 4. nothing went out */
  const offsiteRequests = requests.filter((u) => !u.startsWith('file://'));
  eq(offsiteRequests, [], 'requests the browser made to anything other than the local file');
  for (const [name, page] of [['black', black], ['white', white], ['spectator', spectator]]) {
    const calls = await page.evaluate(() => window.__net);
    eq(calls, [], `network API calls from the ${name} page`);
    eq(page.__errors, [], `uncaught errors on the ${name} page`);
  }

  /* ------------------------------------------------ 5. live mode, measured honestly */
  // WebRTC is the optional transport and it does use the local network, so it is tested
  // without the offline flag. The point measured here is the size of the handshake.
  const liveA = await (await browser.newContext()).newPage();
  const liveB = await (await browser.newContext()).newPage();
  await liveA.goto(PAGE);
  await liveB.goto(PAGE);
  await identify(liveA, 'live A');
  await identify(liveB, 'live B');
  // Live mode sits behind a disclosure that is closed on purpose, so open it first.
  for (const page of [liveA, liveB]) await page.click('details summary');
  eq(await liveA.textContent('#rtc-serverless'), 'yes', 'the page reports it has no ICE servers configured');
  eq(await liveA.textContent('#rtc-supported'), 'yes', 'WebRTC is available');

  let rtc = { offerChars: null, answerChars: null, connected: false, why: '' };
  try {
    await liveA.click('#rtc-offer');
    await liveA.waitForFunction(() => document.getElementById('rtc-out').value.length > 0, null, { timeout: 20000 });
    const offer = await liveA.inputValue('#rtc-out');
    rtc.offerChars = offer.length;
    await liveB.fill('#rtc-in', offer);
    await liveB.click('#rtc-answer');
    await liveB.waitForFunction(() => document.getElementById('rtc-out').value.length > 0, null, { timeout: 20000 });
    const answer = await liveB.inputValue('#rtc-out');
    rtc.answerChars = answer.length;
    await liveA.fill('#rtc-in', answer);
    await liveA.click('#rtc-accept');
    await liveA.waitForFunction(
      () => /connected/.test(document.getElementById('rtc-status').textContent),
      null,
      { timeout: 20000 },
    );
    rtc.connected = true;
  } catch (err) {
    rtc.why = String(err.message).split('\n')[0].slice(0, 140);
  }

  if (rtc.offerChars > 0 && rtc.answerChars > 0) {
    ok(`the handshake blobs are ${rtc.offerChars} and ${rtc.answerChars} characters, against a ${finalCode.length} character game`);
  } else {
    bad(`no handshake blob was produced: ${rtc.why}`);
  }
  if (rtc.connected) {
    ok('two browsers connected peer to peer with no ICE server and no signalling server');
  } else {
    bad(`the peer connection did not open: ${rtc.why}`);
  }

  mkdirSync(join(root, 'results'), { recursive: true });
  writeFileSync(
    join(root, 'results', 'browser.json'),
    `${JSON.stringify({ page: 'docs/index.html', played, rtc, offsiteRequests: offsiteRequests.length }, null, 2)}\n`,
  );
} catch (err) {
  bad(`the harness stopped: ${err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err}`);
} finally {
  await browser.close();
}

console.log(`  browser checks: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
