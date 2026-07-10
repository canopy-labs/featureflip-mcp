import { McpServer } from '@modelcontextprotocol/server';
import { PKG_VERSION } from './version.js';
import type { ToolContext } from './tools/context.js';
import { registerProjectTools } from './tools/projects.js';
import { registerEnvironmentTools } from './tools/environments.js';
import { registerSegmentTools } from './tools/segments.js';
import { registerFlagTools } from './tools/flags.js';
import { registerFlagEnvironmentTools } from './tools/flag-environments.js';
import { registerTargetingTools } from './tools/targeting.js';
import { registerVariationTools } from './tools/variations.js';
import { registerStaleFlagTools } from './tools/workflows/stale-flags.js';
import { registerWrapFeatureTool } from './tools/workflows/wrap-feature.js';

export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: 'featureflip', version: PKG_VERSION });
  registerProjectTools(server, ctx);
  registerEnvironmentTools(server, ctx);
  registerSegmentTools(server, ctx);
  registerFlagTools(server, ctx);
  registerFlagEnvironmentTools(server, ctx);
  registerTargetingTools(server, ctx);
  registerVariationTools(server, ctx);
  registerStaleFlagTools(server, ctx);
  registerWrapFeatureTool(server, ctx);
  return server;
}
