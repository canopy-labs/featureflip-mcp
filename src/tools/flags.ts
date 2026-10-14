import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { enc } from '../client.js';
import { okJson, run } from '../errors.js';
import type { ToolContext } from './context.js';
import { apiOutput, apiOutputWith, nullable, objectOutput } from './outputs.js';
import { etagOutput, ifMatchParam, withEtag } from './etag.js';
import { flagParam, pagination, projectParam } from './params.js';
import { ownerFilter, resolveOwner } from './owner.js';

const flagTypes = z.enum(['Boolean', 'String', 'Number', 'Json']);

export function registerFlagTools(server: McpServer, ctx: ToolContext): void {
  const base = (project: string) => `/api/v1/orgs/${enc(ctx.org)}/projects/${enc(project)}/flags`;

  server.registerTool(
    'list_flags',
    {
      title: 'List feature flags',
      description:
        'List feature flags in a project. Filter with search (key/name substring), tag, type, archived, owner. ' +
        'Each flag carries its owner ({id, email, name}, or null when unowned). Paginated via cursor.',
      inputSchema: z.object({
        project: projectParam,
        search: z.string().optional().describe('Substring of the flag key or name'),
        tag: z.string().optional().describe('Only flags carrying this tag'),
        type: flagTypes.optional().describe('Only flags of this type'),
        archived: z.boolean().optional().describe('true = only archived, false = only active'),
        owner: ownerFilter,
        ...pagination,
      }),
      outputSchema: apiOutput('GET /api/v1/orgs/{org}/projects/{project}/flags'),
      annotations: { readOnlyHint: true },
    },
    async ({ project, owner, ...query }) =>
      run(async () =>
        okJson(await ctx.api.request('GET', base(project), { query: { ...query, owner: await resolveOwner(ctx, owner) } })),
      ),
  );

  server.registerTool(
    'get_flag',
    {
      title: 'Get feature flag',
      description:
        'Get one feature flag with its variations and metadata, including its owner (null when unowned). ' +
        'Address by flag key or id.',
      inputSchema: z.object({
        project: projectParam,
        flag: flagParam,
      }),
      outputSchema: apiOutputWith('GET /api/v1/orgs/{org}/projects/{project}/flags/{flag}', { etag: etagOutput }),
      annotations: { readOnlyHint: true },
    },
    async ({ project, flag }) =>
      run(async () => okJson(withEtag(await ctx.api.requestWithEtag<object>('GET', `${base(project)}/${enc(flag)}`)))),
  );

  server.registerTool(
    'create_flag',
    {
      title: 'Create feature flag',
      description:
        'Create a feature flag. type is one of Boolean|String|Number|Json. Boolean flags get true/false variations automatically; ' +
        'for other types pass initialVariations. The flag is created in every environment of the project (disabled).',
      inputSchema: z.object({
        project: projectParam,
        key: z.string().describe('Unique flag key, e.g. checkout-v2'),
        name: z.string().describe('Display name'),
        type: flagTypes.describe('Value type; Boolean gets true/false variations automatically'),
        description: z.string().optional().describe('What the flag controls'),
        tags: z.array(z.string()).optional().describe('Tags for filtering, e.g. team or area'),
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
          .optional()
          .describe('Variations for a String, Number or Json flag (Boolean flags get true/false automatically)'),
        expiresAtUtc: z
          .string()
          .optional()
          .describe('Optional date (YYYY-MM-DD, end of that UTC day) or ISO-8601 timestamp the flag is expected to be removed by (see set_flag_expiry)'),
        ownerEmail: z
          .string()
          .optional()
          .describe(
            'Optional owner: the email of an active member (Pro plan and above, see set_flag_owner). ' +
              'Omitted, a personal access token makes its own user the owner and a service token leaves the flag unowned',
          ),
        isPermanent: z
          .boolean()
          .optional()
          .describe(
            'Mark the flag permanent: a kill switch, ops toggle or entitlement gate that is meant to stay. ' +
              'Permanent flags are never listed as removal candidates or by find_stale_flags. Cannot be combined with expiresAtUtc',
          ),
        idempotency_key: z.string().optional().describe('Idempotency-Key header for safe retries'),
      }),
      outputSchema: apiOutput('POST /api/v1/orgs/{org}/projects/{project}/flags'),
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
        'Update flag name/description/tags/clientSideVisible. Changes only the fields you pass and keeps the rest; ' +
        'pass description: "" to clear it. Key and type are immutable. ' +
        'Use toggle_flag / update_targeting for behavior changes. ' +
        'Pass ifMatch (the etag from get_flag) to refuse the write if the flag changed since you read it.',
      inputSchema: z.object({
        project: projectParam,
        flag: flagParam,
        name: z.string().optional().describe('New display name'),
        description: z.string().optional().describe('New description; "" clears it'),
        tags: z.array(z.string()).optional().describe('Replaces the whole tag list'),
        clientSideVisible: z
          .boolean()
          .optional()
          .describe('Expose to client-side SDKs (browser/mobile); false hides the flag from them entirely'),
        ifMatch: ifMatchParam('get_flag'),
      }),
      outputSchema: objectOutput(
        { project: { type: 'string' }, flag: { type: 'string' }, updated: { type: 'boolean' } },
        ['project', 'flag', 'updated'],
      ),
      annotations: { destructiveHint: true },
    },
    async ({ project, flag, name, description, tags, clientSideVisible, ifMatch }) =>
      run(async () => {
        const path = `${base(project)}/${enc(flag)}`;
        // PUT is a full replace: a missing name is a 400 and a missing description clears it (#3220).
        // Omitted tags / clientSideVisible already mean "unchanged", so only these two are carried over.
        const read =
          name === undefined || description === undefined
            ? await ctx.api.requestWithEtag<{ name: string; description: string | null }>('GET', path)
            : undefined;
        const current = read?.data;
        const body = {
          name: name ?? current?.name,
          description: description ?? current?.description,
          tags,
          clientSideVisible,
        };
        // PUT .../flags/{flag} returns 204 No Content — nothing to pass through.
        // The agent's ifMatch covers its whole read-to-write gap; our own read's ETag covers just this call.
        await ctx.api.request('PUT', path, { body, ifMatch: ifMatch ?? read?.etag });
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
        'as expired. expiresAtUtc takes a date (2026-12-31), which means the end of that day in UTC, the same as ' +
        'picking it in the dashboard, or a full ISO-8601 timestamp, which is stored exactly. Refused with ' +
        'EXPIRY_IN_PAST for a time that has already passed (today\'s date is allowed), with ' +
        'FEATURE_NOT_ENABLED while flag expiration is not enabled for the organization, and with ' +
        'PERMANENT_FLAG_HAS_EXPIRY on a permanent flag (make it temporary first with set_flag_permanent). ' +
        'Clearing is always allowed.',
      inputSchema: z.object({
        project: projectParam,
        flag: flagParam,
        expiresAtUtc: z.string().nullable().describe('Date (YYYY-MM-DD, end of that UTC day) or ISO-8601 timestamp, or null to clear the expiry'),
      }),
      outputSchema: objectOutput(
        { project: { type: 'string' }, flag: { type: 'string' }, expiresAtUtc: nullable('string') },
        ['project', 'flag', 'expiresAtUtc'],
      ),
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
    'set_flag_permanent',
    {
      title: 'Mark a flag permanent or temporary',
      description:
        'Mark a flag permanent (a kill switch, ops toggle or entitlement gate that is meant to stay), or pass ' +
        'permanent: false to make it temporary again. Permanent flags are never listed as removal candidates or ' +
        'by find_stale_flags; evaluation never changes. Marking is refused with PERMANENT_FLAG_HAS_EXPIRY while ' +
        'the flag has an expiry date (clear it first with set_flag_expiry and expiresAtUtc: null), with ' +
        'FEATURE_NOT_ENABLED while permanent flags are not enabled for the organization, and on an archived flag. ' +
        'Making a flag temporary is always allowed.',
      inputSchema: z.object({
        project: projectParam,
        flag: flagParam,
        permanent: z.boolean().describe('true to mark the flag permanent, false to make it temporary'),
      }),
      outputSchema: objectOutput(
        { project: { type: 'string' }, flag: { type: 'string' }, permanent: { type: 'boolean' } },
        ['project', 'flag', 'permanent'],
      ),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ project, flag, permanent }) =>
      run(async () => {
        // PUT and DELETE .../permanent both return 204 No Content — nothing to pass through.
        const path = `${base(project)}/${enc(flag)}/permanent`;
        await ctx.api.request(permanent ? 'PUT' : 'DELETE', path);
        return okJson({ project, flag, permanent });
      }),
  );

  server.registerTool(
    'set_flag_owner',
    {
      title: 'Set or clear flag owner',
      description:
        'Name the person responsible for a flag, or pass owner: null to leave it unowned. owner is the email of an ' +
        'active member of the organization, or "me" for the token\'s own user (needs a personal access token). ' +
        'The owner gets the flag\'s cleanup notices; evaluation never changes. Refused with OWNER_NOT_MEMBER for an ' +
        'email that is not an active member, and with PLAN_FEATURE_UNAVAILABLE below the Pro plan. ' +
        'Clearing is always allowed.',
      inputSchema: z.object({
        project: projectParam,
        flag: flagParam,
        owner: z
          .string()
          .nullable()
          .describe('Owner email, "me" for the token\'s own user, or null (or "none") to clear the owner'),
      }),
      outputSchema: objectOutput(
        { project: { type: 'string' }, flag: { type: 'string' }, owner: { ...nullable('string'), description: 'Owner email now set, or null when unowned' } },
        ['project', 'flag', 'owner'],
      ),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ project, flag, owner }) =>
      run(async () => {
        // PUT and DELETE .../owner both return 204 No Content — nothing to pass through.
        const path = `${base(project)}/${enc(flag)}/owner`;
        // "none" is the list_flags filter's word for unowned, so it clears here rather than
        // reaching the API as an email.
        const email = owner?.trim().toLowerCase() === 'none' ? undefined : await resolveOwner(ctx, owner ?? undefined);
        if (email === undefined) await ctx.api.request('DELETE', path);
        else await ctx.api.request('PUT', path, { body: { email } });
        return okJson({ project, flag, owner: email ?? null });
      }),
  );

  server.registerTool(
    'delete_flag',
    {
      title: 'Delete feature flag',
      description:
        'PERMANENTLY delete a flag across all environments. Fails with FLAG_HAS_DEPENDENTS if other flags use it as a prerequisite. ' +
        'Prefer archive_flag unless the flag must be fully removed.',
      inputSchema: z.object({ project: projectParam, flag: flagParam }),
      outputSchema: objectOutput(
        { deleted: { type: 'string' } },
        ['deleted'],
      ),
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
        'Archive dependents first: refused with FLAG_HAS_DEPENDENTS while another live flag lists this one as a ' +
        'prerequisite, so archive those flags (blockedBy in find_stale_flags / list_removal_candidates) first. ' +
        'Refused with FLAG_RECENTLY_EVALUATED while live traffic is still evaluating the flag, ' +
        'because archiving makes every caller fall back to its own hardcoded default — normally that ' +
        'means the code removal has merged but not deployed yet, and the refusal clears itself once it has.',
      inputSchema: z.object({
        project: projectParam,
        flag: flagParam,
        force: z
          .boolean()
          .optional()
          .describe(
            'Archive even though traffic is still evaluating the flag. Only for clients that can never ' +
              'be updated (old mobile app versions), where traffic will never drain on its own.',
          ),
      }),
      outputSchema: objectOutput(
        { flag: { type: 'string' }, archived: { type: 'boolean' } },
        ['flag', 'archived'],
      ),
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
      inputSchema: z.object({ project: projectParam, flag: flagParam }),
      outputSchema: objectOutput(
        { flag: { type: 'string' }, archived: { type: 'boolean' } },
        ['flag', 'archived'],
      ),
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
