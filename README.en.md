# dsh-mermaid-studio

A DeepSeek Harness plugin that **renders mermaid fences in the conversation as diagrams**. Zoom, go fullscreen, export SVG — and the render result stays local, so returning to the same diagram does not redraw it.

English | [中文](README.md)

![Diagram card in the light theme](docs/screenshots/card-light.png)

## What it does

- **Fence detection** — claims `mermaid` / `mmd` fences. The host labels them with its generic "code block" text, and the plugin still recognises them; fences with a real language name (`python`, `ts`) are never claimed.
- **Rendering** — mermaid 11.17.2 is bundled, no network. One serial queue with a 15 s timeout and a breaker, so one bad diagram cannot hold up the rest.
- **Cache** — memory plus IndexedDB. A hit is injected directly with no flash, and survives reloads and restarts.
- **Gestures** — Ctrl/⌘ + wheel zooms around the pointer, drag pans, double-click toggles between fit and 1:1.
- **Card controls** — no persistent toolbar. Hovering the diagram floats a row of icon buttons at the top-right (zoom in / zoom out / reset / source / export / fullscreen); it hides when the pointer leaves.
- **Fullscreen** — a CSS overlay, not the system F11; Esc closes it and focus returns to the trigger. The zoom percentage is editable.
- **Export** — SVG only, serialised from the filtered tree.
- **Theme** — always follows the host's light/dark mode, with separate cache entries for each.

## Screenshots

<table>
  <tr>
    <td align="center" width="50%"><img src="docs/screenshots/card-light.png" alt="Diagram card in the light theme"><br><sub>Light: the fence becomes a card; hovering floats the controls</sub></td>
    <td align="center" width="50%"><img src="docs/screenshots/card-dark.png" alt="Diagram card in the dark theme"><br><sub>Dark: follows the host, both themes cached separately</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/screenshots/source-view.png" alt="Source view"><br><sub><code>&lt;/&gt;</code> shows the source; the control row stays above the code block</sub></td>
    <td align="center"><img src="docs/screenshots/fullscreen.png" alt="Fullscreen view"><br><sub>Fullscreen: the zoom percentage is editable</sub></td>
  </tr>
</table>

## How it works

The plugin ships as a two-half bundle: the host half only carries configuration, all UI and rendering live in the browser half. One fence goes through six steps:

