/* ── cache.js — L1 memory, L2 IndexedDB, and the rules around both ──────────
 *
 * L1 exists because scrolling a long conversation unmounts and remounts cards;
 * a memory hit is synchronous, so a remount never flashes code-then-diagram.
 * L2 exists because the process memory is gone after a reload or a session
 * switch, and that is the case this plugin is actually for.
 *
 * Everything here degrades: no IndexedDB (private mode), a quota error, a schema
 * from an older build — the card still renders, the store just stops helping.
 * Records carry their own `expiresAt`, `scopeHash` and byte size so TTL, LRU and
 * per-session cleanup never need to re-parse an SVG to decide.
 */
(function (g) {
  'use strict';
  var MMS = g.__MMS__ || (g.__MMS__ = {});

  function byteLength(text) {
    try {
      return new TextEncoder().encode(String(text)).length;
    } catch (error) {
      return String(text).length * 2;
    }
  }

  /**
   * Whether the document's fonts have finished settling.
   *
   * `loaded` is the only state that guarantees `getBBox()` measured the font the
   * user will actually see; `loading` means at least one font face is pending, so
   * any geometry measured now may be provisional. A document without a
   * FontFaceSet (or a host that disables it) counts as settled: the guard must
   * never disable caching on a platform where it cannot be evaluated.
   */
  function fontsSettled(doc) {
    var fonts = doc && doc.fonts;
    if (!fonts || typeof fonts.status !== 'string') return true;
    return fonts.status === 'loaded';
  }

  function requestAsPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () {
        resolve(request.result);
      };
      request.onerror = function () {
        reject(request.error || new Error('IndexedDB request failed'));
      };
    });
  }

  function createCache(options) {
    var stats = options.stats;
    var config = options.config;
    var l1 = new Map();
    var l2Available = null; // null = not tried yet, true/false after open
    var dbPromise = null;
    var warned = false;
    var hitUpdates = new Map(); // key -> pending lastUsed/hits bump
    var flushTimer = null;
    /**
     * Running total of `record.bytes` in L2, kept in memory instead of measured
     * from the store. `null` = not loaded yet.
     *
     * `enforceCapacity()` used to `getAll()` after *every* put, so once the
     * cache was non-empty each finished diagram deserialized the whole store
     * into the heap — O(store) work, on the tail of a render, in the plugin
     * whose whole purpose is removing that jank. The total is now loaded once
     * (lazily, before the first write), adjusted by each write's delta and each
     * delete, and only a total above the cap is allowed to pay for a full scan
     * — a scan that is also the recalibration.
     */
    var totalBytes = null;
    var totalPromise = null;
    /**
     * L1's own byte budget, because `L1_MAX` alone bounds only the *count*.
     * Every L1 entry carries its full SVG, so 50 diagrams of 1–2 MB pinned
     * ~100 MB of heap while `CACHE_MAX_MB` governed L2 only — a real OOM source
     * with no counterpressure. Half the L2 cap keeps the warm scrollback
     * meaningful without competing with the store it mirrors.
     */
    var l1BudgetBytes = Math.floor((MMS.CONFIG.CACHE_MAX_MB * 1024 * 1024) / 2);
    var l1Bytes = 0;

    function warnOnce(error) {
      if (warned) return;
      warned = true;
      if (stats) stats.cacheError += 1;
      try {
        console.warn('[mms] cache degraded to memory:', error && error.message);
      } catch (ignored) {
        /* console is not guaranteed */
      }
    }

    function openDb() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise(function (resolve) {
        var factory = g.indexedDB;
        if (!factory) {
          // Private mode / blocked storage: one warn, then memory only.
          warnOnce(new Error('indexedDB unavailable'));
          resolve(null);
          return;
        }
        var request;
        try {
          request = factory.open(MMS.CONFIG.IDB_NAME, MMS.CONFIG.IDB_VERSION);
        } catch (error) {
          warnOnce(error);
          resolve(null);
          return;
        }
        request.onupgradeneeded = function () {
          var db = request.result;
          if (!db.objectStoreNames.contains(MMS.CONFIG.IDB_STORE)) {
            var store = db.createObjectStore(MMS.CONFIG.IDB_STORE, { keyPath: 'key' });
            store.createIndex('lastUsed', 'lastUsed');
            store.createIndex('schema', 'schema');
            store.createIndex('expiresAt', 'expiresAt');
            store.createIndex('scopeHash', 'scopeHash');
          }
        };
        request.onsuccess = function () {
          var db = request.result;
          // A previous install (or anything else) may have created the database
          // at this version without our store. Upgrading is the only way back,
          // and silently keeping an empty database would make every write fail.
          if (!db.objectStoreNames.contains(MMS.CONFIG.IDB_STORE)) {
            var nextVersion = db.version + 1;
            db.close();
            var retry = factory.open(MMS.CONFIG.IDB_NAME, nextVersion);
            retry.onupgradeneeded = request.onupgradeneeded;
            retry.onsuccess = function () {
              resolve(retry.result);
            };
            retry.onerror = function () {
              warnOnce(retry.error);
              resolve(null);
            };
            retry.onblocked = function () {
              warnOnce(new Error('IndexedDB upgrade blocked'));
              resolve(null);
            };
            return;
          }
          resolve(db);
        };
        request.onerror = function () {
          warnOnce(request.error);
          resolve(null);
        };
        request.onblocked = function () {
          warnOnce(new Error('IndexedDB open blocked'));
          resolve(null);
        };
      }).then(function (db) {
        l2Available = !!db;
        return db;
      });
      return dbPromise;
    }

    function tx(mode, fn) {
      return openDb().then(function (db) {
        if (!db) return null;
        return new Promise(function (resolve, reject) {
          var transaction = db.transaction(MMS.CONFIG.IDB_STORE, mode);
          var store = transaction.objectStore(MMS.CONFIG.IDB_STORE);
          var result;
          try {
            result = fn(store);
          } catch (error) {
            reject(error);
            return;
          }
          transaction.oncomplete = function () {
            // `result` may be a promise (request-backed reads); resolving with it
            // adopts it, which is exactly the ordering we want.
            resolve(result);
          };
          transaction.onerror = function () {
            reject(transaction.error || new Error('IndexedDB transaction failed'));
          };
          transaction.onabort = function () {
            reject(transaction.error || new Error('IndexedDB transaction aborted'));
          };
        });
      });
    }

    function rememberHit(key, record) {
      hitUpdates.set(key, { lastUsed: Date.now(), hits: (record.hits || 0) + 1 });
      if (flushTimer) return;
      flushTimer = setTimeout(function () {
        flushTimer = null;
        var batch = hitUpdates;
        hitUpdates = new Map();
        tx('readwrite', function (store) {
          batch.forEach(function (patch, targetKey) {
            var get = store.get(targetKey);
            get.onsuccess = function () {
              var found = get.result;
              if (!found) return;
              found.lastUsed = patch.lastUsed;
              found.hits = patch.hits;
              store.put(found);
            };
          });
        }).catch(function () {
          /* a missed usage bump costs an eviction decision, not correctness */
        });
      }, 800);
    }

    function l1Get(key) {
      var record = l1.get(key);
      if (!record) return null;
      l1.delete(key);
      l1.set(key, record); // re-insert: Map order is the L1 LRU order
      return record;
    }

    /** A record's contribution to L1; `bytes` is written by makeRecord. */
    function l1RecordBytes(record) {
      if (!record) return 0;
      if (typeof record.bytes === 'number' && record.bytes > 0) return record.bytes;
      // A record written by an older build has no `bytes`; measuring its SVG is
      // the only honest fallback, and that cost is paid once per entry.
      return byteLength(record.svg || '');
    }

    /** Remove one entry and subtract exactly what it added. */
    function l1Drop(key) {
      var record = l1.get(key);
      if (!record) return;
      l1.delete(key);
      l1Bytes -= l1RecordBytes(record);
      if (l1Bytes < 0) l1Bytes = 0;
    }

    function l1Clear() {
      l1.clear();
      l1Bytes = 0;
    }

    function l1Set(key, record) {
      if (!record) return;
      // Overwriting the same key replaces its size instead of adding to it:
      // re-rendering one diagram must not walk the counter up to the cap.
      l1Drop(key);
      var bytes = l1RecordBytes(record);
      // One record larger than the whole budget cannot be kept without breaking
      // the bound for everything else; L2 still has it, so a later mount is a
      // slower hit, not a miss.
      if (bytes > l1BudgetBytes) return;
      l1.set(key, record);
      l1Bytes += bytes;
      while (l1.size > MMS.CONFIG.L1_MAX || l1Bytes > l1BudgetBytes) {
        l1Drop(l1.keys().next().value);
      }
    }

    function isUsable(record) {
      if (!record || record.schema !== MMS.CONFIG.SCHEMA) return false;
      if (record.expiresAt && record.expiresAt < Date.now()) return false;
      return typeof record.svg === 'string' && record.svg.length > 0;
    }

    function get(key) {
      // cacheEnabled=false means no cache at all — L1 included (design §10).
      var hit = config.cacheEnabled ? l1Get(key) : null;
      if (hit && isUsable(hit)) {
        if (stats) stats.cacheHitL1 += 1;
        return Promise.resolve(hit);
      }
      // l1Get() already promoted the record to the MRU end. If it is dead
      // (expired, foreign schema, no svg) it must go now, or it would sit at the
      // freshest LRU position forever while never serving a read — immortal and
      // un-evictable. L2 may still have a usable copy (e.g. a newer write from
      // another tab), so only the L1 copy is dropped.
      if (hit) l1Drop(key);
      if (!config.cacheEnabled || l2Available === false) return Promise.resolve(null);
      return tx('readonly', function (store) {
        return requestAsPromise(store.get(key));
      })
        .then(function (record) {
          if (!isUsable(record)) return null;
          l1Set(key, record);
          if (stats) stats.cacheHitL2 += 1;
          rememberHit(key, record);
          return record;
        })
        .catch(function (error) {
          warnOnce(error);
          return null;
        });
    }

    function put(record) {
      if (!record || !record.key) return Promise.resolve(false);
      if (!config.cacheEnabled) return Promise.resolve(false);
      // A record freezes the geometry the engine measured at write time. If a
      // webfont is still settling, that geometry is measured against a fallback
      // and the record would keep the wrong one for CACHE_TTL_DAYS — with no way
      // for the user to know, and no way for the plugin to self-correct later.
      // Skipping the write costs one re-render; writing the wrong one costs 30
      // days of a visibly wrong diagram.
      if (!fontsSettled(g.document)) {
        if (stats) stats.note('cacheSkipFont');
        return Promise.resolve(false);
      }
      l1Set(record.key, record);
      if (stats) stats.cacheWrite += 1;
      // Load the total *before* the write, so the base this record is added to
      // cannot already contain it. After the first write this is a resolved
      // promise and touches no IndexedDB.
      return ensureTotal()
        .then(function () {
          return writeRecord(record);
        })
        .then(accountWrite)
        .catch(function (error) {
          warnOnce(error);
          // Quota: drop the oldest batch and retry exactly once.
          return evict(0.5)
            .then(function (evicted) {
              if (!evicted) return false;
              return writeRecord(record).then(accountWrite);
            })
            .catch(function (second) {
              warnOnce(second);
              return false;
            });
        });
    }

    function capBytes() {
      return MMS.CONFIG.CACHE_MAX_MB * 1024 * 1024;
    }

    function sumBytes(list) {
      var total = 0;
      for (var i = 0; i < list.length; i += 1) {
        total += (list[i] && list[i].bytes) || 0;
      }
      return total;
    }

    /** Full read, failures included: the counter only updates on a real answer. */
    function readAll() {
      return tx('readonly', function (store) {
        return requestAsPromise(store.getAll());
      });
    }

    function allRecords() {
      return readAll()
        .then(function (list) {
          return list || [];
        })
        .catch(function (error) {
          warnOnce(error);
          return [];
        });
    }

    function ensureTotal() {
      if (totalBytes !== null) return Promise.resolve(totalBytes);
      if (totalPromise) return totalPromise;
      totalPromise = readAll()
        .then(function (list) {
          // `tx()` resolves null when there is no database at all: nothing can
          // be stored, so zero is exact rather than a guess.
          totalBytes = list ? sumBytes(list) : 0;
          return totalBytes;
        })
        .catch(function (error) {
          warnOnce(error);
          // Unknown stays unknown: an empty-looking total would disable the cap
          // for the rest of the session. The next write retries the load.
          return null;
        });
      totalPromise.then(function () {
        totalPromise = null;
      });
      return totalPromise;
    }

    /**
     * One put plus the O(1) read of the record it replaces. The old size only
     * exists to keep the counter exact on an overwrite (same key, re-rendered
     * SVG): one keyed `get` in the same transaction, where the old code paid
     * for `getAll()` per write. Resolves to the byte delta (0 when there is no
     * database, because then nothing was stored).
     */
    function writeRecord(record) {
      var previousBytes = 0;
      return tx('readwrite', function (store) {
        var probe = store.get(record.key);
        probe.onsuccess = function () {
          var previous = probe.result;
          previousBytes = previous && typeof previous.bytes === 'number' ? previous.bytes : 0;
          store.put(record);
        };
        return true;
      }).then(function (written) {
        if (!written) return 0;
        return (record.bytes || 0) - previousBytes;
      });
    }

    /**
     * Apply a successful write to the counter, then gate. Only a total above the
     * cap may start a scan; `enforceCapacity()` recalibrates from the store
     * while it evicts.
     */
    function accountWrite(delta) {
      if (totalBytes === null) return 0; // total unknown: no eviction on a guess
      totalBytes += delta;
      if (totalBytes <= capBytes()) return 0;
      return enforceCapacity();
    }

    /** Delete expired, foreign-schema and foreign-engine records. */
    function sweep() {
      if (!config.cacheEnabled) return Promise.resolve(0);
      return allRecords().then(function (list) {
        var now = Date.now();
        var engine = stats && stats.mermaidVersion !== 'unknown' ? stats.mermaidVersion : null;
        var doomed = list.filter(function (record) {
          if (!record) return false;
          if (record.schema !== MMS.CONFIG.SCHEMA) return true;
          if (engine && record.mermaidVersion && record.mermaidVersion !== engine) return true;
          if (record.expiresAt && record.expiresAt < now) return true;
          return false;
        });
        if (!doomed.length) return 0;
        var freed = 0;
        for (var i = 0; i < doomed.length; i += 1) freed += doomed[i].bytes || 0;
        return removeKeys(doomed.map(function (r) {
          return r.key;
        })).then(function (removed) {
          if (removed && totalBytes !== null) totalBytes = Math.max(0, totalBytes - freed);
          return removed;
        });
      });
    }

    function removeKeys(keys) {
      if (!keys.length) return Promise.resolve(0);
      return tx('readwrite', function (store) {
        keys.forEach(function (key) {
          store.delete(key);
        });
        return keys.length;
      }).catch(function (error) {
        warnOnce(error);
        return 0;
      });
    }

    /** Byte-budget eviction: keep the store under 90% of the cap. */
    function enforceCapacity() {
      var cap = capBytes();
      return ensureTotal().then(function (total) {
        if (total === null) return 0; // no trustworthy total: never evict blind
        if (total <= cap) return 0;
        // The only full scan left, and it has to happen here: an eviction needs
        // to know which records are oldest. It doubles as the recalibration for
        // the running counter, which is why drift from a concurrent tab heals.
        return readAll()
          .then(function (list) {
            if (!list) return 0;
            var exact = sumBytes(list);
            if (exact <= cap) {
              totalBytes = exact;
              return 0;
            }
            var target = cap * 0.9;
            var sorted = list.slice().sort(function (a, b) {
              return (a.lastUsed || 0) - (b.lastUsed || 0);
            });
            var doomed = [];
            while (exact > target && sorted.length) {
              var record = sorted.shift();
              exact -= record.bytes || 0;
              doomed.push(record.key);
            }
            if (stats) stats.cacheEvict += doomed.length;
            return removeKeys(doomed).then(function (removed) {
              // Recompute from the same snapshot: exact after the deletes we
              // just made, rather than "whatever the counter said before".
              if (removed) totalBytes = Math.max(0, exact);
              return removed;
            });
          })
          .catch(function (error) {
            warnOnce(error);
            return 0; // a failed scan must not read as "the store is empty"
          });
      });
    }

    /** Strategic eviction for quota errors: drop the oldest share of entries. */
    function evict(share) {
      return allRecords().then(function (list) {
        if (!list.length) return false;
        var sorted = list.slice().sort(function (a, b) {
          return (a.lastUsed || 0) - (b.lastUsed || 0);
        });
        var count = Math.max(1, Math.floor(sorted.length * share));
        var batch = sorted.slice(0, count);
        var doomed = batch.map(function (record) {
          return record.key;
        });
        var freed = 0;
        for (var i = 0; i < batch.length; i += 1) freed += batch[i].bytes || 0;
        if (stats) stats.cacheEvict += doomed.length;
        return removeKeys(doomed).then(function (removed) {
          // Keep the counter honest after a quota rescue; `evict` has the exact
          // sizes in hand, so this is a recalibration, not an estimate.
          if (removed && totalBytes !== null) totalBytes = Math.max(0, sumBytes(list) - freed);
          return true;
        });
      });
    }

    function clear() {
      l1Clear();
      if (!g.indexedDB) {
        totalBytes = 0;
        return Promise.resolve(false);
      }
      return tx('readwrite', function (store) {
        store.clear();
        return true;
      })
        .then(function (cleared) {
          if (cleared) totalBytes = 0;
          return cleared;
        })
        .catch(function (error) {
          warnOnce(error);
          return false;
        });
    }

    /** Uninstall path: remove the database itself, not just its records. */
    function dropDatabase() {
      l1Clear();
      if (!g.indexedDB) {
        totalBytes = 0;
        return Promise.resolve(false);
      }
      // The store this counter describes is about to stop existing: forget the
      // total too, or the next put would gate against a number for a database
      // that is gone (and never re-initialise, because the total was "known").
      totalBytes = null;
      totalPromise = null;
      var db = dbPromise;
      dbPromise = null;
      l2Available = null;
      return Promise.resolve(db)
        .then(function (handle) {
          if (handle) {
            try {
              handle.close();
            } catch (error) {
              /* already closed */
            }
          }
        })
        .then(function () {
          return new Promise(function (resolve) {
            var settled = false;
            function done(value) {
              if (settled) return;
              settled = true;
              resolve(value);
            }
            var request;
            try {
              request = g.indexedDB.deleteDatabase(MMS.CONFIG.IDB_NAME);
            } catch (error) {
              done(false);
              return;
            }
            request.onsuccess = function () {
              done(true);
            };
            request.onerror = function () {
              done(false);
            };
            // A blocked delete (another page still holds a connection) must not
            // hang uninstall: the delete is queued by the browser and will land
            // when that connection closes.
            request.onblocked = function () {
              done(false);
            };
            setTimeout(function () {
              done(false);
            }, 1000);
          });
        });
    }

    function dropScope(scopeHash) {
      return tx('readwrite', function (store) {
        var index = store.index('scopeHash');
        return requestAsPromise(index.getAllKeys(scopeHash)).then(function (keys) {
          (keys || []).forEach(function (key) {
            store.delete(key);
          });
          if ((keys || []).length) {
            // This path deletes by key and never sees the sizes; invalidating
            // the counter costs one lazy re-read on the next write instead of a
            // silently wrong total.
            totalBytes = null;
          }
          return (keys || []).length;
        });
      }).catch(function (error) {
        warnOnce(error);
        return 0;
      });
    }

    function makeRecord(fields) {
      var now = Date.now();
      var ttl = MMS.CONFIG.CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
      return {
        key: fields.key,
        source: fields.source,
        svg: fields.svg,
        width: fields.width,
        height: fields.height,
        theme: fields.theme,
        mermaidVersion: fields.mermaidVersion,
        schema: MMS.CONFIG.SCHEMA,
        renderId: fields.renderId,
        scopeHash: fields.scopeHash,
        createdAt: now,
        lastUsed: now,
        expiresAt: now + ttl,
        hits: 0,
        bytes: byteLength(fields.svg)
      };
    }

    return {
      get: get,
      put: put,
      makeRecord: makeRecord,
      sweep: sweep,
      clear: clear,
      dropDatabase: dropDatabase,
      dropScope: dropScope,
      enforceCapacity: enforceCapacity,
      l1Size: function () {
        return l1.size;
      },
      l1Bytes: function () {
        return l1Bytes;
      },
      l1BudgetBytes: function () {
        return l1BudgetBytes;
      },
      isL2Available: function () {
        return l2Available;
      },
      open: openDb
    };
  }

  MMS.createCache = createCache;
  MMS.cacheInternal = { byteLength: byteLength, fontsSettled: fontsSettled };
})(typeof globalThis !== 'undefined' ? globalThis : this);
