import { describe, it, expect } from 'vitest';
import { mockApi, connectClient } from './helpers.js';

const ORG = 'acme';
const SEGMENTS = `/api/v1/orgs/${ORG}/projects/web/segments`;
const text = (r: { content: unknown }) => (r.content as { text: string }[])[0].text;
const cond = { attribute: 'plan', operator: 'Equals', values: ['pro'], negate: false };

describe('manage_segment', () => {
  it('create POSTs the segment and passes the 201 body through', async () => {
    const { api, calls } = mockApi([{ method: 'POST', path: SEGMENTS, status: 201, json: { id: 's1', key: 'pro' } }]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({
      name: 'manage_segment',
      arguments: { action: 'create', project: 'web', key: 'pro', name: 'Pro', conditions: [cond] },
    });
    expect(calls[0].body).toEqual({ key: 'pro', name: 'Pro', conditions: [cond] });
    expect(JSON.parse(text(r)).id).toBe('s1');
  });

  it('update merges the current segment, strips response-only fields, and sends its ETag', async () => {
    const { api, calls } = mockApi([
      {
        method: 'GET',
        path: `${SEGMENTS}/pro`,
        json: { id: 's1', key: 'pro', name: 'Pro', description: 'paying', conditions: [{ ...cond, id: 'c1' }], _actions: {} },
        headers: { ETag: '"s1"' },
      },
      { method: 'PUT', path: `${SEGMENTS}/pro`, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({ name: 'manage_segment', arguments: { action: 'update', project: 'web', segment: 'pro', name: 'Pro+' } });
    const put = calls[1];
    expect(put.body).toEqual({ name: 'Pro+', description: 'paying', conditions: [cond] });
    expect(put.headers['If-Match']).toBe('"s1"');
  });

  it('description "" clears it rather than keeping the current one', async () => {
    const { api, calls } = mockApi([
      { method: 'GET', path: `${SEGMENTS}/pro`, json: { name: 'Pro', description: 'paying', conditions: [] } },
      { method: 'PUT', path: `${SEGMENTS}/pro`, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({ name: 'manage_segment', arguments: { action: 'update', project: 'web', segment: 'pro', description: '' } });
    expect((calls[1].body as { description: string }).description).toBe('');
  });

  it("update prefers the agent's ifMatch", async () => {
    const { api, calls } = mockApi([
      { method: 'GET', path: `${SEGMENTS}/pro`, json: { name: 'Pro', conditions: [] }, headers: { ETag: '"new"' } },
      { method: 'PUT', path: `${SEGMENTS}/pro`, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({
      name: 'manage_segment',
      arguments: { action: 'update', project: 'web', segment: 'pro', name: 'X', ifMatch: '"old"' },
    });
    expect(calls[1].headers['If-Match']).toBe('"old"');
  });

  it('delete DELETEs the segment', async () => {
    const { api, calls } = mockApi([{ method: 'DELETE', path: `${SEGMENTS}/pro`, status: 204 }]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({ name: 'manage_segment', arguments: { action: 'delete', project: 'web', segment: 'pro' } });
    expect(calls[0].method).toBe('DELETE');
    expect(JSON.parse(text(r))).toEqual({ deleted: 'pro' });
  });

  it('create without conditions sends an empty list, which the API requires', async () => {
    const { api, calls } = mockApi([{ method: 'POST', path: SEGMENTS, status: 201, json: { id: 's1', key: 'pro' } }]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({ name: 'manage_segment', arguments: { action: 'create', project: 'web', key: 'pro', name: 'Pro' } });
    expect((calls[0].body as { conditions: unknown }).conditions).toEqual([]);
  });

  // The API refuses If-Match on DELETE/POST, so the tool cannot honour it there. Sending the
  // write without it would silently drop the precondition the agent asked for (#3808).
  it.each(['delete', 'create'])('%s with ifMatch is refused without calling the API', async (action) => {
    const { api, calls } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({
      name: 'manage_segment',
      arguments: { action, project: 'web', segment: 'pro', key: 'pro', name: 'Pro', ifMatch: '"s1"' },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('ifMatch');
    expect(calls).toHaveLength(0);
  });

  it('missing per-action arguments fail without calling the API', async () => {
    const { api, calls } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    for (const args of [
      { action: 'create', project: 'web', name: 'Pro' },
      { action: 'create', project: 'web', key: 'pro' },
      { action: 'update', project: 'web', name: 'X' },
      { action: 'delete', project: 'web' },
    ]) {
      expect((await client.callTool({ name: 'manage_segment', arguments: args })).isError, JSON.stringify(args)).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('manage_segment schema', () => {
  it('describes every condition operator the API accepts', async () => {
    const { api } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    const { tools } = await client.listTools();
    const schema = JSON.stringify(tools.find((t) => t.name === 'manage_segment')?.inputSchema);
    for (const op of ['NotIn', 'MatchesRegex', 'StartsWith', 'EndsWith', 'Before', 'After', 'SemverLessThanOrEqual']) {
      expect(schema, op).toContain(op);
    }
  });
});
