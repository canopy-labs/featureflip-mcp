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
});
