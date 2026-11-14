/* ── scan.js — find fences in the conversation, keep one card per fence ─────
 *
 * Scope: only inside `[data-slot="conversation.chat.flow"]`. Anything rendered
 * elsewhere (sidebar previews, settings samples, plugin pages) is left alone —
 * rendering it would also write its full text into a 30-day store, which is a
 * data-boundary change nobody asked for.
 *
 * Identity: a WeakMap from the host's block element to this plugin's card.
 * `data-mms-key` is a cache key, and five identical fences share one cache key;
 * reconciling by key would collapse them into a single card. So reconciliation
 * walks *nodes*, and the attribute is only for debugging and assertions.
 *
 * Orphan sweep: React can replace a code block wholesale. The card is a sibling,
 * so it is not in `removedNodes`; without the adjacency check below the plugin
 * would leave a second card behind (design P0-9).
 */
(function (g) {
  'use strict';
  var MMS = g.__MMS__ || (g.__MMS__ = {});

  function idle(fn) {
    if (typeof g.requestIdleCallback === 'function') {
      g.requestIdleCallback(fn, { timeout: 300 });
      return;
    }
    setTimeout(fn, MMS.CONFIG.SCAN_IDLE_FALLBACK_MS);
  }

  function startScanner(app) {
    var doc = g.document;
    var roots = new Map();
    var disposed = false;
    var io = null;
    var uidSeq = 0;

    if (typeof g.IntersectionObserver === 'function' && MMS.CONFIG.LAZY_RENDER) {
      io = new g.IntersectionObserver(
        function (entries) {
          for (var i = 0; i < entries.length; i += 1) {
            var entry = entries[i];
            if (!entry.isIntersecting) continue;
            var record = cardStates.get(entry.target);
            if (!record) continue;
            record.visible = true;
            io.unobserve(entry.target);
            scheduleRender(record, 'visible');
          }
        },
        { rootMargin: '200px 0px' }
      );
    }

    var blockStates = new WeakMap();
    /**
     * Lazy rendering observes the CARD, not the code block: in the default
     * "diagram" view the code block is display:none, and an IntersectionObserver
     * never fires for a hidden target — the card would wait for a viewport entry
     * that can never happen. (The harness caught exactly this.)
     */
    var cardStates = new WeakMap();

    // The prerender gates hang off two app signals: "the user has gone quiet"
    // and "the user is back". Both are passive listeners owned by index.js.
    var offQuiet = app.onQuiet
      ? app.onQuiet(function () {
          schedulePrerender();
        })
      : null;
    var offActivity = app.onActivity
      ? app.onActivity(function () {
          cancelBackground();
        })
      : null;

    function stateOf(block) {
      return blockStates.get(block) || null;
    }

    function uid(prefix) {
      uidSeq += 1;
      return prefix + '-' + uidSeq;
    }

    /**
     * Privacy rule for the fallback path: only a block whose nearest slot is a
     * conversation slot may render. A block with no slot ancestor at all is
     * accepted, because that is what an older host without slot markers looks
     * like — the rule has to degrade, not disappear.
     */
    function inConversationScope(block) {
      var slot = block.closest ? block.closest('[data-slot]') : null;
      if (!slot) return true;
      return /^conversation\./.test(slot.getAttribute('data-slot') || '');
    }

    // ── root management ────────────────────────────────────────────────────
    function observeRoot(root, options) {
      if (roots.has(root)) return;
      var record = {
        root: root,
        fallback: !!(options && options.fallback),
        observer: null,
        candidates: new Set(),
        batchPending: false,
        dropped: false,
        cards: new Map() // block -> blockRecord
      };
      record.observer = new g.MutationObserver(function (mutations) {
        handleMutations(record, mutations);
      });
      record.observer.observe(root, { childList: true, subtree: true, characterData: true });
      roots.set(root, record);
      collectAll(record);
    }

    function dropRoot(root) {
      var record = roots.get(root);
      if (!record) return;
      // Mark first, and before the teardown below: an idle batch may already be
      // queued for this root, and a dropped root must not resume scanning (or
      // resurrect a card for a conversation that is gone).
      record.dropped = true;
      record.candidates.clear();
      record.observer.disconnect();
      record.cards.forEach(function (blockRecord) {
        disposeRecord(blockRecord);
      });
      record.cards.clear();
      if (io) {
        record.cards.forEach(function (blockRecord) {
          if (blockRecord.card) io.unobserve(blockRecord.card.el);
        });
        record.candidates.forEach(function (block) {
          io.unobserve(block);
        });
      }
      roots.delete(root);
    }

    function collectAll(record) {
      var blocks = record.root.querySelectorAll(MMS.fence.SELECTORS.block);
      for (var i = 0; i < blocks.length; i += 1) {
        candidate(record, blocks[i]);
      }
      flush(record);
    }

    function nearestBlock(node) {
      if (!node) return null;
      var element = node.nodeType === 1 ? node : node.parentElement;
      if (!element || !element.closest) return null;
      return element.closest(MMS.fence.SELECTORS.block);
    }

    function handleMutations(record, mutations) {
      for (var i = 0; i < mutations.length; i += 1) {
        var mutation = mutations[i];
        if (mutation.type === 'characterData') {
          var target = nearestBlock(mutation.target.parentElement || mutation.target);
          if (target) candidate(record, target);
          continue;
        }
        var added = mutation.addedNodes;
        for (var a = 0; a < added.length; a += 1) {
          var node = added[a];
          if (node.nodeType !== 1) continue;
          if (node.matches && node.matches(MMS.fence.SELECTORS.block)) candidate(record, node);
          if (node.querySelectorAll) {
            var inner = node.querySelectorAll(MMS.fence.SELECTORS.block);
            for (var b = 0; b < inner.length; b += 1) candidate(record, inner[b]);
          }
        }
        var removed = mutation.removedNodes;
        for (var r = 0; r < removed.length; r += 1) {
          var gone = removed[r];
          if (gone.nodeType !== 1) continue;
          record.cards.forEach(function (blockRecord, block) {
            if (block === gone || gone.contains(block)) disposeRecord(blockRecord);
          });
        }
      }
      flush(record);
    }

    /**
     * The one idle hop: at most one flush is queued per root, so a burst of
     * mutations (or one batch leaving work behind) costs one batch, not one
     * flush per block.
     */
    function scheduleFlush(record) {
      if (disposed || record.dropped) return;
      if (record.batchPending) return;
      record.batchPending = true;
      idle(function () {
        record.batchPending = false;
        flush(record);
      });
    }

    function candidate(record, block) {
      if (!block || !block.isConnected) return;
      record.candidates.add(block);
      scheduleFlush(record);
    }

    /**
     * Drain the candidate set, BATCH_MAX at a time. Never `clear()` it.
     *
     * A root can arrive with every fence already in place — reload, session
     * switch, a long conversation restored from the host — so `collectAll()`
     * fills `candidates` in one go and flushes synchronously. The old
     * `Array.from(...).slice(0, BATCH_MAX)` + `clear()` moved the first 20 into
     * cards and *dropped the rest forever*: static history produces no further
     * mutation, so diagram 21+ stayed a source block with no error and no
     * counter. Now each candidate is deleted from the set *before* it is
     * examined (the set therefore strictly shrinks — that is the loop guard,
     * and `examine()` never re-adds a node), and whatever a batch leaves behind
     * asks for another idle flush through the same `scheduleFlush` above.
     */
    function flush(record) {
      if (disposed || record.dropped) return;
      var budget = MMS.CONFIG.BATCH_MAX;
      var examined = 0;
      var pending = record.candidates.values();
      var next = pending.next();
      while (!next.done && examined < budget) {
        record.candidates.delete(next.value);
        examined += 1;
        try {
          examine(record, next.value);
        } catch (error) {
          app.stats.error('examine: ' + error.message);
        }
        next = pending.next();
      }
      sweepOrphans(record);
      schedulePrerender();
      if (record.candidates.size > 0) scheduleFlush(record);
    }

    // ── one candidate ──────────────────────────────────────────────────────
    /**
     * Decide what this block is now. Streaming rewrites text under the same
     * node, so the decision has to be debounced: a fence mid-token would render
     * a syntax error, then immediately be replaced.
     */
    function examine(record, block) {
      if (disposed || !block.isConnected) return;
      if (!record.root.contains(block)) return;
      if (MMS.fence.inOwnCard(block) || MMS.fence.inExcludedRegion(block)) return;
      if (record.fallback && !inConversationScope(block)) return;

      var existing = record.cards.get(block);
      var fence;
      try {
        fence = MMS.fence.parseFence(block);
      } catch (error) {
        app.stats.fenceMiss += 1;
        app.stats.error('parseFence: ' + error.message);
        return;
      }

      if (!fence) {
        // The host rewrote this block into something that is not a mermaid
        // fence (language label changed, content replaced).
        if (existing) {
          disposeRecord(existing);
          record.cards.delete(block);
        }
        return;
      }

      if (fence.empty) {
        if (existing) {
          disposeRecord(existing);
          record.cards.delete(block);
        }
        return;
      }

      if (existing && existing.source === fence.source && !existing.dirty) {
        if (existing.card && !existing.card.el.isConnected) {
          existing.card.mount(block);
        }
        return;
      }

      if (fence.overLong) {
        var created = createRecord(record, block, fence);
        record.cards.set(block, created);
        created.card.showOverLong();
        return;
      }

      var changed = !!existing;
      if (existing) clearTimer(existing);
      var blockRecord = existing || createRecord(record, block, fence);
      if (!existing) record.cards.set(block, blockRecord);

      blockRecord.fence = fence;
      blockRecord.source = fence.source;
      blockRecord.key = keyFor(fence.source, block);
      blockRecord.card.el.setAttribute('data-mms-key', blockRecord.key.slice(0, 16));
      blockRecord.dirty = false;
      if (changed) {
        // Text changed under an existing card: mark the in-flight job stale and
        // wait for the text to go quiet before rendering again.
        if (blockRecord.job) blockRecord.job.superseded = true;
        blockRecord.job = null;
        if (blockRecord.card.state.phase === 'ready') {
          // Already showing an older diagram: swap it without re-mounting.
          blockRecord.card.showPending();
        }
      }
      scheduleRender(blockRecord, 'content');
    }

    function clearTimer(record) {
      if (record.timer) {
        clearTimeout(record.timer);
        record.timer = null;
      }
    }

    function createRecord(record, block, fence) {
      var key = keyFor(fence.source, block);
      var card = MMS.createCard(app, {
        key: key,
        source: fence.source,
        rejected: fence.rejected
      });
      card.mount(block);
      // Reserve the diagram's box before the first paint: a card that starts at
      // zero height and grows when the SVG lands is what shifts the whole
      // conversation under the reader.
      if (card.presize) card.presize();
      var blockRecord = {
        uid: uid('b'),
        root: record.root,
        block: block,
        card: card,
        key: key,
        source: fence.source,
        fence: fence,
        /** Source whose SVG the card currently displays; null until injected. */
        shownSource: null,
        visible: !io,
        dirty: false,
        job: null,
        timer: null
      };
      if (io && !fence.overLong) io.observe(card.el);
      blockStates.set(block, blockRecord);
      cardStates.set(card.el, blockRecord);
      app.stats.fenceSeen += 1;
      return blockRecord;
    }

    function disposeRecord(blockRecord) {
      clearTimer(blockRecord);
      if (blockRecord.job) blockRecord.job.superseded = true;
      blockRecord.job = null;
      if (blockRecord.card) {
        if (io) io.unobserve(blockRecord.card.el);
        cardStates.delete(blockRecord.card.el);
        blockRecord.card.dispose();
      }
      if (io && blockRecord.block) io.unobserve(blockRecord.block);
      blockStates.delete(blockRecord.block);
      var record = roots.get(blockRecord.root);
      if (record) record.cards.delete(blockRecord.block);
    }

    function sweepOrphans(record) {
      var doomed = [];
      record.cards.forEach(function (blockRecord, block) {
        var card = blockRecord.card;
        if (!block.isConnected || !card || !card.el.isConnected) {
          doomed.push(blockRecord);
          return;
        }
        // Card must sit immediately before its block, or it belongs to a block
        // React has already replaced.
        if (card.el.nextElementSibling !== block) {
          var next = card.el.nextElementSibling;
          while (next && next.nodeType !== 1) next = next.nextElementSibling;
          if (next !== block) doomed.push(blockRecord);
        }
      });
      for (var i = 0; i < doomed.length; i += 1) disposeRecord(doomed[i]);
    }

    // ── render one record ──────────────────────────────────────────────────
    function keyFor(source, block) {
      var theme = app.theme();
      return MMS.key.buildKey({
        mermaidVersion: app.mermaidVersion(),
        theme: theme,
        scopeHash: app.scopeHash(),
        themeRevision: MMS.theme.revision(block),
        fontCode: MMS.theme.sampleFontCode(block),
        renderConfig: MMS.renderConfig.configToken(theme, app.fontFamily(block)),
        source: source
      });
    }

    function scheduleRender(blockRecord, reason) {
      if (disposed) return;
      if (!blockRecord.visible) return; // lazy: wait for the viewport
      if (reason === 'content') {
        clearTimer(blockRecord);
        blockRecord.timer = setTimeout(function () {
          blockRecord.timer = null;
          if (!disposed) decide(blockRecord);
        }, MMS.CONFIG.STREAM_DEBOUNCE_MS);
        return;
      }
      decide(blockRecord);
    }

    /**
     * Whether the card is already showing a diagram of the *current* source.
     *
     * `showPending()` only flips `data-mms-state` to `pending`, and the skeleton
     * is an overlay that CSS reveals for that state — the old SVG stays in the
     * stage underneath (injection replaces it only on success). So calling it
     * while a diagram is up paints a skeleton *on top of* that diagram: on a
     * theme switch `rerenderAll` walks every card, and each one flashed
     * "old figure + skeleton" until its new SVG landed. Keeping the current
     * figure on screen until the replacement is injected is both quieter and
     * more truthful: a cache hit usually arrives in the same frame and the SVG
     * is swapped without ever hiding it.
     */
    function keepsShown(blockRecord) {
      var card = blockRecord.card;
      if (!card || card.state.phase !== 'ready') return false;
      // Same source, possibly a different theme key: the displayed figure is
      // still an honest stand-in for this fence until the new one is ready.
      return blockRecord.shownSource === blockRecord.source;
    }

    function decide(blockRecord) {
      if (disposed || !blockRecord.block.isConnected) return;
      var card = blockRecord.card;
      // Over-long sources never enter the queue: mermaid would reject them (or
      // worse, chew on them) and the engine's own limit is the same number.
      if (blockRecord.fence && blockRecord.fence.overLong) {
        card.showOverLong();
        return;
      }
      var theme = app.theme();
      var key = keyFor(blockRecord.source, blockRecord.block);
      blockRecord.key = key;
      card.key = key;
      card.state.rejectedDirectives = !!blockRecord.fence.rejected;
      card.el.setAttribute('data-mms-key', key.slice(0, 16));

      // Only ask for the skeleton when there is nothing to show, or what is
      // shown belongs to another source. See keepsShown().
      if (!keepsShown(blockRecord)) card.showPending();

      // Negative cache: streaming output produces the same broken fence over and
      // over; without this the queue would re-render it every time. Manual retry
      // clears the entry (app.retry), so this is never a dead end.
      var failedAt = app.negative.get(key);
      if (failedAt && Date.now() - failedAt < MMS.CONFIG.NEGATIVE_TTL_MS) {
        card.showError('渲染失败', true, '5 分钟内不自动重试；点「重试」立即重新渲染');
        return;
      }

      app.cache
        .get(key)
        .then(function (record) {
          if (disposed || !blockRecord.block.isConnected) return;
          if (blockRecord.job && blockRecord.job.superseded) return;
          if (record) {
            card.setSkeletonSize(record.width, record.height);
            var ok = card.showSvg(record.svg, record.renderId, {
              clamped: !!record.clamped
            });
            if (ok) {
              blockRecord.shownSource = blockRecord.source;
              return;
            }
          }
          enqueue(blockRecord, key, theme);
        })
        .catch(function (error) {
          app.stats.error('cache get: ' + error.message);
          enqueue(blockRecord, key, theme);
        });
    }

    function enqueue(blockRecord, key, theme) {
      // A prerender already under way lands in this very card; queuing a second
      // render for it would just duplicate ~240 ms of work.
      if (blockRecord.job && blockRecord.job.background && !blockRecord.job.superseded) return;
      // Foreground work cancels queued background work: nothing the user is
      // looking at may wait behind a diagram nobody has scrolled to yet.
      if (app.queue.dropBackground) app.queue.dropBackground();
      var job = {
        uid: uid('j'),
        key: key,
        source: blockRecord.source,
        theme: theme,
        renderId: app.nextRenderId(blockRecord.uid),
        fontFamily: app.fontFamily(blockRecord.block),
        superseded: false,
        // "排队中" until the queue hands this job the slot. With pacing between
        // renders there is now a wait the reader can actually see, so the two
        // words have to mean two different things.
        onStart: function () {
          if (blockRecord.card) blockRecord.card.showRendering();
        },
        stale: function () {
          return job.superseded || !blockRecord.block.isConnected;
        }
      };
      blockRecord.job = job;
      blockRecord.uid = job.uid;
      app.stats.renderCount += 1;
      app.stats.publish();
      app.queue.push(job);
    }

    // ── controlled offscreen prerender ─────────────────────────────────────
    /*
     * The lazy gate (scheduleRender) means a diagram is rendered at the moment
     * it scrolls into view — which is exactly the moment a ~240 ms main-thread
     * block is most expensive, because the reader is mid-scroll. This path pays
     * that block earlier, in a quiet idle window, and stores the SVG, so arrival
     * is a cache hit.
     *
     * The gates are the feature, not safety rails bolted on afterwards:
     *   - cacheEnabled only: the product of the work *is* a cache write.
     *   - no user input/scroll for PRERENDER_QUIET_MS, and never while the tab
     *     is hidden (both mean the user is not waiting on us).
     *   - one job at a time, and only when the queue is empty (never in front of
     *     a real render).
     *   - the fence must be unchanged for PRERENDER_STABLE_MS, so mid-stream
     *     text is never prerendered.
     *   - a failed prerender writes nothing: no negative-cache entry, no error
     *     card for a diagram the user has not seen. They get an ordinary render
     *     when they arrive.
     */
    var bgTimer = null;
    var bgInflight = null;
    /**
     * Keys that already had a background attempt: an insertion-ordered set.
     *
     * Its job is dedupe inside a quiet window. Without it the scheduler keeps
     * picking the same unrendered fence whose render just failed or was skipped,
     * and the prerender loop spins on one diagram. The original was a plain
     * object with no bound and one ~40-character key per distinct cache key
     * (source × theme × scope × font × render config) for the life of the page,
     * cleared only on dispose — a long session with theme switches reached five
     * digits. Past the cap the oldest attempts are forgotten, which at worst
     * costs one extra prerender of a diagram nobody has looked at in hours.
     */
    var BG_ATTEMPTED_MAX = 400;
    var bgAttempted = new Map();

    function prerenderEnabled() {
      if (disposed || !MMS.CONFIG.PRERENDER) return false;
      if (!app.config.cacheEnabled) return false;
      if (doc.hidden) return false;
      if (app.isBreakerOpen()) return false;
      // No gesture yet means the page is still being read for the first time, not
      // that the reader is idle: at boot the plugin has no evidence either way, so
      // it does nothing and waits for a real quiet window after a real gesture.
      if (app.hasActivity && !app.hasActivity()) return false;
      return true;
    }

    function queueIsBusy() {
      return app.queue.isBusy() || app.queue.length() > 0;
    }

    /** Run in an idle window or not at all: starting late is worse than skipping. */
    function idleBackground(fn) {
      if (typeof g.requestIdleCallback === 'function') {
        return g.requestIdleCallback(fn, { timeout: MMS.CONFIG.PRERENDER_IDLE_TIMEOUT_MS });
      }
      return setTimeout(fn, 0);
    }

    /** Remember one attempt, dropping the oldest overflow past the cap. */
    function noteAttempted(key) {
      bgAttempted.set(key, true);
      var overflow = bgAttempted.size - BG_ATTEMPTED_MAX;
      if (overflow <= 0) return;
      // Insertion order is age order. Evict exactly the overflow instead of
      // clearing the set: a clear would re-prerender everything offscreen in one
      // burst, which is the behaviour this gate exists to prevent.
      var keys = bgAttempted.keys();
      var next = keys.next();
      while (overflow > 0 && !next.done) {
        bgAttempted.delete(next.value);
        overflow -= 1;
        next = keys.next();
      }
    }

    function cancelBackground() {
      if (bgTimer !== null) {
        if (typeof g.cancelIdleCallback === 'function') g.cancelIdleCallback(bgTimer);
        else clearTimeout(bgTimer);
        bgTimer = null;
      }
      if (app.queue.dropBackground) {
        var dropped = app.queue.dropBackground();
        if (dropped && app.stats) app.stats.note('prerenderCancelled', dropped);
      }
    }

    /** The first offscreen fence that is stable, unrendered and not yet tried. */
    function pickBackgroundTarget() {
      var best = null;
      roots.forEach(function (record) {
        if (best) return;
        record.cards.forEach(function (blockRecord) {
          if (best) return;
          if (blockRecord.visible || !blockRecord.block.isConnected) return;
          if (blockRecord.job || blockRecord.timer || blockRecord.dirty) return;
          if (!blockRecord.card || blockRecord.card.state.phase !== 'pending') return;
          if (!blockRecord.source) return;
          if (blockRecord.fence && blockRecord.fence.overLong) return;
          if (bgAttempted.has(blockRecord.key)) return;
          if (app.negative.get(blockRecord.key)) return;
          best = blockRecord;
        });
      });
      return best;
    }

    function startBackgroundRender(target) {
      if (disposed || bgInflight) return;
      var job = {
        uid: uid('bg'),
        key: target.key,
        source: target.source,
        theme: app.theme(),
        renderId: app.nextRenderId(target.uid),
        fontFamily: app.fontFamily(target.block),
        superseded: false,
        background: true,
        stale: function () {
          return !target.block.isConnected || target.card.state.phase !== 'pending';
        }
      };
      target.job = job;
      bgInflight = job.uid;
      if (app.stats) app.stats.note('prerenderScheduled');
      app.queue.push(job);
    }

    /**
     * Ask for one prerender. Cheap to call often: every gate is re-checked at
     * fires time, because a scroll may arrive during the idle wait.
     */
    function schedulePrerender() {
      if (!prerenderEnabled() || bgTimer !== null || bgInflight) return;
      if (queueIsBusy()) return;
      if (app.activityAge() < MMS.CONFIG.PRERENDER_QUIET_MS) return;
      var target = pickBackgroundTarget();
      if (!target) return;
      bgTimer = idleBackground(function () {
        bgTimer = null;
        if (!prerenderEnabled() || bgInflight || queueIsBusy()) return;
        if (app.activityAge() < MMS.CONFIG.PRERENDER_QUIET_MS) return;
        if (target.visible || !target.block.isConnected || target.job) return;
        noteAttempted(target.key);
        app.cache
          .get(target.key)
          .then(function (record) {
            if (record || disposed) return; // already stored: nothing to prerender
            startBackgroundRender(target);
          })
          .catch(function () {
            startBackgroundRender(target);
          });
      });
    }

    // ── outcomes from the queue ────────────────────────────────────────────
    /**
     * Negative-cache cap. The TTL is evaluated on read, so an entry that simply
     * sits there is inert — but it is also never removed, and every distinct
     * failed diagram (one per source × theme) left a permanent entry behind: the
     * map grew with the number of broken fences a session ever produced.
     * Pruning on write keeps the read-side TTL semantics untouched (an expired
     * key is still ignored, so a retry is allowed) and only ever bounds memory.
     */
    var NEGATIVE_MAX = 200;

    /** Store one negative entry, sweeping expired ones when the map is over cap. */
    function noteNegative(key) {
      var now = Date.now();
      var ttl = MMS.CONFIG.NEGATIVE_TTL_MS;
      app.negative.set(key, now);
      if (app.negative.size <= NEGATIVE_MAX) return;
      app.negative.forEach(function (at, entryKey) {
        // Deleting the current entry inside forEach is allowed; an entry that
        // is already expired can never block a retry, so dropping it is free.
        if (!(now - at < ttl)) app.negative.delete(entryKey);
      });
      var overflow = app.negative.size - NEGATIVE_MAX;
      if (overflow <= 0) return;
      // Still over cap with nothing expired: drop the oldest writes. They expire
      // soonest, and forgetting one only allows an *earlier* retry — never a
      // dead end, which is the only property the TTL has to keep.
      var keys = app.negative.keys();
      var next = keys.next();
      while (overflow > 0 && !next.done) {
        app.negative.delete(next.value);
        overflow -= 1;
        next = keys.next();
      }
    }

    function onOutcome(outcome) {
      if (disposed) return;
      if (outcome.type === 'breaker') {
        roots.forEach(function (record) {
          record.cards.forEach(function (blockRecord) {
            if (blockRecord.card) blockRecord.card.setBreakerVisible(true);
          });
        });
        return;
      }
      if (outcome.type === 'export') return; // handled by the export resolver
      var target = findRecordByUid(outcome.uid);
      if (!target || !target.card) return;
      if (target.job && target.job.uid !== outcome.uid) return; // superseded attempt
      var background = !!(target.job && target.job.background);
      if (background) bgInflight = null;

      function finishBackground(kind) {
        target.job = null;
        if (app.stats) app.stats.note(kind);
        app.stats.publish();
        // Chain the next candidate; a batch of offscreen diagrams is rendered
        // one idle window at a time, never as a burst.
        schedulePrerender();
      }

      if (outcome.type === 'ready') {
        var record = app.cache.makeRecord({
          key: target.key,
          source: target.source,
          svg: outcome.svg,
          width: 0,
          height: 0,
          theme: app.theme(),
          mermaidVersion: app.mermaidVersion(),
          renderId: outcome.renderId,
          scopeHash: app.scopeHash()
        });
        var injected = target.card.showSvg(outcome.svg, outcome.renderId, {});
        if (!injected) {
          app.stats.error('injection rejected');
          return;
        }
        target.shownSource = target.source;
        var svg = target.card.getSvg();
        if (svg) {
          try {
            var box = svg.getBBox();
            record.width = box.width;
            record.height = box.height;
          } catch (error) {
            /* bbox unavailable: the skeleton simply has no fixed size */
          }
        }
        app.cache.put(record).catch(function () {});
        if (background) finishBackground('prerenderDone');
        return;
      }

      if (outcome.type === 'timeout') {
        // A prerender that times out stays invisible: no error card for a
        // diagram the user has not seen, and no negative-cache entry either.
        if (background) {
          finishBackground('prerenderSkipped');
          return;
        }
        target.card.showError('渲染超时（15 秒）', true, '可以重试；若连续超时请点「重置渲染器」');
        return;
      }

      if (outcome.type === 'error') {
        var message = (outcome.error && outcome.error.message) || '渲染失败';
        // Never judge a diagram nobody has looked at: a background failure just
        // stops the attempt, so the reader gets an ordinary render on arrival.
        if (background) {
          finishBackground('prerenderSkipped');
          return;
        }
        target.card.showError('渲染失败', true, message);
        noteNegative(target.key);
        return;
      }
    }

    function findRecordByUid(target) {
      var found = null;
      roots.forEach(function (record) {
        record.cards.forEach(function (blockRecord) {
          if (found) return;
          if (blockRecord.job && blockRecord.job.uid === target) found = blockRecord;
          else if (blockRecord.uid === target) found = blockRecord;
        });
      });
      return found;
    }

    // ── theme changes ──────────────────────────────────────────────────────
    function rerenderAll() {
      // Every key changes with the theme, so any queued prerender is aimed at a
      // record that will never be requested again.
      cancelBackground();
      roots.forEach(function (record) {
        record.cards.forEach(function (blockRecord) {
          if (!blockRecord.block.isConnected) return;
          var key = keyFor(blockRecord.source, blockRecord.block);
          blockRecord.key = key;
          blockRecord.card.key = key;
          // Cache first: the other theme's SVG is usually already there.
          decide(blockRecord);
        });
      });
    }

    function disposeAll() {
      disposed = true;
      clearTimeout(scopeFallbackTimer);
      cancelBackground();
      if (offQuiet) offQuiet();
      if (offActivity) offActivity();
      bgInflight = null;
      bgAttempted.clear();
      roots.forEach(function (record, root) {
        dropRoot(root);
      });
      roots.clear();
      if (io) io.disconnect();
    }

    // ── bootstrapping ──────────────────────────────────────────────────────
    // Roots appear and disappear with the session; a fresh root gets a full
    // scan (observeRoot → collectAll), a removed one is torn down with its cards.
    var rootWatcher = new g.MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i += 1) {
        var mutation = mutations[i];
        for (var a = 0; a < mutation.addedNodes.length; a += 1) {
          var node = mutation.addedNodes[a];
          if (node.nodeType !== 1) continue;
          if (node.matches && node.matches(MMS.fence.SELECTORS.root)) observeRoot(node);
          if (node.querySelectorAll) {
            var inner = node.querySelectorAll(MMS.fence.SELECTORS.root);
            for (var b = 0; b < inner.length; b += 1) observeRoot(inner[b]);
          }
        }
        for (var r = 0; r < mutation.removedNodes.length; r += 1) {
          var gone = mutation.removedNodes[r];
          if (gone.nodeType !== 1) continue;
          roots.forEach(function (record, root) {
            if (root === gone || gone.contains(root)) dropRoot(root);
          });
        }
      }
    });

    rootWatcher.observe(doc.body, { childList: true, subtree: true });

    var initial = doc.querySelectorAll(MMS.fence.SELECTORS.root);
    for (var i = 0; i < initial.length; i += 1) observeRoot(initial[i]);

    // The slot anchor is a host contract, not a promise. If it is missing but
    // fences exist, observing nothing would look exactly like "plugin broken".
    // Fall back to the document, keep the conversation-scope filter, and record
    // the degradation in __mmsStats.scopeFallback.
    var scopeFallbackTimer = setTimeout(function () {
      if (disposed || roots.size > 0) return;
      if (!doc.querySelector(MMS.fence.SELECTORS.block)) return;
      app.stats.scopeFallback = 1;
      app.stats.publish();
      console.warn('[mms] chat flow slot not found; using conversation-scope fallback');
      observeRoot(doc.body, { fallback: true });
    }, 3000);

    return {
      rerenderAll: rerenderAll,
      /** QA: force a prerender attempt past the quiet gate. */
      schedulePrerender: schedulePrerender,
      prerenderState: function () {
        return {
          enabled: prerenderEnabled(),
          scheduled: bgTimer !== null,
          inflight: bgInflight,
          attempted: bgAttempted.size
        };
      },
      rerenderCard: function (card) {
        var hit = null;
        roots.forEach(function (record) {
          record.cards.forEach(function (blockRecord) {
            if (!hit && blockRecord.card === card) hit = blockRecord;
          });
        });
        if (!hit) return false;
        if (hit.job) hit.job.superseded = true;
        hit.job = null;
        decide(hit);
        return true;
      },
      dispose: disposeAll,
      rescan: function () {
        roots.forEach(function (record) {
          collectAll(record);
        });
      },
      rootCount: function () {
        return roots.size;
      },
      cardCount: function () {
        var total = 0;
        roots.forEach(function (record) {
          total += record.cards.size;
        });
        return total;
      },
      /** QA: per-fence state, so a stuck card can be explained without guessing. */
      debug: function () {
        var out = [];
        roots.forEach(function (record) {
          record.cards.forEach(function (blockRecord, block) {
            out.push({
              uid: blockRecord.uid,
              key: blockRecord.key.slice(0, 16),
              connected: !!block.isConnected,
              visible: !!blockRecord.visible,
              hasJob: !!blockRecord.job,
              jobUid: blockRecord.job ? blockRecord.job.uid : null,
              superseded: blockRecord.job ? !!blockRecord.job.superseded : null,
              pendingTimer: !!blockRecord.timer,
              phase: blockRecord.card ? blockRecord.card.state.phase : null,
              sourceLen: blockRecord.source ? blockRecord.source.length : 0
            });
          });
        });
        return out;
      },
      outcomeHandler: onOutcome
    };
  }

  MMS.startScanner = startScanner;
})(typeof globalThis !== 'undefined' ? globalThis : this);
