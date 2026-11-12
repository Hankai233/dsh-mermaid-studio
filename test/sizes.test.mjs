/**
 * Skeleton size memo tests.
 *
 * The memo is a hint read during card construction, before the async cache can
 * answer. It must therefore never throw, never grow without bound, and never be
 * trusted beyond "a plausible box".
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHUNKS = path.join(HERE, '..', 'src', 'client');

function fakeStorage() {
  const map = new Map();
  return {
    get length() {
      return map.size;
    },
    key: (i) => Array.from(map.keys())[String(i)] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      map.set(k, String(v));
    },
    removeItem: (k) => {
      map.delete(k);
    }
  };
}

async function loadSizes(options = {}) {
  const sandbox = { console, Math, Date, JSON, Number, isFinite, String, setTimeout, clearTimeout };
  sandbox.globalThis = sandbox;
  if (options.storage !== null) sandbox.localStorage = options.storage || fakeStorage();
  const context = vm.createContext(sandbox);
  for (const name of ['config.js', 'sizes.js']) {
    vm.runInContext(await readFile(path.join(CHUNKS, name), 'utf8'), context, { filename: name });
  }
  return { sizes: sandbox.__MMS__.createSizes({}), MMS: sandbox.__MMS__ };
}

test('a written size is readable synchronously, exactly as written', async () => {
  const { sizes } = await loadSizes();
  assert.equal(sizes.set('k1', 6898, 1486), true);
  const memo = sizes.get('k1');
  assert.equal(memo.height, 1486);
  assert.equal(memo.width, 6898);
});

test('unknown and malformed rows read back as null, never as a bad box', async () => {
  const { sizes } = await loadSizes();
  assert.equal(sizes.get('nope'), null);
  assert.equal(sizes.get(''), null);
  assert.equal(sizes.set('bad', 0, 0), false);
  assert.equal(sizes.set('nan', 0, NaN), false);
});

test('the guess is clamped: a 200-line fence cannot reserve the whole screen', async () => {
  const { sizes, MMS } = await loadSizes();
  const tiny = sizes.guess('flowchart TD\nA-->B');
  const huge = sizes.guess(new Array(200).fill('A-->B').join('\n'));
  assert.equal(tiny, MMS.CONFIG.SKELETON_MIN_PX);
  assert.equal(huge, MMS.CONFIG.SKELETON_MAX_PX);
  assert.equal(sizes.guess(''), 0);
});

test('the store is capped: writing past the cap prunes the oldest rows', async () => {
  const { sizes, MMS } = await loadSizes();
  const cap = MMS.CONFIG.SIZE_MEMO_MAX;
  for (let i = 0; i < cap + 5; i += 1) sizes.set('key-' + i, 100, 100 + i);
  assert.ok(sizes.size() <= cap, `size ${sizes.size()} must stay within ${cap}`);
  assert.ok(sizes.size() > 0, 'pruning must not empty the store');
});

test('clear() removes every row this plugin owns', async () => {
  const { sizes } = await loadSizes();
  sizes.set('a', 10, 10);
  sizes.set('b', 10, 20);
  assert.equal(sizes.size(), 2);
  sizes.clear();
  assert.equal(sizes.size(), 0);
});

test('without localStorage every operation degrades quietly', async () => {
  const { sizes } = await loadSizes({ storage: null });
  assert.equal(sizes.get('k'), null);
  assert.equal(sizes.set('k', 10, 10), false);
  assert.equal(sizes.size(), 0);
  assert.equal(sizes.clear(), 0);
});
