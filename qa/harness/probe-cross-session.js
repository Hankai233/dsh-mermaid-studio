// Probe: is the cache shared across conversations? Simulate a session switch by
// tearing the chat flow down and remounting the same source, once with no session
// marker and once with a session id on the root.
const source = 'graph TD\n  SHARED["同一份源码"] --> HIT[缓存命中]';
const app = window.__mmsDebug.app;

const out = { scopeSource: null, runs: [] };

async function run(label, decorate) {
  const flow = document.getElementById('flow');
  flow.innerHTML = '';
  // drop any previous marker so each run is independent
  flow.removeAttribute('data-session-id');
  if (decorate) decorate(flow);
  await new Promise((r) => setTimeout(r, 150));

  const before = window.__stats();
  const beforeCounts = {
    render: before.renderCount,
    hit1: before.cacheHitL1,
    hit2: before.cacheHitL2
  };
  const scope = app.scopeHash();
  const block = window.__addFence(source, 'mermaid');
  await window.__waitFor(() => {
    const card = block.previousElementSibling;
    return card && card.getAttribute('data-mms-state') === 'ready';
  }, 20000);
  await new Promise((r) => setTimeout(r, 250));
  const after = window.__stats();
  out.runs.push({
    label: label,
    scopeHash: scope.slice(0, 10),
    renderDelta: after.renderCount - beforeCounts.render,
    hitL1Delta: after.cacheHitL1 - beforeCounts.hit1,
    hitL2Delta: after.cacheHitL2 - beforeCounts.hit2,
    state: block.previousElementSibling.getAttribute('data-mms-state')
  });
}

await run('first (cold)');
await run('same session, remounted');
await run('other conversation, no session marker');
await run('other conversation with data-session-id', (flow) => {
  flow.setAttribute('data-session-id', 'session-other-1234');
});

out.scopeSource = window.__stats().scopeSource;
out.records = (await window.__idbAll()).filter((rec) => (rec.source || '').indexOf('SHARED') >= 0).length;
return out;
