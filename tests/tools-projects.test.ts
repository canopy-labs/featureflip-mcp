import { describe, it, expect } from 'vitest';
import { mockApi, connectClient } from './helpers.js';

const ORG = 'acme';
const PROJECTS = `/api/v1/orgs/${ORG}/projects`;
const LIFETIME = `${PROJECTS}/web/default-flag-lifetime`;
const text = (r: { content: unknown }) => (r.content as { text: string }[])[0].text;
// The SDK may report a schema-invalid argument as an isError result or as a rejected call;
// either is fine, as long as no API request is made.
const refused = async (p: Promise<{ isError?: unknown }>) => {
  try {
    return (await p).isError === true;
  } catch {
    return true;
  }
};

describe('set_default_flag_lifetime', () => {
  it('reads the impact, then PUTs days, and reports both', async () => {
    const { api, calls } = mockApi([
      { method: 'GET', path: `${LIFETIME}/impact`, query: { days: '90' }, json: { newlyPastExpiry: 4, noLongerPastExpiry: 0 } },
      { method: 'PUT', path: LIFETIME, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({ name: 'set_default_flag_lifetime', arguments: { project: 'web', days: 90 } });
    expect(r.isError).toBeFalsy();
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    expect(calls[1].body).toEqual({ days: 90 });
    expect(JSON.parse(text(r))).toEqual({
      project: 'web', defaultFlagLifetimeDays: 90, applied: true, newlyPastExpiry: 4, noLongerPastExpiry: 0,
    });
  });

  it('removal sends {"days": null}, never {}', async () => {
    const { api, calls } = mockApi([
      { method: 'GET', path: `${LIFETIME}/impact`, query: { days: null }, json: { newlyPastExpiry: 0, noLongerPastExpiry: 2 } },
      { method: 'PUT', path: LIFETIME, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({ name: 'set_default_flag_lifetime', arguments: { project: 'web', days: null } });
    expect(calls[1].body).toEqual({ days: null });
    expect(JSON.stringify(calls[1].body)).toBe('{"days":null}');
  });

  it('preview of a removal reads the impact with no days parameter and writes nothing', async () => {
    const { api, calls } = mockApi([
      { method: 'GET', path: `${LIFETIME}/impact`, query: { days: null }, json: { newlyPastExpiry: 0, noLongerPastExpiry: 2 } },
    ]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({
      name: 'set_default_flag_lifetime',
      arguments: { project: 'web', days: null, preview: true },
    });
    expect(calls.map((c) => c.method)).toEqual(['GET']);
    expect(new URL(calls[0].url).searchParams.has('days')).toBe(false);
    expect(JSON.parse(text(r))).toMatchObject({ applied: false, noLongerPastExpiry: 2, defaultFlagLifetimeDays: null });
  });

  it('rejects days outside 1–3650 before calling the API', async () => {
    const { api, calls } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    expect(await refused(client.callTool({ name: 'set_default_flag_lifetime', arguments: { project: 'web', days: 0 } }))).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('manage_project', () => {
  it('create POSTs key/name/description and passes the 201 body through', async () => {
    const { api, calls } = mockApi([
      { method: 'POST', path: PROJECTS, status: 201, json: { id: 'p1', key: 'mobile', name: 'Mobile' } },
    ]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({
      name: 'manage_project',
      arguments: { action: 'create', key: 'mobile', name: 'Mobile', description: 'apps' },
    });
    expect(calls[0].body).toEqual({ key: 'mobile', name: 'Mobile', description: 'apps' });
    expect(JSON.parse(text(r)).id).toBe('p1');
  });

  it('update keeps omitted fields from the current project', async () => {
    const { api, calls } = mockApi([
      { method: 'GET', path: `${PROJECTS}/web`, json: { key: 'web', name: 'Web', description: 'site' } },
      { method: 'PUT', path: `${PROJECTS}/web`, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({ name: 'manage_project', arguments: { action: 'update', project: 'web', name: 'Website' } });
    expect(calls[1].body).toEqual({ name: 'Website', description: 'site' });
    expect(JSON.parse(text(r))).toMatchObject({ project: 'web', updated: true, name: 'Website' });
  });

  it('missing per-action arguments fail without calling the API', async () => {
    const { api, calls } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    const a = await client.callTool({ name: 'manage_project', arguments: { action: 'create', name: 'X' } });
    const b = await client.callTool({ name: 'manage_project', arguments: { action: 'update', name: 'X' } });
    expect(a.isError).toBe(true);
    expect(b.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
