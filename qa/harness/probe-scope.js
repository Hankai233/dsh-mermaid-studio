// Probe: does per-scope deletion settle, and does it only touch that scope?
const app = window.__mmsDebug.app;
function rec(scope, key) {
  return {
    key,
    source: 'graph TD\n ' + scope + ' --> X',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
    width: 10,
    height: 10,
    theme: 'default',
    mermaidVersion: app.mermaidVersion(),
    schema: 1,
    renderId: 'mms-' + key,
    scopeHash: scope,
    createdAt: Date.now(),
    lastUsed: Date.now(),
    expiresAt: Date.now() + 86400000,
    hits: 0,
    bytes: 120
  };
}
const seededA = await window.__idbSeed(rec('session-A', 'rec-A'));
const seededB = await window.__idbSeed(rec('session-B', 'rec-B'));
const before = await window.__idbAll();
const dropped = await Promise.race([
  app.cache.dropScope('session-A').then((v) => 'dropped:' + v),
  new Promise((r) => setTimeout(() => r('TIMEOUT'), 4000))
]);
const after = await window.__idbAll();
return {
  seededA,
  seededB,
  beforeCount: before.length,
  beforeKeys: before.map((r) => r.key),
  dropped,
  afterKeys: after.map((r) => r.key),
  indexes: await new Promise((resolve) => {
    const open = indexedDB.open('dsh-mermaid-studio');
    open.onsuccess = () => {
      const db = open.result;
      const names = db.objectStoreNames.contains('diagrams')
        ? Array.from(db.transaction('diagrams', 'readonly').objectStore('diagrams').indexNames)
        : [];
      db.close();
      resolve(names);
    };
    open.onerror = () => resolve(['open-failed']);
  })
};
