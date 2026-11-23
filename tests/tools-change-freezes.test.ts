import { describe, it, expect } from 'vitest';
import { mockApi, connectClient } from './helpers.js';

const ORG = 'acme';
const BASE = `/api/v1/orgs/${ORG}/change-freezes`;
const FLAG = `/api/v1/orgs/${ORG}/projects/web/flags/checkout`;
const ID = '0b6f1c1e-6a39-4d55-9f3e-1f0f2b3c4d5e';
const SC = '1c6f1c1e-6a39-4d55-9f3e-1f0f2b3c4d5f';
const KEY = '2c6f1c1e-6a39-4d55-9f3e-1f0f2b3c4d60';
const text = (r: { content: unknown }) => (r.content as { text: string }[])[0].text;
const freeze = (o: Record<string, unknown> = {}) => ({
  id: ID, name: 'Black Friday', reason: 'peak', allEnvironments: false, environmentKeys: ['production'],
  environmentIds: [], startsAt: '2026-11-27T00:00:00Z', endsAt: null, scheduledChangePolicy: 'Hold',
  status: 'Active', enforcing: true, approvals: [], createdByEmail: 'a@b.c', ...o,
});
const refused = async (p: Promise<{ isError?: unknown }>) => {
  try {
    return (await p).isError === true;
  } catch {
    return true;
  }
};

