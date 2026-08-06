/* The courier claims to be game agnostic and ADAPTER.md claims to show how. Both claims are
 * checked here against the same object, and the object is not written in this file: it is
 * extracted from ADAPTER.md itself. A documented example that nobody runs rots into a lie, and
 * this is the cheapest way to make the document fail the build when it stops being true.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Session, CourierError, codeLengthBound } from '../src/courier.mjs';
import { reversi } from '../src/reversi.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const doc = readFileSync(join(root, 'ADAPTER.md'), 'utf8');

/* Pull the fenced js blocks out of the document and turn them into a module. A data: URL has
   no base to resolve a relative import against, so the document's path is rewritten to an
   absolute file URL. Everything else is used exactly as written. */
function exampleSource() {
  const blocks = [...doc.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 2, `ADAPTER.md should carry at least two js examples, found ${blocks.length}`);
  const courier = pathToFileURL(join(root, 'src', 'courier.mjs')).href;
  const source = blocks.join('\n');
  assert.match(source, /from '\.\/src\/courier\.mjs'/, "ADAPTER.md should import the courier by its repository path");
  return source
    .replace(/from '\.\/src\/courier\.mjs'/g, `from '${courier}'`)
    .replace(/^console\.log\(.*$/gm, '')
    .concat('\nexport { game };\n'); // countdown is already exported by the document itself
}

const loaded = await import(
  `data:text/javascript;base64,${Buffer.from(exampleSource(), 'utf8').toString('base64')}`
);
const { countdown } = loaded;

test('the adapter in ADAPTER.md loads and exposes every member the courier calls', () => {
  for (const member of [
    'id', 'name', 'maxPlies', 'initial', 'mover', 'legalMoves',
    'apply', 'pass', 'isOver', 'eq', 'moveName', 'branchBoundLog2',
  ]) {
    assert.ok(member in countdown, `ADAPTER.md's example is missing ${member}`);
  }
  assert.equal(typeof countdown.id, 'number');
  assert.ok(countdown.id >= 0 && countdown.id <= 255, 'a game id has to fit in one byte');
  assert.notEqual(countdown.id, reversi.id, 'the example must not collide with Reversi');
});

test('the example from ADAPTER.md plays, encodes and decodes back to the same game', () => {
  const session = new Session(countdown);
  session.play(3).play(2);
  assert.equal(session.state.left, 16);
  const back = Session.fromCode(countdown, session.code);
  assert.equal(back.code, session.code);
  assert.equal(back.state.left, 16);
  assert.deepEqual(back.digits, session.digits);
});

test('a code for one game is refused by another game on the same courier', () => {
  const session = new Session(countdown);
  session.play(1);
  assert.throws(
    () => Session.fromCode(reversi, session.code),
    (err) => err instanceof CourierError && err.code === 'WRONG_GAME',
  );
});

test('a whole countdown game stays inside the bound ADAPTER.md proves for it', () => {
  const bound = codeLengthBound(countdown);
  for (let seed = 0; seed < 3; seed++) {
    const session = new Session(countdown);
    let n = seed;
    while (!session.over) {
      const legal = session.legalMoves();
      session.play(legal[n++ % legal.length]);
    }
    assert.ok(session.over);
    assert.equal(session.state.left, 0);
    assert.ok(
      session.code.length <= bound.chars,
      `a finished game took ${session.code.length} characters and the bound promises ${bound.chars}`,
    );
    assert.equal(Session.fromCode(countdown, session.code).code, session.code);
  }
});

test('the forced last move costs no digit, which is the saving ADAPTER.md describes', () => {
  const session = new Session(countdown);
  // Take the whole pile down to one, which leaves the mover no choice at all.
  while (session.state.left > 1) session.play(1);
  assert.ok(session.over, 'the forced final move should have been played by the courier');
  assert.ok(
    session.history.length > session.digits.length,
    'at least one ply should have been derived rather than recorded',
  );
});

test('ADAPTER.md does not reference a file that is missing', () => {
  for (const [, path] of doc.matchAll(/`(src\/[A-Za-z0-9_.\-/]+|scripts\/[A-Za-z0-9_.\-/]+|test\/[A-Za-z0-9_.\-/]+)`/g)) {
    assert.ok(
      readFileSync(join(root, path), 'utf8').length > 0,
      `ADAPTER.md points at ${path}, which does not exist`,
    );
  }
});
