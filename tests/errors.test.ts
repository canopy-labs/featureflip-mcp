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
  const frozen = (cf: Record<string, unknown>) =>
    errorResult(new ApiError(423, { error: 'change_frozen', message: 'Frozen', change_freeze: cf } as never)).content[0].text;

  it('change_frozen names the window, environment and end, and the override path', () => {
    const t = frozen({ id: 'i', name: 'Black Friday', environment_key: 'production', ends_at: '2026-11-30T00:00:00Z', can_override: true });
    expect(t).toContain('Black Friday');
    expect(t).toContain('production');
    expect(t).toContain('2026-11-30T00:00:00Z');
    expect(t).toContain('freeze_override: true');
    expect(t).toContain('reason');
  });

  it('change_frozen from an older server (no change_freeze slot) keeps the message and adds no override hint', () => {
    const t = errorResult(new ApiError(423, { error: 'change_frozen', message: 'Production is frozen' })).content[0].text;
    expect(t).toContain('Production is frozen');
    expect(t).not.toContain('freeze_override');
  });

  it('change_frozen without override tells the agent to ask an Owner or Admin, and an open end reads "until it is ended"', () => {
    const t = frozen({ id: 'i', name: 'Incident', environment_key: 'staging', ends_at: null, can_override: false });
    expect(t).toContain('until it is ended');
    expect(t).toContain('Owner or Admin');
    expect(t).not.toContain('freeze_override: true');
  });

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

  it('explains a 412 as a concurrent change and says how to recover', () => {
    const r = errorResult(new ApiError(412, { error: 'precondition_failed', message: 'If-Match did not match' }));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('changed since it was read');
    expect(r.content[0].text).toContain('re-apply');
    // Tools that read before writing (environments, webhooks, rules) recover by being called again.
    expect(r.content[0].text).toContain('call it again');
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
