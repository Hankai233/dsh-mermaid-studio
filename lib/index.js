/**
 * dsh-mermaid-studio — Host half.
 *
 * Carrier only: dsh bundle composition requires a main entry that mounts as a
 * plain Cordis plugin. Every feature lives in the browser half (`./client`).
 *
 * The one job here is delivering config to the renderer. The static client
 * module contract is `factory(require) -> exports`; there is no `host.call`
 * back-channel (verified: 0 hits in the shipped dsh-mermaid-smooth@0.2.3
 * bundle). The only channel with evidence behind it is the web server's
 * index-inject hook, so config rides that. When the hook is absent the
 * renderer reports `config.missing` instead of pretending it read a value.
 */
export const name = 'dsh-mermaid-studio';
export const inject = [];

const CONFIG_GLOBAL = '__DSH_MMS_CONFIG__';

/** Defaults must match src/client/config.js — the client compares against them. */
const DEFAULTS = { cacheEnabled: true };

function normalizeConfig(config) {
  const value = config && typeof config === 'object' ? config : {};
  return {
    cacheEnabled: value.cacheEnabled === undefined ? DEFAULTS.cacheEnabled : value.cacheEnabled === true
  };
}

export function apply(ctx, config) {
  const value = normalizeConfig(config);
  let injected = false;

  try {
    if (typeof ctx.on === 'function') {
      ctx.on('webserver/index-inject', (target) => {
        try {
          target.push({ kind: 'global', name: CONFIG_GLOBAL, value });
          injected = true;
        } catch (error) {
          console.warn('[mms] index-inject push failed:', error);
        }
      });
    }
  } catch (error) {
    console.warn('[mms] webserver/index-inject unavailable:', error);
  }

  // Nothing to tear down beyond the listener the host drops with the plugin.
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {}, 'dsh-mermaid-studio: carrier');
  }

  if (!injected) {
    // Not fatal: the client falls back to localStorage-only config and says so
    // through __mmsStats.config.source. This line exists so the fallback is
    // observable from the host log too.
    console.info('[mms] config injection pending (no index render yet)');
  }
}
