import { describe, it, expect } from 'vitest';
import { mockApi, connectClient } from './helpers.js';
import pkg from '../package.json';

const ORG = 'acme';
const ENV = `/api/v1/orgs/${ORG}/projects/web/flags/checkout-v2/environments/production`;
const VERSIONS = `${ENV}/versions`;
const RESTORE = `${VERSIONS}/3/restore`;
const text = (r: { content: unknown }) => (r.content as { text: string }[])[0].text;
const query = (url: string) => Object.fromEntries(new URL(url).searchParams);

const where = { project: 'web', flag: 'checkout-v2', environment: 'production' };
const snapshot = { isEnabled: true, strategy: 'SingleVariation', rules: [], prerequisites: [] };
const result = {
  changed: true,
  changedSections: ['rules'],
  before: snapshot,
  after: snapshot,
  targetETag: '"e1"',
  warnings: [],
  newVersion: null,
};

describe('list_flag_versions', () => {
  it('list_flag_versions_gets_the_environment_versions_with_paging', async () => {
    const page = { items: [{ version: 4, source: 'mcp', isEnabled: true }], next_cursor: 'c2' };
    const { api, calls } = mockApi([{ method: 'GET', path: VERSIONS, json: page }]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({ name: 'list_flag_versions', arguments: { ...where, limit: 10, cursor: 'c1' } });
    expect(calls[0].method).toBe('GET');
    expect(new URL(calls[0].url).pathname).toBe(VERSIONS);
    expect(query(calls[0].url)).toEqual({ limit: '10', cursor: 'c1' });
    expect(JSON.parse(text(r))).toEqual(page);
  });

  it('list_flag_versions_omits_paging_it_was_not_given', async () => {
    const { api, calls } = mockApi([{ method: 'GET', path: VERSIONS, json: { items: [] } }]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({ name: 'list_flag_versions', arguments: where });
    expect(query(calls[0].url)).toEqual({});
  });
});

describe('restore_flag_version', () => {
  it('restore_flag_version_previews_by_default', async () => {
    const { api, calls } = mockApi([{ method: 'POST', path: RESTORE, json: result }]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({ name: 'restore_flag_version', arguments: { ...where, version: 3 } });
    expect(new URL(calls[0].url).pathname).toBe(RESTORE);
    expect(calls[0].body).toEqual({ dryRun: true, includeState: false });
    expect(JSON.parse(text(r))).toEqual(result);
  });

  it('restore_flag_version_apply_sends_the_etag_and_include_state', async () => {
    const { api, calls } = mockApi([{ method: 'POST', path: RESTORE, json: { ...result, newVersion: 5 } }]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({
      name: 'restore_flag_version',
      arguments: { ...where, version: 3, include_state: true, dry_run: false, etag: '"e1"' },
    });
    expect(calls[0].body).toEqual({ dryRun: false, includeState: true, expectedETag: '"e1"' });
  });

  it.each([
    ['unquoted', 'e1', '"e1"'],
    ['quoted', '"e1"', '"e1"'],
    ['weak', 'W/"e1"', 'W/"e1"'],
  ])('restore_flag_version_body_etag_is_normalized_when_%s', async (_n, given, sent) => {
    const { api, calls } = mockApi([{ method: 'POST', path: RESTORE, json: { ...result, newVersion: 5 } }]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({
      name: 'restore_flag_version',
      arguments: { ...where, version: 3, dry_run: false, etag: given },
    });
    expect((calls[0].body as { expectedETag: string }).expectedETag).toBe(sent);
  });

  it('restore_flag_version_sends_reason_and_freeze_override_as_headers', async () => {
    const { api, calls } = mockApi([{ method: 'POST', path: RESTORE, json: result }]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({
      name: 'restore_flag_version',
      arguments: { ...where, version: 3, dry_run: false, etag: '"e1"', reason: 'Incident 42', freeze_override: true },
    });
    expect(calls[0].headers['X-Intent-Reason']).toBe(encodeURIComponent('Incident 42'));
    expect(calls[0].headers['X-Freeze-Override']).toBe('true');
    expect(calls[0].body).not.toHaveProperty('reason');
  });

  it('restore_flag_version_apply_without_etag_refuses_without_calling_api', async () => {
    const { api, calls } = mockApi([{ method: 'POST', path: RESTORE, json: result }]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({ name: 'restore_flag_version', arguments: { ...where, version: 3, dry_run: false } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Applying needs the preview's targetETag as etag");
    expect(text(r)).toContain('call restore_flag_version with dry_run: true first, then apply with its etag');
    expect(calls).toHaveLength(0);
  });

  it('restore_flag_version_freeze_override_without_reason_refuses_without_calling_api', async () => {
    const { api, calls } = mockApi([{ method: 'POST', path: RESTORE, json: result }]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({
      name: 'restore_flag_version',
      arguments: { ...where, version: 3, dry_run: false, etag: '"e1"', freeze_override: true },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('freeze_override requires reason');
    expect(calls).toHaveLength(0);
  });

  it('restore_flag_version_stale_etag_says_preview_again', async () => {
    const { api } = mockApi([
      { method: 'POST', path: RESTORE, status: 412, json: { error: 'precondition_failed', message: 'changed' } },
    ]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({
      name: 'restore_flag_version',
      arguments: { ...where, version: 3, dry_run: false, etag: '"e1"' },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('dry_run: true');
    expect(text(r)).toContain('new targetETag as etag');
    expect(text(r)).not.toContain('ifMatch');
  });

  it('restore_flag_version_is_destructive_and_says_what_it_restores', async () => {
    const client = await connectClient({ api: mockApi([]).api, org: ORG });
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'restore_flag_version')!;
    expect(tool.annotations?.destructiveHint).toBe(true);
    expect(tool.description).toContain('include_state');
    expect(tool.description).toContain('Pro plan');
    expect(tool.description).toContain("preview's targetETag as etag");
    const etag = (tool.inputSchema.properties as Record<string, { description?: string }>).etag;
    expect(etag.description).toContain('targetETag from the preview');
    const list = tools.find((t) => t.name === 'list_flag_versions')!;
    expect(list.annotations?.readOnlyHint).toBe(true);
  });
});

describe('X-Featureflip-Client', () => {
  it('every tool request says it comes from the MCP server, with its version', async () => {
    const { api, calls } = mockApi([
      { method: 'GET', path: VERSIONS, json: { items: [] } },
      { method: 'POST', path: RESTORE, json: result },
    ]);
    const client = await connectClient({ api, org: ORG });
    await client.callTool({ name: 'list_flag_versions', arguments: where });
    await client.callTool({ name: 'restore_flag_version', arguments: { ...where, version: 3 } });
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c.headers['X-Featureflip-Client'], c.url).toBe(`mcp/${pkg.version}`);
  });
});
