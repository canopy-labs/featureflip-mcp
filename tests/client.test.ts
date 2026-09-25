import { describe, it, expect, vi } from 'vitest';
import { FeatureflipApi, ApiError, enc } from '../src/client.js';

const noSleep = async (_ms: number) => {};

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
    const fetchImpl = vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 }));
    const api = new FeatureflipApi({ token: 't', baseUrl: 'https://api.test', fetchImpl, sleep: noSleep });
    const err = await api.request('GET', '/api/v1/me').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).envelope.error).toBe('http_502');
  });
});

describe('FeatureflipApi.request transient retry', () => {
  const connectError = () => new TypeError('fetch failed');

  function sequence(...steps: (number | Error)[]) {
    return vi.fn(async () => {
      const step = steps.shift();
      if (step === undefined) throw new Error('fetch called more times than scripted');
      if (step instanceof Error) throw step;
      return step === 204 ? new Response(null, { status: 204 }) : jsonResponse(step, { error: `e${step}`, message: `status ${step}` });
    });
  }

  function apiWith(fetchImpl: ReturnType<typeof sequence>, sleep = vi.fn(noSleep)) {
    return { api: new FeatureflipApi({ token: 't', baseUrl: 'https://api.test', fetchImpl, sleep }), sleep };
  }

  it.each([502, 503, 504])('retries a GET after %i and returns the eventual success', async (status) => {
    const fetchImpl = sequence(status, 200);
    const { api } = apiWith(fetchImpl);
    await expect(api.request('GET', '/api/v1/me')).resolves.toEqual({ error: 'e200', message: 'status 200' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries a GET after a network error', async () => {
    const fetchImpl = sequence(connectError(), 204);
    const { api } = apiWith(fetchImpl);
    await expect(api.request('GET', '/api/v1/me')).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up after 3 attempts, backing off between them, and surfaces the last error', async () => {
    const fetchImpl = sequence(503, 503, 503);
    const { api, sleep } = apiWith(fetchImpl);
    const err = await api.request('PUT', '/api/v1/x', { body: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 1000]);
  });

  it('rethrows the last network error once attempts are exhausted', async () => {
    const fetchImpl = sequence(connectError(), connectError(), connectError());
    const { api } = apiWith(fetchImpl);
    await expect(api.request('DELETE', '/api/v1/x')).rejects.toThrow('fetch failed');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('retries a POST carrying an Idempotency-Key on 502, reusing the same key', async () => {
    const fetchImpl = sequence(502, 201);
    const { api } = apiWith(fetchImpl);
    await api.request('POST', '/api/v1/flags', { body: { key: 'k' }, idempotencyKey: 'idem-1' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const keys = fetchImpl.mock.calls.map((c) => (c as unknown as [string, RequestInit])[1].headers as Record<string, string>);
    expect(keys.map((h) => h['Idempotency-Key'])).toEqual(['idem-1', 'idem-1']);
  });

  it('retries an unkeyed POST on 503, where the request never reached the app', async () => {
    const fetchImpl = sequence(503, 200);
    const { api } = apiWith(fetchImpl);
    await api.request('POST', '/api/v1/flags/f/archive');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([502, 504])('does NOT retry an unkeyed POST on %i, which may have been applied', async (status) => {
    const fetchImpl = sequence(status);
    const { api } = apiWith(fetchImpl);
    await expect(api.request('POST', '/api/v1/flags/f/archive')).rejects.toBeInstanceOf(ApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry an unkeyed POST after a network error', async () => {
    const fetchImpl = sequence(connectError());
    const { api } = apiWith(fetchImpl);
    await expect(api.request('POST', '/api/v1/flags/f/archive')).rejects.toThrow('fetch failed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 404, 409, 429, 500])('does not retry %i', async (status) => {
    const fetchImpl = sequence(status);
    const { api } = apiWith(fetchImpl);
    await expect(api.request('GET', '/api/v1/me')).rejects.toBeInstanceOf(ApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('enc', () => {
  it('URL-encodes path segments', () => {
    expect(enc('my flag/x')).toBe('my%20flag%2Fx');
  });
});
