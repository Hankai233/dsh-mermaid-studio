/* ── sizes.js — remember how big a diagram was, so its card can reserve it ──
 *
 * Why this exists: a card is mounted before its diagram exists, and a card with
 * no reserved height makes the conversation jump when the SVG lands. The cache
 * record already carries width/height — but reading it is asynchronous (L2), and
 * the jump happens at the *first paint* of the card, long before that resolves.
 * So this memo is deliberately synchronous and deliberately dumb: one small
 * localStorage row per cache key, read during card construction.
 *
 * It is a hint, never a source of truth:
 *
 *   - a missing/failed/corrupt row costs one guess, never a broken card;
 *   - rows are keyed exactly like cache entries (theme + config + source), so a
 *     stale size can only be shown for a diagram that changed, and a render
 *     always overwrites it;
 *   - the store is capped and pruned by age, because localStorage is shared with
 *     the whole host app and this plugin must not become the reason it fills.
 *
 * `guess()` is the cold-start fallback: line count is a poor predictor of a
 * diagram's box, but a poor box still beats a zero-height one, because it turns
 * a jump into a small correction.
 */
(function (g) {
  'use strict';
  var MMS = g.__MMS__ || (g.__MMS__ = {});

  function clamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
  }

  function createSizes(options) {
    var stats = options && options.stats;
    var prefix = MMS.CONFIG.LS_SIZE_PREFIX;
    var max = MMS.CONFIG.SIZE_MEMO_MAX;
    /**
     * How many rows this plugin believes it owns in localStorage. -1 = not
     * measured yet, which the first successful write fixes with one scan; after
     * that every write/remove adjusts it in O(1).
     *
     * `set()` runs once per diagram card, and `keys()` walks the *whole origin*
     * — localStorage is shared with the host and every other plugin, so the
     * old per-write `keys().length` check made each card a synchronous scan of
     * hundreds of keys it does not own. The cap is still enforced: the counter
     * crossing `max` prunes immediately, and a quota error prunes and retries.
     */
    var known = -1;
    /** Writes since the last full count: a cheap re-sync bound against drift. */
    var drift = 0;
    /** Another tab or the host may add/remove rows; recount this often, not each write. */
    var RESYNC_EVERY = 32;

    function storage() {
      try {
        return g.localStorage || null;
      } catch (error) {
        return null; // private mode / storage disabled
      }
    }

    function rowKey(key) {
      // Long keys are the norm here (hash + config token); the prefix plus a
      // truncated key keeps every row well inside a localStorage quota.
      return prefix + String(key || '').slice(0, 40);
    }

    function parse(raw) {
      if (!raw) return null;
      try {
        var value = JSON.parse(raw);
        if (!value || typeof value !== 'object') return null;
        var width = Number(value.w);
        var height = Number(value.h);
        if (!isFinite(width) || !isFinite(height) || height <= 0) return null;
        return { width: width > 0 ? width : 0, height: height, at: Number(value.at) || 0 };
      } catch (error) {
        return null;
      }
    }

    function keys() {
      var ls = storage();
      if (!ls) return [];
      var out = [];
      try {
        // Read the length once: the getter is not free and the loop cannot
        // change the store.
        var length = ls.length;
        for (var i = 0; i < length; i += 1) {
          var name = ls.key(i);
          if (name && name.indexOf(prefix) === 0) out.push(name);
        }
      } catch (error) {
        return [];
      }
      return out;
    }

    /** The one full count, on demand rather than on every write. */
    function resyncCount() {
      known = keys().length;
      drift = 0;
      return known;
    }

    function rowCount() {
      if (known < 0) resyncCount();
      return known;
    }

    /**
     * Book a successful write. `known` above `max` is what triggers a prune; a
     * periodic recount heals drift from other tabs without paying per write.
     */
    function accountWrite(existed) {
      if (known < 0) {
        // First write: the scan already includes this row, so do not add it.
        resyncCount();
        return;
      }
      if (!existed) known += 1;
      drift += 1;
      if (drift >= RESYNC_EVERY) resyncCount();
    }

    /** Drop the oldest rows until `keep` remain. Runs only when the cap is hit. */
    function prune(keep) {
      var ls = storage();
      if (!ls) return 0;
      var names = keys();
      var rows = names.map(function (name) {
        var value = parse(ls.getItem(name));
        return { name: name, at: value ? value.at : 0 };
      });
      rows.sort(function (a, b) {
        return a.at - b.at;
      });
      var doomed = rows.slice(0, Math.max(0, rows.length - keep));
      var removed = 0;
      for (var i = 0; i < doomed.length; i += 1) {
        try {
          ls.removeItem(doomed[i].name);
          removed += 1;
        } catch (error) {
          break;
        }
      }
      // The count is what `size()` answers and what trips the cap, so prune
      // leaves it exact instead of assuming every removal succeeded.
      known = Math.max(0, names.length - removed);
      drift = 0;
      return removed;
    }

    return {
      /** Synchronous lookup used while the card is being built. */
      get: function (key) {
        var ls = storage();
        if (!ls || !key) return null;
        try {
          var value = parse(ls.getItem(rowKey(key)));
          return value && value.height > 0 ? value : null;
        } catch (error) {
          return null;
        }
      },
      set: function (key, width, height) {
        var ls = storage();
        if (!ls || !key) return false;
        var h = Number(height);
        if (!isFinite(h) || h <= 0) return false;
        var w = Number(width);
        var name = rowKey(key);
        var payload = JSON.stringify({
          w: isFinite(w) && w > 0 ? Math.round(w) : 0,
          h: Math.round(h),
          at: Date.now()
        });
        var existed = false;
        try {
          existed = ls.getItem(name) !== null;
        } catch (error) {
          existed = false;
        }
        try {
          ls.setItem(name, payload);
        } catch (error) {
          // Quota (or disabled storage) is the one moment a scan is worth it:
          // free the oldest rows once, retry once, then degrade quietly.
          try {
            prune(Math.floor(max * 0.75));
          } catch (pruneError) {
            /* storage is unusable end to end */
          }
          try {
            ls.setItem(name, payload);
          } catch (second) {
            if (stats) stats.error('size memo: ' + second.message);
            return false;
          }
          // A prune plus a retry happened, so the count is no longer a simple
          // increment: recount instead of guessing.
          resyncCount();
          return true;
        }
        accountWrite(existed);
        if (known > max) prune(Math.floor(max * 0.75));
        return true;
      },
      forget: function (key) {
        var ls = storage();
        if (!ls || !key) return;
        var name = rowKey(key);
        var existed = false;
        try {
          existed = ls.getItem(name) !== null;
          ls.removeItem(name);
        } catch (error) {
          return; // nothing to undo
        }
        if (existed && known > 0) known -= 1;
      },
      /** Cold-start estimate: a diagram's height tracks its line count, weakly. */
      guess: function (source) {
        var text = String(source || '');
        if (!text) return 0;
        var lines = text.split('\n').length;
        return clamp(lines * MMS.CONFIG.SKELETON_PER_LINE_PX, MMS.CONFIG.SKELETON_MIN_PX, MMS.CONFIG.SKELETON_MAX_PX);
      },
      /** Uninstall contract: this plugin leaves no mms:* key behind. */
      clear: function () {
        var ls = storage();
        if (!ls) return 0;
        var names = keys();
        var removed = 0;
        for (var i = 0; i < names.length; i += 1) {
          try {
            ls.removeItem(names[i]);
            removed += 1;
          } catch (error) {
            break;
          }
        }
        known = Math.max(0, names.length - removed);
        drift = 0;
        return removed;
      },
      size: function () {
        return rowCount();
      }
    };
  }

  MMS.createSizes = createSizes;
})(typeof globalThis !== 'undefined' ? globalThis : this);
