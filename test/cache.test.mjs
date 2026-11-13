/**
 * L2 byte accounting.
 *
 * `enforceCapacity()` used to run `store.getAll()` after every put: once the
 * cache was warm, each finished diagram deserialized the whole store into the
 * heap. That is the jank this plugin exists to remove, so the contract these
 * tests pin is:
 *
 *   - a put under the cap never reads the store (beyond the one lazy total);
 *   - overwriting a key is a delta, not another full record on the counter;
 *   - the full read happens only when the counter says the cap was crossed, and
 *     that pass still lands the store under the cap;
 *   - `dropDatabase()` invalidates the counter instead of carrying a total over
 *     to a database that no longer exists.
 *
 * The stub is a minimal in-memory IndexedDB: transactions are pumped on a timer
 * after the transaction body has been built, which is exactly the ordering the
 * real cache relies on (handlers assigned synchronously, `oncomplete` after).
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
      open(name) {
        calls.open += 1;
        const req = { result: db, error: null };
        setTimeout(() => {
          if (typeof req.onupgradeneeded === 'function') req.onupgradeneeded({ target: req });
          if (typeof req.onsuccess === 'function') req.onsuccess({ target: req });
        }, 0);
        return req;
      },
      deleteDatabase(name) {
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
  const stats = MMS.createStats();
  return { MMS, stats };
}

function record(cache, MMS, key, bytes, lastUsed) {
  const made = cache.makeRecord({
    key,
    source: 'graph TD\n ' + key + ' --> B',
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

/** The same 1 KB budget the eviction tests below reason about. */
function setCapOneKb(MMS) {
  MMS.CONFIG.CACHE_MAX_MB = 1000 / (1024 * 1024);
}

test('put() does not read the whole store once the cache is warm', async () => {
  const idb = createIdb();
  const { MMS, stats } = await loadCache(idb);
  const cache = MMS.createCache({ stats, config: { cacheEnabled: true } });

  for (let i = 0; i < 40; i += 1) {
    await cache.put(record(cache, MMS, 'k' + i, 1024, i));
  }
  assert.equal(idb.calls.put, 40);
  assert.equal(idb.size(), 40);
  assert.equal(idb.calls.getAll, 1, 'the lazy total may read the store exactly once');

  // Rewrites of the same 40 keys must not turn the counter (or a scan) on.
  for (let i = 0; i < 40; i += 1) {
    await cache.put(record(cache, MMS, 'k' + i, 1024, i));
  }
  assert.equal(idb.size(), 40);
  assert.equal(idb.calls.getAll, 1, 'getAll() must not grow with the number of puts');
  assert.equal(stats.cacheEvict, 0);
});

test('rewriting one key is a delta, not a second record on the counter', async () => {
  const idb = createIdb();
  const { MMS, stats } = await loadCache(idb);
  setCapOneKb(MMS);
  const cache = MMS.createCache({ stats, config: { cacheEnabled: true } });

  // 900 bytes of a 1000-byte budget, written 20 times. If each put were added
  // instead of replacing the previous size, the third write would already trip
  // the cap and evict.
  for (let i = 0; i < 20; i += 1) {
    await cache.put(record(cache, MMS, 'same', 900, i));
  }
  assert.equal(idb.size(), 1);
  assert.equal(idb.bytes(), 900);
  assert.equal(stats.cacheEvict, 0, 'a rewrite must not look like growth');
  assert.equal(idb.calls.getAll, 1, 'no scan was needed to notice the rewrite');
});

test('crossing the cap still compacts, and only that pass reads everything', async () => {
  const idb = createIdb();
  const { MMS, stats } = await loadCache(idb);
  setCapOneKb(MMS);
  const cache = MMS.createCache({ stats, config: { cacheEnabled: true } });

  await cache.put(record(cache, MMS, 'a', 600, 1));
  await cache.put(record(cache, MMS, 'b', 600, 2)); // 1200 > 1000: gate trips
  assert.equal(idb.calls.getAll, 2, 'one lazy load plus one gated pass');
  assert.equal(idb.size(), 1);
  assert.equal(stats.cacheEvict, 1);
  assert.ok(idb.bytes() <= 1000, 'the gated pass must land the store under the cap');

  await cache.put(record(cache, MMS, 'c', 600, 3)); // gate trips again
  assert.equal(idb.calls.getAll, 3);
  assert.equal(idb.size(), 1);
  assert.equal(stats.cacheEvict, 2);
  assert.ok(idb.bytes() <= 1000);
});

test('dropDatabase() clears the counter instead of carrying it over', async () => {
  const idb = createIdb();
  const { MMS, stats } = await loadCache(idb);
  const cache = MMS.createCache({ stats, config: { cacheEnabled: true } });

  await cache.put(record(cache, MMS, 'a', 600, 1));
  assert.equal(idb.calls.getAll, 1);

  await cache.dropDatabase();
  assert.equal(idb.size(), 0);

  const before = idb.calls.getAll;
  await cache.put(record(cache, MMS, 'b', 600, 2));
  assert.equal(idb.calls.getAll, before + 1, 'a fresh database re-reads the total once');
  assert.equal(idb.size(), 1);
  assert.equal(idb.bytes(), 600);
});
