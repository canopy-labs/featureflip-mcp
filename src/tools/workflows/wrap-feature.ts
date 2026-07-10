import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { enc } from '../../client.js';
import { okJson, run } from '../../errors.js';
import type { ToolContext } from '../context.js';
import { LANGUAGES, snippetFor } from './snippets.js';

export function registerWrapFeatureTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'wrap_feature',
    {
      title: 'Wrap a feature in a new flag',
      description:
        'Create a Boolean feature flag and get back the SDK code snippet to guard the new code path with it. ' +
        'Returns the snippet only — apply the edit yourself. The flag starts DISABLED in every environment; ' +
        'enable it with toggle_flag when ready.',
      inputSchema: z.object({
        project: z.string().describe('Project key'),
        key: z.string().describe('Flag key, e.g. new-checkout'),
        name: z.string().optional().describe('Display name; defaults to the key'),
        description: z.string().optional().describe('What this flag guards'),
        tags: z.array(z.string()).optional(),
        language: z.enum(LANGUAGES).describe('SDK language of the codebase being edited'),
        idempotency_key: z.string().optional(),
      }),
      annotations: {},
    },
    async ({ project, key, name, description, tags, language, idempotency_key }) =>
      run(async () => {
        const flag = await ctx.api.request(
          'POST',
          `/api/v1/orgs/${enc(ctx.org)}/projects/${enc(project)}/flags`,
          {
            body: { key, name: name ?? key, type: 'Boolean', description, tags },
            idempotencyKey: idempotency_key,
          },
        );
        const snippet = snippetFor(language, key);
        return okJson({
          flag,
          integration: {
            language,
            install: snippet.install,
            code: snippet.code,
            notes: snippet.notes,
          },
          next_steps: [
            'Apply the snippet around the new code path.',
            `Enable in a non-production environment first: toggle_flag { project: "${project}", flag: "${key}", environment: "<env>", enabled: true }.`,
            'Ramp with update_targeting (rolloutPercentage) when ready.',
          ],
        });
      }),
  );
}
