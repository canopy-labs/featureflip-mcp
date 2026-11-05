import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { enc } from '../client.js';
import { errorResult, okJson, run } from '../errors.js';
import type { ToolContext } from './context.js';
import { apiOutput, endpoint, nullable, oneOfOutputs, shape } from './outputs.js';
import { environmentParam, pagination, projectParam, reasonParam } from './params.js';

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

  server.registerTool(
    'manage_environment',
    {
      title: 'Create or update an environment',
      description:
        'Create an environment in a project, or change its name, color or sort order. action=create needs key + ' +
        'name; action=update needs environment and changes only the fields you pass. The key is immutable. ' +
        'Environments cannot be deleted from here. require_change_reason makes every write to the environment need a ' +
        'reason, and require_confirmation makes the dashboard ask for confirmation first; omit either on update to ' +
        'leave it unchanged. Turning either off needs an Admin or Owner token and a reason. A new environment needs an SDK key before apps can use it ' +
        '(manage_sdk_key).',
      inputSchema: z.object({
        action: z.enum(['create', 'update']).describe('create needs key + name; update needs environment'),
        project: projectParam,
        environment: environmentParam.optional().describe('Environment key to update; required for update'),
        key: z.string().optional().describe('New environment key, required for create; immutable afterwards'),
        name: z.string().optional().describe('Display name; required for create'),
        color: z.string().optional().describe('Hex color shown in the dashboard, e.g. #22c55e'),
        sortOrder: z.number().int().optional().describe('Position in environment lists, lowest first'),
        require_change_reason: z
          .boolean()
          .optional()
          .describe('Mark the environment critical: every change to it must carry a reason. Omit on update to leave unchanged'),
        require_confirmation: z
          .boolean()
          .optional()
          .describe('Require explicit confirmation in the dashboard before changes to this environment. Omit on update to leave unchanged'),
        reason: reasonParam,
      }),
      outputSchema: oneOfOutputs(
        endpoint('POST /api/v1/orgs/{org}/projects/{project}/environments'),
        shape(
          {
            environment: { type: 'string' },
            updated: { type: 'boolean' },
            name: nullable('string'),
            color: nullable('string'),
            sortOrder: nullable('integer'),
            requireChangeReason: { type: 'boolean' },
            requireConfirmation: { type: 'boolean' },
          },
          ['environment', 'updated'],
        ),
      ),
      annotations: { destructiveHint: true },
    },
    async ({ action, project, environment, key, name, color, sortOrder, require_change_reason, require_confirmation, reason }) =>
      run(async () => {
        const critical = {
          requireChangeReason: require_change_reason,
          requireConfirmation: require_confirmation,
        };
        const base = `/api/v1/orgs/${enc(ctx.org)}/projects/${enc(project)}/environments`;
        if (action === 'create') {
          if (!key || !name) return errorResult(new Error('action=create requires key and name'));
          // POST returns 201 with the created environment — pass it through.
          return okJson(await ctx.api.request('POST', base, { body: { key, name, color, sortOrder, ...critical }, reason }));
        }
        if (!environment) return errorResult(new Error('action=update requires environment (see list_environments)'));
        const path = `${base}/${enc(environment)}`;
        const { data: current, etag } = await ctx.api.requestWithEtag<{
          name: string | null;
          color: string | null;
          sortOrder: number;
        }>('GET', path);
        const body = {
          name: name ?? current.name,
          color: color ?? current.color,
          sortOrder: sortOrder ?? current.sortOrder,
          ...critical,
        };
        // PUT returns 204 No Content — confirm what was applied instead.
        await ctx.api.request('PUT', path, { body, ifMatch: etag, reason });
        return okJson({ environment, updated: true, ...body });
      }),
  );
}
