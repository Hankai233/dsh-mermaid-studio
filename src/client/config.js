/* ── config.js — constants and the two real config keys ─────────────────────
 *
 * Only `cacheEnabled` is configurable (design §10). Everything
 * else is a constant here, so the plugin never grows a settings surface nothing
 * asked for.
 *
 * Config arrives from the host half through the web server's index-inject hook
 * as `globalThis.__DSH_MMS_CONFIG__`. That channel is not proven yet; when it
 * is absent we fall back to localStorage overrides and *record which source
 * won* in `stats.config` — a silent default would make "user turned caching
 * off but it is still on" invisible from outside.
 */
(function (g) {
  'use strict';
  var MMS = g.__MMS__ || (g.__MMS__ = {});

  var CONFIG_GLOBAL = '__DSH_MMS_CONFIG__';
  var LS_CACHE = 'mms:config:cacheEnabled';

  var CONFIG = {
    SCHEMA: 1,
    /** Bumped whenever the sanitizer's rules change: it is part of every key. */
    SANITIZER_VERSION: 1,
    /** Effective entry capacity is halved by the dual-theme split (§6.1). */
    CACHE_MAX_MB: 32,
    CACHE_TTL_DAYS: 30,
    L1_MAX: 50,
    DEFAULT_VIEW: 'diagram',
    LAZY_RENDER: true,
    /** mermaid@11 MAX_TEXTLENGTH; above this the engine throws anyway. */
    MAX_SOURCE_CHARS: 50000,
    /** Perf ledger seen through __mmsStats: how many recent renders keep a duration. */
    RENDER_MS_WINDOW: 20,
    /** A main-thread block above this is what a user feels as jank. */
    LONG_TASK_MS: 50,
    /**
     * Controlled offscreen prerender. Renders a fence nobody is looking at yet
     * during a quiet idle window, so arriving there is a cache hit instead of a
     * ~240 ms main-thread block. Gated by cacheEnabled: the product is a cache
     * write, so a disabled cache means nothing to prerender for.
     */
    PRERENDER: true,
    /** Scroll/input must have been quiet this long before background work starts. */
    PRERENDER_QUIET_MS: 1000,
    /** Give up waiting for an idle window rather than start late. */
    PRERENDER_IDLE_TIMEOUT_MS: 2000,
    /** A fence must be unchanged this long: mid-stream text must never be prerendered. */
    PRERENDER_STABLE_MS: 600,
    /** Skeleton size memo (localStorage), keyed like the cache but far cheaper. */
    LS_SIZE_PREFIX: 'mms:size:',
    SIZE_MEMO_MAX: 200,
    /** Cold-start skeleton guess when no size is remembered yet. */
    SKELETON_MIN_PX: 96,
    SKELETON_MAX_PX: 420,
    SKELETON_PER_LINE_PX: 34,
    RENDER_TIMEOUT_MS: 15000,
    /**
     * Quiet time between two renders. Concurrency 1 protects the global config,
     * but it does not make the browser able to paint: a render is a synchronous
     * main-thread block, and `finish()` used to start the next one in the same
     * task. Measured with 8 complex diagrams (qa/probe-freeze.mjs): 2129 ms of
     * long tasks in a 2219 ms burst — 96% of the time the page could not paint
     * or take input. This gap is what turns one 2.2 s freeze into eight visible
     * steps.
     */
    RENDER_COOLDOWN_MS: 120,
    /**
     * Floor for that gap. A 17 ms diagram does not need 120 ms of silence — it
     * needs one frame, so the pause scales with the render that just finished
     * and only a heavy one is worth the full cooldown. Two frames: below that
     * the browser has no room to paint at all.
     */
    MIN_RENDER_GAP_MS: 32,
    NEGATIVE_TTL_MS: 300000,
    STREAM_DEBOUNCE_MS: 300,
    BATCH_MAX: 20,
    SCAN_IDLE_FALLBACK_MS: 0,
    ZOOM_MIN: 0.1,
    ZOOM_MAX: 8,
    /** GPU texture budget per side; caps the per-diagram zoom ceiling. */
    LAYER_MAX_PX: 8192,
    /** Graph bbox must keep this many px inside the viewport when panning. */
    PAN_KEEP_PX: 24,
    IDB_NAME: 'dsh-mermaid-studio',
    IDB_VERSION: 1,
    IDB_STORE: 'diagrams',
    LS_VIEW_PREFIX: 'mms:view:',
    LS_CONFIG_CACHE: LS_CACHE,
    CONFIG_GLOBAL: CONFIG_GLOBAL,
    /** Diagnostic build switch: dump the DOM contract to a JSON download. */
    AUDIT: false,
    STYLE_ID: 'mms-styles',
    STATS_KEY: '__mmsStats'
  };

  var DEFAULTS = { cacheEnabled: true };

  function readLs(key) {
    try {
      return g.localStorage ? g.localStorage.getItem(key) : null;
    } catch (error) {
      return null; // private mode / storage disabled
    }
  }

  function writeLs(key, value) {
    try {
      if (g.localStorage) g.localStorage.setItem(key, String(value));
    } catch (error) {
      /* storage disabled: the choice simply does not persist */
    }
  }

  /**
   * Resolve config once per page. Precedence: injected host config > localStorage
   * override > constant default. The source is reported, never hidden.
   */
  function resolveConfig() {
    var injected = g[CONFIG_GLOBAL];
    var present = injected !== undefined && injected !== null && typeof injected === 'object';
    var cacheEnabled = null;
    var source;

    if (present) {
      source = 'inject';
      cacheEnabled = injected.cacheEnabled === undefined ? null : injected.cacheEnabled === true;
    } else {
      source = 'localStorage';
    }

    if (cacheEnabled === null) {
      var stored = readLs(LS_CACHE);
      cacheEnabled = stored === null ? DEFAULTS.cacheEnabled : stored === 'true';
      if (stored === null && source === 'localStorage') source = 'default';
    }

    return {
      cacheEnabled: cacheEnabled,
      source: source,
      /** 1 when neither the host channel nor a stored override was found. */
      missing: source === 'default' ? 1 : 0
    };
  }

  /** Uninstall: remove every preference this plugin ever wrote. */
  function clearPrefs() {
    var ls = g.localStorage;
    if (!ls) return;
    var doomed = [];
    try {
      for (var i = 0; i < ls.length; i += 1) {
        var key = ls.key(i);
        if (key && key.indexOf('mms:') === 0) doomed.push(key);
      }
      for (var j = 0; j < doomed.length; j += 1) ls.removeItem(doomed[j]);
    } catch (error) {
      /* storage disabled: nothing was written either */
    }
  }

  MMS.CONFIG = CONFIG;
  MMS.DEFAULTS = DEFAULTS;
  MMS.resolveConfig = resolveConfig;
  MMS.readLs = readLs;
  MMS.writeLs = writeLs;
  MMS.clearPrefs = clearPrefs;
})(typeof globalThis !== 'undefined' ? globalThis : this);
