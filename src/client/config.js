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
    RENDER_TIMEOUT_MS: 15000,
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
