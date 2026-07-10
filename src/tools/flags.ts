import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { enc } from '../client.js';
import { okJson, run } from '../errors.js';
import type { ToolContext } from './context.js';

const flagTypes = z.enum(['Boolean', 'String', 'Number', 'Json']);

export function registerFlagTools(server: McpServer, ctx: ToolContext): void {
  const base = (project: string) => `/api/v1/orgs/${enc(ctx.org)}/projects/${enc(project)}/flags`;

  server.registerTool(
    'list_flags',
    {
      title: 'List feature flags',
      description:
        'List feature flags in a project. Filter with search (key/name substring), tag, type, archived. Paginated via cursor.',
      inputSchema: z.object({
        project: z.string().describe('Project key'),
        search: z.string().optional(),
        tag: z.string().optional(),
        type: flagTypes.optional(),
        archived: z.boolean().optional().describe('true = only archived, false = only active'),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ project, ...query }) =>
      run(async () => okJson(await ctx.api.request('GET', base(project), { query }))),
  );

  server.registerTool(
    'get_flag',
    {
      title: 'Get feature flag',
      description: 'Get one feature flag with its variations and metadata. Address by flag key or id.',
      inputSchema: z.object({
        project: z.string().describe('Project key'),
        flag: z.string().describe('Flag key or id'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ project, flag }) =>
      run(async () => okJson(await ctx.api.request('GET', `${base(project)}/${enc(flag)}`))),
  );

  server.registerTool(
    'create_flag',
    {
      title: 'Create feature flag',
      description:
        'Create a feature flag. type is one of Boolean|String|Number|Json. Boolean flags get true/false variations automatically; ' +
        'for other types pass initialVariations. The flag is created in every environment of the project (disabled).',
      inputSchema: z.object({
        project: z.string().describe('Project key'),
        key: z.string().describe('Unique flag key, e.g. checkout-v2'),
        name: z.string(),
        type: flagTypes,
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        clientSideVisible: z.boolean().optional().describe('Expose to client-side SDKs (browser/mobile)'),
        initialVariations: z
          .array(
            z.object({
              key: z.string(),
              name: z.string().optional(),
              value: z.string().describe('Variation value serialized as a string'),
              description: z.string().optional(),
            }),
          )
          .optional(),
        idempotency_key: z.string().optional().describe('Idempotency-Key header for safe retries'),
      }),
      annotations: {},
    },
    async ({ project, idempotency_key, ...body }) =>
      run(async () =>
        okJson(await ctx.api.request('POST', base(project), { body, idempotencyKey: idempotency_key })),
      ),
  );

  server.registerTool(
    'update_flag',
    {
      title: 'Update feature flag metadata',
      description:
        'Update flag name/description/tags/clientSideVisible. Key and type are immutable. ' +
        'Use toggle_flag / update_targeting for behavior changes.',
      inputSchema: z.object({
        project: z.string(),
        flag: z.string().describe('Flag key or id'),
        name: z.string().optional(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        clientSideVisible: z.boolean().optional(),
      }),
      annotations: {},
    },
    async ({ project, flag, ...body }) =>
      run(async () => {
        // PUT .../flags/{flag} returns 204 No Content — nothing to pass through.
        await ctx.api.request('PUT', `${base(project)}/${enc(flag)}`, { body });
        return okJson({ project, flag, updated: true });
      }),
  );

  server.registerTool(
    'delete_flag',
    {
      title: 'Delete feature flag',
      description:
        'PERMANENTLY delete a flag across all environments. Fails with FLAG_HAS_DEPENDENTS if other flags use it as a prerequisite. ' +
        'Prefer archive_flag unless the flag must be fully removed.',
      inputSchema: z.object({ project: z.string(), flag: z.string().describe('Flag key or id') }),
      annotations: { destructiveHint: true },
    },
    async ({ project, flag }) =>
      run(async () => {
        await ctx.api.request('DELETE', `${base(project)}/${enc(flag)}`);
        return okJson({ deleted: flag });
      }),
  );

  server.registerTool(
    'archive_flag',
    {
      title: 'Archive feature flag',
      description: 'Archive a flag (soft-hide, evaluation stops serving it). Reversible with restore_flag.',
      inputSchema: z.object({ project: z.string(), flag: z.string() }),
      annotations: { destructiveHint: true },
    },
    async ({ project, flag }) =>
      run(async () => {
        // POST .../archive returns 204 No Content — nothing to pass through.
        await ctx.api.request('POST', `${base(project)}/${enc(flag)}/archive`);
        return okJson({ flag, archived: true });
      }),
  );

  server.registerTool(
    'restore_flag',
    {
      title: 'Restore archived flag',
      description: 'Restore a previously archived flag.',
      inputSchema: z.object({ project: z.string(), flag: z.string() }),
      annotations: {},
    },
    async ({ project, flag }) =>
      run(async () => {
        // POST .../restore returns 204 No Content — nothing to pass through.
        await ctx.api.request('POST', `${base(project)}/${enc(flag)}/restore`);
        return okJson({ flag, archived: false });
      }),
  );
}
