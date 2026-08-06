#!/usr/bin/env node
/* A deterministic dump of what the PAGE does, as opposed to what the modules compute.
 *
 * scripts/fingerprint.mjs imports src/courier.mjs and src/reversi.mjs directly, so it is blind
 * to src/ui.mjs, src/page.html and src/style.css. A sabotage in any of those would leave that
 * dump identical and the sabotage stage would have to call it a no-op, which would be a
 * statement about the fingerprint rather than about the code.
 *
 * So this one loads docs/index.html in a real browser, clicks a fixed sequence of cells, and
 * prints what the page then says about itself.
 *
 * Like the other fingerprint it ASSERTS NOTHING and always exits 0. A page that fails to load
 * prints its failure and that failure is the fingerprint. If this file could fail it could hide
 * a change behind an early exit.
 */
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = pathToFileURL(join(root, 'docs', 'index.html')).href;

const out = [];
const say = (line) => out.push(line);
const finish = () => {
  console.log(out.join('\n'));
  process.exit(0);
};

const require = createRequire(join(root, 'package.json'));
let chromium = null;
for (const candidate of [process.env.PLAYWRIGHT_CORE, join(root, 'node_modules', 'playwright-core')].filter(Boolean)) {
  try {
    const mod = await import(pathToFileURL(require.resolve(candidate)).href);
    chromium = mod.chromium ?? mod.default?.chromium ?? null;
    if (chromium) break;
  } catch {
    /* try the next one */
  }
}
if (!chromium) {
  say('page NO BROWSER');
  finish();
}

let browser;
try {
  browser = await chromium.launch();
} catch (err) {
  say(`page BROWSER WILL NOT START ${String(err).split('\n')[0].slice(0, 80)}`);
  finish();
}

try {
  const context = await browser.newContext({ offline: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 120)));
  await page.goto(PAGE);

  say(`page title ${JSON.stringify(await page.title())}`);
  say(`page ready ${JSON.stringify(await page.getAttribute('html', 'data-ready'))}`);

  const text = async (selector) => {
    try {
      return (await page.textContent(selector))?.trim() ?? 'MISSING';
    } catch {
      return 'MISSING';
    }
  };
  const value = async (selector) => {
    try {
      return await page.inputValue(selector);
    } catch {
      return 'MISSING';
    }
  };
  const board = async () => {
    try {
      return await page.$$eval('.cell', (cells) =>
        cells
          .sort((a, b) => Number(a.dataset.cell) - Number(b.dataset.cell))
          .map((c) => (c.dataset.disc === 'black' ? 'b' : c.dataset.disc === 'white' ? 'w' : '.'))
          .join(''),
      );
    } catch {
      return 'MISSING';
    }
  };

  say(`page cells ${await page.$$eval('.cell', (c) => c.length).catch(() => 'MISSING')}`);
  say(`page opening board ${await board()}`);
  say(`page bound ${await text('#bound-chars')} chars ${await text('#bound-bits')} bits`);
  say(`page storage ${await text('#storage-state')}`);
  say(`page rtc serverless=${await text('#rtc-serverless')} supported=${await text('#rtc-supported')}`);

  // A fixed sequence. Each step takes the lowest numbered legal cell, so the walk is
  // deterministic and any change to move generation, ordering or flipping moves the dump.
  let earlyCode = '';
  for (let step = 0; step < 12; step++) {
    const legal = await page
      .$$eval('.cell[data-legal="yes"]', (cells) => cells.map((c) => Number(c.dataset.cell)).sort((a, b) => a - b))
      .catch(() => []);
    if (legal.length === 0) {
      say(`page step ${step} no legal move offered`);
      break;
    }
    await page.click(`#cell-${legal[0]}`);
    if (step === 3) earlyCode = await value('#code');
    say(
      `page step ${step} played=${legal[0]} legal=${legal.join('.')} code=${await value('#code')} ` +
        `turn=${await text('#turn')} score=${await text('#score-black')}-${await text('#score-white')} ` +
        `plies=${await text('#ply-count')} digits=${await text('#digit-count')} auto=${await text('#auto-count')}`,
    );
  }
  say(`page board after twelve ${await board()}`);

  /* The link and its "fits an SMS" verdict both include the page's own file:// URL, whose
     length is a property of where this checkout happens to sit on disk. Reporting either
     directly makes the fingerprint move when the DIRECTORY changes, which is exactly the
     failure the null control in scripts/sabotage.py exists to catch, and it caught this. So
     the path length is subtracted out and only the part the code decides is recorded. */
  const pageHrefLength = await page.evaluate(() => location.href.split('#')[0].length);
  const linkLength = Number(await text('#link-length'));
  say(`page code length ${await text('#code-length')} link overhead beyond the page url ${linkLength - pageHrefLength}`);

  // What the page says when it is handed something wrong. A guard that stops being consulted
  // changes these lines even when the board does not move.
  const played = await value('#code');
  for (const [label, paste] of [
    ['rubbish', 'this is not a code at all'],
    ['empty', ''],
    ['truncated', played.slice(0, -2)],
    ['one-char', `${played.slice(0, 4)}${played[4] === 'A' ? 'B' : 'A'}${played.slice(5)}`],
  ]) {
    await page.fill('#paste', paste);
    await page.click('#load');
    const shown = (await page.isVisible('#error').catch(() => false))
      ? ((await page.textContent('#error')) ?? '').trim().slice(0, 70)
      : '';
    say(`page refuses ${label} -> ${JSON.stringify(shown)} board=${(await board()).slice(0, 16)}`);
  }

  // The rewind guard, which lives only in the page and not in the codec. Pasting an earlier
  // code from this same game is the blunder-undo attack, and the page is supposed to notice.
  await page.fill('#paste', earlyCode);
  await page.click('#load');
  const rewindSays = (await page.isVisible('#error').catch(() => false))
    ? ((await page.textContent('#error')) ?? '').trim().slice(0, 60)
    : '';
  say(`page rewind refused=${JSON.stringify(rewindSays)} pending=${await page.isVisible('#pending').catch(() => 'MISSING')}`);
  say(`page rewind board still ${(await board()).slice(0, 16)} code ${await value('#code')}`);

  // The cold-open path: a fresh page handed the link must show the same position.
  const cold = await context.newPage();
  await cold.goto(`${PAGE}#g=${played}`);
  const coldBoard = await cold
    .$$eval('.cell', (cells) =>
      cells
        .sort((a, b) => Number(a.dataset.cell) - Number(b.dataset.cell))
        .map((c) => (c.dataset.disc === 'black' ? 'b' : c.dataset.disc === 'white' ? 'w' : '.'))
        .join(''),
    )
    .catch(() => 'MISSING');
  say(`page cold open board ${coldBoard}`);
  say(`page cold open code ${await cold.inputValue('#code').catch(() => 'MISSING')}`);

  say(`page errors ${JSON.stringify(errors)}`);
} catch (err) {
  say(`page HARNESS STOPPED ${String(err && err.message ? err.message : err).split('\n')[0].slice(0, 120)}`);
} finally {
  await browser.close().catch(() => {});
}

finish();
