// Probe: does the sanitized diagram style its labels the same as mermaid's raw
// output? "Some characters do not display" is either a styling difference or a
// font difference, so compare the computed styles of the label elements.
const source = [
  'flowchart LR',
  '  subgraph FE["浏览器 · 前端"]',
  '    F1["knowledge-base store<br/>5MB 分片 × 4 并发"]',
  '    F2["knowledge-base 列表页<br/>WS 事件 + 兜底轮询"]',
  '  end',
  '  subgraph API["Spring Boot :8081"]',
  '    C1["UploadController<br/>/api/v1/upload/*"]',
  '    K2["FileProcessingConsumer<br/>@KafkaListener"]',
  '  end',
  '  F1 -->|"POST /upload/chunk"| C1',
  '  C1 --> K2',
  '  K2 --> F2'
].join('\n');

const app = window.__mmsDebug.app;
const out = {};

const raw = await app.renderer.render({
  uid: 'style-raw',
  key: 'style-raw',
  source: source,
  theme: 'default',
  renderId: 'mms-style-raw-1',
  fontFamily: 'ui-monospace, monospace',
  htmlLabels: true
});

const host = document.createElement('div');
host.style.cssText = 'position:fixed;left:-99999px;top:0;width:1200px;height:800px;';
document.body.appendChild(host);

// raw (lenient parse, unfiltered)
const t1 = document.createElement('template');
t1.innerHTML = raw.svg;
const rawSvg = t1.content.querySelector('svg');
host.appendChild(rawSvg);

// sanitized
const sanitized = app.sanitizer.sanitize(raw.svg, 'mms-style-raw-1');
const cleanSvg = document.importNode(sanitized.root, true);
host.appendChild(cleanSvg);

await new Promise((r) => requestAnimationFrame(r));

function sampleLabels(root, label) {
  const out = [];
  const nodes = root.querySelectorAll('foreignObject span.nodeLabel, foreignObject p, foreignObject div, text');
  for (let i = 0; i < Math.min(nodes.length, 6); i += 1) {
    const el = nodes[i];
    const cs = getComputedStyle(el);
    out.push({
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').slice(0, 18),
      color: cs.color,
      fontFamily: cs.fontFamily.slice(0, 60),
      fontSize: cs.fontSize,
      display: cs.display,
      visibility: cs.visibility,
      opacity: cs.opacity,
      whiteSpace: cs.whiteSpace,
      overflow: cs.overflow,
      rect: (function () { const r = el.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); })()
    });
  }
  return out;
}

out.raw = sampleLabels(rawSvg, 'raw');
out.clean = sampleLabels(cleanSvg, 'clean');

// geometry: the real question for "some characters do not display" is whether
// the label boxes land in the same place with the same size after filtering.
function labelBoxes(root) {
  const base = root.getBoundingClientRect();
  const nodes = Array.from(root.querySelectorAll('foreignObject p'));
  return nodes.slice(0, 10).map((el) => {
    const r = el.getBoundingClientRect();
    return { text: (el.textContent || '').slice(0, 16), x: Math.round(r.x - base.x), y: Math.round(r.y - base.y), w: Math.round(r.width), h: Math.round(r.height) };
  });
}
const rawBoxes = labelBoxes(rawSvg);
const cleanBoxes = labelBoxes(cleanSvg);
let maxDelta = 0;
for (let i = 0; i < Math.min(rawBoxes.length, cleanBoxes.length); i += 1) {
  const a = rawBoxes[i];
  const b = cleanBoxes[i];
  maxDelta = Math.max(maxDelta, Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h));
}
out.geometry = { rawCount: rawBoxes.length, cleanCount: cleanBoxes.length, maxDeltaPx: maxDelta, sample: { raw: rawBoxes.slice(0, 2), clean: cleanBoxes.slice(0, 2) } };

// stylesheet rule survival
const rawStyle = rawSvg.querySelector('style');
const cleanStyle = cleanSvg.querySelector('style');
out.style = {
  rawRules: rawStyle ? rawStyle.sheet.cssRules.length : 0,
  cleanRules: cleanStyle ? cleanStyle.sheet.cssRules.length : 0,
  rawFirst: rawStyle ? Array.from(rawStyle.sheet.cssRules).slice(0, 3).map((r) => r.cssText.slice(0, 70)) : [],
  cleanFirst: cleanStyle ? Array.from(cleanStyle.sheet.cssRules).slice(0, 3).map((r) => r.cssText.slice(0, 70)) : []
};

// which declarations does the sanitizer still remove from the sheet?
const rawRuleText = rawStyle ? rawStyle.textContent : '';
const cleanRuleText = cleanStyle ? cleanStyle.textContent : '';
const props = (text) => {
  const set = new Set();
  for (const match of text.matchAll(/([a-z-]+)\s*:/g)) set.add(match[1]);
  return set;
};
const rawProps = props(rawRuleText);
const cleanProps = props(cleanRuleText);
out.removedProperties = Array.from(rawProps).filter((p) => !cleanProps.has(p)).slice(0, 30);

host.remove();
return out;
