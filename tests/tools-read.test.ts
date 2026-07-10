import { describe, it, expect } from 'vitest';
import { mockApi, connectClient } from './helpers.js';

const ORG = 'acme';

describe('read-only tools', () => {
  it('list_projects hits /api/v1/orgs/{org}/projects and returns JSON text', async () => {
    const { api, calls } = mockApi([
      {
        method: 'GET',
        path: `/api/v1/orgs/${ORG}/projects`,
        json: { items: [{ key: 'web', name: 'Web' }], next_cursor: null },
      },
    ]);
    const client = await connectClient({ api, org: ORG });

    const result = await client.callTool({ name: 'list_projects', arguments: { limit: 10 } });

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse((result.content as { text: string }[])[0].text);
    expect(payload.items[0].key).toBe('web');
    expect(calls[0].url).toContain('limit=10');
  });

  it('list_environments scopes to the project', async () => {
    const { api, calls } = mockApi([
      {
        method: 'GET',
        path: `/api/v1/orgs/${ORG}/projects/web/environments`,
        json: { items: [{ key: 'production', name: 'Production' }], next_cursor: null },
      },
    ]);
    const client = await connectClient({ api, org: ORG });
    const result = await client.callTool({ name: 'list_environments', arguments: { project: 'web' } });
    expect(result.isError).toBeFalsy();
    expect(calls[0].url).toContain('/projects/web/environments');
  });

  it('list_segments and get_segment are registered and read-only', async () => {
    const { api } = mockApi([
      { method: 'GET', path: `/api/v1/orgs/${ORG}/projects/web/segments`, json: { items: [], next_cursor: null } },
      { method: 'GET', path: `/api/v1/orgs/${ORG}/projects/web/segments/beta-users`, json: { key: 'beta-users' } },
    ]);
    const client = await connectClient({ api, org: ORG });
    const list = await client.callTool({ name: 'list_segments', arguments: { project: 'web' } });
    expect(list.isError).toBeFalsy();
    const one = await client.callTool({ name: 'get_segment', arguments: { project: 'web', segment: 'beta-users' } });
    expect(JSON.parse((one.content as { text: string }[])[0].text).key).toBe('beta-users');
  });

  it('API errors surface as isError results with envelope details', async () => {
    const { api } = mockApi([]); // every call 404s
    const client = await connectClient({ api, org: ORG });
    const result = await client.callTool({ name: 'list_projects', arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toContain('not_found');
  });

  it('read tools carry readOnlyHint annotations', async () => {
    const { api } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    const { tools } = await client.listTools();
    const listProjects = tools.find((t) => t.name === 'list_projects');
    expect(listProjects?.annotations?.readOnlyHint).toBe(true);
    expect(listProjects?.title).toBe('List projects');
  });
});
