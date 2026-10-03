import { describe, it, expect } from 'vitest';
import { mockApi, connectClient } from './helpers.js';

const ORG = 'acme';
const FLAGS = `/api/v1/orgs/${ORG}/projects/web/flags`;

const OLD = '2026-01-01T00:00:00Z'; // far older than any cutoff
const FRESH = new Date().toISOString();

function flag(key: string, updatedAt: string) {
  return { key, name: key, type: 'Boolean', isArchived: false, updatedAt };
}

describe('find_stale_flags', () => {
  it('flags old fully-on and fully-off flags, skips mixed and fresh ones', async () => {
    const { api } = mockApi([
      {
        method: 'GET',
        path: FLAGS,
        json: {
          items: [flag('old-on', OLD), flag('old-off', OLD), flag('old-mixed', OLD), flag('fresh', FRESH)],
          next_cursor: null,
        },
      },
      {
        method: 'GET',
        path: `${FLAGS}/old-on/environments`,
        json: [{ environmentKey: 'prod', isEnabled: true }, { environmentKey: 'dev', isEnabled: true }],
      },
      {
        method: 'GET',
        path: `${FLAGS}/old-off/environments`,
        json: [{ environmentKey: 'prod', isEnabled: false }, { environmentKey: 'dev', isEnabled: false }],
      },
      {
        method: 'GET',
        path: `${FLAGS}/old-mixed/environments`,
        json: [{ environmentKey: 'prod', isEnabled: true }, { environmentKey: 'dev', isEnabled: false }],
      },
    ]);
    const client = await connectClient({ api, org: ORG });
    const result = await client.callTool({
      name: 'find_stale_flags',
      arguments: { project: 'web', days: 30 },
    });
    expect(result.isError).toBeFalsy();
    const report = JSON.parse((result.content as { text: string }[])[0].text);
    expect(report.stale.map((f: { key: string }) => f.key).sort()).toEqual(['old-off', 'old-on']);
    expect(report.stale.find((f: { key: string }) => f.key === 'old-on').reason).toBe('enabled-everywhere');
    expect(report.stale.find((f: { key: string }) => f.key === 'old-off').reason).toBe('disabled-everywhere');
    expect(report.truncated).toBe(false);
  });
});

describe('find_stale_flags expiry (#2563)', () => {
  const PAST = '2026-01-15T23:59:59Z';
  const FUTURE = '2099-01-01T00:00:00Z';

  async function report(routes: Parameters<typeof mockApi>[0]) {
    const { api } = mockApi(routes);
    const client = await connectClient({ api, org: ORG });
    const result = await client.callTool({ name: 'find_stale_flags', arguments: { project: 'web', days: 30 } });
    expect(result.isError).toBeFalsy();
    return JSON.parse((result.content as { text: string }[])[0].text);
  }

  it('reports an expired flag even when it was edited recently', async () => {
    const r = await report([
      { method: 'GET', path: FLAGS, json: { items: [{ ...flag('expired-fresh', FRESH), expiresAtUtc: PAST }], next_cursor: null } },
      {
        method: 'GET',
        path: `${FLAGS}/expired-fresh/environments`,
        json: [{ environmentKey: 'prod', isEnabled: false }, { environmentKey: 'dev', isEnabled: false }],
      },
    ]);
    expect(r.stale).toEqual([
      expect.objectContaining({ key: 'expired-fresh', reason: 'disabled-everywhere', expired: true, expiresAtUtc: PAST }),
    ]);
  });

  it('keeps an expired flag that is on in some environments and off in others, as past-expiry', async () => {
    const r = await report([
      { method: 'GET', path: FLAGS, json: { items: [{ ...flag('expired-mixed', OLD), expiresAtUtc: PAST }], next_cursor: null } },
      {
        method: 'GET',
        path: `${FLAGS}/expired-mixed/environments`,
        json: [{ environmentKey: 'prod', isEnabled: true }, { environmentKey: 'dev', isEnabled: false }],
      },
    ]);
    expect(r.stale).toEqual([expect.objectContaining({ key: 'expired-mixed', reason: 'past-expiry', expired: true })]);
  });

  it('reports expiry on unexpired flags and tolerates an API that omits the field', async () => {
    const r = await report([
      {
        method: 'GET',
        path: FLAGS,
        json: { items: [{ ...flag('future', OLD), expiresAtUtc: FUTURE }, flag('legacy', OLD)], next_cursor: null },
      },
      { method: 'GET', path: /\/environments$/, json: [{ environmentKey: 'prod', isEnabled: true }] },
    ]);
    const byKey = Object.fromEntries(r.stale.map((f: { key: string }) => [f.key, f]));
    expect(byKey.future).toMatchObject({ expired: false, expiresAtUtc: FUTURE, reason: 'enabled-everywhere' });
    expect(byKey.legacy).toMatchObject({ expired: false, expiresAtUtc: null });
  });

  it('checks expired flags before the candidate cap can drop them', async () => {
    const old = Array.from({ length: 60 }, (_, i) => flag(`old-${i}`, OLD));
    const r = await report([
      // The expired flag is listed LAST, behind more old candidates than the cap allows.
      { method: 'GET', path: FLAGS, json: { items: [...old, { ...flag('expired', FRESH), expiresAtUtc: PAST }], next_cursor: null } },
      { method: 'GET', path: /\/environments$/, json: [{ environmentKey: 'prod', isEnabled: false }] },
    ]);
    expect(r.truncated).toBe(true);
    expect(r.checked).toBe(50);
    expect(r.stale.map((f: { key: string }) => f.key)).toContain('expired');
  });
});

