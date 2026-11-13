/**
 * The size memo must not scan the whole origin's localStorage on every write.
 *
 * `set()` runs once per diagram card, and `keys()` walks every key in the
 * origin — the host and other plugins share that store, so the old
 * `keys().length` check turned each card into a synchronous scan of hundreds of
 * foreign keys. The contract these tests pin:
 *
 *   - the first successful write measures the store once; later writes are O(1);
 *   - over many writes the scan count stays far below the write count;
 *   - the 200-row cap is still enforced (pruning must not silently disappear);
 *   - the reported size and the real row count stay equal after writes, removals
 *     and clear();
 *   - a quota error prunes immediately, and a storage that just throws degrades
 *     quietly instead of propagating.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHUNKS = path.join(HERE, '..', 'src', 'client');

/**
 * Stub localStorage that counts *scans*: `keys()` reads `length` once, so a
 * `length` read is exactly one walk of the origin's keys. Foreign host keys are
 * pre-seeded so a per-write scan would be visibly expensive, not just countable.
 */
function fakeStorage(hostKeys = 0) {
  const map = new Map();
  const state = { scans: 0, getItem: 0, setItem: 0, failSet: false };
  let orderCache = null;
  const order = () => (orderCache || (orderCache = Array.from(map.keys())));
  for (let i = 0; i < hostKeys; i += 1) map.set('host:unrelated:' + i, 'x');
  return {
    state,
    rows() {
      return Array.from(map.keys()).filter((name) => name.indexOf('mms:size:') === 0).length;
    },
    storage: {
      get length() {
        state.scans += 1;
        return map.size;
      },
      key: (i) => order()[String(i)] ?? null,
      getItem: (k) => {
        state.getItem += 1;
        return map.has(k) ? map.get(k) : null;
      },
      setItem: (k, v) => {
        state.setItem += 1;
        if (state.failSet) throw new Error('QuotaExceededError');
        map.set(k, String(v));
        orderCache = null;
      },
      removeItem: (k) => {
        map.delete(k);
        orderCache = null;
      }
    }
  };
}

async function loadMMS(fake) {
  const sandbox = { console, Math, Date, JSON, Number, isFinite, String, setTimeout, clearTimeout };
  sandbox.globalThis = sandbox;
  if (fake) sandbox.localStorage = fake.storage;
  const context = vm.createContext(sandbox);
  for (const name of ['config.js', 'sizes.js']) {
    vm.runInContext(await readFile(path.join(CHUNKS, name), 'utf8'), context, { filename: name });
  }
  return sandbox.__MMS__;
}

function recordingStats() {
  return {
    errors: [],
    error(message) {
      this.errors.push(message);
    }
  };
}

test('one measurement, then O(1) writes: scans stay far below the write count', async () => {
  const fake = fakeStorage(800);
  const MMS = await loadMMS(fake);
  const sizes = MMS.createSizes({});
  const cap = MMS.CONFIG.SIZE_MEMO_MAX;
  const N = 1000;

  assert.equal(sizes.set('first', 100, 100), true);
  assert.equal(fake.state.scans, 1, 'the first write measures the store exactly once');

  const scansAtStart = fake.state.scans;
  for (let i = 0; i < N; i += 1) sizes.set('card-' + i, 100, 100 + i);
  const scans = fake.state.scans - scansAtStart;

  assert.ok(scans <= N / 10, `${scans} scans for ${N} writes must stay under ${N / 10}`);
  assert.ok(fake.rows() <= cap, `rows ${fake.rows()} must stay within ${cap}`);
  assert.ok(fake.rows() > 0, 'pruning must not empty the store');
  assert.equal(sizes.size(), fake.rows(), 'the reported size must match the real row count');
});

test('pruning really happens at the cap, and the counter follows it', async () => {
  const fake = fakeStorage(100);
  const MMS = await loadMMS(fake);
  const sizes = MMS.createSizes({});
  const cap = MMS.CONFIG.SIZE_MEMO_MAX;

  for (let i = 0; i < cap + 20; i += 1) sizes.set('k-' + i, 100, 100);
  assert.ok(fake.rows() <= cap, `rows ${fake.rows()} must stay within ${cap}`);
  assert.equal(sizes.size(), fake.rows());
  assert.ok(fake.rows() < cap + 20, 'the cap was enforced by removing rows');
});

test('forget() and clear() keep the counter exact', async () => {
  const fake = fakeStorage();
  const MMS = await loadMMS(fake);
  const sizes = MMS.createSizes({});

  for (let i = 0; i < 5; i += 1) sizes.set('a-' + i, 10, 10);
  assert.equal(sizes.size(), 5);
  assert.equal(fake.rows(), 5);

  sizes.forget('a-0');
  assert.equal(sizes.size(), 4);
  assert.equal(fake.rows(), 4);

  // Forgetting an absent row must not make the counter drift.
  sizes.forget('never-written');
  assert.equal(sizes.size(), 4);

  assert.equal(sizes.clear(), 4);
  assert.equal(sizes.size(), 0);
  assert.equal(fake.rows(), 0);
});

test('a quota failure prunes immediately, retries once, then stays quiet', async () => {
  const fake = fakeStorage();
  const MMS = await loadMMS(fake);
  MMS.CONFIG.SIZE_MEMO_MAX = 10;
  const stats = recordingStats();
  const sizes = MMS.createSizes({ stats });

  for (let i = 0; i < 10; i += 1) assert.equal(sizes.set('k-' + i, 10, 10), true);
  assert.equal(fake.rows(), 10);

  fake.state.failSet = true;
  let result;
  assert.doesNotThrow(() => {
    result = sizes.set('overflow', 10, 10);
  });
  assert.equal(result, false, 'a failed write reports failure, it does not throw');
  assert.equal(fake.rows(), 7, 'the quota path pruned to 75% before the retry');
  assert.equal(sizes.size(), fake.rows());
  assert.ok(stats.errors.length > 0, 'the degradation is recorded in stats');
});

test('an unwritable storage degrades silently from the first write', async () => {
  const fake = fakeStorage();
  fake.state.failSet = true;
  const MMS = await loadMMS(fake);
  const sizes = MMS.createSizes({});

  assert.equal(sizes.set('k', 10, 10), false);
  assert.equal(sizes.get('k'), null);
  assert.equal(sizes.size(), 0);
  assert.equal(sizes.clear(), 0);
});
