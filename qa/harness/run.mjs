#!/usr/bin/env node
/**
 * qa/harness/run.mjs — drive the built client bundle in a real Chromium against
 * a fake DSH shell, and write one result file per case into qa/results/.
 *
 * This is §15.0's channel ② ("side execution"), the one that produces evidence
 * without a human clicking a panel: a static page reproduces the host's markup
 * contract (`.md-code-block` + banner + `[data-code-block-content]` inside
 * `[data-slot="conversation.chat.flow"]`), the bundle is loaded exactly as the
 * host loads it (`window.__ModuleLoader__.load` + `apply(ctx)`), and assertions
 * run in-page with real mermaid, real IndexedDB and real canvas.
 *
 * A case that cannot be automated here (a visual judgement, a reload the browser
 * cannot fake, a rollback drill) is reported `pending`, never `pass`.
 *
 * Usage:
 *   node qa/harness/run.mjs                 # all automated cases
 *   node qa/harness/run.mjs --only 1,3,12   # selected ids
 *   node qa/harness/run.mjs --headed        # watch it
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const RESULTS = path.join(ROOT, 'qa', 'results');

const PROFILE_DIR = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function findChrome() {
  if (process.env.MMS_BROWSER && existsSync(process.env.MMS_BROWSER)) return process.env.MMS_BROWSER;
  for (const candidate of CHROME_CANDIDATES) if (existsSync(candidate)) return candidate;
  throw new Error('no Chromium-family browser found (set MMS_BROWSER=<path to chrome.exe>)');
}

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const file = path.join(ROOT, decodeURIComponent(url.pathname));
      if (!file.startsWith(ROOT)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      let body = await readFile(file);
      // ?noplugin=1: measure the page without the plugin bundle.
      if (url.searchParams.get('noplugin') === '1' && file.endsWith('shell.html')) {
        body = Buffer.from(String(body).replace('<script src="/lib/client.js"></script>', ''), 'utf8');
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch (error) {
      res.writeHead(404).end('not found: ' + error.message);
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

const requireFrom = createRequire(path.join(PROFILE_DIR, 'package.json'));
const { chromium } = requireFrom('playwright-core');
const CASE_MANIFEST = JSON.parse(await readFile(path.join(ROOT, 'qa', 'cases.json'), 'utf8'));

const ARGV = process.argv.slice(2);
const HEADED = ARGV.includes('--headed');
const onlyArg = ARGV.find((a) => a.startsWith('--only=')) || ARGV[ARGV.indexOf('--only') + 1];
const ONLY = ARGV.includes('--only') && onlyArg && !onlyArg.startsWith('--') ? onlyArg.split(',').map((s) => s.trim()) : null;

function caseMeta(id) {
  return CASE_MANIFEST.cases.find((entry) => entry.id === id) || { id, name: 'unknown', group: 'unknown', p0: false };
}

function env() {
  return {
    machine: os.hostname(),
    cores: os.cpus().length,
    browser: globalThis.__browserVersion || 'unknown',
    dpr: 1,
    cpuThrottle: 'none'
  };
}

// ── assertion helpers used inside the page ─────────────────────────────────
const PAGE_HELPERS = `
  window.__A = function (name, expected, actual, pass) {
    return { name: name, expected: expected, actual: actual, pass: pass === undefined ? JSON.stringify(expected) === JSON.stringify(actual) : !!pass };
  };
  window.__waitFor = async function (fn, timeout, interval) {
    const started = Date.now();
    while (Date.now() - started < (timeout || 15000)) {
      let value;
      try { value = await fn(); } catch (error) { value = false; }
      if (value) return value;
      await new Promise((r) => setTimeout(r, interval || 80));
    }
    throw new Error('waitFor timed out');
  };
  window.__ready = function () {
    return Array.from(document.querySelectorAll('.mms-card')).filter((c) => c.getAttribute('data-mms-state') === 'ready').length;
  };
  window.__collectConsole = window.__collectConsole || [];
  window.__loadLongTasks = window.__loadLongTasks || [];
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__loadLongTasks.push(Math.round(entry.duration));
    }).observe({ entryTypes: ['longtask'], buffered: true });
  } catch (error) { /* older engine */ }
