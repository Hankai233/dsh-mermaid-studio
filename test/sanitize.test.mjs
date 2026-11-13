/**
 * Sanitizer policy tests — the first ones this file has ever had.
 *
 * Two layers:
 *
 *  1. Pure policy. `filterDeclarations()` only needs the shape of a
 *     CSSStyleDeclaration (length / indexed names / getPropertyValue /
 *     getPropertyPriority), so a tiny lookalike drives the real code without a
 *     DOM. This is where the narrowing of `position` and `z-index` lives.
 *  2. The walk, through `createSanitizer().sanitize()`. That needs a document, so
 *     the harness below builds the element tree by hand and stubs DOMParser to
 *     hand that tree back. It is not a parser and not a spec-faithful DOM — it
 *     only carries the tree through the whitelist, attribute loop, style-body
 *     bound and <use> chain, which is the code under test.
 *
 * What this pins, and why each one is a regression that would otherwise be
 * silent: `position:fixed` and huge `z-index` were previously only stopped by
 * the card's CSS containment, and an oversized `d`/`<style>` only by MAX_NODES,
 * which counts elements rather than bytes.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHUNKS = path.join(HERE, '..', 'src', 'client');

/* ── fake DOM (tree carrier only) ─────────────────────────────────────────── */

/** Minimal CSSStyleDeclaration: enough for filterDeclarations(). */
function makeDecl(text) {
  const names = [];
  const values = new Map();
  for (const chunk of String(text ?? '').split(';')) {
    const colon = chunk.indexOf(':');
    if (colon < 0) continue;
    const name = chunk.slice(0, colon).trim().toLowerCase();
    let value = chunk.slice(colon + 1).trim();
    let priority = '';
    if (/!important$/i.test(value)) {
      value = value.replace(/\s*!important$/i, '').trim();
      priority = 'important';
    }
    if (!name || !value) continue;
    values.set(name, { value, priority });
    names.push(name);
  }
  // A real CSSStyleDeclaration exposes both decl.item(i) and decl[i]; the
  // sanitizer reads decl[i], so the lookalike must too.
  const decl = {
    length: names.length,
    item: (i) => names[Number(i)] ?? '',
    getPropertyValue: (name) => values.get(String(name).toLowerCase())?.value ?? '',
    getPropertyPriority: (name) => values.get(String(name).toLowerCase())?.priority ?? ''
  };
  names.forEach((name, i) => {
    decl[i] = name;
  });
  return decl;
}

class FakeElement {
  constructor(name, attrs = {}, children = []) {
    this.localName = name;
    this.nodeName = name;
    this.attrs = Object.entries(attrs).map(([n, v]) => ({ name: n, value: String(v) }));
    this.children = [];
    this.parentNode = null;
    this._text = '';
    for (const child of children) this.appendChild(child);
  }

  get attributes() {
    return this.attrs;
  }

  get firstElementChild() {
    return this.children[0] ?? null;
  }

  get nextElementSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.children;
    const i = siblings.indexOf(this);
    return i < 0 ? null : siblings[i + 1] ?? null;
  }

  get style() {
    // The real element parses its style attribute into a declaration block;
    // filterInlineStyle() relies on exactly that.
    return makeDecl(this.getAttribute('style'));
  }

  get textContent() {
    return this._text;
  }

  set textContent(value) {
    this._text = String(value);
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }

  setAttribute(name, value) {
    const hit = this.attrs.find((a) => a.name === name);
    if (hit) hit.value = String(value);
    else this.attrs.push({ name, value: String(value) });
  }

  removeAttribute(name) {
    this.attrs = this.attrs.filter((a) => a.name !== name);
  }

  getAttribute(name) {
    return this.attrs.find((a) => a.name === name)?.value ?? null;
  }

  getElementsByTagName(name) {
    const found = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.localName === name) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  querySelector(selector) {
    if (!selector.startsWith('#')) throw new Error('fake querySelector: ' + selector);
    const want = selector.slice(1);
    let found = null;
    const visit = (node) => {
      for (const child of node.children) {
        if (found) return;
        if (child.getAttribute('id') === want) found = child;
        visit(child);
      }
    };
    visit(this);
    return found;
  }
}

function svgFixture(children = []) {
  return new FakeElement('svg', { xmlns: 'http://www.w3.org/2000/svg' }, children);
}

function domFor(tree) {
  function DOMParser() {}
  DOMParser.prototype.parseFromString = () => ({
    documentElement: tree.root,
    getElementsByTagName: () => [] // no <parsererror>: the strict path succeeds
  });
  return {
    DOMParser,
    document: {
      createElement(tag) {
        if (tag === 'template') {
          return { content: { querySelector: () => null }, set innerHTML(_) {} };
        }
        return new FakeElement(tag);
      }
    }
  };
}

/* ── load ─────────────────────────────────────────────────────────────────── */

