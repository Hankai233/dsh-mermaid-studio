/**
 * Cache identity vs. the sentinel guard.
 *
 * The guard exists so a *missing* field can never look like a cache hit on a
 * different font/theme. It used to be a substring test on the part value, which
 * also fired for `src:` — and `src:` is the diagram text, where words like
 * `undefined` are legal content. The throw happened in `createRecord()` before
 * the card existed, so the diagram silently never rendered. These tests pin
 * both halves: legal content passes, a genuinely missing field still throws.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHUNKS = path.join(HERE, '..', 'src', 'client');

async function loadMMS() {
  const sandbox = { console, TextEncoder, Math, Date, JSON };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  for (const name of ['config.js', 'key.js']) {
    vm.runInContext(await readFile(path.join(CHUNKS, name), 'utf8'), context, { filename: name });
  }
  return context.__MMS__;
}

const BASE = {
  mermaidVersion: '11.17.2',
  theme: 'default',
  scopeHash: 'deadbeef',
  themeRevision: 'default@font/12px',
  fontCode: 'Maple/12px',
  renderConfig: 'theme=default;font=x;securityLevel=strict;flowchart=default;maxTextSize=50000',
  source: 'graph TD\n A --> B'
};

test('a diagram that merely mentions a sentinel word still gets a key', async () => {
  const MMS = await loadMMS();
  const sources = [
    'graph TD\n A["is x undefined?"] --> B',
    'graph TD\n A["null"] --> B',
    'graph TD\n A["unknown property"] --> B',
    'stateDiagram-v2\n undefined --> B',
    'graph TD\n A["does this return undefined?"] --> B\n B["or null?"] --> A'
  ];
  for (const source of sources) {
    const key = MMS.key.buildKey({ ...BASE, source });
    assert.match(key, /^[0-9a-f]{40}$/, 'a legal source must produce a key: ' + source);
  }
  // The sentinel words are content, so they still move the key like any text.
  assert.notEqual(
    MMS.key.buildKey({ ...BASE, source: sources[0] }),
    MMS.key.buildKey({ ...BASE, source: sources[1] })
  );
  // And the guard did not become a no-op for the appearance inputs.
  assert.notEqual(
    MMS.key.buildKey({ ...BASE, source: sources[3] }),
    MMS.key.buildKey({ ...BASE, source: sources[3] + ' ' })
  );
});

test('a missing field is still a sentinel, matched as a whole value', async () => {
  const MMS = await loadMMS();
  const build = (patch) => MMS.key.buildKey({ ...BASE, ...patch });

  // String concatenation makes a missing field the exact value.
  assert.throws(() => build({ fontCode: undefined }), /sentinel/);
  assert.throws(() => build({ themeRevision: undefined }), /sentinel/);
  assert.throws(() => build({ renderConfig: undefined }), /sentinel/);
  assert.throws(() => build({ mermaidVersion: undefined }), /sentinel/);
  assert.throws(() => build({ scopeHash: undefined }), /sentinel/);
  // An input that *is* the sentinel word (not a sentence containing it).
  assert.throws(() => build({ theme: 'unknown' }), /sentinel/);
  assert.throws(() => build({ themeRevision: 'null' }), /sentinel/);

  // A longer value containing the word is a normal value, not a sentinel.
  assert.match(build({ themeRevision: 'custom-unknown-ish' }), /^[0-9a-f]{40}$/);
  assert.match(build({ fontCode: 'Noto-Sans-null/13px' }), /^[0-9a-f]{40}$/);
});

test('debugKey reports the parts a key was built from, source included', async () => {
  const MMS = await loadMMS();
  const source = 'graph TD\n A["is x undefined?"] --> B';
  const debug = MMS.key.debugKey({ ...BASE, source });
  assert.equal(debug.key, MMS.key.buildKey({ ...BASE, source }));
  assert.ok(debug.parts.indexOf('src:' + source) >= 0, 'the source is part of the key material');
});
