/**
 * fence.js: the two ways one fence could cost unbounded work.
 *
 * 1. `stripInitDirectives()` used to recurse on the un-scanned tail for every
 *    directive it had to *keep* (`%%{wrap}%%` and friends). The call depth was
 *    therefore the number of directives: ~5000 of them (≈60 KB) threw
 *    `Maximum call stack size exceeded`, scan.js' flush turned that into a stats
 *    counter, and the fence never rendered — with no message anywhere.
 * 2. `parseFence()` stripped first and measured `MAX_SOURCE_CHARS` last, so a
 *    200 KB fence was fully parsed before being discarded.
 *
 * Each chunk is loaded from its shipped bytes in a fresh VM context, exactly as
 * build.mjs concatenates it into lib/client.js.
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
  const sandbox = { console, TextEncoder, setTimeout, clearTimeout, Date, Math, JSON };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  for (const name of ['config.js', 'fence.js']) {
    vm.runInContext(await readFile(path.join(CHUNKS, name), 'utf8'), context, { filename: name });
  }
  return context.__MMS__;
}

/** Minimal stand-in for the host's code block markup (see fence.test.mjs). */
function makeBlock({ lang = 'mermaid', source = '' } = {}) {
  return {
    nodeType: 1,
    className: 'md-code-block',
    querySelector(selector) {
      if (selector === '[data-code-block-banner] [data-text-interaction-exclude]') {
        return { textContent: lang };
      }
      if (selector === '[data-code-block-banner]') {
        return { firstElementChild: { textContent: lang }, textContent: lang };
      }
      if (selector === 'pre code' || selector === 'pre' || selector === 'code') {
        return { textContent: source };
      }
      if (selector === '[data-code-block-content]') return { textContent: source };
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
}

function count(haystack, needle) {
  let total = 0;
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    total += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return total;
}

test('thousands of non-init directives no longer overflow the stack', async () => {
  const MMS = await loadMMS();
  // The reported failure threshold was ~5000 directives (≈60 KB). Use more so
  // the test fails loudly if the recursive shape ever comes back.
  const COUNT = 6000;
  const source = 'graph TD\n' + '%%{wrap}%%\n'.repeat(COUNT) + '  A --> B';

  const result = MMS.fence.stripGovernanceKeys(source);

  assert.equal(result.rejected, false, 'kept directives are not rejections');
  assert.equal(count(result.source, '%%{wrap}%%'), COUNT, 'every kept directive survives');
  assert.ok(result.source.startsWith('graph TD'), 'the body is preserved in order');
  assert.ok(result.source.endsWith('A --> B'), 'the text after the directives survives');
});

test('init filtering still works inside a long directive stream', async () => {
  const MMS = await loadMMS();
  const COUNT = 5500;
  const source =
    '%%{init: {"securityLevel":"loose","theme":"dark"}}%%\n' +
    '%%{wrap}%%\n'.repeat(COUNT) +
    'graph TD\n  A --> B';

  const result = MMS.fence.stripGovernanceKeys(source);

  assert.ok(!result.source.includes('securityLevel'), 'the governance key is gone');
  assert.ok(result.source.includes('"theme":"dark"'), 'the appearance key survives');
  assert.ok(
    result.source.startsWith('%%{init: {"theme":"dark"}}%%'),
    'the init directive is rewritten in canonical form and kept first: ' +
      result.source.slice(0, 60)
  );
  assert.equal(result.rejected, true, 'dropping a key is reported');
  assert.equal(count(result.source, '%%{wrap}%%'), COUNT);
});

test('a canonical init directive is kept verbatim, not re-parsed forever', async () => {
  const MMS = await loadMMS();
  const input = '%%{init: {"theme":"dark"}}%%\ngraph TD\n  A --> B';
  const result = MMS.fence.stripGovernanceKeys(input);
  assert.equal(result.rejected, false);
  assert.equal(result.source, input, 'already-canonical init survives byte for byte');
});

test('an unterminated directive still drops only its line', async () => {
  const MMS = await loadMMS();
  const result = MMS.fence.stripGovernanceKeys('graph TD\n%%{wrap\n  A --> B');
  assert.equal(result.rejected, true);
  assert.ok(!result.source.includes('%%{wrap'), 'the broken directive is dropped');
  assert.ok(result.source.includes('graph TD'), 'the body below it is kept');
  assert.ok(result.source.includes('A --> B'));
});

test('an over-long fence is rejected before any directive work happens', async () => {
  const MMS = await loadMMS();
  // ~130 KB of *non-canonical* init directives: stripping would rewrite every
  // one of them to canonical JSON (and used to recurse per directive).
  const raw = 'graph TD\n' + "%%{init: {theme: 'dark'}}%%\n".repeat(5000) + '  A --> B';
  assert.ok(raw.length > MMS.CONFIG.MAX_SOURCE_CHARS, 'the fixture must exceed the limit');

  const started = Date.now();
  const parsed = MMS.fence.parseFence(makeBlock({ source: raw }));
  const elapsed = Date.now() - started;

  assert.equal(parsed.overLong, true);
  assert.equal(parsed.empty, false);
  // The shape of the result is unchanged for callers (scan.js reads overLong
  // and never renders the source), so the other fields must still be there.
  assert.ok(parsed.block && 'source' in parsed && 'rejected' in parsed);
  // Proof that nothing was stripped: a stripped source would carry canonical
  // JSON (`{"theme":"dark"}`), not the original spelling.
  assert.ok(
    parsed.source.includes("%%{init: {theme: 'dark'}}%%"),
    'the short-circuit must not run the stripping pass'
  );
  // A smoke bound, not a benchmark: the short-circuit is a length compare,
  // while parsing this fixture is tens of milliseconds plus a 5000-deep stack.
  assert.ok(elapsed < 200, 'over-long fences must not be parsed first (took ' + elapsed + 'ms)');
});

test('a fence under the limit is still stripped normally', async () => {
  const MMS = await loadMMS();
  const parsed = MMS.fence.parseFence(
    makeBlock({ source: '%%{init: {"securityLevel":"loose"}}%%\ngraph TD\n  A --> B' })
  );
  assert.equal(parsed.overLong, false);
  assert.equal(parsed.empty, false);
  assert.ok(!parsed.source.includes('securityLevel'), 'normal fences keep the old path');
  assert.ok(parsed.source.includes('graph TD'));
});
