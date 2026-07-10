import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { enc } from '../client.js';
import { okJson, run } from '../errors.js';
import type { ToolContext } from './context.js';

const conditionSchema = z.object({
  attribute: z.string().describe('Context attribute name, e.g. plan, country, user_id'),
  operator: z
    .string()
    .describe('OperatorType member name, case-sensitive — e.g. Equals, NotEquals, Contains, In, GreaterThan'),
  values: z.array(z.string()),
  negate: z.boolean().optional().default(false),
});

const ruleSchema = z.object({
  description: z.string().optional(),
  variationId: z.string().optional().describe('Variation served when the rule matches'),
  rolloutPercentage: z.number().int().min(0).max(100).optional().describe('Percentage rollout for this rule'),
  userSegmentId: z.string().optional().describe('Match users in this segment (see list_segments)'),
  conditionGroups: z
    .array(
      z.object({
        operator: z.enum(['And', 'Or']).describe('How conditions inside this group combine'),
        conditions: z.array(conditionSchema),
      }),
    )
    .optional()
    .describe('Groups are ANDed together; conditions inside a group use the group operator'),
});

export function registerTargetingTools(server: McpServer, ctx: ToolContext): void {
  const targetingUrl = (project: string, flag: string, environment: string) =>
    `/api/v1/orgs/${enc(ctx.org)}/projects/${enc(project)}/flags/${enc(flag)}/environments/${enc(environment)}/targeting`;

  server.registerTool(
    'get_targeting',
    {
      title: 'Get targeting rules',
      description: 'Get a flag\'s current targeting configuration (enabled flag + ordered rules) in one environment.',
      inputSchema: z.object({
        project: z.string(),
        flag: z.string(),
        environment: z.string(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ project, flag, environment }) =>
      run(async () => okJson(await ctx.api.request('GET', targetingUrl(project, flag, environment)))),
  );

  server.registerTool(
    'update_targeting',
    {
      title: 'Replace targeting rules',
      description:
        'REPLACE all targeting rules of a flag in one environment (full PUT — rules not included are removed). ' +
        'Rules are evaluated in order. Get the current rules first with get_targeting.',
      inputSchema: z.object({
        project: z.string(),
        flag: z.string(),
        environment: z.string(),
        rules: z.array(ruleSchema),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ project, flag, environment, rules }) =>
      run(async () => {
        // PUT .../environments/{env}/targeting returns 204 No Content — nothing to pass
        // through, so confirm the applied state instead of echoing an (undefined) response body.
        await ctx.api.request('PUT', targetingUrl(project, flag, environment), { body: { rules } });
        return okJson({ project, flag, environment, rulesReplaced: rules.length });
      }),
  );
}
