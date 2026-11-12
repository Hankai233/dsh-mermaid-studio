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

    function l1Set(key, record) {
      if (l1.has(key)) l1.delete(key);
      l1.set(key, record);
      while (l1.size > MMS.CONFIG.L1_MAX) {
        l1.delete(l1.keys().next().value);
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
      return tx('readwrite', function (store) {
        store.put(record);
        return true;
      })
        .then(function () {
          return enforceCapacity();
        })
        .catch(function (error) {
          warnOnce(error);
          // Quota: drop the oldest batch and retry exactly once.
          return evict(0.5)
            .then(function (evicted) {
              if (!evicted) return false;
              return tx('readwrite', function (store) {
                store.put(record);
                return true;
              });
            })
            .catch(function (second) {
              warnOnce(second);
              return false;
            });
        });
    }

    function allRecords() {
      return tx('readonly', function (store) {
        return requestAsPromise(store.getAll());
      })
        .then(function (list) {
          return list || [];
        })
        .catch(function (error) {
          warnOnce(error);
          return [];
        });
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
        return removeKeys(doomed.map(function (r) {
          return r.key;
        }));
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
      var capBytes = MMS.CONFIG.CACHE_MAX_MB * 1024 * 1024;
      return allRecords().then(function (list) {
        var total = list.reduce(function (sum, record) {
          return sum + (record.bytes || 0);
        }, 0);
        if (total <= capBytes) return 0;
        var target = capBytes * 0.9;
        var sorted = list.slice().sort(function (a, b) {
          return (a.lastUsed || 0) - (b.lastUsed || 0);
        });
        var doomed = [];
        while (total > target && sorted.length) {
          var record = sorted.shift();
          total -= record.bytes || 0;
          doomed.push(record.key);
        }
        if (stats) stats.cacheEvict += doomed.length;
        return removeKeys(doomed);
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
        var doomed = sorted.slice(0, count).map(function (record) {
          return record.key;
        });
        if (stats) stats.cacheEvict += doomed.length;
        return removeKeys(doomed).then(function () {
          return true;
        });
      });
    }

    function clear() {
      l1.clear();
      if (!g.indexedDB) return Promise.resolve(false);
      return tx('readwrite', function (store) {
        store.clear();
        return true;
      }).catch(function (error) {
        warnOnce(error);
        return false;
      });
    }

    /** Uninstall path: remove the database itself, not just its records. */
    function dropDatabase() {
      l1.clear();
      if (!g.indexedDB) return Promise.resolve(false);
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
      isL2Available: function () {
        return l2Available;
      },
      open: openDb
    };
  }

  MMS.createCache = createCache;
  MMS.cacheInternal = { byteLength: byteLength, fontsSettled: fontsSettled };
})(typeof globalThis !== 'undefined' ? globalThis : this);
