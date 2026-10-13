import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { enc } from '../client.js';
import { errorResult, okJson, run } from '../errors.js';
import type { ToolContext } from './context.js';
import { endpoint, oneOfOutputs, shape } from './outputs.js';
import { flagParam, projectParam } from './params.js';

export function registerVariationTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'manage_variation',
    {
      title: 'Add, update, or remove a variation',
      description:
        'Manage a flag\'s variations. action=add requires key + value; action=update/remove require variationId ' +
        '(get ids via get_flag). Removing a variation fails with VARIATION_HAS_DEPENDENTS if other flags depend on it.',
      inputSchema: z.object({
        project: projectParam,
        flag: flagParam,
        action: z.enum(['add', 'update', 'remove']).describe('add needs key + value; update and remove need variationId'),
        variationId: z.string().optional().describe('Required for update/remove'),
        key: z.string().optional().describe('Required for add; immutable afterwards'),
        name: z.string().optional().describe('Display name'),
        value: z.string().optional().describe('Variation value serialized as a string; required for add'),
        description: z.string().optional().describe('What this variation means'),
      }),
      outputSchema: oneOfOutputs(
        endpoint('POST /api/v1/orgs/{org}/projects/{project}/flags/{flag}/variations'),
        shape({ updated: { type: 'string', description: 'Id of the updated variation' } }, ['updated']),
        shape({ removed: { type: 'string', description: 'Id of the removed variation' } }, ['removed']),
      ),
      annotations: { destructiveHint: true },
    },
    async ({ project, flag, action, variationId, key, name, value, description }) =>
      run(async () => {
        const base = `/api/v1/orgs/${enc(ctx.org)}/projects/${enc(project)}/flags/${enc(flag)}/variations`;
        if (action === 'add') {
          if (!key || value === undefined) {
            return errorResult(new Error('action=add requires key and value'));
          }
          // POST /variations returns 201 with the created variation body — pass it through.
          return okJson(await ctx.api.request('POST', base, { body: { key, name, value, description } }));
        }
        if (!variationId) {
          return errorResult(new Error(`action=${action} requires variationId (see get_flag for ids)`));
        }
        if (action === 'update') {
          // PUT /variations/{id} returns 204 No Content — nothing to pass through, so confirm
          // the applied change instead of echoing an (undefined) response body.
          await ctx.api.request('PUT', `${base}/${enc(variationId)}`, { body: { name, value, description } });
          return okJson({ updated: variationId });
        }
        // DELETE /variations/{id} returns 204 No Content.
        await ctx.api.request('DELETE', `${base}/${enc(variationId)}`);
        return okJson({ removed: variationId });
      }),
  );
}
