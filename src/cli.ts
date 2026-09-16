import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { resolveContext } from './bootstrap.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const ctx = await resolveContext();
  serveStdio(() => createServer(ctx));
}

main().catch((err: unknown) => {
  console.error(`[featureflip-mcp] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