async function loadSanitize(dom) {
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  if (dom) {
    sandbox.document = dom.document;
    sandbox.DOMParser = dom.DOMParser;
  }
  const context = vm.createContext(sandbox);
  for (const name of ['config.js', 'sanitize.js']) {
    const code = await readFile(path.join(CHUNKS, name), 'utf8');
    vm.runInContext(code, context, { filename: name });
  }
  return { MMS: sandbox.__MMS__, source: await readFile(path.join(CHUNKS, 'sanitize.js'), 'utf8') };
}

const { MMS, source } = await loadSanitize();
/* Second instance, this one with the fake document, for the walk tests. */
const tree = { root: null };
const DOM_MMS = (await loadSanitize(domFor(tree))).MMS;
const I = MMS.SANITIZE_INTERNALS;
const RENDER_ID = 'mms-test';

/** Run a filterDeclarations() over plain CSS text. */
function filter(text) {
  return I.filterDeclarations(makeDecl(text));
}

function sanitizeOnce(root) {
  tree.root = root;
  return DOM_MMS.createSanitizer({}).sanitize('ignored-fake-parser-input', RENDER_ID);
}

function throwsBlocked(fn, pattern) {
  assert.throws(fn, (error) => {
    assert.equal(error.name, 'SanitizeError');
    assert.ok(['blocked', 'parse', 'complexity'].includes(error.kind), 'kind=' + error.kind);
    assert.match(error.message, pattern);
    return true;
  });
}

/* ── 1. position / z-index are narrowed, not removed ─────────────────────── */

test('position: fixed and sticky are refused, the layout values stay', () => {
  assert.equal(filter('position:fixed').css, '');
  assert.equal(filter('position:sticky').css, '');
  assert.equal(filter('position: FIXED').css, '');
  assert.equal(filter('position:absolute').css, 'position:absolute');
  assert.equal(filter('position:relative').css, 'position:relative');
  assert.equal(filter('position:static').css, 'position:static');
  // Not a value we accept — the declaration goes, nothing else changes.
  assert.equal(filter('position:inherit').css, '');
});

test('a refused declaration does not take its block with it', () => {
  // This is the exact clickjacking payload: the overlay box is now inert, but
  // the label geometry mermaid relies on survives.
  assert.equal(
    filter('position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483647;background:#fff').css,
    'top:0;right:0;bottom:0;left:0;background:#fff'
  );
  assert.equal(filter('z-index:2147483647;position:absolute').css, 'position:absolute');
});

test('z-index is bounded to a local stacking context', () => {
  assert.equal(filter('z-index:2147483647').css, '');
  assert.equal(filter('z-index:999999').css, '');
  assert.equal(filter('z-index:101').css, '');
  assert.equal(filter('z-index:-101').css, '');
  assert.equal(filter('z-index:1e9').css, '');
  assert.equal(filter('z-index:2').css, 'z-index:2');
  assert.equal(filter('z-index: 0').css, 'z-index:0');
  assert.equal(filter('z-index:-3').css, 'z-index:-3');
  assert.equal(filter('z-index:100').css, 'z-index:100', 'mermaid emits this itself');
  assert.equal(filter('z-index:-100').css, 'z-index:-100');
  assert.equal(filter('z-index:auto').css, 'z-index:auto');
});

test('styleDeclValueAllowed is the single place the narrowing lives', () => {
  assert.equal(I.styleDeclValueAllowed('position', 'fixed'), false);
  assert.equal(I.styleDeclValueAllowed('position', 'absolute'), true);
  assert.equal(I.styleDeclValueAllowed('z-index', '2147483647'), false);
  assert.equal(I.styleDeclValueAllowed('z-index', '2'), true);
  // Everything else keeps its old, per-declaration whitelist behaviour.
  assert.equal(I.styleDeclValueAllowed('top', '0'), true);
  assert.equal(I.styleDeclValueAllowed('background', '#fff'), true);
});

test('url()/expression() still mark the whole block unsafe', () => {
  // The new value policy must not have replaced the old fetch check.
  assert.equal(filter('position:absolute;background:url(http://evil.example/x.png)').unsafe, true);
  assert.equal(filter('background:url(#gradient)').unsafe, false);
  assert.equal(filter('width:expression(alert(1))').unsafe, true);
  assert.equal(filter('inset:0').css, '', 'inset is not in STYLE_PROPS at all');
});

/* ── 2. resource bounds ──────────────────────────────────────────────────── */

test('textWithinLimit is inclusive at the limit', () => {
  assert.equal(I.textWithinLimit('x'.repeat(I.MAX_ATTR_VALUE), I.MAX_ATTR_VALUE), true);
  assert.equal(I.textWithinLimit('x'.repeat(I.MAX_ATTR_VALUE + 1), I.MAX_ATTR_VALUE), false);
  assert.equal(I.textWithinLimit(null, 4), true);
});

test('one oversized attribute value fails the value check', () => {
  const ok = 'M0 0L10 10';
  assert.equal(I.attrValueAllowed('d', ok), true);
  assert.equal(I.attrValueAllowed('d', 'M' + '1'.repeat(I.MAX_ATTR_VALUE)), false);
  // A bounded value still has to pass its own check, not just the size check.
  assert.equal(I.attrValueAllowed('href', '#node'), true);
  assert.equal(I.attrValueAllowed('href', 'javascript:alert(1)'), false);
});

