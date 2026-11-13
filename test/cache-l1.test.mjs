/**
 * L1 byte budget, dead L1 entries, and the L2 accounting they must not disturb.
 *
 * `l1Set()` used to cap L1 by *count* only (`L1_MAX = 50`). Each entry carries
 * its full SVG, so fifty 1–2 MB diagrams pinned ~100 MB of heap while
 * `CACHE_MAX_MB` governed L2 alone — the one cache with no byte bound was the
 * one that is never evicted by the browser. These tests pin the four contracts
 * that fix introduced:
 *
 *   (a) L1 bytes stay inside the budget (count cap alone would not prune here);
 *   (b) overwriting one key replaces its bytes instead of accumulating;
 *   (c) an L1 hit that is unusable is removed and does not keep an MRU seat;
 *   (d) the previous round's L2 win is intact: consecutive puts stay O(1) in
 *       `getAll()` (one lazy load, never one scan per record).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHUNKS = path.join(HERE, '..', 'src', 'client');
const STORE = 'diagrams';

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Minimal in-memory IndexedDB, same shape as cache.test.mjs uses. */
function createIdb() {
  const data = new Map();
  const calls = { open: 0, deleteDatabase: 0, getAll: 0, get: 0, put: 0, delete: 0, clear: 0 };

  function fire(request, result) {
    request.result = result;
    if (typeof request.onsuccess === 'function') request.onsuccess({ target: request });
  }

  function makeStore(tx) {
    const later = (fn) => {
      tx.queue.push(fn);
    };
    const request = () => ({});
    return {
      get(key) {
        calls.get += 1;
        const req = request();
        later(() => fire(req, data.has(key) ? clone(data.get(key)) : undefined));
        return req;
      },
      put(record) {
        calls.put += 1;
        const req = request();
        later(() => {
          data.set(record.key, clone(record));
          fire(req, record.key);
        });
        return req;
      },
      delete(key) {
        calls.delete += 1;
        const req = request();
        later(() => {
          data.delete(key);
          fire(req, undefined);
        });
        return req;
      },
      clear() {
        calls.clear += 1;
        const req = request();
        later(() => {
          data.clear();
          fire(req, undefined);
        });
        return req;
      },
      getAll() {
        calls.getAll += 1;
        const req = request();
        later(() => fire(req, Array.from(data.values()).map(clone)));
        return req;
      },
      getAllKeys() {
        const req = request();
        later(() => fire(req, Array.from(data.keys())));
        return req;
      },
      index(name) {
        return {
          getAll(value) {
            const req = request();
            later(() => fire(req, Array.from(data.values()).filter((r) => r && r[name] === value).map(clone)));
            return req;
          },
          getAllKeys(value) {
            const req = request();
            later(() =>
              fire(
                req,
                Array.from(data.values())
                  .filter((r) => r && r[name] === value)
                  .map((r) => r.key)
              )
            );
            return req;
          }
        };
      }
    };
  }

  function transaction() {
    const tx = { oncomplete: null, onerror: null, onabort: null, error: null, queue: [], store: null };
    tx.store = makeStore(tx);
    tx.objectStore = () => tx.store;
    setTimeout(() => {
      while (tx.queue.length) tx.queue.shift()();
      setTimeout(() => {
        if (typeof tx.oncomplete === 'function') tx.oncomplete();
      }, 0);
    }, 0);
    return tx;
  }

  const db = {
    version: 1,
    objectStoreNames: { contains: (name) => name === STORE },
    transaction,
    close() {}
  };

  return {
    calls,
    factory: {
      open() {
        calls.open += 1;
        const req = { result: db, error: null };
        setTimeout(() => {
          if (typeof req.onupgradeneeded === 'function') req.onupgradeneeded({ target: req });
          if (typeof req.onsuccess === 'function') req.onsuccess({ target: req });
        }, 0);
        return req;
      },
      deleteDatabase() {
        calls.deleteDatabase += 1;
        data.clear();
        const req = { error: null };
        setTimeout(() => {
          if (typeof req.onsuccess === 'function') req.onsuccess({ target: req });
        }, 0);
        return req;
      }
    },
    size() {
      return data.size;
    },
    bytes() {
      let total = 0;
      for (const record of data.values()) total += record.bytes || 0;
      return total;
    }
  };
}

async function loadCache(idb) {
  const sandbox = {
    console,
    TextEncoder,
    setTimeout,
    clearTimeout,
    isFinite,
    indexedDB: idb.factory,
    document: { fonts: { status: 'loaded' } },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      length: 0,
      key: () => null
    }
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  for (const name of ['config.js', 'stats.js', 'cache.js']) {
    vm.runInContext(await readFile(path.join(CHUNKS, name), 'utf8'), context, { filename: name });
  }
  const MMS = sandbox.__MMS__;
  return { MMS, stats: MMS.createStats() };
}

