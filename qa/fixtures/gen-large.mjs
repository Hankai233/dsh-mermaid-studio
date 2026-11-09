#!/usr/bin/env node
/**
 * qa/fixtures/gen-large.mjs —— 生成大体量 fixture（不提交进仓库）
 *
 * 产出的三个文件对应：
 *   20-diagrams.md   → 验收 #1（20 张图长消息，性能基线）
 *   oversize.md      → 验收 #22（归一化后 > 50,000 字符，必须被闸门拦下）
 *   same-source.md   → 边界 Bd11（同一源码出现 5 次：渲染 ID 不冲突、缓存只 1 条）
 *
 * 用法：
 *   node qa/fixtures/gen-large.mjs
 *   node qa/fixtures/gen-large.mjs --count 20 --nodes 60
 *
 * 注意：这里生成的是**源码**长度，不是 SVG 字节数。300 KB 的 SVG 通常只对应
 * 几 KB 的源码，所以不要按「源码 300 KB」造数据 —— 那会先被 50,000 字符闸门拦掉。
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function opt(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const COUNT = opt('--count', 20);
const NODES = opt('--nodes', 60);
const OVERSIZE_TARGET = opt('--chars', 60000);

function diagram(seed, nodes) {
  const lines = [`graph TD`, `  R${seed}["会话 ${seed} 根节点"]`];
  for (let i = 1; i <= nodes; i++) {
    lines.push(`  N${seed}_${i}["节点 ${seed}-${i} 的标签文本"]`);
    if (i === 1) lines.push(`  R${seed} --> N${seed}_${i}`);
    else lines.push(`  N${seed}_${i - 1} --> N${seed}_${i}`);
  }
  return '```mermaid\n' + lines.join('\n') + '\n```';
}

async function main() {
  // 1) 20 张图的长消息
  const blocks = [];
  for (let i = 1; i <= COUNT; i++) {
    blocks.push(`### 图 ${i}`);
    blocks.push(diagram(i, NODES));
  }
  const many = `# 20 张图的长消息（验收 #1）\n\n> 逐屏滚动到底，观察全部成图、长任务次数与滚动可交互性。\n\n` + blocks.join('\n\n') + '\n';
  await writeFile(path.join(HERE, '20-diagrams.md'), many, 'utf8');

  // 2) 超长围栏：必须超过 mermaid 的 MAX_TEXTLENGTH = 5e4
  let src = 'graph TD\n';
  let i = 0;
  while (src.length < OVERSIZE_TARGET) {
    i += 1;
    src += `  S${i}["超长图节点 ${i}"] --> S${i + 1}["超长图节点 ${i + 1}"]\n`;
  }
  const oversize = `# 超长围栏（验收 #22）\n\n> 期望：直接 error「源码过长，已跳过渲染」，不进队列，不显示「重试」。\n> 本围栏字符数：${src.length}\n\n\`\`\`mermaid\n${src}\`\`\`\n`;
  await writeFile(path.join(HERE, 'oversize.md'), oversize, 'utf8');

  // 3) 同一源码 5 次
  const one = diagram(99, 8);
  const same = `# 同一源码出现 5 次（Bd11）\n\n> 期望：渲染 ID 不冲突、无残留容器；缓存只 1 条、hits = 5。\n\n` + Array.from({ length: 5 }, () => one).join('\n\n') + '\n';
  await writeFile(path.join(HERE, 'same-source.md'), same, 'utf8');

  console.log('已生成：');
  console.log('  20-diagrams.md  ' + many.length + ' 字符 / ' + COUNT + ' 张图 × ' + NODES + ' 节点');
  console.log('  oversize.md     ' + src.length + ' 字符（> 50000 即应被闸门拦下）');
  console.log('  same-source.md  同一图样 ×5');
}

await main();
