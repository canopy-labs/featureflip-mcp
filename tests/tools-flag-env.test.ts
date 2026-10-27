import { describe, it, expect } from 'vitest';
import { mockApi, connectClient } from './helpers.js';

const ORG = 'acme';
const FLAG = `/api/v1/orgs/${ORG}/projects/web/flags/checkout-v2`;

describe('per-environment tools', () => {
  it('toggle_flag POSTs { enabled } to the env toggle endpoint', async () => {
    // Real controller (FlagEnvironmentConfigController.Toggle) returns 204 No Content.
    const { api, calls } = mockApi([
      { method: 'POST', path: `${FLAG}/environments/production/toggle`, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });
    const result = await client.callTool({
      name: 'toggle_flag',
      arguments: { project: 'web', flag: 'checkout-v2', environment: 'production', enabled: true },
    });
    expect(result.isError).toBeFalsy();
    expect(calls[0].body).toEqual({ enabled: true });
  });

  it('update_flag_environment_config PUTs defaultVariationId/strategy/prerequisites', async () => {
    // Real controller (FlagEnvironmentConfigController.Update) returns 204 No Content.
    const { api, calls } = mockApi([
      { method: 'PUT', path: `${FLAG}/environments/staging`, status: 204 },
    ]);
    const client = await connectClient({ api, org: ORG });
    const result = await client.callTool({
      name: 'update_flag_environment_config',
      arguments: {
        project: 'web',
        flag: 'checkout-v2',
        environment: 'staging',
        defaultVariationId: 'var-1',
        strategy: 'SingleVariation',
        prerequisites: [{ prerequisiteFlagKey: 'base-flag', expectedVariationKey: 'true' }],
      },
    });
    expect(result.isError).toBeFalsy();
    expect(calls[0].body).toEqual({
      defaultVariationId: 'var-1',
      strategy: 'SingleVariation',
      prerequisites: [{ prerequisiteFlagKey: 'base-flag', expectedVariationKey: 'true' }],
    });
  });

  it('flag_status combines flag detail and env configs into a compact view', async () => {
    const { api } = mockApi([
      {
        method: 'GET',
        path: FLAG,
        json: {
          key: 'checkout-v2',
          name: 'Checkout V2',
          type: 'Boolean',
          isArchived: false,
          updatedAt: '2026-07-01T00:00:00Z',
          variations: [
            { id: 'var-t', key: 'true' },
            { id: 'var-f', key: 'false' },
          ],
        },
      },
      {
        // FlagEnvironmentConfigController.GetAll returns a BARE array of
        // PublicFlagEnvConfigResponse — verified against the controller and the
        // committed public-v1-openapi.json (`"schema": { "type": "array", "items": {...} }`),
        // not a `{ items: [...] }` wrapper.
        method: 'GET',
        path: `${FLAG}/environments`,
        json: [
          { environmentKey: 'production', isEnabled: true, defaultVariationId: 'var-t', strategy: 'SingleVariation', prerequisites: [] },
          { environmentKey: 'staging', isEnabled: false, defaultVariationId: 'var-f', strategy: 'SingleVariation', prerequisites: [] },
        ],
      },
    ]);
    const client = await connectClient({ api, org: ORG });
    const result = await client.callTool({ name: 'flag_status', arguments: { project: 'web', flag: 'checkout-v2' } });
    expect(result.isError).toBeFalsy();
    const status = JSON.parse((result.content as { text: string }[])[0].text);
    expect(status.key).toBe('checkout-v2');
    expect(status.environments).toEqual([
      { environment: 'production', enabled: true, strategy: 'SingleVariation', defaultVariation: 'true', prerequisites: [] },
      { environment: 'staging', enabled: false, strategy: 'SingleVariation', defaultVariation: 'false', prerequisites: [] },
    ]);
  });

  it('toggle_flag is destructive, flag_status read-only', async () => {
    const { api } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'toggle_flag')?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === 'update_flag_environment_config')?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === 'flag_status')?.annotations?.readOnlyHint).toBe(true);
  });

  const EVALUATIONS = {
    environmentKey: 'production',
    days: 30,
    fromUtc: '2026-09-27T00:00:00Z',
    toUtc: '2026-10-26T12:00:00Z',
    totalCount: 120,
    lastEvaluatedAtUtc: '2026-10-26T11:59:00Z',
    variations: [{ variationKey: 'true', name: 'On', exists: true, count: 120, share: 1 }],
    sources: [
      {
        source: 'fallthrough',
        ruleId: null,
        ruleLabel: null,
        ruleExists: false,
        count: 120,
        share: 1,
        variations: [{ variationKey: 'true', name: 'On', exists: true, count: 120, share: 1 }],
        rollout: null,
      },
    ],
  };

  it('flag_evaluations GETs the evaluations endpoint with days and passes the body through', async () => {
    // Real controller: FlagEvaluationsController.Get (?days=7|30|90).
    const { api, calls } = mockApi([
      { method: 'GET', path: `${FLAG}/environments/production/evaluations`, query: { days: '30' }, json: EVALUATIONS },
    ]);
    const client = await connectClient({ api, org: ORG });
    const result = await client.callTool({
      name: 'flag_evaluations',
      arguments: { project: 'web', flag: 'checkout-v2', environment: 'production', days: 30 },
    });
    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(result.structuredContent).toEqual(EVALUATIONS);
  });

  it('flag_evaluations defaults days to 7', async () => {
    const { api } = mockApi([
      {
        method: 'GET',
        path: `${FLAG}/environments/production/evaluations`,
        query: { days: '7' },
        json: { ...EVALUATIONS, days: 7 },
      },
    ]);
    const client = await connectClient({ api, org: ORG });
    const result = await client.callTool({
      name: 'flag_evaluations',
      arguments: { project: 'web', flag: 'checkout-v2', environment: 'production' },
    });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { days: number }).days).toBe(7);
  });

  it('flag_evaluations rejects a window other than 7, 30 or 90', async () => {
    const { api, calls } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    const result = await client.callTool({
      name: 'flag_evaluations',
      arguments: { project: 'web', flag: 'checkout-v2', environment: 'production', days: 14 },
    });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('flag_evaluations tells agents the counts are evaluations, not users', async () => {
    const { api } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'flag_evaluations');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.description).toContain('NOT unique users');
    expect(tool?.description).toContain('zero means no evaluations were reported');
  });
});
