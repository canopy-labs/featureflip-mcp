import { describe, it, expect } from 'vitest';
import { mockApi, connectClient } from './helpers.js';

const ORG = 'acme';
const TRIGGERS = `/api/v1/orgs/${ORG}/projects/web/flags/checkout/environments/production/triggers`;
const ID = '0b6f1c1e-6a39-4d55-9f3e-1f0f2b3c4d5e';
const text = (r: { content: unknown }) => (r.content as { text: string }[])[0].text;
const where = { project: 'web', flag: 'checkout', environment: 'production' };
// The SDK may report a schema-invalid argument as an isError result or as a rejected call;
// either is fine, as long as no API request is made.
const refused = async (p: Promise<{ isError?: unknown }>) => {
  try {
    return (await p).isError === true;
  } catch {
    return true;
  }
};

const trigger = (overrides: Record<string, unknown> = {}) => ({
  id: ID,
  name: 'Grafana: checkout errors',
  description: 'kept',
  action: 'Disable',
  enabled: true,
  secretLastFour: 'ab12',
  createdAt: '2026-11-06T00:00:00Z',
  updatedAt: '2026-11-06T00:00:00Z',
  lastFiredAt: null,
  ...overrides,
});

const withUrl = (secret: string) => ({
  trigger: trigger(),
  url: `https://api.test/api/triggers/${secret}`,
  endpoint: 'https://api.test/api/triggers',
  secret,
  warning: 'Store this as a secret.',
});

