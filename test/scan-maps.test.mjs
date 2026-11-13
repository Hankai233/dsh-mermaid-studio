/**
 * The scanner's two bookkeeping maps: bounded, and pruned where they used to
 * only grow.
 *
 *   · bgAttempted   — "this key already had a background attempt" was a plain
 *     object with no bound, cleared only on dispose. One ~40-char key per
 *     distinct cache key (source × theme × scope × font × render config) for the
 *     life of the page. Now an insertion-ordered Map with a FIFO cap.
 *   · app.negative  — the negative render cache evaluated its TTL only on read,
 *     so an expired entry was ignored but never removed, and the map grew with
 *     every diagram that ever failed. Now the write path sweeps.
 *
 * Stub-level, same shape as scan.test.mjs: the scanner is DOM-driven, so blocks,
 * root, card and the fence/theme/renderConfig modules are stood in. What is
 * under test is the bookkeeping and the gates around it, not mermaid.
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

/** Mirrors BG_ATTEMPTED_MAX in src/client/scan.js. */
const BG_CAP = 400;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for a predicate without paying the platform timer quantum per step:
 * alternate microtask turns (where the stubbed idle callbacks run) with a real
 * 1 ms timer so anything that genuinely needs a timer still makes progress.
 */
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (let i = 0; ; i += 1) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    if (i % 8 === 7) await delay(1);
    else await Promise.resolve();
  }
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
    const state = { phase: 'pending', rejectedDirectives: false };
    const calls = { showPending: 0, showSvg: 0, showError: 0 };
    const card = {
      el: el,
      key: options.key,
      source: options.source,
      state: state,
      calls: calls,
      mount: function (block) {
        el.nextElementSibling = block;
        block._mounts += 1;
      },
      presize: function () {},
      showPending: function () {
        calls.showPending += 1;
        state.phase = 'pending';
      },
      showError: function (message) {
        calls.showError += 1;
        state.phase = 'error';
        state.error = message;
        app.stats.publish();
      },
      showSvg: function () {
        calls.showSvg += 1;
        state.phase = 'ready';
        return true;
      },
      showOverLong: function () {
        state.phase = 'error';
      },
      setSkeletonSize: function () {},
      setBreakerVisible: function () {},
      getSvg: function () {
        return null;
      },
      dispose: function () {
        el.isConnected = false;
      }
    };
    created.push({ key: options.key, source: options.source, card: card });
    return card;
  };
}

async function boot(options) {
  const sandbox = { console, TextEncoder, setTimeout, clearTimeout, Date, Math, JSON, Promise };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  for (const name of ['config.js', 'key.js', 'scan.js']) {
    vm.runInContext(await readFile(path.join(CHUNKS, name), 'utf8'), context, { filename: name });
  }
  const MMS = sandbox.__MMS__;

  const blocks = options.sources.map((source) => ({
    nodeType: 1,
    isConnected: true,
    _source: source,
    _mounts: 0,
    closest: () => null,
    matches: () => false,
    querySelector: () => null,
    querySelectorAll: () => []
  }));
  const root = {
    nodeType: 1,
    contains: (node) => blocks.indexOf(node) >= 0,
    querySelectorAll: (selector) => (selector === BLOCK_SELECTOR ? blocks : []),
    closest: () => null
  };
  const doc = {
    hidden: true, // prerender stays off until a test asks for it
    body: { nodeType: 1 },
    querySelectorAll: (selector) => (selector === ROOT_SELECTOR ? [root] : []),
    querySelector: () => null
  };
  sandbox.document = doc;
  sandbox.MutationObserver = function MutationObserver() {
    this.observe = function () {};
    this.disconnect = function () {};
  };
  if (options.lazy) {
    // Observing but never intersecting: every card stays offscreen, which is
    // exactly the state prerender is allowed to work on.
    sandbox.IntersectionObserver = function IntersectionObserver() {
      this.observe = function () {};
      this.unobserve = function () {};
      this.disconnect = function () {};
    };
  }

  /**
   * The scanner schedules idle work through requestIdleCallback. This machine's
   * setTimeout quantum is ~15 ms, which would make an attempt-per-key test take
   * over 7 s; a microtask stand-in keeps the same call ordering (return id →
   * run later) without the wall-clock cost.
   */
  let idleSeq = 0;
  const cancelledIdle = new Set();
  const idleErrors = [];
  sandbox.requestIdleCallback = function (fn) {
    idleSeq += 1;
    const id = idleSeq;
    Promise.resolve().then(function () {
      if (cancelledIdle.has(id)) return;
      try {
        fn({ didTimeout: false, timeRemaining: function () { return 50; } });
      } catch (error) {
        idleErrors.push(error);
      }
    });
    return id;
  };
  sandbox.cancelIdleCallback = function (id) {
    cancelledIdle.add(id);
  };

  MMS.fence = {
    SELECTORS: { root: ROOT_SELECTOR, block: BLOCK_SELECTOR },
    parseFence: (block) => ({
      block: block,
      source: block._source,
      rejected: false,
      empty: false,
      overLong: false
    }),
    inOwnCard: () => false,
    inExcludedRegion: () => false
  };
  MMS.theme = { revision: () => 'rev-1', sampleFontCode: () => 'mono/12px' };
  MMS.renderConfig = { configToken: () => 'cfg-1' };

  const created = [];
  MMS.createCard = makeCardFactory(created);

  const errors = [];
  const seenKeys = [];
  const activity = { on: false };
  const queue = {
    pushes: [],
    push: function (job) {
      queue.pushes.push(job);
    },
    dropBackground: function () {
      return 0;
    },
    isBusy: function () {
      return false;
    },
    length: function () {
      return 0;
    }
  };
  const app = {
    config: { cacheEnabled: !!options.prerender },
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
    hasActivity: () => activity.on,
    activityAge: () => 1e9,
    negative: new Map(),
    nextRenderId: (uid) => 'r-' + uid,
    cache: {
      get: function (key) {
        seenKeys.push(key);
        return Promise.resolve(null);
      },
      put: function () {
        return Promise.resolve(false);
      },
      makeRecord: function (record) {
        return record;
      }
    },
    queue: queue
  };

  return { MMS, sandbox, doc, blocks, created, errors, app, activity, queue, seenKeys, idleErrors };
}

