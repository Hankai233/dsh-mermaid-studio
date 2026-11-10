# dsh-mermaid-studio

[中文](README.md) · [English](README.en.md)

A DSH plugin that renders mermaid fences in the conversation as diagrams you can zoom, open fullscreen and export as SVG. Render results are stored in the browser, so returning to the same diagram does not redraw it.

The engine is mermaid 11.17.2, bundled into the plugin. No network access.

---

## What it does

### Fence detection

- Works on `div.md-code-block` elements. The language comes from three signals in union: the banner text, a `language-*` class, and a strict first-line keyword.
- The host renders the banner label for mermaid as the localized generic text "代码块" (code block), not as `mermaid`. The plugin hands that generic label to the first-line rule, while a fence with a real language label (`python`, `ts`, …) is still never claimed.
- Governance keys inside `%%{init: …}%%` and frontmatter (`securityLevel`, `htmlLabels`, `maxTextSize`, `fontFamily`, `themeVariables`, …) are stripped from the source before rendering. When something was stripped, the card shows a small "init directive ignored" badge; the diagram still renders.
- Empty fences, comment-only fences and directive-only fences get no card and never enter the queue.

### Rendering

- One serial queue, concurrency 1. mermaid's `initialize()` is global configuration; concurrent renders bleed themes into each other.
- A 15 s timeout changes the card state but does not free the queue slot. If a render never settles (2× timeout), the current engine instance is abandoned and a fresh one continues; the event is counted as `renderIsolated`. Two consecutive timeouts open a breaker and the card offers "reset renderer".
- The cache key reads the version injected at build time, so computing a key never evaluates the 3.5 MB bundle. The engine is evaluated only when a diagram actually needs it, split from the render into two tasks with the skeleton painted in between.
- Lazy rendering: a fence shows a skeleton until it enters the viewport.

### Cache

| Layer | Storage | Purpose |
| --- | --- | --- |
| L1 | in-memory `Map`, 50 entries | same-page scrolling, returning to a conversation: synchronous hit |
| L2 | IndexedDB database `dsh-mermaid-studio` | survives reloads and restarts |
| L3 | mermaid render | only when the first two miss |

- 32 MB cap with byte-based LRU, 30-day expiry, and a sweep that drops expired or schema-mismatched records on write.
- A hit is injected directly, so you never see code first and a diagram flashing in after.
- `cacheEnabled = false` turns off L1, L2 and the negative cache, and clears existing records.
- If IndexedDB cannot open (private mode, quota errors), the plugin uses memory only, warns once, and keeps working.
- Keys are built from source, theme, font, engine version and sanitizer version; changing any of them produces a new entry.

### Interaction

- Ctrl/⌘ + wheel zooms around the pointer; a plain wheel still scrolls the page.
- Drag to pan, with moves coalesced per frame (20 consecutive `pointermove` events result in 1 style write). Double-click toggles between "fit page" and 100%.
- The zoom ceiling is derived from the diagram's actual size (`LAYER_MAX_PX = 8192`) so the composited layer stays inside the GPU texture budget.
- Fullscreen is a CSS overlay, not the Fullscreen API: Esc closes it, focus returns to the trigger, and `body.style.overflow` is restored to whatever it was.

### Export

SVG only. What gets serialized is the DOM that was already injected and filtered — not the raw string from the cache. A standalone `.svg` opens without the host CSP, so only the filtered tree is a safe deliverable.

Before serializing, `xmlns`, `xmlns:xlink`, `width`/`height`/`viewBox` are filled in and a fallback font stack is appended.

### Theme

Always follows the host's `body[data-ds-dark-theme]`; there is no manual switch. When the host flips the mode the plugin checks the cache first, so flipping back is a hit rather than a redraw. Light and dark SVGs are separate records.

### Errors and degradation

| Situation | Behaviour |
| --- | --- |
| Syntax error | Card keeps the source, adds a collapsible error bar and a retry button; no automatic retry for 5 minutes, manual retry is immediate; nothing is written to the persistent cache |
| Source over 50,000 chars | Straight to the error state ("source too long, skipped"); no queue entry, no retry button |
| Rendered SVG contains blocked content | Error bar "the rendered result contains blocked content", `sanitizeRejected` +1, nothing cached |
| Rendered SVG cannot be parsed | Error bar "the diagram markup could not be parsed", retried once with lenient parsing |
| mermaid fails to load | Cards fall back to plain code blocks |
| A cached SVG was tampered with | Injection blocked, badge shown, diagram re-rendered and the record overwritten |

### Uninstall

Removes every card and the `<style id="mms-styles">` element, disconnects every MutationObserver / IntersectionObserver it created, tears down any fullscreen overlay and body styles, deletes the IndexedDB database, and clears `mms:*` local keys plus `__mmsStats`. Nodes owned by the host (React) are never written to, so nothing needs restoring.

---

## Installation

Requires DSH `>= 0.2.1-rc.2`. Works in the desktop app and the web UI.

The plugin is a two-half bundle: the host half only carries configuration; all UI and rendering live in the browser half.

### From a source checkout

The repository already contains the build output in `lib/` (`lib/index.js`, `lib/client.js`), so it can be installed as-is. Rebuild after changing `src/`.

```powershell
# 1) build (optional: lib/ is committed)
$env:DSH_PROFILE_DIR = "$env:USERPROFILE\.dsh\profiles\desktop"
node scripts/build.mjs

# 2) the build needs an exact mermaid@11.17.2 on this machine:
#    node_modules / $DSH_PROFILE_DIR/node_modules / $DSH_HOME/profiles/desktop/node_modules
#    A mismatched version fails loudly instead of silently degrading.
```

