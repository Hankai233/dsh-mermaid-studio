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

    function button(label, action, title, extra) {
      var el = g.document.createElement('button');
      el.type = 'button';
      el.className = 'mms-btn' + (extra ? ' ' + extra : '');
      el.textContent = label;
      el.title = title || label;
      el.setAttribute('aria-label', title || label);
      el.addEventListener('click', action);
      return el;
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
      bar.className = 'mms-bar';
      bar.setAttribute('role', 'toolbar');
      bar.setAttribute('aria-label', '图表工具');
      var badge = doc.createElement('span');
      badge.className = 'mms-badge';
      badge.textContent = 'mermaid';
      bar.appendChild(badge);

      var actions = doc.createElement('div');
      actions.className = 'mms-actions';
      var scaleLabel = doc.createElement('span');
      scaleLabel.className = 'mms-scale';
      scaleLabel.textContent = '100%';

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

      actions.appendChild(button('−', function () { controller && controller.zoomBy(1 / 1.2); }, '缩小'));
      actions.appendChild(scaleLabel);
      actions.appendChild(button('+', function () { controller && controller.zoomBy(1.2); }, '放大'));
      actions.appendChild(button('适应宽度', function () { controller && controller.fitWidth(); }, '适应宽度'));
      actions.appendChild(button('适应全图', function () { controller && controller.fitPage(); }, '适应全图'));
      actions.appendChild(
        button('导出 SVG', function () {
          if (!card.getSvg()) return;
          exporter.exportVector(card.getSvg(), card.getHash()).catch(function (error) {
            if (onExport) onExport('导出失败：' + error.message);
          });
        }, '导出为 SVG')
      );
      var closeBtn = button('关闭', function () { close(); }, '关闭全屏（Esc）', 'mms-btn-icon');
      actions.appendChild(closeBtn);
      bar.appendChild(actions);

      shell.appendChild(bar);
      shell.appendChild(viewport);
      overlay.appendChild(shell);
      doc.body.appendChild(overlay);

      controller = MMS.createViewport({
        viewport: viewport,
        stage: stage,
        alwaysZoom: true,
        onScale: function (scale) {
          scaleLabel.textContent = Math.round(scale * 100) + '%';
        }
      });
      controller.fitPage();

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
