/**
 * Channel registry — maps channel ids to their adapter factories and builds the
 * set of enabled adapters from the `channels` config block.
 *
 * A channel is enabled when its config block exists and is not `enabled: false`
 * and the factory can resolve its required credentials (from config or env).
 */

import { getLogger } from '../core/logger';
import type { ChannelAdapter, ChannelFactory } from './types';
import { createFeishuAdapter } from './channels/feishu';
import { createWecomAdapter } from './channels/wecom';
import { createQQAdapter } from './channels/qq';

const log = getLogger('gateway-registry');

const FACTORIES: Record<string, ChannelFactory> = {
  feishu: createFeishuAdapter,
  wecom: createWecomAdapter,
  qq: createQQAdapter,
};

/** Build all enabled, well-configured adapters from the channels config. */
export function buildAdapters(
  channelsCfg: Record<string, any>,
  env: NodeJS.ProcessEnv,
): Map<string, ChannelAdapter> {
  const adapters = new Map<string, ChannelAdapter>();
  for (const [id, factory] of Object.entries(FACTORIES)) {
    const cfg = channelsCfg[id];
    // A channel can be enabled purely via env vars (no config block) — pass an
    // empty object so the factory still tries env fallback. Skip only when the
    // block is explicitly disabled.
    if (cfg && cfg.enabled === false) continue;
    try {
      const adapter = factory(cfg || {}, env);
      if (adapter) adapters.set(id, adapter);
    } catch (e) {
      log.warn('adapter_build_failed', { channel: id, error: String(e) });
    }
  }
  return adapters;
}

export const SUPPORTED_CHANNELS = Object.keys(FACTORIES);
