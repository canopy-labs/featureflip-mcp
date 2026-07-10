import { describe, it, expect, vi } from 'vitest';
import { FeatureflipApi, ApiError, enc } from '../src/client.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('FeatureflipApi.request', () => {
  it('sends bearer auth, JSON headers, and builds query strings (skipping undefined)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { items: [] }));
    const api = new FeatureflipApi({ token: 'ffp_t', baseUrl: 'https://api.test', fetchImpl });

    await api.request('GET', '/api/v1/orgs/acme/projects', { query: { limit: 5, cursor: undefined } });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.test/api/v1/orgs/acme/projects?limit=5');
    expect(init.method).toBe('GET');
    expect(init.headers['Authorization']).toBe('Bearer ffp_t');
    expect(init.headers['Accept']).toBe('application/json');
    expect(init.body).toBeUndefined();
  });

  it('serializes bodies and sets Content-Type + Idempotency-Key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, { key: 'new-flag' }));
    const api = new FeatureflipApi({ token: 'ffs_t', baseUrl: 'https://api.test', fetchImpl });

    const out = await api.request<{ key: string }>('POST', '/api/v1/orgs/a/projects/p/flags', {
      body: { key: 'new-flag' },
      idempotencyKey: 'idem-1',
    });

    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['Idempotency-Key']).toBe('idem-1');
    expect(JSON.parse(init.body)).toEqual({ key: 'new-flag' });
    expect(out.key).toBe('new-flag');
  });

  it('returns undefined for 204 responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const api = new FeatureflipApi({ token: 't', baseUrl: 'https://api.test', fetchImpl });
    await expect(api.request('DELETE', '/api/v1/orgs/a/projects/p/flags/f')).resolves.toBeUndefined();
  });

  it('throws ApiError carrying the error envelope', async () => {
    const envelope = {
      error: 'not_found',
      message: 'Flag not found',
      did_you_mean: ['checkout-v2'],
      docs_url: 'https://featureflip.io/docs/management-api/errors/not_found',
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404, envelope));
    const api = new FeatureflipApi({ token: 't', baseUrl: 'https://api.test', fetchImpl });

    const err = await api.request('GET', '/api/v1/orgs/a/projects/p/flags/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).envelope).toEqual(envelope);
  });

  it('synthesizes an envelope for non-JSON error bodies', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }));
    const api = new FeatureflipApi({ token: 't', baseUrl: 'https://api.test', fetchImpl });
    const err = await api.request('GET', '/api/v1/me').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).envelope.error).toBe('http_502');
  });
});

describe('enc', () => {
  it('URL-encodes path segments', () => {
    expect(enc('my flag/x')).toBe('my%20flag%2Fx');
  });
});
