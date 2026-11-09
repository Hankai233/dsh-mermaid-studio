/* ── diag.js — contract dump for hosts we cannot open a console in ──────────
 *
 * The desktop GUI has no DevTools, and the plugin's own health signals live in
 * the renderer. When the fence contract changes, "nothing renders" and "not
 * loaded at all" look identical from outside — this chunk exists to tell them
 * apart: it walks the real DOM and hands back one JSON file with the selectors,
 * labels and ancestor chains it actually saw.
 *
 * Gated by CONFIG.AUDIT, which the build only turns on for diagnostic builds.
 */
(function (g) {
  'use strict';
  var MMS = g.__MMS__ || (g.__MMS__ = {});

  function attrSummary(el) {
    var out = {};
    var attrs = el.attributes || [];
    for (var i = 0; i < attrs.length; i += 1) {
      var name = attrs[i].name;
      if (name === 'class' || name === 'style') continue;
      if (name.indexOf('data-') === 0 || name.indexOf('aria-') === 0) {
        out[name] = String(attrs[i].value).slice(0, 80);
      }
    }
    return out;
  }

  function describe(el) {
    if (!el || el.nodeType !== 1) return null;
    var name = (el.localName || el.nodeName || '').toLowerCase();
    var cls = typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean).slice(0, 4).join('.') : '';
    var attrs = attrSummary(el);
    var extra = Object.keys(attrs).map(function (key) {
      return '[' + key + '=' + attrs[key] + ']';
    }).join('');
    return name + (cls ? '.' + cls : '') + extra;
  }

  function ancestry(el, depth) {
    var chain = [];
    var node = el;
    var guard = 0;
    while (node && node.nodeType === 1 && guard < depth) {
      chain.push(describe(node));
      node = node.parentElement;
      guard += 1;
    }
    return chain;
  }

  function slotValues() {
    var values = {};
    var nodes = g.document.querySelectorAll('[data-slot]');
    for (var i = 0; i < nodes.length; i += 1) {
      var value = nodes[i].getAttribute('data-slot');
      values[value] = (values[value] || 0) + 1;
    }
    return values;
  }

  function blockDetail(block, index) {
    var banner = block.querySelector(MMS.fence.SELECTORS.banner);
    var bannerLang = block.querySelector(MMS.fence.SELECTORS.bannerLang);
    var code = block.querySelector('pre code') || block.querySelector('code');
    var content = block.querySelector(MMS.fence.SELECTORS.content);
    var slotAncestor = block.closest('[data-slot]');
    return {
      index: index,
      className: String(block.className),
      attrs: attrSummary(block),
      bannerFound: !!banner,
      bannerText: banner ? String(banner.textContent).trim().slice(0, 60) : null,
      bannerLangFound: !!bannerLang,
      bannerLangText: bannerLang ? String(bannerLang.textContent).trim().slice(0, 60) : null,
      firstChildText: block.firstElementChild ? String(block.firstElementChild.textContent).trim().slice(0, 60) : null,
      codeFound: !!code,
      codeClass: code && typeof code.className === 'string' ? code.className : null,
      contentContainerFound: !!content,
      sourceHead: MMS.fence.readSource(block).slice(0, 160),
      label: MMS.fence.readLanguageLabel(block),
      detected: MMS.fence.isMermaidBlock(block),
      closestSlot: slotAncestor ? slotAncestor.getAttribute('data-slot') : null,
      ancestry: ancestry(block, 8)
    };
  }

  function buildAudit() {
    var doc = g.document;
    var roots = doc.querySelectorAll(MMS.fence.SELECTORS.root);
    var blocks = doc.querySelectorAll(MMS.fence.SELECTORS.block);
    var audit = {
      at: new Date().toISOString(),
      href: String(g.location && g.location.href),
      title: doc.title,
      readyState: doc.readyState,
      viewport: { w: g.innerWidth, h: g.innerHeight, dpr: g.devicePixelRatio },
      package: {
        id: MMS.PACKAGE_ID,
        schema: MMS.CONFIG.SCHEMA,
        sanitizer: MMS.CONFIG.SANITIZER_VERSION,
        mermaid: (g.__MMS_MERMAID_VERSION__ || 'unknown')
      },
      loaded: {
        mmsNamespace: !!MMS.createApp,
        stats: !!g[MMS.CONFIG.STATS_KEY],
        styles: !!doc.getElementById(MMS.CONFIG.STYLE_ID),
        debug: !!g.__mmsDebug,
        configGlobal: g[MMS.CONFIG.CONFIG_GLOBAL] !== undefined
      },
      config: null,
      stats: null,
      slots: slotValues(),
      selectors: {
        root: MMS.fence.SELECTORS.root,
        rootsFound: roots.length,
        blocksFound: blocks.length
      },
      blocks: [],
      scanner: null,
      probes: {}
    };

    try {
      audit.config = MMS.resolveConfig();
    } catch (error) {
      audit.config = 'ERR ' + error.message;
    }
    try {
      audit.stats = JSON.parse(JSON.stringify(g[MMS.CONFIG.STATS_KEY] || null));
    } catch (error) {
      audit.stats = 'ERR ' + error.message;
    }
    try {
      if (g.__mmsDebug && g.__mmsDebug.scanner) {
        var scanner = g.__mmsDebug.scanner();
        audit.scanner = scanner && scanner.debug ? scanner.debug() : 'no-debug';
      }
    } catch (error) {
      audit.scanner = 'ERR ' + error.message;
    }

    var limit = Math.min(blocks.length, 4);
    for (var i = 0; i < limit; i += 1) {
      try {
        audit.blocks.push(blockDetail(blocks[i], i));
      } catch (error) {
        audit.blocks.push({ index: i, error: String(error && error.message) });
      }
    }

    // Independent probes: do the two assumptions the scanner rests on hold here?
    audit.probes.flowCandidates = doc.querySelectorAll('[data-slot="conversation.chat.flow"]').length;
    audit.probes.blocksInsideFlow = 0;
    for (var j = 0; j < blocks.length; j += 1) {
      var slot = blocks[j].closest('[data-slot]');
      if (slot && slot.getAttribute('data-slot') === 'conversation.chat.flow') {
        audit.probes.blocksInsideFlow += 1;
      }
    }
    try {
      audit.probes.firstBlockRect = blocks.length
        ? (function (rect) {
            return { w: Math.round(rect.width), h: Math.round(rect.height), visible: rect.width > 0 && rect.height > 0 };
          })(blocks[0].getBoundingClientRect())
        : null;
    } catch (error) {
      audit.probes.firstBlockRect = String(error && error.message);
    }
    return audit;
  }

  function downloadAudit() {
    var payload = JSON.stringify(buildAudit(), null, 2);
    // Second channel: the desktop GUI may swallow programmatic downloads, and a
    // LevelDB string is still readable from disk by whoever debugs the host.
    try {
      g.localStorage.setItem('mms:audit', payload);
    } catch (error) {
      /* storage unavailable: the download is the only channel */
    }
    var name = 'mms-audit-' + Date.now() + '.json';
    try {
      var blob = new g.Blob([payload], { type: 'application/json' });
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
    } catch (error) {
      console.warn('[mms] audit download failed:', error);
    }
    console.info('[mms] audit written: ' + name);
    return payload;
  }

  MMS.buildAudit = buildAudit;
  MMS.downloadAudit = downloadAudit;
})(typeof globalThis !== 'undefined' ? globalThis : this);
