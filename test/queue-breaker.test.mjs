/**
 * queue.js: what happens at the two edges of the breaker, and the perf window
 * an abandoned render used to leave open.
 *
 * - While the breaker is open the queue must not accept work it will never
 *   consume: the job used to sit in `pending` forever, so the card kept its
 *   skeleton animation, held the whole source alive, and had no error state and
 *   no reset button (the button only appears through showError()).
 * - `releaseSlot()` frees the slot when a render is abandoned, but never closed
 *   the perf window it had opened. `end: 0` is then backfilled by index.js as
 *   `start + duration`, which attributes every later long task to a render —
 *   one abandon is enough to make the session's render p95 mean nothing.
 *
 * The queue is loaded from its shipped bytes in a fresh VM context; the outcome
 * type asserted here is the contract scan.js consumes (type `timeout`), so this
 * file also pins that choice.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHUNKS = path.join(HERE, '..', 'src', 'client');

async function loadQueue() {
  const sandbox = { console, Math, Date, JSON, Promise, setTimeout, clearTimeout, isFinite };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  for (const name of ['config.js', 'stats.js', 'queue.js']) {
    vm.runInContext(await readFile(path.join(CHUNKS, name), 'utf8'), context, { filename: name });
  }
  const MMS = context.__MMS__;
  return { MMS, stats: MMS.createStats() };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitFor(predicate, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    (function poll() {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error('condition not met within ' + timeoutMs + 'ms'));
      setTimeout(poll, 5);
    })();
  });
}

/** A renderer that never settles: the only way out is the timeout + abandon path. */
function stuckRenderer(rendered) {
  return {
    render(job) {
      rendered.push(job.uid);
      return new Promise(() => {});
    },
    reset() {}
  };
}

test('jobs already queued when the breaker opens are settled, not parked', async () => {
  const { MMS, stats } = await loadQueue();
  const rendered = [];
  const outcomes = [];
  const queue = MMS.createQueue({
    renderer: stuckRenderer(rendered),
    stats,
    timeoutMs: 5,
    onOutcome: (outcome) => outcomes.push(outcome)
  });

  queue.push({ uid: 'j1', key: 'k1', source: 'graph TD\n  A --> B' });
  queue.push({ uid: 'j2', key: 'k2', source: 'graph TD\n  A --> B' });
  queue.push({ uid: 'j3', key: 'k3', source: 'graph TD\n  A --> B' });
  assert.deepEqual(rendered, ['j1'], 'serial: only the first job starts');
  assert.equal(queue.length(), 2, 'the other two wait in the queue');
  assert.equal(queue.isBreakerOpen(), false);

  // j1 times out (1), is abandoned, j2 starts and times out (2) → breaker.
  await waitFor(() => queue.isBreakerOpen());

  assert.deepEqual(rendered, ['j1', 'j2'], 'the third job must never reach the renderer');
  assert.equal(queue.length(), 0, 'nothing may stay parked behind an open breaker');

  const breaker = outcomes.filter((outcome) => outcome.type === 'breaker');
  assert.equal(breaker.length, 1, 'the breaker is announced once');

  const j3 = outcomes.filter((outcome) => outcome.uid === 'j3');
  assert.equal(j3.length, 1, 'the queued job receives exactly one outcome');
  assert.equal(j3[0].type, 'timeout', 'scan.js renders this as an error card + reset button');
  assert.equal(j3[0].breaker, true, 'a skipped render is distinguishable from a real timeout');
  // The error comes from the VM realm, so match on its message rather than
  // `instanceof` (which is realm-specific).
  assert.match(String(j3[0].error && j3[0].error.message), /breaker/);
  assert.equal(j3[0].key, 'k3');

  // The queue's own accounting: only the two renders that really timed out
  // increment the counter, and a skipped render is not reported as an error.
  assert.equal(stats.timeoutCount, 2);
  assert.equal(stats.errorCount, 0);
  assert.equal(stats.queueBreaker, 1);
});

test('a job pushed while the breaker is open is settled immediately', async () => {
  const { MMS, stats } = await loadQueue();
  const rendered = [];
  const outcomes = [];
  const queue = MMS.createQueue({
    renderer: stuckRenderer(rendered),
    stats,
    timeoutMs: 50,
    onOutcome: (outcome) => outcomes.push(outcome)
  });

  queue.setBreaker(true);
  queue.push({ uid: 'fg', key: 'kf', source: 'graph TD\n  A --> B' });

  // Settlement is synchronous: the card reaches its error state in the same
  // call, instead of waiting for a pump() that will never run.
  const fg = outcomes.filter((outcome) => outcome.uid === 'fg');
  assert.equal(fg.length, 1);
  assert.equal(fg[0].type, 'timeout');
  assert.equal(fg[0].breaker, true);
  assert.equal(queue.length(), 0);
  assert.deepEqual(rendered, [], 'nothing may be handed to the engine');
  assert.equal(stats.timeoutCount, 0, 'a skipped render is not a timeout sample');

  // Background work is settled the same way: scan.js treats a background
  // timeout as an invisible prerenderSkipped, so a prerender can never be
  // parked forever and can never pop an error card either.
  queue.push({ uid: 'bg', key: 'kb', background: true, source: 'graph TD\n  A --> B' });
  const bg = outcomes.filter((outcome) => outcome.uid === 'bg');
  assert.equal(bg.length, 1);
  assert.equal(bg[0].type, 'timeout');
  assert.equal(bg[0].breaker, true);
  assert.equal(queue.length(), 0);
  assert.deepEqual(rendered, []);
});

