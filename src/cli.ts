import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { FeatureflipApi, ApiError } from './client.js';
import { resolveOrg } from './org.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const api = new FeatureflipApi(config);

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

  const org = await resolveOrg(api, config.org);
  serveStdio(() => createServer({ api, org }));
}

main().catch((err: unknown) => {
  console.error(`[featureflip-mcp] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
