// Probe: split the first-render latency into debounce / cache / queue / render /
// inject / fit, and report long tasks for each pass (cold then warm page).
const base = [
  'flowchart LR',
  '  subgraph FE["浏览器 · 前端"]',
  '    F1["knowledge-base store<br/>5MB 分片 × 4 并发"]',
  '    F2["knowledge-base 列表页<br/>WS 事件 + 兜底轮询"]',
  '  end',
  '  subgraph API["Spring Boot :8081"]',
  '    C1["UploadController<br/>/api/v1/upload/*"]',
  '    S1["UploadService<br/>分片/合并/清理"]',
  '    S2["FileProcessingOutboxService<br/>事务性发件箱"]',
  '    K1["Kafka 生产者<br/>executeInTransaction"]',
  '    K2["FileProcessingConsumer<br/>@KafkaListener"]',
  '    L1["VectorizationLeaseService<br/>条件 UPDATE 租约"]',
  '    P1["ParseService<br/>Tika / LiteParse + 分块"]',
  '    V1["VectorizationService<br/>批 10 条 embedding"]',
  '    N1["DocumentStatusNotifier<br/>事务提交后推送"]',
  '  end',
  '  subgraph INFRA["基础设施"]',
  '    M1[("MinIO<br/>chunks/ · merged/")]',
  '    R1[("Redis<br/>分片 bitmap · 发布订阅")]',
  '    Q1[["Kafka<br/>file-processing-topic1 + dlt"]]',
  '    E1[("Elasticsearch<br/>别名 knowledge_base")]',
  '  end',
  '  F1 -->|"POST /upload/chunk"| C1',
  '  C1 --> S1',
  '  S1 -->|"putObject"| M1',
  '  S2 -->|"afterCommit + 定时补发"| K1',
  '  K1 --> Q1',
  '  Q1 --> K2',
  '  K2 --> L1',
  '  K2 -->|"清旧索引 + 解析"| P1',
  '  K2 --> V1',
  '  K2 -->|"complete 后"| N1',
  '  R1 -->|"document_status"| F2'
];

const app = window.__mmsDebug.app;
const out = { passes: [] };

let tCacheGet = 0;
let tPush = 0;
let tRender = 0;
let tInject = 0;
let tPushToRender = 0;
let lastPushAt = 0;
let lastRenderStart = 0;

const realCacheGet = app.cache.get.bind(app.cache);
app.cache.get = function (key) {
  const t = performance.now();
  return realCacheGet(key).finally(() => {
    tCacheGet += performance.now() - t;
  });
};
const realPush = app.queue.push.bind(app.queue);
app.queue.push = function (job) {
  lastPushAt = performance.now();
  const handle = realPush(job);
  tPush += 1;
  return handle;
};
const realRender = app.renderer.render.bind(app.renderer);
app.renderer.render = function (job) {
  if (lastPushAt) {
    lastRenderStart = performance.now();
    tPushToRender += lastRenderStart - lastPushAt;
    lastPushAt = 0;
  }
  const t = performance.now();
  const p = realRender(job);
  return p.then(
    (v) => {
      tRender += performance.now() - t;
      return v;
    },
    (e) => {
      tRender += performance.now() - t;
      throw e;
    }
  );
};
const realInject = app.sanitizer.inject.bind(app.sanitizer);
app.sanitizer.inject = function (container, svg, id) {
  const t = performance.now();
  try {
    return realInject(container, svg, id);
  } finally {
    tInject += performance.now() - t;
  }
};

async function pass(label, extraLine) {
  tCacheGet = 0;
  tPush = 0;
  tRender = 0;
  tInject = 0;
  tPushToRender = 0;
  lastPushAt = 0;

  const longTasks = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push(Math.round(entry.duration));
  });
  observer.observe({ entryTypes: ['longtask'] });

  const flow = document.getElementById('flow');
  flow.innerHTML = '';
  await new Promise((r) => setTimeout(r, 120));

  const source = base.concat(extraLine ? [extraLine] : []).join('\n');
  const t0 = performance.now();
  const block = window.__addFence(source, 'mermaid');
  await window.__waitFor(() => {
    const card = block.previousElementSibling;
    return card && card.getAttribute('data-mms-state') === 'ready';
  }, 30000);
  const readyMs = performance.now() - t0;
  await new Promise((r) => setTimeout(r, 350));
  observer.disconnect();

  const card = block.previousElementSibling;
  const svg = card.querySelector('.mms-stage svg');
  out.passes.push({
    label: label,
    totalToReadyMs: Math.round(readyMs),
    debounceAndCacheMs: Math.round(readyMs - tPushToRender - tRender - tInject - 5),
    cacheGetMs: Math.round(tCacheGet),
    queueStartMs: Math.round(tPushToRender),
    renderMs: Math.round(tRender),
    injectMs: Math.round(tInject),
    longTasks: longTasks,
    nodes: svg ? svg.getElementsByTagName('*').length : 0,
    labels: svg ? svg.getElementsByTagName('foreignObject').length : 0
  });
}

await pass('cold-first-card', '  M1 -->|"probe"| F2');
await pass('second-card-different-key', '  M1 -->|"probe2"| E1');
return out;