test('reset() reopens the queue and the next job renders', async () => {
  const { MMS, stats } = await loadQueue();
  const rendered = [];
  const outcomes = [];
  let resets = 0;
  const queue = MMS.createQueue({
    renderer: {
      render(job) {
        rendered.push(job.uid);
        if (job.uid === 'ok') return Promise.resolve({ svg: '<svg/>', renderId: 7 });
        return new Promise(() => {});
      },
      reset() {
        resets += 1;
      }
    },
    stats,
    timeoutMs: 5,
    onOutcome: (outcome) => outcomes.push(outcome)
  });

  queue.push({ uid: 'j1', key: 'k1', source: 'a' });
  queue.push({ uid: 'j2', key: 'k2', source: 'a' });
  await waitFor(() => queue.isBreakerOpen());

  queue.push({ uid: 'blocked', key: 'k3', source: 'a' });
  assert.equal(outcomes.filter((outcome) => outcome.uid === 'blocked').length, 1);

  // The slot is still held by the timed-out j2 until its abandon timer fires.
  await waitFor(() => !queue.isBusy());

  queue.reset();
  assert.equal(queue.isBreakerOpen(), false);
  assert.equal(stats.queueBreaker, 0);
  assert.equal(queue.length(), 0);

  queue.push({ uid: 'ok', key: 'kok', source: 'graph TD\n  A --> B' });
  await waitFor(() => outcomes.some((outcome) => outcome.uid === 'ok' && outcome.type === 'ready'));

  const ready = outcomes.filter((outcome) => outcome.uid === 'ok');
  assert.equal(ready.length, 1);
  assert.equal(ready[0].svg, '<svg/>');
  assert.deepEqual(rendered, ['j1', 'j2', 'ok'], 'post-reset work reaches the engine again');
  assert.equal(queue.length(), 0);
  assert.ok(resets >= 1, 'reset() restarts the engine too');
});

test('an abandoned render closes its perf window', async () => {
  const { MMS, stats } = await loadQueue();
  const queue = MMS.createQueue({
    renderer: stuckRenderer([]),
    stats,
    timeoutMs: 5,
    onOutcome: () => {}
  });

  queue.push({ uid: 'slow', key: 'k', source: 'graph TD\n  A --> B' });
  const opened = queue.windows();
  assert.equal(opened.length, 1, 'starting a render opens exactly one window');
  assert.equal(opened[0].end, 0, 'a running render has no end yet');

  // Stuck: the slot is abandoned after 2 × timeoutMs, and that path must close
  // the window instead of leaving `end: 0` for index.js to backfill.
  await waitFor(() => !queue.isBusy());
  const closed = queue.windows();
  assert.equal(closed.length, 1);
  assert.ok(closed[0].end > 0, 'releaseSlot() must call closeWindow()');
  assert.ok(closed[0].end >= closed[0].start);
});

test('a late rejection frees the slot and closes the window', async () => {
  const { MMS, stats } = await loadQueue();
  let rejectRender = null;
  const queue = MMS.createQueue({
    renderer: {
      render() {
        return new Promise((resolve, reject) => {
          rejectRender = reject;
        });
      },
      reset() {}
    },
    stats,
    timeoutMs: 5,
    onOutcome: () => {}
  });

  queue.push({ uid: 'late', key: 'k', source: 'graph TD\n  A --> B' });
  await delay(8); // the timeout has fired, the slot is still held
  assert.ok(rejectRender, 'render() was called');
  rejectRender(new Error('late failure'));

  await waitFor(() => !queue.isBusy());
  const windows = queue.windows();
  assert.equal(windows.length, 1);
  assert.ok(windows[0].end > 0, 'the slot-freed path closes the window too');
});

test('the normal completion path closes the window exactly once', async () => {
  const { MMS, stats } = await loadQueue();
  const queue = MMS.createQueue({
    renderer: { render: () => Promise.resolve({ svg: '<svg/>', renderId: 1 }), reset() {} },
    stats,
    timeoutMs: 50,
    onOutcome: () => {}
  });

  queue.push({ uid: 'a', key: 'ka', source: 'graph TD\n  A --> B' });
  await waitFor(() => queue.windows().length === 1 && queue.windows()[0].end > 0);
  const first = queue.windows()[0];
  await delay(20);
  const after = queue.windows();
  assert.equal(after.length, 1, 'no extra window was opened for the same render');
  assert.equal(after[0].end, first.end, 'the closed window is not re-closed later');

  queue.push({ uid: 'b', key: 'kb', source: 'graph TD\n  A --> B' });
  await waitFor(() => queue.windows().length === 2);
  const open = queue.windows().filter((window) => !window.end);
  assert.ok(open.length <= 1, 'at most one render window may be open at a time');
});
