import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { enc } from '../client.js';
import { okJson, run } from '../errors.js';
import type { ToolContext } from './context.js';
import { nullable, objectOutput, shape } from './outputs.js';
import { environmentParam, flagParam, projectParam } from './params.js';
import type { components } from '../generated/api-types.js';

const strategies = z.enum(['SingleVariation', 'PercentageRollout', 'TargetedRollout']);

type FlagDetail = components['schemas']['PublicFlagResponse'];
type EnvConfig = components['schemas']['PublicFlagEnvConfigResponse'];

export function registerFlagEnvironmentTools(server: McpServer, ctx: ToolContext): void {
  const flagBase = (project: string, flag: string) =>
    `/api/v1/orgs/${enc(ctx.org)}/projects/${enc(project)}/flags/${enc(flag)}`;

  server.registerTool(
    'toggle_flag',
    {
      title: 'Toggle flag in environment',
      description:
        'Enable or disable a flag in ONE environment. Affects live evaluation immediately — double-check the environment.',
      inputSchema: z.object({
        project: projectParam,
        flag: flagParam,
        environment: environmentParam,
        enabled: z.boolean().describe('true to turn the flag on in this environment, false to turn it off'),
      }),
      outputSchema: objectOutput(
        { project: { type: 'string' }, flag: { type: 'string' }, environment: { type: 'string' }, enabled: { type: 'boolean' } },
        ['project', 'flag', 'environment', 'enabled'],
      ),
      annotations: { destructiveHint: true },
    },
    async ({ project, flag, environment, enabled }) =>
      run(async () => {
        // POST .../toggle returns 204 No Content — nothing to pass through, so confirm the
        // applied state instead of echoing an (undefined) response body.
        await ctx.api.request('POST', `${flagBase(project, flag)}/environments/${enc(environment)}/toggle`, {
          body: { enabled },
        });
        return okJson({ project, flag, environment, enabled });
      }),
  );

  server.registerTool(
    'update_flag_environment_config',
    {
      title: 'Update flag environment config',
      description:
        'Update a flag\'s per-environment serving config: defaultVariationId (served on fallthrough, required), ' +
        'strategy (SingleVariation | PercentageRollout | TargetedRollout — only SingleVariation is currently ' +
        'supported at the environment level), and prerequisites. ' +
        'Percentage rollouts are configured on targeting rules via update_targeting.',
      inputSchema: z.object({
        project: projectParam,
        flag: flagParam,
        environment: environmentParam,
        defaultVariationId: z.string().describe('Variation id to serve on fallthrough — required by the API'),
        strategy: strategies.optional().describe('Serving strategy; only SingleVariation is currently supported here'),
        prerequisites: z
          .array(z.object({ prerequisiteFlagKey: z.string(), expectedVariationKey: z.string() }))
          .optional()
          .describe(
            'Flags that must evaluate to the expected variation before this flag serves. ' +
              'Omit to leave existing prerequisites untouched; pass a list (possibly empty) to replace them wholesale.',
          ),
      }),
      outputSchema: objectOutput(
        { project: { type: 'string' }, flag: { type: 'string' }, environment: { type: 'string' }, defaultVariationId: { type: 'string' }, strategy: { type: 'string' }, prerequisites: {
          type: 'array',
          items: shape({ prerequisiteFlagKey: { type: 'string' }, expectedVariationKey: { type: 'string' } }),
        } },
        ['project', 'flag', 'environment', 'defaultVariationId'],
      ),
      annotations: { destructiveHint: true },
    },
    async ({ project, flag, environment, ...body }) =>
      run(async () => {
        // PUT .../environments/{env} returns 204 No Content — nothing to pass through.
        await ctx.api.request('PUT', `${flagBase(project, flag)}/environments/${enc(environment)}`, { body });
        return okJson({ project, flag, environment, ...body });
      }),
  );

  server.registerTool(
    'flag_status',
    {
      title: 'Flag status across environments',
      description:
        'Compact cross-environment view of one flag: enabled state, strategy, default variation, and prerequisites per environment.',
      inputSchema: z.object({ project: projectParam, flag: flagParam }),
      outputSchema: objectOutput(
        { key: nullable('string'), name: nullable('string'), type: nullable('string'), archived: { type: 'boolean' }, updatedAt: nullable('string'), environments: {
          type: 'array',
          items: shape({
            environment: nullable('string'),
            enabled: { type: 'boolean' },
            strategy: nullable('string'),
            defaultVariation: { ...nullable('string'), description: 'Variation key served on fallthrough' },
            prerequisites: { type: 'array' },
          }),
        } },
        ['key', 'name', 'type', 'archived', 'updatedAt', 'environments'],
      ),
      annotations: { readOnlyHint: true },
    },
    async ({ project, flag }) =>
      run(async () => {
        const [detail, envs] = await Promise.all([
          ctx.api.request<FlagDetail>('GET', flagBase(project, flag)),
          // GET .../environments returns a bare JSON array of PublicFlagEnvConfigResponse, not a
          // { items: [...] } wrapper — verified against FlagEnvironmentConfigController.GetAll
          // (ProducesResponseType(typeof(List<PublicFlagEnvConfigResponse>))) and the committed
          // public-v1-openapi.json ("schema": { "type": "array", "items": {...} }).
          ctx.api.request<EnvConfig[]>('GET', `${flagBase(project, flag)}/environments`),
        ]);
        const variationKey = (id: string | undefined) =>
          (detail.variations ?? []).find((v) => v.id === id)?.key ?? id ?? null;
        return okJson({
          key: detail.key ?? null,
          name: detail.name ?? null,
          type: detail.type ?? null,
          archived: detail.isArchived ?? false,
          updatedAt: detail.updatedAt ?? null,
          environments: envs.map((e) => ({
            environment: e.environmentKey ?? null,
            enabled: e.isEnabled ?? false,
            strategy: e.strategy ?? null,
            defaultVariation: variationKey(e.defaultVariationId),
            prerequisites: e.prerequisites ?? [],
          })),
        });
      }),
  );
}
