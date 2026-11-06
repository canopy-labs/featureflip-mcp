import { describe, it, expect } from 'vitest';
import { mockApi, connectClient } from './helpers.js';

const ORG = 'acme';
const P = `/api/v1/orgs/${ORG}/projects/web`;
const COPY = `${P}/flags/checkout-v2/environments/production/copy`;
const text = (r: { content: unknown }) => (r.content as { text: string }[])[0].text;
const query = (url: string) => Object.fromEntries(new URL(url).searchParams);

const result = {
  changed: true,
  changedSections: ['rules'],
  after: { enabled: true, strategy: 'SingleVariation', rules: [], prerequisites: [] },
  sourceETag: '"s1"',
  targetETag: '"t1"',
  warnings: [],
};
const etags = { source_etag: '"s1"', target_etag: '"t1"' };
const copyArgs = { project: 'web', flag: 'checkout-v2', source: 'staging', target: 'production' };

describe('compare_environments', () => {
  it('compare_environments_passes_paging_and_filters', async () => {
    const { api, calls } = mockApi([{ method: 'GET', path: `${P}/compare`, json: { items: [] } }]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({
      name: 'compare_environments',
      arguments: { project: 'web', base: 'staging', other: 'production', different_only: false, tag: 't', owner: 'none', limit: 10, cursor: 'c1' },
    });
    expect(new URL(calls[0].url).pathname).toBe(`${P}/compare`);
    expect(query(calls[0].url)).toEqual({ base: 'staging', other: 'production', differentOnly: 'false', tag: 't', owner: 'none', limit: '10', cursor: 'c1' });
  });

  it('compare_environments_defaults_to_differences_only', async () => {
    const { api, calls } = mockApi([{ method: 'GET', path: `${P}/compare`, json: { items: [] } }]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({ name: 'compare_environments', arguments: { project: 'web', base: 'staging', other: 'production' } });
    expect(query(calls[0].url)).toEqual({ base: 'staging', other: 'production', differentOnly: 'true' });
  });
});

describe('copy_flag_config', () => {
  it('copy_flag_config_previews_by_default', async () => {
    const { api, calls } = mockApi([{ method: 'POST', path: COPY, json: result }]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({ name: 'copy_flag_config', arguments: copyArgs });
    expect(calls[0].body).toEqual({ source: 'staging', includeState: false, dryRun: true });
    expect(JSON.parse(text(r))).toEqual(result);
  });

  it('copy_flag_config_apply_sends_etags', async () => {
    const { api, calls } = mockApi([{ method: 'POST', path: COPY, json: result }]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({
      name: 'copy_flag_config',
      arguments: { ...copyArgs, include_state: true, dry_run: false, source_etag: '"s1"', target_etag: '"t1"' },
    });
    expect(calls[0].body).toEqual({
      source: 'staging', includeState: true, dryRun: false, expectedSourceETag: '"s1"', expectedTargetETag: '"t1"',
    });
  });

  it('copy_flag_config_sends_reason', async () => {
    const { api, calls } = mockApi([{ method: 'POST', path: COPY, json: result }]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({ name: 'copy_flag_config', arguments: { ...copyArgs, dry_run: false, ...etags, reason: 'Incident 42' } });
    expect(calls[0].headers['X-Intent-Reason']).toBe(encodeURIComponent('Incident 42'));
    expect(calls[0].body).not.toHaveProperty('reason');
  });

  it('copy_flag_config_stale_etag_says_preview_again', async () => {
    const { api } = mockApi([{ method: 'POST', path: COPY, status: 412, json: { error: 'precondition_failed', message: 'changed' } }]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({ name: 'copy_flag_config', arguments: { ...copyArgs, dry_run: false, ...etags } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('dry_run: true');
    expect(text(r)).not.toContain('ifMatch');
  });

  it('copy_flag_config_apply_without_reason_into_critical_env_surfaces_retry_hint', async () => {
    const { api } = mockApi([{ method: 'POST', path: COPY, status: 422, json: { error: 'change_reason_required', message: 'reason needed' } }]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({ name: 'copy_flag_config', arguments: { ...copyArgs, dry_run: false, ...etags } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('`reason`');
  });

  it.each([
    ['both', {}],
    ['target', { source_etag: '"s1"' }],
    ['source', { target_etag: '"t1"' }],
  ])('copy_flag_config_apply_without_etags_refuses_without_calling_api (missing %s)', async (_n, extra) => {
    const { api, calls } = mockApi([{ method: 'POST', path: COPY, json: result }]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({ name: 'copy_flag_config', arguments: { ...copyArgs, dry_run: false, ...extra } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('both source_etag and target_etag');
    expect(calls).toHaveLength(0);
  });
});
