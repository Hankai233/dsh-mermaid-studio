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
        for (var i = 0; i < ls.length; i += 1) {
          var name = ls.key(i);
          if (name && name.indexOf(prefix) === 0) out.push(name);
        }
      } catch (error) {
        return [];
      }
      return out;
    }

    /** Drop the oldest rows until `keep` remain. Runs only when the cap is hit. */
    function prune(keep) {
      var ls = storage();
      if (!ls) return 0;
      var rows = keys().map(function (name) {
        var value = parse(ls.getItem(name));
        return { name: name, at: value ? value.at : 0 };
      });
      rows.sort(function (a, b) {
        return a.at - b.at;
      });
      var doomed = rows.slice(0, Math.max(0, rows.length - keep));
      for (var i = 0; i < doomed.length; i += 1) {
        try {
          ls.removeItem(doomed[i].name);
        } catch (error) {
          return i;
        }
      }
      return doomed.length;
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
        try {
          ls.setItem(
            rowKey(key),
            JSON.stringify({ w: isFinite(w) && w > 0 ? Math.round(w) : 0, h: Math.round(h), at: Date.now() })
          );
        } catch (error) {
          // Quota or disabled storage: the memo is an optimisation, never a need.
          if (stats) stats.error('size memo: ' + error.message);
          return false;
        }
        if (keys().length > max) prune(Math.floor(max * 0.75));
        return true;
      },
      forget: function (key) {
        var ls = storage();
        if (!ls || !key) return;
        try {
          ls.removeItem(rowKey(key));
        } catch (error) {
          /* nothing to undo */
        }
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
        for (var i = 0; i < names.length; i += 1) {
          try {
            ls.removeItem(names[i]);
          } catch (error) {
            return i;
          }
        }
        return names.length;
      },
      size: function () {
        return keys().length;
      }
    };
  }

  MMS.createSizes = createSizes;
})(typeof globalThis !== 'undefined' ? globalThis : this);
