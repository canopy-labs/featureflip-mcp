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
