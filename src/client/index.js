/* ── index.js — the module-loader entry and the wiring ──────────────────────
 *
 * Contract (verified against two shipped plugins in this host version —
 * dsh-mermaid-smooth@0.2.3 and @liustack/modsearch): the browser half is loaded
 * with `window.__ModuleLoader__.load({ id, factory })`; the factory returns
 * Cordis-plugin exports; the host then calls `apply(ctx)` on the real context.
 * So `ctx` is available here, and `host.call` does not exist at all.
 *
 * Everything below is plain DOM work on top of that context. Nothing is
 * registered on the host except a dispose hook.
 */
(function (g) {
  'use strict';
  var MMS = g.__MMS__ || (g.__MMS__ = {});
  var PACKAGE_ID = 'dsh-mermaid-studio';

  function buildApp(ctx) {
    var config = MMS.resolveConfig();
    var stats = MMS.createStats();
    stats.setConfig(config);
    if (config.missing) {
      stats.configMissing = 1;
      console.warn('[mms] config channel absent; using localStorage/defaults (source=' + config.source + ')');
    }

    var sanitizer = MMS.createSanitizer({ stats: stats });
    var exporter = MMS.createExporter({ stats: stats });
    var renderer = MMS.createRenderer({ stats: stats });
    var sizes = MMS.createSizes({ stats: stats });
    var negative = new Map();
    /**
     * Scope resolution is cached per chat root, not globally: memoising the very
     * first answer meant that even when a session marker appeared later (a host
     * upgrade, or switching conversations without a reload) the plugin kept using
     * the old scope — so "per session" was silently "per page".
     */
    var scopeState = { source: 'unknown', byRoot: new WeakMap(), fallback: null };
    var scanner = null;
    var viewer = null;
    var disposed = false;

    function dispatch(outcome) {
      if (scanner) scanner.outcomeHandler(outcome);
    }

    var queue = MMS.createQueue({ renderer: renderer, stats: stats, onOutcome: dispatch });
    var cache = MMS.createCache({ stats: stats, config: config });

    /**
     * Activity signals for the prerender gates.
     *
     * `activity` fires on the first movement of any input; `quiet` fires once the
     * user has stopped for PRERENDER_QUIET_MS. Both listeners are passive and
     * capture-phase, so observing a scroll costs nothing measurable — a gate that
     * adds jank to the gesture it is trying to protect is worse than no gate.
     */
    var lastActivity = Date.now();
    /** False until the user has scrolled/typed once: a page nobody touched is not idle, it is unread. */
    var sawActivity = false;
    var quietTimer = null;
    var activityHandlers = [];
    var quietHandlers = [];

    function fireActivity() {
      lastActivity = Date.now();
      sawActivity = true;
      for (var i = 0; i < activityHandlers.length; i += 1) {
        try {
          activityHandlers[i]();
        } catch (error) {
          stats.error('activity handler: ' + error.message);
        }
      }
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(function () {
        quietTimer = null;
        for (var j = 0; j < quietHandlers.length; j += 1) {
          try {
            quietHandlers[j]();
          } catch (error) {
            stats.error('quiet handler: ' + error.message);
          }
        }
      }, MMS.CONFIG.PRERENDER_QUIET_MS);
    }

    function subscribe(list, fn) {
      list.push(fn);
      return function () {
        var at = list.indexOf(fn);
        if (at >= 0) list.splice(at, 1);
      };
    }

    /**
     * Long-task ledger. The observer cannot say whose task it was, but every mermaid
     * render has a recorded [start, end] window on the queue, so a task whose
     * `startTime` falls inside one is attributed to us and everything else to the
     * host. Without that split, "the plugin janks" and "the app janks" are the
     * same number.
     */
    var longTasks = null;
    if (typeof g.PerformanceObserver === 'function' && typeof g.PerformanceLongTaskTiming !== 'undefined') {
      try {
        longTasks = new g.PerformanceObserver(function (list) {
          var entries = list.getEntries();
          var windows = queue.windows();
          for (var i = 0; i < entries.length; i += 1) {
            var entry = entries[i];
            var during = false;
            for (var w = windows.length - 1; w >= 0; w -= 1) {
              var win = windows[w];
              var end = win.end || entry.startTime + entry.duration;
              if (entry.startTime >= win.start && entry.startTime <= end + 1) {
                during = true;
                break;
              }
            }
            stats.noteLongTask(entry.duration, during);
          }
        });
        longTasks.observe({ entryTypes: ['longtask'] });
      } catch (error) {
        longTasks = null; // unsupported: the ledger simply stays at zero
      }
    }

    function theme() {
      // Always follows the host; there is no manual override any more.
      return MMS.theme.resolve();
    }

    function mermaidVersion() {
      var version = renderer.getVersion();
      return version && version !== 'unknown' ? version : 'unknown-version';
    }

    function fontFamily(block) {
      try {
        var node = block || (g.document && g.document.querySelector('.md-code-block code'));
        if (node && g.getComputedStyle) {
          var family = g.getComputedStyle(node).fontFamily;
          if (family) return family;
        }
      } catch (error) {
        /* fall through to the static stack */
      }
      return 'ui-monospace, SFMono-Regular, Menlo, monospace';
    }

    /**
     * Session scope for the cache key. Best available signal, in order: a
     * session id in the URL, a data attribute on the chat root's ancestors, and
     * finally a constant. The constant is reported as its own source so a
     * shared scope can never be mistaken for per-session isolation.
     */
    function computeScope() {
      var root = null;
      try {
        root = g.document ? g.document.querySelector(MMS.fence.SELECTORS.root) : null;
      } catch (error) {
        root = null;
      }

      var id = null;
      var source = 'none';

      try {
        var href = (g.location && g.location.href) || '';
        var match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(href);
        if (match) {
          id = match[1];
          source = 'url';
        }
      } catch (error) {
        /* location unavailable */
      }

      if (!id && root) {
        var node = root;
        var guard = 0;
        var attrs = ['data-session-id', 'data-session', 'data-conversation-id', 'data-key'];
        while (node && guard < 12) {
          for (var i = 0; i < attrs.length; i += 1) {
            var value = node.getAttribute && node.getAttribute(attrs[i]);
            if (value) {
              id = value;
              source = 'dom:' + attrs[i];
              break;
            }
          }
          if (id) break;
          node = node.parentElement;
          guard += 1;
        }
      }

      var hash = id ? MMS.key.sha1('scope:' + id) : null;
      if (!hash) {
        // No marker anywhere: one shared scope. Reported, never disguised as
        // per-conversation isolation.
        if (!scopeState.fallback) scopeState.fallback = MMS.key.sha1('scope:na');
        hash = scopeState.fallback;
      }

      if (scopeState.source !== source) {
        scopeState.source = source;
        if (stats) {
          stats.scopeSource = source;
          stats.publish();
        }
      }

      if (root && id) {
        var known = scopeState.byRoot.get(root);
        if (known === hash) return hash;
        scopeState.byRoot.set(root, hash);
      }
      return hash;
    }

    var app = {
      config: config,
      stats: stats,
      sanitizer: sanitizer,
      exporter: exporter,
      renderer: renderer,
      queue: queue,
      cache: cache,
      sizes: sizes,
      negative: negative,
      /** Milliseconds since the last observed scroll/input. */
      activityAge: function () {
        return Date.now() - lastActivity;
      },
      /** Whether any gesture was observed at all. */
      hasActivity: function () {
        return sawActivity;
      },
      onActivity: function (fn) {
        return subscribe(activityHandlers, fn);
      },
      onQuiet: function (fn) {
        return subscribe(quietHandlers, fn);
      },
      theme: theme,
      mermaidVersion: mermaidVersion,
      fontFamily: fontFamily,
      scopeHash: computeScope,
      nextRenderId: function (base) {
        return renderer.nextRenderId(base);
      },
      openViewer: function (card) {
        if (viewer) viewer.open(card);
      },
      resetRenderer: function () {
        queue.reset();
        if (scanner) scanner.rerenderAll();
      },
      retry: function (card) {
        negative.delete(card.key);
        if (scanner && scanner.rerenderCard) scanner.rerenderCard(card);
      },
      isBreakerOpen: function () {
        return queue.isBreakerOpen();
      },
      onViewChange: function () {},
      writeLs: MMS.writeLs,
      dispose: function () {
        disposed = true;
        if (scanner) scanner.dispose();
        if (viewer) viewer.close();
        if (unsubscribeTheme) unsubscribeTheme();
        if (unmountStyles) unmountStyles();
        detachActivity();
        if (longTasks) {
          try {
            longTasks.disconnect();
          } catch (error) {
            /* already gone */
          }
          longTasks = null;
        }
        // Uninstall contract (design §11): no cards, no style, no store, no
        // stats, no mms:* preferences left behind.
        cache.dropDatabase();
        sizes.clear();
        MMS.clearPrefs();
        try {
          delete g[MMS.CONFIG.STATS_KEY];
        } catch (error) {
          g[MMS.CONFIG.STATS_KEY] = undefined;
        }
      }
    };

    var unsubscribeTheme = null;
    var unmountStyles = null;

    var ACTIVITY_EVENTS = ['scroll', 'wheel', 'keydown', 'pointerdown', 'touchstart'];
    var activityListener = function () {
      fireActivity();
    };
    var activityAttached = false;

    function attachActivity() {
      if (activityAttached || !g.addEventListener) return;
      activityAttached = true;
      for (var i = 0; i < ACTIVITY_EVENTS.length; i += 1) {
        g.addEventListener(ACTIVITY_EVENTS[i], activityListener, { passive: true, capture: true });
      }
    }

    function detachActivity() {
      if (quietTimer) {
        clearTimeout(quietTimer);
        quietTimer = null;
      }
      if (!activityAttached || !g.removeEventListener) return;
      activityAttached = false;
      for (var i = 0; i < ACTIVITY_EVENTS.length; i += 1) {
        g.removeEventListener(ACTIVITY_EVENTS[i], activityListener, { passive: true, capture: true });
      }
      activityHandlers.length = 0;
      quietHandlers.length = 0;
    }

    function themeChanged() {
      if (scanner) scanner.rerenderAll();
      if (viewer && viewer.isOpen()) viewer.close();
    }

    viewer = MMS.createViewer({
      exporter: exporter,
      onExport: function (message) {
        console.warn('[mms] ' + message);
      }
    });

    return {
      app: app,
      start: function () {
        unmountStyles = MMS.styles.mount();
        attachActivity();
        scanner = MMS.startScanner(app);
        unsubscribeTheme = MMS.theme.subscribe(function () {
          if (!disposed) themeChanged();
        });
        cache.open().then(function () {
          if (!config.cacheEnabled) return cache.clear();
          return cache.sweep();
        });
        stats.publish();
        printStats();
        if (MMS.CONFIG.AUDIT && typeof MMS.downloadAudit === 'function') {
          setTimeout(function () {
            try {
              MMS.downloadAudit();
            } catch (error) {
              console.warn('[mms] audit failed:', error);
            }
          }, 2500);
        }
        // QA hook: §15.0's two channels both need to reach the internals from
        // outside (the harness, and the in-page self-test panel). Same-origin
        // scripts can already forge __mmsStats, so this adds no trust boundary.
        g.__mmsDebug = {
          app: app,
          scanner: function () {
            return scanner;
          },
          version: MMS.CONFIG.SCHEMA
        };
        return scanner;
      },
      dispose: function () {
        app.dispose();
      },
      scanner: function () {
        return scanner;
      }
    };
  }

  function printStats() {
    try {
      console.info(g[MMS.CONFIG.STATS_KEY].line());
    } catch (error) {
      /* console may be filtered */
    }
  }

  MMS.createApp = buildApp;
  MMS.PACKAGE_ID = PACKAGE_ID;
})(typeof globalThis !== 'undefined' ? globalThis : this);
