import { describe, it, expect, vi } from 'vitest';
import { FeatureflipApi } from '../src/client.js';
import { resolveOrg } from '../src/org.js';

function apiReturningOrgs(items: { slug: string; name: string }[]): FeatureflipApi {
  const fetchImpl = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ items, next_cursor: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  return new FeatureflipApi({ token: 't', baseUrl: 'https://api.test', fetchImpl });
}

describe('resolveOrg', () => {
  it('returns the explicit org untouched without calling the API', async () => {
    const api = apiReturningOrgs([]);
    await expect(resolveOrg(api, 'acme')).resolves.toBe('acme');
  });

  it('auto-resolves when exactly one org is visible', async () => {
    await expect(resolveOrg(apiReturningOrgs([{ slug: 'solo', name: 'Solo' }]))).resolves.toBe('solo');
  });

  it('throws listing slugs when multiple orgs are visible', async () => {
    const err = await resolveOrg(apiReturningOrgs([
      { slug: 'acme', name: 'Acme' },
      { slug: 'beta', name: 'Beta' },
    ])).catch((e) => e);
    expect(err.message).toMatch(/FEATUREFLIP_ORG/);
    expect(err.message).toContain('acme');
    expect(err.message).toContain('beta');
  });

  it('throws when no orgs are visible', async () => {
    await expect(resolveOrg(apiReturningOrgs([]))).rejects.toThrowError(/no organizations/i);
  });
});