/** One scheduled prerender: wait for it to reach queue.push(). */
async function nextAttempt(env, scanner) {
  const start = env.queue.pushes.length;
  scanner.schedulePrerender();
  const pushed = await waitFor(() => env.queue.pushes.length > start, 800);
  return pushed ? env.queue.pushes[env.queue.pushes.length - 1] : null;
}

test('bgAttempted is bounded: 450 distinct keys never grow the set past the cap', async (t) => {
  const sources = [];
  for (let i = 0; i < 450; i += 1) sources.push('graph TD\n A' + i + ' --> B');
  const env = await boot({ sources: sources, lazy: true, prerender: true });
  const scanner = env.MMS.startScanner(env.app);
  t.after(() => scanner.dispose());

  assert.ok(await waitFor(() => scanner.cardCount() === 450, 5000), 'every fence got a card');
  env.doc.hidden = false;
  env.activity.on = true;

  let worst = 0;
  for (let attempt = 0; attempt < 480; attempt += 1) {
    const job = await nextAttempt(env, scanner);
    assert.ok(job, 'prerender attempt #' + attempt + ' produced a job');
    assert.equal(job.background, true, 'the job is a background one');
    worst = Math.max(worst, scanner.prerenderState().attempted);
    scanner.outcomeHandler({ type: 'timeout', uid: job.uid });
  }

  assert.ok(worst <= BG_CAP, 'attempted never exceeded the cap, saw ' + worst);
  assert.equal(scanner.prerenderState().attempted, BG_CAP, 'the set filled to the cap and then evicted');
  assert.ok(BG_CAP < 450, 'the scenario really produced more distinct keys than the cap');
  assert.deepEqual(env.errors, [], 'no internal error was recorded');
  assert.deepEqual(env.idleErrors, [], 'no idle callback threw');
});

test('the same cache key is never prerendered twice in one session', async (t) => {
  const env = await boot({
    sources: ['graph TD\n X --> Y', 'graph TD\n X --> Y', 'graph TD\n P --> Q'],
    lazy: true,
    prerender: true
  });
  const scanner = env.MMS.startScanner(env.app);
  t.after(() => scanner.dispose());

  assert.ok(await waitFor(() => scanner.cardCount() === 3, 1000), 'three fences got cards');
  assert.equal(env.created[0].key, env.created[1].key, 'identical fences share one cache key');
  env.doc.hidden = false;
  env.activity.on = true;

  const first = await nextAttempt(env, scanner);
  assert.ok(first, 'the first prerender happened');
  assert.equal(first.key, env.created[0].key, 'it picked the first unrendered fence');
  scanner.outcomeHandler({ type: 'timeout', uid: first.uid });

  const second = await nextAttempt(env, scanner);
  assert.ok(second, 'the second prerender happened');
  assert.notEqual(second.key, first.key, 'the already-attempted key is skipped');
  assert.equal(second.key, env.created[2].key, 'the next distinct source is picked instead');
  scanner.outcomeHandler({ type: 'timeout', uid: second.uid });

  // Nothing distinct is left, and the duplicate fence must not be retried just
  // because its attempt is over.
  scanner.schedulePrerender();
  await delay(30);
  assert.equal(env.queue.pushes.length, 2, 'no third prerender: the duplicate key is not re-attempted');
  assert.equal(scanner.prerenderState().attempted, 2, 'two keys remembered, not three attempts');
  assert.deepEqual(env.idleErrors, [], 'no idle callback threw');
});

