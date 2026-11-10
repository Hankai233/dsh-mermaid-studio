/* ── styles.js — one <style> element, removed on unload ─────────────────────
 *
 * The host offers no stylesheet insertion API we can rely on (`styles.insert` is
 * not in the static client contract), so the plugin owns a single <style
 * id="mms-styles"> and deletes it when it goes away.
 *
 * Everything is namespaced under `.mms-`; the only rules that touch host nodes
 * are the sibling rules that hide the code block, and they use `+` (the block we
 * inserted next to) rather than `~` (which would also hide every later code
 * block in the same message).
 */
(function (g) {
  'use strict';
  var MMS = g.__MMS__ || (g.__MMS__ = {});

  var CSS = [
    '.mms-card{--mms-border:var(--dsw-alias-border-l1,rgba(127,127,127,.28));--mms-bg:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));--mms-bg-2:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));--mms-label:var(--dsw-alias-label-primary,inherit);--mms-label-2:var(--dsw-alias-label-secondary,#8a8f98);--mms-accent:var(--dsw-alias-state-business-primary,#4d93f8);box-sizing:border-box;position:relative;margin:10px 0;border:1px solid var(--mms-border);border-radius:10px;background:var(--mms-bg);color:var(--mms-label);font-family:var(--ds-font-family-text,inherit);overflow:hidden}',
    '.mms-card[data-mms-state="error"]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 45%,transparent)}',

    /* bar */
    '.mms-btn{appearance:none;border:0;background:transparent;color:var(--mms-label-2);font:var(--dsw-font-xxxs-11,11px/1.4 inherit);border-radius:6px;padding:3px 7px;cursor:pointer;line-height:1.5;display:inline-flex;align-items:center;gap:4px;white-space:nowrap}',
    '.mms-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));color:var(--mms-label)}',
    '.mms-btn:focus-visible{outline:2px solid var(--mms-accent);outline-offset:1px}',
    '.mms-btn[aria-pressed="true"]{color:var(--mms-accent)}',
    '.mms-btn[disabled]{opacity:.45;cursor:default}',
    '.mms-btn-icon{width:24px;height:22px;justify-content:center;padding:0}',


    /* viewport */
    '.mms-vp{position:relative;user-select:none;-webkit-user-select:none;height:clamp(180px,42vh,560px);overflow:hidden;cursor:grab;touch-action:pan-y;background:var(--mms-bg);contain:paint}',
    '.mms-vp:focus-visible{outline:2px solid var(--mms-accent);outline-offset:-2px}',
    /* Floating controls: hidden until the pointer is over the diagram (or focus is inside it), bottom-right. pointer-events stay off while hidden so the row never swallows a drag. */
    '.mms-float{position:absolute;right:10px;top:10px;z-index:6;display:flex;align-items:center;gap:2px;padding:3px;border-radius:10px;border:1px solid var(--mms-border);background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,#fff));backdrop-filter:blur(6px);box-shadow:var(--dsw-shadow-lv2,0 6px 18px rgba(0,0,0,.18));opacity:0;transform:translateY(-4px);pointer-events:none;transition:opacity .12s ease,transform .12s ease}',
    '.mms-card:hover .mms-float,.mms-float:focus-within{opacity:1;transform:none;pointer-events:auto}',
    '.mms-float .mms-btn{padding:2px 8px;font-size:12px;line-height:20px;min-width:26px;justify-content:center}',
    '.mms-float-note{margin:0 8px 0 6px;font:11px/1.4 inherit;color:var(--dsw-alias-state-warn-label,#b27a00);white-space:nowrap}',
    '@media (prefers-reduced-motion:reduce){.mms-float{transition:none}}',
    '.mms-vp[data-dragging="1"]{cursor:grabbing;touch-action:none}',
    // Layer promotion is opt-in: a permanent will-change on a freshly injected
    // 3.7k-px SVG made the first paint pay for a layer it did not need yet.
    '.mms-vp[data-dragging="1"] .mms-stage,.mms-vp[data-zoomed="1"] .mms-stage{will-change:transform}',
    '.mms-stage{position:absolute;top:0;left:0;transform-origin:0 0;display:inline-block;contain:layout style paint;backface-visibility:hidden}',
    '.mms-stage > svg{display:block;max-width:none!important;height:auto}',
    '.mms-card[data-view="code"] .mms-vp{display:none}',

    /* skeleton / pending */
    '.mms-skeleton{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:16px}',
    '.mms-card[data-mms-state="ready"] .mms-skeleton,.mms-card[data-mms-state="error"] .mms-skeleton{display:none}',
    '.mms-skeleton span{display:block;height:9px;border-radius:5px;background:var(--mms-bg-2);animation:mms-pulse 1.4s ease-in-out infinite}',
    '.mms-skeleton span:nth-child(1){width:min(320px,70%)}',
    '.mms-skeleton span:nth-child(2){width:min(240px,55%);animation-delay:.15s}',
    '.mms-skeleton span:nth-child(3){width:min(160px,40%);animation-delay:.3s}',
    '@keyframes mms-pulse{0%,100%{opacity:.45}50%{opacity:1}}',
    '.mms-skeleton[data-sized="1"]{padding:0}',
    '.mms-skeleton[data-sized="1"] span{display:none}',

    /* error */
    '.mms-error{position:absolute;inset:0;display:none;flex-direction:column;gap:8px;padding:12px;overflow:auto;background:var(--mms-bg)}',
    '.mms-card[data-mms-state="error"] .mms-error{display:flex}',
    '.mms-error-head{font:var(--dsw-font-xxs-strong-12,600 12px/1.4 inherit);color:var(--dsw-alias-state-error-primary,#e5484d)}',
    '.mms-error-detail{margin:0;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-word;color:var(--mms-label-2);max-height:40%;overflow:auto}',
    '.mms-error-actions{display:flex;gap:6px}',

    /* status line */
    '.mms-status{position:absolute;left:8px;bottom:6px;font:var(--dsw-font-xxxs-11,11px/1.4 inherit);color:var(--mms-label-2);pointer-events:none;opacity:0;transition:opacity .15s}',
    '.mms-status[data-on="1"]{opacity:1}',

    /* fullscreen overlay */
    '[data-mms-overlay]{position:fixed;inset:0;z-index:2147483000;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.62));display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px)}',
    '[data-mms-overlay] .mms-shell{display:flex;flex-direction:column;width:92vw;height:88vh;border:1px solid var(--mms-border,#333);border-radius:12px;background:var(--dsw-alias-bg-base,#fff);overflow:hidden}',
    '[data-mms-overlay] .mms-bar{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid var(--mms-border);background:var(--mms-bg-2);min-height:32px}',
    '[data-mms-overlay] .mms-actions{margin-left:auto;display:flex;align-items:center;gap:2px}',
    '[data-mms-overlay] .mms-badge{font:600 11px/1.4 ui-monospace,monospace;color:var(--mms-label-2);letter-spacing:.02em;text-transform:lowercase}',
    '[data-mms-overlay] .mms-vp{flex:1;height:auto;cursor:grab}',
    '[data-mms-overlay] .mms-scale{font:var(--dsw-font-xxxs-11,11px/1.4 inherit);color:var(--mms-label-2);min-width:44px;text-align:right}',

    /* hide the host code block only, never restyle it */
    '.mms-card[data-view="diagram"] + .md-code-block{display:none}',
    '.mms-card[data-view="code"] + .md-code-block{display:block}',
    '.mms-card[data-view="code"]{border-color:transparent;background:transparent}',
    '.mms-card[data-view="code"] .mms-float{position:static;margin:0 0 2px;opacity:1;transform:none;pointer-events:auto;justify-content:flex-end;border:0;background:transparent;box-shadow:none;padding:0 2px}',
    '.mms-card[data-view="code"] .mms-error{display:none}',

    '@media (prefers-reduced-motion:reduce){.mms-skeleton span{animation:none}[data-mms-overlay]{backdrop-filter:none}}'
  ].join('\n');

  function mountStyles() {
    var doc = g.document;
    if (!doc) return function () {};
    var existing = doc.getElementById(MMS.CONFIG.STYLE_ID);
    if (existing) return function () {};
    var style = doc.createElement('style');
    style.id = MMS.CONFIG.STYLE_ID;
    style.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(style);
    return function unmount() {
      if (style.parentNode) style.parentNode.removeChild(style);
    };
  }

  MMS.styles = { CSS: CSS, mount: mountStyles };
})(typeof globalThis !== 'undefined' ? globalThis : this);
