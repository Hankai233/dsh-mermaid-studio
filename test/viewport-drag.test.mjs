/**
 * Drag must not outlive the button.
 *
 * `setPointerCapture` is a nicety, and the old code swallowed its failure with
 * an empty catch: when the call was refused, a release outside the viewport
 * never reached our `pointerup` listener, `drag` stayed non-null, and every
 * subsequent mouse move panned the diagram with no button held. `onPointerMove`
 * now treats `buttons === 0` as the release (with a pointerType guard so touch
 * is not misread), and a failed capture arms a one-shot window listener for the
 * release that arrives outside the element.
 *
 * These tests also pin the behaviour the fix must not break: a real press still
 * pans, high-frequency moves are still coalesced into one write per frame, and
 * a touch drag still pans.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHUNKS = path.join(HERE, '..', 'src', 'client');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(1);
  }
  return predicate();
}

/** Minimal element: attributes, style, listeners, and pointer capture. */
function element(tag) {
  const listeners = new Map();
  const el = {
    tagName: tag,
    attrs: {},
    style: {},
    children: [],
    firstElementChild: null,
    clientWidth: 0,
    clientHeight: 0,
    pointerCapture: null,
    addEventListener: function (type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener: function (type, fn) {
      const set = listeners.get(type);
      if (set) set.delete(fn);
    },
    listenerCount: function (type) {
      const set = listeners.get(type);
      return set ? set.size : 0;
    },
    dispatch: function (type, props) {
      const event = Object.assign(
        {
          type: type,
          target: el,
          currentTarget: el,
          cancelable: false,
          button: 0,
          buttons: 1,
          pointerId: 1,
          preventDefault: function () {},
          stopPropagation: function () {}
        },
        props
      );
      const set = listeners.get(type);
      if (set) {
        const snapshot = Array.from(set); // a handler may remove itself mid-dispatch
        for (let i = 0; i < snapshot.length; i += 1) snapshot[i](event);
      }
      return event;
    },
    setAttribute: function (name, value) {
      el.attrs[name] = String(value);
    },
    getAttribute: function (name) {
      return el.attrs[name] === undefined ? null : el.attrs[name];
    },
    removeAttribute: function (name) {
      delete el.attrs[name];
    },
    setPointerCapture: function (id) {
      el.pointerCapture = id;
    },
    releasePointerCapture: function (id) {
      if (el.pointerCapture === id) el.pointerCapture = null;
    },
    getBoundingClientRect: function () {
      return { left: 0, top: 0, width: el.clientWidth, height: el.clientHeight };
    }
  };
  return el;
}

async function load() {
  const sandbox = { console, setTimeout, clearTimeout, Date, Math, JSON, Promise };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  for (const name of ['config.js', 'viewport.js']) {
    vm.runInContext(await readFile(path.join(CHUNKS, name), 'utf8'), context, { filename: name });
  }
  sandbox.window = element('window');
  return { MMS: sandbox.__MMS__, window: sandbox.window };
}

/**
 * A viewport of 400×200 showing a 400×200 diagram: at scale 1 neither axis is
 * larger than the viewport, so clampPan() leaves a small drag untouched and the
 * numbers in the assertions are the raw pointer deltas.
 */
async function rig(options) {
  const env = await load();
  const viewport = element('div');
  const stage = element('div');
  const svg = element('svg');
  svg.attrs.viewBox = '0 0 400 200';
  stage.firstElementChild = svg;
  viewport.clientWidth = 400;
  viewport.clientHeight = 200;
  if (options && options.captureFails) {
    viewport.setPointerCapture = function () {
      throw new Error('capture refused');
    };
  }
  const writes = [];
  Object.defineProperty(stage.style, 'transform', {
    configurable: true,
    get: function () {
      return writes.length ? writes[writes.length - 1] : '';
    },
    set: function (value) {
      writes.push(value);
    }
  });
  const controller = env.MMS.createViewport({ viewport: viewport, stage: stage });
  return { env, viewport, stage, writes, controller };
}

test('pointermove with no button held never pans, even when capture was refused', async (t) => {
  const r = await rig({ captureFails: true });
  t.after(() => r.controller.dispose());

  r.viewport.dispatch('pointerdown', {
    button: 0,
    buttons: 1,
    pointerId: 1,
    clientX: 100,
    clientY: 100,
    pointerType: 'mouse',
    cancelable: true
  });
  assert.equal(r.env.window.listenerCount('pointerup'), 1, 'a refused capture arms the release watch');

  r.viewport.dispatch('pointermove', {
    pointerId: 1,
    clientX: 160,
    clientY: 100,
    pointerType: 'mouse',
    buttons: 0
  });
  assert.equal(r.controller.state().x, 0, 'an un-pressed move must not pan');
  assert.equal(r.controller.state().y, 0);
  assert.equal(r.viewport.getAttribute('data-dragging'), null, 'the drag state was torn down');
  assert.equal(r.env.window.listenerCount('pointerup'), 0, 'the release watch went with it');

  // And it stays ended: further un-pressed moves are inert.
  r.viewport.dispatch('pointermove', {
    pointerId: 1,
    clientX: 220,
    clientY: 140,
    pointerType: 'mouse',
    buttons: 0
  });
  assert.equal(r.controller.state().x, 0);
  assert.equal(r.controller.state().y, 0);
});

test('a real press still pans, coalesced into one write per frame', async (t) => {
  const r = await rig({});
  t.after(() => r.controller.dispose());

  r.viewport.dispatch('pointerdown', {
    button: 0,
    buttons: 1,
    pointerId: 2,
    clientX: 100,
    clientY: 100,
    pointerType: 'mouse',
    cancelable: true
  });
  assert.equal(r.env.window.listenerCount('pointerup'), 0, 'a successful capture needs no fallback');

  r.viewport.dispatch('pointermove', { pointerId: 2, clientX: 110, clientY: 100, pointerType: 'mouse', buttons: 1 });
  r.viewport.dispatch('pointermove', { pointerId: 2, clientX: 120, clientY: 100, pointerType: 'mouse', buttons: 1 });

  assert.equal(r.controller.state().x, 20, 'both moves accumulated');
  assert.equal(r.writes.length, 0, 'no synchronous write per move event');
  assert.ok(await waitFor(() => r.writes.length === 1), 'the burst produced exactly one write');
  assert.equal(r.writes[0], 'translate3d(20.00px,0.00px,0) scale(1.0000)');

  // The ordinary pointerup path still ends the drag.
  r.viewport.dispatch('pointerup', { pointerId: 2, clientX: 120, clientY: 100, pointerType: 'mouse', buttons: 0 });
  const afterRelease = r.controller.state().x;
  r.viewport.dispatch('pointermove', { pointerId: 2, clientX: 300, clientY: 100, pointerType: 'mouse', buttons: 1 });
  assert.equal(r.controller.state().x, afterRelease, 'no pan after the pointer was released');
});

test('a release outside the viewport ends the drag when capture was refused', async (t) => {
  const r = await rig({ captureFails: true });
  t.after(() => r.controller.dispose());

  r.viewport.dispatch('pointerdown', {
    button: 0,
    buttons: 1,
    pointerId: 3,
    clientX: 100,
    clientY: 100,
    pointerType: 'mouse'
  });
  r.viewport.dispatch('pointermove', { pointerId: 3, clientX: 130, clientY: 100, pointerType: 'mouse', buttons: 1 });
  assert.equal(r.controller.state().x, 30, 'the drag worked');

  // Released far from the card: this pointerup never reaches the viewport.
  r.env.window.dispatch('pointerup', {
    pointerId: 3,
    clientX: 900,
    clientY: 900,
    pointerType: 'mouse',
    buttons: 0
  });
  assert.equal(r.env.window.listenerCount('pointerup'), 0, 'the one-shot watch was consumed');
  assert.equal(r.viewport.getAttribute('data-dragging'), null, 'the drag state was torn down');

  // buttons: 1 on purpose — this move would pan if the drag had survived.
  r.viewport.dispatch('pointermove', { pointerId: 3, clientX: 200, clientY: 100, pointerType: 'mouse', buttons: 1 });
  assert.equal(r.controller.state().x, 30, 'the drag did not survive the outside release');
});

test('a touch drag is not mistaken for a release', async (t) => {
  const r = await rig({});
  t.after(() => r.controller.dispose());

  r.viewport.dispatch('pointerdown', {
    button: 0,
    buttons: 1,
    pointerId: 4,
    clientX: 50,
    clientY: 50,
    pointerType: 'touch'
  });
  r.viewport.dispatch('pointermove', { pointerId: 4, clientX: 90, clientY: 50, pointerType: 'touch', buttons: 0 });
  assert.equal(r.controller.state().x, 40, 'a touch move still pans');

  // The pointerType guard covers a driver that reports no held button mid-drag.
  r.viewport.dispatch('pointermove', { pointerId: 4, clientX: 100, clientY: 50, pointerType: 'touch', buttons: 0 });
  assert.equal(r.controller.state().x, 50, 'touch keeps panning');
});
