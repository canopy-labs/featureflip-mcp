import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { enc } from '../client.js';
import { errorResult, okJson, run } from '../errors.js';
import type { ToolContext } from './context.js';
import type { components } from '../generated/api-types.js';

type Subscription = components['schemas']['PublicWebhookSubscriptionResponse'];

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every webhook action requires Admin, reads included, and the whole surface answers 404
// while webhooks are not enabled for the organization.
const ACCESS_NOTE = 'Requires an Admin token. A 404 on every webhook call means webhooks are not enabled for the organization.';

const pagination = {
  limit: z.number().int().min(1).max(100).optional().describe('Page size (default 20)'),
  cursor: z.string().optional().describe('next_cursor from a previous response'),
};

export function registerWebhookTools(server: McpServer, ctx: ToolContext): void {
  const base = `/api/v1/orgs/${enc(ctx.org)}/webhooks`;
  const hook = (id: string) => `${base}/${enc(id)}`;

  /** Project keys become ids; anything already shaped like an id is passed through untouched. */
  async function resolveProjects(entries: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const entry of entries) {
      if (GUID.test(entry)) {
        ids.push(entry);
        continue;
      }
      const project = await ctx.api.request<{ id?: string }>(
        'GET',
        `/api/v1/orgs/${enc(ctx.org)}/projects/${enc(entry)}`,
      );
      if (!project?.id) throw new Error(`Project "${entry}" resolved without an id`);
      ids.push(project.id);
    }
    return ids;
  }

  /**
   * Parses every entry before resolving any, so a malformed one fails without a request.
   * Environment keys repeat across projects (nearly every project has a "production"),
   * which is why a key must name its project.
   */
  async function resolveEnvironments(entries: string[]): Promise<string[]> {
    const parsed = entries.map((entry): { id: string } | { project: string; env: string } => {
      if (GUID.test(entry)) return { id: entry };
      const slash = entry.indexOf('/');
      const project = entry.slice(0, slash);
      const env = entry.slice(slash + 1);
      if (slash < 0 || !project || !env) {
        throw new Error(
          `Environment "${entry}" needs its project: pass "<project>/<environment>", e.g. "web/production", ` +
            "or the environment's id.",
        );
      }
      return { project, env };
    });
    const ids: string[] = [];
    for (const p of parsed) {
      if ('id' in p) {
        ids.push(p.id);
        continue;
      }
      const environment = await ctx.api.request<{ id?: string }>(
        'GET',
        `/api/v1/orgs/${enc(ctx.org)}/projects/${enc(p.project)}/environments/${enc(p.env)}`,
      );
      if (!environment?.id) throw new Error(`Environment "${p.project}/${p.env}" resolved without an id`);
      ids.push(environment.id);
    }
    return ids;
  }

  server.registerTool(
    'list_webhooks',
    {
      title: 'List webhook subscriptions',
      description:
        'List the organization\'s outbound webhook subscriptions (url, event/project/environment filters, ' +
        'enabled state, failure count, signing secret ids — never secret values), plus availableEventTypes: the ' +
        'event types a subscription can filter on. Empty filter lists mean "all". Paginated via cursor. ' +
        ACCESS_NOTE,
      inputSchema: z.object({ ...pagination }),
      annotations: { readOnlyHint: true },
    },
    async ({ limit, cursor }) =>
      run(async () => {
        const [page, availableEventTypes] = await Promise.all([
          ctx.api.request<Record<string, unknown>>('GET', base, { query: { limit, cursor } }),
          ctx.api.request<string[]>('GET', `${base}/event-types`),
        ]);
        return okJson({ ...page, availableEventTypes });
      }),
  );

  server.registerTool(
    'list_webhook_deliveries',
    {
      title: 'List webhook deliveries',
      description:
        'List one subscription\'s delivery attempts, most recent first. status is Pending (awaiting an attempt, ' +
        'backing off, or in flight), Succeeded or DeadLettered; lastResponseStatusCode and lastError explain a ' +
        'failure. Paginated via cursor. ' +
        ACCESS_NOTE,
      inputSchema: z.object({
        id: z.string().describe('Subscription id (from list_webhooks)'),
        ...pagination,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ id, limit, cursor }) =>
      run(async () => okJson(await ctx.api.request('GET', `${hook(id)}/deliveries`, { query: { limit, cursor } }))),
  );

  server.registerTool(
    'manage_webhook',
    {
      title: 'Create, update, or delete a webhook subscription, or rotate its secret',
      description:
        'action=create requires name + url and returns the signing secret. action=update/delete/rotate_secret/' +
        'retire_secret require id. update changes only the fields you pass and keeps the rest; pass an empty ' +
        'list to widen that filter back to "all". projects take project keys or ids; environments take ' +
        '"<project>/<environment>" keys (e.g. "web/production") or ids. eventTypes come from list_webhooks ' +
        '→ availableEventTypes. create and rotate_secret return a secret that is NEVER shown again: relay it ' +
        'to the user verbatim so they can store it. rotate_secret adds a new active secret while the old one ' +
        'keeps signing; retire_secret (secretId from list_webhooks) removes one and is refused for the last ' +
        'active secret. A project-restricted service token must list at least one project, all in its scope. ' +
        ACCESS_NOTE,
      inputSchema: z.object({
        action: z.enum(['create', 'update', 'delete', 'rotate_secret', 'retire_secret']),
        id: z.string().optional().describe('Subscription id; required for everything except create'),
        name: z.string().optional().describe('Required for create'),
        url: z.string().optional().describe('Receiver URL; required for create'),
        eventTypes: z.array(z.string()).optional().describe('Event types to send; empty or omitted = all'),
        projects: z
          .array(z.string())
          .optional()
          .describe('Project keys or ids to cover; empty or omitted on create = all'),
        environments: z
          .array(z.string())
          .optional()
          .describe('"<project>/<environment>" keys or environment ids; empty or omitted on create = all'),
        enabled: z.boolean().optional().describe('update only; subscriptions are created enabled'),
        secretId: z.string().optional().describe('Required for retire_secret'),
        idempotency_key: z.string().optional().describe('Idempotency-Key header for create / rotate_secret'),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ action, id, name, url, eventTypes, projects, environments, enabled, secretId, idempotency_key }) =>
      run(async () => {
        if (action === 'create') {
          if (!name || !url) return errorResult(new Error('action=create requires name and url'));
          // Resolve environments first: it validates every entry before making any request.
          const environmentIds = environments && (await resolveEnvironments(environments));
          const projectIds = projects && (await resolveProjects(projects));
          // POST returns 201 with { id, secret, warning } — pass it through so the secret reaches the user.
          return okJson(
            await ctx.api.request('POST', base, {
              // GenericHttp is the only provider the API accepts.
              body: { name, url, provider: 'GenericHttp', eventTypes, projectIds, environmentIds },
              idempotencyKey: idempotency_key,
            }),
          );
        }

        if (!id) return errorResult(new Error(`action=${action} requires id (see list_webhooks)`));

        if (action === 'update') {
          const environmentIds = environments && (await resolveEnvironments(environments));
          const projectIds = projects && (await resolveProjects(projects));
          // PUT is a full replace: an omitted list would widen that filter to "all", and a missing
          // isEnabled is a 400. Read the subscription and carry over everything not being changed.
          const current = await ctx.api.request<Subscription>('GET', hook(id));
          const body = {
            name: name ?? current.name,
            url: url ?? current.url,
            eventTypes: eventTypes ?? current.eventTypes,
            projectIds: projectIds ?? current.projectIds,
            environmentIds: environmentIds ?? current.environmentIds,
            isEnabled: enabled ?? current.isEnabled,
          };
          // PUT returns 204 No Content — confirm what was applied instead.
          await ctx.api.request('PUT', hook(id), { body });
          return okJson({ id, updated: true, ...body });
        }

        if (action === 'delete') {
          await ctx.api.request('DELETE', hook(id));
          return okJson({ deleted: id });
        }

        if (action === 'rotate_secret') {
          // POST returns 201 with { secretId, secret, warning } — the only time this secret is shown.
          return okJson(
            await ctx.api.request('POST', `${hook(id)}/secrets`, { idempotencyKey: idempotency_key }),
          );
        }

        if (!secretId) return errorResult(new Error('action=retire_secret requires secretId (see list_webhooks)'));
        await ctx.api.request('DELETE', `${hook(id)}/secrets/${enc(secretId)}`);
        return okJson({ id, retiredSecretId: secretId });
      }),
  );

  server.registerTool(
    'deliver_webhook',
    {
      title: 'Send a test event or redeliver',
      description:
        'action=test queues one synthetic flag.toggled event to this subscription alone; action=redeliver ' +
        '(deliveryId from list_webhook_deliveries) re-sends a finished delivery, restarting its retry ' +
        'schedule. Delivery is asynchronous: read list_webhook_deliveries for the outcome. Both are refused ' +
        'for a disabled subscription, and redeliver for a delivery that is still Pending. ' +
        ACCESS_NOTE,
      inputSchema: z.object({
        action: z.enum(['test', 'redeliver']),
        id: z.string().describe('Subscription id (from list_webhooks)'),
        deliveryId: z.string().optional().describe('Required for redeliver'),
      }),
      // Sends a request to the receiver but changes nothing in Featureflip.
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async ({ action, id, deliveryId }) =>
      run(async () => {
        if (action === 'test') {
          // POST returns 202 with { webhookEventId, webhookDeliveryId }.
          return okJson(await ctx.api.request('POST', `${hook(id)}/test`));
        }
        if (!deliveryId) {
          return errorResult(new Error('action=redeliver requires deliveryId (see list_webhook_deliveries)'));
        }
        // POST .../redeliver returns 204 No Content.
        await ctx.api.request('POST', `${hook(id)}/deliveries/${enc(deliveryId)}/redeliver`);
        return okJson({ id, redelivered: deliveryId });
      }),
  );
}
