import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { enc } from '../client.js';
import { okJson, run } from '../errors.js';
import type { ToolContext } from './context.js';

export function registerEnvironmentTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_environments',
    {
      title: 'List environments',
      description: 'List the environments of a project (e.g. development, staging, production).',
      inputSchema: z.object({
        project: z.string().describe('Project key'),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ project, limit, cursor }) =>
      run(async () =>
        okJson(
          await ctx.api.request(
            'GET',
            `/api/v1/orgs/${enc(ctx.org)}/projects/${enc(project)}/environments`,
            { query: { limit, cursor } },
          ),
        ),
      ),
  );
}
