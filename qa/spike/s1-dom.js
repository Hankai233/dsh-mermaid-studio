/**
 * spike/s1-dom.js —— S1：聊天侧 DOM 契约坐实（UNK-08 / §4.1 / §3.3 / §4.4）
 *
 * 解决什么：#4.1 的候选单元、语言判定、锚点位置目前来自 asar 产物的单来源证据。
 * 本脚本在真机上把实际 DOM 打印出来，并把结果逐字回填文档 §3.1.1 与 §4.1。
 *
 * 怎么跑：在 DSH GUI 页面（对话里已有 mermaid 围栏、也已有一条非 mermaid 代码块时）
 *         打开控制台，整段粘贴，回车。只读，不修改页面。
 *
 * 判定标准：
 *   1. 非空 mermaid 围栏的 code/pre 上是否真的没有 language-* 类？
 *   2. 语言文本是否稳定出现在 [data-code-block-banner] 内？
 *   3. 锚点是否有稳定的父容器（.md-code-block）供兄弟插入？
 * 三项都成立 → §4.1 的三路并集方案成立；任一项不成立 → 改文档，不要改实现。
 */
(function () {
  'use strict';

  const MAX_DETAIL = 6;
  const sel = {
    block: '.md-code-block',
    banner: '[data-code-block-banner]',
    bannerText: '[data-code-block-banner] [data-text-interaction-exclude]',
    content: '[data-code-block-content]',
    langClass: 'code[class*="language-"], pre[class*="language-"]',
    // §4.1 里被列为「兼容」的三条，本脚本顺带证伪
    legacy: {
      'code[data-lang]': 'code[data-lang]',
      'div[data-language]': 'div[data-language]',
      'pre.shiki': 'pre.shiki'
    }
  };

  const q = (s, r) => (r || document).querySelector(s);
  const qa = (s, r) => Array.from((r || document).querySelectorAll(s));

  const counts = {
    block: qa(sel.block).length,
    banner: qa(sel.banner).length,
    bannerText: qa(sel.bannerText).length,
    content: qa(sel.content).length,
    langClass: qa(sel.langClass).length,
    pre: qa('pre').length,
    code: qa('code').length
  };
  const legacy = {};
  for (const [k, s] of Object.entries(sel.legacy)) legacy[k] = qa(s).length;

  function describeBlock(el, i) {
    const banner = q(sel.banner, el);
    const bannerText = q(sel.bannerText, el);
    const content = q(sel.content, el);
    const codeEl = content ? q('code, pre', content) : null;
    const text = (content || el).textContent || '';
    const firstLine = text.trim().split('\n')[0].slice(0, 80);

    return {
      i,
      parentTag: el.parentElement ? el.parentElement.tagName.toLowerCase() : null,
      parentClass: el.parentElement ? el.parentElement.className : null,
      prevSibling: el.previousElementSibling
        ? el.previousElementSibling.tagName.toLowerCase() + '.' + (el.previousElementSibling.className || '')
        : null,
      bannerText: bannerText ? bannerText.textContent.trim() : null,
      hasBanner: !!banner,
      contentPresent: !!content,
      codeTag: codeEl ? codeEl.tagName.toLowerCase() : null,
      codeClass: codeEl ? codeEl.className : null,
      hasLanguageClass: codeEl ? /language-/.test(codeEl.className || '') : false,
      firstLine,
      // 语言判定注入点是否唯一：banner 文本能否区分 mermaid / python
      outerHead: el.outerHTML.slice(0, 220)
    };
  }

  // v5 修正：单块解析失败不得吞掉整份报告（原实现在第 50 行直接抛错，什么都打不出来）
  const blocks = qa(sel.block)
    .slice(0, MAX_DETAIL)
    .map((el, i) => {
      try {
        return describeBlock(el, i);
      } catch (err) {
        return { i, error: (err && err.message) || String(err) };
      }
    });

  // v5 新增：会话正文根容器的取证（§4.3 至今没有取值，这是唯一一次采集机会）
  const firstBlock = qa(sel.block)[0];
  const ancestry = [];
  if (firstBlock) {
    for (let n = firstBlock; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      ancestry.push({
        tag: n.tagName.toLowerCase(),
        id: n.id || null,
        cls: typeof n.className === 'string' ? n.className.slice(0, 80) : null,
        attrs: Array.from(n.attributes)
          .map((a) => a.name)
          .filter((k) => k !== 'class' && k !== 'style')
          .slice(0, 8)
      });
    }
  }
  const sessionish = qa('[data-session-id], [data-session], [data-conversation-id]')
    .slice(0, 5)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      cls: typeof el.className === 'string' ? el.className.slice(0, 60) : null,
      attrs: Array.from(el.attributes).map((a) => a.name)
    }));

  const report = {
    at: new Date().toISOString(),
    href: location.href,
    counts,
    legacy,
    blocks,
    ancestry,
    sessionish,
    verdict: {
      // 三路并集是否成立
      bannerUsable: counts.bannerText > 0,
      anyLanguageClass: counts.langClass > 0,
      blockContainerStable: counts.block > 0 && blocks.every((b) => b.contentPresent),
      // 直接回答「非空围栏有无 language class」
      nonEmptyHasLanguageClass: blocks.some((b) => b.firstLine && b.hasLanguageClass)
    }
  };

  console.group('%c[mms spike S1] DOM 契约', 'color:#4da3ff;font-weight:bold');
  console.table(counts);
  console.log('legacy 选择器命中（§4.1 作废项，期望全 0）：', legacy);
  if (ancestry.length) console.log('会话正文祖先链（回填 §4.3 的 sessionRoot）：', ancestry);
  if (sessionish.length) console.log('疑似会话容器（带 session 属性的节点）：', sessionish);
  if (blocks.length) console.table(blocks.map((b) => ({
    i: b.i,
    bannerText: b.bannerText,
    codeTag: b.codeTag,
    hasLanguageClass: b.hasLanguageClass,
    firstLine: b.firstLine
  })));
  else console.warn('没有找到 .md-code-block —— 说明 §4.1 的候选单元也不对，先看 counts.pre/counts.code');
  console.log('verdict：', report.verdict);
  console.log('第一条完整 outerHTML（粘贴进文档 §3.1.1）：\n', blocks[0] ? blocks[0].outerHead : '(none)');
  console.log('%c完整 JSON（右键 Copy object 回填 UNK-08）', 'color:#4da3ff');
  console.log(JSON.stringify(report, null, 2));
  console.groupEnd();

  window.__mmsSpikeS1 = report;
  return report;
})();
