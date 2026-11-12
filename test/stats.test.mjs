/**
 * Perf ledger tests.
 *
 * The ledger exists because a counter cannot answer "was it slow". These tests
 * pin the two properties that make it trustworthy: a bounded window (so a long
 * session cannot grow it) and nearest-rank percentiles over that window.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHUNKS = path.join(HERE, '..', 'src', 'client');

async function loadStats() {
  const sandbox = { console, Math, Date, JSON, isFinite };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  for (const name of ['config.js', 'stats.js']) {
    vm.runInContext(await readFile(path.join(CHUNKS, name), 'utf8'), context, { filename: name });
  }
  return { stats: sandbox.__MMS__.createStats(), MMS: sandbox.__MMS__ };
}

test('percentiles use nearest rank over the live window', async () => {
  const { stats } = await loadStats();
  for (let ms = 1; ms <= 10; ms += 1) stats.noteRender(ms, { lines: 1, chars: 5 });
  assert.equal(stats.renderLastMs, 10);
  // 10 samples: nearest-rank p50 is index floor(0.5*9)=4 -> 5, p95 index 8 -> 9
  assert.equal(stats.renderP50, 5);
  assert.equal(stats.renderP95, 9);
});

test('the window is bounded, so a long session cannot grow the ledger', async () => {
  const { stats, MMS } = await loadStats();
  const cap = MMS.CONFIG.RENDER_MS_WINDOW;
  for (let i = 0; i < cap * 3; i += 1) stats.noteRender(100, {});
  assert.equal(stats.renderMs.length, cap);
});

test('rejects non-finite durations instead of poisoning the percentiles', async () => {
  const { stats } = await loadStats();
  stats.noteRender(NaN, {});
  stats.noteRender(Infinity, {});
  stats.noteRender(4, {});
  assert.equal(stats.renderMs.length, 3);
  assert.ok(stats.renderP95 < 5, 'non-finite samples must clamp to a finite value');
});

test('long tasks keep their own totals and a render-attributed subset', async () => {
  const { stats } = await loadStats();
  stats.noteLongTask(120, true);
  stats.noteLongTask(60, false);
  assert.equal(stats.longTaskCount, 2);
  assert.equal(stats.longTaskMaxMs, 120);
  assert.equal(stats.longTaskTotalMs, 180);
  assert.equal(stats.longTaskRenderCount, 1);
});

test('the console line exposes the percentile, not just counters', async () => {
  const { stats } = await loadStats();
  stats.noteRender(250, {});
  assert.match(stats.line(), /p95=250ms/);
});
