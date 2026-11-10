/**
 * Unit tests for the pure client modules — the ones that decide *what* gets
 * rendered and *which cache entry* it maps to. DOM-dependent behaviour (SVG
 * injection, canvas export, observers) is covered by the local acceptance harness (not shipped) in a
 * real browser instead of a DOM stub that would only test the stub.
 *
 * Each chunk is loaded from its shipped bytes in a fresh VM context, so the
 * tests exercise exactly what build.mjs concatenates into lib/client.js.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHUNKS = path.join(HERE, '..', 'src', 'client');

async function loadMMS(chunks = ['config.js', 'stats.js', 'fence.js', 'key.js', 'theme.js']) {
  const sandbox = { console, TextEncoder, setTimeout, clearTimeout, Date, Math, JSON };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  for (const name of chunks) {
    const source = await readFile(path.join(CHUNKS, name), 'utf8');
    vm.runInContext(source, context, { filename: name });
  }
  return context.__MMS__;
}

/** Minimal stand-in for the host's code block markup. */
function makeBlock({ lang = 'mermaid', source = '', shiki = false, noLabel = false } = {}) {
  const bannerLang = noLabel ? '' : lang;
  const lines = shiki
    ? source.split('\n').map((line) => ({ tagName: 'SPAN', className: 'line', textContent: line }))
    : [{ textContent: source }];
  const block = {
    nodeType: 1,
    className: 'md-code-block',
    _bannerLang: bannerLang,
    _lines: lines,
    querySelector(selector) {
      if (selector === '[data-code-block-banner] [data-text-interaction-exclude]') {
        return bannerLang ? { textContent: bannerLang } : null;
      }
      if (selector === '[data-code-block-banner]') {
        return { firstElementChild: { textContent: bannerLang }, textContent: bannerLang };
      }
      if (selector === '[data-code-block-content]') return this;
      if (selector === 'code' || selector === 'pre') {
        return { textContent: lines.map((line) => line.textContent).join('\n') };
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[class*="language-"]') return [];
      return [];
    }
  };
  return block;
}

test('sha1 matches known vectors', async () => {
  const MMS = await loadMMS();
  assert.equal(MMS.key.sha1(''), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
  assert.equal(MMS.key.sha1('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(
    MMS.key.sha1('The quick brown fox jumps over the lazy dog'),
    '2fd4e1c67a2d28fced849ee1bb76e7391b93eb12'
  );
  assert.equal(MMS.key.sha1('中文与 emoji 🎉'), MMS.key.sha1('中文与 emoji 🎉'));
  assert.notEqual(MMS.key.sha1('a'), MMS.key.sha1('b'));
});

test('cache key is stable, order-fixed and refuses sentinels', async () => {
  const MMS = await loadMMS();
  const input = {
    mermaidVersion: '11.17.2',
    theme: 'default',
    scopeHash: 'deadbeef',
    themeRevision: 'default@font/12px',
    fontCode: 'Maple/12px',
    renderConfig: 'theme=default;font=x;securityLevel=strict;flowchart=default;maxTextSize=50000',
    source: 'graph TD\n A --> B'
  };
  const a = MMS.key.buildKey(input);
  const b = MMS.key.buildKey({ ...input });
  assert.equal(a, b);
  // Every appearance input must move the key, or "changed the font" would keep
  // hitting a stale entry (the failure mode the original design called out).
  assert.notEqual(a, MMS.key.buildKey({ ...input, theme: 'dark' }));
  assert.notEqual(a, MMS.key.buildKey({ ...input, fontCode: 'Other/13px' }));
  assert.notEqual(a, MMS.key.buildKey({ ...input, mermaidVersion: '11.18.0' }));
  assert.notEqual(a, MMS.key.buildKey({ ...input, scopeHash: 'cafe' }));
  assert.notEqual(a, MMS.key.buildKey({ ...input, source: input.source + ' ' }));
  assert.throws(() => MMS.key.buildKey({ ...input, fontCode: undefined }), /sentinel/);
  assert.throws(() => MMS.key.buildKey({ ...input, themeRevision: 'unknown' }), /sentinel/);
});

test('normalisation is idempotent and strips CRLF noise', async () => {
  const MMS = await loadMMS();
  const raw = '\r\n\r\ngraph TD\r\n  A --> B\r\n\r\n\r\n\r\n  B --> C\r\n\r\n';
  const once = MMS.fence.normalizeSource(raw);
  assert.equal(once, 'graph TD\n  A --> B\n\n  B --> C');
  assert.equal(MMS.fence.normalizeSource(once), once);
});

test('language detection uses the three-way union without claiming python', async () => {
  const MMS = await loadMMS();
  assert.equal(MMS.fence.isMermaidBlock(makeBlock({ lang: 'mermaid', source: 'graph TD\n A-->B' })), true);
  assert.equal(MMS.fence.isMermaidBlock(makeBlock({ lang: 'mmd', source: 'graph TD\n A-->B' })), true);
  // A labelled python fence whose first line starts with `graph` must stay python.
  assert.equal(MMS.fence.isMermaidBlock(makeBlock({ lang: 'python', source: 'graph = {"a": 1}' })), false);
  assert.equal(MMS.fence.isMermaidBlock(makeBlock({ lang: 'typescript', source: 'flowchart LR' })), false);
  // No label at all: the strict first-line rule may claim it.
  assert.equal(MMS.fence.isMermaidBlock(makeBlock({ noLabel: true, source: 'flowchart LR\n A-->B' })), true);
  assert.equal(MMS.fence.isMermaidBlock(makeBlock({ noLabel: true, source: 'graph = 1' })), false);
  // shiki path: spans, no language class, no label
  const shiki = makeBlock({ noLabel: true, shiki: true, source: 'sequenceDiagram\n Alice->>Bob: hi' });
  assert.equal(MMS.fence.isMermaidBlock(shiki), true);
});

test('empty and directive-only fences are not renderable', async () => {
  const MMS = await loadMMS();
  assert.equal(MMS.fence.parseFence(makeBlock({ source: '   \n\n  ' })).empty, true);
  const onlyDirective = MMS.fence.parseFence(
    makeBlock({ source: '%%{init: {"theme":"dark"}}%%\n' })
  );
  assert.equal(onlyDirective.empty, true);
  const normal = MMS.fence.parseFence(makeBlock({ source: 'graph TD\n A-->B' }));
  assert.equal(normal.empty, false);
  assert.equal(normal.source, 'graph TD\n A-->B');
});

test('governance keys are stripped from init directives, appearance keys survive', async () => {
  const MMS = await loadMMS();
  const cases = [
    {
      name: 'securityLevel removed',
      input: '%%{init: {"securityLevel":"loose"}}%%\ngraph TD\n A-->B',
      mustNot: ['securityLevel'],
      mustInclude: ['graph TD']
    },
    {
      name: 'htmlLabels / maxTextSize / maxEdges removed',
      input: '%%{init: {"htmlLabels": true, "maxTextSize": 999999, "maxEdges": 5}}%%\ngraph TD\n A-->B',
      mustNot: ['htmlLabels', 'maxTextSize', 'maxEdges'],
      mustInclude: ['graph TD']
    },
    {
      name: 'fontFamily removed, theme kept',
      input: '%%{init: {"theme":"dark","fontFamily":"x; } body{display:none} .a{"}}%%\ngraph TD\n A-->B',
      mustNot: ['fontFamily', 'body{display:none}'],
      mustInclude: ['"theme":"dark"', 'graph TD']
    },
    {
      name: 'themeVariables dropped wholesale',
      input: '%%{init: {"themeVariables": {"primaryColor": "#f00"}}}%%\ngraph TD\n A-->B',
      mustNot: ['themeVariables'],
      mustInclude: ['graph TD']
    },
    {
      name: 'nested governance subkey dropped, appearance kept',
      input: '%%{init: {"flowchart": {"htmlLabels": true, "curve": "basis"}}}%%\ngraph TD\n A-->B',
      mustNot: ['htmlLabels'],
      mustInclude: ['"curve":"basis"']
    },
    {
      name: 'unparsable directive dropped entirely',
      input: '%%{init: {"theme": "dark" %%}\ngraph TD\n A-->B',
      mustNot: ['init'],
      mustInclude: ['graph TD']
    },
    {
      name: 'non-init directives are left alone',
      input: '%%{wrap}%%\ngraph TD\n A-->B',
      mustInclude: ['%%{wrap}%%']
    }
  ];
  for (const entry of cases) {
    const result = MMS.fence.stripGovernanceKeys(entry.input);
    for (const needle of entry.mustNot || []) {
      assert.ok(!result.source.includes(needle), `${entry.name}: still contains ${needle} → ${result.source}`);
    }
    for (const needle of entry.mustInclude || []) {
      assert.ok(result.source.includes(needle), `${entry.name}: lost ${needle} → ${result.source}`);
    }
  }
});

test('frontmatter config block is filtered, other frontmatter survives', async () => {
  const MMS = await loadMMS();
  const source = [
    '---',
    'title: 我的图',
    'config:',
    '  theme: dark',
    '  securityLevel: loose',
    '  flowchart:',
    '    htmlLabels: true',
    '    curve: basis',
    '  themeVariables:',
    '    fontFamily: x',
    '---',
    'graph TD',
    ' A-->B'
  ].join('\n');
  const result = MMS.fence.stripGovernanceKeys(source);
  assert.ok(result.rejected, 'should report a rejected key');
  assert.ok(result.source.includes('title: 我的图'), 'kept unrelated frontmatter');
  assert.ok(result.source.includes('theme: dark'), 'kept allowed key');
  assert.ok(result.source.includes('curve: basis'), 'kept appearance subkey');
  assert.ok(!result.source.includes('securityLevel'), 'dropped governance key');
  assert.ok(!result.source.includes('htmlLabels'), 'dropped nested governance key');
  assert.ok(!result.source.includes('themeVariables'), 'dropped themeVariables block with its subtree');
  assert.ok(result.source.includes('graph TD'));
});

test('over-long source is flagged, not queued', async () => {
  const MMS = await loadMMS();
  const huge = 'graph TD\n' + '  A --> B\n'.repeat(8000);
  const parsed = MMS.fence.parseFence(makeBlock({ source: huge }));
  assert.equal(parsed.empty, false);
  assert.equal(parsed.overLong, true);
});

test('config resolution prefers injection, then localStorage, and reports the source', async () => {
  const sandbox = {
    console,
    TextEncoder,
    store: new Map(),
    setTimeout,
    clearTimeout
  };
  sandbox.globalThis = sandbox;
  sandbox.localStorage = {
    getItem: (key) => (sandbox.store.has(key) ? sandbox.store.get(key) : null),
    setItem: (key, value) => sandbox.store.set(key, String(value)),
    removeItem: (key) => sandbox.store.delete(key),
    get length() {
      return sandbox.store.size;
    },
    key: (index) => Array.from(sandbox.store.keys())[index] ?? null
  };
  const context = vm.createContext(sandbox);
  for (const name of ['config.js', 'stats.js']) {
    vm.runInContext(await readFile(path.join(CHUNKS, name), 'utf8'), context, { filename: name });
  }
  const MMS = context.__MMS__;

  let cfg = MMS.resolveConfig();
  assert.equal(cfg.source, 'default');
  assert.equal(cfg.cacheEnabled, true);
  assert.equal(cfg.missing, 1);
  assert.equal(cfg.themeMode, undefined, 'theme is follow-only: no config key any more');

  MMS.writeLs('mms:config:cacheEnabled', 'false');
  cfg = MMS.resolveConfig();
  assert.equal(cfg.source, 'localStorage');
  assert.equal(cfg.cacheEnabled, false);

  sandbox.__DSH_MMS_CONFIG__ = { cacheEnabled: true };
  cfg = MMS.resolveConfig();
  assert.equal(cfg.source, 'inject');
  assert.equal(cfg.cacheEnabled, true, 'injected value wins over the stored override');

  MMS.clearPrefs();
  assert.equal(sandbox.store.size, 0, 'uninstall clears every mms:* key');
});

test('theme always follows the host dark attribute', async () => {
  const MMS = await loadMMS();
  assert.equal(MMS.theme.resolve(), 'default');
  assert.equal(MMS.theme.revision(), 'default@na');
  // Nothing in the public surface may allow an override any more.
  assert.equal(MMS.theme.set, undefined);
  assert.equal(MMS.theme.next, undefined);
  assert.equal(MMS.theme.preference, undefined);
});

test('cache-key version never evaluates the 3.5 MB engine', async () => {
  // Regression for the first-render freeze: keyFor() used to call the engine's
  // version getter, which evaluated mermaid (~190 ms measured in Chromium) even
  // when every diagram was already cached.
  const sandbox = { console, TextEncoder, setTimeout, clearTimeout, Date, Math, JSON };
  sandbox.globalThis = sandbox;
  sandbox.__MMS_MERMAID_VERSION__ = '11.17.2';
  let engineCalls = 0;
  sandbox.__mmsFreshMermaid = function () {
    engineCalls += 1;
    return {
      initialize: function () {},
      render: function () {
        return Promise.resolve({ svg: '<svg id="x" viewBox="0 0 1 1"></svg>' });
      }
    };
  };
  const context = vm.createContext(sandbox);
  for (const name of ['config.js', 'stats.js', 'render.js']) {
    vm.runInContext(await readFile(path.join(CHUNKS, name), 'utf8'), context, { filename: name });
  }
  const renderer = context.__MMS__.createRenderer({ stats: { note() {}, error() {} } });

  assert.equal(renderer.getVersion(), '11.17.2');
  assert.equal(engineCalls, 0, 'reading the version must not evaluate the engine');

  renderer.warm();
  assert.equal(engineCalls, 1, 'warm() is the explicit way to pay the init cost');

  renderer.reset();
  assert.equal(engineCalls, 2, 'reset() abandons the stuck instance');
});
