import { describe, it, expect } from 'vitest';
import { mockApi, connectClient } from './helpers.js';

const ORG = 'acme';
const FLAGS = `/api/v1/orgs/${ORG}/projects/web/flags`;

describe('flag CRUD tools', () => {
  it('list_flags forwards filters', async () => {
    const { api, calls } = mockApi([
      { method: 'GET', path: FLAGS, json: { items: [], next_cursor: null } },
    ]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({
      name: 'list_flags',
      arguments: { project: 'web', search: 'checkout', archived: false, tag: 'ui' },
    });
    expect(calls[0].url).toContain('search=checkout');
    expect(calls[0].url).toContain('archived=false');
    expect(calls[0].url).toContain('tag=ui');
  });

  it('create_flag POSTs body and passes idempotency key', async () => {
    const { api, calls } = mockApi([
      { method: 'POST', path: FLAGS, status: 201, json: { key: 'checkout-v2' } },
    ]);
    const client = await connectClient({ api, org: ORG });
    const result = await client.callTool({
      name: 'create_flag',
      arguments: {
        project: 'web',
        key: 'checkout-v2',
        name: 'Checkout V2',
        type: 'Boolean',
        description: 'New checkout flow',
        tags: ['checkout'],
        idempotency_key: 'idem-42',
      },
    });
    expect(result.isError).toBeFalsy();
    expect(calls[0].body).toMatchObject({ key: 'checkout-v2', name: 'Checkout V2', type: 'Boolean' });
  });

  it('get_flag / update_flag / delete_flag / archive_flag / restore_flag hit their endpoints', async () => {
    const { api, calls } = mockApi([
      { method: 'GET', path: `${FLAGS}/checkout-v2`, json: { key: 'checkout-v2' } },
      // Real controller (FeatureFlagsController.Update) returns 204 No Content.
      { method: 'PUT', path: `${FLAGS}/checkout-v2`, status: 204 },
      { method: 'DELETE', path: `${FLAGS}/old-flag`, status: 204 },
      // Real controller (FeatureFlagsController.Archive/Restore) returns 204 No Content.
      { method: 'POST', path: `${FLAGS}/tired/archive`, status: 204 },
      { method: 'POST', path: `${FLAGS}/tired/restore`, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });

    await client.callTool({ name: 'get_flag', arguments: { project: 'web', flag: 'checkout-v2' } });
    const updated = await client.callTool({
      name: 'update_flag',
      arguments: { project: 'web', flag: 'checkout-v2', name: 'Renamed' },
    });
    const del = await client.callTool({ name: 'delete_flag', arguments: { project: 'web', flag: 'old-flag' } });
    const archived = await client.callTool({ name: 'archive_flag', arguments: { project: 'web', flag: 'tired' } });
    const restored = await client.callTool({ name: 'restore_flag', arguments: { project: 'web', flag: 'tired' } });

    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT', 'DELETE', 'POST', 'POST']);
    expect(updated.isError).toBeFalsy();
    expect(JSON.parse((updated.content as { text: string }[])[0].text)).toEqual({
      project: 'web',
      flag: 'checkout-v2',
      updated: true,
    });
    expect(del.isError).toBeFalsy();
    expect((del.content as { text: string }[])[0].text).toContain('deleted');
    expect(archived.isError).toBeFalsy();
    expect(JSON.parse((archived.content as { text: string }[])[0].text)).toEqual({ flag: 'tired', archived: true });
    expect(restored.isError).toBeFalsy();
    expect(JSON.parse((restored.content as { text: string }[])[0].text)).toEqual({ flag: 'tired', archived: false });
  });

  it('destructive tools carry destructiveHint', async () => {
    const { api } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    const { tools } = await client.listTools();
    for (const name of ['delete_flag', 'archive_flag']) {
      expect(tools.find((t) => t.name === name)?.annotations?.destructiveHint, name).toBe(true);
    }
    expect(tools.find((t) => t.name === 'get_flag')?.annotations?.readOnlyHint).toBe(true);
  });
});
