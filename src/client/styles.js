/* ── styles.js — one <style> element, removed on unload ─────────────────────
 *
 * Visual language (borrowed from the guizang-page design rules, applied to a
 * chat widget rather than a document):
 *   · near-white paper / near-black ink instead of #fff / #000
 *   · one accent per card, used only for focus, the active view toggle and the
 *     loading tint — never for decoration
 *   · mono for chrome (buttons, counters, error detail), sans for nothing:
 *     every piece of text this plugin draws is chrome, so it is mono throughout
 *   · surfaces and spacing carry the separation; only one hairline is drawn (the
 *     card outline) and it softens on hover instead of gaining a second line
 *   · restrained radii (8px card, 9px pill, 6px buttons), one soft shadow only
 *     where something floats over content
 *
 * DSH tokens are preferred everywhere; the fallbacks are the Swiss palette so the
 * card still reads correctly outside the app (harness screenshots, exports).
 *
 * Namespacing: everything is `.mms-`. The only rules touching host nodes are the
 * sibling rules that hide the code block, and they use `+` (the block we inserted
 * next to) rather than `~` (which would hide every later block in the message).
 */
(function (g) {
  'use strict';
  var MMS = g.__MMS__ || (g.__MMS__ = {});

  var CSS = [
    /* ── card ─────────────────────────────────────────────────────────────── */
    '.mms-card{--mms-paper:var(--dsw-alias-bg-base,#fafaf8);--mms-surface:var(--dsw-alias-bg-layer-1,#f2f2ee);--mms-surface-2:var(--dsw-alias-bg-layer-2,#fffefb);--mms-line:var(--dsw-alias-border-l1,rgba(10,10,10,.10));--mms-line-2:var(--dsw-alias-border-l2,rgba(10,10,10,.20));--mms-ink:var(--dsw-alias-label-primary,#0a0a0a);--mms-ink-2:var(--dsw-alias-label-secondary,#6c6c66);--mms-ink-3:var(--dsw-alias-label-caption,#96968f);--mms-accent:var(--dsw-alias-state-business-primary,#002fa7);--mms-accent-soft:color-mix(in srgb,var(--mms-accent) 10%,transparent);--mms-warn:var(--dsw-alias-state-warn-label,#9a6a00);--mms-error:var(--dsw-alias-state-error-primary,#c0342b);--mms-mono:var(--ds-font-family-code,"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace);--mms-r-card:8px;--mms-r-ctl:6px;box-sizing:border-box;position:relative;margin:12px 0;border:1px solid var(--mms-line);border-radius:var(--mms-r-card);background:var(--mms-paper);color:var(--mms-ink);overflow:hidden;transition:border-color .16s ease}',
    '.mms-card:hover{border-color:var(--mms-line-2)}',
    '.mms-card[data-mms-state="error"]{border-color:color-mix(in srgb,var(--mms-error) 38%,var(--mms-line))}',

    /* ── viewport ─────────────────────────────────────────────────────────── */
    '.mms-vp{position:relative;user-select:none;-webkit-user-select:none;height:clamp(200px,44vh,560px);overflow:hidden;cursor:grab;touch-action:pan-y;background:var(--mms-paper);contain:paint}',
    '.mms-vp:focus-visible{outline:2px solid var(--mms-accent);outline-offset:-3px}',
    '.mms-vp[data-dragging="1"]{cursor:grabbing;touch-action:none}',
    /* Layer promotion is opt-in: a permanent will-change on a freshly injected
       3.7k-px SVG made the first paint pay for a layer it did not need yet. */
    '.mms-vp[data-dragging="1"] .mms-stage,.mms-vp[data-zoomed="1"] .mms-stage{will-change:transform}',
    '.mms-stage{position:absolute;top:0;left:0;transform-origin:0 0;display:inline-block;contain:layout style paint;backface-visibility:hidden}',
    '.mms-stage > svg{display:block;max-width:none!important;height:auto}',

    /* ── loading ──────────────────────────────────────────────────────────── */
    '.mms-skeleton{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;padding:20px}',
    '.mms-card[data-mms-state="ready"] .mms-skeleton,.mms-card[data-mms-state="error"] .mms-skeleton{display:none}',
    '.mms-skeleton span{display:block;height:5px;border-radius:3px;background:var(--mms-accent);opacity:.18;animation:mms-breathe 1.6s ease-in-out infinite}',
    '.mms-skeleton span:nth-child(1){width:min(320px,62%)}',
    '.mms-skeleton span:nth-child(2){width:min(232px,45%);animation-delay:.12s}',
    '.mms-skeleton span:nth-child(3){width:min(148px,30%);animation-delay:.24s}',
    '@keyframes mms-breathe{0%,100%{opacity:.14}50%{opacity:.5}}',
    '.mms-skeleton[data-sized="1"]{padding:0}',
    '.mms-skeleton[data-sized="1"] span{display:none}',

    /* ── error ────────────────────────────────────────────────────────────── */
    '.mms-card[data-mms-state="error"] .mms-vp{height:auto;min-height:0}',
    '.mms-error{position:relative;display:none;flex-direction:column;gap:10px;padding:16px 16px 14px;background:var(--mms-paper)}',
    '.mms-card[data-mms-state="error"] .mms-error{display:flex}',
    '.mms-error-head{font:600 11px/1.3 var(--mms-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--mms-error)}',
    '.mms-error-detail{margin:0;font:400 11.5px/1.65 var(--mms-mono);white-space:pre-wrap;word-break:break-word;color:var(--mms-ink-2);max-height:180px;overflow:auto}',
    '.mms-error-actions{display:flex;gap:8px;margin-top:2px}',
    '.mms-error-actions .mms-btn{height:28px;padding:0 12px;border:1px solid var(--mms-line);background:var(--mms-surface-2);color:var(--mms-ink)}',

    /* ── controls: one pill, floating at the top-right of the diagram ─────── */
    '.mms-float{position:absolute;right:12px;top:12px;z-index:6;display:flex;align-items:center;gap:1px;padding:4px;border:1px solid var(--mms-line);border-radius:9px;background:var(--mms-surface-2);box-shadow:0 10px 24px -14px rgba(0,0,0,.45),0 1px 2px rgba(0,0,0,.06);backdrop-filter:blur(8px) saturate(1.15);opacity:0;transform:translateY(-4px);pointer-events:none;transition:opacity .14s ease,transform .14s ease}',
    '.mms-card:hover .mms-float,.mms-float:focus-within{opacity:1;transform:none;pointer-events:auto}',
    '@media (hover:none){.mms-float{opacity:1;transform:none;pointer-events:auto}}',
    '.mms-btn{appearance:none;border:0;background:transparent;color:var(--mms-ink-2);font:500 11.5px/1 var(--mms-mono);letter-spacing:.01em;border-radius:var(--mms-r-ctl);height:26px;padding:0 9px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:4px;white-space:nowrap;transition:background-color .12s ease,color .12s ease}',
    '.mms-btn:hover{background:var(--mms-surface);color:var(--mms-ink)}',
    '.mms-btn:active{background:var(--mms-accent-soft);color:var(--mms-accent)}',
    '.mms-btn:focus-visible{outline:2px solid var(--mms-accent);outline-offset:1px}',
    '.mms-btn[aria-pressed="true"]{background:var(--mms-accent-soft);color:var(--mms-accent)}',
    '.mms-btn[disabled]{opacity:.4;cursor:default}',
    '.mms-btn-icon{width:26px;padding:0;font-size:12px}',
    '.mms-btn-icon svg{width:13px;height:13px;display:block}',
    /* A soft veil behind the pill: the controls sit over the drawing, and a fade
       makes that read as intentional instead of accidental overlap. */
    '.mms-vp::after{content:"";position:absolute;top:0;right:0;z-index:5;width:320px;height:72px;pointer-events:none;opacity:0;transition:opacity .14s ease;background:radial-gradient(120% 100% at 100% 0,var(--mms-paper) 30%,color-mix(in srgb,var(--mms-paper) 60%,transparent) 60%,transparent 100%)}',
    '.mms-card:hover .mms-vp::after{opacity:1}',
    '.mms-card[data-view="code"] .mms-vp::after{display:none}',
    '.mms-float-note{padding:0 9px 0 5px;font:400 10.5px/1 var(--mms-mono);letter-spacing:.02em;color:var(--mms-warn);white-space:nowrap}',

    /* ── status line ──────────────────────────────────────────────────────── */
    '.mms-status{position:absolute;left:12px;bottom:12px;padding:3px 8px;border-radius:999px;border:1px solid var(--mms-line);background:var(--mms-surface-2);font:400 10.5px/1.5 var(--mms-mono);color:var(--mms-ink-2);pointer-events:none;opacity:0;transition:opacity .16s ease}',
    '.mms-status[data-on="1"]{opacity:1}',

    /* ── fullscreen overlay ───────────────────────────────────────────────── */
    '[data-mms-overlay]{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(10,10,10,.66);backdrop-filter:blur(4px)}',
    '[data-mms-overlay] .mms-shell{display:flex;flex-direction:column;width:92vw;height:88vh;border:1px solid rgba(255,255,255,.14);border-radius:12px;background:var(--mms-paper,#fafaf8);box-shadow:0 32px 80px -32px rgba(0,0,0,.7);overflow:hidden;outline:none}',
    '[data-mms-overlay] .mms-bar{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--mms-line,rgba(10,10,10,.1));background:var(--mms-surface,#f2f2ee);min-height:40px}',
    '[data-mms-overlay] .mms-badge{font:600 10.5px/1 var(--mms-mono,monospace);letter-spacing:.1em;text-transform:uppercase;color:var(--mms-ink-3,#96968f)}',
    '[data-mms-overlay] .mms-actions{margin-left:auto;display:flex;align-items:center;gap:2px}',
    '[data-mms-overlay] .mms-scale{min-width:46px;text-align:right;font:500 11px/1 var(--mms-mono,monospace);font-variant-numeric:tabular-nums;color:var(--mms-ink-2,#6c6c66)}',
    '[data-mms-overlay] .mms-vp{flex:1;height:auto;cursor:grab;background:var(--mms-paper,#fafaf8)}',

    /* ── diagram / source switch: two sibling rules, no node is moved ─────── */
    '.mms-card[data-view="diagram"] + .md-code-block{display:none}',
    '.mms-card[data-view="code"] + .md-code-block{display:block}',
    '.mms-card[data-view="code"]{border-color:transparent;background:transparent;margin-bottom:2px}',
    /* no canvas to hover in source view: the same row becomes a plain row above
       the code block, in the same visual place, so the switch never makes the
       controls jump around */
    '.mms-card[data-view="code"] .mms-vp{display:none}',
    '.mms-card[data-view="code"] .mms-float{position:static;margin:0 0 3px;padding:0 2px;border:0;background:transparent;box-shadow:none;backdrop-filter:none;opacity:1;transform:none;pointer-events:auto;justify-content:flex-end}',
    '.mms-card[data-view="code"] .mms-error{display:none}',

    '@media (prefers-reduced-motion:reduce){.mms-float,.mms-status,.mms-card{transition:none}.mms-skeleton span{animation:none;opacity:.28}[data-mms-overlay]{backdrop-filter:none}}'
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
