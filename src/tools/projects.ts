import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { enc } from '../client.js';
import { okJson, run } from '../errors.js';
import type { ToolContext } from './context.js';

const pagination = {
  limit: z.number().int().min(1).max(100).optional().describe('Page size (default 20)'),
  cursor: z.string().optional().describe('next_cursor from a previous response'),
};

export function registerProjectTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description:
        'List projects in the Featureflip organization. Paginated: pass cursor from next_cursor to continue.',
      inputSchema: z.object({ ...pagination }),
      annotations: { readOnlyHint: true },
    },
    async ({ limit, cursor }) =>
      run(async () =>
        okJson(
          await ctx.api.request('GET', `/api/v1/orgs/${enc(ctx.org)}/projects`, {
            query: { limit, cursor },
          }),
        ),
      ),
  );
}
