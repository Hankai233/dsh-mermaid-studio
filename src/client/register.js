/* ── register.js — hand the browser half to the host's module loader ────────
 *
 * Lazy-CJS protocol: `factory(require)` returns Cordis-plugin exports, and the
 * host calls `apply(ctx)` with the real plugin context. Verified against the
 * shipped bundles in this host version (both the minified mermaid plugin and
 * @liustack/modsearch's hand-written one use exactly this shape).
 *
 * `ctx.effect` is the dispose hook: returning a function unregisters everything
 * this plugin ever put in the document, the store or localStorage.
 */
(function (g) {
  'use strict';
  var MMS = g.__MMS__;
  var ID = 'dsh-mermaid-studio';

  function boot() {
    if (!g.__ModuleLoader__ || typeof g.__ModuleLoader__.load !== 'function') {
      console.error('[mms] __ModuleLoader__ unavailable; client half not registered');
      return;
    }

    g.__ModuleLoader__.load({
      id: ID,
      factory: function (require) {
        var module = { exports: {} };
        var instance = null;

        function dispose() {
          if (!instance) return;
          try {
            instance.dispose();
          } catch (error) {
            console.error('[mms] dispose failed:', error);
          }
          instance = null;
        }

        function start(ctx) {
          if (instance) return;
          if (!g.document || g.document.readyState === 'loading') {
            g.document.addEventListener(
              'DOMContentLoaded',
              function () {
                if (!instance) begin(ctx);
              },
              { once: true }
            );
            return;
          }
          begin(ctx);
        }

        function begin(ctx) {
          try {
            instance = MMS.createApp(ctx);
            instance.start();
          } catch (error) {
            console.error('[mms] start failed:', error);
            instance = null;
          }
        }

        function apply(ctx) {
          start(ctx);
          if (ctx && typeof ctx.effect === 'function') {
            ctx.effect(function () {
              return dispose;
            }, ID + ': lifecycle');
          } else {
            // No effect hook: still clean up when the page unloads.
            g.addEventListener('pagehide', dispose, { once: true });
          }
        }

        module.exports.apply = apply;
        module.exports.inject = [];
        return module.exports;
      }
    });
  }

  boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);