function record(cache, key, bytes, lastUsed) {
  const made = cache.makeRecord({
    key,
    source: 'graph TD\\n ' + key + ' --> B',
    svg: '<svg data-key="' + key + '"></svg>',
    width: 10,
    height: 10,
    theme: 'default',
    mermaidVersion: '11.17.2',
    renderId: key,
    scopeHash: 'scope'
  });
  made.bytes = bytes;
  if (lastUsed !== undefined) made.lastUsed = lastUsed;
  return made;
}

test('(a) L1 is pruned by bytes, not just by the 50-entry count', async () => {
  const idb = createIdb();
  const { MMS, stats } = await loadCache(idb);
  MMS.CONFIG.CACHE_MAX_MB = 8; // L1 budget is half of it: 4 MiB
  const cache = MMS.createCache({ stats, config: { cacheEnabled: true } });
  const budget = cache.l1BudgetBytes();
  assert.equal(budget, 4 * 1024 * 1024);

  const size = 300 * 1024;
  for (let i = 0; i < 20; i += 1) {
    await cache.put(record(cache, 'big-' + i, size, i));
  }

  assert.ok(cache.l1Bytes() <= budget, `L1 holds ${cache.l1Bytes()} bytes, budget ${budget}`);
  assert.ok(cache.l1Size() > 0, 'the budget must not empty L1');
  assert.ok(cache.l1Size() < MMS.CONFIG.L1_MAX, 'byte pressure pruned before the count cap did');
  assert.ok(cache.l1Size() <= Math.floor(budget / size));
});

test('(b) rewriting the same key replaces its L1 bytes instead of adding them', async () => {
  const idb = createIdb();
  const { MMS, stats } = await loadCache(idb);
  MMS.CONFIG.CACHE_MAX_MB = 4; // L1 budget 2 MiB
  const cache = MMS.createCache({ stats, config: { cacheEnabled: true } });

  await cache.put(record(cache, 'same', 400 * 1024, 1));
  assert.equal(cache.l1Size(), 1);
  assert.equal(cache.l1Bytes(), 400 * 1024);

  // Shrink it: a stale "+=" would leave 900 KiB behind.
  await cache.put(record(cache, 'same', 100 * 1024, 2));
  assert.equal(cache.l1Size(), 1);
  assert.equal(cache.l1Bytes(), 100 * 1024);

  // Re-render it many more times: the counter must not creep toward the cap.
  for (let i = 0; i < 30; i += 1) {
    await cache.put(record(cache, 'same', 100 * 1024, i));
  }
  assert.equal(cache.l1Size(), 1);
  assert.equal(cache.l1Bytes(), 100 * 1024, 'the same key must not accumulate');
  assert.equal(stats.cacheEvict, 0, 'and must not look like L2 growth either');
});

test('(c) an unusable L1 hit is dropped instead of being refreshed to MRU', async () => {
  const idb = createIdb();
  const { MMS, stats } = await loadCache(idb);
  const cache = MMS.createCache({ stats, config: { cacheEnabled: true } });

  const expired = record(cache, 'expired', 1024, 1);
  expired.expiresAt = Date.now() - 1000;
  await cache.put(expired);
  assert.equal(cache.l1Size(), 1);
  assert.equal(cache.l1Bytes(), 1024);

  const beforeL2Reads = idb.calls.get;
  const found = await cache.get('expired');
  assert.equal(found, null);
  assert.equal(cache.l1Size(), 0, 'a dead hit must not keep an L1 seat');
  assert.equal(cache.l1Bytes(), 0);
  assert.equal(stats.cacheHitL1, 0);
  assert.ok(idb.calls.get > beforeL2Reads, 'the lookup continued into L2');

  // A foreign-schema record is dead the same way (old build after a bump).
  const foreign = record(cache, 'foreign', 1024, 2);
  foreign.schema = MMS.CONFIG.SCHEMA + 7;
  await cache.put(foreign);
  assert.equal(cache.l1Size(), 1);
  assert.equal(await cache.get('foreign'), null);
  assert.equal(cache.l1Size(), 0);
  assert.equal(cache.l1Bytes(), 0);
});

test('(d) L1 accounting did not regress the L2 O(1) getAll contract', async () => {
  const idb = createIdb();
  const { MMS, stats } = await loadCache(idb);
  const cache = MMS.createCache({ stats, config: { cacheEnabled: true } });

  for (let i = 0; i < 40; i += 1) {
    await cache.put(record(cache, 'k' + i, 1024, i));
  }
  assert.equal(idb.size(), 40);
  assert.equal(cache.l1Size(), 40);
  assert.equal(idb.calls.getAll, 1, 'the lazy total may read the store exactly once');

  for (let i = 0; i < 40; i += 1) {
    await cache.put(record(cache, 'k' + i, 1024, i));
  }
  assert.equal(idb.calls.getAll, 1, 'getAll() must not grow with the number of puts');
  assert.equal(stats.cacheEvict, 0);
  assert.equal(cache.l1Bytes(), 40 * 1024);
});
