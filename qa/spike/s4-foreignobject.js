/**
 * spike/s4-foreignobject.js —— S4：foreignObject 在 <img> 静态模式下是否丢内容
 *                             （§8.2 P1-1 / 验收 #7 · 决定导出 PNG/JPG 能不能用）
 *
 * 背景：§6.7 要求白名单保留 foreignObject（否则 mermaid 的 htmlLabels 全图失败），
 *       而 §8.2 的导出管线是 svg → blob → <img> → canvas。<img> 的「安全静态模式」
 *       对 foreignObject 的绘制行为**没有验证过**。若丢内容，导出的 PNG 只剩连线与
 *       空白节点，而 #7 现有三条断言照样通过 —— 这正是「通过验收但产物不可用」。
 *
 * 怎么跑：页面里至少渲染好一张带标签的 mermaid 图（旧插件渲染的即可），
 *         控制台整段粘贴，等待结果。
 *
 * 判定：
 *   foPixels > 0 且 (fullTotal - noFOTotal) / fullTotal > 0.02  → 通过，维持 §8.2 现状
 *   foPixels === 0 或差值占比 ≈ 0                              → 丢内容，按 §8.2 二选一改造
 */
(async function () {
  'use strict';

  const MAX_SIDE = 1600; // 采样画布上限，避免超大图拖慢
  const NON_BG_ALPHA = 16;
  const NON_BG_LUMA = 245;

  const svg =
    document.querySelector('.mms-card svg') ||
    Array.from(document.querySelectorAll('svg')).find((s) => s.querySelector('foreignObject'));

  if (!svg) {
    console.error('[mms spike S4] 页面上没找到带 foreignObject 的 <svg>。先让一张 mermaid 图渲染出来。');
    return null;
  }

  function prep(svgEl, stripFO) {
    const clone = svgEl.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    if (!clone.getAttribute('xmlns:xlink')) {
      clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    }
    if (stripFO) clone.querySelectorAll('foreignObject').forEach((n) => n.remove());

    const rect = svgEl.getBoundingClientRect();
    // v5 修正：mermaid 常输出 width="100%"，parseFloat 会得到 100 → 画布被压成 100px，
    // foreignObject 区域换算随之失真。优先 viewBox，其次非百分比的 width/height，最后 rect。
    const vb = (clone.getAttribute('viewBox') || '').split(/[\s,]+/).filter(Boolean).map(Number);
    const vbW = vb.length === 4 ? Math.abs(vb[2]) : 0;
    const vbH = vb.length === 4 ? Math.abs(vb[3]) : 0;
    const raww = clone.getAttribute('width') || '';
    const rawh = clone.getAttribute('height') || '';
    const pctW = /%\s*$/.test(raww);
    const pctH = /%\s*$/.test(rawh);
    let w = vbW || (!pctW && parseFloat(raww)) || rect.width || 800;
    let h = vbH || (!pctH && parseFloat(rawh)) || rect.height || 600;
    const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
    clone.setAttribute('width', String(Math.max(1, Math.round(w * scale))));
    clone.setAttribute('height', String(Math.max(1, Math.round(h * scale))));
    return {
      text: new XMLSerializer().serializeToString(clone),
      w: Math.max(1, Math.round(w * scale)),
      h: Math.max(1, Math.round(h * scale)),
      scale
    };
  }

  async function rasterize(prepared) {
    const blob = new Blob([prepared.text], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    try {
      img.src = url;
      await img.decode();
    } catch (err) {
      URL.revokeObjectURL(url);
      throw new Error('<img> 解码失败（' + (err && err.message) + '）—— 导出管线在源串这一层就断了');
    }
    const canvas = document.createElement('canvas');
    canvas.width = prepared.w;
    canvas.height = prepared.h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    return { canvas, ctx };
  }

  function nonBgCount(ctx, x, y, w, h) {
    x = Math.max(0, Math.floor(x)); y = Math.max(0, Math.floor(y));
    w = Math.min(ctx.canvas.width - x, Math.ceil(w)); h = Math.min(ctx.canvas.height - y, Math.ceil(h));
    if (w <= 0 || h <= 0) return 0;
    const data = ctx.getImageData(x, y, w, h).data;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a <= NON_BG_ALPHA) continue;
      const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (luma < NON_BG_LUMA) n++;
    }
    return n;
  }

  // foreignObject 在 SVG 用户坐标系里的位置 → 画布坐标
  const svgRect = svg.getBoundingClientRect();
  const foBoxes = Array.from(svg.querySelectorAll('foreignObject'))
    .map((fo) => {
      const r = fo.getBoundingClientRect();
      if (!svgRect.width || !svgRect.height) return null;
      return {
        x: ((r.left - svgRect.left) / svgRect.width) * svgRect.width,
        y: ((r.top - svgRect.top) / svgRect.height) * svgRect.height,
        w: r.width,
        h: r.height
      };
    })
    .filter(Boolean);

  const full = prep(svg, false);
  const noFO = prep(svg, true);
  const out = { at: new Date().toISOString(), viewport: { w: full.w, h: full.h, scale: full.scale }, foCount: foBoxes.length };

  try {
    const a = await rasterize(full);
    const b = await rasterize(noFO);

    // 全图非背景像素
    out.fullPixels = nonBgCount(a.ctx, 0, 0, a.canvas.width, a.canvas.height);
    out.noFoPixels = nonBgCount(b.ctx, 0, 0, b.canvas.width, b.canvas.height);

    // foreignObject 区域内的非背景像素（按画布比例缩放）
    const kx = a.canvas.width / (svgRect.width || 1);
    const ky = a.canvas.height / (svgRect.height || 1);
    out.foRegions = foBoxes.map((bx, i) => {
      const n = nonBgCount(a.ctx, bx.x * kx, bx.y * ky, bx.w * kx, bx.h * ky);
      return { i, box: [Math.round(bx.x), Math.round(bx.y), Math.round(bx.w), Math.round(bx.h)], nonBg: n };
    });
    out.foPixels = out.foRegions.reduce((s, r) => s + r.nonBg, 0);

    out.deltaRatio = out.fullPixels ? (out.fullPixels - out.noFoPixels) / out.fullPixels : 0;
    out.deltaNote = 'deltaRatio 仅作诊断：浅色填充也算非背景像素，文字占比通常 < 2%，不可作判据（v5 修正）';

    // v5 修正：判据只看「foreignObject 区域是否完全无像素」。
    // 原实现叠加 deltaRatio <= 0.02，会把正常渲染误判成丢内容，进而触发不必要的导出改造。
    const lost = out.foPixels === 0;
    out.verdict = lost ? 'FO_CONTENT_LOST' : 'FO_RENDERED';
    out.recommendation = lost
      ? '按 §8.2 处置：① 序列化前把 foreignObject 降级为 <text>；或 ② 导出走 htmlLabels:false 的第二条渲染路径（需安全侧确认白名单覆盖并集）'
      : '维持 §8.2 现有管线；把「标签区域非背景像素 > 0」写进验收 #7';

    // 给人眼看的附件
    out.previewUrl = a.canvas.toDataURL('image/png');
  } catch (err) {
    out.error = (err && err.message) || String(err);
    out.verdict = 'INCONCLUSIVE';
  }

  console.group('%c[mms spike S4] foreignObject → canvas', 'color:#c9a227;font-weight:bold');
  console.log(out);
  if (out.previewUrl) {
    console.log('%c导出结果预览（点开看标签是否还在）', 'color:#c9a227');
    const img = new Image();
    img.src = out.previewUrl;
    img.style.cssText = 'max-width:100%;border:1px solid #666;margin-top:6px';
    console.log(img);
  }
  console.log('verdict：' + out.verdict + ' · ' + (out.recommendation || out.error || ''));
  console.groupEnd();

  window.__mmsSpikeS4 = out;
  return out;
})();
