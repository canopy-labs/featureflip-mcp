import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { enc } from '../client.js';
import { okJson, run } from '../errors.js';
import type { ToolContext } from './context.js';
import { apiOutput } from './outputs.js';
import { pagination, projectParam } from './params.js';

export function registerEnvironmentTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_environments',
    {
      title: 'List environments',
      description: 'List the environments of a project (e.g. development, staging, production).',
      inputSchema: z.object({
        project: projectParam,
        ...pagination,
      }),
      outputSchema: apiOutput('GET /api/v1/orgs/{org}/projects/{project}/environments'),
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
