/* ── fence.js — the one place that knows the host's chat DOM ────────────────
 *
 * Every selector the plugin depends on lives here, so a host upgrade that
 * changes markup has exactly one file to fix.
 *
 * Verified against the host (app.asar + dsh-mermaid-smooth@0.2.3, which renders
 * this same DOM in production):
 *
 *   <div class="md-code-block">                       ← candidate unit
 *     <div data-code-block-banner>                    ← banner (two shapes)
 *       <div data-text-interaction-exclude>mermaid</div>   (shape A: info string)
 *       …or… <div class="…heading"><span class="…language">mermaid</span></div>
 *     </div>
 *     <div data-code-block-content><pre>…</pre></div>  ← source text
 *   </div>
 *
 * The chat flow container carries `data-slot="conversation.chat.flow"` — a slot
 * name, not a hashed class, so it survives style rebuilds. Scoping the scanner
 * to it is what keeps sidebar previews and settings-page samples out of the
 * renderer (and out of the 30-day cache).
 */
(function (g) {
  'use strict';
  var MMS = g.__MMS__ || (g.__MMS__ = {});

  var SELECTORS = {
    root: '[data-slot="conversation.chat.flow"]',
    block: '.md-code-block',
    banner: '[data-code-block-banner]',
    bannerLang: '[data-code-block-banner] [data-text-interaction-exclude]',
    content: '[data-code-block-content]'
  };

  var LONG_LANGS = { mermaid: 1, mmd: 1 };

  /**
   * Strict first-line patterns. A loose `^graph` would claim `graph = {...}` in
   * a python fence, so every keyword is anchored to its real declaration shape.
   */
  var FIRST_LINE = [
    /^(graph|flowchart)\s+(TD|TB|BT|RL|LR)\b/i,
    /^sequenceDiagram\b/i,
    /^classDiagram(-v2)?\b/i,
    /^stateDiagram(-v2)?\b/i,
    /^erDiagram\b/i,
    /^gantt\b/i,
    /^pie\b/i,
    /^mindmap\b/i,
    /^timeline\b/i,
    /^journey\b/i,
    /^gitGraph\b/i,
    /^quadrantChart\b/i,
    /^xychart(-beta)?\b/i,
    /^block-beta\b/i,
    /^sankey(-beta)?\b/i,
    /^packet-beta\b/i,
    /^architecture(-beta)?\b/i,
    /^kanban\b/i,
    /^requirementDiagram\b/i,
    /^C4(Context|Container|Component|Dynamic|Deployment)\b/i,
    /^info\b/i
  ];

  var BANNER_NOISE = /^(copy|copied|复制|已复制|wrap|unwrap|换行|不换行|expand|collapse|展开|收起)$/i;

  function textOf(node) {
    return node && typeof node.textContent === 'string' ? node.textContent : '';
  }

  /** The language label, or '' when the host rendered no label at all. */
  function readLanguageLabel(block) {
    var lang = block.querySelector(SELECTORS.bannerLang);
    var raw = textOf(lang);
    if (!raw) {
      var banner = block.querySelector(SELECTORS.banner);
      if (banner) {
        var first = banner.firstElementChild;
        raw = textOf(first) || textOf(banner);
      }
    }
    raw = raw.replace(/\s+/g, ' ').trim();
    if (!raw) return '';
    var head = raw.split(' ')[0];
    if (BANNER_NOISE.test(head)) return '';
    return head.toLowerCase();
  }

  function readSource(block) {
    // `pre code` first: that is the path the shipped reference plugin reads, so
    // it is the one shape known to exist in every host build we have seen. The
    // content container is the fallback, not the requirement.
    var code = block.querySelector('pre code') || block.querySelector('pre');
    if (code) return textOf(code);
    var content = block.querySelector(SELECTORS.content) || block;
    return textOf(content.querySelector('code') || content);
  }

  function firstMeaningfulLine(source) {
    var lines = source.split('\n');
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i].trim();
      if (!line) continue;
      if (line.charAt(0) === '%') continue; // %% comments / directives
      if (line.charAt(0) === '#' && !/^#\s/.test(line)) continue; // %%{}%% handled above
      return line;
    }
    return '';
  }

  function looksLikeMermaid(source) {
    var line = firstMeaningfulLine(source);
    if (!line) return false;
    for (var i = 0; i < FIRST_LINE.length; i += 1) {
      if (FIRST_LINE[i].test(line)) return true;
    }
    return false;
  }

  function hasLanguageClass(block) {
    var nodes = block.querySelectorAll('[class*="language-"]');
    for (var i = 0; i < nodes.length; i += 1) {
      var cls = nodes[i].className;
      if (typeof cls === 'string' && /language-(mermaid|mmd)\b/i.test(cls)) return true;
    }
    return false;
  }

  /**
   * Three-way union: a `mermaid`/`mmd` label, a `language-mermaid` class, or —
   * only when the host rendered no label at all — a strict mermaid first line.
   * A labelled `python` fence is therefore never claimed by the keyword rule.
   */
  var LANGUAGE_NAME = /^[a-z][a-z0-9+#.-]*$/;

  function isMermaidBlock(block) {
    if (!block || block.nodeType !== 1) return false;
    var label = readLanguageLabel(block);
    // The host falls back to a localized "code block" label when it does not
    // recognise the info string as a highlight language — and it does not know
    // `mermaid`. Measured in the running app: the banner reads "代码块", not
    // "mermaid". So only an ASCII identifier-shaped label may vote against the
    // fence (that keeps a real `python` label authoritative), while a generic
    // label falls through to the strict first-line rule.
    if (label && LANGUAGE_NAME.test(label)) {
      return Object.prototype.hasOwnProperty.call(LONG_LANGS, label);
    }
    if (Object.prototype.hasOwnProperty.call(LONG_LANGS, label)) return true;
    if (hasLanguageClass(block)) return true;
    return looksLikeMermaid(readSource(block));
  }

  function normalizeSource(text) {
    var out = String(text || '').replace(/\r\n?/g, '\n');
    out = out.replace(/^\uFEFF/, '');
    out = out.replace(/[ \t]+$/gm, '');
    out = out.replace(/\n{3,}/g, '\n\n');
    out = out.replace(/^\n+/, '').replace(/\s+$/, '');
    return out;
  }

  /* ── governance stripping ──────────────────────────────────────────────────
   * `%%{init: …}%%` is global config, and one fence writing
   * `securityLevel: 'loose'` (or a `fontFamily` that lands verbatim inside a
   * generated CSS declaration) would silently rewrite the security posture of
   * every following diagram. Rejected keys are *removed from the source*, not
   * merely ignored: the stripped text is what gets rendered, cached and
   * exported, so the cache key and the diagram agree by construction.
   */

  var TOP_ALLOWED = { theme: 1, flowchart: 1, sequence: 1, gantt: 1 };
  var KEY_DENY = /^(securityLevel|htmlLabels|maxTextSize|maxEdges|maxEdgesSize|fontFamily|altFontFamily|themeVariables|startOnLoad|logLevel|deterministicIds|deterministicIDSeed)$/i;

  function isDeniedKey(key) {
    return KEY_DENY.test(key) || /^on[a-z]/.test(key);
  }

  function FilterResult() {}

  /** Tiny JSON5-subset parser: enough for init directives and frontmatter blocks. */
  function parseLoose(text) {
    var i = 0;
    var src = String(text);

    function ws() {
      for (;;) {
        while (i < src.length && /\s/.test(src.charAt(i))) i += 1;
        if (src.charAt(i) === '/' && src.charAt(i + 1) === '/') {
          while (i < src.length && src.charAt(i) !== '\n') i += 1;
          continue;
        }
        if (src.charAt(i) === '/' && src.charAt(i + 1) === '*') {
          var end = src.indexOf('*/', i + 2);
          i = end < 0 ? src.length : end + 2;
          continue;
        }
        break;
      }
    }

    function fail(message) {
      throw new Error('parse: ' + message + ' at ' + i);
    }

    function str() {
      var quote = src.charAt(i);
      i += 1;
      var out = '';
      while (i < src.length) {
        var ch = src.charAt(i);
        if (ch === '\\') {
          var next = src.charAt(i + 1);
          var map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"', "'": "'" };
          out += map[next] !== undefined ? map[next] : next;
          i += 2;
          continue;
        }
        if (ch === quote) {
          i += 1;
          return out;
        }
        out += ch;
        i += 1;
      }
      fail('unterminated string');
    }

    function key() {
      if (src.charAt(i) === '"' || src.charAt(i) === "'") return str();
      var start = i;
      while (i < src.length && /[A-Za-z0-9_$.\-]/.test(src.charAt(i))) i += 1;
      if (start === i) fail('expected key');
      return src.slice(start, i);
    }

    function value() {
      ws();
      var ch = src.charAt(i);
      if (ch === '{') return object();
      if (ch === '[') return array();
      if (ch === '"' || ch === "'") return str();
      var m = /^(true|false|null|undefined|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(src.slice(i));
      if (!m) fail('unexpected token');
      i += m[0].length;
      if (m[0] === 'true') return true;
      if (m[0] === 'false') return false;
      if (m[0] === 'null' || m[0] === 'undefined') return null;
      return Number(m[0]);
    }

    function object() {
      i += 1;
      var out = {};
      for (;;) {
        ws();
        if (src.charAt(i) === '}') {
          i += 1;
          return out;
        }
        if (i >= src.length) fail('unterminated object');
        var k = key();
        ws();
        if (src.charAt(i) !== ':') fail('expected :');
        i += 1;
        out[k] = value();
        ws();
        if (src.charAt(i) === ',') {
          i += 1;
          continue;
        }
        if (src.charAt(i) === '}') {
          i += 1;
          return out;
        }
        fail('expected , or }');
      }
    }

    function array() {
      i += 1;
      var out = [];
      for (;;) {
        ws();
        if (src.charAt(i) === ']') {
          i += 1;
          return out;
        }
        if (i >= src.length) fail('unterminated array');
        out.push(value());
        ws();
        if (src.charAt(i) === ',') {
          i += 1;
          continue;
        }
        if (src.charAt(i) === ']') {
          i += 1;
          return out;
        }
        fail('expected , or ]');
      }
    }

    var result = value();
    ws();
    if (i !== src.length) fail('trailing input');
    return result;
  }

  function filterConfig(value, depth) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    var out = {};
    for (var k in value) {
      if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
      if (isDeniedKey(k)) continue;
      if (depth === 0 && !TOP_ALLOWED[k]) continue;
      var child = value[k];
      if (child && typeof child === 'object' && !Array.isArray(child)) {
        // Nested config (flowchart: { htmlLabels: true }) is filtered the same
        // way at every level: "ignore the intent" is not the requirement.
        var nested = filterConfig(child, depth + 1);
        if (Object.keys(nested).length) out[k] = nested;
        continue;
      }
      out[k] = child;
    }
    return out;
  }

  /** Locate the balanced `{…}` starting at or after `from`; -1 when absent. */
  function findBraces(text, from) {
    var start = text.indexOf('{', from);
    if (start < 0) return null;
    var depth = 0;
    var quote = '';
    for (var i = start; i < text.length; i += 1) {
      var ch = text.charAt(i);
      if (quote) {
        if (ch === '\\') i += 1;
        else if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) return { start: start, end: i };
      }
    }
    return null;
  }

  function stripInitDirectives(source) {
    var rejected = false;
    var out = source;
    var guard = 0;

    while (guard < 50) {
      guard += 1;
      var open = out.indexOf('%%{');
      if (open < 0) break;
      var close = out.indexOf('}%%', open);
      if (close < 0) {
        // Unterminated directive: drop the rest of the line, it cannot render.
        var lineEnd = out.indexOf('\n', open);
        var cut = lineEnd < 0 ? out.length : lineEnd;
        out = out.slice(0, open) + out.slice(cut);
        rejected = true;
        continue;
      }
      var whole = out.slice(open, close + 3);
      var inner = out.slice(open + 3, close);
      var rebuilt = null;

      if (/^\s*init\s*:/.test(inner)) {
        var braces = findBraces(inner, inner.indexOf(':'));
        if (braces) {
          try {
            var parsed = parseLoose(inner.slice(braces.start, braces.end + 1));
            var kept = filterConfig(parsed, 0);
            var keys = Object.keys(kept);
            rejected = rejected || keys.length !== Object.keys(parsed).length;
            rebuilt = keys.length ? '%%{init: ' + JSON.stringify(kept) + '}%%' : '';
          } catch (error) {
            rebuilt = ''; // unparsable: drop it rather than pass it through
            rejected = true;
          }
        } else {
          rebuilt = '';
          rejected = true;
        }
      } else {
        // Other directives (%%{wrap}%%) are harmless; leave them untouched.
        rebuilt = whole;
      }

      if (rebuilt === whole) {
        // Nothing to strip here; continue scanning after this directive.
        out = out.slice(0, open) + whole + out.slice(close + 3);
        var resume = open + whole.length;
        var rest = stripInitDirectives(out.slice(resume));
        return { source: out.slice(0, resume) + rest.source, rejected: rejected || rest.rejected };
      }
      out = out.slice(0, open) + rebuilt + out.slice(close + 3);
    }
    return { source: out, rejected: rejected };
  }

  /** Drop a `config:` block (or its denied children) from leading frontmatter. */
  function stripFrontmatter(source) {
    if (source.slice(0, 3) !== '---') return { source: source, rejected: false };
    var lines = source.split('\n');
    if (lines[0].trim() !== '---') return { source: source, rejected: false };
    var end = -1;
    for (var i = 1; i < lines.length; i += 1) {
      if (lines[i].trim() === '---') {
        end = i;
        break;
      }
    }
    if (end < 0) return { source: source, rejected: false };

    var head = lines.slice(0, end + 1);
    var body = lines.slice(end + 1);
    var rejected = false;
    var rebuilt = rebuildFrontmatter(head, body, rejected);
    return { source: rebuilt.source, rejected: rebuilt.rejected };
  }

  /**
   * Second, explicit pass over frontmatter. Kept separate from the scan above so
   * "dropped key drops its subtree" is one obvious rule instead of a flag that
   * has to be threaded through the loop.
   */
  function rebuildFrontmatter(head, body, rejectedSeed) {
    var out = [];
    var inConfig = false;
    var configIndent = 0;
    var keepSubtree = true;
    var rejected = rejectedSeed === true;

    for (var i = 0; i < head.length; i += 1) {
      var line = head[i];
      var indent = line.length - line.replace(/^\s*/, '').length;
      var trimmed = line.trim();

      if (!inConfig) {
        if (/^config\s*:/.test(trimmed)) {
          var inline = trimmed.slice(trimmed.indexOf(':') + 1).trim();
          if (inline) {
            var braces = findBraces(inline, 0);
            if (!braces) {
              rejected = true;
              continue;
            }
            try {
              var parsed = parseLoose(inline.slice(braces.start, braces.end + 1));
              var kept = filterConfig(parsed, 0);
              if (Object.keys(kept).length !== Object.keys(parsed).length) rejected = true;
              if (Object.keys(kept).length) {
                out.push('config: ' + JSON.stringify(kept));
              }
            } catch (error) {
              rejected = true;
            }
            continue;
          }
          inConfig = true;
          configIndent = indent;
          keepSubtree = true;
          out.push(line);
          continue;
        }
        out.push(line);
        continue;
      }

      if (!trimmed) {
        if (keepSubtree) out.push(line);
        continue;
      }
      if (indent <= configIndent) {
        inConfig = false;
        keepSubtree = true;
        out.push(line);
        continue;
      }
      if (indent === configIndent + 2) {
        var childKey = trimmed.split(':')[0].trim();
        if (isDeniedKey(childKey) || !TOP_ALLOWED[childKey]) {
          rejected = true;
          keepSubtree = false;
          continue;
        }
        keepSubtree = true;
        out.push(line);
        continue;
      }
      // Deeper lines: a denied key takes its subtree with it; a kept key line
      // re-opens the subtree for its own children.
      if (indent > configIndent + 2) {
        var deepMatch = /^([A-Za-z_][\w-]*)\s*:/.exec(trimmed);
        if (deepMatch) {
          if (isDeniedKey(deepMatch[1])) {
            rejected = true;
            keepSubtree = false;
            continue;
          }
          keepSubtree = true;
          out.push(line);
          continue;
        }
        if (keepSubtree) out.push(line);
        continue;
      }
      if (keepSubtree) out.push(line);
    }

    return { source: out.concat(body).join('\n'), rejected: rejected };
  }

  function stripGovernanceKeys(source) {
    var result = stripInitDirectives(source);
    var fm = stripFrontmatter(result.source);
    return { source: normalizeSource(fm.source), rejected: result.rejected || fm.rejected };
  }

  /**
   * A fence can survive normalisation and still have nothing to draw: an empty
   * body, only `%%` comments, or only init directives. Those must not reach the
   * queue — mermaid would throw and leave an error card with a retry button that
   * can never succeed (design P0-11).
   */
  function hasDiagramBody(source) {
    var text = String(source || '');
    if (text.slice(0, 3) === '---') {
      var lines = text.split('\n');
      for (var i = 1; i < lines.length; i += 1) {
        if (lines[i].trim() === '---') {
          text = lines.slice(i + 1).join('\n');
          break;
        }
      }
    }
    text = text.replace(/%%\{[\s\S]*?\}%%/g, ' ');
    text = text
      .split('\n')
      .filter(function (line) {
        return !/^\s*%%/.test(line);
      })
      .join('\n');
    return text.trim().length > 0;
  }

  /** Everything the renderer needs from one candidate node, or null. */
  function parseFence(block) {
    if (!isMermaidBlock(block)) return null;
    var raw = readSource(block);
    var stripped = stripGovernanceKeys(raw);
    var source = stripped.source;
    if (!source || !hasDiagramBody(source)) {
      return { block: block, empty: true, source: '', rejected: stripped.rejected };
    }
    return {
      block: block,
      empty: false,
      source: source,
      rejected: stripped.rejected,
      overLong: source.length > MMS.CONFIG.MAX_SOURCE_CHARS
    };
  }

  function inOwnCard(node) {
    return !!(node && node.closest && node.closest('.mms-card'));
  }

  function inExcludedRegion(node) {
    return !!(
      node &&
      node.closest &&
      (node.closest('[contenteditable]') || node.closest('[data-mms-overlay]') || node.closest('#mms-selftest'))
    );
  }

  MMS.fence = {
    SELECTORS: SELECTORS,
    readLanguageLabel: readLanguageLabel,
    readSource: readSource,
    isMermaidBlock: isMermaidBlock,
    looksLikeMermaid: looksLikeMermaid,
    normalizeSource: normalizeSource,
    stripGovernanceKeys: stripGovernanceKeys,
    parseLoose: parseLoose,
    parseFence: parseFence,
    hasDiagramBody: hasDiagramBody,
    inOwnCard: inOwnCard,
    inExcludedRegion: inExcludedRegion,
    firstMeaningfulLine: firstMeaningfulLine
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
