/**
 * probe-plugin / lib/index.js —— Host 半边（载体插件）
 *
 * 唯一职责：验证「Host 能否把配置送进渲染进程」（UNK-06 / P0-5）。
 * 通道假设：ctx.on('webserver/index-inject', t => t.push({kind:'global', name, value}))。
 *
 * 设计原则（对应 §10 翻转条件）：
 *   - 通道不通时要**大声失败**，不允许静默兜底。
 *   - 除了注入，不注册任何其它方法（P1-4：host 半边能力面必须收口）。
 *
 * 用完即删，不要留在 profile 里。
 */

export const name = 'dsh-mermaid-probe';

export function apply(ctx, config) {
  const value = {
    probe: true,
    injectedAt: new Date().toISOString(),
    // 故意带上配置：用来判断 apply 是否真的拿到了合并后的 config
    receivedConfig: config === undefined ? null : config
  };

  let injected = false;

  const push = (target) => {
    try {
      target.push({ kind: 'global', name: '__DSH_MMS_PROBE__', value });
      injected = true;
    } catch (err) {
      console.warn('[mms-probe] index-inject push 失败：', err);
    }
  };

  try {
    if (typeof ctx?.on === 'function') {
      ctx.on('webserver/index-inject', push);
    } else {
      console.warn('[mms-probe] ctx.on 不存在 —— 注入通道假设不成立（§10 翻转条件）');
    }
  } catch (err) {
    console.warn('[mms-probe] 订阅 webserver/index-inject 抛错：', err);
  }

  // 给宿主日志留一行，便于在 Host 侧确认 apply 是否执行
  try {
    ctx?.logger?.info?.('[mms-probe] apply 完成，已订阅注入通道：' + (typeof ctx?.on === 'function'));
  } catch (_) {
    /* logger 不可用不影响探针 */
  }

  // 卸载时不留痕
  try {
    ctx?.on?.('dispose', () => console.info('[mms-probe] disposed；若注入值仍在，说明清理责任在宿主侧'));
  } catch (_) {
    /* ignore */
  }

  return { injected, value };
}