describe('find_stale_flags blockedBy (#3458)', () => {
  const CANDIDATES = `${FLAGS}/removal-candidates`;
  const offEverywhere = { method: 'GET', path: /\/environments$/, json: [{ environmentKey: 'prod', isEnabled: false }] };

  async function call(routes: Parameters<typeof mockApi>[0]) {
    const { api, calls } = mockApi(routes);
    const client = await connectClient({ api, org: ORG });
    const result = await client.callTool({ name: 'find_stale_flags', arguments: { project: 'web', days: 30 } });
    expect(result.isError).toBeFalsy();
    const report = JSON.parse((result.content as { text: string }[])[0].text);
    return { report, calls, byKey: Object.fromEntries(report.stale.map((f: { key: string }) => [f.key, f])) };
  }

  it('reports the live dependents the server names, [] for none, and null for a flag it did not classify', async () => {
    const { byKey, calls } = await call([
      {
        method: 'GET',
        path: FLAGS,
        json: { items: [flag('two-factor-auth', OLD), flag('leaf', OLD), flag('unclassified', OLD)], next_cursor: null },
      },
      offEverywhere,
      {
        method: 'GET',
        path: CANDIDATES,
        json: {
          items: [
            { key: 'two-factor-auth', reason: 'StuckRolledBack', treatment: false, status: 'Dead', blockedBy: ['web-two-factor-auth'] },
            { key: 'leaf', reason: 'StuckRolledBack', treatment: false, status: 'Dead', blockedBy: [] },
          ],
          next_cursor: null,
        },
      },
    ]);
    expect(byKey['two-factor-auth'].blockedBy).toEqual(['web-two-factor-auth']);
    expect(byKey.leaf.blockedBy).toEqual([]);
    expect(byKey.unclassified.blockedBy).toBeNull();
    // Stale tier, so the classification covers every flag the server would call stale, not only dead ones.
    const candidateCall = calls.find((c) => new URL(c.url).pathname === CANDIDATES)!;
    expect(new URL(candidateCall.url).searchParams.get('staleness')).toBe('stale');
  });

  it('follows the removal-candidates cursor', async () => {
    const { byKey } = await call([
      { method: 'GET', path: FLAGS, json: { items: [flag('a', OLD), flag('b', OLD)], next_cursor: null } },
      offEverywhere,
      { method: 'GET', path: CANDIDATES, query: { cursor: null }, json: { items: [{ key: 'a', blockedBy: ['x'] }], next_cursor: 'page2' } },
      { method: 'GET', path: CANDIDATES, query: { cursor: 'page2' }, json: { items: [{ key: 'b', blockedBy: ['y'] }], next_cursor: null } },
    ]);
    expect(byKey.a.blockedBy).toEqual(['x']);
    expect(byKey.b.blockedBy).toEqual(['y']);
  });

  it('reads blockedBy as unknown (null) from an API that predates the field', async () => {
    const { byKey } = await call([
      { method: 'GET', path: FLAGS, json: { items: [flag('legacy', OLD)], next_cursor: null } },
      offEverywhere,
      { method: 'GET', path: CANDIDATES, json: { items: [{ key: 'legacy', reason: 'StuckRolledBack', treatment: false, status: 'Dead' }], next_cursor: null } },
    ]);
    expect(byKey.legacy.blockedBy).toBeNull();
  });

  it('does not ask for removal candidates when nothing is stale', async () => {
    const { calls } = await call([{ method: 'GET', path: FLAGS, json: { items: [flag('fresh', FRESH)], next_cursor: null } }]);
    expect(calls.some((c) => new URL(c.url).pathname === CANDIDATES)).toBe(false);
  });

  it('still returns the stale report, with blockedBy null and a note, when removal-candidates fails', async () => {
    const { report } = await call([
      { method: 'GET', path: FLAGS, json: { items: [flag('old-off', OLD)], next_cursor: null } },
      offEverywhere,
      { method: 'GET', path: CANDIDATES, status: 500, json: { error: 'internal_error', message: 'boom' } },
    ]);
    expect(report.stale).toEqual([expect.objectContaining({ key: 'old-off', blockedBy: null })]);
    expect(report.blockedByNote).toMatch(/removal-candidates/);
  });
});

