/* ── stats.js — in-process counters, published where a human can read them ──
 *
 * The desktop GUI has no DevTools by default, so counters that only reach the
 * console cannot settle any acceptance question. They live on
 * `window.__mmsStats` (a plain object, mutated in place) and are also printed
 * as one console line per batch.
 */
(function (g) {
  'use strict';
  var MMS = g.__MMS__ || (g.__MMS__ = {});

  function createStats() {
    var stats = {
      renderCount: 0,
      renderIsolated: 0,
      cacheHitL1: 0,
      cacheHitL2: 0,
      cacheWrite: 0,
      cacheEvict: 0,
      cacheError: 0,
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
      line: function () {
        return (
          '[mms] render=' +
          stats.renderCount +
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
      error: function (message) {
        stats.errorCount += 1;
        stats.lastError = String(message || '').slice(0, 300);
      }
    };
    stats.publish();
    return stats;
  }

  MMS.createStats = createStats;
})(typeof globalThis !== 'undefined' ? globalThis : this);
