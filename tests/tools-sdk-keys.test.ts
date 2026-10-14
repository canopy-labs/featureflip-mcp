import { describe, it, expect } from 'vitest';
import { mockApi, connectClient } from './helpers.js';

const ORG = 'acme';
const KEYS = `/api/v1/orgs/${ORG}/projects/web/environments/production/sdk-keys`;
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

describe('sdk key tools', () => {
  it('list_sdk_keys passes the list through and is read-only', async () => {
    const { api, calls } = mockApi([
      { method: 'GET', path: KEYS, json: { items: [{ id: 'k1', lastFourCharacters: 'ab12' }], next_cursor: null } },
    ]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({
      name: 'list_sdk_keys',
      arguments: { project: 'web', environment: 'production', limit: 5 },
    });
    expect(JSON.parse(text(r)).items[0].lastFourCharacters).toBe('ab12');
    expect(calls[0].url).toContain('limit=5');
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'list_sdk_keys')?.annotations?.readOnlyHint).toBe(true);
  });

  it('create returns the plaintext key once, with a warning', async () => {
    const { api, calls } = mockApi([
      { method: 'POST', path: KEYS, status: 201, json: { id: 'k2', key: 'srv-secret', lastFourCharacters: 'cret', type: 'ServerSide' } },
    ]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({
      name: 'manage_sdk_key',
      arguments: { action: 'create', project: 'web', environment: 'production', name: 'backend', type: 'ServerSide' },
    });
    expect(calls[0].body).toEqual({ name: 'backend', type: 'ServerSide' });
    const out = JSON.parse(text(r));
    expect(out.key).toBe('srv-secret');
    expect(out.warning).toMatch(/only time|not be shown again/i);
  });

  it('keeps the API\'s own warning and adds the never-commit guidance to it', async () => {
    const { api } = mockApi([
      { method: 'POST', path: KEYS, status: 201, json: { id: 'k2', key: 's', warning: 'Store this key now.' } },
    ]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({
      name: 'manage_sdk_key',
      arguments: { action: 'create', project: 'web', environment: 'production', name: 'b', type: 'ClientSide' },
    });
    const warning = JSON.parse(text(r)).warning;
    expect(warning).toContain('Store this key now.');
    expect(warning).toContain('never in source control');
  });

  it('a create whose key comes back null is still a success, not an output-schema error', async () => {
    const { api } = mockApi([{ method: 'POST', path: KEYS, status: 201, json: { id: 'k3', key: null, warning: 'w' } }]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({
      name: 'manage_sdk_key',
      arguments: { action: 'create', project: 'web', environment: 'production', name: 'b', type: 'ServerSide' },
    });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r)).id).toBe('k3');
  });

  it('rejects an unknown key type before calling the API', async () => {
    const { api, calls } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    const call = client.callTool({
      name: 'manage_sdk_key',
      arguments: { action: 'create', project: 'web', environment: 'production', name: 'b', type: 'server' },
    });
    expect(await refused(call)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('rename keeps the description it is not given', async () => {
    const { api, calls } = mockApi([
      { method: 'GET', path: `${KEYS}/k1`, json: { id: 'k1', name: 'old', description: 'kept' } },
      { method: 'PUT', path: `${KEYS}/k1`, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({
      name: 'manage_sdk_key',
      arguments: { action: 'rename', project: 'web', environment: 'production', sdkKey: 'k1', name: 'new' },
    });
    expect(calls[1].body).toEqual({ name: 'new', description: 'kept' });
    expect(JSON.parse(text(r))).toMatchObject({ sdkKey: 'k1', renamed: true, name: 'new' });
    expect(JSON.stringify(JSON.parse(text(r)))).not.toContain('"key"');
  });

  it('revoke POSTs .../revoke', async () => {
    const { api, calls } = mockApi([{ method: 'POST', path: `${KEYS}/k1/revoke`, status: 204 }]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({
      name: 'manage_sdk_key',
      arguments: { action: 'revoke', project: 'web', environment: 'production', sdkKey: 'k1' },
    });
    expect(calls[0].method).toBe('POST');
    expect(JSON.parse(text(r))).toEqual({ revoked: 'k1' });
  });

  it('missing per-action arguments fail without calling the API', async () => {
    const { api, calls } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    const env = { project: 'web', environment: 'production' };
    for (const args of [
      { action: 'create', ...env, type: 'ServerSide' },
      { action: 'create', ...env, name: 'b' },
      { action: 'rename', ...env, name: 'x' },
      { action: 'revoke', ...env },
    ]) {
      const r = await client.callTool({ name: 'manage_sdk_key', arguments: args });
      expect(r.isError, JSON.stringify(args)).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });
});
