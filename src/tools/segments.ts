import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { enc } from '../client.js';
import { okJson, run } from '../errors.js';
import type { ToolContext } from './context.js';

export function registerSegmentTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_segments',
    {
      title: 'List user segments',
      description:
        'List reusable user segments in a project. Segments are referenced from targeting rules via userSegmentId.',
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
            `/api/v1/orgs/${enc(ctx.org)}/projects/${enc(project)}/segments`,
            { query: { limit, cursor } },
          ),
        ),
      ),
  );

  server.registerTool(
    'get_segment',
    {
      title: 'Get user segment',
      description: 'Get one user segment (its conditions, id, and metadata) by key or id.',
      inputSchema: z.object({
        project: z.string().describe('Project key'),
        segment: z.string().describe('Segment key or id'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ project, segment }) =>
      run(async () =>
        okJson(
          await ctx.api.request(
            'GET',
            `/api/v1/orgs/${enc(ctx.org)}/projects/${enc(project)}/segments/${enc(segment)}`,
          ),
        ),
      ),
  );
}
