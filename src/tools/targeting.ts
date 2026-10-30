import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { enc } from '../client.js';
import { errorResult, okJson, run } from '../errors.js';
import type { ToolContext } from './context.js';
import { apiOutputWith, endpoint, objectOutput, oneOfOutputs, shape } from './outputs.js';
import { etagOutput, ifMatchParam, withEtag, writtenEtagOutput } from './etag.js';
import { environmentParam, flagParam, projectParam } from './params.js';

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
  bucketBy: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .optional()
    .describe(
      'Context attribute the rollout hashes on (default `user_id`; `userId` is accepted as an alias). Visitors whose context lacks it skip this rule, ' +
        'even at 100%. Changing it reshuffles who is in the rollout. Omit to keep the current value.',
    ),
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

// The API requires conditionGroups on a rule it creates; a rule with none (segment- or
// rollout-only) is sent as an explicit empty list.
const withGroups = <R extends { conditionGroups?: unknown[] }>(rule: R) => ({
  ...rule,
  conditionGroups: rule.conditionGroups ?? [],
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
        project: projectParam,
        flag: flagParam,
        environment: environmentParam,
      }),
      outputSchema: apiOutputWith('GET /api/v1/orgs/{org}/projects/{project}/flags/{flag}/environments/{env}/targeting', {
        etag: etagOutput,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ project, flag, environment }) =>
      run(async () => okJson(withEtag(await ctx.api.requestWithEtag<object>('GET', targetingUrl(project, flag, environment))))),
  );

  server.registerTool(
    'update_targeting',
    {
      title: 'Replace targeting rules',
      description:
        'REPLACE all targeting rules of a flag in one environment (full PUT — rules not included are removed). ' +
        'Rules are evaluated in order. Get the current rules first with get_targeting. ' +
        'Pass ifMatch (the etag from get_targeting) so rules someone else changed meanwhile are not overwritten.',
      inputSchema: z.object({
        project: projectParam,
        flag: flagParam,
        environment: environmentParam,
        rules: z.array(ruleSchema).describe('The complete ordered rule list; rules left out are deleted'),
        ifMatch: ifMatchParam('get_targeting'),
      }),
      outputSchema: objectOutput(
        {
          project: { type: 'string' },
          flag: { type: 'string' },
          environment: { type: 'string' },
          rulesReplaced: { type: 'integer' },
          etag: writtenEtagOutput,
        },
        ['project', 'flag', 'environment', 'rulesReplaced'],
      ),
      annotations: { destructiveHint: true },
    },
    async ({ project, flag, environment, rules, ifMatch }) =>
      run(async () => {
        // PUT .../environments/{env}/targeting returns 204 No Content — nothing to pass
        // through, so confirm the applied state instead of echoing an (undefined) response body.
        const { etag } = await ctx.api.requestWithEtag('PUT', targetingUrl(project, flag, environment), {
          body: { rules: rules.map(withGroups) },
          ifMatch,
        });
        return okJson(withEtag({ data: { project, flag, environment, rulesReplaced: rules.length }, etag }));
      }),
  );

  type RuleResponse = {
    description: string | null;
    variationId: string;
    rolloutPercentage: number | null;
    bucketBy: string | null;
    userSegmentId: string | null;
    conditionGroups:
      | {
          operator: string;
          conditions: { attribute: string; operator: string; values: string[]; negate: boolean }[] | null;
        }[]
      | null;
  };

  server.registerTool(
    'manage_targeting_rule',
    {
      title: 'Add, update, remove, or reorder one targeting rule',
      description:
        'Edit a single targeting rule instead of replacing them all with update_targeting. action=add needs rule ' +
        '(appended last); action=update needs ruleId + rule and changes only the fields you pass (conditionGroups ' +
        'replaces the rule\'s groups; to clear rolloutPercentage or userSegmentId use update_targeting); ' +
        'action=remove needs ruleId; action=reorder needs ruleIds, every existing rule id exactly once, in the new ' +
        'order. Rule ids come from get_targeting.',
      inputSchema: z.object({
        action: z.enum(['add', 'update', 'remove', 'reorder']).describe('add needs rule; update needs ruleId + rule; remove needs ruleId; reorder needs ruleIds'),
        project: projectParam,
        flag: flagParam,
        environment: environmentParam,
        ruleId: z.string().optional().describe('Rule id from get_targeting; required for update and remove'),
        rule: ruleSchema.optional().describe('Rule fields; required for add and update'),
        ruleIds: z.array(z.string()).optional().describe('Every rule id exactly once, in evaluation order; required for reorder'),
      }),
      outputSchema: oneOfOutputs(
        endpoint('POST /api/v1/orgs/{org}/projects/{project}/flags/{flag}/environments/{env}/rules'),
        shape({ ruleId: { type: 'string' }, updated: { type: 'boolean' } }, ['ruleId', 'updated']),
        shape({ removed: { type: 'string' } }, ['removed']),
        shape({ reordered: { type: 'array', items: { type: 'string' } } }, ['reordered']),
      ),
      annotations: { destructiveHint: true },
    },
    async ({ action, project, flag, environment, ruleId, rule, ruleIds }) =>
      run(async () => {
        const base = `/api/v1/orgs/${enc(ctx.org)}/projects/${enc(project)}/flags/${enc(flag)}/environments/${enc(environment)}/rules`;
        if (action === 'add') {
          if (!rule) return errorResult(new Error('action=add requires rule'));
          // POST returns 201 with the created rule — pass it through.
          return okJson(await ctx.api.request('POST', base, { body: withGroups(rule) }));
        }
        if (action === 'reorder') {
          if (!ruleIds) return errorResult(new Error('action=reorder requires ruleIds (see get_targeting)'));
          // PUT .../rules/reorder returns 204 No Content.
          await ctx.api.request('PUT', `${base}/reorder`, { body: { ruleIds } });
          return okJson({ reordered: ruleIds });
        }
        if (!ruleId) return errorResult(new Error(`action=${action} requires ruleId (see get_targeting)`));
        const path = `${base}/${enc(ruleId)}`;
        if (action === 'update') {
          if (!rule) return errorResult(new Error('action=update requires rule'));
          const { data: current, etag } = await ctx.api.requestWithEtag<RuleResponse>('GET', path);
          // PUT is a full replace. Carry over what isn't being changed, as the request shape only:
          // the GET body also has id, priority, _actions and nested ids the PUT does not take.
          // A fixed rule has no bucket-by to carry (it never hashes), so leave it out and let the API
          // decide: it keeps a rollout's value and gives a rule turning into one the default (#4607).
          const bucketBy = rule.bucketBy ?? (current.rolloutPercentage == null ? undefined : current.bucketBy);
          const body = {
            description: rule.description ?? current.description,
            variationId: rule.variationId ?? current.variationId,
            rolloutPercentage: rule.rolloutPercentage ?? current.rolloutPercentage,
            ...(bucketBy == null ? {} : { bucketBy }),
            userSegmentId: rule.userSegmentId ?? current.userSegmentId,
            conditionGroups:
              rule.conditionGroups ??
              (current.conditionGroups ?? []).map((g) => ({
                operator: g.operator,
                conditions: (g.conditions ?? []).map((c) => ({
                  attribute: c.attribute,
                  operator: c.operator,
                  values: c.values,
                  negate: c.negate,
                })),
              })),
          };
          // PUT returns 204 No Content — confirm instead.
          await ctx.api.request('PUT', path, { body, ifMatch: etag });
          return okJson({ ruleId, updated: true });
        }
        // DELETE returns 204 No Content.
        await ctx.api.request('DELETE', path);
        return okJson({ removed: ruleId });
      }),
  );
}
