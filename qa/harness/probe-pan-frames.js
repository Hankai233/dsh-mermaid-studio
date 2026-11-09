// Probe: frame pacing while panning at max zoom on the full diagram, and how
// long a PNG export blocks the main thread.
const source = [
  'flowchart LR',
  '  subgraph FE["浏览器 · 前端"]',
  '    F1["knowledge-base store<br/>5MB 分片 × 4 并发"]',
  '    F2["knowledge-base 列表页<br/>WS 事件 + 兜底轮询"]',
  '  end',
  '',
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
  '',
  '  subgraph INFRA["基础设施"]',
  '    M1[("MinIO<br/>chunks/ · merged/")]',
  '    D1[("MySQL<br/>file_upload / document_vectors<br/>file_processing_outbox")]',
  '    R1[("Redis<br/>分片 bitmap · 发布订阅")]',
  '    Q1[["Kafka<br/>file-processing-topic1 + dlt"]]',
  '    E1[("Elasticsearch<br/>别名 knowledge_base")]',
  '    X1["Embedding API<br/>text-embedding-v4 · 2048"]',
  '  end',
  '',
  '  F1 -->|"POST /upload/chunk"| C1',
  '  C1 --> S1',
  '  S1 -->|"putObject"| M1',
  '  S1 -->|"setBit 进度"| R1',
  '  S1 -->|"ChunkInfo / file_upload"| D1',
  '  F1 -->|"POST /upload/merge"| C1',
  '  C1 --> S1',
  '  S1 -->|"composeObject"| M1',
  '  S1 -->|"completeMerge"| D1',
  '  C1 -->|"enqueueVectorization(同事务)"| S2',
  '  S2 --> D1',
  '  S2 -->|"afterCommit + 定时补发"| K1',
  '  K1 --> Q1',
  '  Q1 --> K2',
  '  K2 --> L1',
  '  K2 -->|"清旧索引 + 解析"| P1',
  '  P1 --> D1',
  '  K2 --> V1',
  '  V1 --> X1',
  '  V1 -->|"bulkIndex 写别名"| E1',
  '  K2 -->|"complete 后"| N1',
  '  N1 --> R1',
  '  R1 -->|"document_status"| F2'
].join('\n');

const app = window.__mmsDebug.app;
const out = {};

// The user's profile runs a "frosted glass" theme; an ancestor with
// backdrop-filter re-samples the backdrop whenever a descendant transform
// changes, which is a known drag-lag multiplier. Simulate it here.
const HOST_HAS_BACKDROP = window.__probeBackdrop === true;
const VARIANT = window.__probeVariant || 'baseline';
const styleTag = document.createElement('style');
if (VARIANT === 'opaque') {
  styleTag.textContent = '.mms-vp{background:#ffffff !important;isolation:isolate}';
}
if (VARIANT === 'snapshot') {
  styleTag.textContent = '.mms-stage{contain:paint}';
}
if (styleTag.textContent) document.head.appendChild(styleTag);
if (HOST_HAS_BACKDROP) {
  const chat = document.getElementById('chat');
  chat.style.backdropFilter = 'blur(14px)';
  chat.style.webkitBackdropFilter = 'blur(14px)';
  chat.style.background = 'rgba(255,255,255,0.35)';
}

const blocks = await window.__reset([{ source: source, lang: 'mermaid' }]);
const card = blocks[0].previousElementSibling;
const vp = card.querySelector('.mms-vp');
const stage = card.querySelector('.mms-stage');
const svg = stage.firstElementChild;
out.diagram = {
  state: card.getAttribute('data-mms-state'),
  viewBox: svg.getAttribute('viewBox'),
  foreignObjects: svg.getElementsByTagName('foreignObject').length,
  nodes: svg.getElementsByTagName('*').length
};

// Zoom to the ceiling with real wheel events.
const rect = vp.getBoundingClientRect();
for (let i = 0; i < 40; i += 1) {
  vp.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, ctrlKey: true, clientX: rect.left + 200, clientY: rect.top + 150, bubbles: true, cancelable: true }));
}
const parseTransform = () => {
  const m = /translate(?:3d)?\(([-\d.]+)px,\s*([-\d.]+)px(?:,\s*0px)?\)\s*scale\(([\d.]+)\)/.exec(stage.style.transform);
  return m ? { x: +m[1], y: +m[2], s: +m[3] } : null;
};
const atMax = parseTransform();
out.zoom = {
  scale: atMax ? +atMax.s.toFixed(3) : null,
  ceilingHint: Math.round((8192 / 3693) * 100) / 100,
  stagePx: atMax ? Math.round(3693 * atMax.s) : null
};

// Frame pacing while panning: drive a rAF loop that moves the stage every frame.
const deltas = [];
let last = performance.now();
let frame = 0;
await new Promise((resolve) => {
  const start = performance.now();
  function step(now) {
    deltas.push(now - last);
    last = now;
    frame += 1;
    vp.dispatchEvent(new PointerEvent('pointermove', { pointerId: 3, clientX: rect.left + 200 + Math.sin(frame / 4) * 120, clientY: rect.top + 150 + Math.cos(frame / 4) * 80, bubbles: true }));
    if (now - start < 1500) requestAnimationFrame(step);
    else resolve();
  }
  vp.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 3, clientX: rect.left + 200, clientY: rect.top + 150, bubbles: true }));
  requestAnimationFrame(step);
});
vp.dispatchEvent(new PointerEvent('pointerup', { pointerId: 3, clientX: rect.left + 200, clientY: rect.top + 150, bubbles: true }));
deltas.shift();
deltas.sort((a, b) => a - b);
const pick = (q) => Math.round(deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * q))] * 10) / 10;
// style-write coalescing: N synchronous moves must not produce N writes
let writes = 0;
const stageObserver = new MutationObserver((records) => {
  for (const record of records) if (record.attributeName === 'style') writes += 1;
});
stageObserver.observe(stage, { attributes: true, attributeFilter: ['style'] });
vp.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 9, clientX: rect.left + 150, clientY: rect.top + 100, bubbles: true }));
for (let i = 0; i < 20; i += 1) {
  vp.dispatchEvent(new PointerEvent('pointermove', { pointerId: 9, clientX: rect.left + 150 + i * 2, clientY: rect.top + 100 + i, bubbles: true }));
}
await new Promise((r) => setTimeout(r, 120));
vp.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, clientX: rect.left + 190, clientY: rect.top + 120, bubbles: true }));
await new Promise((r) => setTimeout(r, 60));
stageObserver.disconnect();
out.styleWritesPer20Moves = writes;

out.panFrames = {
  frames: deltas.length,
  p50: pick(0.5),
  p95: pick(0.95),
  max: Math.round(deltas[deltas.length - 1] * 10) / 10,
  over33ms: deltas.filter((d) => d > 33).length
};

// SVG export timing: serialize the injected, already-sanitized node.
const exportStart = performance.now();
const exporter = window.__MMS__.createExporter({});
const svgText = exporter.serializeSvg(svg);
const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
const afterExport = performance.now();
out.export = {
  svgMs: Math.round(afterExport - exportStart),
  bytes: blob.size,
  hasForeignObject: svgText.indexOf('foreignObject') >= 0,
  width: /\swidth="([^"]+)"/.exec(svgText.slice(0, 400)) ? /\swidth="([^"]+)"/.exec(svgText.slice(0, 400))[1] : null,
  height: /\sheight="([^"]+)"/.exec(svgText.slice(0, 400)) ? /\sheight="([^"]+)"/.exec(svgText.slice(0, 400))[1] : null
};

return out;