describe('change freeze tools', () => {
  it('list_change_freezes sends status and project, read-only', async () => {
    const { api, calls } = mockApi([{ method: 'GET', path: BASE, json: { items: [freeze()], next_cursor: null } }]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({ name: 'list_change_freezes', arguments: { status: 'Active', project: 'web' } });
    expect(r.isError).toBeFalsy();
    expect(calls[0].url).toContain('status=Active');
    expect(calls[0].url).toContain('project=web');
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'list_change_freezes')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'manage_change_freeze')?.annotations?.destructiveHint).toBe(true);
  });

  it('list_change_freezes gets one by id', async () => {
    const { api } = mockApi([{ method: 'GET', path: `${BASE}/${ID}`, json: freeze(), headers: { ETag: '"e1"' } }]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({ name: 'list_change_freezes', arguments: { freeze_id: ID } });
    expect(JSON.parse(text(r)).name).toBe('Black Friday');
    expect(JSON.parse(text(r)).etag).toBe('"e1"');
  });

  it('freeze_now posts without starts_at', async () => {
    const { api, calls } = mockApi([{ method: 'POST', path: BASE, status: 201, json: freeze() }]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({
      name: 'manage_change_freeze',
      arguments: { action: 'freeze_now', name: 'Incident', reason: 'INC-1', environments: ['production'], idempotency_key: KEY },
    });
    expect(r.isError).toBeFalsy();
    expect(calls[0].body).toEqual({ name: 'Incident', reason: 'INC-1', environmentKeys: ['production'], allEnvironments: false });
    expect(calls[0].headers['Idempotency-Key']).toBe(KEY);
  });

  it('freeze_now refuses starts_at without calling the API', async () => {
    const { api, calls } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({
      name: 'manage_change_freeze',
      arguments: { action: 'freeze_now', name: 'n', reason: 'r', environments: ['production'], starts_at: '2030-01-01T00:00:00Z' },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('freeze_now starts at once; use action=create with starts_at to schedule');
    expect(calls).toHaveLength(0);
  });

  it('update refuses project; get refuses freeze_id with filters; end sends the idempotency key', async () => {
    const { api, calls } = mockApi([{ method: 'POST', path: `${BASE}/${ID}/end`, json: freeze({ status: 'Ended' }) }]);
    const client = await connectClient({ api, org: ORG });
    const u = await client.callTool({ name: 'manage_change_freeze', arguments: { action: 'update', freeze_id: ID, project: 'web' } });
    expect(u.isError).toBe(true);
    const l = await client.callTool({ name: 'list_change_freezes', arguments: { freeze_id: ID, status: 'Active' } });
    expect(l.isError).toBe(true);
    expect(calls).toHaveLength(0);
    await client.callTool({ name: 'manage_change_freeze', arguments: { action: 'end', freeze_id: ID, idempotency_key: KEY } });
    expect(calls[0].headers['Idempotency-Key']).toBe(KEY);
  });

  it('create sends starts_at, ends_at, policy and project', async () => {
    const { api, calls } = mockApi([{ method: 'POST', path: BASE, status: 201, json: freeze() }]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({
      name: 'manage_change_freeze',
      arguments: {
        action: 'create', name: 'BF', reason: 'peak', project: 'web', all_environments: true,
        starts_at: '2026-11-27T00:00:00Z', ends_at: '2026-11-30T00:00:00Z', scheduled_change_policy: 'Fail',
      },
    });
    expect(calls[0].body).toEqual({
      name: 'BF', reason: 'peak', project: 'web', allEnvironments: true,
      startsAt: '2026-11-27T00:00:00Z', endsAt: '2026-11-30T00:00:00Z', scheduledChangePolicy: 'Fail',
    });
  });

  it('create refuses a missing name or ends_at-less scheduled window without calling the API', async () => {
    const { api, calls } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    expect(await refused(client.callTool({ name: 'manage_change_freeze', arguments: { action: 'create', reason: 'x' } }))).toBe(true);
    expect(await refused(client.callTool({
      name: 'manage_change_freeze',
      arguments: { action: 'create', name: 'n', reason: 'x', environments: ['production'], starts_at: '2030-01-01T00:00:00Z' },
    }))).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('update PATCHes only given fields with the etag as If-Match', async () => {
    const { api, calls } = mockApi([{ method: 'PATCH', path: `${BASE}/${ID}`, json: freeze({ name: 'New' }), headers: { ETag: '"e2"' } }]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({
      name: 'manage_change_freeze',
      arguments: { action: 'update', freeze_id: ID, name: 'New', ends_at: '2026-12-01T00:00:00Z', ifMatch: 'e1' },
    });
    expect(calls[0].body).toEqual({ name: 'New', endsAt: '2026-12-01T00:00:00Z' });
    expect(calls[0].headers['If-Match']).toBe('"e1"');
    expect(JSON.parse(text(r)).etag).toBe('"e2"');
  });

  it('end posts to /end and delete deletes', async () => {
    const { api, calls } = mockApi([
      { method: 'POST', path: `${BASE}/${ID}/end`, json: freeze({ status: 'Ended' }) },
      { method: 'DELETE', path: `${BASE}/${ID}`, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });
    const end = await client.callTool({ name: 'manage_change_freeze', arguments: { action: 'end', freeze_id: ID } });
    expect(end.isError).toBeFalsy();
    const del = await client.callTool({ name: 'manage_change_freeze', arguments: { action: 'delete', freeze_id: ID } });
    expect(JSON.parse(text(del))).toEqual({ deleted: ID });
    expect(calls.map((c) => c.method)).toEqual(['POST', 'DELETE']);
  });

  it('approve posts to approvals; revoke deletes the approval', async () => {
    const { api, calls } = mockApi([
      { method: 'POST', path: `${BASE}/${ID}/approvals`, status: 201, json: { scheduledChangeId: SC, stands: true } },
      { method: 'DELETE', path: `${BASE}/${ID}/approvals/${SC}`, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });
    const a = await client.callTool({
      name: 'manage_change_freeze',
      arguments: { action: 'approve_scheduled_change', freeze_id: ID, scheduled_change_id: SC, reason: 'hotfix', idempotency_key: KEY },
    });
    expect(a.isError).toBeFalsy();
    expect(calls[0].body).toEqual({ scheduledChangeId: SC, reason: 'hotfix' });
    const d = await client.callTool({
      name: 'manage_change_freeze',
      arguments: { action: 'revoke_approval', freeze_id: ID, scheduled_change_id: SC },
    });
    expect(JSON.parse(text(d))).toEqual({ deleted: SC });
  });

  it('approve requires reason', async () => {
    const { api, calls } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    expect(await refused(client.callTool({
      name: 'manage_change_freeze',
      arguments: { action: 'approve_scheduled_change', freeze_id: ID, scheduled_change_id: SC },
    }))).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('freeze_override', () => {
  it('toggle_flag sends X-Freeze-Override when freeze_override', async () => {
    const { api, calls } = mockApi([{ method: 'POST', path: `${FLAG}/environments/production/toggle`, status: 204 }]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({
      name: 'toggle_flag',
      arguments: { project: 'web', flag: 'checkout', environment: 'production', enabled: false, reason: 'INC-9', freeze_override: true },
    });
    expect(calls[0].headers['X-Freeze-Override']).toBe('true');
    expect(calls[0].headers['X-Intent-Reason']).toBe('INC-9');
  });

  it('omits the header by default', async () => {
    const { api, calls } = mockApi([{ method: 'POST', path: `${FLAG}/environments/production/toggle`, status: 204 }]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({ name: 'toggle_flag', arguments: { project: 'web', flag: 'checkout', environment: 'production', enabled: false } });
    expect(calls[0].headers['X-Freeze-Override']).toBeUndefined();
  });

  it('freeze_override without reason is a validation error and makes no request', async () => {
    const { api, calls } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({
      name: 'toggle_flag',
      arguments: { project: 'web', flag: 'checkout', environment: 'production', enabled: false, freeze_override: true },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('freeze_override requires reason');
    expect(calls).toHaveLength(0);
  });

  it('is accepted by every flag-state write tool', async () => {
    const client = await connectClient({ api: mockApi([]).api, org: ORG });
    const { tools } = await client.listTools();
    for (const name of ['toggle_flag', 'update_targeting', 'manage_targeting_rule', 'update_flag_environment_config', 'copy_flag_config', 'restore_flag_version', 'manage_rollout_ramp']) {
      const props = tools.find((t) => t.name === name)?.inputSchema.properties as Record<string, unknown>;
      expect(props, name).toHaveProperty('freeze_override');
    }
  });
});

describe('freeze_override header on each write tool', () => {
  const E = `${FLAG}/environments/production`;
  const RAMP = '0b6f1c1e-6a39-4d55-9f3e-1f0f2b3c4d5e';
  const ramp = { id: RAMP, status: 'Running' };
  const where = { project: 'web', flag: 'checkout', environment: 'production' };

  it('update_targeting, manage_targeting_rule, update_flag_environment_config and copy_flag_config send it', async () => {
    const { api, calls } = mockApi([
      { method: 'PUT', path: `${E}/targeting`, status: 204 },
      { method: 'PUT', path: `${E}/rules/reorder`, status: 204 },
      { method: 'PUT', path: E, status: 204 },
      { method: 'POST', path: `${FLAG}/environments/staging/copy`, json: { changedSections: [] } },
    ]);
    const client = await connectClient({ api, org: ORG });
    const o = { reason: 'INC-9', freeze_override: true };
    await client.callTool({ name: 'update_targeting', arguments: { ...where, rules: [], ...o } });
    await client.callTool({ name: 'manage_targeting_rule', arguments: { action: 'reorder', ...where, ruleIds: ['r1'], ...o } });
    await client.callTool({ name: 'update_flag_environment_config', arguments: { ...where, defaultVariationId: 'v1', ...o } });
    await client.callTool({ name: 'copy_flag_config', arguments: { project: 'web', flag: 'checkout', source: 'production', target: 'staging', ...o } });
    expect(calls).toHaveLength(4);
    for (const c of calls) expect(c.headers['X-Freeze-Override'], c.url).toBe('true');
  });

  it('manage_rollout_ramp sends it on start, resume and advance, not on pause or abort', async () => {
    const rule = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
    const { api, calls } = mockApi([
      { method: 'POST', path: `${E}/rules/${rule}/ramp`, status: 201, json: ramp },
      { method: 'POST', path: `${E}/ramps/${RAMP}/resume`, json: ramp },
      { method: 'POST', path: `${E}/ramps/${RAMP}/advance`, json: ramp },
      { method: 'POST', path: `${E}/ramps/${RAMP}/pause`, json: ramp },
      { method: 'POST', path: `${E}/ramps/${RAMP}/abort`, json: ramp },
    ]);
    const client = await connectClient({ api, org: ORG });
    const o = { ...where, reason: 'INC-9', freeze_override: true };
    const steps = [{ percent: 5, holdMinutes: 60 }, { percent: 100, holdMinutes: 0 }];
    await client.callTool({ name: 'manage_rollout_ramp', arguments: { action: 'start', rule, steps, ...o } });
    for (const action of ['resume', 'advance', 'pause', 'abort']) {
      await client.callTool({
        name: 'manage_rollout_ramp',
        arguments: { action, ramp: RAMP, expectedStepIndex: 0, percent: 0, ...o },
      });
    }
    expect(calls.map((c) => c.headers['X-Freeze-Override'])).toEqual(['true', 'true', 'true', undefined, undefined]);
  });
});

describe('freeze_override on segment and variation edits (#5884)', () => {
  const SEG = `/api/v1/orgs/${ORG}/projects/web/segments/beta`;
  const VARS = `${FLAG}/variations`;
  const o = { reason: 'INC-9', freeze_override: true };

  it('manage_segment sends it on update, never on create or delete', async () => {
    const { api, calls } = mockApi([
      { method: 'GET', path: SEG, json: { name: 'Beta', description: null, conditions: [] }, headers: { ETag: '"s1"' } },
      { method: 'PUT', path: SEG, status: 204 },
      { method: 'POST', path: `/api/v1/orgs/${ORG}/projects/web/segments`, status: 201, json: { id: 's2' } },
      { method: 'DELETE', path: SEG, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({ name: 'manage_segment', arguments: { action: 'update', project: 'web', segment: 'beta', name: 'B', ...o } });
    await client.callTool({ name: 'manage_segment', arguments: { action: 'create', project: 'web', key: 'b2', name: 'B2', ...o } });
    await client.callTool({ name: 'manage_segment', arguments: { action: 'delete', project: 'web', segment: 'beta', ...o } });

    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.headers['X-Freeze-Override']).toBe('true');
    expect(put.headers['X-Intent-Reason']).toBe('INC-9');
    for (const c of calls.filter((c) => c.method === 'POST' || c.method === 'DELETE'))
      expect(c.headers['X-Freeze-Override'], `${c.method} ${c.url}`).toBeUndefined();
  });

  it('manage_variation sends it on add, update and remove', async () => {
    const { api, calls } = mockApi([
      { method: 'POST', path: VARS, status: 201, json: { id: 'v3' } },
      { method: 'PUT', path: `${VARS}/v1`, status: 204 },
      { method: 'DELETE', path: `${VARS}/v2`, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });
    const at = { project: 'web', flag: 'checkout', ...o };
    await client.callTool({ name: 'manage_variation', arguments: { action: 'add', key: 'c', value: 'c', ...at } });
    await client.callTool({ name: 'manage_variation', arguments: { action: 'update', variationId: 'v1', value: 'x', ...at } });
    await client.callTool({ name: 'manage_variation', arguments: { action: 'remove', variationId: 'v2', ...at } });

    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c.headers['X-Freeze-Override'], `${c.method} ${c.url}`).toBe('true');
  });

  it('without a reason both are refused before any request', async () => {
    const { api, calls } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    const seg = await client.callTool({
      name: 'manage_segment',
      arguments: { action: 'update', project: 'web', segment: 'beta', name: 'B', freeze_override: true },
    });
    const variation = await client.callTool({
      name: 'manage_variation',
      arguments: { action: 'remove', project: 'web', flag: 'checkout', variationId: 'v2', freeze_override: true },
    });

    expect(seg.isError).toBe(true);
    expect(text(seg)).toContain('freeze_override requires reason');
    expect(variation.isError).toBe(true);
    expect(text(variation)).toContain('freeze_override requires reason');
    expect(calls).toHaveLength(0);
  });
});
