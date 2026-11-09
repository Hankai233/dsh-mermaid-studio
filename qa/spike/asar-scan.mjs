#!/usr/bin/env node
/**
 * qa/spike/asar-scan.mjs —— 从宿主 app.asar 里取 DOM 契约证据（UNK-07 / UNK-08）
 *
 * 只做只读扫描：在 asar 原始字节里找 needle，打印命中处前后窗口。
 * 不做解包、不写被扫描的目录。
 *
 * 用法：
 *   node qa/spike/asar-scan.mjs md-code-block data-code-block-banner
 *   node qa/spike/asar-scan.mjs --ctx=400 --max=5 <needle> [needle2 ...]
 */
import { open } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_ASAR = path.join(
  process.env['ProgramFiles(x86)'] || process.env.ProgramFiles || 'C:/Program Files (x86)',
  'dsh',
  'resources',
  'app.asar'
);
const ASAR = process.env.DSH_ASAR || DEFAULT_ASAR;
const argv = process.argv.slice(2);
const ctxArg = argv.find((a) => a.startsWith('--ctx='));
const maxArg = argv.find((a) => a.startsWith('--max='));
const CTX = ctxArg ? Number(ctxArg.slice(6)) : 300;
const MAX = maxArg ? Number(maxArg.slice(6)) : 6;
const needles = argv.filter((a) => !a.startsWith('--')).map((s) => Buffer.from(s, 'utf8'));

if (needles.length === 0) {
  console.error('用法: node qa/spike/asar-scan.mjs [--ctx=300] [--max=6] <needle> [...]');
  process.exit(2);
}

const fh = await open(ASAR, 'r');
const { size } = await fh.stat();
const CHUNK = 8 * 1024 * 1024;
const overlap = Math.max(...needles.map((n) => n.length)) + CTX * 2;

const found = needles.map(() => []);
let carry = Buffer.alloc(0);
let base = 0;

for (let off = 0; off < size; off += CHUNK) {
  const len = Math.min(CHUNK, size - off);
  const buf = Buffer.alloc(len);
  await fh.read(buf, 0, len, off);
  const hay = carry.length ? Buffer.concat([carry, buf]) : buf;

  for (let i = 0; i < needles.length; i += 1) {
    if (found[i].length >= MAX) continue;
    let from = 0;
    while (found[i].length < MAX) {
      const at = hay.indexOf(needles[i], from);
      if (at < 0) break;
      const start = Math.max(0, at - CTX);
      const end = Math.min(hay.length, at + needles[i].length + CTX);
      found[i].push({ pos: base - carry.length + at, text: hay.subarray(start, end).toString('utf8') });
      from = at + needles[i].length;
    }
  }

  carry = hay.subarray(Math.max(0, hay.length - overlap));
  base = off + len;
}

await fh.close();

for (let i = 0; i < needles.length; i += 1) {
  console.log(`\n===== ${needles[i].toString('utf8')} —— 命中 ${found[i].length} 处（最多打印 ${MAX}）=====`);
  for (const hit of found[i]) {
    const clean = hit.text.replace(/[^\x20-\x7e\n]/g, '·');
    console.log(`\n--- @${hit.pos} ---\n${clean}`);
  }
}
