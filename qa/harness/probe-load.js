// Probe: what does the plugin cost at page load? Run with and without
// ?noplugin=1 to compare.
const nav = performance.getEntriesByType('navigation')[0] || {};
const paints = {};
for (const entry of performance.getEntriesByType('paint')) paints[entry.name] = Math.round(entry.startTime);

const bundle = performance
  .getEntriesByType('resource')
  .filter((entry) => entry.name.indexOf('/lib/client.js') >= 0)
  .map((entry) => ({
    name: entry.name.slice(entry.name.indexOf('/lib/')),
    durationMs: Math.round(entry.duration),
    transferKB: Math.round(entry.transferSize / 1024),
    decodedKB: Math.round(entry.decodedBodySize / 1024)
  }));

// give the idle warm-up a chance to fire, then report
await new Promise((r) => setTimeout(r, 2500));

return {
  url: location.href.replace(location.origin, ''),
  dclMs: Math.round(nav.domContentLoadedEventEnd || 0),
  loadMs: Math.round(nav.loadEventEnd || 0),
  responseMs: Math.round(nav.responseEnd || 0),
  paints: paints,
  bundle: bundle,
  longTasks: (window.__loadLongTasks || []).slice(0, 12),
  longTaskCount: (window.__loadLongTasks || []).length,
  plugin: {
    loaded: typeof window.__mmsStats !== 'undefined',
    warmed: !!(window.__mmsStats && window.__mmsStats.mermaidVersion && window.__mmsStats.mermaidVersion !== 'unknown'),
    cards: document.querySelectorAll('.mms-card').length,
    styles: !!document.getElementById('mms-styles')
  }
};
