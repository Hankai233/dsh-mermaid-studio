// Probe: is the first-render cost in mermaid, in the foreignObject labels, or in
// our injection? Compare htmlLabels on/off through the same render path.
const source = [
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
  '    D1[("MySQL<br/>file_upload / document_vectors<br/>file_processing_outbox")]',
  '    R1[("Redis<br/>分片 bitmap · 发布订阅")]',
  '    Q1[["Kafka<br/>file-processing-topic1 + dlt"]]',
  '    E1[("Elasticsearch<br/>别名 knowledge_base")]',
  '    X1["Embedding API<br/>text-embedding-v4 · 2048"]',
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
  '  V1 --> X1',
  '  K2 -->|"complete 后"| N1',
  '  R1 -->|"document_status"| F2'
].join('\n');

const app = window.__mmsDebug.app;
const out = {};

async function measure(htmlLabels, fontFamily) {
  const engine = window.__mmsFreshMermaid();
  const id = 'mms-bench-' + (htmlLabels ? 'html' : 'text') + '-' + Math.random().toString(36).slice(2, 6);
  const t0 = performance.now();
  engine.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    maxTextSize: 50000,
    maxEdges: 2000,
    htmlLabels: htmlLabels,
    theme: 'default',
    fontFamily: fontFamily
  });
  const result = await engine.render(id, source);
  const renderMs = performance.now() - t0;

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:520px;overflow:hidden;';
  document.body.appendChild(host);

  const t1 = performance.now();
  const injected = app.sanitizer.inject(host, result.svg, id);
  const sanitizeInjectMs = performance.now() - t1;

  // first layout of the injected tree (what the browser pays on insertion)
  const t2 = performance.now();
  const firstLayout = host.getBoundingClientRect().height;
  const layoutMs = performance.now() - t2;

  // force a paint and time the frame that follows
  const t3 = performance.now();
  await new Promise((r) => requestAnimationFrame(r));
  const paintMs = performance.now() - t3;

  const svg = injected && injected.svg;
  const stats = {
    htmlLabels: htmlLabels,
    renderMs: Math.round(renderMs),
    sanitizeInjectMs: Math.round(sanitizeInjectMs),
    layoutMs: Math.round(layoutMs),
    paintMs: Math.round(paintMs),
    totalMs: Math.round(renderMs + sanitizeInjectMs + layoutMs + paintMs),
    foreignObjects: svg ? svg.getElementsByTagName('foreignObject').length : 0,
    textNodes: svg ? svg.getElementsByTagName('text').length : 0,
    height: Math.round(firstLayout)
  };
  host.remove();
  return stats;
}

// warm the module once so we measure steady-state, not first import
await measure(true, 'ui-monospace, monospace');

out.htmlLabels = await measure(true, 'ui-monospace, monospace');
out.svgText = await measure(false, 'ui-monospace, monospace');
// same comparison with the chat's code font, which is what the plugin actually passes
const codeFont = (function () {
  try {
    return getComputedStyle(document.querySelector('.md-code-block code') || document.body).fontFamily;
  } catch (error) {
    return 'ui-monospace, monospace';
  }
})();
out.codeFontName = codeFont;
out.htmlLabelsWithCodeFont = await measure(true, codeFont);
out.svgTextWithCodeFont = await measure(false, codeFont);
return out;
