import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ApiError, enc } from '../client.js';
import { errorResult, okJson, type ToolResult } from '../errors.js';
import type { ToolContext } from './context.js';
import { endpoint, oneOfOutputs, shape } from './outputs.js';
import { environmentParam, flagParam, pagination, projectParam, reasonParam } from './params.js';
import type { components } from '../generated/api-types.js';

type Trigger = components['schemas']['PublicFlagTriggerResponse'];
type TriggerWithUrl = components['schemas']['PublicFlagTriggerWithUrlResponse'];

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ROUTE = 'GET /api/v1/orgs/{org}/projects/{project}/flags/{flag}/environments/{env}/triggers';

// The URL and secret exist only in the create and rotate responses; list carries the secret's
// last four characters. Either one fires the trigger, so it belongs in the monitoring tool's
// secret store and nowhere else.
const SECRET_WARNING =
  'Relay the url (or endpoint + secret) to the user verbatim so they can paste it into their monitoring tool, ' +
  'where it should be stored as a secret. Never write it to source control or a chat log. If it leaks, rotate it.';

const ROTATE_WARNING = 'The old URL stopped working the moment this returned: update the monitoring tool now.';

// The API's refusals carry their code in the text, in two different places: PLAN_FEATURE_UNAVAILABLE
// in the message of a 400 bad_request, FEATURE_NOT_ENABLED in a validation_failed field error (the
// public API replaces that envelope's message with a generic one).
const GATE_HINTS: [code: string, hint: string][] = [
  [
    'PLAN_FEATURE_UNAVAILABLE',
    'Flag triggers need the Team plan or above. On a lower plan you can still list, rename, disable and delete ' +
      'existing triggers, but not create, re-enable or rotate one. An organization Owner can upgrade in Billing.',
  ],
  [
    'FEATURE_NOT_ENABLED',
    'Flag triggers are not enabled for this organization yet. Nothing in the request is wrong, and retrying will ' +
      'not help until they are.',
  ],
];

function gateHint(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  const said = [err.envelope.message, ...Object.values(err.envelope.fields ?? {}).flat()].join('\n');
  return GATE_HINTS.find(([code]) => said.includes(code))?.[1];
}

async function runTrigger(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    const result = errorResult(err);
    const hint = gateHint(err);
    if (hint) result.content[0].text += `\n${hint}`;
    return result;
  }
}

// Triggers have no key, and the API answers a non-id with a 404 that errorResult annotates as
// "the public API may not be enabled", which sends the agent the wrong way.
const notAnId = (trigger: string) =>
  errorResult(new Error(`trigger must be a trigger id, not "${trigger}": triggers have no key. See list_flag_triggers.`));