test('an oversized <style> body blocks the fence instead of being truncated', () => {
  const style = new FakeElement('style');
  style.textContent = 'a'.repeat(I.MAX_STYLE_TEXT + 1);
  throwsBlocked(() => sanitizeOnce(svgFixture([style])), /style text too large/);
});

test('an oversized attribute blocks the fence in the walk', () => {
  const path = new FakeElement('path', { d: 'M0 0' + '1'.repeat(I.MAX_ATTR_VALUE) });
  throwsBlocked(() => sanitizeOnce(svgFixture([path])), /unsafe value for d/);
});

/* ── 3. the walk itself: old protections, unchanged ──────────────────────── */

test('a benign diagram walks and reports node count', () => {
  const root = svgFixture([
    new FakeElement('g', { id: 'g1' }, [
      new FakeElement('rect', { x: '0', y: '0', width: '10', height: '10', fill: '#fff' }),
      new FakeElement('path', { d: 'M0 0L10 10' })
    ])
  ]);
  const result = sanitizeOnce(root);
  assert.equal(result.nodes, 4);
});

test('on* attributes still block the fence', () => {
  const rect = new FakeElement('rect', { onclick: 'alert(1)', width: '10' });
  throwsBlocked(() => sanitizeOnce(svgFixture([rect])), /event handler attribute onclick/);
});

test('data:image/svg+xml is still refused on href', () => {
  const image = new FakeElement('image', {
    href: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='
  });
  throwsBlocked(() => sanitizeOnce(svgFixture([image])), /unsafe value for href/);
});

test('script carriers still block the whole fence', () => {
  throwsBlocked(() => sanitizeOnce(svgFixture([new FakeElement('script')])), /blocked element <script>/);
});

test('foreignObject stays text-level only', () => {
  const foreign = new FakeElement('foreignObject', {}, [
    new FakeElement('div', {}, [new FakeElement('img', { src: 'x' })])
  ]);
  throwsBlocked(() => sanitizeOnce(svgFixture([foreign])), /element <img> is not allowed/);
});

test('a bounded <use> cycle is still detected', () => {
  const root = svgFixture([
    new FakeElement('use', { id: 'u1', href: '#u2' }),
    new FakeElement('use', { id: 'u2', href: '#u1' })
  ]);
  throwsBlocked(() => sanitizeOnce(root), /use cycle/);
});

test('the inline-style path narrows position and keeps the rest', () => {
  const label = new FakeElement('div', {
    style: 'position:fixed;top:0;left:0;z-index:2147483647;color:#111'
  });
  const root = svgFixture([new FakeElement('foreignObject', {}, [label])]);
  sanitizeOnce(root);
  assert.equal(label.getAttribute('style'), 'top:0;left:0;color:#111');
});

/* ── 4. dead code ────────────────────────────────────────────────────────── */

test('styleValueSafe is gone, not just unused', () => {
  // The style attribute never reaches attrValueAllowed(), so its `style` branch
  // and styleValueSafe() were unreachable. A source assertion is the honest
  // check here: absence of behaviour cannot be observed through the exports.
  assert.equal(source.includes('styleValueSafe'), false);
  assert.equal(MMS.SANITIZE_INTERNALS.styleValueSafe, undefined);
  assert.equal(MMS.SANITIZE_TABLES.STYLE_PROPS.position, 1);
  assert.equal(MMS.SANITIZE_TABLES.STYLE_PROPS['z-index'], 1);
});

/* ── 5. ids beyond ASCII ─────────────────────────────────────────────────── */

test('a subgraph title in Chinese is a legal id, not an unsafe one', () => {
  // mermaid names a cluster `<renderId>-<title>`, so `subgraph 分组甲` yields
  // id="mms-b-1-1-分组甲". An ASCII-only id test rejected it and blocked the
  // ENTIRE diagram, which is a total failure for a Chinese-first tool: the bug
  // was invisible to every unit test because labels are text, not ids.
  assert.equal(MMS.SANITIZE_INTERNALS.attrValueAllowed('id', 'mms-b-1-1-分组甲'), true);
  assert.equal(MMS.SANITIZE_INTERNALS.attrValueAllowed('id', '分组乙'), true);
  assert.equal(MMS.SANITIZE_INTERNALS.attrValueAllowed('id', 'a-b_c.d:e'), true);

  // The character classes that could break out of the attribute or the selector
  // stay rejected — relaxing for CJK must not relax these.
  for (const bad of ['a b', 'a"b', "a'b", 'a<b', 'a>b', 'a#b', 'a(b)', 'a\\b', 'a\nb']) {
    assert.equal(MMS.SANITIZE_INTERNALS.attrValueAllowed('id', bad), false, 'must reject: ' + JSON.stringify(bad));
  }
});
