/**
 * probe-plugin / lib/client.js —— Client 半边
 *
 * 唯一职责：把 §3.1.1 里标「待 spike」的三行打印出来：
 *   1. `factory` 的实参形状（是 `require` 还是 `(require, ctx)`？）—— UNK-04
 *   2. `ctx.get('theme')` 的取值 API 与字段集 —— UNK-05
 *   3. `globalThis.__DSH_MMS_PROBE__` 是否被 Host 注入 —— UNK-06
 *
 * 不渲染 UI、不改 DOM、不写存储。任何一步失败都只打印，不抛出 ——
 * 探针自己崩掉就什么都测不到了。
 */
(function () {
  'use strict';

  const ID = 'dsh-mermaid-probe';

  function safe(label, fn) {
    try {
      return fn();
    } catch (err) {
      console.warn('[mms-probe] ' + label + ' 抛错：', err);
      return 'ERR: ' + ((err && err.message) || String(err));
    }
  }

  function keysOf(v) {
    if (!v) return null;
    const t = typeof v;
    if (t !== 'object' && t !== 'function') return null;
    return safe('Object.keys', () => Object.keys(v).slice(0, 60));
  }

  window.__ModuleLoader__.load({
    id: ID,
    factory: function (require) {
      const report = {
        at: new Date().toISOString(),
        id: ID,
        factory: {
          argsCount: arguments.length,
          argTypes: Array.from(arguments).map((a) => (a === null ? 'null' : typeof a)),
          // 第 1 实参通常是 require
          requireType: typeof require,
          requireKeys: keysOf(require),
          requireIsFunction: typeof require === 'function'
        }
      };

      // —— 第 2 实参是否是 ctx？（§3.1.1 的两处冲突就在这儿见分晓）
      const maybeCtx = arguments.length > 1 ? arguments[1] : null;
      report.ctx = {
        present: !!maybeCtx,
        type: typeof maybeCtx,
        keys: keysOf(maybeCtx),
        hasGet: !!(maybeCtx && typeof maybeCtx.get === 'function'),
        hasOn: !!(maybeCtx && typeof maybeCtx.on === 'function'),
        hasEffect: !!(maybeCtx && typeof maybeCtx.effect === 'function')
      };

      // —— theme 取值 API：形状已知，访问器未知
      report.theme = safe('theme', () => {
        const ctx = maybeCtx && typeof maybeCtx.get === 'function' ? maybeCtx : null;
        if (!ctx) return { reachable: false, hint: '第 2 实参不是 ctx；改用其它方式取 ctx 后再跑 __mmsProbe.themeProbe(ctx)' };
        const snap = ctx.get('theme');
        if (!snap) return { reachable: true, value: null };
        return {
          reachable: true,
          keys: Object.keys(snap),
          preference: snap.preference,
          revision: snap.revision,
          fontFamilies: snap.fontFamilies,
          fontSizes: snap.fontSizes
        };
      });

      // —— 配置注入通道：Host 应该已经把值推到全域
      report.config = safe('config', () => {
        const v = globalThis.__DSH_MMS_PROBE__;
        return {
          present: v !== undefined,
          value: v === undefined ? null : v,
          verdict: v === undefined
            ? '通道未生效 → 按 §10 翻转条件处理（cacheEnabled/themeMode 降级 localStorage-only，并从 §17.1 Must 移出）'
            : '通道生效 → 回填 §3.1.1 与 UNK-06'
        };
      });

      report.styleChannel = safe('styleChannel', () => ({
        styleSheets: document.styleSheets.length,
        note: '若要在插件里注入 CSS，用自建 <style id="mms-styles">（§3.1：styles.insert 已证伪）'
      }));

      console.group('%c[mms-probe] 运行时契约', 'color:#4da3ff;font-weight:bold');
      console.log(report);
      console.table(report.factory);
      if (report.theme && report.theme.keys) console.log('theme keys：', report.theme.keys);
      if (report.config && report.config.present) console.log('注入的配置：', report.config.value);
      console.log('%c把上面的 report 整段贴进 §3.1.1 与 UNKNOWNS.md 对应行', 'color:#4da3ff');
      console.groupEnd();

      window.__mmsProbe = report;

      // 后续可手动调用：__mmsProbeTheme(ctx)
      window.__mmsProbeTheme = function (ctx) {
        return safe('themeProbe', () => {
          const snap = ctx.get('theme');
          return { keys: Object.keys(snap || {}), snapshot: snap };
        });
      };

      return {};
    }
  });

  console.info('[mms-probe] client 已挂载，结果见 window.__mmsProbe');
})();
