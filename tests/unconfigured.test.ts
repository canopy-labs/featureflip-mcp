import { describe, it, expect } from 'vitest';
import { connectClient } from './helpers.js';
import { resolveContext } from '../src/bootstrap.js';
import { loadConfig, tryLoadConfig, MISSING_TOKEN_MESSAGE } from '../src/config.js';
import { unconfiguredContext } from '../src/unconfigured.js';

/** Records every request and answers from a path table, 404-ing anything unlisted. */
function stubFetch(routes: Record<string, unknown>): { fetchImpl: typeof fetch; paths: string[] } {
  const paths: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const { pathname } = new URL(String(input));
    paths.push(pathname);
    const json = routes[pathname];
    return new Response(JSON.stringify(json ?? { error: 'not_found', message: 'no route' }), {
      status: json === undefined ? 404 : 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, paths };
}

describe('starting with no credentials configured', () => {
  it('tryLoadConfig reports the absence instead of throwing', () => {
    expect(tryLoadConfig({})).toBeNull();
    expect(tryLoadConfig({ FEATUREFLIP_TOKEN: '   ' })).toBeNull();
    expect(tryLoadConfig({ FEATUREFLIP_TOKEN: 'ffp_x' })?.token).toBe('ffp_x');
    expect(() => loadConfig({})).toThrow(MISSING_TOKEN_MESSAGE);
  });

  // The regression this locks: startup used to loadConfig() and preflight
  // /api/v1/me BEFORE serving, so anything inspecting the server without a token
  // — a registry computing a tool-definition quality score, an editor probing on
  // first run — got process.exit(1) and recorded zero tools.
  it('resolves a context without touching the network', async () => {
    const { fetchImpl, paths } = stubFetch({});

    const ctx = await resolveContext({}, fetchImpl);

    expect(paths).toEqual([]);
    await expect(ctx.api.request('GET', '/api/v1/orgs')).rejects.toThrow(MISSING_TOKEN_MESSAGE);
  });

  it('still advertises the full tool surface', async () => {
    const client = await connectClient(unconfiguredContext());
    const { tools } = await client.listTools();

    expect(tools).toHaveLength(19);
    expect(tools.map((t) => t.name)).toContain('list_flags');
  });

  it('fails a tool CALL with the same guidance startup used to print', async () => {
    const client = await connectClient(unconfiguredContext());
    const result = await client.callTool({ name: 'list_projects', arguments: {} });

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toContain(MISSING_TOKEN_MESSAGE);
  });
});

describe('starting with a token still fails fast', () => {
  it('preflights /api/v1/me and resolves the org', async () => {
    const { fetchImpl, paths } = stubFetch({
      '/api/v1/me': {},
      '/api/v1/orgs': { items: [{ slug: 'acme' }] },
    });

    const ctx = await resolveContext({ FEATUREFLIP_TOKEN: 'ffp_good' }, fetchImpl);

    expect(paths).toEqual(['/api/v1/me', '/api/v1/orgs']);
    expect(ctx.org).toBe('acme');
  });

  it('rejects a bad token at startup rather than at first tool call', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'unauthorized', message: 'nope' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    await expect(resolveContext({ FEATUREFLIP_TOKEN: 'ffp_bad' }, fetchImpl)).rejects.toThrow(
      'FEATUREFLIP_TOKEN was rejected (401)',
    );
  });
});
