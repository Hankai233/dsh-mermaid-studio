/* ── key.js — cache identity ────────────────────────────────────────────────
 *
 * The key folds everything that changes what the SVG looks like, so an upgrade
 * or a font change invalidates entries by construction instead of via migration
 * code: mermaid version, resolved theme, code font, render config, sanitizer
 * rules and the source itself.
 *
 * Assertion the tests hold us to: no key input may be `undefined`/`null`/`''`
 * and no input may be the sentinel `unknown` — a key that silently contains
 * `undefined` shows up as "changed the font but the cache still hit".
 */
(function (g) {
  'use strict';
  var MMS = g.__MMS__ || (g.__MMS__ = {});

  /* SHA-1, synchronous and dependency-free: keys are needed in the same tick a
     card mounts, and SubtleCrypto would force every caller into async. */
  function sha1(str) {
    var bytes = utf8Bytes(String(str));
    var words = [];
    var i;
    for (i = 0; i < bytes.length; i += 1) {
      words[i >> 2] = (words[i >> 2] || 0) | (bytes[i] << (24 - (i % 4) * 8));
    }
    words[bytes.length >> 2] = (words[bytes.length >> 2] || 0) | (0x80 << (24 - (bytes.length % 4) * 8));
    var wordCount = (((bytes.length + 8) >> 6) + 1) * 16;
    for (i = 0; i < wordCount; i += 1) words[i] = words[i] | 0;
    var bitLength = bytes.length * 8;
    words[wordCount - 1] = bitLength;
    words[wordCount - 2] = Math.floor(bitLength / 0x100000000);

    var h0 = 0x67452301;
    var h1 = 0xefcdab89;
    var h2 = 0x98badcfe;
    var h3 = 0x10325476;
    var h4 = 0xc3d2e1f0;

    function rotl(n, s) {
      return (n << s) | (n >>> (32 - s));
    }

    for (i = 0; i < wordCount; i += 16) {
      var a = h0;
      var b = h1;
      var c = h2;
      var d = h3;
      var e = h4;
      var w = [];
      for (var t = 0; t < 80; t += 1) {
        if (t < 16) w[t] = words[i + t] | 0;
        else w[t] = rotl(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1) | 0;
        var f;
        var k;
        if (t < 20) {
          f = (b & c) | (~b & d);
          k = 0x5a827999;
        } else if (t < 40) {
          f = b ^ c ^ d;
          k = 0x6ed9eba1;
        } else if (t < 60) {
          f = (b & c) | (b & d) | (c & d);
          k = 0x8f1bbcdc;
        } else {
          f = b ^ c ^ d;
          k = 0xca62c1d6;
        }
        var temp = (rotl(a, 5) + f + e + k + w[t]) | 0;
        e = d;
        d = c;
        c = rotl(b, 30);
        b = a;
        a = temp;
      }
      h0 = (h0 + a) | 0;
      h1 = (h1 + b) | 0;
      h2 = (h2 + c) | 0;
      h3 = (h3 + d) | 0;
      h4 = (h4 + e) | 0;
    }

    return [h0, h1, h2, h3, h4].map(toHex).join('');
  }

  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    var out = [];
    for (var i = 0; i < str.length; i += 1) {
      var code = str.charCodeAt(i);
      if (code < 0x80) out.push(code);
      else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
      else out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    }
    return out;
  }

  function toHex(n) {
    var s = (n >>> 0).toString(16);
    return '00000000'.slice(s.length) + s;
  }

  /** Fixed key order; values come from the render path, never from a default. */
  function keyParts(input) {
    return [
      'schema:' + MMS.CONFIG.SCHEMA,
      'mermaid:' + input.mermaidVersion,
      'theme:' + input.theme,
      'scp:' + input.scopeHash,
      'themeRev:' + input.themeRevision,
      'font:' + input.fontCode,
      'cfg:' + input.renderConfig,
      'san:' + MMS.CONFIG.SANITIZER_VERSION,
      'src:' + input.source
    ];
  }

  var SENTINELS = { undefined: 1, null: 1, unknown: 1 };

  function assertParts(parts) {
    for (var i = 0; i < parts.length; i += 1) {
      var part = String(parts[i]);
      var value = part.slice(part.indexOf(':') + 1);
      // A key built from a missing field is indistinguishable from a hit on a
      // different font/theme — throw in tests and in the harness rather than
      // silently producing a shared entry.
      if (SENTINELS[value] || value.indexOf('undefined') >= 0) {
        throw new Error('cache key input contains a sentinel: ' + part);
      }
    }
    return parts.join('\u0000');
  }

  function buildKey(input) {
    return sha1(assertParts(keyParts(input)));
  }

  /** Records the exact bytes a key was computed from, for the self-test panel. */
  function debugKey(input) {
    return { parts: keyParts(input), key: buildKey(input) };
  }

  MMS.key = { sha1: sha1, buildKey: buildKey, keyParts: keyParts, debugKey: debugKey };
})(typeof globalThis !== 'undefined' ? globalThis : this);
