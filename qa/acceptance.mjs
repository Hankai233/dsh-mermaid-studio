#!/usr/bin/env node
/**
 * qa/acceptance.mjs —— §15.0 执行通道 ②：用例清单 / 结果归档 / Gate 判定
 *
 * 零依赖（只用 node: 内置模块），不需要 Puppeteer / CDP。
 * 页面内执行由 qa/selftest.js 负责，本脚本负责「归档 → 校验 → 判 Gate」。
 *
 * 用法：
 *   node qa/acceptance.mjs --list
 *   node qa/acceptance.mjs --ingest mms-selftest-1731234567890.json
 *   node qa/acceptance.mjs --check
 *   node qa/acceptance.mjs --gate
 *
 * 退出码：0 = 通过；1 = 有未通过项；2 = 输入/归档有问题。
 */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(HERE, 'results');
const CASES_FILE = path.join(HERE, 'cases.json');

const STATUS = ['pass', 'fail', 'pending', 'error'];
const REQUIRED_FIELDS = ['id', 'name', 'group', 'status', 'startedAt', 'env', 'assertions'];

const c = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`
};

function pad(s, n) {
  // 中文字符按 2 列估算，避免表格错位
  let width = 0;
  for (const ch of String(s)) width += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return String(s) + ' '.repeat(Math.max(0, n - width));
}

async function loadCases() {
  const raw = JSON.parse(await readFile(CASES_FILE, 'utf8'));
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) throw new Error('cases.json 没有 cases 数组');
  return raw.cases;
}

async function loadResults() {
  await mkdir(RESULTS_DIR, { recursive: true });
  // v5：_invariants.json 是诊断附件，不参与用例校验
  const files = (await readdir(RESULTS_DIR)).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  const list = [];
  for (const f of files) {
    try {
      const body = JSON.parse(await readFile(path.join(RESULTS_DIR, f), 'utf8'));
      list.push({ file: f, body });
    } catch (err) {
      list.push({ file: f, body: null, parseError: err.message });
    }
  }
  return list;
}

// ------------------------------------------------------------------ 命令
async function cmdList() {
  const cases = await loadCases();
  const results = await loadResults();
  const byId = new Map(results.filter((r) => r.body).map((r) => [String(r.body.id), r.body]));

  console.log('\n用例清单（源自 qa/cases.json）\n');
  console.log(
    pad('#', 5) + pad('组', 12) + pad('P0', 4) + pad('状态', 10) + pad('人工', 6) + '名称'
  );
  console.log('-'.repeat(96));
  for (const k of cases) {
    const rec = byId.get(String(k.id));
    const status = rec ? rec.status : '—';
    const paint = status === 'pass' ? c.ok : status === 'fail' || status === 'error' ? c.bad : c.dim;
    console.log(
      pad(k.id, 5) +
        pad(k.group, 12) +
        pad(k.p0 ? 'yes' : '', 4) +
        pad(paint(status), 10) +
        pad(k.manual ? 'yes' : '', 6) +
        k.name
    );
  }
  const p0 = cases.filter((k) => k.p0);
  const done = p0.filter((k) => byId.get(String(k.id))?.status === 'pass');
  console.log(c.dim(`\nP0 覆盖 ${done.length}/${p0.length} · 归档文件 ${results.length} 个 · 结果目录 qa/results/`));
}

async function cmdIngest(fileArg, opts) {
  opts = opts || {};
  if (!fileArg) {
    console.error(c.bad('用法: node qa/acceptance.mjs --ingest <mms-selftest-*.json> [--throttle none|4x|6x]'));
    process.exit(2);
  }
  const dump = JSON.parse(await readFile(path.resolve(process.cwd(), fileArg), 'utf8'));
  const results = Array.isArray(dump) ? dump : dump.results;
  if (!Array.isArray(results)) throw new Error('dump 里找不到 results 数组');

  const cases = await loadCases();
  const manifest = new Map(cases.map((k) => [String(k.id), k]));
  await mkdir(RESULTS_DIR, { recursive: true });

  let kept = 0;
  const invariants = [];
  for (const rec of results) {
    if (!rec || rec.id === undefined) continue;
    // v5 修正：只归档清单内的 id。INV-* 另存，否则 --check 会报「id 不在清单内」而恒 exit 2。
    if (!manifest.has(String(rec.id))) {
      invariants.push(rec);
      continue;
    }
    if (opts.throttle) rec.env = Object.assign({}, rec.env, { cpuThrottle: opts.throttle });
    await writeFile(path.join(RESULTS_DIR, String(rec.id) + '.json'), JSON.stringify(rec, null, 2) + '\n', 'utf8');
    kept += 1;
  }
  if (invariants.length) {
    await writeFile(
      path.join(RESULTS_DIR, '_invariants.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), note: '诊断用，不参与 P0 判定', results: invariants }, null, 2) + '\n',
      'utf8'
    );
  }
  console.log(c.ok(`已归档 ${kept} 条用例结果到 qa/results/`));
  if (invariants.length) {
    console.log(c.dim(`另有 ${invariants.length} 条 INV-* 诊断记录写入 _invariants.json（不参与 Gate）`));
  }
  if (dump.env && dump.env.cpuThrottle === 'unknown' && !opts.throttle) {
    console.log(c.warn('警告：env.cpuThrottle 仍是 unknown，请用 --throttle 回填后重新归档（§15.0 基线环境要求）'));
  }
}

const ENV_FIELDS = ['machine', 'cores', 'browser', 'dpr', 'cpuThrottle'];

// v5 修正：原实现只判 env.cpuThrottle === 'unknown'，env:{} 或缺字段照样通过（假通过）
function envProblems(file, env) {
  if (!env || typeof env !== 'object') return [file + ': 缺 env（§15.0 要求基线环境）'];
  const out = [];
  for (const k of ENV_FIELDS) {
    if (env[k] === undefined || env[k] === null || env[k] === '') out.push(file + ': env.' + k + ' 为空');
  }
  if (env.machine === 'unknown') out.push(file + ': env.machine 仍是 unknown');
  if (env.cpuThrottle === 'unknown') out.push(file + ': env.cpuThrottle 未回填（不算归档，§15.0）');
  if (!(Number(env.cores) > 0)) out.push(file + ': env.cores 非法');
  if (!(Number(env.dpr) > 0)) out.push(file + ': env.dpr 非法');
  return out;
}

async function cmdCheck() {
  const cases = await loadCases();
  const manifest = new Map(cases.map((k) => [String(k.id), k]));
  const results = await loadResults();
  const problems = [];

  if (results.length === 0) {
    console.log(c.warn('qa/results/ 为空：执行数 = 0，无法判定任何验收结论（§15.0）'));
    process.exit(1);
  }

  const seen = new Set();
  for (const { file, body, parseError } of results) {
    if (parseError) {
      problems.push(`${file}: JSON 解析失败 — ${parseError}`);
      continue;
    }
    for (const f of REQUIRED_FIELDS) {
      if (body[f] === undefined) problems.push(`${file}: 缺字段 ${f}`);
    }
    if (!STATUS.includes(body.status)) problems.push(`${file}: status 非法值 ${body.status}`);
    problems.push(...envProblems(file, body.env));
    // v5 修正：assertions 必须是数组；pass 时不得为空、不得含未通过断言
    if (!Array.isArray(body.assertions)) {
      problems.push(`${file}: assertions 不是数组（禁止用 null 绕过）`);
    } else {
      if (body.status === 'pass' && body.assertions.length === 0) {
        problems.push(`${file}: status=pass 但 assertions 为空（禁止无断言通过）`);
      }
      if (body.status === 'pass' && body.assertions.some((a) => !a || a.pass !== true)) {
        problems.push(`${file}: status=pass 但存在未通过的断言`);
      }
    }
    const key = manifest.get(String(body.id));
    if (!key) {
      problems.push(`${file}: id ${body.id} 不在 cases.json 清单内`);
    } else {
      // P0-12: a case "passes" only if the assertions this case is supposed to
      // make are actually present — otherwise one unrelated green assertion
      // would be enough to fake it.
      const required = key.requiredAssertions || [];
      if (body.status === 'pass' && required.length) {
        const names = new Set((body.assertions || []).map((a) => a.name));
        const missing = required.filter((name) => !names.has(name));
        if (missing.length) {
          problems.push(`${file}: 缺少该用例的必备断言 ${missing.join(' / ')}`);
        }
      }
      seen.add(String(body.id));
      // v5 新增：记录里的 p0 必须与清单一致（原实现把 #11/#24 也标成 P0）
      if (body.p0 !== undefined && Boolean(body.p0) !== Boolean(key.p0)) {
        problems.push(`${file}: p0 与清单不一致（记录 ${body.p0} / 清单 ${key.p0}）`);
      }
    }
  }

  const missingP0 = cases.filter((k) => k.p0 && !seen.has(String(k.id)));
  if (missingP0.length) {
    problems.push(`缺少 P0 用例归档：${missingP0.map((k) => k.id).join(', ')}`);
  }

  if (problems.length === 0) {
    console.log(c.ok(`归档完整：${results.length} 条，P0 已齐。**这不代表验收通过**——用 --gate 判定。`));
    process.exit(0);
  }
  console.log(c.bad(`归档校验未通过（${problems.length} 项）\n`));
  for (const p of problems) console.log('  - ' + p);
  process.exit(2);
}

async function cmdGate() {
  const cases = await loadCases();
  const results = (await loadResults()).filter((r) => r.body).map((r) => r.body);
  const byId = new Map(results.map((r) => [String(r.id), r]));

  const p0 = cases.filter((k) => k.p0);
  const p0Pass = p0.filter((k) => byId.get(String(k.id))?.status === 'pass');
  const p0NotPass = p0.filter((k) => byId.get(String(k.id))?.status !== 'pass');
  // v5 修正：anyBad 只统计 P0（#11 现象复现 / #24 P1 失败不该拖垮 G2）
  const anyBad = p0
    .map((k) => byId.get(String(k.id)))
    .filter(Boolean)
    .filter((r) => r.status === 'fail' || r.status === 'error');
  // v5 修正：环境校验复用 envProblems，缺字段/空对象不再能混过 G6
  const envOk =
    p0.length > 0 &&
    p0.every((k) => {
      const r = byId.get(String(k.id));
      return !!r && envProblems(String(k.id), r.env).length === 0;
    });

  const gates = [
    {
      id: 'G1',
      desc: '契约就位（§3.1.1 无「假设」行）',
      pass: null,
      note: '人工核对文档；spike 输出已逐字回填即为通过'
    },
    {
      id: 'G2',
      desc: `P0 用例全绿（${p0Pass.length}/${p0.length}）`,
      pass: p0NotPass.length === 0 && anyBad.length === 0 && results.length > 0,
      note: p0NotPass.length ? '未通过：' + p0NotPass.map((k) => k.id).join(', ') : '全部通过'
    },
    {
      id: 'G3',
      desc: '可删除性（#16 / #25 / #26）',
      pass: ['16', '25', '26'].every((id) => byId.get(id)?.status === 'pass'),
      note: '现设计下这三条在实现前必然失败'
    },
    {
      id: 'G4',
      desc: '回滚演练（#18）',
      pass: byId.get('18')?.status === 'pass',
      note: '须人工按 §14.1 A/B 执行并记录两个时间戳'
    },
    {
      id: 'G5',
      desc: '未知项清零（UNKNOWNS.md 19 条全 closed）',
      pass: null,
      note: '人工核对文档'
    },
    {
      id: 'G6',
      desc: '基线环境齐备（每条结果 env.cpuThrottle 已回填）',
      pass: envOk,
      note: envOk ? 'ok' : '仍有 unknown'
    }
  ];

  console.log('\n放行 Gate（BLOCKERS.md）\n');
  for (const g of gates) {
    const mark = g.pass === true ? c.ok('PASS') : g.pass === false ? c.bad('FAIL') : c.warn('人工');
    console.log(`${pad(g.id, 5)}${pad(mark, 12)}${g.desc}`);
    if (g.note) console.log(c.dim('      ↳ ' + g.note));
  }

  const hardFail = gates.some((g) => g.pass === false);
  console.log('');
  if (hardFail) {
    console.log(c.bad('结论：未达放行条件。不得使用「已验收 / 生产就绪」表述。'));
    process.exit(1);
  }
  console.log(c.ok('结论：机械可判项均通过；仍须人工确认 G1 / G5。'));
}

// ------------------------------------------------------------------ 入口
const ARGV = process.argv.slice(2);
const cmd = ARGV[0];
const flagValue = (name) => {
  const i = ARGV.indexOf(name);
  return i >= 0 ? ARGV[i + 1] : undefined;
};
const positional = ARGV[1] && ARGV[1].charAt(0) !== '-' ? ARGV[1] : undefined;
const opts = { throttle: flagValue('--throttle') };

try {
  if (cmd === '--list') await cmdList();
  else if (cmd === '--ingest') await cmdIngest(positional || flagValue('--file'), opts);
  else if (cmd === '--check') await cmdCheck();
  else if (cmd === '--gate') await cmdGate();
  else {
    console.log(`qa/acceptance.mjs

  --list                列出全部用例与归档状态
  --ingest <file>       把 selftest 面板导出的 JSON 拆成 qa/results/<id>.json
                        [--throttle none|4x|6x] 统一回填 env.cpuThrottle
  --check               校验归档完整性（字段 / id / 空断言 / 基线环境）
  --gate                输出 BLOCKERS.md 放行 Gate
`);
  }
} catch (err) {
  console.error(c.bad('执行失败：' + err.message));
  process.exit(2);
}