Register it in the profile, one of two ways:

- **With a plugin manager**: `plugin_manager install_bundle`, target set to the absolute path of this directory.
- **By hand** (no plugin manager): edit `<DSH_HOME>/profiles/desktop/package.json`
  - add `"dsh-mermaid-studio": "link:<absolute path to this directory>"` to `dependencies`
  - add `"dsh-mermaid-studio"` to the `dsh.profile.bundles` array
  - create a link in `node_modules` pointing at this directory (Windows: `New-Item -ItemType Junction`)
  - fully quit and restart DSH (or reload the page)

Two checks after installing:

1. If `dsh-mermaid-smooth` is still enabled, disable it. Both plugins insert a card next to the same code block, which gives you two toolbars.
2. Send a message with a mermaid fence — a card should appear. The toolbar reads `源码` (source) · `导出 SVG` (export SVG) · `⛶`; `window.__mmsStats` in the browser console shows the counters.

Rollback steps and a troubleshooting table are in [scripts/rollback.md](scripts/rollback.md).

### npm

Not published to npm yet. `package.json` already follows the bundle conventions (`dsh.client`, `exports["./client"]`, `cordis.patch.yml`); a published package will ship `lib/`, so consumers will not need to build.

### Configuration

One key, `cacheEnabled` (default `true`). Put it in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-mermaid-studio
  name: dsh-mermaid-studio
  config:
    cacheEnabled: true
```

Changes take effect after a page reload. If the injected value is missing, the plugin falls back to localStorage; if neither exists it uses the default and records `__mmsStats.configSource` as `default` instead of pretending it read something.

---

## Security boundary

The `svg` string comes from IndexedDB and is treated as untrusted input: any same-origin script can write that database, and records live there for 30 days.

- There is one injection exit, `injectSvg()`: parse into a detached document, filter, then `importNode`. Both the fresh-render path and the cache-hit path use it.
- Parsing is strict XML first. When that fails, a lenient `<template>` HTML parse is used (mermaid emits an unclosed `<br>` inside labels, so the string is not valid XML); the filter is the same either way.
- Element whitelist (including `foreignObject` and the text-level HTML it may contain), a real attribute whitelist, and declaration-level filtering for inline styles and `<style>`. Stylesheets are rebuilt through CSSOM with `#<renderId>` prefixes; rules that cannot be rewritten are dropped.
- `href` is limited to `#` fragments and raster `data:image/(png|jpeg|gif|webp)`; `url()` is limited to `#`. Attributes that can trigger a fetch (fills, strokes, filters, masks) are checked by value, not just by name.
- Any `script`, `iframe`, event attribute or SMIL event element puts the whole fence into the error state and it is never cached.
- Exported SVGs reuse this already-filtered tree.

---

## Known limitations

These are deliberate, not open bugs:

- **The cache is shared across conversations.** Neither the URL nor the chat DOM exposes a session id, so the scope degrades to a constant and the same source in another conversation hits the same record. The upside is that a recurring diagram appears instantly anywhere; the downside is that deleting a conversation does not delete its diagrams — the only exits are TTL expiry, uninstall, or `cacheEnabled=false`.
- **Each new diagram costs 50–90 ms of synchronous rendering.** mermaid needs a DOM, so it cannot move to a Worker. The serial queue prevents concurrency but cannot split it further.
- **SVG is the only export format.** PNG/JPG needed a second render plus a canvas encode of up to 27.8 Mpx, which is exactly what made the previous export stall.
- **Theme only follows.** No manual switch, no per-diagram override.
- Smart file names, full keyboard control and a complete focus trap are P1 and not implemented.

---

## Development

```powershell
node scripts/build.mjs               # writes lib/index.js + lib/client.js, prints sha256
node test/fence.test.mjs             # pure-logic unit tests (no browser needed)
node qa/harness/run.mjs              # acceptance cases in headless Chromium
node qa/acceptance.mjs --check       # validate the archive (fields / ids / required assertions / baseline env)
node qa/harness/run.mjs --headed     # watch it run
```

```
src/host/index.js       host half: carrier plugin + config injection
src/client/*.js         browser half, 18 chunks concatenated in build order
scripts/build.mjs       build: wrap mermaid once, concatenate chunks
scripts/rollback.md     rollback manual
qa/harness/             acceptance channel (real Chromium against a fake host page)
qa/acceptance.mjs       archive validation and gate evaluation
test/                   pure-logic unit tests
lib/                    build output (committed: installation needs it)
```

`lib/client.js` is about 3.6 MB, mostly the bundled mermaid engine. The build carries no timestamp, so two builds from the same inputs produce the same sha256.

### Verification status

26 cases: 23 pass, 3 need a human (coexistence with the old plugin, rollback drill, P1 keyboard focus). 11 pure-logic unit tests.

`node qa/acceptance.mjs --gate` still fails: the blocker is the rollback drill, which needs a real plugin disable/enable with timing and cannot be scripted.

### Measurements

On this machine (Chromium 156, 16 cores, DPR 1, no CPU throttling) with a 3693×1880 diagram carrying 30 labels:

| Metric | Value |
| --- | --- |
| Page load complete | 93 ms with **0 long tasks during load** (before removing the idle warm-up: 2 × 180 ms) |
| First diagram on a cold page, to ready | 302 ms (185 ms engine evaluation + 97 ms render, two tasks, skeleton visible in between) |
| Second diagram (engine warm) | 82 ms |
| Cache key computation | 0.3 ms |
| SVG export | 1 ms / 39 KB |

---

## License

Released under **GPL-3.0** (see [LICENSE](LICENSE)).

The bundled mermaid 11.17.2 is MIT-licensed and compatible with GPL-3.0.
