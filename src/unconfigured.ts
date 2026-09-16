import { FeatureflipApi } from './client.js';
import { MISSING_TOKEN_MESSAGE } from './config.js';
import type { ToolContext } from './tools/context.js';

/**
 * Stands in for a real API client when no credentials are configured. Every
 * request fails with the same message `loadConfig` would have thrown at startup,
 * so the guidance reaches the user as a tool error rather than as a process exit
 * they never see.
 */
class UnconfiguredApi extends FeatureflipApi {
  constructor() {
    super({ token: '', baseUrl: 'https://api.featureflip.io' });
  }

  override request<T = unknown>(): Promise<T> {
    return Promise.reject(new Error(MISSING_TOKEN_MESSAGE));
  }
}

/**
 * A context that serves tool *definitions* but no data.
 *
 * `tools/list` is how a client discovers what this server can do, and registries
 * (Glama among them) enumerate it before anyone has wired a token. Exiting at
 * startup made the server look like it had no tools at all — so with no token we
 * start anyway and fail at call time instead.
 */
export function unconfiguredContext(): ToolContext {
  return { api: new UnconfiguredApi(), org: '' };
}
