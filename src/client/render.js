/* ── render.js — the mermaid instance, one at a time ────────────────────────
 *
 * `mermaid.initialize()` is global configuration: two renders in flight would
 * fight over theme and fonts, so the queue (queue.js) keeps concurrency at 1 and
 * this module only wraps init + render + temp-node cleanup.
 *
 * A "fresh instance" comes from `__mmsFreshMermaid()` — a function the build
 * wraps around the vendored mermaid bundle, so calling it again re-evaluates the
 * engine in its own scope. That is the only way out of a render that never
 * settles; without it, concurrency 1 would stall the plugin permanently.
 */
(function (g) {
  'use strict';
  var MMS = g.__MMS__ || (g.__MMS__ = {});

  /**
   * Base config. `theme` and `fontFamily` are per-call.
   *
   * `htmlLabels` is deliberately absent: it stays at the engine default
   * (`true`, i.e. foreignObject). It used to be accepted here as a third
   * parameter that was never written into the config — a documented "per-call"
   * knob that did nothing, and was absent from the cache key, so flipping it
   * would have changed neither the output nor the key. It was removed rather
   * than wired up: switching it to `false` measured ~0.5 ms on the insertion
   * layout (the only place it could plausibly matter) while changing how labels
   * wrap and clip. Measured in qa/bench-insert-layout.mjs.
   */
  function baseConfig(theme, fontFamily) {
    return {
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      maxTextSize: MMS.CONFIG.MAX_SOURCE_CHARS,
      maxEdges: 2000,
      theme: theme === 'dark' ? 'dark' : 'default',
      fontFamily: fontFamily
    };
  }

  /** `cfg:` part of the cache key: fixed keys, fixed order, no JSON.stringify. */
  function configToken(theme, fontFamily) {
    return [
      'theme=' + (theme === 'dark' ? 'dark' : 'default'),
      'font=' + fontFamily,
      'securityLevel=strict',
      'flowchart=default',
      'maxTextSize=' + MMS.CONFIG.MAX_SOURCE_CHARS
    ].join(';');
  }

  function createMermaidInstance() {
    if (typeof g.__mmsFreshMermaid === 'function') {
      var fresh = g.__mmsFreshMermaid();
      if (fresh) return fresh;
    }
    if (g.mermaid && typeof g.mermaid.render === 'function') return g.mermaid;
    throw new Error('mermaid engine unavailable');
  }

  /**
   * Version for the cache key. Read from the build constant, never from the
   * engine: computing a key must not evaluate the 3.5 MB mermaid bundle, or a
   * page whose diagrams are all cached still pays the one-time init (~190 ms
   * measured in Chromium).
   */
  function readVersion(mermaid) {
    if (typeof g.__MMS_MERMAID_VERSION__ === 'string') return g.__MMS_MERMAID_VERSION__;
    if (mermaid && typeof mermaid.version === 'string') return mermaid.version;
    return 'unknown';
  }

  function removeQuietly(node) {
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  /**
   * mermaid appends a scratch container to `document.body` for each render and
   * removes it on success. On error or timeout it stays behind, so the ids are
   * swept here — in a `finally`, not only on success.
   */
  function cleanupTemp(renderId) {
    var doc = g.document;
    if (!doc || !renderId) return;
    var ids = [renderId, 'd' + renderId, 'i' + renderId];
    for (var i = 0; i < ids.length; i += 1) {
      removeQuietly(doc.getElementById(ids[i]));
    }
    var strays = doc.querySelectorAll('[id^="' + renderId + '"], [id^="d' + renderId + '"]');
    for (var j = 0; j < strays.length; j += 1) {
      // Only sweep scratch nodes the engine put directly under <body>; the SVG
      // we injected carries the same id and must survive.
      if (strays[j].parentNode === doc.body) removeQuietly(strays[j]);
    }
  }

  function createRenderer(options) {
    var stats = options && options.stats;
    var mermaid = null;
    var version = 'unknown';
    var seq = 0;

    function instance() {
      if (!mermaid) {
        mermaid = createMermaidInstance();
        version = readVersion(mermaid);
        if (stats && version !== 'unknown') stats.mermaidVersion = version;
      }
      return mermaid;
    }

    /** Instantiate the engine without rendering anything (idle warm-up). */
    function warm() {
      try {
        instance();
        return true;
      } catch (error) {
        return false;
      }
    }

    function nextRenderId(base) {
      seq += 1;
      // The id ends up in the SVG and in every rewritten CSS selector, so it
      // must be a legal id and stable across a cache round-trip.
      return 'mms-' + String(base || 'r').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) + '-' + seq;
    }

    function render(job) {
      // Engine evaluation is a one-time ~190 ms block (3.5 MB bundle). Doing it
      // and the render in the same task made one 300 ms freeze; yielding once
      // between them turns it into two shorter blocks with a painted skeleton
      // in between.
      var coldStart = !mermaid;
      var engine = instance();
      if (coldStart) {
        return new Promise(function (resolve) {
          setTimeout(resolve, 0);
        }).then(function () {
          return doRender(engine, job);
        });
      }
      return doRender(engine, job);
    }

    function doRender(engine, job) {
      var fontFamily = job.fontFamily || 'ui-monospace, SFMono-Regular, Menlo, monospace';
      var renderId = job.renderId || nextRenderId(job.uid);
      try {
        engine.initialize(baseConfig(job.theme, fontFamily));
        return Promise.resolve(engine.render(renderId, job.source)).then(
          function (result) {
            cleanupTemp(renderId);
            if (!result || typeof result.svg !== 'string' || !result.svg) {
              throw new Error('mermaid returned no svg');
            }
            return { svg: result.svg, renderId: renderId, version: version };
          },
          function (error) {
            cleanupTemp(renderId);
            throw error;
          }
        );
      } catch (error) {
        cleanupTemp(renderId);
        return Promise.reject(error);
      }
    }

    /** Drop the engine so the next render builds a new one (isolation escape). */
    function reset() {
      mermaid = null;
      return instance();
    }

    return {
      render: render,
      reset: reset,
      warm: warm,
      nextRenderId: nextRenderId,
      getVersion: function () {
        // No instance() here on purpose: see readVersion().
        var known = readVersion(mermaid);
        if (known !== 'unknown') version = known;
        return version;
      },
      configToken: configToken
    };
  }

  MMS.createRenderer = createRenderer;
  MMS.renderConfig = { baseConfig: baseConfig, configToken: configToken, cleanupTemp: cleanupTemp };
})(typeof globalThis !== 'undefined' ? globalThis : this);
