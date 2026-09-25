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
        expiresAtUtc: z
          .string()
          .optional()
          .describe('Optional ISO-8601 UTC instant the flag is expected to be removed by (see set_flag_expiry)'),
        idempotency_key: z.string().optional().describe('Idempotency-Key header for safe retries'),
      }),
      annotations: { destructiveHint: false },
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
      annotations: { destructiveHint: true },
    },
    async ({ project, flag, ...body }) =>
      run(async () => {
        // PUT .../flags/{flag} returns 204 No Content — nothing to pass through.
        await ctx.api.request('PUT', `${base(project)}/${enc(flag)}`, { body });
        return okJson({ project, flag, updated: true });
      }),
  );

  server.registerTool(
    'set_flag_expiry',
    {
      title: 'Set or clear flag expiry',
      description:
        'Set the date a flag is expected to be removed by, or pass expiresAtUtc: null to clear it. ' +
        'Expiry is advisory: evaluation never changes. Once the date passes, find_stale_flags reports the flag ' +
        'as expired. expiresAtUtc is an exact ISO-8601 UTC instant; a bare date means 00:00 UTC that day, so pass ' +
        'e.g. 2026-12-31T23:59:59Z for the end of a day. Refused with EXPIRY_IN_PAST for a time that has already ' +
        'passed, and with FEATURE_NOT_ENABLED while flag expiration is not enabled for the organization. ' +
        'Clearing is always allowed.',
      inputSchema: z.object({
        project: z.string(),
        flag: z.string().describe('Flag key or id'),
        expiresAtUtc: z.string().nullable().describe('ISO-8601 UTC instant, or null to clear the expiry'),
      }),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ project, flag, expiresAtUtc }) =>
      run(async () => {
        // PUT and DELETE .../expiry both return 204 No Content — nothing to pass through.
        const path = `${base(project)}/${enc(flag)}/expiry`;
        if (expiresAtUtc === null) await ctx.api.request('DELETE', path);
        else await ctx.api.request('PUT', path, { body: { expiresAtUtc } });
        return okJson({ project, flag, expiresAtUtc });
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
      description:
        'Archive a flag (soft-hide, evaluation stops serving it). Reversible with restore_flag. ' +
        'Refused with FLAG_RECENTLY_EVALUATED while live traffic is still evaluating the flag, ' +
        'because archiving makes every caller fall back to its own hardcoded default — normally that ' +
        'means the code removal has merged but not deployed yet, and the refusal clears itself once it has.',
      inputSchema: z.object({
        project: z.string(),
        flag: z.string(),
        force: z
          .boolean()
          .optional()
          .describe(
            'Archive even though traffic is still evaluating the flag. Only for clients that can never ' +
              'be updated (old mobile app versions), where traffic will never drain on its own.',
          ),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ project, flag, force }) =>
      run(async () => {
        // POST .../archive returns 204 No Content — nothing to pass through.
        await ctx.api.request('POST', `${base(project)}/${enc(flag)}/archive`, {
          query: force ? { force: true } : {},
        });
        return okJson({ flag, archived: true });
      }),
  );

  server.registerTool(
    'restore_flag',
    {
      title: 'Restore archived flag',
      description: 'Restore a previously archived flag.',
      inputSchema: z.object({ project: z.string(), flag: z.string() }),
      annotations: { destructiveHint: false },
    },
    async ({ project, flag }) =>
      run(async () => {
        // POST .../restore returns 204 No Content — nothing to pass through.
        await ctx.api.request('POST', `${base(project)}/${enc(flag)}/restore`);
        return okJson({ flag, archived: false });
      }),
  );
}
