/* ── sanitize.js — the only way an SVG string reaches the DOM ───────────────
 *
 * The SVG we inject comes from IndexedDB, i.e. from a same-origin store any
 * script (or an older, buggier build of this plugin) may have written, and it
 * stays there for 30 days. `securityLevel: 'strict'` guards the render, not the
 * string read back later. So:
 *
 *   parse in a DETACHED document → filter there → importNode → insert
 *
 * The filter is closed by default: element whitelist, attribute whitelist,
 * per-value checks for everything that can fetch (href, url(), style), and a
 * CSSOM rebuild of <style> that prefixes every selector with the diagram's id
 * so an inline stylesheet cannot restyle the page. Rules that fail to rewrite
 * are dropped and counted.
 *
 * Whole-fence rejection (not best-effort) for script carriers: once a fence
 * contains one, the card goes to the error state and the record is never
 * cached.
 */
(function (g) {
  'use strict';
  var MMS = g.__MMS__ || (g.__MMS__ = {});

  var SVG_NS = 'http://www.w3.org/2000/svg';

  var ALLOWED_ELEMENTS = {
    svg: 1, g: 1, path: 1, rect: 1, circle: 1, ellipse: 1, line: 1, polyline: 1,
    polygon: 1, text: 1, tspan: 1, textPath: 1, title: 1, desc: 1, marker: 1,
    defs: 1, style: 1, linearGradient: 1, radialGradient: 1, stop: 1,
    pattern: 1, clipPath: 1, mask: 1, use: 1, image: 1, filter: 1, switch: 1,
    symbol: 1, foreignObject: 1
  };

  /* HTML that mermaid's htmlLabels legitimately produces inside foreignObject.
     Deliberately text-level only: no img, no a, no form controls. */
  var ALLOWED_FOREIGN = {
    div: 1, span: 1, p: 1, br: 1, b: 1, i: 1, em: 1, strong: 1, code: 1,
    pre: 1, u: 1, s: 1, small: 1, sub: 1, sup: 1, hr: 1
  };

  var FILTER_ELEMENTS = {
    feGaussianBlur: 1, feOffset: 1, feMerge: 1, feMergeNode: 1, feBlend: 1,
    feColorMatrix: 1, feFlood: 1, feComposite: 1, feDropShadow: 1,
    feTurbulence: 1, feDisplacementMap: 1, feMorphology: 1,
    feComponentTransfer: 1, feFuncA: 1, feFuncR: 1, feFuncG: 1, feFuncB: 1
  };

  /* Anything here means "this SVG tries to run or embed": reject the fence. */
  var BLOCKED_ELEMENTS = {
    script: 1, iframe: 1, object: 1, embed: 1, audio: 1, video: 1, set: 1,
    handler: 1, animate: 1, animateMotion: 1, animateTransform: 1,
    discard: 1, canvas: 1, frame: 1, frameset: 1, applet: 1, base: 1,
    link: 1, meta: 1, form: 1, input: 1, button: 1, textarea: 1, select: 1
  };

  var ALLOWED_ATTRS = {
    d: 1, x: 1, y: 1, x1: 1, y1: 1, x2: 1, y2: 1, cx: 1, cy: 1, r: 1, rx: 1,
    ry: 1, width: 1, height: 1, viewBox: 1, points: 1, transform: 1,
    fill: 1, stroke: 1, 'stroke-width': 1, 'stroke-dasharray': 1,
    'stroke-dashoffset': 1, 'stroke-linecap': 1, 'stroke-linejoin': 1,
    'stroke-miterlimit': 1, 'stroke-opacity': 1, 'fill-opacity': 1,
    'fill-rule': 1, 'clip-rule': 1, opacity: 1, color: 1, 'stop-color': 1,
    'stop-opacity': 1, offset: 1, 'gradientUnits': 1, 'gradientTransform': 1,
    spreadMethod: 1, patternUnits: 1, patternContentUnits: 1,
    patternTransform: 1, markerWidth: 1, markerHeight: 1, markerUnits: 1,
    refX: 1, refY: 1, orient: 1, 'marker-start': 1, 'marker-mid': 1,
    'marker-end': 1, 'font-family': 1, 'font-size': 1, 'font-weight': 1,
    'font-style': 1, 'text-anchor': 1, 'dominant-baseline': 1,
    'alignment-baseline': 1, 'baseline-shift': 1, 'letter-spacing': 1,
    'word-spacing': 1, 'text-decoration': 1, dx: 1, dy: 1, rotate: 1,
    textLength: 1, lengthAdjust: 1, 'writing-mode': 1, id: 1, class: 1,
    style: 1, href: 1, 'xlink:href': 1, 'clip-path': 1, mask: 1, filter: 1,
    preserveAspectRatio: 1, xmlns: 1, 'xmlns:xlink': 1, version: 1, role: 1,
    'aria-label': 1, 'aria-roledescription': 1, 'aria-describedby': 1,
    'aria-labelledby': 1, 'aria-hidden': 1, focusable: 1, tabindex: 1,
    'xml:space': 1, requiredFeatures: 1, requiredExtensions: 1,
    systemLanguage: 1,
    // filter primitives: mermaid's drop-shadow filter needs these or box
    // shadows silently disappear (measured: feDropShadow lost stdDeviation,
    // flood-opacity and flood-color).
    stdDeviation: 1, 'flood-opacity': 1, 'flood-color': 1, 'flood-color-2': 0,
    in: 1, in2: 1, result: 1, operator: 1, radius: 1,
    'color-interpolation-filters': 1, filterUnits: 1, primitiveUnits: 1
  };

  /* Attributes whose value can start a fetch or a style: checked per value. */
  var PAINT_ATTRS = {
    fill: 1, stroke: 1, 'marker-start': 1, 'marker-mid': 1, 'marker-end': 1,
    filter: 1, mask: 1, 'clip-path': 1
  };

  var RASTER_DATA = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i;
  var COLOR_VALUE = /^(#[0-9a-f]{3,8}|[a-z]+|rgba?\([^)]*\)|hsla?\([^)]*\))$/i;
  var URL_REF = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
  var FRAGMENT = /^#[A-Za-z0-9_:.\-]+$/;
  /**
   * Ids are document-local names: they cannot fetch, load or execute anything,
   * so the only job of this test is to keep the value from breaking out of an
   * attribute or a CSS selector. ASCII punctuation stays banned; letters
   * outside ASCII do not, because mermaid builds a cluster's id from its
   * *title* — a subgraph called `分组甲` produces `id="mms-b-1-1-分组甲"`, and an
   * ASCII-only test rejected that as "unsafe value for id", blocking the whole
   * diagram into an error card. Node and edge labels never hit this (they are
   * text, not ids), which is why it went unnoticed until a real browser ran a
   * subgraph with a Chinese title.
   */
  var ID_VALUE = /^[A-Za-z0-9_:.\-\u00A0-\uFFFF]+$/;
  var MAX_NODES = 20000;
  var MAX_USE_DEPTH = 32;
  var MAX_RULES = 4000;

  /* MAX_NODES counts elements, so a single value is otherwise unbounded: one
     10 MB `d` attribute or one huge <style> body parses, filters and reaches
     the compositor while still counting as one node. Both are cut here instead
     of by the node gate.

     Sizes: the SVG on the render path is generated from a fence capped at
     CONFIG.MAX_SOURCE_CHARS (50000) characters, so nothing legitimate emits a
     single attribute near 100000 — that is 2x the whole source budget, enough
     headroom for generated geometry/label attributes that have no source
     counterpart. A mermaid <style> body is emitted in full and runs to tens of
     KB even for a large theme, so 200000 keeps ~5-10x headroom over what the
     engine actually writes while stopping multi-MB sheets.

     Over-limit is a `blocked` rejection, never a truncation: cutting a path
     `d` or a stylesheet in half leaves invalid syntax that renders as a wrong
     diagram and hides the real problem. */
  var MAX_ATTR_VALUE = 100000;
  var MAX_STYLE_TEXT = 200000;

  function SanitizeError(kind, message) {
    this.name = 'SanitizeError';
    this.kind = kind;
    this.message = message;
    this.stack = new Error(message).stack;
  }
  SanitizeError.prototype = Object.create(Error.prototype);

  function localName(el) {
    return el.localName || el.nodeName;
  }

  function isElementAllowed(el, insideForeign) {
    var name = localName(el);
    if (insideForeign) return ALLOWED_FOREIGN[name] === 1;
    return (
      ALLOWED_ELEMENTS[name] === 1 ||
      FILTER_ELEMENTS[name] === 1 ||
      name.slice(0, 2) === 'fe'
    );
  }

  /** Resource bound shared by one attribute value and one <style> body. */
  function textWithinLimit(text, limit) {
    var length = String(text === null || text === undefined ? '' : text).length;
    return length <= limit;
  }

  function attrValueAllowed(name, value) {
    var v = String(value);
    if (!textWithinLimit(v, MAX_ATTR_VALUE)) return false;
    if (name === 'href' || name === 'xlink:href') {
      return FRAGMENT.test(v) || RASTER_DATA.test(v.trim());
    }
    if (name === 'id') return ID_VALUE.test(v);
    if (PAINT_ATTRS[name] === 1) return paintValueAllowed(v);
    // NB: `style` never arrives here — the attribute loop filters it through
    // filterInlineStyle() and continues.
    return safeCssValue(v);
  }

  /** No url() except a fragment, no raster data: anything else can fetch. */
  function paintValueAllowed(value) {
    var match;
    var found = false;
    URL_REF.lastIndex = 0;
    while ((match = URL_REF.exec(value)) !== null) {
      found = true;
      if (!FRAGMENT.test(match[2].trim())) return false;
    }
    if (found) return true;
    if (/^\s*(none|currentColor|inherit|transparent)\s*$/i.test(value)) return true;
    return COLOR_VALUE.test(value.trim());
  }

  function safeCssValue(value) {
    var v = String(value);
    if (/expression\s*\(|javascript:|@import|@font-face/i.test(v)) return false;
    var match;
    URL_REF.lastIndex = 0;
    while ((match = URL_REF.exec(v)) !== null) {
      var target = match[2].trim();
      if (!FRAGMENT.test(target) && !RASTER_DATA.test(target)) return false;
    }
    return true;
  }

  var STYLE_PROPS = {
    fill: 1, stroke: 1, 'stroke-width': 1, 'stroke-dasharray': 1,
    'stroke-opacity': 1, 'fill-opacity': 1, 'fill-rule': 1, opacity: 1,
    color: 1, 'font-family': 1, 'font-size': 1, 'font-weight': 1,
    'font-style': 1, 'text-anchor': 1, 'dominant-baseline': 1,
    'letter-spacing': 1, 'word-spacing': 1, 'text-decoration': 1,
    'white-space': 1, 'overflow-wrap': 1, 'word-break': 1, 'line-height': 1,
    'stop-color': 1, 'stop-opacity': 1, 'paint-order': 1, 'shape-rendering': 1,
    'vector-effect': 1, cursor: 1, 'pointer-events': 1, display: 1,
    visibility: 1, 'box-sizing': 1, 'background-color': 1, 'border-radius': 1,
    padding: 1, margin: 1, 'text-align': 1, 'vertical-align': 1, 'min-width': 1,
    'max-width': 1, 'min-height': 1, 'max-height': 1, width: 1, height: 1,
    'user-select': 1, 'flex-direction': 1, 'align-items': 1, 'justify-content': 1,
    'text-transform': 1, 'font-variant': 1, font: 1, direction: 1,
    overflow: 1, 'text-overflow': 1, 'overflow-x': 1, 'overflow-y': 1,
    'padding-top': 1, 'padding-right': 1, 'padding-bottom': 1, 'padding-left': 1,
    'margin-top': 1, 'margin-right': 1, 'margin-bottom': 1, 'margin-left': 1,
    'border-color': 1, 'border-style': 1, 'border-width': 1, border: 1,
    'border-radius': 1, transform: 1, 'transform-origin': 1,
    // Layout properties the label boxes rely on. Dropping them made labels sit
    // in the wrong place / clip their own text (the "some characters missing"
    // report); none of them can fetch or execute, and url() values are still
    // rejected by safeCssValue. The two that can also act as a UI-deception
    // primitive are kept here and *narrowed* in styleDeclValueAllowed() —
    // mermaid's htmlLabels need absolute/relative boxes, so the properties stay
    // and only fixed/sticky and huge z-index values are refused.
    position: 1, top: 1, right: 1, bottom: 1, left: 1, 'z-index': 1,
    background: 1, 'background-color': 1, filter: 1,
    'stroke-dashoffset': 1, 'stroke-linecap': 1, 'stroke-linejoin': 1,
    'stroke-miterlimit': 1, 'shape-rendering': 1
  };

  /* Value policy for the layout properties above.
   *
   * `position:fixed` (and `sticky`) is the one thing that turns a diagram into
   * a full-viewport overlay — "click here" chrome over the host UI — and until
   * now that was held back only by the card's containment (`overflow:hidden`
   * plus `contain:paint` on the viewport and `contain:layout style paint` on
   * the stage). One stylesheet edit that drops `contain` and the primitive is
   * real, so the value is refused here instead of relying on containment.
   *
   * Everything else about the properties is preserved: absolute/relative stay
   * (labels are positioned with them), and so do top/right/bottom/left and
   * background/filter. `inset` is not in STYLE_PROPS at all, so the shorthand
   * cannot re-introduce the same box with one declaration.
   *
   * z-index: a local stacking context needs a handful of layers. Negative
   * values are harmless (only ordering inside the diagram's own context) so
   * they stay; the 2^31-1 "cover the page" value does not. The ceiling is 100
   * rather than 10 because mermaid's own theme CSS emits `z-index: 100` for its
   * pointer-events:none label boxes (measured in mermaid@11.17.2 dist: the
   * flowchart, journey and block diagram stylesheets each carry it) — dropping
   * that declaration would be a silent stacking regression, and 100 buys
   * nothing for an attacker once `position:fixed|sticky` is gone. */
  var ALLOWED_POSITION = { 'static': 1, relative: 1, absolute: 1 };
  var MAX_Z_INDEX = 100;

  function positionValueAllowed(value) {
    return ALLOWED_POSITION[String(value).trim().toLowerCase()] === 1;
  }

  function zIndexValueAllowed(value) {
    var v = String(value).trim();
    if (/^auto$/i.test(v)) return true;
    if (!/^-?[0-9]{1,6}$/.test(v)) return false;
    var n = parseInt(v, 10);
    return n >= -MAX_Z_INDEX && n <= MAX_Z_INDEX;
  }

  /** @returns {boolean} whether one declaration may keep its value */
  function styleDeclValueAllowed(prop, value) {
    if (prop === 'position') return positionValueAllowed(value);
    if (prop === 'z-index') return zIndexValueAllowed(value);
    return true;
  }

  /**
   * Keep the appearance declarations a style object may carry, drop the rest.
   *
   * Dropping a whole rule because one property is unknown is how text styling
   * disappears: mermaid's sheet mixes layout/animation properties with the
   * colour and font rules the labels need. So filter declarations, and reserve
   * whole-fence rejection for values that can fetch or execute.
   */
  function filterDeclarations(decl) {
    var parts = [];
    var unsafe = false;
    for (var i = 0; i < decl.length; i += 1) {
      var prop = decl[i];
      var lower = String(prop).toLowerCase();
      var value = decl.getPropertyValue(prop);
      if (!safeCssValue(value)) {
        unsafe = true;
        continue;
      }
      if (!STYLE_PROPS[lower]) continue;
      // One refused value drops that declaration only: the rest of the block
      // (e.g. the `top:0` next to a `position:fixed`) still applies.
      if (!styleDeclValueAllowed(lower, value)) continue;
      var priority = decl.getPropertyPriority(prop);
      parts.push(prop + ':' + value + (priority ? ' !' + priority : ''));
    }
    return { css: parts.join(';'), unsafe: unsafe };
  }

  /** @returns {string|null} filtered style text, or null when it is unsafe */
  function filterInlineStyle(text) {
    if (!textWithinLimit(text, MAX_ATTR_VALUE)) return null;
    var probe = g.document.createElement('span');
    probe.setAttribute('style', String(text));
    var result = filterDeclarations(probe.style);
    if (result.unsafe) return null;
    return result.css;
  }

  function rebuildStyleText(text, renderId) {
    var out = [];
    if (typeof g.CSSStyleSheet !== 'function') return { css: '', dropped: 1 };
    var sheet;
    try {
      sheet = new g.CSSStyleSheet();
      sheet.replaceSync(String(text || ''));
    } catch (error) {
      return { css: '', dropped: 1 };
    }

    var dropped = 0;
    var emitted = 0;

    function rewriteSelector(selector) {
      var segments = [].concat(selector.trim().split(','));
      var kept = [];
      for (var i = 0; i < segments.length; i += 1) {
        var seg = segments[i].trim();
        if (!seg) continue;
        if (seg.indexOf('#' + renderId) >= 0) kept.push(seg);
        else kept.push('#' + renderId + ' ' + seg);
      }
      return kept.join(',');
    }

    function rewriteStyleRule(rule) {
      var selector = rewriteSelector(rule.selectorText || '');
      if (!selector) return null;
      var filtered = filterDeclarations(rule.style);
      if (filtered.unsafe) return { unsafe: true };
      if (!filtered.css) return null;
      return { css: selector + '{' + filtered.css + '}' };
    }

    function walk(rules, depth) {
      if (depth > 3) return;
      for (var i = 0; i < rules.length; i += 1) {
        var rule = rules[i];
        var type = rule.type;
        if (type === 1 /* STYLE */) {
          if (emitted >= MAX_RULES) {
            dropped += 1;
            continue;
          }
          var rewritten = rewriteStyleRule(rule);
          if (!rewritten || rewritten.unsafe) {
            dropped += 1;
          } else {
            out.push(rewritten.css);
            emitted += 1;
          }
          continue;
        }
        if (type === 4 /* MEDIA */ || type === 12 /* SUPPORTS */) {
          var inner = [];
          var saved = out;
          out = inner;
          walk(rule.cssRules || [], depth + 1);
          out = saved;
          if (!inner.length) continue;
          var head =
            type === 4
              ? '@media ' + rule.conditionText + '{'
              : '@supports ' + rule.conditionText + '{';
          out.push(head + inner.join('') + '}');
          emitted += 1;
          continue;
        }
        // @font-face / @import / @keyframes / @page: all dropped.
        dropped += 1;
      }
    }

    walk(sheet.cssRules || [], 0);
    return { css: out.join('\n'), dropped: dropped };
  }

  /**
   * Parse an SVG string into a detached root, strictly when possible.
   *
   * mermaid writes HTML *inside* foreignObject for htmlLabels, and that HTML is
   * not XML: a label with a self-closed <br/> comes out as an unclosed <br>, so
   * image/svg+xml parsing fails with "unexpected closing tag: p != br".
   * Measured on a real diagram (multi-line subgraph labels) — rejecting it would
   * be a false positive of the "over-tight filter" kind.
   *
   * So: strict XML first (exact, no HTML repair heuristics), then an inert HTML
   * parse used only to *reach* the tree. The whitelist runs afterwards either
   * way, and template content neither executes nor fetches.
   */
  function parseSvgDocument(input) {
    var strictError = null;
    try {
      var doc = new g.DOMParser().parseFromString(input, 'image/svg+xml');
      var parserError = doc.getElementsByTagName('parsererror')[0];
      var root = doc.documentElement;
      if (!parserError && root && String(root.localName || '').toLowerCase() === 'svg') {
        return { root: root, lenient: false };
      }
      strictError = parserError ? 'parsererror' : 'root is not <svg>';
    } catch (error) {
      strictError = error.message;
    }

    var template = g.document.createElement('template');
    template.innerHTML = input;
    var svg = template.content.querySelector('svg');
    if (svg) return { root: svg, lenient: true, strictError: strictError };

    throw new SanitizeError('parse', 'svg parse failed (' + strictError + ')');
  }

  function createSanitizer(options) {
    var stats = options && options.stats;

    /**
     * @returns {{root: Element, nodes: number, droppedRules: number}}
     * @throws {SanitizeError} for parse failures, blocked content, complexity
     */
    function sanitize(svgString, renderId) {
      if (typeof svgString !== 'string' || !svgString) {
        throw new SanitizeError('parse', 'empty svg');
      }
      var input = svgString;
      var parsed = parseSvgDocument(input);
      var root = parsed.root;
      if (parsed.lenient && stats) stats.sanitizeLenientParse += 1;

      var nodes = 0;
      var droppedRules = 0;
      var styleTexts = [];
      var blocked = null;

      function walk(el, insideForeign, depth) {
        if (blocked) return;
        if (depth > 64) {
          blocked = 'nesting too deep';
          return;
        }
        nodes += 1;
        if (nodes > MAX_NODES) {
          blocked = 'too many nodes (' + nodes + ')';
          return;
        }
        var name = localName(el);
        if (BLOCKED_ELEMENTS[name] === 1) {
          blocked = 'blocked element <' + name + '>';
          return;
        }
        if (!isElementAllowed(el, insideForeign)) {
          blocked = 'element <' + name + '> is not allowed';
          return;
        }

        // Attributes: whitelist on names, validate the ones that can fetch.
        var attrs = Array.prototype.slice.call(el.attributes || []);
        for (var i = 0; i < attrs.length; i += 1) {
          var attr = attrs[i];
          var attrName = attr.name;
          if (/^on/i.test(attrName)) {
            blocked = 'event handler attribute ' + attrName;
            return;
          }
          if (attrName === 'style') {
            var filteredStyle = filterInlineStyle(attr.value);
            if (filteredStyle === null) {
              blocked = 'unsafe inline style';
              return;
            }
            if (filteredStyle) el.setAttribute('style', filteredStyle);
            else el.removeAttribute('style');
            continue;
          }
          if (!ALLOWED_ATTRS[attrName]) {
            el.removeAttribute(attrName);
            continue;
          }
          if (!attrValueAllowed(attrName, attr.value)) {
            blocked = 'unsafe value for ' + attrName;
            return;
          }
        }

        if (name === 'style' && !insideForeign) {
          if (!textWithinLimit(el.textContent, MAX_STYLE_TEXT)) {
            blocked = 'style text too large (' +
              String(el.textContent || '').length + ' chars)';
            return;
          }
          styleTexts.push(el);
        }

        var child = el.firstElementChild;
        while (child) {
          walk(child, insideForeign || name === 'foreignObject', depth + 1);
          if (blocked) return;
          child = child.nextElementSibling;
        }
      }

      walk(root, false, 0);
      if (blocked) throw new SanitizeError('blocked', blocked);

      // <style> is a document-level stylesheet: rebuild it so no rule escapes
      // the diagram's id.
      for (var s = 0; s < styleTexts.length; s += 1) {
        var styleEl = styleTexts[s];
        var rebuilt = rebuildStyleText(styleEl.textContent, renderId);
        droppedRules += rebuilt.dropped;
        if (rebuilt.css) styleEl.textContent = rebuilt.css;
        else styleEl.parentNode.removeChild(styleEl);
      }

      // <use> chains: bounded depth and count, so a self-referencing graph
      // cannot hang the compositor after injection.
      var uses = root.getElementsByTagName('use');
      for (var u = 0; u < uses.length; u += 1) {
        var depth = 0;
        var node = uses[u];
        var seen = {};
        while (node && depth <= MAX_USE_DEPTH) {
          var href = node.getAttribute('href') || node.getAttribute('xlink:href') || '';
          if (href.charAt(0) !== '#') break;
          if (seen[href]) {
            blocked = 'use cycle';
            break;
          }
          seen[href] = 1;
          var target = root.querySelector(href);
          node = target;
          depth += 1;
        }
        if (blocked) break;
        if (depth > MAX_USE_DEPTH) blocked = 'use chain too deep';
      }
      if (blocked) throw new SanitizeError('complexity', blocked);

      if (stats) {
        stats.sanitizeDroppedRules += droppedRules;
      }
      return { root: root, nodes: nodes, droppedRules: droppedRules };
    }

    /** The single injection exit: sanitize detached, then import + replace. */
    function inject(container, svgString, renderId) {
      var result = sanitize(svgString, renderId);
      var imported = g.document.importNode(result.root, true);
      container.replaceChildren(imported);
      return { svg: imported, nodes: result.nodes, droppedRules: result.droppedRules };
    }

    return { sanitize: sanitize, inject: inject };
  }

  MMS.SanitizeError = SanitizeError;
  MMS.parseSvgDocument = parseSvgDocument;
  MMS.createSanitizer = createSanitizer;
  MMS.SANITIZE_TABLES = {
    ALLOWED_ELEMENTS: ALLOWED_ELEMENTS,
    ALLOWED_FOREIGN: ALLOWED_FOREIGN,
    BLOCKED_ELEMENTS: BLOCKED_ELEMENTS,
    ALLOWED_ATTRS: ALLOWED_ATTRS,
    STYLE_PROPS: STYLE_PROPS
  };

  /* Test-only surface (test/sanitize.test.mjs). The value policy and the
     resource bounds are pure functions of strings and are what a regression
     breaks silently; everything else here needs a real DOM. Not runtime API. */
  MMS.SANITIZE_INTERNALS = {
    filterDeclarations: filterDeclarations,
    attrValueAllowed: attrValueAllowed,
    styleDeclValueAllowed: styleDeclValueAllowed,
    textWithinLimit: textWithinLimit,
    MAX_ATTR_VALUE: MAX_ATTR_VALUE,
    MAX_STYLE_TEXT: MAX_STYLE_TEXT,
    MAX_Z_INDEX: MAX_Z_INDEX
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
