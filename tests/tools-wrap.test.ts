import { describe, it, expect } from 'vitest';
import { LANGUAGES, snippetFor } from '../src/tools/workflows/snippets.js';
import { mockApi, connectClient } from './helpers.js';

const ORG = 'acme';

describe('snippetFor', () => {
  it('produces a snippet containing the flag key for every language', () => {
    for (const lang of LANGUAGES) {
      const s = snippetFor(lang, 'my-new-flag');
      expect(s.code, lang).toContain('my-new-flag');
      expect(s.install.length, lang).toBeGreaterThan(0);
    }
  });

  it('server SDKs use sdk key, client SDKs use client key', () => {
    expect(snippetFor('node', 'f').code).toContain('sdkKey');
    expect(snippetFor('browser', 'f').code).toContain('clientKey');
    expect(snippetFor('python', 'f').code).toContain('sdk_key');
  });

  it('JS-family snippets reference the real published npm package names', () => {
    const real = {
      js: '@featureflip/js',
      node: '@featureflip/node',
      browser: '@featureflip/browser',
      react: '@featureflip/react',
    } as const;
    const stale = ['@featureflip/sdk', '@featureflip/node-sdk', '@featureflip/browser-sdk', '@featureflip/react-sdk'];

    for (const lang of ['js', 'node', 'browser', 'react'] as const) {
      const s = snippetFor(lang, 'f');
      expect(s.install, lang).toContain(real[lang]);
      expect(s.code, lang).toContain(real[lang]);
      for (const name of stale) {
        expect(s.install, lang).not.toContain(name);
        expect(s.code, lang).not.toContain(name);
      }
    }
  });
});

describe('wrap_feature', () => {
  it('creates a Boolean flag and returns the snippet', async () => {
    const { api, calls } = mockApi([
      {
        method: 'POST',
        path: `/api/v1/orgs/${ORG}/projects/web/flags`,
        status: 201,
        json: { key: 'new-checkout', name: 'New checkout', type: 'Boolean' },
      },
    ]);
    const client = await connectClient({ api, org: ORG });
    const result = await client.callTool({
      name: 'wrap_feature',
      arguments: { project: 'web', key: 'new-checkout', description: 'New checkout flow', language: 'node' },
    });
    expect(result.isError).toBeFalsy();
    expect(calls[0].body).toMatchObject({ key: 'new-checkout', type: 'Boolean' });
    const text = (result.content as { text: string }[])[0].text;
    expect(text).toContain('new-checkout');
    expect(text).toContain('boolVariation');
    expect(text).toContain('npm install');
  });
});
