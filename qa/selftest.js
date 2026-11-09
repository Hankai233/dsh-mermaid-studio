/**
 * qa/selftest.js —— §15.0 执行通道 ①：插件内置自测面板
 *
 * 目标：不依赖 DevTools，也能把 §15 / §15.1 的用例跑出可归档的 JSON。
 * 用法：构建期把本文件并入 client 包，或在 GUI 控制台整段粘贴。
 *      面板出现在右下角；`window.__mmsSelfTest` 暴露 run/runAll/list/results。
 *
 * 诚实性约束（§15.0 硬规矩）：
 *   - 未实现的用例只能返回 pending，绝不允许返回 pass。
 *   - 每条结果都带 env 快照；缺基线环境（含 cpuThrottle）的记录不算归档。
 *   - 计数器可被同源脚本伪造：**v5 更正 —— 本文件不再声称有 nonce 防伪**。
 *     需要防伪时用 CDP 独立世界读取；页面内自证天然不可信，不要自欺。
 */
(function () {
  'use strict';

  if (window.__mmsSelfTest) return;

  const PANEL_ID = 'mms-selftest';
  const SPEC = 'docs/superpowers/specs/2026-11-09-dsh-mermaid-studio-design.md';
  const CASE_TIMEOUT_MS = 30000;

  // ---------------------------------------------------------------- 环境
  // DevTools 的 CPU 节流状态无法从页面内读取 → 必须人工回填。
  const THROTTLE_VALUES = ['none', '4x', '6x'];
  function cpuThrottle() {
    const v = window.__mmsCpuThrottle;
    return THROTTLE_VALUES.indexOf(v) >= 0 ? v : 'unknown';
  }

  function envSnapshot() {
    const uad = navigator.userAgentData;
    return {
      machine: (uad && uad.platform) || navigator.platform || 'unknown',
      cores: navigator.hardwareConcurrency || null,
      browser: navigator.userAgent,
      dpr: window.devicePixelRatio || 1,
      cpuThrottle: cpuThrottle()
    };
  }

  // ---------------------------------------------------------------- DOM 工具
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const isPanelNode = (el) => !!(el && el.closest && el.closest('#' + PANEL_ID));

  const api = {
    cards: () => $$('.mms-card').filter((el) => !isPanelNode(el)),
    // mermaid 渲染残留的临时容器（§5.1 要求 finally 里按渲染 ID 清干净）。
    // v5 修正：必须排除插件自己的 <style id="mms-styles">，否则健康实现上恒红。
    leftovers: () =>
      $$('[id^="mms-"]').filter(
        (el) =>
          el.id !== PANEL_ID &&
          el.id !== 'mms-styles' &&
          !isPanelNode(el) &&
          !el.closest('.mms-card')
      ),
    // 文档级样式规则 = §6.7 断链失败。
    // v5 修正：改「与基线差集」——宿主 GUI 自身的 body/html 规则不是我们的责任，
    // 全量扫描会让 INV-2 在真机上恒红。
    baseline: null,
    styleFingerprint: () => {
      const seen = new Set();
      for (const sheet of Array.from(document.styleSheets)) {
        let rules;
        try { rules = sheet.cssRules; } catch (_) { continue; } // 跨域样式表跳过
        for (const rule of Array.from(rules || [])) {
          const sel = rule.selectorText;
          if (sel && /(^|[,\s>+~(]|:)(body|html|:root)([,\s{:.#>+~)]|$)/i.test(sel)) seen.add(sel);
        }
      }
      return seen;
    },
    captureBaseline: () => {
      api.baseline = api.styleFingerprint();
      return api.baseline.size;
    },
    globalSelectors: () => {
      const base = api.baseline || new Set();
      return Array.from(api.styleFingerprint()).filter((sel) => !base.has(sel));
    },
    stats: () => window.__mmsStats || null,
    statsShapeOk: () => {
      const s = window.__mmsStats;
      if (!s) return false;
      return ['renderCount', 'cacheHitCount', 'dirRejected', 'sanitizeRejected', 'renderIsolated', 'configMissing', 'fenceMiss'].every(
        (k) => typeof s[k] === 'number'
      );
    },
    // React 拥有的节点基线快照，用于「零属性写入」人工对比（§3.3）
    reactNodeSnapshot: () =>
      $$('.md-code-block').map((el) => ({
        sameNode: true,
        attrs: Array.from(el.attributes).map((a) => a.name + '=' + a.value).sort().join('|')
      })),
    diffSnapshot: (before) => {
      const after = api.reactNodeSnapshot();
      const bad = [];
      if (before.length !== after.length) return { ok: false, reason: '节点数变化 ' + before.length + ' → ' + after.length };
      before.forEach((b, i) => {
        if (after[i] && b.attrs !== after[i].attrs) bad.push('#' + i + ' attrs 被改写');
      });
      return { ok: bad.length === 0, reason: bad.join('; ') };
    }
  };

  // 载入时立刻采样式基线（此刻插件还没注入任何样式），供 INV-2 做差集
  api.captureBaseline();

  // ---------------------------------------------------------------- 断言器
  function makeT() {
    const assertions = [];
    let pendingReason = null;
    // v5 修正：pass 必须显式传入，不再拿 diagnostic 值当判定依据。
    // 原实现里 ok() 一旦传了 actual 就忽略 cond、gte() 用 Object.is 比字符串与数字 → 两条都恒红。
    const push = (name, expected, actual, pass) => {
      assertions.push({ name, expected, actual, pass: !!pass });
    };
    return {
      eq: (name, actual, expected) => push(name, expected, actual, Object.is(actual, expected)),
      ok: (name, cond, detail) => push(name, true, detail === undefined ? !!cond : detail, !!cond),
      gte: (name, actual, min) => push(name, '>= ' + min, actual, Number(actual) >= Number(min)),
      lte: (name, actual, max) => push(name, '<= ' + max, actual, Number(actual) <= Number(max)),
      pending: (reason) => { pendingReason = reason; },
      get assertions() { return assertions; },
      get pendingReason() { return pendingReason; }
    };
  }

  // ---------------------------------------------------------------- 用例表
  // 已实现：只用页面内可观测事实就能判定的不变量。
  const IMPLEMENTED = {
    'INV-1': async (t) => {
      t.eq('无 mms- 残留临时容器', api.leftovers().length, 0);
    },
    'INV-2': async (t) => {
      const bad = api.globalSelectors();
      t.eq('无打到 body/html 的样式规则', bad.length, 0);
      if (bad.length) t.ok('命中规则样例', false, bad.slice(0, 3).join(' | '));
    },
    'INV-3': async (t) => {
      t.ok('__mmsStats 结构完整', api.statsShapeOk(), api.stats() ? JSON.stringify(api.stats()) : 'null');
    },
    'INV-4': async (t) => {
      const snap = api.reactNodeSnapshot();
      if (snap.length === 0) {
        t.pending('页面上没有 .md-code-block，无基线可采');
        return;
      }
      window.__mmsSnap = snap;
      t.gte('已采到 .md-code-block 基线', snap.length, 1);
    }
  };

  // 待实现的验收用例：只声明，不伪造结果。
  // #11 是现象复现、#24 是 P1，二者不计入 P0。
  const NON_P0 = ['11', '24'];
  const CASES = [
    ['1', 'perf', '首次出现 mermaid 围栏（20 张图长消息）', '需要 mermaid 已加载 + qa/fixtures/20-diagrams.md'],
    ['2', 'perf', '刷新页面（L2 命中，P95 ≤ 150 ms）', '需要 Performance 起点/终点打点 + 100 次采样'],
    ['2b', 'perf', '刷新页面（冷缓存 / 首见）', '需要清库流程 + 长任务观察'],
    ['3', 'cache', '切换会话再切回（L1 命中）', '需要 __mmsStats 前后差分'],
    ['4', 'interact', '滚轮 / 拖拽 / 双击 / 0 宽容器', '人工为主；断言部分需合成 pointer 事件'],
    ['5', 'interact', '全屏 Esc / 焦点回拉 ≤200 ms', '人工为主；回拉耗时需 focusin 时间戳'],
    ['6', 'export', '导出 SVG（结构断言）', '需要导出产物字符串做 XML 解析'],
    ['7', 'export', '导出 PNG / JPG（像素断言）', '需要 canvas getImageData + 标签区域判定'],
    ['8', 'theme', '全局三态主题（两态各自命中）', '需要 cacheHitCount 分主题差分'],
    ['9', 'error', '语法错误围栏 + 重试绕过负缓存', '需要错误图样与负缓存观测'],
    ['10', 'lifecycle', '卸载插件（现场清理）', '需要停用后复核；面板届时已不存在，须由 runner 侧执行'],
    ['11', 'coexist', '与旧插件并存（现象复现）', '人工复现，不产出 pass'],
    ['12', 'security', '渲染态注入（6 条 payload 组）', '需要 qa/fixtures/css-payloads.md + styleSheets 差分 + Network'],
    ['13', 'security', '缓存命中态注入（播种契约）', '需要 IDB 播种：正常渲染 → 读记录 → 仅替换 svg 写回'],
    ['14', 'security', '过滤未过度收紧（防误杀）', '需要 htmlLabels 图与外观类 init 指令图样'],
    ['15', 'security', '执行面收口（导出物顶层打开）', '需要离线打开导出的 .svg'],
    ['16', 'security', '数据可删除（IDB / mms:* / TTL）', '需要 indexedDB.databases() + localStorage 前缀扫描 + 31 天前播种'],
    ['17', 'queue', '串行不变量（5 s 延迟打桩）', '需要向 render 注入延迟打桩'],
    ['18', 'rollback', '回滚演练 ≤60 s', '跨进程操作，由人工按 §14.1 A/B 执行并记录时间戳'],
    ['19', 'cache', 'cacheEnabled = false 语义', '需要改配置 + 刷新 + IDB 复核'],
    ['20', 'cache', 'IndexedDB 降级 / 配额超限', '需要打桩 indexedDB.open 抛错 / 配额异常'],
    ['21', 'queue', '超时与槽位（永不 settle 打桩）', '需要永不 resolve 的打桩 render'],
    ['22', 'fence', '超长源码 + 治理键', '需要 qa/fixtures/gen-large.mjs 生成的 60k 字符图样'],
    ['23', 'theme', 'themeMode 初始化与按钮优先', '需要改 Config + 刷新 + localStorage 复核'],
    ['24', 'a11y', '完整焦点陷阱（P1）', '人工为主'],
    ['25', 'scope', '作用域授权（非正文不渲染/不入库）', '需要在侧栏预览放围栏并检索 IDB'],
    ['26', 'scope', '可删除性（按会话 scopeHash）', '需要删会话 + 重启 + 分 scopeHash 核对'],
    ['27', 'security', '过滤顺序（过滤先于插入）', '需要在 injectSvg 内打时序桩']
  ].map(([id, group, name, requires]) => ({ id, group, name, requires, p0: NON_P0.indexOf(id) < 0 }));

  // ---------------------------------------------------------------- 执行
  const results = new Map();

  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('超时 ' + ms + 'ms: ' + label)), ms))
    ]);
  }

  async function runCase(entry) {
    const t = makeT();
    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    let status = 'pending';
    let note = '';

    const fn = IMPLEMENTED[entry.id];
    if (!fn) {
      t.pending(entry.requires || '尚未实现');
      note = entry.requires || '';
    } else {
      try {
        await withTimeout(fn(t), CASE_TIMEOUT_MS, entry.id);
      } catch (err) {
        status = 'error';
        note = (err && err.message) || String(err);
      }
    }

    const assertions = t.assertions;
    if (status !== 'error') {
      if (t.pendingReason) status = 'pending';
      else if (assertions.length === 0) status = 'pending'; // 无断言 = 未判定，不允许算通过
      else status = assertions.every((a) => a.pass) ? 'pass' : 'fail';
      if (t.pendingReason) note = t.pendingReason;
    }

    const record = {
      id: entry.id,
      name: entry.name,
      group: entry.group,
      p0: entry.p0 === true,
      status,
      startedAt,
      durationMs: Math.round(performance.now() - t0),
      env: envSnapshot(),
      assertions,
      note
    };
    results.set(entry.id, record);
    return record;
  }

  async function runOne(id) {
    const entry = CASES.find((c) => c.id === id);
    if (!entry) throw new Error('未知用例 id: ' + id);
    const rec = await runCase(entry);
    render();
    return rec;
  }

  // 串行执行：队列类用例（#17/#21）互相污染，不允许并发
  async function runAll(filter) {
    const list = CASES.filter((c) => !filter || c.group === filter || filter === 'all');
    const out = [];
    for (const c of list) out.push(await runCase(c));
    for (const id of Object.keys(IMPLEMENTED)) {
      if (out.some((r) => r.id === id)) continue;
      out.push(await runCase({ id, group: 'invariant', name: id, requires: '', p0: false }));
    }
    render();
    return out;
  }

  function summary() {
    const all = Array.from(results.values());
    const by = (s) => all.filter((r) => r.status === s).length;
    return { total: all.length, pass: by('pass'), fail: by('fail'), pending: by('pending'), error: by('error') };
  }

  // ---------------------------------------------------------------- 面板
  const ROWS = new Map();

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    // v5 修正：面板挂在 body 上、会话正文根之外，天然不进扫描域（§4.2）。
    // 原实现挂了一个 data-mms-ignore 属性，但 §4.2 从未定义它——同 §16 删掉的 pre[data-mms-skip] 一样没有生产者。
    panel.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'width:520px', 'max-height:60vh',
      'overflow:auto', 'z-index:2147483001', 'background:#1e1e1e', 'color:#e6e6e6',
      'font:12px/1.5 ui-monospace,monospace', 'border:1px solid #444', 'border-radius:8px',
      'padding:10px', 'box-shadow:0 8px 24px rgba(0,0,0,.4)'
    ].join(';');

    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:8px';

    const title = document.createElement('strong');
    title.textContent = 'selftest';
    const mk = (label, onClick) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'font:inherit;padding:2px 8px;cursor:pointer;background:#2d2d2d;color:#e6e6e6;border:1px solid #555;border-radius:4px';
      b.onclick = onClick;
      return b;
    };
    const sum = document.createElement('span');
    sum.id = PANEL_ID + '-sum';
    sum.style.cssText = 'margin-left:auto;opacity:.8';

    // v5 新增：CPU 节流无法从页面内读取，必须人工回填，否则归档永远不算数
    const throttle = document.createElement('select');
    throttle.title = 'CPU 节流（DevTools 的状态无法从页面内读取，须手填）';
    throttle.style.cssText = 'font:inherit;background:#2d2d2d;color:#e6e6e6;border:1px solid #555;border-radius:4px';
    for (const v of ['unknown'].concat(THROTTLE_VALUES)) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = 'throttle:' + v;
      throttle.appendChild(o);
    }
    throttle.onchange = () => {
      window.__mmsCpuThrottle = throttle.value;
      render();
    };

    bar.append(title, mk('全跑', () => runAll('all')), mk('复制 JSON', copyJson), mk('下载', downloadJson), throttle, sum);

    const list = document.createElement('div');
    list.id = PANEL_ID + '-list';
    list.textContent = '尚未执行。点「全跑」开始。';

    panel.append(bar, list);
    document.body.appendChild(panel);
    return panel;
  }

  function render() {
    const panel = ensurePanel();
    const list = panel.querySelector('#' + PANEL_ID + '-list');
    const sumEl = panel.querySelector('#' + PANEL_ID + '-sum');
    const s = summary();
    sumEl.textContent = 'pass ' + s.pass + ' / fail ' + s.fail + ' / pending ' + s.pending + ' / error ' + s.error;

    list.textContent = '';
    for (const rec of results.values()) {
      const row = document.createElement('div');
      row.style.cssText = 'padding:3px 0;border-bottom:1px solid #333;white-space:pre-wrap';
      const color = { pass: '#7bd88f', fail: '#ff6b6b', pending: '#c9a227', error: '#ff6b6b' }[rec.status];
      const head = document.createElement('div');
      head.style.cssText = 'color:' + color;
      head.textContent = '[' + rec.status + '] #' + rec.id + ' ' + rec.name + '  (' + rec.durationMs + 'ms)';
      row.appendChild(head);

      if (rec.note) {
        const note = document.createElement('div');
        note.style.cssText = 'opacity:.7;padding-left:12px';
        note.textContent = '↳ ' + rec.note;
        row.appendChild(note);
      }
      for (const a of rec.assertions.filter((x) => !x.pass)) {
        const bad = document.createElement('div');
        bad.style.cssText = 'color:#ff9f9f;padding-left:12px';
        bad.textContent = '↳ FAIL ' + a.name + ' | expected=' + JSON.stringify(a.expected) + ' actual=' + JSON.stringify(a.actual);
        row.appendChild(bad);
      }
      list.appendChild(row);
      ROWS.set(rec.id, row);
    }
  }

  function allResults() {
    return Array.from(results.values());
  }

  async function copyJson() {
    const text = JSON.stringify(allResults(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      ensurePanel().querySelector('#' + PANEL_ID + '-sum').textContent = '已复制 ' + allResults().length + ' 条';
    } catch (_) {
      console.log(text);
      ensurePanel().querySelector('#' + PANEL_ID + '-sum').textContent = '剪贴板不可用，已打印到 console';
    }
  }

  function downloadJson() {
    const payload = {
      generatedAt: new Date().toISOString(),
      spec: SPEC,
      env: envSnapshot(),
      results: allResults()
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'mms-selftest-' + Date.now() + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  // ---------------------------------------------------------------- 对外接口
  window.__mmsSelfTest = {
    list: () => CASES.map((c) => ({ id: c.id, group: c.group, name: c.name, implemented: !!IMPLEMENTED[c.id] })),
    run: runOne,
    runAll,
    results: allResults,
    summary,
    api,
    snapshot: () => (window.__mmsSnap = api.reactNodeSnapshot()),
    diff: () => api.diffSnapshot(window.__mmsSnap || []),
    show: () => { ensurePanel(); render(); }
  };

  console.info('[mms-selftest] ready → window.__mmsSelfTest');
})();
