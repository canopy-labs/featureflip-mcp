import { describe, it, expect } from 'vitest';
import { mockApi, connectClient } from './helpers.js';

const ORG = 'acme';
const RULES = `/api/v1/orgs/${ORG}/projects/web/flags/checkout/environments/production/rules`;
const at = { project: 'web', flag: 'checkout', environment: 'production' };
const text = (r: { content: unknown }) => (r.content as { text: string }[])[0].text;
const group = { operator: 'And', conditions: [{ attribute: 'plan', operator: 'Equals', values: ['pro'], negate: false }] };

describe('manage_targeting_rule', () => {
  it('add POSTs the rule and passes the 201 body through', async () => {
    const { api, calls } = mockApi([{ method: 'POST', path: RULES, status: 201, json: { id: 'r1', priority: 3 } }]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({
      name: 'manage_targeting_rule',
      arguments: { action: 'add', ...at, rule: { variationId: 'v-on', conditionGroups: [group] } },
    });
    expect(calls[0].body).toEqual({ variationId: 'v-on', conditionGroups: [group] });
    expect(JSON.parse(text(r)).id).toBe('r1');
  });

  it('add without conditionGroups sends an empty list, which the API requires', async () => {
    const { api, calls } = mockApi([{ method: 'POST', path: RULES, status: 201, json: { id: 'r1', priority: 0 } }]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({
      name: 'manage_targeting_rule',
      arguments: { action: 'add', ...at, rule: { variationId: 'v-on', userSegmentId: 'seg-1' } },
    });
    expect(calls[0].body).toEqual({ variationId: 'v-on', userSegmentId: 'seg-1', conditionGroups: [] });
  });

  it('update merges the current rule, sends only the request shape, and sends its ETag', async () => {
    const { api, calls } = mockApi([
      {
        method: 'GET',
        path: `${RULES}/r1`,
        json: {
          id: 'r1', priority: 0, description: 'pros', variationId: 'v-on', rolloutPercentage: null, userSegmentId: null,
          conditionGroups: [{ ...group, id: 'g1', conditions: [{ ...group.conditions[0], id: 'c1' }] }], _actions: {},
        },
        headers: { ETag: '"r1"' },
      },
      { method: 'PUT', path: `${RULES}/r1`, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({
      name: 'manage_targeting_rule',
      arguments: { action: 'update', ...at, ruleId: 'r1', rule: { variationId: 'v-off' } },
    });
    expect(calls[1].body).toEqual({
      description: 'pros', variationId: 'v-off', rolloutPercentage: null, userSegmentId: null, conditionGroups: [group],
    });
    expect(calls[1].headers['If-Match']).toBe('"r1"');
  });

  it('remove DELETEs the rule', async () => {
    const { api, calls } = mockApi([{ method: 'DELETE', path: `${RULES}/r1`, status: 204 }]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({ name: 'manage_targeting_rule', arguments: { action: 'remove', ...at, ruleId: 'r1' } });
    expect(calls[0].method).toBe('DELETE');
    expect(JSON.parse(text(r))).toEqual({ removed: 'r1' });
  });

  it('reorder PUTs ruleIds verbatim', async () => {
    const { api, calls } = mockApi([{ method: 'PUT', path: `${RULES}/reorder`, status: 204 }]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({
      name: 'manage_targeting_rule',
      arguments: { action: 'reorder', ...at, ruleIds: ['r2', 'r1'] },
    });
    expect(calls[0].body).toEqual({ ruleIds: ['r2', 'r1'] });
    expect(JSON.parse(text(r))).toEqual({ reordered: ['r2', 'r1'] });
  });

  it('missing per-action arguments fail without calling the API', async () => {
    const { api, calls } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    for (const args of [
      { action: 'add', ...at },
      { action: 'update', ...at, rule: { variationId: 'v' } },
      { action: 'update', ...at, ruleId: 'r1' },
      { action: 'remove', ...at },
      { action: 'reorder', ...at },
    ]) {
      expect((await client.callTool({ name: 'manage_targeting_rule', arguments: args })).isError, JSON.stringify(args)).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });
});
