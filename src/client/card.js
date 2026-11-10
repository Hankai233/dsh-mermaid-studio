/* ── card.js — one card per fence: DOM, states, and the floating controls ───
 *
 * Structure (the code block stays exactly where React put it, one sibling
 * after the card; the plugin never writes an attribute, class or style onto a
 * node it does not own):
 *
 *   <div class="mms-card" data-mms-state data-view data-mms-key>
 *     <div class="mms-vp"><div class="mms-stage">…svg…</div>…skeleton/error…</div>
 *     <div class="mms-float" role="toolbar">…</div>   ← bottom-right, on hover
 *     <div class="mms-status" aria-live="polite"></div>
 *   </div>
 *   <div class="md-code-block">…</div>
 *
 * No persistent toolbar: the control row is invisible until the pointer is over
 * the diagram (CSS :hover) or focus is inside it, so the diagram itself gets the
 * whole card. In source view there is no canvas to hover, so CSS turns the row
 * into a normal row above the code block.
 *
 * Diagram/source is a `data-view` attribute on the card plus two CSS sibling
 * rules — no node is moved, so React's commit never removes a child from a
 * parent it does not know about.
 */
(function (g) {
  'use strict';
  var MMS = g.__MMS__ || (g.__MMS__ = {});

  function el(tag, className, text) {
    var node = g.document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }


  var ICON_NS = 'http://www.w3.org/2000/svg';

  /**
   * Line icon on a 16x16 grid. Shared by every button in the floating row so the
   * set reads as one family: same box, same stroke weight, same cap/join, colour
   * inherited from the button (currentColor) so hover and pressed states need no
   * icon-specific rules.
   */
  function icon(paths) {
    var svg = g.document.createElementNS(ICON_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (var i = 0; i < paths.length; i += 1) {
      var path = g.document.createElementNS(ICON_NS, 'path');
      path.setAttribute('d', paths[i]);
      svg.appendChild(path);
    }
    return svg;
  }

  var ICONS = {
    zoomIn: ['M8 3.2v9.6', 'M3.2 8h9.6'],
    zoomOut: ['M3.2 8h9.6'],
    // circular arrow with the arrowhead on the gap: reads as "back to the start"
    reset: ['M5.24 4.71A4.3 4.3 0 1 0 10.76 4.71', 'M11.11 6.68L10.76 4.71 12.76 4.71'],
    source: ['M6 4.2L2.4 8l3.6 3.8', 'M10 4.2L13.6 8l-3.6 3.8'],
    download: ['M8 2.9v6.8', 'M5.1 6.9L8 9.8l2.9-2.9', 'M3.3 11.4v1.7c0 .5.4.9.9.9h7.6c.5 0 .9-.4.9-.9v-1.7'],
    expand: [
      'M6 2.6H3.6c-.55 0-1 .45-1 1V6',
      'M10 2.6h2.4c.55 0 1 .45 1 1V6',
      'M6 13.4H3.6c-.55 0-1-.45-1-1V10',
      'M10 13.4h2.4c.55 0 1-.45 1-1V10'
    ],
    close: ['M4.7 4.7l6.6 6.6', 'M11.3 4.7l-6.6 6.6']
  };

  // The fullscreen overlay builds its controls from the same set, so the two
  // surfaces cannot drift apart visually.
  MMS.icons = { build: icon, paths: ICONS };

  function iconButton(node, title, action) {
    var button = el('button', 'mms-btn mms-btn-icon');
    button.type = 'button';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.appendChild(node);
    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      action(event);
    });
    return button;
  }

  function textButton(label, title, action) {
    var button = el('button', 'mms-btn', label);
    button.type = 'button';
    button.title = title || label;
    button.setAttribute('aria-label', title || label);
    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      action(event);
    });
    return button;
  }

  function createCard(app, fence) {
    var config = app.config;
    var stats = app.stats;
    var key = fence.key;
    var state = {
      view: readView(key),
      phase: 'pending',
      svgString: null,
      renderId: null,
      sanitized: null,
      error: null,
      retryable: true,
      rejectedDirectives: !!fence.rejected
    };

    var root = el('div', 'mms-card');
    root.setAttribute('data-mms-key', key.slice(0, 16));
    root.setAttribute('data-mms-state', 'pending');
    root.setAttribute('data-view', state.view);
    root.setAttribute('role', 'img');
    root.setAttribute('aria-label', 'Mermaid 图');

    var viewport = el('div', 'mms-vp');
    viewport.tabIndex = 0;
    viewport.setAttribute('role', 'application');
    viewport.setAttribute('aria-label', '图表画布：Ctrl 滚轮缩放，拖拽平移，双击适应');
    var stage = el('div', 'mms-stage');
    var skeleton = el('div', 'mms-skeleton');
    skeleton.appendChild(el('span'));
    skeleton.appendChild(el('span'));
    skeleton.appendChild(el('span'));

    var errorBox = el('div', 'mms-error');
    var errorHead = el('div', 'mms-error-head', '渲染失败');
    var errorDetail = el('pre', 'mms-error-detail');
    var errorActions = el('div', 'mms-error-actions');
    var retryButton = textButton('重试', '重新渲染', function () {
      app.retry(card);
    });
    var resetButton = textButton('重置渲染器', '重建 mermaid 实例并继续渲染', function () {
      app.resetRenderer();
      app.retry(card);
    });
    resetButton.hidden = true;
    errorActions.appendChild(retryButton);
    errorActions.appendChild(resetButton);
    errorBox.appendChild(errorHead);
    errorBox.appendChild(errorDetail);
    errorBox.appendChild(errorActions);

    viewport.appendChild(stage);
    viewport.appendChild(skeleton);
    viewport.appendChild(errorBox);

    // Floating controls: no persistent toolbar. The row appears when the pointer
    // is over the diagram (CSS :hover) or when keyboard focus is inside it, and
    // sits bottom-right over the canvas. In source view there is no canvas to
    // hover, so the row becomes a normal row above the code block.
    var floatBar = el('div', 'mms-float');
    floatBar.setAttribute('role', 'toolbar');
    floatBar.setAttribute('aria-label', '图表工具');
    if (state.rejectedDirectives) {
      var note = el('span', 'mms-float-note', '已忽略 init 指令');
      note.title = '源码里的 init 指令包含被禁止的配置键，已从源码中剥离';
      floatBar.appendChild(note);
    }
    var zoomInButton = iconButton(icon(ICONS.zoomIn), '放大', function () {
      controller.zoomBy(1.25);
    });
    var zoomOutButton = iconButton(icon(ICONS.zoomOut), '缩小', function () {
      controller.zoomBy(1 / 1.25);
    });
    var resetZoomButton = iconButton(icon(ICONS.reset), '重置缩放（回到适应宽度）', function () {
      controller.fitWidth();
    });
    var viewButton = iconButton(icon(ICONS.source), '显示源代码', function () {
      setView(state.view === 'diagram' ? 'code' : 'diagram');
    });
    // Export is SVG only: the raster path needed a second htmlLabels:false
    // render plus a 27.8 Mpx canvas encode, which is what made the whole app
    // stutter.
    var exportButton = iconButton(icon(ICONS.download), '导出为 SVG 文件', function () {
      doExportSvg();
    });
    var fullscreenButton = iconButton(icon(ICONS.expand), '全屏查看', function () {
      app.openViewer(card);
    });

    floatBar.appendChild(zoomInButton);
    floatBar.appendChild(zoomOutButton);
    floatBar.appendChild(resetZoomButton);
    floatBar.appendChild(viewButton);
    floatBar.appendChild(exportButton);
    floatBar.appendChild(fullscreenButton);

    var status = el('div', 'mms-status');
    status.setAttribute('aria-live', 'polite');

    root.appendChild(viewport);
    root.appendChild(floatBar);
    root.appendChild(status);

    var controller = MMS.createViewport({
      viewport: viewport,
      stage: stage,
      onScale: function () {}
    });

    var statusTimer = null;
    function flash(text) {
      status.textContent = text;
      status.setAttribute('data-on', '1');
      if (statusTimer) clearTimeout(statusTimer);
      statusTimer = setTimeout(function () {
        status.removeAttribute('data-on');
        status.textContent = '';
      }, 2000);
    }

    function readView(cacheKey) {
      var stored = MMS.readLs(MMS.CONFIG.LS_VIEW_PREFIX + cacheKey.slice(0, 12));
      return stored === 'code' || stored === 'diagram' ? stored : config.DEFAULT_VIEW;
    }

    function setView(view) {
      state.view = view === 'code' ? 'code' : 'diagram';
      root.setAttribute('data-view', state.view);
      viewButton.setAttribute('aria-pressed', state.view === 'code' ? 'true' : 'false');
      var viewTitle = state.view === 'code' ? '显示图表' : '显示源代码';
      viewButton.title = viewTitle;
      viewButton.setAttribute('aria-label', viewTitle);
      MMS.writeLs(MMS.CONFIG.LS_VIEW_PREFIX + key.slice(0, 12), state.view);
      if (state.view === 'diagram' && state.phase === 'ready') {
        requestAnimationFrame(function () {
          if (root.isConnected) controller.refit();
        });
      }
      app.onViewChange(card, state.view);
    }

    function setPhase(phase) {
      state.phase = phase;
      root.setAttribute('data-mms-state', phase);
    }

    function setSkeletonSize(width, height) {
      if (!width || !height) return;
      skeleton.setAttribute('data-sized', '1');
      var box = viewport.getBoundingClientRect();
      if (!box.width) return;
      var scale = Math.min(box.width / width, 1);
      skeleton.style.height = Math.max(80, Math.round(height * scale)) + 'px';
    }

    function clearSkeletonSize() {
      skeleton.removeAttribute('data-sized');
      skeleton.style.height = '';
      skeleton.style.width = '';
    }

    /** Give the injected SVG a definite layout size so fit/zoom maths is exact. */
    function normalizeInjectedSize(svg) {
      if (!svg) return;
      var viewBox = svg.getAttribute('viewBox');
      if (viewBox) {
        var parts = viewBox.split(/[\s,]+/).map(Number);
        if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
          svg.setAttribute('width', String(parts[2]));
          svg.setAttribute('height', String(parts[3]));
        }
      }
      // mermaid ships `max-width: …px` inline; our stage owns the sizing now.
      svg.style.maxWidth = 'none';
      svg.style.width = svg.getAttribute('width') || '';
      svg.style.height = svg.getAttribute('height') || '';
    }

    function showSvg(svgString, renderId, meta) {
      try {
        var result = app.sanitizer.inject(stage, svgString, renderId);
        state.svgString = svgString;
        state.renderId = renderId;
        state.sanitized = result;
        state.error = null;
        normalizeInjectedSize(result.svg);
        clearSkeletonSize();
        setPhase('ready');
        root.setAttribute('aria-label', (meta && meta.title) || 'Mermaid 图');
        viewButton.hidden = false;
        // One fit, in the frame after insertion: a second fit forced another
        // full layout of a 3693 px SVG (measured: a 191 ms long task on first
        // render), and fitWidth() already centres what it needs to.
        requestAnimationFrame(function () {
          controller.fitWidth();
        });
        if (meta && meta.clamped) flash('图过大，已按比例缩放');
        return true;
      } catch (error) {
        if (error && error.name === 'SanitizeError') {
          if (error.kind === 'parse') {
            // Not a security event: the markup itself did not parse. Saying
            // "blocked content" here would point the user at the wrong problem.
            stats.sanitizeParseFail += 1;
            showError('图表标记无法解析', true, error.message);
            stats.publish();
            return false;
          }
          stats.sanitizeRejected += 1;
          showError('渲染结果包含被阻止的内容', false, error.message);
          stats.publish();
          // Self-heal: the fence itself is fine, only the stored copy was
          // tampered with, so the caller re-renders and overwrites the record.
          // The badge makes the event visible instead of silently recovering.
          flash('已阻止缓存中的可疑内容，正在重新渲染');
          return false;
        }
        showError('图表注入失败', true, error && error.message);
        return false;
      }
    }

    function showError(message, retryable, detail) {
      state.error = { message: message, detail: detail || '' };
      state.retryable = retryable !== false;
      errorHead.textContent = message;
      errorDetail.textContent = detail || '';
      retryButton.hidden = !state.retryable;
      resetButton.hidden = !app.isBreakerOpen();
      setPhase('error');
      clearSkeletonSize();
      if (stats) stats.error(message);
      stats.publish();
    }

    function showOverLong() {
      state.retryable = false;
      showError('源码过长，已跳过渲染', false, '超过 ' + MMS.CONFIG.MAX_SOURCE_CHARS + ' 字符的围栏不进入渲染队列');
    }

    function doExportSvg() {
      if (state.phase !== 'ready' || !stage.firstElementChild) {
        flash('图表尚未渲染完成');
        return;
      }
      try {
        app.exporter.exportVector(stage.firstElementChild, key);
        flash('已导出 SVG');
      } catch (error) {
        flash('导出失败：' + ((error && error.message) || '未知错误'));
      }
    }

    var disposed = false;
    var card = {
      el: root,
      key: key,
      source: fence.source,
      state: state,
      mount: function (block) {
        if (block && block.parentNode) block.parentNode.insertBefore(root, block);
      },
      setSkeletonSize: setSkeletonSize,
      showSvg: showSvg,
      showError: showError,
      showOverLong: showOverLong,
      showPending: function () {
        setPhase('pending');
      },
      flash: flash,
      setBreakerVisible: function (visible) {
        resetButton.hidden = !visible;
      },
      getSvg: function () {
        return state.phase === 'ready' ? stage.firstElementChild : null;
      },
      /** Already-sanitized serialization of the injected tree (§8.1). */
      serialize: function () {
        var svg = stage.firstElementChild;
        return svg ? app.exporter.serializeSvg(svg) : null;
      },
      getHash: function () {
        return key;
      },
      getSource: function () {
        return fence.source;
      },
      dispose: function () {
        if (disposed) return;
        disposed = true;
        if (statusTimer) clearTimeout(statusTimer);
        controller.dispose();
        if (root.parentNode) root.parentNode.removeChild(root);
        stage.replaceChildren();
        state.svgString = null;
        state.sanitized = null;
        stats.cardDisposed += 1;
      }
    };

    // View preference is restored before the first paint so a remembered
    // "source" view never flashes a diagram.
    setView(state.view);
    stats.cardBuilt += 1;
    // Property (not attribute) so the QA panel / harness can reach the card
    // object from its DOM node without the plugin exposing a global registry.
    root.__mmsCard = card;
    return card;
  }

  MMS.createCard = createCard;
})(typeof globalThis !== 'undefined' ? globalThis : this);
