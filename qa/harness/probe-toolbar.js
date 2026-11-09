// Probe: the toolbar after the SVG-only change, and that export actually runs.
const blocks = await window.__reset([{ source: 'graph TD\n  A --> B', lang: 'mermaid' }]);
const card = blocks[0].previousElementSibling;
const labels = Array.from(card.querySelectorAll('.mms-bar button')).map(function (b) {
  return b.textContent.trim() || b.getAttribute('aria-label');
});
const errors = [];
window.addEventListener('error', function (e) {
  errors.push(String(e.message));
});

let clicked = false;
card.querySelectorAll('.mms-bar button').forEach(function (b) {
  if (b.textContent.trim() === '导出 SVG') {
    b.click();
    clicked = true;
  }
});
await new Promise(function (r) { setTimeout(r, 600); });

return {
  toolbar: labels,
  clickedExport: clicked,
  hasCopy: labels.indexOf('复制') >= 0,
  hasMenu: !!card.querySelector('.mms-menu'),
  status: card.querySelector('.mms-status') ? card.querySelector('.mms-status').textContent : '',
  errors: errors,
  exporterApi: Object.keys(window.__MMS__.createExporter({})),
  bundleHasRasterize: typeof window.__MMS__.exportInternals.rasterize,
  statsExportCount: (window.__stats() || {}).exportCount
};
