/**
 * Queue behaviour for controlled prerender, plus the font guard on cache writes.
 *
 * Two properties are load-bearing and easy to lose in a refactor:
 *   - a queued background render must never delay a render the user can see;
 *   - a background render must never be able to open the breaker, because two
 *     stuck prerenders would otherwise disable the plugin for the whole session.
 *
 * The cache case is a pure predicate, so it is tested without IndexedDB.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHUNKS = path.join(HERE, '..', 'src', 'client');

async function loadQueue(options = {}) {
  const sandbox = { console, Math, Date, JSON, Promise, setTimeout, clearTimeout, isFinite };
  sandbox.globalThis = sandbox;
  sandbox.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    length: 0,
    key: () => null
  };
  const context = vm.createContext(sandbox);
  for (const name of ['config.js', 'stats.js', 'queue.js', 'cache.js']) {
    vm.runInContext(await readFile(path.join(CHUNKS, name), 'utf8'), context, { filename: name });
  }
  const MMS = sandbox.__MMS__;
  const stats = MMS.createStats();
  return { MMS, sandbox, stats };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('a foreground render overtakes every queued background render', async () => {
  const { MMS, stats } = await loadQueue();
  const order = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const queue = MMS.createQueue({
    renderer: {
      render: (job) => {
        order.push(job.uid);
        if (job.uid === 'bg-1') return gate.then(() => ({ svg: '<svg/>' }));
        return Promise.resolve({ svg: '<svg/>' });
      },
      reset: () => {}
    },
    stats,
    timeoutMs: 50,
    onOutcome: () => {}
  });

  queue.push({ uid: 'bg-1', background: true, source: 'a-->b' });
  queue.push({ uid: 'bg-2', background: true, source: 'a-->b' });
  queue.push({ uid: 'fg-1', source: 'a-->b' });
  assert.deepEqual(order, ['bg-1'], 'only the first job may start synchronously');

  release();
  await delay(5);
  assert.deepEqual(order, ['bg-1', 'fg-1', 'bg-2'], 'the foreground job must jump the background queue');
});

test('dropBackground() empties the queue without touching foreground work', async () => {
  const { MMS, stats } = await loadQueue();
  const queue = MMS.createQueue({
    renderer: { render: () => new Promise(() => {}), reset: () => {} },
    stats,
    timeoutMs: 50,
    onOutcome: () => {}
  });
  queue.push({ uid: 'bg-1', background: true, source: 'a' });
  queue.push({ uid: 'bg-2', background: true, source: 'a' });
  queue.push({ uid: 'fg-1', source: 'a' });
  assert.equal(queue.backgroundLength(), 1);
  assert.equal(queue.dropBackground(), 1);
  assert.equal(queue.backgroundLength(), 0);
  assert.equal(queue.length(), 1, 'the foreground job survives');
});

test('a background timeout does not feed the breaker', async () => {
  const { MMS, stats } = await loadQueue();
  const outcomes = [];
  const queue = MMS.createQueue({
    renderer: { render: () => new Promise(() => {}), reset: () => {} },
    stats,
    timeoutMs: 5,
    onOutcome: (outcome) => outcomes.push(outcome)
  });
  queue.push({ uid: 'bg-1', background: true, source: 'a' });
  await delay(30);
  queue.push({ uid: 'bg-2', background: true, source: 'a' });
  await delay(30);
  assert.equal(queue.isBreakerOpen(), false, 'two stuck prerenders must not disable rendering');
  assert.equal(outcomes.filter((o) => o.type === 'timeout').length, 2);
});

test('a finished render lands in the perf ledger', async () => {
  const { MMS, stats } = await loadQueue();
  const queue = MMS.createQueue({
    renderer: { render: () => Promise.resolve({ svg: '<svg/>' }), reset: () => {} },
    stats,
    onOutcome: () => {}
  });
  queue.push({ uid: 'fg-1', source: 'flowchart TD\nA-->B', theme: 'light' });
  await delay(5);
  assert.equal(stats.renderMs.length, 1);
  assert.equal(stats.renderLastLines, 2);
});

test('cache writes are refused while a webfont is still settling', async () => {
  const { MMS } = await loadQueue();
  const { fontsSettled } = MMS.cacheInternal;
  assert.equal(fontsSettled({ fonts: { status: 'loading' } }), false);
  assert.equal(fontsSettled({ fonts: { status: 'loaded' } }), true);
  // A document without a FontFaceSet must be treated as settled: the guard may
  // never silently disable caching on a platform it cannot evaluate.
  assert.equal(fontsSettled({}), true);
  assert.equal(fontsSettled(undefined), true);
});