test('negative cache: a write sweeps expired entries and keeps live ones', async (t) => {
  const env = await boot({ sources: ['graph TD\n A --> B'], lazy: false, prerender: false });
  const scanner = env.MMS.startScanner(env.app);
  t.after(() => scanner.dispose());

  const ttl = env.MMS.CONFIG.NEGATIVE_TTL_MS;
  const now = Date.now();
  const expired = [];
  for (let i = 0; i < 250; i += 1) {
    const key = 'expired-' + i;
    expired.push(key);
    env.app.negative.set(key, now - ttl - 1000);
  }
  const live = ['live-1', 'live-2', 'live-3'];
  for (const key of live) env.app.negative.set(key, now - 1000);
  assert.equal(env.app.negative.size, 253, 'the map starts over its cap');

  const record = scanner.debug()[0];
  assert.ok(record, 'the fence got a card');
  // A foreground render failure — the only writer of the negative cache.
  scanner.outcomeHandler({ type: 'error', uid: record.uid, error: { message: 'boom' } });

  assert.equal(
    env.app.negative.size,
    live.length + 1,
    'the write swept every expired entry and recorded only the new failure'
  );
  assert.ok(
    expired.every((key) => !env.app.negative.has(key)),
    'an expired entry is removed, so that key is free to retry'
  );
  for (const key of live) assert.ok(env.app.negative.has(key), 'a live entry was kept: ' + key);
  assert.deepEqual(env.errors, [], 'no internal error was recorded');
});

test('negative cache TTL still gates retries: fresh blocks, expired allows', async (t) => {
  const env = await boot({ sources: ['graph TD\n A --> B'], lazy: false, prerender: false });
  const scanner = env.MMS.startScanner(env.app);
  t.after(() => scanner.dispose());

  // rerenderAll() decides every record, which is the cheapest way to observe
  // what decide() does with the negative cache.
  scanner.rerenderAll();
  assert.equal(env.seenKeys.length, 1, 'without an entry the cache is consulted');
  const key = env.seenKeys[0];

  env.app.negative.set(key, Date.now());
  scanner.rerenderAll();
  assert.equal(env.seenKeys.length, 1, 'a fresh entry suppresses the cache read');
  assert.equal(env.created[0].card.state.phase, 'error', 'the error card is shown instead');

  env.app.negative.set(key, Date.now() - env.MMS.CONFIG.NEGATIVE_TTL_MS - 1);
  scanner.rerenderAll();
  assert.equal(env.seenKeys.length, 2, 'an expired entry no longer blocks the retry');
});

test('a card already showing this source keeps its figure instead of flashing the skeleton', async (t) => {
  const env = await boot({ sources: ['graph TD\n A --> B'], lazy: false, prerender: false });
  const scanner = env.MMS.startScanner(env.app);
  t.after(() => scanner.dispose());
  const card = env.created[0].card;

  // 1. Nothing on screen yet: the skeleton is the only honest state.
  scanner.rerenderAll();
  assert.equal(card.calls.showPending, 1, 'an empty card asks for the skeleton');

  // 2. A diagram lands: the card is now showing this source.
  assert.ok(await waitFor(() => scanner.debug()[0].jobUid !== null, 500), 'a foreground job was queued');
  scanner.outcomeHandler({
    type: 'ready',
    uid: scanner.debug()[0].jobUid,
    svg: '<svg viewBox="0 0 10 10"></svg>',
    renderId: 'r-1'
  });
  assert.equal(card.state.phase, 'ready', 'the diagram is up');

  // 3. Theme switch: the key changes, the source does not. showPending() would
  //    flip data-mms-state to pending, and the skeleton overlay only becomes
  //    visible again in that state — an "old figure + skeleton" flash.
  env.app.theme = () => 'dark';
  scanner.rerenderAll();
  assert.equal(card.calls.showPending, 1, 'a same-source card is not re-covered by the skeleton');
  await Promise.resolve(); // the cache lookup settles (blank record -> enqueue)
  assert.equal(card.state.phase, 'ready', 'the old figure stays visible while the new one loads');
  assert.equal(card.calls.showPending, 1);

  // 4. The source really changed: hiding the stale figure is correct now.
  env.blocks[0]._source = 'graph TD\n A --> Z';
  scanner.rescan();
  assert.ok(await waitFor(() => card.calls.showPending === 2, 500), 'a different source may show the skeleton');
  assert.equal(card.state.phase, 'pending');
});
