import { tryLoadConfig, type McpConfig } from './config.js';
import { FeatureflipApi, ApiError } from './client.js';
import { resolveOrg } from './org.js';
import { unconfiguredContext } from './unconfigured.js';
import type { ToolContext } from './tools/context.js';

async function connect(config: McpConfig, fetchImpl?: typeof fetch): Promise<ToolContext> {
  const api = new FeatureflipApi({ ...config, fetchImpl });

  try {
    await api.request('GET', '/api/v1/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      throw new Error(
        'FEATUREFLIP_TOKEN was rejected (401). Check the token in the Featureflip dashboard (Settings → API Tokens).',
      );
    }
    if (err instanceof ApiError && err.status === 404) {
      throw new Error(
        'The public Management API returned 404 for /api/v1/me. This usually means the public API is not enabled ' +
          'for your organization yet — contact Featureflip support.',
      );
    }
    throw err;
  }

  return { api, org: await resolveOrg(api, config.org) };
}

/**
 * Decides what the server serves before it starts.
 *
 * A configured token still preflights and still fails fast on a bad one — the
 * startup error is unchanged. No token at all is a different situation: nobody
 * has wired this up yet, and the caller may only be enumerating the tool surface,
 * so we hand back a context that serves definitions and errors on use. Exiting
 * there made the server indistinguishable from one with no tools.
 */
export function resolveContext(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: typeof fetch,
): Promise<ToolContext> {
  const config = tryLoadConfig(env);
  return config ? connect(config, fetchImpl) : Promise.resolve(unconfiguredContext());
}
