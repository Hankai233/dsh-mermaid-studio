const app = window.__mmsDebug.app;
const out = {};
const t0 = performance.now();
const version = app.mermaidVersion();
out.version = version;
out.versionMs = Math.round((performance.now() - t0) * 100) / 100;
const t1 = performance.now();
const key = window.__MMS__.key.buildKey({
  mermaidVersion: version,
  theme: 'default',
  scopeHash: 'x',
  themeRevision: 'default@f',
  fontCode: 'f',
  renderConfig: 'c',
  source: 'graph TD\n A-->B'
});
out.keyMs = Math.round((performance.now() - t1) * 100) / 100;
out.key = key.slice(0, 8);
const t2 = performance.now();
const warmed = app.renderer.warm();
out.warmMs = Math.round(performance.now() - t2);
out.warmed = warmed;
return out;