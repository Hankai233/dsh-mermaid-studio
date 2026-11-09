// Probe: the exact diagram from the user's report, through the real card path.
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

document.getElementById('flow').innerHTML = '';
await new Promise((r) => setTimeout(r, 150));
const block = window.__addFence(source, 'mermaid');
block.scrollIntoView();
await window.__waitFor(() => {
  const card = block.previousElementSibling;
  return card && card.getAttribute('data-mms-state') !== 'pending';
}, 30000);
const card = block.previousElementSibling;
const svg = card.querySelector('.mms-stage svg');
const stats = window.__stats();
return {
  state: card.getAttribute('data-mms-state'),
  errorHead: card.querySelector('.mms-error-head') ? card.querySelector('.mms-error-head').textContent : null,
  errorDetail: card.querySelector('.mms-error-detail') ? card.querySelector('.mms-error-detail').textContent.slice(0, 160) : null,
  hasSvg: !!svg,
  viewBox: svg ? svg.getAttribute('viewBox') : null,
  widthAttr: svg ? svg.getAttribute('width') : null,
  heightAttr: svg ? svg.getAttribute('height') : null,
  transform: card.querySelector('.mms-stage') ? card.querySelector('.mms-stage').style.transform : null,
  markerWidthAttr: (function(){ var m = svg && svg.querySelector('marker'); return m ? m.getAttribute('markerWidth') : 'none'; })(),
  svgNodes: svg ? svg.getElementsByTagName('*').length : 0,
  foreignObjects: svg ? svg.getElementsByTagName('foreignObject').length : 0,
  labels: svg ? Array.from(svg.querySelectorAll('foreignObject p')).slice(0, 3).map((p) => p.textContent) : [],
  sanitizeLenientParse: stats.sanitizeLenientParse,
  sanitizeParseFail: stats.sanitizeParseFail,
  sanitizeRejected: stats.sanitizeRejected,
  line: stats.line()
};
