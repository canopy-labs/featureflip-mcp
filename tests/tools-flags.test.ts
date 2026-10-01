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

  it('list_flags filters by owner, resolving "me" to the token user\'s email (#3189)', async () => {
    const { api, calls } = mockApi([
      { method: 'GET', path: '/api/v1/me', json: { type: 'user', name: 'Alice', email: 'alice@acme.test' } },
      { method: 'GET', path: FLAGS, json: { items: [], next_cursor: null } },
    ]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({ name: 'list_flags', arguments: { project: 'web', owner: 'none' } });
    await client.callTool({ name: 'list_flags', arguments: { project: 'web', owner: 'me' } });
    const owners = calls
      .filter((c) => new URL(c.url).pathname === FLAGS)
      .map((c) => new URL(c.url).searchParams.get('owner'));
    expect(owners).toEqual(['none', 'alice@acme.test']);
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

    // update_flag reads the flag first to keep the description it was not given (#3220).
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET', 'PUT', 'DELETE', 'POST', 'POST']);
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

  // The public PUT is a full replace: `name` is required and a missing `description` clears it.
  // update_flag advertises both as optional, so it must fill the omitted ones from the current flag.
  describe('update_flag keeps the fields it was not given (#3220)', () => {
    const current = { key: 'checkout-v2', name: 'Checkout V2', description: 'New checkout flow', tags: ['checkout'] };
    const routes = [
      { method: 'GET', path: `${FLAGS}/checkout-v2`, json: current },
      { method: 'PUT', path: `${FLAGS}/checkout-v2`, status: 204 },
    ];

    it('description only: sends the current name', async () => {
      const { api, calls } = mockApi(routes);
      const client = await connectClient({ api, org: ORG });
      const result = await client.callTool({
        name: 'update_flag',
        arguments: { project: 'web', flag: 'checkout-v2', description: 'Reworded' },
      });
      expect(result.isError).toBeFalsy();
      expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
      expect(calls[1].body).toEqual({ name: 'Checkout V2', description: 'Reworded' });
    });

    it('name only: sends the current description instead of clearing it', async () => {
      const { api, calls } = mockApi(routes);
      const client = await connectClient({ api, org: ORG });
      await client.callTool({ name: 'update_flag', arguments: { project: 'web', flag: 'checkout-v2', name: 'Renamed' } });
      expect(calls[1].body).toEqual({ name: 'Renamed', description: 'New checkout flow' });
    });

    it('tags only: fills name and description, passes tags through', async () => {
      const { api, calls } = mockApi(routes);
      const client = await connectClient({ api, org: ORG });
      await client.callTool({ name: 'update_flag', arguments: { project: 'web', flag: 'checkout-v2', tags: ['ui'] } });
      expect(calls[1].body).toEqual({ name: 'Checkout V2', description: 'New checkout flow', tags: ['ui'] });
    });

    it('an empty description still clears it', async () => {
      const { api, calls } = mockApi(routes);
      const client = await connectClient({ api, org: ORG });
      await client.callTool({ name: 'update_flag', arguments: { project: 'web', flag: 'checkout-v2', description: '' } });
      expect(calls[1].body).toEqual({ name: 'Checkout V2', description: '' });
    });

    it('name and description both given: no read', async () => {
      const { api, calls } = mockApi(routes);
      const client = await connectClient({ api, org: ORG });
      await client.callTool({
        name: 'update_flag',
        arguments: { project: 'web', flag: 'checkout-v2', name: 'Renamed', description: 'Reworded' },
      });
      expect(calls.map((c) => c.method)).toEqual(['PUT']);
      expect(calls[0].body).toEqual({ name: 'Renamed', description: 'Reworded' });
    });

    it('a failed read surfaces the error and sends no PUT', async () => {
      const { api, calls } = mockApi([{ method: 'PUT', path: `${FLAGS}/missing`, status: 204 }]);
      const client = await connectClient({ api, org: ORG });
      const result = await client.callTool({
        name: 'update_flag',
        arguments: { project: 'web', flag: 'missing', description: 'x' },
      });
      expect(result.isError).toBe(true);
      expect(calls.map((c) => c.method)).toEqual(['GET']);
    });
  });

  it('archive_flag only sends force when asked (#3043)', async () => {
    const { api, calls } = mockApi([
      { method: 'POST', path: `${FLAGS}/a/archive`, status: 204 },
      { method: 'POST', path: `${FLAGS}/b/archive`, status: 204 },
      { method: 'POST', path: `${FLAGS}/c/archive`, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });

    await client.callTool({ name: 'archive_flag', arguments: { project: 'web', flag: 'a' } });
    await client.callTool({ name: 'archive_flag', arguments: { project: 'web', flag: 'b', force: false } });
    await client.callTool({ name: 'archive_flag', arguments: { project: 'web', flag: 'c', force: true } });

    // force=false must be indistinguishable from omitting it — sending `force=false` would still
    // read as an explicit override to anyone auditing the request log.
    expect(calls[0].url).not.toContain('force');
    expect(calls[1].url).not.toContain('force');
    expect(calls[2].url).toContain('force=true');
  });

  it('create_flag forwards expiresAtUtc', async () => {
    const { api, calls } = mockApi([{ method: 'POST', path: FLAGS, status: 201, json: { key: 'promo' } }]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({
      name: 'create_flag',
      arguments: { project: 'web', key: 'promo', name: 'Promo', type: 'Boolean', expiresAtUtc: '2026-12-31T23:59:59Z' },
    });
    expect(calls[0].body).toMatchObject({ key: 'promo', expiresAtUtc: '2026-12-31T23:59:59Z' });
  });

  it('set_flag_expiry PUTs a date and DELETEs on null (#2563)', async () => {
    const { api, calls } = mockApi([
      // Real controller (PublicFlagsController.SetExpiry/ClearExpiry) returns 204 No Content.
      { method: 'PUT', path: `${FLAGS}/promo/expiry`, status: 204 },
      { method: 'DELETE', path: `${FLAGS}/promo/expiry`, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });

    const set = await client.callTool({
      name: 'set_flag_expiry',
      arguments: { project: 'web', flag: 'promo', expiresAtUtc: '2026-12-31T23:59:59Z' },
    });
    const cleared = await client.callTool({
      name: 'set_flag_expiry',
      arguments: { project: 'web', flag: 'promo', expiresAtUtc: null },
    });

    expect(calls.map((c) => c.method)).toEqual(['PUT', 'DELETE']);
    expect(calls[0].body).toEqual({ expiresAtUtc: '2026-12-31T23:59:59Z' });
    expect(calls[1].body).toBeUndefined();
    expect(JSON.parse((set.content as { text: string }[])[0].text)).toEqual({
      project: 'web',
      flag: 'promo',
      expiresAtUtc: '2026-12-31T23:59:59Z',
    });
    expect(JSON.parse((cleared.content as { text: string }[])[0].text)).toEqual({
      project: 'web',
      flag: 'promo',
      expiresAtUtc: null,
    });
  });

  it('set_flag_expiry surfaces the API refusal', async () => {
    const { api } = mockApi([
      {
        method: 'PUT',
        path: `${FLAGS}/promo/expiry`,
        status: 400,
        json: {
          error: 'validation_failed',
          message: 'One or more validation errors occurred.',
          fields: { expiresAtUtc: ['EXPIRY_IN_PAST: Expiry must be in the future.'] },
        },
      },
    ]);
    const client = await connectClient({ api, org: ORG });
    const result = await client.callTool({
      name: 'set_flag_expiry',
      arguments: { project: 'web', flag: 'promo', expiresAtUtc: '2020-01-01T00:00:00Z' },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toContain('EXPIRY_IN_PAST');
  });

  it('set_flag_expiry is advertised as non-destructive and idempotent', async () => {
    const { api } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'set_flag_expiry');
    expect(tool?.annotations?.destructiveHint).toBe(false);
    expect(tool?.annotations?.idempotentHint).toBe(true);
  });

  it('set_flag_owner PUTs an email, resolves "me", and DELETEs on null or "none"', async () => {
    const { api, calls } = mockApi([
      { method: 'GET', path: '/api/v1/me', json: { type: 'user', name: 'Alice', email: 'alice@acme.test' } },
      // Real controller (PublicFlagsController.SetOwner/ClearOwner) returns 204 No Content.
      { method: 'PUT', path: `${FLAGS}/promo/owner`, status: 204 },
      { method: 'DELETE', path: `${FLAGS}/promo/owner`, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });
    const call = async (owner: string | null) =>
      JSON.parse(
        ((await client.callTool({ name: 'set_flag_owner', arguments: { project: 'web', flag: 'promo', owner } }))
          .content as { text: string }[])[0].text,
      );

    expect(await call('bob@acme.test')).toEqual({ project: 'web', flag: 'promo', owner: 'bob@acme.test' });
    expect(await call('me')).toEqual({ project: 'web', flag: 'promo', owner: 'alice@acme.test' });
    expect(await call(null)).toEqual({ project: 'web', flag: 'promo', owner: null });
    expect(await call('none')).toEqual({ project: 'web', flag: 'promo', owner: null });

    const writes = calls.filter((c) => new URL(c.url).pathname === `${FLAGS}/promo/owner`);
    expect(writes.map((c) => [c.method, c.body])).toEqual([
      ['PUT', { email: 'bob@acme.test' }],
      ['PUT', { email: 'alice@acme.test' }],
      ['DELETE', undefined],
      ['DELETE', undefined],
    ]);
  });

  it('set_flag_owner refuses "me" on a service token instead of clearing the owner', async () => {
    const { api, calls } = mockApi([
      { method: 'GET', path: '/api/v1/me', json: { type: 'service', name: 'ci' } },
    ]);
    const client = await connectClient({ api, org: ORG });
    const result = await client.callTool({
      name: 'set_flag_owner',
      arguments: { project: 'web', flag: 'promo', owner: 'me' },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toContain('personal access token');
    expect(calls.some((c) => c.url.includes('/owner'))).toBe(false);
  });

  it('set_flag_owner surfaces the API refusal', async () => {
    const { api } = mockApi([
      {
        method: 'PUT',
        path: `${FLAGS}/promo/owner`,
        status: 400,
        json: { error: 'bad_request', message: 'PLAN_FEATURE_UNAVAILABLE: Flag owners are available on the Pro plan and above.' },
      },
    ]);
    const client = await connectClient({ api, org: ORG });
    const result = await client.callTool({
      name: 'set_flag_owner',
      arguments: { project: 'web', flag: 'promo', owner: 'bob@acme.test' },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toContain('PLAN_FEATURE_UNAVAILABLE');
  });

  it('set_flag_owner is advertised as non-destructive and idempotent', async () => {
    const { api } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'set_flag_owner');
    expect(tool?.annotations?.destructiveHint).toBe(false);
    expect(tool?.annotations?.idempotentHint).toBe(true);
  });

  it('create_flag forwards ownerEmail', async () => {
    const { api, calls } = mockApi([
      { method: 'POST', path: FLAGS, status: 201, json: { key: 'promo' } },
    ]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({
      name: 'create_flag',
      arguments: { project: 'web', key: 'promo', name: 'Promo', type: 'Boolean', ownerEmail: 'bob@acme.test' },
    });
    expect(calls[0].body).toMatchObject({ key: 'promo', ownerEmail: 'bob@acme.test' });
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
