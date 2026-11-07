import { describe, it, expect } from 'vitest';
import { mockApi, connectClient } from './helpers.js';

const ORG = 'acme';
const P = `/api/v1/orgs/${ORG}/projects/web`;
const FLAG = `${P}/flags/checkout-v2`;
const REASON = 'Incident 42';
const WIRE = encodeURIComponent(REASON);
const text = (r: { content: unknown }) => (r.content as { text: string }[])[0].text;
const reasons = (calls: { method: string; headers: Record<string, string> }[]) =>
  calls.filter((c) => c.method !== 'GET').map((c) => c.headers['X-Intent-Reason']);

describe('reason on write tools', () => {
  it('toggle_flag forwards reason', async () => {
    const { api, calls } = mockApi([{ method: 'POST', path: `${FLAG}/environments/production/toggle`, status: 204 }]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({
      name: 'toggle_flag',
      arguments: { project: 'web', flag: 'checkout-v2', environment: 'production', enabled: true, reason: REASON },
    });
    expect(calls[0].headers['X-Intent-Reason']).toBe(WIRE);
  });

  it('update_flag_environment_config forwards reason and keeps it out of the body', async () => {
    const { api, calls } = mockApi([{ method: 'PUT', path: `${FLAG}/environments/staging`, status: 204 }]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({
      name: 'update_flag_environment_config',
      arguments: { project: 'web', flag: 'checkout-v2', environment: 'staging', defaultVariationId: 'v1', reason: REASON },
    });
    expect(calls[0].headers['X-Intent-Reason']).toBe(WIRE);
    expect(calls[0].body).toEqual({ defaultVariationId: 'v1' });
  });

  it('update_targeting forwards reason', async () => {
    const { api, calls } = mockApi([{ method: 'PUT', path: `${FLAG}/environments/production/targeting`, status: 204 }]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({
      name: 'update_targeting',
      arguments: { project: 'web', flag: 'checkout-v2', environment: 'production', rules: [], reason: REASON },
    });
    expect(reasons(calls)).toEqual([WIRE]);
  });

  it('manage_targeting_rule forwards reason on every write action', async () => {
    const R = `${FLAG}/environments/production/rules`;
    const { api, calls } = mockApi([
      { method: 'POST', path: R, status: 201, json: { id: 'r1' } },
      { method: 'PUT', path: `${R}/reorder`, status: 204 },
      { method: 'GET', path: `${R}/r1`, json: { variationId: 'v1', rolloutPercentage: null, bucketBy: null, userSegmentId: null, description: null, conditionGroups: [] }, headers: { ETag: '"e"' } },
      { method: 'PUT', path: `${R}/r1`, status: 204 },
      { method: 'DELETE', path: `${R}/r1`, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });
    const base = { project: 'web', flag: 'checkout-v2', environment: 'production', reason: REASON };
    for (const args of [
      { action: 'add', rule: { variationId: 'v1' } },
      { action: 'reorder', ruleIds: ['r1'] },
      { action: 'update', ruleId: 'r1', rule: { description: 'd' } },
      { action: 'remove', ruleId: 'r1' },
    ]) {
      const r = await client.callTool({ name: 'manage_targeting_rule', arguments: { ...base, ...args } });
      expect(r.isError, JSON.stringify(args)).toBeFalsy();
    }
    expect(reasons(calls)).toEqual([WIRE, WIRE, WIRE, WIRE]);
  });

  it('manage_segment forwards reason on create, update and delete', async () => {
    const S = `${P}/segments`;
    const { api, calls } = mockApi([
      { method: 'POST', path: S, status: 201, json: { id: 's1' } },
      { method: 'GET', path: `${S}/beta`, json: { name: 'Beta', description: null, conditions: [] }, headers: { ETag: '"e"' } },
      { method: 'PUT', path: `${S}/beta`, status: 204 },
      { method: 'DELETE', path: `${S}/beta`, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });
    for (const args of [
      { action: 'create', key: 'beta', name: 'Beta' },
      { action: 'update', segment: 'beta', name: 'B2' },
      { action: 'delete', segment: 'beta' },
    ]) {
      await client.callTool({ name: 'manage_segment', arguments: { project: 'web', reason: REASON, ...args } });
    }
    expect(reasons(calls)).toEqual([WIRE, WIRE, WIRE]);
  });

  it('manage_variation forwards reason on add, update and remove', async () => {
    const V = `${FLAG}/variations`;
    const { api, calls } = mockApi([
      { method: 'POST', path: V, status: 201, json: { id: 'v9' } },
      { method: 'PUT', path: `${V}/v9`, status: 204 },
      { method: 'DELETE', path: `${V}/v9`, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });
    for (const args of [
      { action: 'add', key: 'x', value: 'true' },
      { action: 'update', variationId: 'v9', name: 'n' },
      { action: 'remove', variationId: 'v9' },
    ]) {
      await client.callTool({ name: 'manage_variation', arguments: { project: 'web', flag: 'checkout-v2', reason: REASON, ...args } });
    }
    expect(reasons(calls)).toEqual([WIRE, WIRE, WIRE]);
  });

  it('archive_flag, restore_flag and delete_flag forward reason', async () => {
    const { api, calls } = mockApi([
      { method: 'POST', path: `${FLAG}/archive`, status: 204 },
      { method: 'POST', path: `${FLAG}/restore`, status: 204 },
      { method: 'DELETE', path: FLAG, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });
    for (const name of ['archive_flag', 'restore_flag', 'delete_flag']) {
      const r = await client.callTool({ name, arguments: { project: 'web', flag: 'checkout-v2', reason: REASON } });
      expect(r.isError, name).toBeFalsy();
    }
    expect(reasons(calls)).toEqual([WIRE, WIRE, WIRE]);
  });

  it('update_flag forwards reason (a clientSideVisible change can need one) and keeps it out of the body', async () => {
    const { api, calls } = mockApi([
      { method: 'GET', path: FLAG, json: { name: 'Checkout', description: null }, headers: { ETag: '"e1"' } },
      { method: 'PUT', path: FLAG, status: 204, headers: { ETag: '"e2"' } },
    ]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({
      name: 'update_flag',
      arguments: { project: 'web', flag: 'checkout-v2', clientSideVisible: true, reason: REASON },
    });
    expect(r.isError).toBeFalsy();
    expect(reasons(calls)).toEqual([WIRE]);
    expect('reason' in (calls[1].body as Record<string, unknown>)).toBe(false);
  });

  it('manage_sdk_key forwards reason on revoke', async () => {
    const K = `${P}/environments/production/sdk-keys/k1`;
    const { api, calls } = mockApi([{ method: 'POST', path: `${K}/revoke`, status: 204 }]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({
      name: 'manage_sdk_key',
      arguments: { action: 'revoke', project: 'web', environment: 'production', sdkKey: 'k1', reason: REASON },
    });
    expect(r.isError).toBeFalsy();
    expect(reasons(calls)).toEqual([WIRE]);
  });

  it('every tool that can reach a reason-gated write accepts reason', async () => {
    const { api } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    const { tools } = await client.listTools();
    const gated = [
      'toggle_flag', 'update_flag_environment_config', 'update_targeting', 'manage_targeting_rule',
      'manage_segment', 'manage_variation', 'archive_flag', 'restore_flag', 'delete_flag',
      'update_flag', 'manage_sdk_key', 'manage_environment', 'manage_flag_trigger',
    ];
    for (const name of gated) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(Object.keys((tool!.inputSchema as { properties: object }).properties), name).toContain('reason');
    }
  });

  it('a 422 change_reason_required surfaces its message to the agent', async () => {
    const message = 'Changing production requires one. Send it in the X-Intent-Reason header.';
    const { api } = mockApi([
      { method: 'POST', path: `${FLAG}/environments/production/toggle`, status: 422, json: { error: 'change_reason_required', message } },
    ]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({
      name: 'toggle_flag',
      arguments: { project: 'web', flag: 'checkout-v2', environment: 'production', enabled: true },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('change_reason_required');
    expect(text(r)).toContain('requires one. Send it in the X-Intent-Reason header');
    expect(text(r)).toContain('Retry this tool call with the `reason` argument explaining why you are making the change.');
  });
});

describe('manage_environment critical settings', () => {
  const ENVS = `${P}/environments`;

  it('create maps require_change_reason / require_confirmation', async () => {
    const { api, calls } = mockApi([{ method: 'POST', path: ENVS, status: 201, json: { id: 'e1' } }]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({
      name: 'manage_environment',
      arguments: { action: 'create', project: 'web', key: 'prod2', name: 'Prod 2', require_change_reason: true, require_confirmation: false, reason: REASON },
    });
    expect(calls[0].body).toMatchObject({ requireChangeReason: true, requireConfirmation: false });
    expect(calls[0].headers['X-Intent-Reason']).toBe(WIRE);
  });

  it('update sends only the critical fields it was given', async () => {
    const { api, calls } = mockApi([
      { method: 'GET', path: `${ENVS}/staging`, json: { name: 'S', color: null, sortOrder: 1, requireChangeReason: false, requireConfirmation: false }, headers: { ETag: '"e1"' } },
      { method: 'PUT', path: `${ENVS}/staging`, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({
      name: 'manage_environment',
      arguments: { action: 'update', project: 'web', environment: 'staging', require_change_reason: true },
    });
    const body = calls[1].body as Record<string, unknown>;
    expect(body.requireChangeReason).toBe(true);
    expect('requireConfirmation' in body).toBe(false);
  });

  it('update forwards reason when turning a critical setting off', async () => {
    const { api, calls } = mockApi([
      { method: 'GET', path: `${ENVS}/production`, json: { name: 'P', color: null, sortOrder: 2 }, headers: { ETag: '"e1"' } },
      { method: 'PUT', path: `${ENVS}/production`, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({
      name: 'manage_environment',
      arguments: { action: 'update', project: 'web', environment: 'production', require_change_reason: false, reason: REASON },
    });
    expect(calls[1].headers['X-Intent-Reason']).toBe(WIRE);
    expect((calls[1].body as Record<string, unknown>).requireChangeReason).toBe(false);
  });

  it('update without them leaves both out of the body (unchanged)', async () => {
    const { api, calls } = mockApi([
      { method: 'GET', path: `${ENVS}/staging`, json: { name: 'S', color: null, sortOrder: 1 }, headers: { ETag: '"e1"' } },
      { method: 'PUT', path: `${ENVS}/staging`, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({ name: 'manage_environment', arguments: { action: 'update', project: 'web', environment: 'staging', sortOrder: 0 } });
    const body = calls[1].body as Record<string, unknown>;
    expect('requireChangeReason' in body).toBe(false);
    expect('requireConfirmation' in body).toBe(false);
  });
});
