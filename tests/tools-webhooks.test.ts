import { describe, it, expect } from 'vitest';
import { mockApi, connectClient } from './helpers.js';

const ORG = 'acme';
const HOOKS = `/api/v1/orgs/${ORG}/webhooks`;
const PROJECTS = `/api/v1/orgs/${ORG}/projects`;
const HOOK_ID = '11111111-1111-4111-8111-111111111111';
const WEB_ID = '22222222-2222-4222-8222-222222222222';
const PROD_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_PROJECT_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_ENV_ID = '55555555-5555-4555-8555-555555555555';

const text = (result: unknown) => (result as { content: { text: string }[] }).content[0].text;
const payload = (result: unknown) => JSON.parse(text(result));

const existing = {
  id: HOOK_ID,
  name: 'Slack relay',
  url: 'https://hooks.example.com/ff',
  provider: 'GenericHttp',
  isEnabled: true,
  eventTypes: ['flag.toggled'],
  projectIds: [WEB_ID],
  environmentIds: [PROD_ID],
  secrets: [],
};

describe('webhook tools', () => {
  it('list_webhooks returns the page plus the event types a subscription can filter on', async () => {
    const { api, calls } = mockApi([
      { method: 'GET', path: HOOKS, json: { items: [existing], next_cursor: 'c2' } },
      { method: 'GET', path: `${HOOKS}/event-types`, json: ['flag.created', 'flag.toggled'] },
    ]);
    const client = await connectClient({ api, org: ORG });

    const result = await client.callTool({ name: 'list_webhooks', arguments: { limit: 5, cursor: 'c1' } });

    expect(result.isError).toBeFalsy();
    const body = payload(result);
    expect(body.items[0].id).toBe(HOOK_ID);
    expect(body.next_cursor).toBe('c2');
    expect(body.availableEventTypes).toEqual(['flag.created', 'flag.toggled']);
    const list = calls.find((c) => new URL(c.url).pathname === HOOKS)!;
    expect(list.url).toContain('limit=5');
    expect(list.url).toContain('cursor=c1');
  });

  it('list_webhook_deliveries pages one subscription\'s delivery log', async () => {
    const { api, calls } = mockApi([
      { method: 'GET', path: `${HOOKS}/${HOOK_ID}/deliveries`, json: { items: [{ status: 'DeadLettered' }], next_cursor: null } },
    ]);
    const client = await connectClient({ api, org: ORG });

    const result = await client.callTool({ name: 'list_webhook_deliveries', arguments: { id: HOOK_ID, limit: 10 } });

    expect(result.isError).toBeFalsy();
    expect(payload(result).items[0].status).toBe('DeadLettered');
    expect(calls[0].url).toContain('limit=10');
  });

  describe('manage_webhook create', () => {
    it('resolves project and project/environment keys, passes ids through, and returns the one-time secret', async () => {
      const { api, calls } = mockApi([
        { method: 'GET', path: `${PROJECTS}/web`, json: { id: WEB_ID, key: 'web' } },
        { method: 'GET', path: `${PROJECTS}/web/environments/production`, json: { id: PROD_ID, key: 'production' } },
        { method: 'POST', path: HOOKS, status: 201, json: { id: HOOK_ID, secret: 'whsec_abc', warning: 'Store this secret securely — it will not be shown again.' } },
      ]);
      const client = await connectClient({ api, org: ORG });

      const result = await client.callTool({
        name: 'manage_webhook',
        arguments: {
          action: 'create',
          name: 'Slack relay',
          url: 'https://hooks.example.com/ff',
          eventTypes: ['flag.toggled'],
          projects: ['web', OTHER_PROJECT_ID],
          environments: ['web/production', OTHER_ENV_ID],
          idempotency_key: 'idem-1',
        },
      });

      expect(result.isError).toBeFalsy();
      const post = calls.find((c) => c.method === 'POST')!;
      expect(post.body).toEqual({
        name: 'Slack relay',
        url: 'https://hooks.example.com/ff',
        provider: 'GenericHttp',
        eventTypes: ['flag.toggled'],
        projectIds: [WEB_ID, OTHER_PROJECT_ID],
        environmentIds: [PROD_ID, OTHER_ENV_ID],
      });
      const body = payload(result);
      expect(body.secret).toBe('whsec_abc');
      expect(body.warning).toMatch(/not be shown again/);
    });

    it('omits every filter it was not given, which the API reads as "all"', async () => {
      const { api, calls } = mockApi([{ method: 'POST', path: HOOKS, status: 201, json: { id: HOOK_ID, secret: 's' } }]);
      const client = await connectClient({ api, org: ORG });

      await client.callTool({ name: 'manage_webhook', arguments: { action: 'create', name: 'All', url: 'https://x.example' } });

      expect(calls).toHaveLength(1);
      expect(calls[0].body).toEqual({ name: 'All', url: 'https://x.example', provider: 'GenericHttp' });
    });

    it('refuses a bare environment key without calling the API, since every project has a production', async () => {
      const { api, calls } = mockApi([]);
      const client = await connectClient({ api, org: ORG });

      const result = await client.callTool({
        name: 'manage_webhook',
        arguments: { action: 'create', name: 'n', url: 'https://x.example', environments: ['production'] },
      });

      expect(result.isError).toBe(true);
      expect(text(result)).toContain('web/production');
      expect(calls).toHaveLength(0);
    });

    it('surfaces an unknown project key as the API error and creates nothing', async () => {
      const { api, calls } = mockApi([
        { method: 'GET', path: `${PROJECTS}/wbe`, status: 404, json: { error: 'not_found', message: "Project 'wbe' was not found.", did_you_mean: ['web'] } },
      ]);
      const client = await connectClient({ api, org: ORG });

      const result = await client.callTool({
        name: 'manage_webhook',
        arguments: { action: 'create', name: 'n', url: 'https://x.example', projects: ['wbe'] },
      });

      expect(result.isError).toBe(true);
      expect(text(result)).toContain('Did you mean: web');
      expect(calls.some((c) => c.method === 'POST')).toBe(false);
    });

    it('requires name and url', async () => {
      const { api, calls } = mockApi([]);
      const client = await connectClient({ api, org: ORG });

      const result = await client.callTool({ name: 'manage_webhook', arguments: { action: 'create', name: 'n' } });

      expect(result.isError).toBe(true);
      expect(calls).toHaveLength(0);
    });
  });

  describe('manage_webhook update', () => {
    it('reads the subscription and sends it back whole, changing only what was given', async () => {
      const { api, calls } = mockApi([
        { method: 'GET', path: `${HOOKS}/${HOOK_ID}`, json: existing },
        { method: 'PUT', path: `${HOOKS}/${HOOK_ID}`, status: 204 },
      ]);
      const client = await connectClient({ api, org: ORG });

      const result = await client.callTool({
        name: 'manage_webhook',
        arguments: { action: 'update', id: HOOK_ID, name: 'Renamed' },
      });

      expect(result.isError).toBeFalsy();
      // The PUT is a full replace: an omitted list would widen the filter to "all" and a missing
      // isEnabled is a 400, so everything not being changed is carried over from the read.
      expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
        name: 'Renamed',
        url: existing.url,
        eventTypes: existing.eventTypes,
        projectIds: existing.projectIds,
        environmentIds: existing.environmentIds,
        isEnabled: true,
      });
    });

    it('disables, and an empty list widens that filter back to all', async () => {
      const { api, calls } = mockApi([
        { method: 'GET', path: `${HOOKS}/${HOOK_ID}`, json: existing },
        { method: 'PUT', path: `${HOOKS}/${HOOK_ID}`, status: 204 },
      ]);
      const client = await connectClient({ api, org: ORG });

      await client.callTool({
        name: 'manage_webhook',
        arguments: { action: 'update', id: HOOK_ID, enabled: false, projects: [], eventTypes: [] },
      });

      expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({
        isEnabled: false,
        projectIds: [],
        eventTypes: [],
        environmentIds: existing.environmentIds,
      });
    });

    it('resolves keys given on update', async () => {
      const { api, calls } = mockApi([
        { method: 'GET', path: `${HOOKS}/${HOOK_ID}`, json: existing },
        { method: 'GET', path: `${PROJECTS}/api/environments/staging`, json: { id: OTHER_ENV_ID } },
        { method: 'PUT', path: `${HOOKS}/${HOOK_ID}`, status: 204 },
      ]);
      const client = await connectClient({ api, org: ORG });

      await client.callTool({
        name: 'manage_webhook',
        arguments: { action: 'update', id: HOOK_ID, environments: ['api/staging'] },
      });

      expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({ environmentIds: [OTHER_ENV_ID] });
    });

    it('requires id', async () => {
      const { api, calls } = mockApi([]);
      const client = await connectClient({ api, org: ORG });

      const result = await client.callTool({ name: 'manage_webhook', arguments: { action: 'update', name: 'x' } });

      expect(result.isError).toBe(true);
      expect(calls).toHaveLength(0);
    });
  });

  it('manage_webhook delete / rotate_secret / retire_secret hit their endpoints', async () => {
    const SECRET_ID = '66666666-6666-4666-8666-666666666666';
    const { api, calls } = mockApi([
      { method: 'DELETE', path: `${HOOKS}/${HOOK_ID}`, status: 204 },
      { method: 'POST', path: `${HOOKS}/${HOOK_ID}/secrets`, status: 201, json: { secretId: SECRET_ID, secret: 'whsec_new', warning: 'Store this secret securely — it will not be shown again.' } },
      { method: 'DELETE', path: `${HOOKS}/${HOOK_ID}/secrets/${SECRET_ID}`, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });

    const del = await client.callTool({ name: 'manage_webhook', arguments: { action: 'delete', id: HOOK_ID } });
    const rotated = await client.callTool({ name: 'manage_webhook', arguments: { action: 'rotate_secret', id: HOOK_ID } });
    const retired = await client.callTool({
      name: 'manage_webhook',
      arguments: { action: 'retire_secret', id: HOOK_ID, secretId: SECRET_ID },
    });

    expect(payload(del)).toEqual({ deleted: HOOK_ID });
    expect(payload(rotated)).toMatchObject({ secretId: SECRET_ID, secret: 'whsec_new' });
    expect(payload(retired)).toEqual({ id: HOOK_ID, retiredSecretId: SECRET_ID });
    expect(calls.map((c) => c.method)).toEqual(['DELETE', 'POST', 'DELETE']);
  });

  it('manage_webhook retire_secret requires secretId', async () => {
    const { api, calls } = mockApi([]);
    const client = await connectClient({ api, org: ORG });

    const result = await client.callTool({ name: 'manage_webhook', arguments: { action: 'retire_secret', id: HOOK_ID } });

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('deliver_webhook queues a test event or a redelivery', async () => {
    const DELIVERY_ID = '77777777-7777-4777-8777-777777777777';
    const { api, calls } = mockApi([
      { method: 'POST', path: `${HOOKS}/${HOOK_ID}/test`, status: 202, json: { webhookEventId: 'e1', webhookDeliveryId: DELIVERY_ID } },
      { method: 'POST', path: `${HOOKS}/${HOOK_ID}/deliveries/${DELIVERY_ID}/redeliver`, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });

    const test = await client.callTool({ name: 'deliver_webhook', arguments: { action: 'test', id: HOOK_ID } });
    const again = await client.callTool({
      name: 'deliver_webhook',
      arguments: { action: 'redeliver', id: HOOK_ID, deliveryId: DELIVERY_ID },
    });

    expect(payload(test).webhookDeliveryId).toBe(DELIVERY_ID);
    expect(payload(again)).toEqual({ id: HOOK_ID, redelivered: DELIVERY_ID });
    expect(calls.map((c) => c.method)).toEqual(['POST', 'POST']);
  });

  it('deliver_webhook redeliver requires deliveryId', async () => {
    const { api, calls } = mockApi([]);
    const client = await connectClient({ api, org: ORG });

    const result = await client.callTool({ name: 'deliver_webhook', arguments: { action: 'redeliver', id: HOOK_ID } });

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
