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
      negative: negative,
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
        // Uninstall contract (design §11): no cards, no style, no store, no
        // stats, no mms:* preferences left behind.
        cache.dropDatabase();
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

    function scheduleWarmup() {
      var run = function () {
        try {
          renderer.warm();
        } catch (error) {
          /* warm-up is best effort; the first render will retry */
        }
      };
      var idle = g.requestIdleCallback;
      var raf = g.requestAnimationFrame || function (fn) {
        return setTimeout(fn, 16);
      };
      // After the chat's first paint, during the first idle window: paying the
      // engine cost here is invisible, paying it while a diagram waits is not.
      raf(function () {
        if (typeof idle === 'function') idle(run, { timeout: 500 });
        else setTimeout(run, 0);
      });
    }

    return {
      app: app,
      start: function () {
        unmountStyles = MMS.styles.mount();
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

        // Move the one-time engine evaluation off the first diagram's critical
        // path: by the time the user scrolls to a fence it is usually warm.
        scheduleWarmup();
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