1. **Find the fence** — scan the host's `div.md-code-block` elements and decide the language from three signals: banner text, a `language-*` class, and a strict first-line keyword. The banner shows a localised generic label for mermaid, so the first-line rule is the fallback. A hit inserts a card *before* the code block — **the block itself is never touched** (the plugin does not write to host-owned nodes).
2. **Strip governance keys** — `%%{init: …}%%` and frontmatter keys such as `securityLevel`, `htmlLabels`, `fontFamily` and `themeVariables` are removed, so one diagram cannot change global render settings; the control row says so when it happened.
3. **Look up the cache** — key = `sha1(source · theme · font · engine version · sanitizer version)`. Memory first (50 entries), then IndexedDB (32 MB, 30 days, byte-based LRU).
4. **Render** — only on a double miss, and only in the serial queue. mermaid needs a DOM, so it runs on the main thread at 50–90 ms per new diagram; the queue guarantees no concurrency (the engine's `initialize()` is global state and concurrent renders bleed themes).
5. **Filter, then inject** — the SVG is parsed into a detached document, filtered through element/attribute whitelists, its `<style>` rebuilt through CSSOM with `#<renderId>` prefixes, and only then `importNode`d in. **Cache hits take the same exit**: stored strings are treated as untrusted input, because any same-origin script can write that database.
6. **Uninstall cleanly** — remove cards, the `<style>`, both observers, delete the IndexedDB database and clear local keys.

## Deployment

Requires DSH `>= 0.2.1-rc.2`. Works in the desktop app and the web UI.

### From a source checkout

The repo already contains the build output in `lib/`, so it can be installed as-is; rebuild only after changing `src/`.

```powershell
git clone https://github.com/Hankai233/dsh-mermaid-studio.git
cd dsh-mermaid-studio

# optional: rebuild (npm install brings in mermaid@11.17.2 for the build)
npm install
$env:DSH_PROFILE_DIR = "$env:USERPROFILE\.dsh\profiles\desktop"
npm run build
```

Register it in the profile (pick one):

- **Plugin manager**: `plugin_manager install_bundle`, target set to the absolute path of this checkout.
- **By hand**: edit `<DSH_HOME>/profiles/desktop/package.json`
  - add `"dsh-mermaid-studio": "link:<absolute path>"` to `dependencies`
  - add `"dsh-mermaid-studio"` to `dsh.profile.bundles`
  - create a link in `node_modules` pointing at the checkout (Windows: `New-Item -ItemType Junction`)
  - fully quit and restart DSH

After installing: send any mermaid fence — it should render directly; hover it and the six icon buttons appear at the top-right. `window.__mmsStats` in the console shows the counters. If `dsh-mermaid-smooth` is still enabled, disable it first — both plugins insert a card next to the same code block. Rollback steps are in [scripts/rollback.md](scripts/rollback.md).

### Let an agent install it

Paste this into an agent inside DSH and it will clone, build, register and verify:

```text
Install the DSH plugin dsh-mermaid-studio on this machine.

Repo: https://github.com/Hankai233/dsh-mermaid-studio

Work in this order and confirm each step before moving on:
1. Clone the repo somewhere sensible (not inside DSH's own install directory).
2. Check that lib/index.js and lib/client.js exist and are non-empty.
   If they are missing, or I ask for a source build, set DSH_PROFILE_DIR and run
   node scripts/build.mjs (needs mermaid@11.17.2; a version mismatch fails loudly — do not substitute another version).
3. Open <DSH_HOME>/profiles/desktop/package.json:
   - add "dsh-mermaid-studio": "link:<absolute path of the clone>" to dependencies
   - add "dsh-mermaid-studio" to dsh.profile.bundles
   - create a link in node_modules pointing at the clone (junction on Windows)
4. If dsh-mermaid-smooth is still listed in dsh.profile.bundles, remove it (its dependency entry can stay).
5. Restart DSH, then send a mermaid fence and confirm a diagram card appears and
   that hovering it floats six icon buttons (zoom in / zoom out / reset / source / export / fullscreen).
6. Report: the absolute paths you changed, the sha256 of the build output, and what you actually saw in step 5.

Do not modify plugin source, and do not disable DSH security settings to make a check pass.
```

## Limits

- **The cache is shared across conversations.** The host exposes no session id, so the scope degrades to a constant and the same source in another conversation hits the same record. Deleting a conversation does not delete its diagrams; the exits are the 30-day expiry, uninstalling, or setting `cacheEnabled` to `false`.
- **Each new diagram costs 50–90 ms of synchronous rendering.** mermaid needs a DOM, so it cannot move to a Worker.
- **SVG is the only export.** PNG/JPG needed a second render plus a canvas encode of up to 27.8 Mpx, which is exactly what made export stall, so it was removed.

## Development

```powershell
npm install        # pulls mermaid@11.17.2 (a devDependency) for the build
npm run build      # writes lib/, prints sha256; same input produces the same output
npm test           # pure-logic unit tests (node --test), no browser needed
```

Publishing: `npm publish` (the account has 2FA on, so it asks for a one-time code). `files` ships `lib/`, `cordis.patch.yml`, `icon.svg` and the screenshots the README references, so installing the package never requires a build.

The acceptance channel (the 28 headless-Chromium cases) is not shipped — it is a local development tool; the repo carries the pure-logic tests in `test/`.

`src/client/` holds the 18 chunks of the browser half, concatenated in the order `scripts/build.mjs` lists; `lib/client.js` is about 3.6 MB, mostly the bundled mermaid engine.

## License

Released under **GPL-3.0**; see [LICENSE](LICENSE).
