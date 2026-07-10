import { describe, it, expect } from 'vitest';
import { ApiError } from '../src/client.js';
import { okJson, errorResult, run } from '../src/errors.js';

describe('okJson', () => {
  it('wraps data as pretty JSON text content', () => {
    const result = okJson({ a: 1 });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual({ type: 'text', text: JSON.stringify({ a: 1 }, null, 2) });
  });
});

describe('errorResult', () => {
  it('renders envelope details including hints', () => {
    const err = new ApiError(404, {
      error: 'not_found',
      message: 'Flag "chekout" not found',
      did_you_mean: ['checkout'],
      next_actions: [{ method: 'GET', path: '/api/v1/orgs/acme/projects/web/flags' }],
      docs_url: 'https://featureflip.io/docs/management-api/errors/not_found',
    });
    const result = errorResult(err);
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('404');
    expect(text).toContain('not_found');
    expect(text).toContain('Did you mean: checkout');
    expect(text).toContain('GET /api/v1/orgs/acme/projects/web/flags');
    expect(text).toContain('public Management API is not enabled'); // 404 hint
  });

  it('renders rate-limit retry hint', () => {
    const result = errorResult(new ApiError(429, { error: 'rate_limited', message: 'Too many requests', retry_after: 12 }));
    expect(result.content[0].text).toContain('retry after 12s');
  });

  it('handles non-ApiError values', () => {
    expect(errorResult(new Error('boom')).content[0].text).toContain('boom');
    expect(errorResult('bad').content[0].text).toContain('bad');
  });
});

describe('run', () => {
  it('passes through successful results and converts throws', async () => {
    const good = await run(async () => okJson({ ok: true }));
    expect(good.isError).toBeUndefined();
    const bad = await run(async () => {
      throw new ApiError(403, { error: 'forbidden', message: 'requires Member role' });
    });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain('forbidden');
  });
});
