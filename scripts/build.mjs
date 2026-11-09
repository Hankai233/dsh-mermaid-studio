#!/usr/bin/env node
/**
 * scripts/build.mjs — assemble the browser half and validate the host half.
 *
 * Why not esbuild (the design's original plan): the mermaid package already
 * ships a single-file, offline IIFE (`dist/mermaid.min.js`) built by its own
 * pipeline, and our client code is plain ES5-era JavaScript with no imports. A
 * custom concatenator is both simpler and *more* reproducible than a bundler:
 * no lockfile, no platform binary, no postinstall download — two clean builds
 * differ only if the inputs differ, and the script prints the hash to prove it.
 *
 * The one transformation applied to vendored code is the last line of
 * mermaid.min.js: it assigns the engine to `globalThis.mermaid`. We need a
 * function that returns a *fresh* engine instance (design §5.1's escape hatch
 * for a render that never settles), so that line is rewritten to expose the
 * instance locally. The script fails loudly if the expected line is not found
 * exactly once, so a mermaid upgrade cannot silently produce a bundle that
 * leaks instances onto the global object.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'src', 'client');
const OUT = path.join(ROOT, 'lib');

const CHUNKS = [
  'config.js',
  'stats.js',
  'fence.js',
  'key.js',
  'theme.js',
  'sanitize.js',
  'render.js',
  'queue.js',
  'cache.js',
  'styles.js',
  'viewport.js',
  'export.js',
  'viewer.js',
  'card.js',
  'diag.js',
  'scan.js',
  'index.js',
  'register.js'
];

const VENDOR_TAIL = 'globalThis["mermaid"] = globalThis.__esbuild_esm_mermaid_nm["mermaid"].default;';

function fail(message) {
  console.error('[build] ' + message);
  process.exit(1);
}

async function readPinnedMermaid() {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const pinned = pkg.devDependencies?.mermaid || pkg.dependencies?.mermaid;
  if (!pinned || !/^\d+\.\d+\.\d+/.test(pinned)) {
    fail('package.json must pin an exact mermaid version (got: ' + pinned + ')');
  }
  return pinned;
}

function candidateRoots() {
  const roots = [path.join(ROOT, 'node_modules', 'mermaid')];
  if (process.env.DSH_PROFILE_DIR) roots.push(path.join(process.env.DSH_PROFILE_DIR, 'node_modules', 'mermaid'));
  if (process.env.DSH_HOME) roots.push(path.join(process.env.DSH_HOME, 'profiles', 'desktop', 'node_modules', 'mermaid'));
  roots.push(path.join(process.cwd(), 'node_modules', 'mermaid'));
  return roots;
}

async function locateMermaid(pinned) {
  for (const root of candidateRoots()) {
    const pkgFile = path.join(root, 'package.json');
    if (!existsSync(pkgFile)) continue;
    const pkg = JSON.parse(await readFile(pkgFile, 'utf8'));
    if (pkg.version !== pinned) {
      console.warn(`[build] skip ${root}: version ${pkg.version} != pinned ${pinned}`);
      continue;
    }
    const dist = path.join(root, 'dist', 'mermaid.min.js');
    if (!existsSync(dist)) continue;
    return { root, dist, version: pkg.version };
  }
  fail(
    'mermaid@' +
      pinned +
      ' not found. Install it (pnpm add -D mermaid@' +
      pinned +
      ') or point DSH_PROFILE_DIR at a profile that has it.'
  );
}

function wrapMermaid(source, version) {
  const hits = source.split(VENDOR_TAIL).length - 1;
  if (hits !== 1) {
    fail(`vendor tail statement found ${hits} times (expected exactly 1) — mermaid ${version} changed its output shape`);
  }
  const rewritten = source.replace(
    VENDOR_TAIL,
    '__mmsExported = __esbuild_esm_mermaid_nm["mermaid"].default;'
  );
  if (/\bexport\s|\bimport\s/.test(rewritten.slice(0, 2000))) {
    fail('vendor bundle looks like an ES module; expected a single-file IIFE');
  }
  return [
    '/* Vendored mermaid@' + version + ' (MIT). Wrapped so each call evaluates a fresh instance. */',
    'function __mmsFreshMermaid() {',
    "  'use strict';",
    '  var __mmsExported;',
    // Shadowing globalThis keeps the engine's scratch state off the page's
    // global object; only the engine instance itself escapes.
    '  var globalThis = { injected: { includeLargeFeatures: true, profiling: false, version: "0.0.0" } };',
    rewritten,
    '  return __mmsExported;',
    '}'
  ].join('\n');
}

async function build() {
  const pinned = await readPinnedMermaid();
  const located = await locateMermaid(pinned);
  const vendor = await readFile(located.dist, 'utf8');

  const parts = [];
  const chunkHashes = [];
  for (const name of CHUNKS) {
    const file = path.join(SRC, name);
    if (!existsSync(file)) fail('missing chunk: ' + name);
    const text = await readFile(file, 'utf8');
    chunkHashes.push(name + ':' + createHash('sha256').update(text).digest('hex').slice(0, 12));
    parts.push(`\n/* ── ${name} ── */\n` + text);
  }

  const banner = [
    '/*! dsh-mermaid-studio — browser half.',
    ' *  Built from src/client/*.js; do not edit lib/client.js by hand.',
    ` *  mermaid ${pinned} · sanitizer v1 · chunks: ${chunkHashes.join(' ')}`,
    ' */'
  ].join('\n');

  const bootstrap = [
    '(function () {',
    '  "use strict";',
    wrapMermaid(vendor, pinned),
    '  globalThis.__mmsFreshMermaid = __mmsFreshMermaid;',
    '  globalThis.__MMS_MERMAID_VERSION__ = ' + JSON.stringify(pinned) + ';',
    '})();'
  ].join('\n');

  let output = [banner, bootstrap].concat(parts).join('\n') + '\n';

  // Diagnostic builds only: dumps the live DOM contract to a JSON download,
  // because the desktop GUI has no console to read.
  if (process.env.MMS_AUDIT === '1') {
    const hits = output.split('AUDIT: false').length - 1;
    if (hits !== 1) fail('audit flag marker not found exactly once (got ' + hits + ')');
    output = output.replace('AUDIT: false', 'AUDIT: true');
    console.log('[build] audit dump ENABLED');
  }

  await mkdir(OUT, { recursive: true });
  await writeFile(path.join(OUT, 'client.js'), output, 'utf8');

  // Host half: plain ESM, copied so lib/ is the only shipped directory.
  const hostSource = await readFile(path.join(ROOT, 'src', 'host', 'index.js'), 'utf8');
  await writeFile(path.join(OUT, 'index.js'), hostSource, 'utf8');

  const hash = createHash('sha256').update(output).digest('hex');
  const size = (await stat(path.join(OUT, 'client.js'))).size;
  console.log('[build] mermaid      ' + pinned + '  (' + located.root + ')');
  console.log('[build] chunks       ' + CHUNKS.length);
  console.log('[build] lib/client.js ' + (size / 1024 / 1024).toFixed(2) + ' MB');
  console.log('[build] sha256       ' + hash);
  console.log('[build] lib/index.js  ' + (await stat(path.join(OUT, 'index.js'))).size + ' bytes');
  return hash;
}

build().catch((error) => {
  console.error('[build] failed:', error);
  process.exit(1);
});
