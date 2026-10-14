import { describe, it, expect } from 'vitest';
import { mockApi, connectClient } from './helpers.js';

const ORG = 'acme';
const ENVS = `/api/v1/orgs/${ORG}/projects/web/environments`;
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

describe('manage_environment', () => {
  it('create POSTs the environment and passes the 201 body through', async () => {
    const { api, calls } = mockApi([{ method: 'POST', path: ENVS, status: 201, json: { id: 'e1', key: 'staging' } }]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({
      name: 'manage_environment',
      arguments: { action: 'create', project: 'web', key: 'staging', name: 'Staging', color: '#ffaa00', sortOrder: 2 },
    });
    expect(calls[0].body).toEqual({ key: 'staging', name: 'Staging', color: '#ffaa00', sortOrder: 2 });
    expect(JSON.parse(text(r)).id).toBe('e1');
  });

  it('update merges the current environment and sends its ETag', async () => {
    const { api, calls } = mockApi([
      { method: 'GET', path: `${ENVS}/staging`, json: { key: 'staging', name: 'Staging', color: '#ffaa00', sortOrder: 2 }, headers: { ETag: '"e1"' } },
      { method: 'PUT', path: `${ENVS}/staging`, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({
      name: 'manage_environment',
      arguments: { action: 'update', project: 'web', environment: 'staging', sortOrder: 0 },
    });
    expect(calls[1].body).toEqual({ name: 'Staging', color: '#ffaa00', sortOrder: 0 });
    expect(calls[1].headers['If-Match']).toBe('"e1"');
    expect(JSON.parse(text(r))).toMatchObject({ environment: 'staging', updated: true, sortOrder: 0 });
  });

  it('has no delete action', async () => {
    const { api, calls } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    const call = client.callTool({ name: 'manage_environment', arguments: { action: 'delete', project: 'web', environment: 'staging' } });
    expect(await refused(call)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('missing per-action arguments fail without calling the API', async () => {
    const { api, calls } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    for (const args of [
      { action: 'create', project: 'web', name: 'S' },
      { action: 'create', project: 'web', key: 's' },
      { action: 'update', project: 'web', name: 'S' },
    ]) {
      expect((await client.callTool({ name: 'manage_environment', arguments: args })).isError, JSON.stringify(args)).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });
});
