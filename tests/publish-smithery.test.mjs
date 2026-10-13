// .mjs, not .ts: the script under test is plain ESM with no declarations, and
// tsconfig typechecks tests/*.ts with allowJs off.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildPayload, buildServerUpdate, toConfigSchema } from '../scripts/publish-smithery.mjs';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

const tool = {
  name: 'list_projects',
  description: 'List projects',
  inputSchema: { type: 'object', properties: { cursor: { type: 'string' } } },
};

describe('buildPayload', () => {
  it('sends the tools it is given, schemas included', () => {
    // The whole reason the script exists: Smithery rejects a tool without
    // inputSchema, and the MCPB manifest cannot carry one.
    const payload = buildPayload({ ...manifest, version: '9.9.9' }, [tool]);
    expect(payload).toMatchObject({
      type: 'stdio',
      runtime: 'node',
      serverCard: { serverInfo: { name: manifest.name, version: '9.9.9' }, tools: [tool] },
    });
    expect(payload.serverCard.tools[0].inputSchema).toEqual(tool.inputSchema);
  });

  it('turns the real manifest user_config into the install form schema', () => {
    const { configSchema } = buildPayload(manifest, [tool]);
    expect(configSchema.required).toEqual(['featureflip_token']);
    expect(Object.keys(configSchema.properties).sort()).toEqual(
      ['featureflip_api_url', 'featureflip_org', 'featureflip_token'],
    );
    expect(configSchema.properties.featureflip_api_url).toMatchObject({
      type: 'string',
      default: 'https://api.featureflip.io',
    });
    // `sensitive` and `required` are manifest vocabulary, not JSON Schema.
    expect(configSchema.properties.featureflip_token).not.toHaveProperty('sensitive');
    expect(configSchema.properties.featureflip_token).not.toHaveProperty('required');
  });

  it('refuses a runtime it does not know how to describe', () => {
    expect(() => buildPayload({ ...manifest, server: { type: 'binary' } }, [tool])).toThrow(/runtime/);
  });
});

describe('toConfigSchema', () => {
  it('omits an empty user_config entirely', () => {
    expect(toConfigSchema(undefined)).toBeUndefined();
    expect(toConfigSchema({})).toBeUndefined();
  });

  it('maps file and directory fields to strings and multiple to arrays', () => {
    expect(toConfigSchema({ p: { type: 'directory', multiple: true } }).properties.p).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
  });
});

describe('buildServerUpdate', () => {
  it('fills the listing from the real manifest, homepage included', () => {
    // The homepage is the listing's link back to featureflip.io: a server
    // created by a release alone has none.
    expect(buildServerUpdate(manifest)).toEqual({
      displayName: 'Featureflip',
      description: manifest.description,
      homepage: 'https://featureflip.io',
      repositoryUrl: 'https://github.com/canopy-labs/featureflip-mcp',
      license: 'Apache-2.0',
      iconUrl: 'https://featureflip.io/brand/logo-512.png',
    });
  });
});
