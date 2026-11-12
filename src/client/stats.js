/* ── stats.js — in-process counters, published where a human can read them ──
 *
 * The desktop GUI has no DevTools by default, so counters that only reach the
 * console cannot settle any acceptance question. They live on
 * `window.__mmsStats` (a plain object, mutated in place) and are also printed
 * as one console line per batch.
 *
 * Two families are kept apart on purpose:
 *
 *   - counters (`renderCount`, `cacheHitL1`, …) answer "did it happen".
 *   - the perf ledger (`renderLastMs` / `renderP50` / `renderP95` and the
 *     long-task totals) answers "was it slow", which counters cannot. Without
 *     durations, every post-release "it stutters" report is unanswerable and
 *     every optimisation is unfalsifiable.
 *
 * Percentiles are recomputed on each sample over a small ring, so a percentile
 * read costs nothing until the ledger is full, and never allocates per frame.
 */
(function (g) {
  'use strict';
  var MMS = g.__MMS__ || (g.__MMS__ = {});

  function percentile(sorted, p) {
    if (!sorted.length) return 0;
    var at = Math.floor(p * (sorted.length - 1));
    return sorted[at];
  }

  function createStats() {
    var samples = [];

    var stats = {
      renderCount: 0,
      renderIsolated: 0,
      cacheHitL1: 0,
      cacheHitL2: 0,
      cacheWrite: 0,
      cacheEvict: 0,
      cacheError: 0,
      /** Writes refused because a webfont had not settled: see cache.put(). */
      cacheSkipFont: 0,
      dirRejected: 0,
      sanitizeRejected: 0,
      sanitizeParseFail: 0,
      sanitizeLenientParse: 0,
      sanitizeDroppedRules: 0,
      fenceSeen: 0,
      fenceMiss: 0,
      scopeFallback: 0,
      cardBuilt: 0,
      cardDisposed: 0,
      queueBreaker: 0,
      exportCount: 0,
      timeoutCount: 0,
      errorCount: 0,
      configMissing: 0,
      configSource: 'unknown',
      mermaidVersion: 'unknown',
      lastError: '',
      /** Perf ledger. `renderMs` holds the most recent durations, newest last. */
      renderMs: [],
      renderLastMs: 0,
      renderP50: 0,
      renderP95: 0,
      /** Source scale of the last render, so a slow sample has a size attached. */
      renderLastLines: 0,
      renderLastChars: 0,
      /** Main-thread blocks over LONG_TASK_MS, whole page, since boot. */
      longTaskCount: 0,
      longTaskMaxMs: 0,
      longTaskTotalMs: 0,
      /** Subset that overlapped a mermaid render: the part this plugin owns. */
      longTaskRenderCount: 0,
      /** Controlled prerender (scan.js): scheduled / finished / skipped / cancelled. */
      prerenderScheduled: 0,
      prerenderDone: 0,
      prerenderSkipped: 0,
      prerenderCancelled: 0,
      line: function () {
        return (
          '[mms] render=' +
          stats.renderCount +
          ' p95=' +
          Math.round(stats.renderP95) +
          'ms' +
          ' lt=' +
          stats.longTaskCount +
          ' pre=' +
          stats.prerenderDone +
          ' hit=' +
          (stats.cacheHitL1 + stats.cacheHitL2) +
          ' l1=' +
          stats.cacheHitL1 +
          ' l2=' +
          stats.cacheHitL2 +
          ' dir=' +
          stats.dirRejected +
          ' san=' +
          stats.sanitizeRejected +
          ' miss=' +
          stats.fenceMiss +
          ' err=' +
          stats.errorCount
        );
      },
      publish: function () {
        g[MMS.CONFIG.STATS_KEY] = stats;
      },
      setConfig: function (cfg) {
        stats.configSource = cfg.source;
        stats.configMissing = cfg.missing;
        stats.cacheEnabled = cfg.cacheEnabled;
      },
      note: function (key, delta) {
        if (typeof stats[key] === 'number') stats[key] += delta === undefined ? 1 : delta;
      },
      /** Record one finished render; `meta` carries the source scale. */
      noteRender: function (ms, meta) {
        var value = typeof ms === 'number' && isFinite(ms) ? Math.max(0, ms) : 0;
        samples.push(value);
        var cap = MMS.CONFIG.RENDER_MS_WINDOW;
        if (samples.length > cap) samples.shift();
        stats.renderMs = samples.slice();
        stats.renderLastMs = value;
        stats.renderLastLines = meta && meta.lines ? meta.lines : 0;
        stats.renderLastChars = meta && meta.chars ? meta.chars : 0;
        var sorted = samples.slice().sort(function (a, b) {
          return a - b;
        });
        stats.renderP50 = percentile(sorted, 0.5);
        stats.renderP95 = percentile(sorted, 0.95);
      },
      /** One observed main-thread block; `duringRender` separates ours from the host's. */
      noteLongTask: function (ms, duringRender) {
        var value = Math.max(0, ms || 0);
        stats.longTaskCount += 1;
        stats.longTaskTotalMs += value;
        if (value > stats.longTaskMaxMs) stats.longTaskMaxMs = value;
        if (duringRender) stats.longTaskRenderCount += 1;
      },
      error: function (message) {
        stats.errorCount += 1;
        stats.lastError = String(message || '').slice(0, 300);
      }
    };
    stats.publish();
    return stats;
  }

  MMS.createStats = createStats;
  MMS.statsInternal = { percentile: percentile };
})(typeof globalThis !== 'undefined' ? globalThis : this);
