/* ── theme.js — light/dark always follows the host ──────────────────────────
 *
 * No manual override: the diagram takes whatever mode the GUI is in. The host
 * publishes that state as `body[data-ds-dark-theme]`, which is also what the
 * previously shipped mermaid plugin reads — no dependency on a theme service
 * contract.
 *
 * When the host flips the attribute we re-render every card; both variants end
 * up in the cache under their own key, so flipping back is a cache hit.
 */
(function (g) {
  'use strict';
  var MMS = g.__MMS__ || (g.__MMS__ = {});

  var DARK_ATTR = 'data-ds-dark-theme';

  function bodyIsDark() {
    var body = g.document && g.document.body;
    return !!(body && body.hasAttribute(DARK_ATTR));
  }

  /** What mermaid is initialized with: `default` or `dark`. */
  function resolve() {
    return bodyIsDark() ? 'dark' : 'default';
  }

  /** Fires when the host flips its dark attribute. */
  function subscribe(callback) {
    var body = g.document && g.document.body;
    if (!body || typeof g.MutationObserver !== 'function') return function () {};
    var observer = new g.MutationObserver(function (records) {
      for (var i = 0; i < records.length; i += 1) {
        if (records[i].attributeName === DARK_ATTR) {
          callback();
          return;
        }
      }
    });
    observer.observe(body, { attributes: true, attributeFilter: [DARK_ATTR] });
    return function dispose() {
      observer.disconnect();
    };
  }

  /**
   * Font identity for the cache key. Reads the code font the host actually
   * rendered with, which is a real observation — the flat `fontFamily` field the
   * original design assumed does not exist in the theme snapshot.
   */
  function sampleFontCode(node) {
    try {
      var target = node || (g.document && g.document.querySelector('.md-code-block code')) || g.document.body;
      if (!target || !g.getComputedStyle) return 'na';
      var style = g.getComputedStyle(target);
      var text = (style.fontFamily || '').replace(/\s+/g, ' ').trim() || 'na';
      return text + '/' + (style.fontSize || 'na');
    } catch (error) {
      return 'na';
    }
  }

  /** Revision token for the cache key: the observed mode plus the sampled font. */
  function revision(node) {
    return resolve() + '@' + sampleFontCode(node);
  }

  MMS.theme = {
    DARK_ATTR: DARK_ATTR,
    bodyIsDark: bodyIsDark,
    resolve: resolve,
    subscribe: subscribe,
    sampleFontCode: sampleFontCode,
    revision: revision
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
