import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ApiError, enc } from '../client.js';
import { errorResult, okJson, type ToolResult } from '../errors.js';
import type { ToolContext } from './context.js';
import { ifMatchParam, withEtag, writtenEtagOutput } from './etag.js';
import { apiOutputWith, endpoint, oneOfOutputs } from './outputs.js';
import { environmentParam, flagParam, pagination, projectParam, reasonParam } from './params.js';
import type { components } from '../generated/api-types.js';

type Ramp = components['schemas']['PublicRolloutRampResponse'];
type RampStep = components['schemas']['PublicRampStep'];

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BASE = '/api/v1/orgs/{org}/projects/{project}/flags/{flag}/environments/{env}';
const LIST_ROUTE = `GET ${BASE}/ramps`;
const GET_ROUTE = `GET ${BASE}/ramps/{rampId}`;

// Starting is the only plan-gated write, and pause and abort stay open on any plan so a ramp can always be stopped.
// PLAN_FEATURE_UNAVAILABLE and FEATURE_NOT_ENABLED arrive in the message of a 400, as for flag triggers.
const GATE_HINTS: [code: string, hint: string][] = [
  [
    'PLAN_FEATURE_UNAVAILABLE',
    'Starting a rollout ramp needs the Team plan or above. A ramp already running keeps running and can still be ' +
      'paused or aborted. An organization Owner can upgrade in Billing.',
  ],
  [
    'FEATURE_NOT_ENABLED',
    'Rollout ramps are not enabled for this organization yet. Nothing in the request is wrong, and retrying will ' +
      'not help until they are.',
  ],
];

function gateHint(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  const said = [err.envelope.message, ...Object.values(err.envelope.fields ?? {}).flat()].join('\n');
  return GATE_HINTS.find(([code]) => said.includes(code))?.[1];
}

async function runRamp(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    const result = errorResult(err);
    const hint = gateHint(err);
    if (hint) result.content[0].text += `\n${hint}`;
    return result;
  }
}

// Ramps and rules have no key, and the API answers a non-id with a 404 that errorResult annotates as
// "the public API may not be enabled", which sends the agent the wrong way.
const notAnId = (what: string, value: string, see: string) =>
  errorResult(new Error(`${what} must be an id, not "${value}". See ${see}.`));

const stepSchema = z.object({
  percent: z.number().int().min(1).max(100).describe('Rollout percentage for this step, 1-100'),
  holdMinutes: z
    .number()
    .int()
    .min(0)
    .describe('Minutes to hold at this step before the next one: 5 to 43200 (30 days); ignored on the last step'),
});