describe('list_removal_candidates (#3458)', () => {
  const CANDIDATES = `${FLAGS}/removal-candidates`;

  it('passes staleness, limit and cursor through and returns the page as-is', async () => {
    const page = {
      items: [{ key: 'two-factor-auth', reason: 'StuckRolledBack', treatment: false, status: 'Dead', blockedBy: ['web-two-factor-auth'] }],
      next_cursor: 'MjA',
    };
    const { api, calls } = mockApi([{ method: 'GET', path: CANDIDATES, json: page }]);
    const client = await connectClient({ api, org: ORG });
    const result = await client.callTool({
      name: 'list_removal_candidates',
      arguments: { project: 'web', staleness: 'stale', limit: 20, cursor: 'abc' },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual(page);
    const params = new URL(calls[0].url).searchParams;
    expect(params.get('staleness')).toBe('stale');
    expect(params.get('limit')).toBe('20');
    expect(params.get('cursor')).toBe('abc');
  });

  it('defaults to the server\'s dead tier by omitting staleness', async () => {
    const { api, calls } = mockApi([{ method: 'GET', path: CANDIDATES, json: { items: [], next_cursor: null } }]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({ name: 'list_removal_candidates', arguments: { project: 'web' } });
    expect(new URL(calls[0].url).searchParams.has('staleness')).toBe(false);
  });
});

describe('dependents-first guidance (#3458)', () => {
  it('find_stale_flags, list_removal_candidates and archive_flag all say dependents go first', async () => {
    const { api } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    const { tools } = await client.listTools();
    const desc = (name: string) => tools.find((t) => t.name === name)!.description!;
    for (const name of ['find_stale_flags', 'list_removal_candidates', 'archive_flag']) {
      expect(desc(name)).toMatch(/FLAG_HAS_DEPENDENTS/);
      expect(desc(name)).toMatch(/dependents first/i);
    }
  });
});

describe('find_stale_flags owner (#3189)', () => {
  const ALICE = { id: '0197b6a0-5f2a-7c3e-9b4d-1e2f3a4b5c6d', email: 'alice@acme.test', name: 'Alice' };
  const offEverywhere = { method: 'GET', path: /\/environments$/, json: [{ environmentKey: 'prod', isEnabled: false }] };

  async function call(args: Record<string, unknown>, routes: Parameters<typeof mockApi>[0]) {
    const { api, calls } = mockApi(routes);
    const client = await connectClient({ api, org: ORG });
    const result = await client.callTool({ name: 'find_stale_flags', arguments: { project: 'web', ...args } });
    return { result, calls, text: (result.content as { text: string }[])[0].text };
  }

  it('reports each stale flag with its owner, and null for an unowned one', async () => {
    const { result, text } = await call({}, [
      {
        method: 'GET',
        path: FLAGS,
        json: { items: [{ ...flag('owned', OLD), owner: ALICE }, flag('unowned', OLD)], next_cursor: null },
      },
      offEverywhere,
    ]);
    expect(result.isError).toBeFalsy();
    const byKey = Object.fromEntries(JSON.parse(text).stale.map((f: { key: string }) => [f.key, f]));
    expect(byKey.owned.owner).toEqual(ALICE);
    expect(byKey.unowned.owner).toBeNull();
  });

  it('passes an email owner filter to the flag list and echoes it', async () => {
    const { result, calls, text } = await call({ owner: 'alice@acme.test' }, [
      { method: 'GET', path: FLAGS, json: { items: [], next_cursor: null } },
    ]);
    expect(result.isError).toBeFalsy();
    expect(new URL(calls[0].url).searchParams.get('owner')).toBe('alice@acme.test');
    expect(JSON.parse(text).owner).toBe('alice@acme.test');
  });

  it('passes owner "none" through for unowned flags', async () => {
    const { calls } = await call({ owner: 'none' }, [{ method: 'GET', path: FLAGS, json: { items: [], next_cursor: null } }]);
    expect(new URL(calls[0].url).searchParams.get('owner')).toBe('none');
  });

  it('resolves owner "me" to the token user\'s email', async () => {
    const { result, calls, text } = await call({ owner: 'me' }, [
      { method: 'GET', path: '/api/v1/me', json: { type: 'user', id: ALICE.id, name: 'Alice', email: 'alice@acme.test' } },
      { method: 'GET', path: FLAGS, json: { items: [], next_cursor: null } },
    ]);
    expect(result.isError).toBeFalsy();
    const list = calls.find((c) => new URL(c.url).pathname === FLAGS)!;
    expect(new URL(list.url).searchParams.get('owner')).toBe('alice@acme.test');
    expect(JSON.parse(text).owner).toBe('alice@acme.test');
  });

  it('refuses owner "me" for a service token instead of listing every flag', async () => {
    const { result, calls, text } = await call({ owner: 'me' }, [
      { method: 'GET', path: '/api/v1/me', json: { type: 'service_token', id: ALICE.id, name: 'ci', role: 'Admin' } },
      { method: 'GET', path: FLAGS, json: { items: [], next_cursor: null } },
    ]);
    expect(result.isError).toBe(true);
    expect(text).toMatch(/service token/i);
    expect(calls.some((c) => new URL(c.url).pathname === FLAGS)).toBe(false);
  });
});
