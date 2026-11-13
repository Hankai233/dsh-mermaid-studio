/**
 * Scanner batching for a root that is already full of fences.
 *
 * This is the shape of a reload, a session switch, or a long restored
 * conversation: `collectAll()` fills `candidates` in one go and flushes
 * synchronously. The old flush took `Array.from(...).slice(0, BATCH_MAX)` and
 * then `clear()`ed the set — so everything past the first 20 was never examined
 * and those diagrams stayed source blocks forever (static history produces no
 * further mutation to re-add them).
 *
 * Stub-level by necessity: the scanner is DOM-driven, so this test stands in
 * minimal block/root/card shapes and stubs `fence`, `theme`, `renderConfig` and
 * `createCard`. What is under test is the drain loop itself — consume BATCH_MAX,
 * never clear, reschedule the remainder on the same idle hop, stop on dispose.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHUNKS = path.join(HERE, '..', 'src', 'client');
const BLOCK_SELECTOR = '.md-code-block';
const ROOT_SELECTOR = '[data-slot="conversation.chat.flow"]';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadScanner() {
  const sandbox = { console, TextEncoder, setTimeout, clearTimeout, Date, Math, JSON };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  for (const name of ['config.js', 'stats.js', 'key.js', 'scan.js']) {
    vm.runInContext(await readFile(path.join(CHUNKS, name), 'utf8'), context, { filename: name });
  }
  const MMS = sandbox.__MMS__;
  sandbox.MutationObserver = function MutationObserver() {
    this.observe = function () {};
    this.disconnect = function () {};
  };
  return { MMS, sandbox };
}

function makeCardFactory(created) {
  return function createCard(app, options) {
    const el = {
      isConnected: true,
      attrs: {},
      nextElementSibling: null,
      setAttribute: function (name, value) {
        this.attrs[name] = String(value);
      },
      getAttribute: function (name) {
        return this.attrs[name] === undefined ? null : this.attrs[name];
      }
    };
    created.push({ key: options.key, source: options.source });
    return {
      el: el,
      key: options.key,
      state: { phase: 'pending' },
      mount: function (block) {
        el.nextElementSibling = block; // sweepOrphans requires card-before-block
        block._mounts += 1;
      },
      presize: function () {},
      showPending: function () {},
      showError: function () {},
      showSvg: function () {
        return true;
      },
      showOverLong: function () {},
      setSkeletonSize: function () {},
      setBreakerVisible: function () {},
      getSvg: function () {
        return null;
      },
      dispose: function () {
        el.isConnected = false;
      }
    };
  };
}

/** A root whose every fence is already present, as a restore/reload produces. */
function mountRoot(MMS, sandbox, count) {
  const blocks = [];
  for (let i = 0; i < count; i += 1) {
    blocks.push({
      nodeType: 1,
      isConnected: true,
      _source: 'graph TD\n N' + i + ' --> B',
      _mounts: 0,
      closest: () => null,
      matches: () => false,
      querySelector: () => null,
      querySelectorAll: () => []
    });
  }
  const root = {
    nodeType: 1,
    contains: (node) => blocks.indexOf(node) >= 0,
    querySelectorAll: (selector) => (selector === BLOCK_SELECTOR ? blocks : []),
    closest: () => null
  };
  sandbox.document = {
    hidden: true,
    body: { nodeType: 1 },
    querySelectorAll: (selector) => (selector === ROOT_SELECTOR ? [root] : []),
    querySelector: () => null
  };

  MMS.fence = {
    SELECTORS: { root: ROOT_SELECTOR, block: BLOCK_SELECTOR },
    parseFence: (block) => ({ block: block, source: block._source, rejected: false, empty: false, overLong: false }),
    inOwnCard: () => false,
    inExcludedRegion: () => false
  };
  MMS.theme = { revision: () => 'rev-1', sampleFontCode: () => 'mono/12px' };
  MMS.renderConfig = { configToken: () => 'cfg-1' };

  const created = [];
  const errors = [];
  MMS.createCard = makeCardFactory(created);

  const app = {
    config: { cacheEnabled: false }, // prerender gates short-circuit
    stats: {
      fenceSeen: 0,
      renderCount: 0,
      fenceMiss: 0,
      error: (message) => errors.push(message),
      note: () => {},
      publish: () => {}
    },
    theme: () => 'default',
    mermaidVersion: () => '11.17.2',
    scopeHash: () => 'scope',
    fontFamily: () => 'mono',
    isBreakerOpen: () => false,
    hasActivity: () => false,
    activityAge: () => 1e9,
    negative: new Map(),
    nextRenderId: (uid) => 'r-' + uid,
    cache: { get: () => Promise.resolve(null), put: () => Promise.resolve(false) },
    queue: { push: () => {}, dropBackground: () => false, isBusy: () => false, length: () => 0 }
  };

  return { app, blocks, created, errors };
}

test('a root with more fences than BATCH_MAX ends up with a card for every fence', async () => {
  const { MMS, sandbox } = await loadScanner();
  const { app, blocks, created, errors } = mountRoot(MMS, sandbox, 25);

  const scanner = MMS.startScanner(app);
  assert.equal(created.length, MMS.CONFIG.BATCH_MAX, 'the synchronous first batch stays capped');
  assert.equal(scanner.cardCount(), MMS.CONFIG.BATCH_MAX);

  await delay(25);
  assert.equal(scanner.cardCount(), 25, 'the leftover candidates must not be dropped');
  assert.equal(created.length, 25);
  assert.ok(
    blocks.every((block) => block._mounts === 1),
    'every fence got exactly one card'
  );
  assert.deepEqual(errors, [], 'no examine() threw');
  scanner.dispose();
});

test('a batch of leftovers is yielded to idle, not drained in one turn', async () => {
  const { MMS, sandbox } = await loadScanner();
  const { app, created } = mountRoot(MMS, sandbox, 45);

  const scanner = MMS.startScanner(app);
  assert.equal(created.length, 20, 'one turn consumes at most BATCH_MAX');

  await delay(25);
  assert.equal(created.length, 45, 'the remaining batches arrive on their own idle hops');

  await delay(60);
  assert.equal(created.length, 45, 'nothing re-enters the loop and no card is created twice');
  scanner.dispose();
});

test('dispose() stops a scheduled leftover batch (no resume after teardown)', async () => {
  const { MMS, sandbox } = await loadScanner();
  const { app, created } = mountRoot(MMS, sandbox, 45);

  const scanner = MMS.startScanner(app);
  assert.equal(created.length, 20);
  scanner.dispose(); // window closed with work still queued

  await delay(40);
  assert.equal(created.length, 20, 'a disposed scanner must not card anything further');
});
