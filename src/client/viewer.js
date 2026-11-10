/* ── viewer.js — fullscreen overlay ────────────────────────────────────────
 *
 * A CSS overlay, not the Fullscreen API: Electron and browsers disagree about
 * Esc/F11 there, and a plugin must not take over those keys process-wide.
 *
 * The overlay gets its own viewport controller (card state stays untouched), a
 * minimal focus trap (Tab cycles inside, focusin is pulled back) because it
 * announces `aria-modal="true"` to screen readers, and it restores
 * `body.style.overflow` to whatever it was before — other plugins write that
 * property too.
 */
(function (g) {
  'use strict';
  var MMS = g.__MMS__ || (g.__MMS__ = {});

  function createViewer(options) {
    var exporter = options.exporter;
    var onExport = options.onExport;
    var overlay = null;
    var controller = null;
    var previousOverflow = null;
    var previousFocus = null;

    function close() {
      if (!overlay) return;
      if (controller) controller.dispose();
      controller = null;
      overlay.removeEventListener('pointermove', wakeRow);
      if (rowTimer) {
        clearTimeout(rowTimer);
        rowTimer = null;
      }
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      overlay = null;
      if (g.document.body) g.document.body.style.overflow = previousOverflow === null ? '' : previousOverflow;
      g.document.removeEventListener('keydown', onKeyDown, true);
      g.document.removeEventListener('focusin', onFocusIn, true);
      var target = previousFocus;
      previousFocus = null;
      if (target && target.isConnected && typeof target.focus === 'function') target.focus();
    }

    function onKeyDown(event) {
      if (event.key === 'Escape' && overlay && event.target === overlay.querySelector('.mms-float-scale')) {
        var input = event.target;
        input.value = Math.round((controller ? controller.state().s : 1) * 100) + '%';
        input.blur();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'Tab' || !overlay) return;
      var focusables = overlay.querySelectorAll('button,[tabindex="0"]');
      if (!focusables.length) return;
      var first = focusables[0];
      var last = focusables[focusables.length - 1];
      if (event.shiftKey && g.document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && g.document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    function onFocusIn(event) {
      if (!overlay) return;
      if (!overlay.contains(event.target)) {
        var shell = overlay.querySelector('.mms-shell');
        if (shell) shell.focus();
      }
    }

    // Same construction as the card's controls, so both surfaces read alike.
    function control(kind, title, action) {
      var button = g.document.createElement('button');
      button.type = 'button';
      button.className = 'mms-btn mms-btn-icon';
      button.title = title;
      button.setAttribute('aria-label', title);
      if (MMS.icons) button.appendChild(MMS.icons.build(MMS.icons.paths[kind]));
      button.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        action(event);
      });
      return button;
    }

    // In fullscreen the whole screen is the diagram, so "hover over the diagram"
    // would mean "always visible". Instead the row wakes on pointer movement and
    // fades after a moment of stillness, which keeps the canvas clear but brings
    // the controls back the instant the user reaches for them.
    var rowTimer = null;
    function wakeRow() {
      if (!overlay) return;
      overlay.setAttribute('data-row', 'on');
      if (rowTimer) clearTimeout(rowTimer);
      rowTimer = setTimeout(function () {
        rowTimer = null;
        if (!overlay) return;
        var row = overlay.querySelector('.mms-float');
        if (row && row.contains(g.document.activeElement)) return;
        overlay.removeAttribute('data-row');
      }, 1600);
    }

    function open(card) {
      if (overlay) close();
      if (!card || !card.getSvg()) {
        if (onExport) onExport('图表尚未渲染完成');
        return;
      }
      var doc = g.document;
      previousFocus = doc.activeElement;
      previousOverflow = doc.body.style.overflow;
      doc.body.style.overflow = 'hidden';

      overlay = doc.createElement('div');
      overlay.setAttribute('data-mms-overlay', '');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-label', '全屏查看 Mermaid 图');

      var shell = doc.createElement('div');
      shell.className = 'mms-shell';
      shell.tabIndex = -1;

      var bar = doc.createElement('div');
      bar.className = 'mms-float';
      bar.setAttribute('role', 'toolbar');
      bar.setAttribute('aria-label', '全屏图表工具');
      var currentScale = 1;
      var scaleInput = doc.createElement('input');
      scaleInput.type = 'text';
      scaleInput.className = 'mms-float-scale';
      scaleInput.setAttribute('inputmode', 'decimal');
      scaleInput.setAttribute('aria-label', '缩放百分比，可直接输入');
      scaleInput.title = '输入百分比后回车应用';
      scaleInput.value = '100%';

      var viewport = doc.createElement('div');
      viewport.className = 'mms-vp';
      viewport.tabIndex = 0;
      viewport.setAttribute('role', 'application');
      viewport.setAttribute('aria-label', '图表画布：Ctrl 滚轮缩放，拖拽平移，双击适应');
      var stage = doc.createElement('div');
      stage.className = 'mms-stage';
      var svg = card.getSvg().cloneNode(true);
      stage.appendChild(svg);
      viewport.appendChild(stage);

      function showScale(scale) {
        currentScale = scale;
        if (g.document.activeElement !== scaleInput) scaleInput.value = Math.round(scale * 100) + '%';
      }

      function restoreScale() {
        scaleInput.value = Math.round(currentScale * 100) + '%';
      }

      /** Typed value wins; anything unparsable just snaps back to the real scale. */
      function commitScale() {
        var digits = String(scaleInput.value).replace(/[^0-9.]/g, '');
        var percent = parseFloat(digits);
        if (!isFinite(percent) || percent <= 0 || !controller) {
          restoreScale();
          return;
        }
        var applied = controller.zoomTo(percent / 100);
        showScale(applied);
        scaleInput.value = Math.round(applied * 100) + '%';
      }

      scaleInput.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          commitScale();
        }
      });
      scaleInput.addEventListener('blur', function () {
        commitScale();
      });

      bar.appendChild(control('zoomIn', '放大', function () { controller && controller.zoomBy(1.25); }));
      bar.appendChild(scaleInput);
      bar.appendChild(control('zoomOut', '缩小', function () { controller && controller.zoomBy(1 / 1.25); }));
      bar.appendChild(control('reset', '重置缩放（回到 100%）', function () {
        if (!controller) return;
        controller.reset100();
        showScale(controller.state().s);
        scaleInput.value = '100%';
      }));
      bar.appendChild(
        control('download', '导出为 SVG 文件', function () {
          if (!card.getSvg()) return;
          exporter.exportVector(card.getSvg(), card.getHash()).catch(function (error) {
            if (onExport) onExport('导出失败：' + error.message);
          });
        })
      );
      bar.appendChild(control('close', '退出全屏（Esc）', function () { close(); }));

      shell.appendChild(bar);
      shell.appendChild(viewport);
      overlay.appendChild(shell);
      doc.body.appendChild(overlay);

      controller = MMS.createViewport({
        viewport: viewport,
        stage: stage,
        alwaysZoom: true,
        onScale: showScale
      });
      controller.fitPage();

      overlay.addEventListener('pointermove', wakeRow);
      wakeRow();
      doc.addEventListener('keydown', onKeyDown, true);
      doc.addEventListener('focusin', onFocusIn, true);
      shell.focus();
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(function () {
          controller && controller.fitPage();
        });
      }
    }

    return {
      open: open,
      close: close,
      isOpen: function () {
        return !!overlay;
      }
    };
  }

  MMS.createViewer = createViewer;
})(typeof globalThis !== 'undefined' ? globalThis : this);
