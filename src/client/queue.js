/* ── queue.js — serial render queue with an escape hatch ────────────────────
 *
 * Concurrency is 1 because `mermaid.initialize()` is global config. Two things
 * make a serial queue safe to ship:
 *
 *   1. A timeout changes the card's state but does NOT free the slot. Freeing it
 *      early would start the next render while the previous one is still
 *      running — exactly the global-config race the queue exists to prevent.
 *   2. If a render never settles at all (2 × timeout), the slot is freed by
 *      abandoning the engine instance (`renderer.reset()`) instead of by
 *      waiting. Without this, one pathological diagram disables the plugin for
 *      the rest of the session.
 *
 * Two consecutive timeouts open a breaker: consuming further jobs would stack
 * timeout cards and blank slots, so the queue stops and the UI offers a reset.
 */
(function (g) {
  'use strict';
  var MMS = g.__MMS__ || (g.__MMS__ = {});

  function createQueue(options) {
    var renderer = options.renderer;
    var stats = options.stats;
    var timeoutMs = options.timeoutMs || MMS.CONFIG.RENDER_TIMEOUT_MS;
    var onOutcome = options.onOutcome || function () {};

    var pending = [];
    var running = null;
    var breakerOpen = false;
    var consecutiveTimeouts = 0;
    /**
     * Recent [start, end] windows of this queue's own renders. The long-task
     * observer (index.js) has no other way to tell a block caused by a mermaid
     * render from one caused by the host app, so attribution uses `startTime`
     * against these windows instead of guessing.
     */
    var windows = [];

    function now() {
      return typeof g.performance !== 'undefined' && g.performance.now ? g.performance.now() : Date.now();
    }

    function closeWindow(at) {
      for (var i = windows.length - 1; i >= 0; i -= 1) {
        if (!windows[i].end) {
          windows[i].end = at;
          return;
        }
      }
    }

    function noteTimeout() {
      consecutiveTimeouts += 1;
      if (consecutiveTimeouts >= 2 && !breakerOpen) {
        breakerOpen = true;
        if (stats) stats.queueBreaker = 1;
        try {
          onOutcome({ type: 'breaker', queueLength: pending.length });
        } catch (error) {
          if (stats) stats.error('onOutcome: ' + error.message);
        }
        // An open breaker must not strand the work already queued behind it.
        settlePending();
      }
    }

    function noteSuccess() {
      consecutiveTimeouts = 0;
    }

    /**
     * Settle a job that will never run because the breaker is open.
     *
     * The breaker means "stop taking work", not "queue it silently". pump() used
     * to just return, so a job pushed while it was open stayed in `pending`
     * forever: its card kept the skeleton animation with no timeout, no error
     * and no reset button (the button only shows via showError), and every one
     * of those jobs held its whole source alive while scrolling kept adding
     * more.
     *
     * Settlement goes through the same onOutcome channel as any other end of a
     * job, as a `timeout`. That is the one existing outcome that reaches the
     * "error card + reset button" state without side effects that outlive
     * reset(): scan.js renders a foreground timeout as showError() and, because
     * isBreakerOpen() is true, the reset button is visible — while an `error`
     * outcome would also write a NEGATIVE_TTL_MS entry, so after reset() the
     * card would still refuse to render for five minutes. A background job
     * keeps its invisibility: scan.js treats a background timeout as a silent
     * prerenderSkipped (no card, no negative entry).
     */
    function settleBlocked(job) {
      if (!job) return;
      try {
        onOutcome({
          type: 'timeout',
          uid: job.uid,
          key: job.key,
          breaker: true, // distinguishes this from a render that really timed out
          error: new Error('renderer breaker is open; render skipped')
        });
      } catch (error) {
        if (stats) stats.error('onOutcome: ' + error.message);
      }
    }

    /** Drain `pending` through settleBlocked(); nothing is left parked. */
    function settlePending() {
      if (pending.length === 0) return;
      var blocked = pending;
      pending = [];
      for (var i = 0; i < blocked.length; i += 1) settleBlocked(blocked[i]);
    }

    function start(job) {
      running = job;
      if (job.uid && typeof job.onStart === 'function') job.onStart();

      var startedAt = now();
      windows.push({ start: startedAt, end: 0 });
      if (windows.length > 10) windows.shift();
      var settled = false;
      var timedOut = false;
      var isolated = false;
      var timer;
      var abandonTimer;

      function finish(kind, payload) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(abandonTimer);
        running = null;
        closeWindow(now());
        if (kind === 'ready') {
          noteSuccess();
          // The one place a render duration is measured: after the promise
          // settles, before the queue hands the slot on. Without this the perf
          // ledger has no samples and every "it is slow" report is a guess.
          if (stats && typeof stats.noteRender === 'function') {
            var source = job.source || '';
            stats.noteRender(now() - startedAt, {
              lines: source ? source.split('\n').length : 0,
              chars: source.length,
              background: !!job.background
            });
          }
        }
        if (kind === 'ready') noteSuccess();
        try {
          onOutcome({
            type: kind,
            uid: job.uid,
            key: job.key,
            renderId: payload && payload.renderId,
            svg: payload && payload.svg,
            error: payload && payload.error,
            timedOut: timedOut
          });
        } catch (error) {
          if (stats) stats.error('onOutcome: ' + error.message);
        }
        pump();
      }

      function releaseSlot() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(abandonTimer);
        running = null;
        // The window opened in start() has to be closed on this path too. It
        // used to be closed only in finish(), so every abandoned render left
        // `end: 0` behind; index.js then backfills `end = start + duration` and
        // attributes *every later long task* to a render, permanently poisoning
        // the p95 of the session's render cost. closeWindow() takes the newest
        // open window and is a no-op once none is open, so the normal path
        // (finish() closed it, settled is true, we return above) is untouched.
        closeWindow(now());
        pump();
      }

      var promise;
      try {
        promise = renderer.render(job);
      } catch (error) {
        promise = Promise.reject(error);
      }

      timer = setTimeout(function () {
        if (settled) return;
        timedOut = true;
        if (stats) stats.note('timeoutCount');
        // A background job must never feed the breaker: two stuck prerenders
        // would otherwise lock out every render the user can actually see.
        if (!job.background) noteTimeout();
        // Report the timeout, keep the slot: the engine is still running.
        onOutcome({
          type: 'timeout',
          uid: job.uid,
          key: job.key,
          error: new Error('render timed out after ' + timeoutMs + 'ms')
        });

        abandonTimer = setTimeout(function () {
          if (settled) return;
          isolated = true;
          if (stats) stats.note('renderIsolated');
          try {
            renderer.reset();
          } catch (error) {
            if (stats) stats.error('renderer reset failed: ' + error.message);
          }
          releaseSlot();
        }, timeoutMs);
      }, timeoutMs);

      promise.then(
        function (result) {
          if (isolated) return; // engine already abandoned; result is unusable
          finish('ready', result);
        },
        function (error) {
          if (isolated) return;
          if (timedOut) {
            // The card already shows the timeout state; keep it and free the slot.
            releaseSlot();
            return;
          }
          if (stats) stats.note('errorCount');
          finish('error', { error: error });
        }
      );
    }

    function pump() {
      if (breakerOpen) {
        // Whichever path opened the breaker, nothing may stay parked behind it.
        settlePending();
        return;
      }
      if (running || pending.length === 0) return;
      var job = pending.shift();
      if (job && job.stale && job.stale()) {
        pump();
        return;
      }
      if (job) start(job);
    }

    function push(job) {
      // Settle on the spot while the breaker is open: a job accepted here would
      // never be consumed by pump(), so this is the card's only exit (see
      // settleBlocked). reset() reopens the queue, so this is not a dead end.
      if (breakerOpen) {
        settleBlocked(job);
        return {
          cancel: function () {}
        };
      }
      // Foreground work overtakes everything queued: a prerender that has not
      // started yet must never delay a diagram the user is looking at.
      if (job && !job.background) {
        var at = -1;
        for (var i = 0; i < pending.length; i += 1) {
          if (pending[i] && pending[i].background) {
            at = i;
            break;
          }
        }
        if (at >= 0) pending.splice(at, 0, job);
        else pending.push(job);
      } else if (job) {
        pending.push(job);
      }
      pump();
      return {
        cancel: function () {
          var at = pending.indexOf(job);
          if (at >= 0) pending.splice(at, 1);
        }
      };
    }

    /** Drop every queued background job; a running one cannot be aborted. */
    function dropBackground() {
      var kept = [];
      var dropped = 0;
      for (var i = 0; i < pending.length; i += 1) {
        if (pending[i] && pending[i].background) dropped += 1;
        else kept.push(pending[i]);
      }
      pending = kept;
      return dropped;
    }

    function clear() {
      pending = [];
    }

    /** Manual recovery: new engine, breaker closed, queue drained. */
    function reset() {
      breakerOpen = false;
      consecutiveTimeouts = 0;
      pending = [];
      if (stats) stats.queueBreaker = 0;
      renderer.reset();
    }

    return {
      push: push,
      clear: clear,
      reset: reset,
      dropBackground: dropBackground,
      isBreakerOpen: function () {
        return breakerOpen;
      },
      setBreaker: function (open) {
        breakerOpen = !!open;
      },
      length: function () {
        return pending.length;
      },
      backgroundLength: function () {
        var total = 0;
        for (var i = 0; i < pending.length; i += 1) if (pending[i] && pending[i].background) total += 1;
        return total;
      },
      /** Render windows, for attributing observed long tasks to this queue. */
      windows: function () {
        return windows.slice();
      },
      isBusy: function () {
        return !!running;
      },
      timeoutMs: timeoutMs
    };
  }

  MMS.createQueue = createQueue;
})(typeof globalThis !== 'undefined' ? globalThis : this);
