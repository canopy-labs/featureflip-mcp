import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { enc } from '../client.js';
import { errorResult, okJson, run } from '../errors.js';
import type { ToolContext } from './context.js';
import { apiOutput, endpoint, nullable, objectOutput, oneOfOutputs, shape } from './outputs.js';
import { pagination, projectParam } from './params.js';

export function registerProjectTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description:
        'List projects in the Featureflip organization. Paginated: pass cursor from next_cursor to continue.',
      inputSchema: z.object({ ...pagination }),
      outputSchema: apiOutput('GET /api/v1/orgs/{org}/projects'),
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

  const projects = `/api/v1/orgs/${enc(ctx.org)}/projects`;

  server.registerTool(
    'manage_project',
    {
      title: 'Create or update a project',
      description:
        'Create a project, or change its name/description. action=create needs key + name; action=update needs ' +
        'project and changes only the fields you pass (description: "" clears it). The key is immutable. ' +
        'Projects cannot be deleted from here.',
      inputSchema: z.object({
        action: z.enum(['create', 'update']).describe('create needs key + name; update needs project'),
        project: projectParam.optional().describe('Project key to update; required for update'),
        key: z.string().optional().describe('New project key, required for create; immutable afterwards'),
        name: z.string().optional().describe('Display name; required for create'),
        description: z.string().optional().describe('What the project is for; "" clears it'),
      }),
      outputSchema: oneOfOutputs(
        endpoint('POST /api/v1/orgs/{org}/projects'),
        shape(
          { project: { type: 'string' }, updated: { type: 'boolean' }, name: nullable('string'), description: nullable('string') },
          ['project', 'updated'],
        ),
      ),
      annotations: { destructiveHint: true },
    },
    async ({ action, project, key, name, description }) =>
      run(async () => {
        if (action === 'create') {
          if (!key || !name) return errorResult(new Error('action=create requires key and name'));
          // POST returns 201 with the created project — pass it through.
          return okJson(await ctx.api.request('POST', projects, { body: { key, name, description } }));
        }
        if (!project) return errorResult(new Error('action=update requires project (see list_projects)'));
        const path = `${projects}/${enc(project)}`;
        // PUT is a full replace, so carry over what isn't being changed.
        const current = await ctx.api.request<{ name: string | null; description: string | null }>('GET', path);
        const body = { name: name ?? current.name, description: description ?? current.description };
        // PUT returns 204 No Content — confirm what was applied instead.
        await ctx.api.request('PUT', path, { body });
        return okJson({ project, updated: true, ...body });
      }),
  );

  server.registerTool(
    'set_default_flag_lifetime',
    {
      title: 'Set or remove a project\'s default flag lifetime',
      description:
        'Set how many days a temporary flag with no expiry date of its own lives before it counts as expired, or ' +
        'pass days: null to remove the default. Advisory only: evaluation never changes. Pass preview: true first ' +
        'to see how many flags would newly be, or stop being, past expiry without changing anything. Setting a ' +
        'value is refused with FEATURE_NOT_ENABLED when the organization\'s plan lacks it; removal is always ' +
        'allowed. The current value is defaultFlagLifetimeDays in list_projects.',
      inputSchema: z.object({
        project: projectParam,
        days: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .nullable()
          .describe('Lifetime in days (1–3650), or null to remove the default'),
        preview: z
          .boolean()
          .optional()
          .default(false)
          .describe('true: only report the impact; nothing is changed'),
      }),
      outputSchema: objectOutput(
        {
          project: { type: 'string' },
          defaultFlagLifetimeDays: nullable('integer'),
          applied: { type: 'boolean', description: 'false for a preview' },
          newlyPastExpiry: { type: 'integer', description: 'Flags this would put past expiry' },
          noLongerPastExpiry: { type: 'integer', description: 'Flags this would take back out of expiry' },
        },
        ['project', 'defaultFlagLifetimeDays', 'applied', 'newlyPastExpiry', 'noLongerPastExpiry'],
      ),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ project, days, preview }) =>
      run(async () => {
        const path = `${projects}/${enc(project)}/default-flag-lifetime`;
        // Impact is measured against the current setting, so it has to be read before the PUT.
        // No days parameter previews removal; the client drops undefined query values.
        const impact = await ctx.api.request<{ newlyPastExpiry: number; noLongerPastExpiry: number }>(
          'GET',
          `${path}/impact`,
          { query: { days: days ?? undefined } },
        );
        // days is required by the API: {"days": null} removes, {} is a validation error.
        if (!preview) await ctx.api.request('PUT', path, { body: { days } });
        return okJson({
          project,
          defaultFlagLifetimeDays: days,
          applied: !preview,
          newlyPastExpiry: impact.newlyPastExpiry,
          noLongerPastExpiry: impact.noLongerPastExpiry,
        });
      }),
  );
}
