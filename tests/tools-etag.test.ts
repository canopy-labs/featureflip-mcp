import { describe, it, expect } from 'vitest';
import { mockApi, connectClient } from './helpers.js';

const ORG = 'acme';
const FLAG = `/api/v1/orgs/${ORG}/projects/web/flags/checkout`;
const TARGETING = `${FLAG}/environments/production/targeting`;
const SEGMENT = `/api/v1/orgs/${ORG}/projects/web/segments/beta`;
const text = (r: { content: unknown }) => (r.content as { text: string }[])[0].text;

describe('etag on reads', () => {
  it('get_flag, get_targeting and get_segment add the ETag header as etag', async () => {
    const { api } = mockApi([
      { method: 'GET', path: FLAG, json: { key: 'checkout' }, headers: { ETag: '"f1"' } },
      { method: 'GET', path: TARGETING, json: { rules: [] }, headers: { ETag: '"t1"' } },
      { method: 'GET', path: SEGMENT, json: { key: 'beta' }, headers: { ETag: '"s1"' } },
    ]);
    const client = await connectClient({ api, org: ORG });
    const flag = await client.callTool({ name: 'get_flag', arguments: { project: 'web', flag: 'checkout' } });
    const tgt = await client.callTool({
      name: 'get_targeting',
      arguments: { project: 'web', flag: 'checkout', environment: 'production' },
    });
    const seg = await client.callTool({ name: 'get_segment', arguments: { project: 'web', segment: 'beta' } });
    expect(JSON.parse(text(flag)).etag).toBe('"f1"');
    expect(JSON.parse(text(tgt)).etag).toBe('"t1"');
    expect(JSON.parse(text(seg)).etag).toBe('"s1"');
    expect((flag.structuredContent as { etag: string }).etag).toBe('"f1"');
  });

  it('omits etag when the API sent none', async () => {
    const { api } = mockApi([{ method: 'GET', path: FLAG, json: { key: 'checkout' } }]);
    const client = await connectClient({ api, org: ORG });
    const flag = await client.callTool({ name: 'get_flag', arguments: { project: 'web', flag: 'checkout' } });
    expect(flag.isError).toBeFalsy();
    expect('etag' in JSON.parse(text(flag))).toBe(false);
  });
});

describe('If-Match on writes', () => {
  it('update_flag forwards the ETag of its own GET when it has to read', async () => {
    const { api, calls } = mockApi([
      { method: 'GET', path: FLAG, json: { name: 'Checkout', description: 'd' }, headers: { ETag: '"f1"' } },
      { method: 'PUT', path: FLAG, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({ name: 'update_flag', arguments: { project: 'web', flag: 'checkout', name: 'New' } });
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.headers['If-Match']).toBe('"f1"');
  });

  it("update_flag prefers the agent's ifMatch over the ETag it read", async () => {
    const { api, calls } = mockApi([
      { method: 'GET', path: FLAG, json: { name: 'Checkout', description: 'd' }, headers: { ETag: '"f2"' } },
      { method: 'PUT', path: FLAG, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({
      name: 'update_flag',
      arguments: { project: 'web', flag: 'checkout', name: 'New', ifMatch: '"f1"' },
    });
    expect(calls.find((c) => c.method === 'PUT')!.headers['If-Match']).toBe('"f1"');
  });

  it('update_flag with name and description makes no GET and sends ifMatch as given', async () => {
    const { api, calls } = mockApi([{ method: 'PUT', path: FLAG, status: 204 }]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({
      name: 'update_flag',
      arguments: { project: 'web', flag: 'checkout', name: 'N', description: 'D', ifMatch: '"f1"' },
    });
    expect(calls.map((c) => c.method)).toEqual(['PUT']);
    expect(calls[0].headers['If-Match']).toBe('"f1"');
  });

  it('update_targeting sends ifMatch, and a 412 comes back as a re-read hint', async () => {
    const { api, calls } = mockApi([
      { method: 'PUT', path: TARGETING, status: 412, json: { error: 'precondition_failed', message: 'stale' } },
    ]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({
      name: 'update_targeting',
      arguments: { project: 'web', flag: 'checkout', environment: 'production', rules: [], ifMatch: '"t1"' },
    });
    expect(calls[0].headers['If-Match']).toBe('"t1"');
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('changed since it was read');
  });

  it('manage_webhook update forwards the ETag of its own GET', async () => {
    const HOOK = `/api/v1/orgs/${ORG}/webhooks/11111111-1111-1111-1111-111111111111`;
    const { api, calls } = mockApi([
      {
        method: 'GET',
        path: HOOK,
        json: { name: 'h', url: 'https://x.test', eventTypes: [], projectIds: [], environmentIds: [], isEnabled: true },
        headers: { ETag: '"w1"' },
      },
      { method: 'PUT', path: HOOK, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({
      name: 'manage_webhook',
      arguments: { action: 'update', id: '11111111-1111-1111-1111-111111111111', name: 'renamed' },
    });
    expect(calls.find((c) => c.method === 'PUT')!.headers['If-Match']).toBe('"w1"');
  });
});
