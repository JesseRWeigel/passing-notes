#!/usr/bin/env node
/* Fold src/ into one self-contained docs/index.html.
 *
 * Why a build step at all, when the whole point is a page with no dependencies.
 *
 * ES modules cannot be loaded from a file:// page. Chrome treats the origin as null and the
 * CORS check on the module fetch fails, so a page split into <script type="module"> files
 * works when served and breaks the moment somebody saves it to disk, which is exactly the
 * case this project promises to support. Inlining one classic script sidesteps that, and it
 * also means the deliverable is a single file you can attach to an email.
 *
 * The sources stay as real modules so that Node can import and unit test them directly.
 * verify.sh runs this with --check, which fails if docs/index.html is not byte for byte what
 * the current sources produce. Without that, the tested code and the shipped code drift.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORDER = ['courier.mjs', 'reversi.mjs', 'rtc.mjs', 'ui.mjs'];

/* Strip the module syntax. The sources are written so this is a purely local edit: imports
   sit alone on their own lines and every export is an `export` keyword in front of a
   declaration. Anything else is rejected rather than mangled. */
function flatten(name, source) {
  const out = [];
  for (const line of source.split('\n')) {
    if (/^\s*import\s/.test(line)) {
      if (!/from\s+'\.\//.test(line)) throw new Error(`${name}: only relative imports are allowed: ${line.trim()}`);
      continue;
    }
    if (/^\s*export\s+(default|\*|\{)/.test(line)) {
      throw new Error(`${name}: only \`export <declaration>\` is supported, found: ${line.trim()}`);
    }
    out.push(line.replace(/^export\s+/, ''));
  }
  return out.join('\n');
}

/* Two modules that both declare `el` would silently shadow each other once concatenated, and
   the failure would surface as a wrong page rather than an error. Catch it here. */
function topLevelNames(name, source) {
  const names = [];
  for (const line of source.split('\n')) {
    const m = /^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (m) names.push(m[1]);
  }
  return names.map((n) => [n, name]);
}

const parts = [];
const seen = new Map();
for (const file of ORDER) {
  const flat = flatten(file, readFileSync(join(root, 'src', file), 'utf8'));
  for (const [name, from] of topLevelNames(file, flat)) {
    if (seen.has(name)) throw new Error(`\`${name}\` is declared in both ${seen.get(name)} and ${from}`);
    seen.set(name, from);
  }
  parts.push(`/* ---- src/${file} ---- */\n${flat.trim()}\n`);
}

const bootstrap = `/* ---- bootstrap ---- */
startApp({
  game: reversi,
  Session,
  codeLengthBound,
  rtcSupported,
  rtcHonesty,
  ManualPeer,
  iceServers: [],
  maxCodeLength: DEFAULT_MAX_CODE,
});
`;

const script = `'use strict';\n(function () {\n${parts.join('\n')}\n${bootstrap}}());\n`;

// A page whose script does not parse renders as static HTML and every unit test still passes,
// so the build refuses to write one.
new vm.Script(script, { filename: 'docs/index.html inline script' });

const css = readFileSync(join(root, 'src', 'style.css'), 'utf8').trim();
const shell = readFileSync(join(root, 'src', 'page.html'), 'utf8');
for (const marker of ['/*INLINE:STYLE*/', '/*INLINE:SCRIPT*/']) {
  if (!shell.includes(marker)) throw new Error(`src/page.html is missing ${marker}`);
}
const html = shell.replace('/*INLINE:STYLE*/', css).replace('/*INLINE:SCRIPT*/', script.trim());

if (html.includes('/*INLINE:')) throw new Error('a marker survived the build');

const target = join(root, 'docs', 'index.html');
const check = process.argv.includes('--check');
if (check) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    console.error('docs/index.html does not exist. Run: node scripts/build.mjs');
    process.exit(1);
  }
  if (current !== html) {
    console.error('docs/index.html is not what src/ currently produces. Run: node scripts/build.mjs');
    process.exit(1);
  }
  console.log(`docs/index.html matches src/ (${html.length} bytes, ${ORDER.length} modules inlined)`);
} else {
  writeFileSync(target, html);
  console.log(`wrote docs/index.html (${html.length} bytes, ${ORDER.length} modules inlined)`);
}