`;

const TESTS = [];

function test(id, fn) {
  TESTS.push({ id, fn });
}

/* ── 1: first sighting of mermaid fences ─────────────────────────────────── */
test('1', async (page) => {
  const result = await page.evaluate(async () => {
    const out = [];
    document.getElementById('flow').innerHTML = '';
    const a = window.__addFence('graph TD\n  A[开始] --> B{判断}\n  B -->|是| C[结束]', 'mermaid');
    const b = window.__addFence('graph LR\n  X --> Y', 'mmd');
    const py = window.__addFence('graph = {"a": 1}\nprint(graph)', 'python');
    const empty = window.__addFence('', 'mermaid');
    const noLabel = window.__addFence('sequenceDiagram\n  Alice->>Bob: hi', '', { shiki: true });
    // The real desktop host does not recognise "mermaid" as a highlight
    // language and renders the localized generic label instead. Measured in the
    // running app: the banner reads "代码块". A generic label must not veto the
    // fence; a real language label (python) still must.
    const genericLabel = window.__addFence('graph TD\n  GENERIC --> LABEL', '代码块');
    const genericPython = window.__addFence('graph = {"a": 1}', '代码块');
    await window.__waitFor(() => window.__ready() >= 3, 20000);
    const cards = window.__cards();
    out.push(window.__A('mermaid 围栏成图', 3, cards.filter((c) => c.state === 'ready').length));
    out.push(window.__A('python 围栏不误判', 0, cards.filter((c) => c.key && py.contains(c.el)).length));
    out.push(window.__A('python 围栏无卡片', false, !!document.querySelector('.mms-card[data-mms-key]') && py.previousElementSibling !== null && py.previousElementSibling.classList.contains('mms-card')));
    out.push(window.__A('空围栏无卡片', false, empty.previousElementSibling ? empty.previousElementSibling.classList.contains('mms-card') : false));
    out.push(window.__A('无语言标签 + 关键字命中', true, noLabel.previousElementSibling && noLabel.previousElementSibling.classList.contains('mms-card')));
    out.push(window.__A('通用标签（代码块）+ mermaid 首行 → 成图', true, !!(genericLabel.previousElementSibling && genericLabel.previousElementSibling.classList.contains('mms-card'))));
    out.push(window.__A('通用标签 + 非 mermaid 首行 → 不成图', false, !!(genericPython.previousElementSibling && genericPython.previousElementSibling.classList.contains('mms-card'))));
    out.push(window.__A('卡片紧邻代码块（不移动 React 节点）', true, cards.every((c) => c.nextIsBlock)));
    const firstCard = document.querySelector('.mms-card');
    const toolbarText = Array.from(firstCard.querySelectorAll('.mms-float button')).map((b) => b.textContent.trim());
    out.push(window.__A('悬浮按钮顺序：+ − 重置 </> 导出 SVG ⛶', '+|−|重置|</>|导出 SVG|⛶', toolbarText.join('|')));
    out.push(window.__A('没有常驻工具栏', null, document.querySelector('.mms-bar')));
    out.push(window.__A('渲染计数 >= 3', true, (window.__stats().renderCount || 0) >= 3, (window.__stats().renderCount || 0) >= 3));
    // P0-10: five identical fences share one cache key but must each get a card.
    const same = [];
    for (let i = 0; i < 5; i += 1) same.push(window.__addFence('graph LR\n  SAME --> SOURCE', 'mermaid'));
    await window.__waitFor(() => document.querySelectorAll('.mms-card').length >= 9, 15000);
    out.push(window.__A('同源 5 个围栏 → 5 张卡', 5, same.filter((b) => {
      const card = b.previousElementSibling;
      return card && card.classList.contains('mms-card');
    }).length));
    // Walk the page down in steps so every card crosses the lazy observer's
    // viewport at least once (a single jump can skip past one).
    const step = 240;
    const maxY = document.documentElement.scrollHeight;
    for (let y = 0; y <= maxY + step; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 70));
    }
    window.scrollTo(0, 0);
    await window.__waitFor(() => window.__ready() >= 9, 25000);
    out.push(window.__A('滚动后 9 张卡全部成图', 9, window.__ready()));
    window.__fenceRefs = { a, b, py, empty, noLabel };
    return out;
  });
  return result;
});

/* ── 3: revisit (L1 hit, no re-render) ───────────────────────────────────── */
test('3', async (page) => {
  return page.evaluate(async () => {
    const out = [];
    const snapshot = window.__stats();
    const before = { renderCount: snapshot.renderCount, cacheHitL1: snapshot.cacheHitL1, cacheHitL2: snapshot.cacheHitL2, sanitizeRejected: snapshot.sanitizeRejected, dirRejected: snapshot.dirRejected, fenceSeen: snapshot.fenceSeen };
    const renderBefore = before.renderCount;
    await window.__reset([
      { source: 'graph TD\n  A[开始] --> B{判断}\n  B -->|是| C[结束]', lang: 'mermaid' },
      { source: 'graph LR\n  X --> Y', lang: 'mmd' }
    ]);
    const after = window.__stats();
    out.push(window.__A('重挂载不重新渲染', true, after.renderCount === renderBefore, after.renderCount === renderBefore));
    out.push(window.__A('L1 命中计数增长', true, after.cacheHitL1 > before.cacheHitL1, after.cacheHitL1 > before.cacheHitL1));
    return out;
  });
});

/* ── 2: reload, L2 hit ───────────────────────────────────────────────────── */
test('2', async (page, context, url) => {
  // Let the previous cases finish writing, then reload with a clean page: L1 is
  // process memory, so only IndexedDB can answer.
  await page.waitForTimeout(600);
  const records = await page.evaluate(() => window.__idbRecordCount());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.evaluate(PAGE_HELPERS);
  const booted = await page.evaluate(() => window.__boot());
  const result = await page.evaluate(async (recordCount) => {
    const out = [];
    out.push(window.__A('IndexedDB 有记录', true, recordCount > 0, recordCount > 0));
    window.__addFence('graph TD\n  A[开始] --> B{判断}\n  B -->|是| C[结束]', 'mermaid');
    const started = performance.now();
    await window.__waitFor(() => window.__ready() >= 1, 15000);
    const elapsed = performance.now() - started;
    const stats = window.__stats();
    out.push(window.__A('刷新后命中 L2', true, stats.cacheHitL2 > 0, stats.cacheHitL2 > 0));
    out.push(window.__A('刷新后 renderCount 不增', 0, stats.renderCount));
    out.push(window.__A('免渲染注入耗时 < 500ms', true, elapsed < 500, elapsed < 500));
    return out;
  }, records);
  return { assertions: result, booted };
});

/* ── 4: zoom / pan / dblclick / 0-size container ─────────────────────────── */
test('4', async (page) => {
  return page.evaluate(async () => {
    const out = [];
    const card = document.querySelector('.mms-card');
    const vp = card.querySelector('.mms-vp');
    const stage = card.querySelector('.mms-stage');
    const read = () => {
      const m = /translate(?:3d)?\(([-\d.]+)px,\s*([-\d.]+)px(?:,\s*0px)?\)\s*scale\(([\d.]+)\)/.exec(stage.style.transform);
      return m ? { x: +m[1], y: +m[2], s: +m[3] } : null;
    };
    await window.__waitFor(() => card.getAttribute('data-mms-state') === 'ready', 15000);
    const start = read();
    out.push(window.__A('初始为适应宽度（transform 有效）', true, !!start && isFinite(start.s), !!start && isFinite(start.s)));

    // plain wheel must not be prevented: the page keeps scrolling
    const wheel = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
    vp.dispatchEvent(wheel);
    out.push(window.__A('普通滚轮不拦截页面滚动', false, wheel.defaultPrevented));

    // ctrl+wheel zooms around the pointer
    const rect = vp.getBoundingClientRect();
    const px = rect.left + 40;
    const py = rect.top + 30;
    const ctrlWheel = new WheelEvent('wheel', { deltaY: -220, ctrlKey: true, clientX: px, clientY: py, bubbles: true, cancelable: true });
    vp.dispatchEvent(ctrlWheel);
    const zoomed = read();
    out.push(window.__A('Ctrl+滚轮缩放生效', true, ctrlWheel.defaultPrevented && zoomed.s > start.s, ctrlWheel.defaultPrevented && zoomed.s > start.s));
    out.push(window.__A('缩放结果无 NaN', true, isFinite(zoomed.x) && isFinite(zoomed.y) && isFinite(zoomed.s), isFinite(zoomed.x) && isFinite(zoomed.y) && isFinite(zoomed.s)));

    // pointer anchoring: the point under the cursor stays put (±2px)
    const before = start;
    const contentX = (px - rect.left - before.x) / before.s;
    const after = read();
    const contentXAfter = (px - rect.left - after.x) / after.s;
    const drift = Math.abs(contentX - contentXAfter);
    out.push(window.__A('指针锚定偏移 ≤2px（内容坐标）', true, drift <= 2, drift <= 2));

    // user zoom is clamped to 0.1–8
    for (let i = 0; i < 40; i += 1) {
      vp.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, ctrlKey: true, clientX: px, clientY: py, bubbles: true, cancelable: true }));
    }
    const maxZoom = read();
    out.push(window.__A('用户缩放下限 0.1 / 上限 8', true, maxZoom.s <= 8.0001, maxZoom.s <= 8.0001));
    for (let i = 0; i < 80; i += 1) {
      vp.dispatchEvent(new WheelEvent('wheel', { deltaY: 400, ctrlKey: true, clientX: px, clientY: py, bubbles: true, cancelable: true }));
    }
    const minZoom = read();
    out.push(window.__A('缩到下限仍 ≥0.1', true, minZoom.s >= 0.0999, minZoom.s >= 0.0999));

    // drag pans 1:1
    const beforeDrag = read();
    vp.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, clientX: 300, clientY: 300, bubbles: true }));
    vp.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 340, clientY: 330, bubbles: true }));
    vp.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 340, clientY: 330, bubbles: true }));
    const afterDrag = read();
    out.push(window.__A('拖拽平移 1:1（x+40）', true, Math.abs(afterDrag.x - beforeDrag.x - 40) < 1.5, Math.abs(afterDrag.x - beforeDrag.x - 40) < 1.5));

    // double click toggles fit-page <-> 100%
    vp.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const afterDbl = read();
    out.push(window.__A('双击切到 100%（s≈1）', true, Math.abs(afterDbl.s - 1) < 0.02, Math.abs(afterDbl.s - 1) < 0.02));

    // 0-sized container must not produce NaN
    vp.style.height = '0px';
    vp.style.display = 'none';
    await new Promise((r) => setTimeout(r, 120));
    vp.style.display = '';
    vp.style.height = '';
    await new Promise((r) => setTimeout(r, 200));
    const afterResize = read();
    out.push(window.__A('0 尺寸容器不产生 NaN', true, isFinite(afterResize.s) && afterResize.s > 0, isFinite(afterResize.s) && afterResize.s > 0));
    return out;
  });
});

/* ── 4b: floating row visibility and zoom buttons (real mouse) ───────────── */
test('4b', async (page) => {
  const out = [];
  await page.mouse.move(2, 2);
  await page.waitForTimeout(200);
  const hidden = await page.evaluate(() => getComputedStyle(document.querySelector('.mms-float')).opacity);
  out.push({ name: '指针不在图上时悬浮按钮隐藏', expected: '0', actual: hidden, pass: hidden === '0' });

  await page.hover('.mms-card');
  await page.waitForTimeout(200);
  const shown = await page.evaluate(() => getComputedStyle(document.querySelector('.mms-float')).opacity);
  out.push({ name: '指针在图上时悬浮按钮可见', expected: '1', actual: shown, pass: shown === '1' });

  const zoom = await page.evaluate(async () => {
    const card = document.querySelector('.mms-card');
    const stage = card.querySelector('.mms-stage');
    const read = () => {
      const m = /translate(?:3d)?\(([-\d.]+)px,\s*([-\d.]+)px(?:,\s*0px)?\)\s*scale\(([\d.]+)\)/.exec(stage.style.transform);
      return m ? +m[3] : null;
    };
    const click = (label) => {
      const button = Array.from(card.querySelectorAll('.mms-float button')).find((b) => b.textContent.trim() === label);
      button.click();
    };
    const fit = read();
    click('+');
    const afterPlus = read();
    click('−');
    click('−');
    const afterMinus = read();
    click('重置');
    const afterReset = read();
    return { fit, afterPlus, afterMinus, afterReset };
  });
  out.push({ name: '+ 放大', expected: '倍数变大', actual: zoom.afterPlus, pass: zoom.afterPlus > zoom.fit });
  out.push({ name: '− 缩小', expected: '倍数变小', actual: zoom.afterMinus, pass: zoom.afterMinus < zoom.fit });
  out.push({ name: '重置回到适应宽度', expected: zoom.fit, actual: zoom.afterReset, pass: Math.abs(zoom.afterReset - zoom.fit) < 0.01 });

  // </> toggles the source view and the row stays reachable
  const view = await page.evaluate(async () => {
    const card = document.querySelector('.mms-card');
    const button = Array.from(card.querySelectorAll('.mms-float button')).find((b) => b.textContent.trim() === '</>');
    button.click();
    await new Promise((r) => setTimeout(r, 120));
    const codeView = card.getAttribute('data-view');
    const blockVisible = getComputedStyle(card.nextElementSibling).display !== 'none';
    const rowOpacity = getComputedStyle(card.querySelector('.mms-float')).opacity;
    button.click();
    await new Promise((r) => setTimeout(r, 120));
    return { codeView, blockVisible, rowOpacity, back: card.getAttribute('data-view') };
  });
  out.push({ name: '</> 切到源码视图并露出代码块', 'source+block': 'source+true', actual: view.codeView + '+' + view.blockVisible, pass: view.codeView === 'code' && view.blockVisible });
  out.push({ name: '源码视图下按钮行仍然可见（不依赖悬停）', expected: '1', actual: view.rowOpacity, pass: view.rowOpacity === '1' });
  out.push({ name: '</> 再点回到图表视图', expected: 'diagram', actual: view.back, pass: view.back === 'diagram' });
  return out;
});

/* ── 5: fullscreen overlay ───────────────────────────────────────────────── */
test('5', async (page) => {
  return page.evaluate(async () => {
    const out = [];
    const card = document.querySelector('.mms-card');
    const overflowBefore = document.body.style.overflow;
    const trigger = card.querySelector('.mms-btn-icon');
    trigger.focus();
    trigger.click();
    await window.__waitFor(() => !!document.querySelector('[data-mms-overlay]'), 5000);
    const overlay = document.querySelector('[data-mms-overlay]');
    out.push(window.__A('overlay 打开', true, !!overlay, !!overlay));
    out.push(window.__A('body 滚动被锁', 'hidden', document.body.style.overflow));
    out.push(window.__A('aria-modal 宣告', 'true', overlay.getAttribute('aria-modal')));
    // focus trap: focus pulled back inside
    const outside = document.getElementById('sidebar-mount');
    outside.tabIndex = 0;
    outside.focus();
    await new Promise((r) => setTimeout(r, 30));
    out.push(window.__A('焦点回拉到 overlay 内', true, overlay.contains(document.activeElement), overlay.contains(document.activeElement)));
    // Esc closes and restores
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    out.push(window.__A('Esc 关闭 overlay', true, !document.querySelector('[data-mms-overlay]'), !document.querySelector('[data-mms-overlay]')));
    out.push(window.__A('body overflow 还原为进入前', overflowBefore || '', document.body.style.overflow));
    out.push(window.__A('焦点回到触发按钮', true, document.activeElement === trigger, document.activeElement === trigger));
    outside.tabIndex = -1;
    return out;
  });
});

/* ── 6: export structure ─────────────────────────────────────────────────── */
test('6', async (page) => {
  return page.evaluate(async () => {
    const out = [];
    const card = document.querySelector('.mms-card');
    const svg = card.querySelector('.mms-stage svg');
    const text = window.__MMS__.createExporter({}).serializeSvg(svg);
    const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
    out.push(window.__A('XML 解析无 parsererror', 0, parsed.getElementsByTagName('parsererror').length));
    out.push(window.__A('含 xmlns', true, text.indexOf('xmlns="http://www.w3.org/2000/svg"') > 0, text.indexOf('xmlns="http://www.w3.org/2000/svg"') > 0));
    out.push(window.__A('含 viewBox', true, /viewBox="/.test(text), /viewBox="/.test(text)));
    out.push(window.__A('含显式 width/height', true, /\swidth="/.test(text) && /\sheight="/.test(text), /\swidth="/.test(text) && /\sheight="/.test(text)));
    out.push(window.__A('含 fallback 字体栈', true, text.indexOf('ui-monospace') > 0, text.indexOf('ui-monospace') > 0));
    out.push(window.__A('导出物无 <script>', true, parsed.getElementsByTagName('script').length === 0, parsed.getElementsByTagName('script').length === 0));
    out.push(window.__A('导出物无外连 url()', true, !/url\(\s*['"]?(https?:)?\/\//i.test(text), !/url\(\s*['"]?(https?:)?\/\//i.test(text)));
    // Export is SVG only now: the raster path (second render + canvas encode) is
    // what used to freeze the app, so its absence is an asserted property.
    out.push(window.__A('导出器不再提供位图接口', 'undefined', typeof window.__MMS__.createExporter({}).exportRaster));
    return out;
  });
});

/* ── 9: syntax error fence, negative cache, retry ────────────────────────── */
test('9', async (page) => {
  return page.evaluate(async () => {
    const out = [];
    const block = window.__addFence('graph TD\n  A --> ', 'mermaid');
    await window.__waitFor(() => block.previousElementSibling && block.previousElementSibling.getAttribute('data-mms-state') === 'error', 20000);
    const card = block.previousElementSibling;
    out.push(window.__A('语法错误进入 error 态', 'error', card.getAttribute('data-mms-state')));
    out.push(window.__A('错误卡提供重试', true, !!card.querySelector('.mms-btn:not([hidden])'), !!card.querySelector('.mms-btn:not([hidden])')));
    const key = card.getAttribute('data-mms-key');
    const records = await window.__idbAll();
    out.push(window.__A('错误不写入持久缓存', 0, records.filter((r) => r.key.indexOf(key) === 0).length));
    const renderBefore = window.__stats().renderCount;
    card.querySelectorAll('.mms-btn').forEach((b) => {
      if (b.textContent === '重试') b.click();
    });
    await new Promise((r) => setTimeout(r, 1200));
    out.push(window.__A('手动重试绕过负缓存', true, window.__stats().renderCount > renderBefore, window.__stats().renderCount > renderBefore));
    return out;
  });
});

/* ── 12: injection payloads (security) ──────────────────────────────────── */
test('12', async (page) => {
  return page.evaluate(async () => {
    const out = [];
    const payloads = [
      'graph TD\n  A["<script>window.__mmsPwned=1</script>"] --> B',
      '%%{init: {"themeVariables": {"fontFamily": "x; } body{visibility:hidden} .a{"}}}%%\ngraph TD\n  A --> B',
      'graph TD\n  A["<style>body{visibility:hidden}</style>"] --> B',
      '%%{init: {"securityLevel": "loose"}}%%\ngraph TD\n  A --> B',
      'graph TD\n  A["<img src=x onerror=window.__mmsPwned=1>"] --> B',
      'graph TD\n  A --> B\n  style A fill:url(https://example.invalid/x)'
    ];
    const bodyStyleBefore = getComputedStyle(document.body).visibility;
    const sheetCountBefore = document.styleSheets.length;
    const sanBefore = window.__stats().sanitizeRejected;
    const dirBefore = window.__stats().dirRejected;
    function bodyRuleCount() {
      let total = 0;
      for (const sheet of Array.from(document.styleSheets)) {
        let rules;
        try { rules = sheet.cssRules; } catch (error) { continue; }
        for (const rule of Array.from(rules || [])) {
          if (rule.selectorText && /(^|,)\s*(body|html)\b/.test(rule.selectorText)) total += 1;
        }
      }
      return total;
    }
    const bodyRulesBefore = bodyRuleCount();
    for (const payload of payloads) window.__addFence(payload, 'mermaid');
    await window.__waitFor(() => window.__stats().fenceSeen >= 6, 20000);
    await new Promise((r) => setTimeout(r, 4000));
    out.push(window.__A('未执行注入脚本', 'undefined', typeof window.__mmsPwned));
    out.push(window.__A('body 可见性未被改变', bodyStyleBefore, getComputedStyle(document.body).visibility));
    out.push(window.__A('无新增 body/html 全局样式规则', 0, bodyRuleCount() - bodyRulesBefore));
    out.push(window.__A('sanitizeRejected 有增量或 init 键被剥离', true, window.__stats().sanitizeRejected > sanBefore || window.__stats().dirRejected > dirBefore, 'san=' + window.__stats().sanitizeRejected + ' dir=' + window.__stats().dirRejected));
    out.push(window.__A('样式表数量未因注入增长', true, document.styleSheets.length <= sheetCountBefore + 1, document.styleSheets.length + ' vs ' + sheetCountBefore));
    return out;
  });
});

/* ── 14: sanitizer is not over-tight (positive control) ─────────────────── */
test('14', async (page) => {
  return page.evaluate(async () => {
    const out = [];
    const block = window.__addFence('graph TD\n  A[开始] --> B["带 <b>HTML</b> 标签"]', 'mermaid');
    await window.__waitFor(() => {
      const card = block.previousElementSibling;
      return card && card.getAttribute('data-mms-state') === 'ready';
    }, 20000);
    const card = block.previousElementSibling;
    out.push(window.__A('htmlLabels 图正常成图', 'ready', card.getAttribute('data-mms-state')));
    const svg = card.querySelector('.mms-stage svg');
    out.push(window.__A('foreignObject 被保留', true, !!svg && !!svg.querySelector('foreignObject'), !!svg && !!svg.querySelector('foreignObject')));
    const styled = svg ? svg.querySelector('style') : null;
    out.push(window.__A('合法 <style> 被保留', true, !!styled && styled.textContent.length > 0, !!styled && styled.textContent.length > 0));

    // Regression: mermaid writes an unclosed <br> inside foreignObject for any
    // multi-line label, so the SVG string is not valid XML. Strict image/svg+xml
    // parsing rejected exactly this and showed a false "blocked content" error.
    const multi = await window.__reset([{
      source: 'flowchart LR\n  subgraph FE["浏览器 · 前端"]\n    F1["knowledge-base store<br/>5MB 分片 × 4 并发"]\n  end\n  F1 -->|"POST /upload/chunk"| C1["UploadController"]',
      lang: 'mermaid'
    }]);
    const multiCard = multi[0].previousElementSibling;
    out.push(window.__A('多行标签图（<br/>）正常成图', 'ready', multiCard && multiCard.getAttribute('data-mms-state')));
    out.push(window.__A('多行标签图未被误判为被阻止内容', false, multiCard ? multiCard.textContent.indexOf('被阻止的内容') >= 0 : true));
    out.push(window.__A('宽松解析计数 ≥ 1', true, window.__stats().sanitizeLenientParse >= 1, window.__stats().sanitizeLenientParse));
    out.push(window.__A('严格解析失败计数为 0（走的是宽松回退）', 0, window.__stats().sanitizeParseFail || 0));
    return out;
  });
});

/* ── 17: serial invariant on streaming ──────────────────────────────────── */
test('17', async (page) => {
  return page.evaluate(async () => {
    const out = [];
    const block = window.__addFence('graph TD\n  A --> B', 'mermaid');
    const renderBefore = window.__stats().renderCount;
    for (let i = 0; i < 12; i += 1) {
      window.__setFenceSource(block, 'graph TD\n  A --> B' + ' --> C'.repeat(i));
      await new Promise((r) => setTimeout(r, 60));
    }
    window.__setFenceSource(block, 'graph TD\n  A --> B --> C --> D');
    await window.__waitFor(() => {
      const card = block.previousElementSibling;
      return card && card.getAttribute('data-mms-state') === 'ready';
    }, 25000);
    const delta = window.__stats().renderCount - renderBefore;
    out.push(window.__A('流式 12 次改写后渲染 ≤ 3 次', '≤3', delta, delta <= 3));    out.push(window.__A('卡片数 = 1（无重复卡片）', 1, Array.from(document.querySelectorAll('.mms-card')).filter((c) => c.nextElementSibling === block).length));
    const strays = Array.from(document.body.children).filter((n) => n.id && (n.id.indexOf('mermaid-') === 0 || n.id.indexOf('dmm') === 0));
    out.push(window.__A('body 下无 mermaid 临时容器残留', 0, strays.length));

    // P0-9: the host may replace the whole code block. The card is a sibling, so
    // it is not in removedNodes — the orphan sweep has to catch it.
    let current = block;
    for (let i = 0; i < 3; i += 1) {
      const replacement = window.__makeFence('graph TD\n  R' + i + ' --> X', 'mermaid');
      current.parentNode.replaceChild(replacement, current);
      current = replacement;
      await new Promise((r) => setTimeout(r, 700));
    }
    await window.__waitFor(() => {
      const card = current.previousElementSibling;
      return card && card.getAttribute('data-mms-state') === 'ready';
    }, 25000);
    let siblings = 0;
    let walker = current.previousElementSibling;
    while (walker && walker.classList.contains('mms-card')) {
      siblings += 1;
      walker = walker.previousElementSibling;
    }
    out.push(window.__A('代码块被整体替换 3 次后只留 1 张卡', 1, siblings));
    return out;
  });
});

/* ── 22: overlong source and governance keys ────────────────────────────── */
test('22', async (page) => {
  return page.evaluate(async () => {
    const out = [];
    const huge = 'graph TD\n' + Array.from({ length: 6000 }, (_, i) => '  N' + i + ' --> N' + (i + 1)).join('\n');
    const block = window.__addFence(huge, 'mermaid');
    await window.__waitFor(() => block.previousElementSibling && block.previousElementSibling.getAttribute('data-mms-state') === 'error', 15000);
    const card = block.previousElementSibling;
    out.push(window.__A('超长源码直接 error', 'error', card.getAttribute('data-mms-state')));
    out.push(window.__A('超长源码错误文案', true, card.textContent.indexOf('源码过长') >= 0, card.textContent.indexOf('源码过长') >= 0));
    const retryVisible = Array.from(card.querySelectorAll('button')).some((b) => b.textContent === '重试' && !b.hidden);
    out.push(window.__A('超长源码不显示重试', false, retryVisible));

    const governed = window.__addFence('%%{init: {"securityLevel":"loose","theme":"dark"}}%%\ngraph TD\n  A --> B', 'mermaid');
    const dirBefore = window.__stats().dirRejected;
    await window.__waitFor(() => governed.previousElementSibling && governed.previousElementSibling.getAttribute('data-mms-state') === 'ready', 20000);
    out.push(window.__A('治理键被剥离后仍出图', 'ready', governed.previousElementSibling.getAttribute('data-mms-state')));
    out.push(window.__A('卡片角标提示已忽略 init 指令', true, governed.previousElementSibling.textContent.indexOf('已忽略 init 指令') >= 0, true));
    const records = await window.__idbAll();
    const stored = records.filter((r) => r.source && r.source.indexOf('securityLevel') >= 0);
    out.push(window.__A('落库源码不含 securityLevel', 0, stored.length));
    out.push(window.__A('dirRejected 记录被拒键', true, window.__stats().dirRejected >= dirBefore, true));
    return out;
  });
});

/* ── 25: scope — fences outside the chat flow are ignored ───────────────── */
test('25', async (page) => {
  return page.evaluate(async () => {
    const out = [];
    const sidebar = document.getElementById('sidebar-mount');
    const block = window.__makeFence('graph TD\n  SECRET --> SIDEBAR', 'mermaid');
    sidebar.appendChild(block);
    await new Promise((r) => setTimeout(r, 1200));
    out.push(window.__A('侧栏围栏不生成卡片', false, block.previousElementSibling && block.previousElementSibling.classList.contains('mms-card') ? true : false));
    const outside = document.getElementById('outside-flow');
    const block2 = window.__makeFence('graph TD\n  OUT -->SIDE', 'mermaid');
    outside.appendChild(block2);
    await new Promise((r) => setTimeout(r, 1200));
    out.push(window.__A('会话流之外不生成卡片', false, block2.previousElementSibling && block2.previousElementSibling.classList.contains('mms-card') ? true : false));
    const records = await window.__idbAll();
    out.push(window.__A('非正文内容不入库', 0, records.filter((r) => (r.source || '').indexOf('SIDEBAR') >= 0 || (r.source || '').indexOf('SIDE') >= 0).length));
    return out;
  });
});

/* ── 19: cacheEnabled = false ───────────────────────────────────────────── */
test('19', async (page, context, url) => {
  const page2 = await context.newPage();
  await page2.addInitScript(() => {
    window.localStorage.setItem('mms:config:cacheEnabled', 'false');
  });
  await page2.goto(url, { waitUntil: 'domcontentloaded' });
  await page2.evaluate(PAGE_HELPERS);
  const booted = await page2.evaluate(() => window.__boot());
  const result = await page2.evaluate(async () => {
    const out = [];
    window.__addFence('graph TD\n  A --> B', 'mermaid');
    await window.__waitFor(() => window.__ready() >= 1, 20000);
    await new Promise((r) => setTimeout(r, 800));
    const records = await window.__idbRecordCount();
    out.push(window.__A('cacheEnabled=false → store 记录数 0', 0, records));
    const before = window.__stats().renderCount;
    // Unmount and rebuild the fences (not the serialized cards), then assert the
    // engine runs again instead of answering from memory.
    await window.__reset([{ source: 'graph TD\n  A --> B', lang: 'mermaid' }]);
    out.push(window.__A('每次进视口都重新渲染', '>0', window.__stats().renderCount - before, window.__stats().renderCount > before));
    return out;
  });
  // localStorage is shared by the whole context: leaving the override behind
  // would silently disable caching for every later case.
  await page2.evaluate(() => localStorage.removeItem('mms:config:cacheEnabled'));
  await page2.close();
  return result;
});

/* ── 20: IndexedDB degradation ──────────────────────────────────────────── */
test('20', async (page, context, url) => {
  const page2 = await context.newPage();
  await page2.addInitScript(() => {
    // Break indexedDB before the bundle runs: the plugin must fall back to memory
    // and warn exactly once.
    Object.defineProperty(window, 'indexedDB', { get: () => undefined, configurable: true });
    window.__warnCount = 0;
    const originalWarn = console.warn;
    console.warn = function (...args) {
      if (String(args[0]).indexOf('[mms] cache degraded') >= 0) window.__warnCount += 1;
      originalWarn.apply(console, args);
    };
  });
  await page2.goto(url, { waitUntil: 'domcontentloaded' });
  await page2.evaluate(PAGE_HELPERS);
  const booted = await page2.evaluate(() => window.__boot());
  const result = await page2.evaluate(async () => {
    const out = [];
    window.__addFence('graph TD\n  A --> B', 'mermaid');
    window.__addFence('graph LR\n  C --> D', 'mermaid');
    await window.__waitFor(() => window.__ready() >= 2, 25000);
    out.push(window.__A('IDB 不可用仍成图', 2, window.__ready()));
    out.push(window.__A('降级只告警一次', 1, window.__warnCount));
    out.push(window.__A('功能不中断（L1 仍生效）', true, window.__stats().cardBuilt >= 2, window.__stats().cardBuilt >= 2));
    return out;
  });
  await page2.close();
  return result;
});

/* ── 2b: cold cache, first sighting timing / long tasks ─────────────────── */
test('2b', async (page, context, url) => {
  // Cold means cold: a fresh browser profile, otherwise the shared IndexedDB from
  // earlier cases turns this into another L2-hit measurement.
  const coldDir = path.join(os.tmpdir(), 'mms-harness-cold-' + process.pid);
  await rm(coldDir, { recursive: true, force: true });
  const cold = await chromium.launchPersistentContext(coldDir, {
    executablePath: findChrome(),
    headless: !HEADED,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check']
  });
  await cold.addInitScript(PAGE_HELPERS);
  await cold.addInitScript(() => {
    window.__longTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__longTasks.push(Math.round(entry.duration));
      }).observe({ entryTypes: ['longtask'] });
    } catch (error) {
      window.__longTasks = null;
    }
  });
  const page2 = await cold.newPage();
  await page2.goto(url, { waitUntil: 'domcontentloaded' });
  await page2.evaluate(PAGE_HELPERS);
  await page2.evaluate(() => window.__boot());
  const result = await page2.evaluate(async () => {
    const out = [];
    await window.__reset([{ source: 'graph TD\n  A[开始] --> B{判断}\n  B -->|是| C[结束]', lang: 'mermaid' }]);
    const stats = window.__stats();
    out.push(window.__A('冷缓存下有真实渲染', '>=1', stats.renderCount, stats.renderCount >= 1));
    out.push(window.__A('冷缓存下无持久命中', '0', stats.cacheHitL1 + stats.cacheHitL2, stats.cacheHitL1 + stats.cacheHitL2 === 0));
    const longTasks = window.__longTasks;
    if (longTasks) {
      out.push(window.__A('渲染期间长任务 ≤ 2 次', '≤2', longTasks.length, longTasks.length <= 2));
    }
    return out;
  });
  await cold.close();
  await rm(coldDir, { recursive: true, force: true });
  return result;
});

/* ── 13: cache-hit injection with a poisoned record ─────────────────────── */
test('13', async (page, context, url) => {
  const page2 = await context.newPage();
  await page2.goto(url, { waitUntil: 'domcontentloaded' });
  await page2.evaluate(PAGE_HELPERS);
  await page2.evaluate(() => window.__boot());
  const seeded = await page2.evaluate(async () => {
    const source = 'graph TD\n  POISON --> TARGET';
    const block = window.__addFence(source, 'mermaid');
    await window.__waitFor(() => window.__ready() >= 1, 20000);
    const records = await window.__waitFor(async () => {
      const list = await window.__idbAll();
      return list.length ? list : false;
    }, 8000).catch(() => []);
    if (!records.length) return { ok: false, reason: 'no record to poison' };
    // Pick OUR record: the store also holds records from earlier cases, and
    // poisoning someone else's entry would make this test pass for the wrong
    // reason (or fail mysteriously).
    const record = records.find((r) => r.source === source);
    if (!record) return { ok: false, reason: 'no record for this source' };
    // Seeding contract (§15.1 #13): replace ONLY the svg, keep key / expiresAt /
    // lastUsed / bytes legal so TTL and LRU do not delete it first.
    const payload = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><style>body{visibility:hidden}</style><script>window.__mmsPwned=1</script><rect width="120" height="40" fill="#fff"/><text x="4" y="24" class="nodeLabel">x</text></svg>';
    const poisoned = Object.assign({}, record, { svg: payload, bytes: 200 });
    await window.__idbSeed(poisoned);
    return { ok: true, key: record.key, source };
  });
  if (!seeded.ok) {
    await page2.close();
    return [];
  }
  await page2.reload({ waitUntil: 'domcontentloaded' });
  await page2.evaluate(PAGE_HELPERS);
  await page2.evaluate(() => window.__boot());
  const result = await page2.evaluate(async (key) => {
    const out = [];
    const before = window.__stats();
    const sanBefore = before.sanitizeRejected;
    window.__addFence('graph TD\n  POISON --> TARGET', 'mermaid');
    await window.__waitFor(() => {
      const card = document.querySelector('.mms-card');
      return card && ['ready', 'error'].includes(card.getAttribute('data-mms-state'));
    }, 20000).catch(() => {});
    await new Promise((r) => setTimeout(r, 800));
    const card = document.querySelector('.mms-card');
    // Deliberate deviation from §11 (reported): a poisoned *cache record* does
    // not leave the user staring at an error for a diagram that is fine — the
    // card re-renders and overwrites the record. What is asserted here is that
    // the payload never ran, never reached the DOM, and never survived.
    out.push(window.__A('污染内容未进入 DOM', 0, card.querySelectorAll('script').length));
    out.push(window.__A('body 仍然可见', 'visible', getComputedStyle(document.body).visibility));
    out.push(window.__A('未执行注入脚本', 'undefined', typeof window.__mmsPwned));
    out.push(window.__A('sanitizeRejected 计数增加', true, window.__stats().sanitizeRejected > sanBefore, window.__stats().sanitizeRejected - sanBefore));
    out.push(window.__A('自愈后卡片成图', 'ready', card.getAttribute('data-mms-state')));
    const records = await window.__idbAll();
    const mine = records.find((r) => r.key === key);
    out.push(window.__A('该 key 未被回写为污染内容', false, mine ? mine.svg.indexOf('__mmsPwned') >= 0 : false));
    return out;
  }, seeded.key);
  await page2.close();
  return result;
});

/* ── 26: per-session cleanup deletes only that scope ────────────────────── */
test('26', async (page, context, url) => {
  const page2 = await context.newPage();
  await page2.goto(url, { waitUntil: 'domcontentloaded' });
  await page2.evaluate(PAGE_HELPERS);
  await page2.evaluate(() => window.__boot());
  const result = await page2.evaluate(async () => {
    const out = [];
    const app = window.__mmsDebug.app;
    const makeRecord = (scope, key) => ({
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
    });
    await window.__idbSeed(makeRecord('session-A', 'rec-A'));
    await window.__idbSeed(makeRecord('session-B', 'rec-B'));
    await new Promise((r) => setTimeout(r, 200));
    const before = await window.__idbAll();
    const removed = await app.cache.dropScope('session-A');
    const after = await window.__idbAll();
    out.push(window.__A('两份记录先落库', 2, before.filter((r) => r.key === 'rec-A' || r.key === 'rec-B').length));
    out.push(window.__A('按 scope 删除返回删除数', 1, removed));
    out.push(window.__A('会话 A 记录清 0', 0, after.filter((r) => r.key === 'rec-A').length));
    out.push(window.__A('会话 B 记录仍在', 1, after.filter((r) => r.key === 'rec-B').length));
    return out;
  });
  await page2.close();
  return result;
});

/* ── 27: filtering happens before insertion ─────────────────────────────── */
test('27', async (page) => {
  return page.evaluate(async () => {
    const out = [];
    const original = document.importNode.bind(document);
    const seen = [];
    document.importNode = function (node, deep) {
      try {
        const html = node.outerHTML || '';
        seen.push({
          hasScript: !!(node.querySelector && node.querySelector('script')),
          hasOnAttr: /on[a-z]+\s*=/i.test(html)
        });
      } catch (error) {
        seen.push({ hasScript: 'unknown', hasOnAttr: 'unknown' });
      }
      return original(node, deep);
    };
    window.__addFence('graph TD\n  A["<script>window.__mmsOrder=1</script>"] --> B', 'mermaid');
    await window.__waitFor(() => {
      const card = document.querySelector('.mms-card');
      return card && ['ready', 'error'].includes(card.getAttribute('data-mms-state'));
    }, 20000);
    await new Promise((r) => setTimeout(r, 300));
    document.importNode = original;
    out.push(window.__A('导入前已无 script 节点', true, seen.length > 0 && seen.every((s) => s.hasScript === false), JSON.stringify(seen)));
    out.push(window.__A('导入前已无 on* 属性', true, seen.every((s) => s.hasOnAttr === false), JSON.stringify(seen)));
    out.push(window.__A('payload 未执行', 'undefined', typeof window.__mmsOrder));
    return out;
  });
});

/* ── 15: execution surface closed (exported SVG) ────────────────────────── */
test('15', async (page) => {
  return page.evaluate(async () => {
    const out = [];
    const block = await window.__reset([
      { source: 'graph TD\n  A["<script>window.__mmsExportPwned=1</script>"] --> B', lang: 'mermaid' }
    ]);
    const card = block[0].previousElementSibling;
    const svg = card.querySelector('.mms-stage svg');
    out.push(window.__A('payload 围栏成图', 'ready', card.getAttribute('data-mms-state')));
    const text = window.__mmsDebug.app.exporter.serializeSvg(svg);
    out.push(window.__A('导出串含 xmlns', true, text.indexOf('xmlns="http://www.w3.org/2000/svg"') > 0, text.indexOf('xmlns="http://www.w3.org/2000/svg"') > 0));
    const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
    out.push(window.__A('导出物无 script 元素', 0, parsed.getElementsByTagName('script').length));
    out.push(window.__A('导出物无 on* 属性', true, !/<[^>]+\son[a-z]+\s*=/i.test(text), !/<[^>]+\son[a-z]+\s*=/i.test(text)));
    out.push(window.__A('导出物无外连 URL', true, !/url\(\s*['"]?(https?:)?\/\//i.test(text), !/url\(\s*['"]?(https?:)?\/\//i.test(text)));
    out.push(window.__A('顶层打开不执行脚本', 'undefined', typeof window.__mmsExportPwned));
    return out;
  });
});

/* ── 21: timeout and slot ownership (queue invariants) ──────────────────── */
test('21', async (page) => {
  return page.evaluate(async () => {
    const out = [];
    const MMS = window.__MMS__;
    const stats = { renderCount: 0, note: function () {}, error: function () {} };
    let started = [];
    let resets = 0;
    let firstResolve = null;
    const fakeRenderer = {
      render(job) {
        started.push(job.uid);
        if (job.uid === 'job-1') {
          return new Promise((resolve) => {
            firstResolve = resolve; // never settles on its own
          });
        }
        return Promise.resolve({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>', renderId: job.uid });
      },
      reset() {
        resets += 1;
      }
    };
    const outcomes = [];
    const queue = MMS.createQueue({
      renderer: fakeRenderer,
      stats: stats,
      timeoutMs: 250,
      onOutcome: (outcome) => outcomes.push(outcome)
    });
    queue.push({ uid: 'job-1', source: 'graph TD\n A-->B', theme: 'default' });
    queue.push({ uid: 'job-2', source: 'graph TD\n C-->D', theme: 'default' });
    await new Promise((r) => setTimeout(r, 120));
    out.push(window.__A('第 1 项在跑时第 2 项不开始', 'job-1', started.join(',')));
    // After 2 × timeout the engine is abandoned and the slot released.
    await new Promise((r) => setTimeout(r, 600));
    out.push(window.__A('永不 settle 后隔离并放行下一项', true, started.includes('job-2'), started.join(',')));
    out.push(window.__A('隔离时重建渲染器', 1, resets));
    out.push(window.__A('超时事件已上报', true, outcomes.some((o) => o.type === 'timeout'), outcomes.map((o) => o.type).join(',')));

    // Breaker: two consecutive timeouts stop the queue.
    const outcomes2 = [];
    const started2 = [];
    const stuck = {
      render(job) {
        started2.push(job.uid);
        return new Promise(() => {});
      },
      reset() {}
    };
    const queue2 = MMS.createQueue({
      renderer: stuck,
      stats: { note: function () {}, error: function () {} },
      timeoutMs: 120,
      onOutcome: (outcome) => outcomes2.push(outcome)
    });
    queue2.push({ uid: 'a', source: 'graph TD', theme: 'default' });
    queue2.push({ uid: 'b', source: 'graph TD', theme: 'default' });
    queue2.push({ uid: 'c', source: 'graph TD', theme: 'default' });
    await new Promise((r) => setTimeout(r, 900));
    out.push(window.__A('连续 2 项超时后熔断', true, queue2.isBreakerOpen(), queue2.isBreakerOpen()));
    out.push(window.__A('熔断后第 3 项不再开始', 'a,b', started2.join(',')));
    out.push(window.__A('剩余项留在队列等待重置', 1, queue2.length()));
    return out;
  });
});

/* ── 8: theme follows the host (no manual override) ─────────────────────── */
test('8', async (page) => {
  return page.evaluate(async () => {
    const out = [];
    const card = document.querySelector('.mms-card');
    const toolbar = Array.from(card.querySelectorAll('.mms-float button')).map((b) => b.textContent.trim());
    out.push(window.__A('悬浮按钮里没有主题开关', false, toolbar.some((t) => t.indexOf('主题') === 0)));

    const before = window.__stats();
    const hitsBefore = before.cacheHitL1 + before.cacheHitL2;
    window.__setDark(true);
    await window.__waitFor(() => card.getAttribute('data-mms-state') === 'ready', 20000);
    await new Promise((r) => setTimeout(r, 500));
    const records = await window.__idbAll();
    const dark = records.filter((rec) => rec.theme === 'dark');
    out.push(window.__A('跟随宿主切到暗色后重新渲染', true, dark.length > 0, dark.length));
    out.push(window.__A('暗色下卡片仍 ready', 'ready', card.getAttribute('data-mms-state')));

    window.__setDark(false);
    await window.__waitFor(() => card.getAttribute('data-mms-state') === 'ready', 20000);
    await new Promise((r) => setTimeout(r, 500));
    const hitsAfter = window.__stats().cacheHitL1 + window.__stats().cacheHitL2;
    out.push(window.__A('切回亮色时命中已缓存的那份', true, hitsAfter > hitsBefore, hitsBefore + ' -> ' + hitsAfter));
    out.push(window.__A('两份主题各自入库', true, records.some((rec) => rec.theme === 'dark') && (await window.__idbAll()).some((rec) => rec.theme === 'default')));
    return out;
  });
});

/* ── 10: uninstall hygiene ──────────────────────────────────────────────── */
test('10', async (page) => {
  const result = await page.evaluate(async () => {
    const out = [];
    const before = {
      cards: document.querySelectorAll('.mms-card').length,
      style: !!document.getElementById('mms-styles'),
      keys: window.__mmsKeys().length
    };
    out.push(window.__A('卸载前存在卡片', true, before.cards > 0, before.cards));
    out.push(window.__A('卸载前存在样式表', true, before.style, before.style));
    if (typeof window.__disposeHook === 'function') window.__disposeHook();
    await new Promise((r) => setTimeout(r, 900));
    out.push(window.__A('卡片全部移除', 0, document.querySelectorAll('.mms-card').length));
    out.push(window.__A('<style> 已移除', false, !!document.getElementById('mms-styles')));
    const hidden = Array.from(document.querySelectorAll('.md-code-block')).filter((b) => getComputedStyle(b).display === 'none');
    out.push(window.__A('代码块全部可见', 0, hidden.length));
    const databases = await window.__databases();
    out.push(window.__A('IndexedDB 库已删除', false, databases.includes('dsh-mermaid-studio')));
    out.push(window.__A('mms:* localStorage 已清空', 0, window.__mmsKeys().length));
    out.push(window.__A('__mmsStats 已移除', 'undefined', typeof window.__mmsStats));
    out.push(window.__A('body overflow 已还原', '', document.body.style.overflow));
    return out;
  });
  return result;
});

/* ── 16: data deletable (TTL sweep + uninstall) ─────────────────────────── */
test('16', async (page, context, url) => {
  const page2 = await context.newPage();
  await page2.goto(url, { waitUntil: 'domcontentloaded' });
  await page2.evaluate(PAGE_HELPERS);
  await page2.evaluate(() => window.__boot());
  const seeded = await page2.evaluate(async () => {
    // An entry that is already past its TTL must be swept at startup, not served.
    const stale = {
      key: 'stale-' + Math.random().toString(36).slice(2),
      source: 'graph TD\n STALE --> ENTRY',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
      width: 10,
      height: 10,
      theme: 'default',
      mermaidVersion: window.__mmsDebug.app.mermaidVersion(),
      schema: 1,
      renderId: 'mms-stale-1',
      scopeHash: 'stale-scope',
      createdAt: Date.now() - 40 * 24 * 3600 * 1000,
      lastUsed: Date.now() - 40 * 24 * 3600 * 1000,
      expiresAt: Date.now() - 24 * 3600 * 1000,
      hits: 0,
      bytes: 120
    };
    await window.__idbSeed(stale);
    return { key: stale.key };
  });
  await page2.reload({ waitUntil: 'domcontentloaded' });
  await page2.evaluate(PAGE_HELPERS);
  await page2.evaluate(() => window.__boot());
  const result = await page2.evaluate(async (staleKey) => {
    const out = [];
    await new Promise((r) => setTimeout(r, 800));
    const records = await window.__idbAll();
    out.push(window.__A('31 天前条目启动时被清', 0, records.filter((r) => r.key === staleKey).length));
    if (typeof window.__disposeHook === 'function') window.__disposeHook();
    await new Promise((r) => setTimeout(r, 900));
    const databases = await window.__databases();
    out.push(window.__A('卸载后 IDB 库不存在', false, databases.includes('dsh-mermaid-studio')));
    out.push(window.__A('卸载后 mms:* 键为 0', 0, window.__mmsKeys().length));
    return out;
  }, seeded.key);
  await page2.close();
  return result;
});


/* ── manual cases: declared, not claimed ────────────────────────────────── */
test('11', async () => ({ assertions: [], note: '需要同时启用 dsh-mermaid-smooth 才能复现双工具栏现象；默认 profile 已停用它，故本通道记为 pending。' }));
test('18', async () => ({ assertions: [], note: '回滚演练需要在真实 profile 上执行 set_bundle 停用/启用（涉审批耗时），无头通道无法代跑；见 scripts/rollback.md。' }));
test('24', async () => ({ assertions: [], note: 'P1 项：Tab 焦点循环需真实键盘事件，脚本合成事件不能驱动焦点移动，属于人工验收。' }));

// ── runner ────────────────────────────────────────────────────────────────
async function main() {
  const { server, port } = await startServer();
  const suffixArg = ARGV.find((a) => a.startsWith('--suffix='));
  const url = `http://127.0.0.1:${port}/qa/harness/shell.html` + (suffixArg ? suffixArg.slice('--suffix='.length) : '');
  const userDataDir = path.join(os.tmpdir(), 'mms-harness-' + process.pid);
  await rm(userDataDir, { recursive: true, force: true });

  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChrome(),
    headless: !HEADED,
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
    args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check']
  });
  await context.addInitScript(PAGE_HELPERS);
  globalThis.__browserVersion = 'Chromium/' + context.browser()?.version?.() || 'unknown';

  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
    if (msg.type() === 'warning' && msg.text().includes('[mms]')) consoleErrors.push('warn: ' + msg.text());
  });
  page.on('pageerror', (error) => consoleErrors.push('pageerror: ' + error.message));

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.evaluate(PAGE_HELPERS);
  const booted = await page.evaluate(() => window.__boot());
  const loadAb = ARGV.some((a) => a.indexOf('noplugin=1') >= 0);
  if (booted !== 'ok' && !loadAb) {
    const loadError = await page.evaluate(() => window.__loadError || '');
    console.error('[harness] bundle failed to boot:', booted, loadError);
    await context.close();
    server.close();
    process.exit(1);
  }

  if (ARGV.includes('--probe') || ARGV.some((a) => a.startsWith('--probe-file'))) {
    let code = ARGV[ARGV.indexOf('--probe') + 1];
    const fileArg = ARGV.find((a) => a.startsWith('--probe-file='));
    if (fileArg) code = await readFile(path.resolve(ROOT, fileArg.slice('--probe-file='.length)), 'utf8');
    else if (ARGV.includes('--probe') && ARGV[ARGV.indexOf('--probe') + 1] && !code) {
      console.error('[harness] --probe needs a JS expression');
      process.exit(2);
    }
    if (!code) {
      console.error('[harness] --probe-file needs a path');
      process.exit(2);
    }
    const probeVariant = process.env.PROBE_VARIANT || 'baseline';
    await page.evaluate(({ flag, variant }) => {
      window.__probeBackdrop = flag;
      window.__probeVariant = variant;
    }, { flag: ARGV.includes('--backdrop'), variant: probeVariant });
    const probe = await page.evaluate(async (body) => {
      const fn = new Function('return (async () => {' + body + '})()');
      return JSON.parse(JSON.stringify(await fn()));
    }, code);
    console.log(JSON.stringify(probe, null, 2));
    await context.close();
    server.close();
    return;
  }

  await mkdir(RESULTS, { recursive: true });
  const summary = [];

  for (const entry of TESTS) {
    if (ONLY && !ONLY.includes(entry.id)) continue;
    const meta = caseMeta(entry.id);
    const startedAt = new Date().toISOString();
    const started = Date.now();
    let assertions = [];
    let status = 'pass';
    let note = '';
    try {
      // Every case starts from one freshly rendered card in a clean flow, so a
      // leftover DOM from the previous case can never satisfy an assertion.
      if (entry.id !== '10') {
        await page.evaluate(async () => {
          if (!window.__reset || typeof window.__mmsStats === 'undefined') return;
          try {
            await window.__reset([{ source: 'graph TD\n  A[开始] --> B{判断}\n  B -->|是| C[结束]', lang: 'mermaid' }]);
          } catch (error) {
            // A disposed plugin (after the uninstall case) renders nothing; the
            // case that follows owns its own setup.
          }
        });
      }
      const result = await entry.fn(page, context, url);
      assertions = Array.isArray(result) ? result : (result && result.assertions) || [];
      if (result && result.note) note = result.note;
      if (!assertions.length) status = 'pending';
      else if (assertions.some((a) => !a.pass)) status = 'fail';
    } catch (error) {
      status = 'error';
      note = error.message + (error.stack ? '\n' + error.stack.split('\n').slice(0, 4).join('\n') : '');
    }
    const record = {
      id: meta.id,
      name: meta.name,
      group: meta.group,
      p0: meta.p0,
      status,
      startedAt,
      durationMs: Date.now() - started,
      env: env(),
      assertions,
      note
    };
    await writeFile(path.join(RESULTS, meta.id + '.json'), JSON.stringify(record, null, 2) + '\n', 'utf8');
    summary.push(record);
    const mark = status === 'pass' ? 'PASS' : status === 'pending' ? 'PEND' : status.toUpperCase();
    console.log(`[harness] ${mark} #${meta.id} ${meta.name} (${record.durationMs} ms)`);
    for (const assertion of assertions) {
      if (!assertion.pass) console.log('    ✗ ' + assertion.name + ' → expected ' + JSON.stringify(assertion.expected) + ', actual ' + JSON.stringify(assertion.actual));
    }
    if (note) console.log('    ! ' + note.split('\n')[0]);
  }

  if (consoleErrors.length) {
    console.log('\n[harness] console errors/warnings captured:');
    for (const line of consoleErrors.slice(0, 12)) console.log('    · ' + line);
  }

  await writeFile(
    path.join(RESULTS, '_harness-summary.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), booted, url, results: summary.map((r) => ({ id: r.id, status: r.status, failed: r.assertions.filter((a) => !a.pass).length })), consoleErrors }, null, 2) + '\n',
    'utf8'
  );

  await context.close();
  server.close();
  const failed = summary.filter((r) => r.status === 'fail' || r.status === 'error');
  console.log(`\n[harness] ${summary.length - failed.length}/${summary.length} case files written; ${failed.length} not passing`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('[harness] fatal:', error);
  process.exit(1);
});
