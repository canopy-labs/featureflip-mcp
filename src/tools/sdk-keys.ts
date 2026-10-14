import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { enc } from '../client.js';
import { errorResult, okJson, run } from '../errors.js';
import type { ToolContext } from './context.js';
import { apiOutput, nullable, oneOfOutputs, shape } from './outputs.js';
import { environmentParam, pagination, projectParam } from './params.js';

// The plaintext key exists only in the create response; list and get carry its last four
// characters. It is returned so an agent wiring up an SDK can put it in an .env file.
const KEY_WARNING =
  'This is the only time the full key is returned; it cannot be shown again. Store it in a secret or an ' +
  'untracked .env file, never in source control or a chat log.';

export function registerSdkKeyTools(server: McpServer, ctx: ToolContext): void {
  const keys = (project: string, environment: string) =>
    `/api/v1/orgs/${enc(ctx.org)}/projects/${enc(project)}/environments/${enc(environment)}/sdk-keys`;

  server.registerTool(
    'list_sdk_keys',
    {
      title: 'List SDK keys',
      description:
        'List the SDK keys of one environment: id, name, type, last four characters, and whether each is active. ' +
        'The full key is never listed; it is shown once, when manage_sdk_key creates it.',
      inputSchema: z.object({ project: projectParam, environment: environmentParam, ...pagination }),
      outputSchema: apiOutput('GET /api/v1/orgs/{org}/projects/{project}/environments/{env}/sdk-keys'),
      annotations: { readOnlyHint: true },
    },
    async ({ project, environment, limit, cursor }) =>
      run(async () => okJson(await ctx.api.request('GET', keys(project, environment), { query: { limit, cursor } }))),
  );

  server.registerTool(
    'manage_sdk_key',
    {
      title: 'Create, rename, or revoke an SDK key',
      description:
        'Manage an environment\'s SDK keys. action=create needs name + type and returns the full key ONCE ' +
        '(ServerSide for backend SDKs, ClientSide for browser/mobile). action=rename needs sdkKey and changes ' +
        'only the fields you pass. action=revoke needs sdkKey and stops the key working immediately; apps still ' +
        'using it lose flag updates. To rotate: create a new key, deploy it, then revoke the old one.',
      inputSchema: z.object({
        action: z.enum(['create', 'rename', 'revoke']).describe('create needs name + type; rename and revoke need sdkKey'),
        project: projectParam,
        environment: environmentParam,
        sdkKey: z.string().optional().describe('SDK key id (see list_sdk_keys); required for rename and revoke'),
        name: z.string().optional().describe('Key name; required for create'),
        description: z.string().optional().describe('What the key is used for; "" clears it'),
        type: z
          .enum(['ServerSide', 'ClientSide'])
          .optional()
          .describe('Required for create: ServerSide for backend SDKs, ClientSide for browser/mobile SDKs'),
      }),
      outputSchema: oneOfOutputs(
        // create: the API body plus a warning; spelled out because oneOf members can't use apiOutputWith.
        shape({ id: { type: 'string' }, key: nullable('string'), warning: { type: 'string' } }, ['warning']),
        shape(
          { sdkKey: { type: 'string' }, renamed: { type: 'boolean' }, name: nullable('string'), description: nullable('string') },
          ['sdkKey', 'renamed'],
        ),
        shape({ revoked: { type: 'string' } }, ['revoked']),
      ),
      annotations: { destructiveHint: true },
    },
    async ({ action, project, environment, sdkKey, name, description, type }) =>
      run(async () => {
        const base = keys(project, environment);
        if (action === 'create') {
          if (!name || !type) return errorResult(new Error('action=create requires name and type'));
          const created = await ctx.api.request<{ warning?: string | null }>('POST', base, {
            body: { name, description, type },
          });
          // The API always sends its own "store securely" line; it does not say where not to put the key.
          return okJson({ ...created, warning: created.warning ? `${created.warning} ${KEY_WARNING}` : KEY_WARNING });
        }
        if (!sdkKey) return errorResult(new Error(`action=${action} requires sdkKey (see list_sdk_keys)`));
        const path = `${base}/${enc(sdkKey)}`;
        if (action === 'rename') {
          const current = await ctx.api.request<{ name: string | null; description: string | null }>('GET', path);
          const body = { name: name ?? current.name, description: description ?? current.description };
          // PUT returns 204 No Content — confirm what was applied instead.
          await ctx.api.request('PUT', path, { body });
          return okJson({ sdkKey, renamed: true, ...body });
        }
        // POST .../revoke returns 204 No Content.
        await ctx.api.request('POST', `${path}/revoke`);
        return okJson({ revoked: sdkKey });
      }),
  );
}