export function registerRolloutRampTools(server: McpServer, ctx: ToolContext): void {
  const base = (project: string, flag: string, environment: string) =>
    `/api/v1/orgs/${enc(ctx.org)}/projects/${enc(project)}/flags/${enc(flag)}/environments/${enc(environment)}`;

  server.registerTool(
    'list_rollout_ramps',
    {
      title: 'List rollout ramps',
      description:
        "List a flag's rollout ramps in one environment (the active ones, newest first, then the ten most recently " +
        'finished), or get one by passing ramp. A ramp raises a percentage rollout one step at a time on a timer. ' +
        'Each ramp shows its status (Running, Paused, Completed, Aborted), its steps, currentStepIndex, nextStepAt, ' +
        'and why it paused. A single ramp comes with an etag to pass as ifMatch to manage_rollout_ramp.',
      inputSchema: z.object({
        project: projectParam,
        flag: flagParam,
        environment: environmentParam,
        ramp: z.string().optional().describe('Ramp id: get just that ramp (with its etag) instead of listing'),
        ...pagination,
      }),
      // A single ramp also carries its etag; extra fields are always allowed.
      outputSchema: oneOfOutputs(endpoint(LIST_ROUTE), endpoint(GET_ROUTE)),
      annotations: { readOnlyHint: true },
    },
    async ({ project, flag, environment, ramp, limit, cursor }) =>
      runRamp(async () => {
        const path = `${base(project, flag, environment)}/ramps`;
        if (ramp === undefined) return okJson(await ctx.api.request('GET', path, { query: { limit, cursor } }));
        if (!GUID.test(ramp)) return notAnId('ramp', ramp, 'list_rollout_ramps');
        return okJson(withEtag(await ctx.api.requestWithEtag<Ramp>('GET', `${path}/${enc(ramp)}`)));
      }),
  );

  server.registerTool(
    'manage_rollout_ramp',
    {
      title: 'Start, pause, resume, advance, or abort a rollout ramp',
      description:
        'Manage a rollout ramp on a flag in one environment. A ramp raises a percentage rollout step by step: it ' +
        'applies the first step at once, then each next step when the previous hold runs out. Every step is an ' +
        'audited rule change that reaches SDKs over the stream. ' +
        'action=start needs rule + steps: rule is a targeting rule id (from get_targeting) whose rule serves a ' +
        'percentage rollout, or "default" for the default rule. Steps (1 to 20) must rise, the first not below the ' +
        "rule's current rollout. A default-rule ramp may name the variation to ramp to (variation id; needed when the " +
        'default rule has no rollout yet) and bucketBy, and on reaching 100% makes that variation the default. ' +
        'The flag must be on in the environment. ' +
        'action=pause keeps the rest of the hold; action=resume continues from the rule as it stands now; ' +
        'action=advance applies the next step now and needs expectedStepIndex (the currentStepIndex you last saw); ' +
        'action=abort stops the ramp and leaves the rule at percent (0-100, at or below the current one). ' +
        'pause, resume, advance and abort need ramp and accept ifMatch. Editing the rule by hand or turning the flag ' +
        'off pauses a ramp. Starting needs the Team plan or above; every write needs a Member token.',
      inputSchema: z.object({
        action: z
          .enum(['start', 'pause', 'resume', 'advance', 'abort'])
          .describe('start needs rule + steps; the others need ramp'),
        project: projectParam,
        flag: flagParam,
        environment: environmentParam,
        rule: z
          .string()
          .optional()
          .describe('start only: the targeting rule id (see get_targeting), or "default" for the default rule'),
        steps: z.array(stepSchema).min(1).max(20).optional().describe('start only: the ladder, in rising order'),
        variation: z
          .string()
          .optional()
          .describe('start on rule="default" only: the variation id to ramp to (see get_flag)'),
        bucketBy: z
          .string()
          .optional()
          .describe('start on rule="default" only: the context attribute to bucket by (default: key)'),
        ramp: z.string().optional().describe('Ramp id (see list_rollout_ramps); required for every action but start'),
        expectedStepIndex: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('advance only (required): the currentStepIndex you last saw; a ramp that moved on is refused (409)'),
        percent: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe('abort only (required): the rollout percentage to leave the rule at'),
        ifMatch: ifMatchParam('list_rollout_ramps with ramp'),
        reason: reasonParam,
        idempotency_key: z.string().optional().describe('Idempotency-Key header for start'),
      }),
      outputSchema: apiOutputWith(GET_ROUTE, { etag: writtenEtagOutput }),
      annotations: { destructiveHint: true },
    },
    async ({
      action, project, flag, environment, rule, steps, variation, bucketBy, ramp, expectedStepIndex, percent,
      ifMatch, reason, idempotency_key,
    }) =>
      runRamp(async () => {
        const root = base(project, flag, environment);

        if (action === 'start') {
          if (!rule || !steps) return errorResult(new Error('action=start requires rule and steps'));
          const ladder: RampStep[] = steps.map(({ percent: p, holdMinutes }) => ({ percent: p, holdMinutes }));
          if (rule === 'default') {
            return okJson(
              withEtag(
                await ctx.api.requestWithEtag<Ramp>('POST', `${root}/default-rule/ramp`, {
                  body: { steps: ladder, variationId: variation ?? null, bucketBy: bucketBy ?? null },
                  idempotencyKey: idempotency_key,
                  reason,
                }),
              ),
            );
          }
          if (variation !== undefined || bucketBy !== undefined) {
            return errorResult(
              new Error('variation and bucketBy apply only to rule="default"; a rule ramp keeps the rule\'s own'),
            );
          }
          if (!GUID.test(rule)) return notAnId('rule', rule, 'get_targeting, or pass rule="default"');
          return okJson(
            withEtag(
              await ctx.api.requestWithEtag<Ramp>('POST', `${root}/rules/${enc(rule)}/ramp`, {
                body: { steps: ladder },
                idempotencyKey: idempotency_key,
                reason,
              }),
            ),
          );
        }

        if (!ramp) return errorResult(new Error(`action=${action} requires ramp (see list_rollout_ramps)`));
        if (!GUID.test(ramp)) return notAnId('ramp', ramp, 'list_rollout_ramps');
        let body: object | undefined;
        if (action === 'advance') {
          if (expectedStepIndex === undefined) {
            return errorResult(
              new Error('action=advance requires expectedStepIndex: the currentStepIndex from list_rollout_ramps'),
            );
          }
          body = { expectedStepIndex };
        } else if (action === 'abort') {
          if (percent === undefined) {
            return errorResult(new Error('action=abort requires percent: the rollout percentage to leave the rule at'));
          }
          body = { percent };
        }
        return okJson(
          withEtag(
            await ctx.api.requestWithEtag<Ramp>('POST', `${root}/ramps/${enc(ramp)}/${action}`, {
              body,
              ifMatch,
              reason,
            }),
          ),
        );
      }),
  );
}

