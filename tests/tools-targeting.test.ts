import { describe, it, expect } from 'vitest';
import { mockApi, connectClient } from './helpers.js';

const ORG = 'acme';
const FLAG = `/api/v1/orgs/${ORG}/projects/web/flags/checkout-v2`;

describe('get_targeting', () => {
  it('GETs the resolved targeting configuration', async () => {
    const targetingConfig = {
      isEnabled: true,
      rules: [
        {
          id: 'rule-1',
          description: 'Beta cohort',
          variationId: 'var-t',
          rolloutPercentage: 25,
          conditionGroups: [],
        },
      ],
    };
    const { api, calls } = mockApi([
      { method: 'GET', path: `${FLAG}/environments/production/targeting`, status: 200, json: targetingConfig },
    ]);
    const client = await connectClient({ api, org: ORG });
    const result = await client.callTool({
      name: 'get_targeting',
      arguments: { project: 'web', flag: 'checkout-v2', environment: 'production' },
    });
    expect(result.isError).toBeFalsy();
    expect(calls[0].method).toBe('GET');
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual(targetingConfig);
  });

  it('is read-only', async () => {
    const { api } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'get_targeting')?.annotations?.readOnlyHint).toBe(true);
  });
});

describe('update_targeting', () => {
  it('PUTs full rule replacement with condition groups (204 No Content)', async () => {
    // Real controller (FlagTargetingController.Update) returns 204 No Content.
    const { api, calls } = mockApi([
      { method: 'PUT', path: `${FLAG}/environments/production/targeting`, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });
    const rules = [
      {
        description: 'Beta cohort',
        variationId: 'var-t',
        rolloutPercentage: 25,
        conditionGroups: [
          {
            operator: 'And',
            conditions: [{ attribute: 'plan', operator: 'Equals', values: ['pro'], negate: false }],
          },
        ],
      },
    ];
    const result = await client.callTool({
      name: 'update_targeting',
      arguments: { project: 'web', flag: 'checkout-v2', environment: 'production', rules },
    });
    expect(result.isError).toBeFalsy();
    expect(calls[0].body).toEqual({ rules });
    const confirmation = JSON.parse((result.content as { text: string }[])[0].text);
    expect(confirmation).toEqual({
      project: 'web',
      flag: 'checkout-v2',
      environment: 'production',
      rulesReplaced: 1,
    });
  });

  it('defaults an omitted condition `negate` to false in the PUT body', async () => {
    const { api, calls } = mockApi([
      { method: 'PUT', path: `${FLAG}/environments/production/targeting`, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });
    const rules = [
      {
        variationId: 'var-t',
        conditionGroups: [
          {
            operator: 'And',
            conditions: [{ attribute: 'plan', operator: 'Equals', values: ['pro'] }],
          },
        ],
      },
    ];
    await client.callTool({
      name: 'update_targeting',
      arguments: { project: 'web', flag: 'checkout-v2', environment: 'production', rules },
    });
    expect(
      (calls[0].body as { rules: { conditionGroups: { conditions: { negate: boolean }[] }[] }[] }).rules[0]
        .conditionGroups[0].conditions[0].negate,
    ).toBe(false);
  });
});

describe('manage_variation', () => {
  it('add → POST /variations (201 with body)', async () => {
    const { api, calls } = mockApi([
      { method: 'POST', path: `${FLAG}/variations`, status: 201, json: { key: 'treatment' } },
    ]);
    const client = await connectClient({ api, org: ORG });
    const result = await client.callTool({
      name: 'manage_variation',
      arguments: { project: 'web', flag: 'checkout-v2', action: 'add', key: 'treatment', value: 'true' },
    });
    expect(result.isError).toBeFalsy();
    expect(calls[0].body).toMatchObject({ key: 'treatment', value: 'true' });
    const body = JSON.parse((result.content as { text: string }[])[0].text);
    expect(body).toEqual({ key: 'treatment' });
  });

  it('update → PUT /variations/{id} (204), remove → DELETE /variations/{id} (204)', async () => {
    const { api, calls } = mockApi([
      { method: 'PUT', path: `${FLAG}/variations/var-9`, status: 204 },
      { method: 'DELETE', path: `${FLAG}/variations/var-9`, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });
    const updated = await client.callTool({
      name: 'manage_variation',
      arguments: { project: 'web', flag: 'checkout-v2', action: 'update', variationId: 'var-9', name: 'Treatment' },
    });
    const removed = await client.callTool({
      name: 'manage_variation',
      arguments: { project: 'web', flag: 'checkout-v2', action: 'remove', variationId: 'var-9' },
    });
    expect(calls.map((c) => c.method)).toEqual(['PUT', 'DELETE']);
    // JSON.stringify drops undefined-valued keys, so only the supplied field survives.
    expect(calls[0].body).toEqual({ name: 'Treatment' });
    expect(updated.isError).toBeFalsy();
    expect(removed.isError).toBeFalsy();
    expect(JSON.parse((updated.content as { text: string }[])[0].text)).toEqual({ updated: 'var-9' });
    expect(JSON.parse((removed.content as { text: string }[])[0].text)).toEqual({ removed: 'var-9' });
  });

  it('rejects update/remove without variationId (validation, no HTTP call)', async () => {
    const { api, calls } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    const result = await client.callTool({
      name: 'manage_variation',
      arguments: { project: 'web', flag: 'checkout-v2', action: 'remove' },
    });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('rejects add without key/value (validation, no HTTP call)', async () => {
    const { api, calls } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    const result = await client.callTool({
      name: 'manage_variation',
      arguments: { project: 'web', flag: 'checkout-v2', action: 'add' },
    });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('update_targeting is destructive, manage_variation is destructive', async () => {
    const { api } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'update_targeting')?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === 'manage_variation')?.annotations?.destructiveHint).toBe(true);
  });
});
