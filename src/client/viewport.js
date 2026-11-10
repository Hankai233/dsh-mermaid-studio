/* ── viewport.js — zoom / pan / fit for one diagram ─────────────────────────
 *
 * One transform, `translate(x,y) scale(s)`, on a stage inside a clipped viewport.
 *
 * Two rules that took a design pass to get right and are easy to regress:
 *   · The 0.1–8 clamp applies to USER input only. "Fit width" on a 4000×200
 *     diagram legitimately needs s < 0.1; clamping fit to the input range would
 *     leave the diagram unreadably cropped with no way out.
 *   · A viewport that measures 0 (collapsed sidebar, hidden tab) must not run
 *     fit at all — it would compute s = 0/NaN and blank the card with no error
 *     state. Wait for the ResizeObserver.
 *
 * Wheel: plain wheel scrolls the page (a chat is a document; stealing scroll is
 * hostile). Ctrl/⌘+wheel zooms around the pointer, and inside the fullscreen
 * overlay plain wheel zooms because there is no page to scroll.
 */
(function (g) {
  'use strict';
  var MMS = g.__MMS__ || (g.__MMS__ = {});

  var WHEEL_FACTOR = 0.0015;

  function createViewport(options) {
    var viewport = options.viewport;
    var stage = options.stage;
    var onScale = options.onScale || function () {};
    var alwaysZoom = !!options.alwaysZoom;
    var state = { x: 0, y: 0, s: 1, mode: 'page', fitted: false };
    var drag = null;
    var resizeObserver = null;
    var disposed = false;

    function contentSize() {
      var svg = stage.firstElementChild;
      if (!svg) return { w: 0, h: 0 };
      // Prefer the authored viewBox: getBBox depends on layout having happened,
      // which is exactly what fit runs before.
      var viewBox = svg.getAttribute('viewBox');
      if (viewBox) {
        var parts = viewBox.split(/[\s,]+/).map(Number);
        if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) return { w: parts[2], h: parts[3] };
      }
      var box = null;
      try {
        box = svg.getBBox();
      } catch (error) {
        box = null;
      }
      var w = box && box.width ? box.width : svg.clientWidth || svg.getBoundingClientRect().width;
      var h = box && box.height ? box.height : svg.clientHeight || svg.getBoundingClientRect().height;
      if (!w || !h) {
        var rect = svg.getBoundingClientRect();
        w = w || rect.width;
        h = h || rect.height;
      }
      return { w: Math.max(1, w || 1), h: Math.max(1, h || 1) };
    }

    function viewSize() {
      return { w: viewport.clientWidth, h: viewport.clientHeight };
    }

    var pendingFrame = 0;
    var pendingNotify = false;

    function write() {
      stage.style.transform =
        'translate3d(' + state.x.toFixed(2) + 'px,' + state.y.toFixed(2) + 'px,0) scale(' + state.s.toFixed(4) + ')';
      if (pendingNotify) {
        pendingNotify = false;
        onScale(state.s, state.mode);
      }
    }

    /** Apply now (fit / zoom / programmatic) and report the scale. */
    function apply() {
      pendingNotify = true;
      write();
    }

    /**
     * Coalesce high-frequency drag moves into one write per frame: a pointermove
     * burst otherwise forces a style recalc + layer update per event.
     */
    function promoteLayer() {
      // From the first user-driven transform on, the stage is worth a layer.
      if (viewport.getAttribute('data-zoomed') !== '1') viewport.setAttribute('data-zoomed', '1');
    }

    function schedule() {
      if (pendingFrame) return;
      var raf = g.requestAnimationFrame || function (fn) {
        return setTimeout(fn, 16);
      };
      pendingFrame = raf(function () {
        pendingFrame = 0;
        write();
      });
    }

    function flush() {
      if (pendingFrame) {
        var cancel = g.cancelAnimationFrame || clearTimeout;
        cancel(pendingFrame);
        pendingFrame = 0;
      }
      write();
    }

    function fit(mode) {
      var view = viewSize();
      var content = contentSize();
      if (!view.w || !view.h) {
        state.mode = mode;
        state.fitted = false;
        return false; // 0-sized container: retry on the next ResizeObserver callback
      }
      var s;
      // "Fit" shrinks an oversized diagram and never blows a small one up: a
      // 90px-wide flowchart at full-card width would be 14x type. Users who want
      // it bigger zoom in.
      if (mode === 'width') s = Math.min(1, view.w / content.w);
      else s = Math.min(1, view.w / content.w, view.h / content.h);
      if (!isFinite(s) || s <= 0) return false;
      state.s = s;
      state.x = (view.w - content.w * s) / 2;
      state.y = mode === 'width' ? Math.min(0, (view.h - content.h * s) / 2) : (view.h - content.h * s) / 2;
      state.mode = mode;
      state.fitted = true;
      apply();
      return true;
    }

    function fitWidth() {
      return fit('width');
    }

    function fitPage() {
      return fit('page');
    }

    /**
     * Highest scale this diagram may use.
     *
     * The stage is a composited layer whose pixel size is `content × scale`.
     * Chrome's texture budget stops at ~16k px per side, so a 3693 px wide
     * diagram at the 8× limit asks for a ~29k px layer — past that point tiles
     * get split and every pan frame re-rasterises, which is what "drag is laggy
     * when zoomed in" actually was. Clamp per diagram instead of globally.
     */
    function maxScaleFor(content) {
      var longest = Math.max(content.w || 1, content.h || 1);
      var textureCap = MMS.CONFIG.LAYER_MAX_PX / longest;
      if (!isFinite(textureCap) || textureCap <= 0) return MMS.CONFIG.ZOOM_MAX;
      return Math.max(MMS.CONFIG.ZOOM_MIN, Math.min(MMS.CONFIG.ZOOM_MAX, textureCap));
    }

    function clampScale(value) {
      var ceiling = maxScaleFor(contentSize());
      return Math.min(ceiling, Math.max(MMS.CONFIG.ZOOM_MIN, value));
    }

    function clampPan() {
      var view = viewSize();
      var content = contentSize();
      var w = content.w * state.s;
      var h = content.h * state.s;
      var keep = MMS.CONFIG.PAN_KEEP_PX;
      // Only clamp an axis where the content is larger than the viewport. When
      // it is smaller, re-centering here would silently undo pointer-anchored
      // zoom and any small drag; centering belongs to fit() and nothing else.
      if (w > view.w) state.x = Math.min(view.w - keep, Math.max(keep - w, state.x));
      if (h > view.h) state.y = Math.min(view.h - keep, Math.max(keep - h, state.y));
    }

    /** Zoom around a point in viewport coordinates. */
    function zoomAt(px, py, factor) {
      var next = clampScale(state.s * factor);
      if (next === state.s) return;
      promoteLayer();
      var ratio = next / state.s;
      state.x = px - (px - state.x) * ratio;
      state.y = py - (py - state.y) * ratio;
      state.s = next;
      state.mode = 'custom';
      clampPan();
      apply();
    }

    function zoomCentered(factor) {
      var view = viewSize();
      zoomAt(view.w / 2, view.h / 2, factor);
    }

    function reset100() {
      var view = viewSize();
      var content = contentSize();
      state.s = 1;
      state.x = (view.w - content.w) / 2;
      state.y = (view.h - content.h) / 2;
      state.mode = 'custom';
      clampPan();
      apply();
    }

    function toggled100() {
      if (Math.abs(state.s - 1) < 0.01 && state.mode === 'custom') fitPage();
      else reset100();
    }

    function onWheel(event) {
      if (disposed) return;
      var zoomIntent = alwaysZoom || event.ctrlKey || event.metaKey;
      if (!zoomIntent && document.activeElement !== viewport && !viewport.contains(document.activeElement)) {
        return; // plain wheel: let the page scroll
      }
      if (zoomIntent || alwaysZoom) {
        event.preventDefault();
        var rect = viewport.getBoundingClientRect();
        var factor = Math.exp(-event.deltaY * WHEEL_FACTOR);
        zoomAt(event.clientX - rect.left, event.clientY - rect.top, factor);
      }
    }

    function onPointerDown(event) {
      if (event.button !== 0) return;
      // Without this, dragging over text starts a selection and the browser
      // keeps re-resolving it every frame — visible as jank on big diagrams.
      if (event.cancelable) event.preventDefault();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
      try {
        viewport.setPointerCapture(event.pointerId);
      } catch (error) {
        /* capture is a nicety; dragging still works without it */
      }
    }

    function onPointerMove(event) {
      if (!drag || drag.id !== event.pointerId) return;
      var dx = event.clientX - drag.x;
      var dy = event.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      if (!drag.moved) {
        drag.moved = true;
        viewport.setAttribute('data-dragging', '1');
        promoteLayer();
        state.mode = 'custom';
      }
      drag.x = event.clientX;
      drag.y = event.clientY;
      state.x += dx;
      state.y += dy;
      clampPan();
      schedule();
    }

    function endDrag(event) {
      if (!drag || (event && drag.id !== event.pointerId)) return;
      flush();
      try {
        viewport.releasePointerCapture(drag.id);
      } catch (error) {
        /* may already be released */
      }
      drag = null;
      viewport.removeAttribute('data-dragging');
    }

    function onKeyDown(event) {
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        zoomCentered(1.2);
      } else if (event.key === '-') {
        event.preventDefault();
        zoomCentered(1 / 1.2);
      } else if (event.key === '0') {
        event.preventDefault();
        fitPage();
      }
    }

    viewport.addEventListener('wheel', onWheel, { passive: false });
    viewport.addEventListener('pointerdown', onPointerDown);
    viewport.addEventListener('pointermove', onPointerMove);
    viewport.addEventListener('pointerup', endDrag);
    viewport.addEventListener('pointercancel', endDrag);
    viewport.addEventListener('dblclick', toggled100);
    viewport.addEventListener('keydown', onKeyDown);

    if (typeof g.ResizeObserver === 'function') {
      resizeObserver = new g.ResizeObserver(function () {
        if (disposed) return;
        if (!state.fitted && state.mode !== 'custom') fit(state.mode);
        else if (state.mode === 'width' || state.mode === 'page') fit(state.mode);
      });
      resizeObserver.observe(viewport);
      resizeObserver.observe(stage);
    }

    return {
      fitWidth: fitWidth,
      fitPage: fitPage,
      reset100: reset100,
      zoomBy: zoomCentered,
      zoomAt: zoomAt,
      refit: function () {
        fit(state.mode === 'custom' ? 'page' : state.mode);
      },
      state: function () {
        return { x: state.x, y: state.y, s: state.s, mode: state.mode };
      },
      apply: apply,
      dispose: function () {
        disposed = true;
        if (pendingFrame) {
          var cancel = g.cancelAnimationFrame || clearTimeout;
          cancel(pendingFrame);
          pendingFrame = 0;
        }
        if (resizeObserver) resizeObserver.disconnect();
        viewport.removeEventListener('wheel', onWheel);
        viewport.removeEventListener('pointerdown', onPointerDown);
        viewport.removeEventListener('pointermove', onPointerMove);
        viewport.removeEventListener('pointerup', endDrag);
        viewport.removeEventListener('pointercancel', endDrag);
        viewport.removeEventListener('dblclick', toggled100);
        viewport.removeEventListener('keydown', onKeyDown);
      }
    };
  }

  MMS.createViewport = createViewport;
})(typeof globalThis !== 'undefined' ? globalThis : this);
