/* ── export.js — SVG export out of an already-sanitized diagram ─────────────
 *
 * SVG only, by decision: the PNG/JPG path needed a second htmlLabels:false
 * render plus a canvas encode of up to 27.8 Mpx, and that second render + encode
 * was what froze the app during export. This path has neither — it serializes
 * the same DOM node the user is looking at, which already passed the whitelist.
 *
 * A standalone .svg opens as a top-level document with no host CSP, so the only
 * safe source is that filtered tree; never a raw string from the cache.
 */
(function (g) {
  'use strict';
  var MMS = g.__MMS__ || (g.__MMS__ = {});

  var FALLBACK_FONT = '"Maple Mono NF CN", ui-monospace, SFMono-Regular, Menlo, monospace';

  function svgSize(svg) {
    var viewBox = svg.getAttribute('viewBox');
    if (viewBox) {
      var parts = viewBox.split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) return { width: parts[2], height: parts[3] };
    }
    var box = null;
    try {
      box = svg.getBBox();
    } catch (error) {
      box = null;
    }
    if (box && box.width && box.height) return { width: box.width, height: box.height };
    var rect = svg.getBoundingClientRect();
    return { width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
  }

  function sizeFromAttributes(el) {
    var w = parseFloat(el.getAttribute('width'));
    var h = parseFloat(el.getAttribute('height'));
    if (isFinite(w) && isFinite(h) && w > 0 && h > 0) return { width: w, height: h };
    return null;
  }

  /**
   * Make an SVG element standalone: namespaces, definite width/height, viewBox,
   * fallback font stack. Works on a detached element (the exporter's sanitized
   * root) as well as on an injected one, so both export paths agree.
   */
  function normalizeRoot(clone, options) {
    var opts = options || {};
    var scale = opts.scale || 1;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');

    var viewBox = clone.getAttribute('viewBox');
    var size = null;
    if (viewBox) {
      var parts = viewBox.split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) size = { width: parts[2], height: parts[3] };
    }
    if (!size) size = sizeFromAttributes(clone);
    if (!size) size = svgSize(clone);
    if (!viewBox) clone.setAttribute('viewBox', '0 0 ' + size.width + ' ' + size.height);
    clone.setAttribute('width', String(Math.round(size.width * scale)));
    clone.setAttribute('height', String(Math.round(size.height * scale)));

    // Fallback stack inside the diagram's own <style>: a machine without the
    // chat's code font still lays the labels out.
    var rule = '#' + (clone.getAttribute('id') || 'x') + ' text{font-family:' + FALLBACK_FONT + '}';
    var style = clone.getElementsByTagName('style')[0];
    if (style) {
      style.textContent = style.textContent + '\n' + rule;
    } else {
      var created = g.document.createElementNS('http://www.w3.org/2000/svg', 'style');
      created.textContent = rule;
      clone.insertBefore(created, clone.firstChild);
    }
    return clone;
  }

  function serializeSvg(svg, options) {
    var clone = normalizeRoot(svg.cloneNode(true), options);
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + new g.XMLSerializer().serializeToString(clone);
  }

  function filename(ext, hash) {
    var slug = String(hash || 'diagram').replace(/[^A-Za-z0-9]/g, '').slice(0, 6) || 'diagram';
    return 'mermaid-diagram-' + slug + '.' + ext;
  }

  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var anchor = g.document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    g.document.body.appendChild(anchor);
    anchor.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      if (anchor.parentNode) anchor.parentNode.removeChild(anchor);
    }, 4000);
  }

  function createExporter(options) {
    var stats = options && options.stats;

    function noteExport() {
      if (stats) stats.note('exportCount');
    }

    /** @returns {Promise<{name: string}>} */
    function exportVector(svg, hash) {
      var text = serializeSvg(svg);
      download(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }), filename('svg', hash));
      noteExport();
      return Promise.resolve({ name: filename('svg', hash), kind: 'svg' });
    }

    return {
      exportVector: exportVector,
      serializeSvg: serializeSvg,
      filename: filename
    };
  }

  MMS.createExporter = createExporter;
  MMS.exportInternals = { serializeSvg: serializeSvg, filename: filename };
})(typeof globalThis !== 'undefined' ? globalThis : this);