describe('flag trigger tools', () => {
  it('list_flag_triggers passes the list through and is read-only', async () => {
    const { api, calls } = mockApi([{ method: 'GET', path: TRIGGERS, json: { items: [trigger()], next_cursor: null } }]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({ name: 'list_flag_triggers', arguments: { ...where, limit: 5 } });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r)).items[0].secretLastFour).toBe('ab12');
    expect(calls[0].url).toContain('limit=5');
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'list_flag_triggers')?.annotations?.readOnlyHint).toBe(true);
  });

  it('create sends the trigger action as action and returns the URL once, with a warning', async () => {
    const { api, calls } = mockApi([{ method: 'POST', path: TRIGGERS, status: 201, json: withUrl('fft_new') }]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({
      name: 'manage_flag_trigger',
      arguments: {
        action: 'create', ...where, name: 'Grafana: checkout errors', triggerAction: 'Disable',
        reason: 'kill switch for INC-12', idempotency_key: 'k-1',
      },
    });
    expect(r.isError).toBeFalsy();
    expect(calls[0].body).toEqual({ name: 'Grafana: checkout errors', action: 'Disable' });
    expect(calls[0].headers['Idempotency-Key']).toBe('k-1');
    expect(calls[0].headers['X-Intent-Reason']).toBe(encodeURIComponent('kill switch for INC-12'));
    const out = JSON.parse(text(r));
    expect(out.url).toBe('https://api.test/api/triggers/fft_new');
    expect(out.secret).toBe('fft_new');
    expect(out.warning).toContain('Store this as a secret.');
    expect(out.warning).toContain('Never write it to source control');
  });

  it('create without a name or trigger action makes no request', async () => {
    const { api, calls } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({ name: 'manage_flag_trigger', arguments: { action: 'create', ...where, name: 'x' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('triggerAction');
    expect(calls).toHaveLength(0);
  });

  it('rejects an unknown trigger action before calling the API', async () => {
    const { api, calls } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    const call = client.callTool({
      name: 'manage_flag_trigger',
      arguments: { action: 'create', ...where, name: 'x', triggerAction: 'off' },
    });
    expect(await refused(call)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it.each(['update', 'rotate', 'delete'])('%s without a trigger id makes no request', async (action) => {
    const { api, calls } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({ name: 'manage_flag_trigger', arguments: { action, ...where } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('list_flag_triggers');
    expect(calls).toHaveLength(0);
  });

  it('update keeps the fields it is not given, so disabling does not rename', async () => {
    const { api, calls } = mockApi([
      { method: 'GET', path: `${TRIGGERS}/${ID}`, json: trigger() },
      { method: 'PUT', path: `${TRIGGERS}/${ID}`, json: trigger({ enabled: false }) },
    ]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({
      name: 'manage_flag_trigger',
      arguments: { action: 'update', ...where, trigger: ID, enabled: false },
    });
    expect(r.isError).toBeFalsy();
    expect(calls[1].body).toEqual({ name: 'Grafana: checkout errors', description: 'kept', enabled: false });
    expect(JSON.parse(text(r)).enabled).toBe(false);
  });

  it('update sends enabled even when only the name changes, since the API refuses a PUT without it', async () => {
    const { api, calls } = mockApi([
      { method: 'GET', path: `${TRIGGERS}/${ID}`, json: trigger({ enabled: false }) },
      { method: 'PUT', path: `${TRIGGERS}/${ID}`, json: trigger({ name: 'renamed', enabled: false }) },
    ]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({ name: 'manage_flag_trigger', arguments: { action: 'update', ...where, trigger: ID, name: 'renamed' } });
    expect(calls[1].body).toEqual({ name: 'renamed', description: 'kept', enabled: false });
  });

  it('rotate returns the new URL with the warning and carries the reason', async () => {
    const { api, calls } = mockApi([{ method: 'POST', path: `${TRIGGERS}/${ID}/rotate`, json: withUrl('fft_rotated') }]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({
      name: 'manage_flag_trigger',
      arguments: { action: 'rotate', ...where, trigger: ID, reason: 'URL leaked' },
    });
    expect(r.isError).toBeFalsy();
    expect(calls[0].headers['X-Intent-Reason']).toBe(encodeURIComponent('URL leaked'));
    const out = JSON.parse(text(r));
    expect(out.secret).toBe('fft_rotated');
    expect(out.warning).toContain('rotate it');
  });

  it('delete confirms what it deleted', async () => {
    const { api, calls } = mockApi([{ method: 'DELETE', path: `${TRIGGERS}/${ID}`, status: 204 }]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({ name: 'manage_flag_trigger', arguments: { action: 'delete', ...where, trigger: ID } });
    expect(r.isError).toBeFalsy();
    expect(calls[0].method).toBe('DELETE');
    expect(JSON.parse(text(r))).toEqual({ deleted: ID });
  });

  // The envelope FlagTriggerAccess.EnsurePlanAsync produces on /api/v1: a BadRequestException, so a 400
  // bad_request whose message starts with the code.
  const PLAN_REFUSAL = {
    status: 400,
    json: { error: 'bad_request', message: 'PLAN_FEATURE_UNAVAILABLE: Flag triggers are available on the Team plan and above.' },
  };

  it('explains PLAN_FEATURE_UNAVAILABLE: what a lower plan can and cannot still do', async () => {
    const { api } = mockApi([{ method: 'POST', path: TRIGGERS, ...PLAN_REFUSAL }]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({
      name: 'manage_flag_trigger',
      arguments: { action: 'create', ...where, name: 'x', triggerAction: 'Disable' },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('PLAN_FEATURE_UNAVAILABLE');
    expect(text(r)).toMatch(/Team plan or above/);
    expect(text(r)).toMatch(/still list, rename, disable and delete/);
  });

  it('re-enabling on a lower plan gets the same hint', async () => {
    const { api } = mockApi([
      { method: 'GET', path: `${TRIGGERS}/${ID}`, json: trigger({ enabled: false }) },
      { method: 'PUT', path: `${TRIGGERS}/${ID}`, ...PLAN_REFUSAL },
    ]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({ name: 'manage_flag_trigger', arguments: { action: 'update', ...where, trigger: ID, enabled: true } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Team plan or above/);
  });

  it('explains FEATURE_NOT_ENABLED, which arrives as a validation_failed field error', async () => {
    // FlagTriggerAccess.EnsureFeatureEnabled throws ValidationException(string): the public API replaces
    // the message with a generic one and the code survives only in fields.
    const { api } = mockApi([
      {
        method: 'POST',
        path: TRIGGERS,
        status: 400,
        json: {
          error: 'validation_failed',
          message: 'One or more fields are invalid.',
          fields: { validation: ['FEATURE_NOT_ENABLED: flag triggers are not enabled.'] },
        },
      },
    ]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({
      name: 'manage_flag_trigger',
      arguments: { action: 'create', ...where, name: 'x', triggerAction: 'Enable' },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not enabled for this organization yet/);
  });

  it('leaves unrelated errors without a trigger hint', async () => {
    const { api } = mockApi([
      { method: 'GET', path: TRIGGERS, status: 401, json: { error: 'unauthorized', message: 'Token expired.' } },
    ]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({ name: 'list_flag_triggers', arguments: where });
    expect(r.isError).toBe(true);
    expect(text(r)).not.toMatch(/Team plan|not enabled for this organization/);
  });

  it('list_flag_triggers with a trigger id gets that one trigger', async () => {
    const { api, calls } = mockApi([{ method: 'GET', path: `${TRIGGERS}/${ID}`, json: trigger() }]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({ name: 'list_flag_triggers', arguments: { ...where, trigger: ID } });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r)).id).toBe(ID);
    expect(calls).toHaveLength(1);
  });

  it('a trigger that is not an id is refused before the API turns it into a misleading 404', async () => {
    const { api, calls } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    for (const args of [
      { name: 'list_flag_triggers', arguments: { ...where, trigger: 'Grafana: checkout errors' } },
      { name: 'manage_flag_trigger', arguments: { action: 'delete', ...where, trigger: 'Grafana: checkout errors' } },
    ]) {
      const r = await client.callTool(args);
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('triggers have no key');
    }
    expect(calls).toHaveLength(0);
  });

  it('update with nothing to change makes no request', async () => {
    const { api, calls } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({ name: 'manage_flag_trigger', arguments: { action: 'update', ...where, trigger: ID } });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('update with "" clears the description', async () => {
    const { api, calls } = mockApi([
      { method: 'GET', path: `${TRIGGERS}/${ID}`, json: trigger() },
      { method: 'PUT', path: `${TRIGGERS}/${ID}`, json: trigger({ description: null }) },
    ]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({ name: 'manage_flag_trigger', arguments: { action: 'update', ...where, trigger: ID, description: '' } });
    expect(calls[1].body).toEqual({ name: 'Grafana: checkout errors', description: null, enabled: true });
  });

  it('update output carries no secret or URL', async () => {
    const { api } = mockApi([
      { method: 'GET', path: `${TRIGGERS}/${ID}`, json: trigger() },
      { method: 'PUT', path: `${TRIGGERS}/${ID}`, json: trigger({ name: 'renamed' }) },
    ]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({ name: 'manage_flag_trigger', arguments: { action: 'update', ...where, trigger: ID, name: 'renamed' } });
    expect(text(r)).not.toContain('"secret"');
    expect(text(r)).not.toContain('"url"');
  });

  it('rotate warns that the old URL is already dead', async () => {
    const { api } = mockApi([{ method: 'POST', path: `${TRIGGERS}/${ID}/rotate`, json: withUrl('fft_rotated') }]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({ name: 'manage_flag_trigger', arguments: { action: 'rotate', ...where, trigger: ID } });
    expect(JSON.parse(text(r)).warning).toMatch(/old URL stopped working/);
  });
});
