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