export function registerFlagTriggerTools(server: McpServer, ctx: ToolContext): void {
  const triggers = (project: string, flag: string, environment: string) =>
    `/api/v1/orgs/${enc(ctx.org)}/projects/${enc(project)}/flags/${enc(flag)}/environments/${enc(environment)}/triggers`;

  server.registerTool(
    'list_flag_triggers',
    {
      title: 'List flag triggers',
      description:
        "List a flag's triggers in one environment, or get one by passing trigger: id, name, action (Enable or " +
        'Disable), whether each is enabled, the last four characters of its secret, and when it last fired. A ' +
        'trigger is a secret URL that a monitoring tool (a Grafana alert, a Datadog monitor) calls to turn the flag ' +
        'on or off. The URL is never listed; it is shown once, when manage_flag_trigger creates or rotates it.',
      inputSchema: z.object({
        project: projectParam,
        flag: flagParam,
        environment: environmentParam,
        trigger: z.string().optional().describe('Trigger id: get just that trigger instead of listing'),
        ...pagination,
      }),
      outputSchema: oneOfOutputs(endpoint(ROUTE), endpoint(`${ROUTE}/{trigger}`)),
      annotations: { readOnlyHint: true },
    },
    async ({ project, flag, environment, trigger, limit, cursor }) =>
      runTrigger(async () => {
        const base = triggers(project, flag, environment);
        if (trigger === undefined) return okJson(await ctx.api.request('GET', base, { query: { limit, cursor } }));
        if (!GUID.test(trigger)) return notAnId(trigger);
        return okJson(await ctx.api.request('GET', `${base}/${enc(trigger)}`));
      }),
  );

  server.registerTool(
    'manage_flag_trigger',
    {
      title: 'Create, update, rotate, or delete a flag trigger',
      description:
        "Manage a flag's triggers in one environment. A trigger is a secret URL a monitoring tool POSTs to (no body) " +
        'to turn the flag on (Enable) or off (Disable); calling it when the flag is already in that state changes ' +
        'nothing. action=create needs name + triggerAction and returns the URL ONCE. action=update needs trigger and ' +
        'changes only the fields you pass (name, description, enabled; enabled=false stops the URL working until ' +
        're-enabled). action=rotate needs trigger: the old URL stops working at once and the new one is returned ONCE. ' +
        'action=delete needs trigger. The action (Enable/Disable) is fixed at creation. Creating, re-enabling and ' +
        'rotating need the Team plan or above; every write needs a Member token; at most 10 per flag per ' +
        'environment. To change the flag yourself, use toggle_flag instead.',
      inputSchema: z.object({
        action: z
          .enum(['create', 'update', 'rotate', 'delete'])
          .describe('create needs name + triggerAction; update, rotate and delete need trigger'),
        project: projectParam,
        flag: flagParam,
        environment: environmentParam,
        trigger: z.string().optional().describe('Trigger id (see list_flag_triggers); required for update, rotate and delete'),
        name: z.string().optional().describe('Trigger name, e.g. "Grafana: checkout error rate"; required for create'),
        triggerAction: z
          .enum(['Enable', 'Disable'])
          .optional()
          .describe('Required for create: Disable turns the flag off (a kill switch), Enable turns it on'),
        description: z.string().optional().describe('What calls the trigger and why; "" clears it'),
        enabled: z.boolean().optional().describe('update only: false stops the URL working, true turns it back on'),
        reason: reasonParam,
        idempotency_key: z.string().optional().describe('Idempotency-Key header for create'),
      }),
      outputSchema: oneOfOutputs(
        endpoint('POST /api/v1/orgs/{org}/projects/{project}/flags/{flag}/environments/{env}/triggers'),
        endpoint('PUT /api/v1/orgs/{org}/projects/{project}/flags/{flag}/environments/{env}/triggers/{trigger}'),
        shape({ deleted: { type: 'string' } }, ['deleted']),
      ),
      annotations: { destructiveHint: true },
    },
    async ({ action, project, flag, environment, trigger, name, triggerAction, description, enabled, reason, idempotency_key }) =>
      runTrigger(async () => {
        const base = triggers(project, flag, environment);
        const withWarning = (created: TriggerWithUrl, ...first: string[]) =>
          okJson({ ...created, warning: [...first, created.warning, SECRET_WARNING].filter(Boolean).join(' ') });

        if (action === 'create') {
          if (!name || !triggerAction) return errorResult(new Error('action=create requires name and triggerAction'));
          const created = await ctx.api.request<TriggerWithUrl>('POST', base, {
            body: { name, action: triggerAction, description },
            idempotencyKey: idempotency_key,
            reason,
          });
          return withWarning(created);
        }
        if (!trigger) return errorResult(new Error(`action=${action} requires trigger (see list_flag_triggers)`));
        if (!GUID.test(trigger)) return notAnId(trigger);
        const path = `${base}/${enc(trigger)}`;
        if (action === 'update') {
          if (name === undefined && description === undefined && enabled === undefined) {
            return errorResult(new Error('action=update needs at least one of name, description or enabled'));
          }
          // PUT replaces name, description and enabled together; keep whatever the caller didn't pass.
          const current = await ctx.api.request<Trigger>('GET', path);
          const body = {
            name: name ?? current.name,
            description: description === '' ? null : (description ?? current.description ?? null),
            enabled: enabled ?? current.enabled,
          };
          return okJson(await ctx.api.request('PUT', path, { body, reason }));
        }
        if (action === 'rotate') {
          return withWarning(await ctx.api.request<TriggerWithUrl>('POST', `${path}/rotate`, { reason }), ROTATE_WARNING);
        }
        // DELETE returns 204 No Content.
        await ctx.api.request('DELETE', path, { reason });
        return okJson({ deleted: trigger });
      }),
  );
}
