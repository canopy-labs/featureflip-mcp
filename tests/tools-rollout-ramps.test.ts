import { describe, it, expect } from 'vitest';
import { mockApi, connectClient } from './helpers.js';

const ORG = 'acme';
const ENV = `/api/v1/orgs/${ORG}/projects/web/flags/checkout/environments/production`;
const RAMPS = `${ENV}/ramps`;
const RAMP_ID = '0b6f1c1e-6a39-4d55-9f3e-1f0f2b3c4d5e';
const RULE_ID = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const VARIATION_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const ETAG = '"r-abc"';
const text = (r: { content: unknown }) => (r.content as { text: string }[])[0].text;
const where = { project: 'web', flag: 'checkout', environment: 'production' };
const refused = async (p: Promise<{ isError?: unknown }>) => {
  try {
    return (await p).isError === true;
  } catch {
    return true;
  }
};

const ramp = (overrides: Record<string, unknown> = {}) => ({
  id: RAMP_ID,
  ruleId: RULE_ID,
  isDefaultRule: false,
  targetVariationId: null,
  status: 'Running',
  steps: [
    { percent: 5, holdMinutes: 60 },
    { percent: 100, holdMinutes: 0 },
  ],
  currentStepIndex: 0,
  nextStepAt: '2026-11-10T13:00:00Z',
  pausedReason: null,
  pausedDetail: null,
  startedByName: 'Ada',
  createdAt: '2026-11-10T12:00:00Z',
  completedAt: null,
  abortedAt: null,
  ...overrides,
});
const steps = [
  { percent: 5, holdMinutes: 60 },
  { percent: 100, holdMinutes: 0 },
];

describe('rollout ramp tools', () => {
  it('list_rollout_ramps passes the list through and is read-only', async () => {
    const { api, calls } = mockApi([{ method: 'GET', path: RAMPS, json: { items: [ramp()], next_cursor: null } }]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({ name: 'list_rollout_ramps', arguments: { ...where, limit: 5 } });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r)).items[0].status).toBe('Running');
    expect(calls[0].url).toContain('limit=5');
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'list_rollout_ramps')?.annotations?.readOnlyHint).toBe(true);
  });

  it('list_rollout_ramps with ramp gets that ramp with its etag', async () => {
    const { api } = mockApi([{ method: 'GET', path: `${RAMPS}/${RAMP_ID}`, json: ramp(), headers: { etag: ETAG } }]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({ name: 'list_rollout_ramps', arguments: { ...where, ramp: RAMP_ID } });
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(text(r));
    expect(body.id).toBe(RAMP_ID);
    expect(body.etag).toBe(ETAG);
  });

  it('a ramp that is not an id is refused before the call', async () => {
    const { api, calls } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({ name: 'list_rollout_ramps', arguments: { ...where, ramp: 'my-ramp' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/must be an id/);
    expect(calls).toHaveLength(0);
  });

  it('start on a rule posts the steps to the rule, with idempotency key and reason', async () => {
    const { api, calls } = mockApi([
      { method: 'POST', path: `${ENV}/rules/${RULE_ID}/ramp`, status: 201, json: ramp(), headers: { etag: ETAG } },
    ]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({
      name: 'manage_rollout_ramp',
      arguments: { action: 'start', ...where, rule: RULE_ID, steps, reason: 'checkout v2', idempotency_key: 'k-1' },
    });
    expect(r.isError).toBeFalsy();
    expect(calls[0].body).toEqual({ steps });
    expect(calls[0].headers['Idempotency-Key']).toBe('k-1');
    expect(calls[0].headers['X-Intent-Reason']).toBe('checkout%20v2');
    expect(JSON.parse(text(r)).etag).toBe(ETAG);
  });

  it('start on rule="default" posts to the default rule with variation and bucketBy', async () => {
    const { api, calls } = mockApi([
      {
        method: 'POST',
        path: `${ENV}/default-rule/ramp`,
        status: 201,
        json: ramp({ ruleId: null, isDefaultRule: true, targetVariationId: VARIATION_ID }),
      },
    ]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({
      name: 'manage_rollout_ramp',
      arguments: { action: 'start', ...where, rule: 'default', steps, variation: VARIATION_ID, bucketBy: 'accountId' },
    });
    expect(r.isError).toBeFalsy();
    expect(calls[0].body).toEqual({ steps, variationId: VARIATION_ID, bucketBy: 'accountId' });
  });

  it('start without rule or steps, or with a rule that is not an id, makes no request', async () => {
    const { api, calls } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    const noSteps = await client.callTool({ name: 'manage_rollout_ramp', arguments: { action: 'start', ...where, rule: RULE_ID } });
    expect(noSteps.isError).toBe(true);
    const badRule = await client.callTool({ name: 'manage_rollout_ramp', arguments: { action: 'start', ...where, rule: 'beta', steps } });
    expect(badRule.isError).toBe(true);
    expect(text(badRule)).toMatch(/rule="default"/);
    expect(calls).toHaveLength(0);
  });

  it('variation and bucketBy on a rule ramp are refused instead of dropped', async () => {
    const { api, calls } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({
      name: 'manage_rollout_ramp',
      arguments: { action: 'start', ...where, rule: RULE_ID, steps, variation: VARIATION_ID },
    });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('rejects a step percent above 100 before calling the API', async () => {
    const { api, calls } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    expect(
      await refused(
        client.callTool({
          name: 'manage_rollout_ramp',
          arguments: { action: 'start', ...where, rule: RULE_ID, steps: [{ percent: 150, holdMinutes: 60 }] },
        }),
      ),
    ).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('pause posts with no body and passes ifMatch through, returning the written etag', async () => {
    const { api, calls } = mockApi([
      { method: 'POST', path: `${RAMPS}/${RAMP_ID}/pause`, json: ramp({ status: 'Paused' }), headers: { etag: '"r-new"' } },
    ]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({ name: 'manage_rollout_ramp', arguments: { action: 'pause', ...where, ramp: RAMP_ID, ifMatch: ETAG } });
    expect(r.isError).toBeFalsy();
    expect(calls[0].body).toBeUndefined();
    expect(calls[0].headers['If-Match']).toBe(ETAG);
    expect(JSON.parse(text(r))).toMatchObject({ status: 'Paused', etag: '"r-new"' });
  });

  it('resume posts to resume', async () => {
    const { api, calls } = mockApi([{ method: 'POST', path: `${RAMPS}/${RAMP_ID}/resume`, json: ramp() }]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({ name: 'manage_rollout_ramp', arguments: { action: 'resume', ...where, ramp: RAMP_ID } });
    expect(r.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
  });

  it('advance sends expectedStepIndex and refuses without it', async () => {
    const { api, calls } = mockApi([
      { method: 'POST', path: `${RAMPS}/${RAMP_ID}/advance`, json: ramp({ currentStepIndex: 1 }) },
    ]);
    const client = await connectClient({ api, org: ORG });
    const missing = await client.callTool({ name: 'manage_rollout_ramp', arguments: { action: 'advance', ...where, ramp: RAMP_ID } });
    expect(missing.isError).toBe(true);
    expect(calls).toHaveLength(0);
    const r = await client.callTool({
      name: 'manage_rollout_ramp',
      arguments: { action: 'advance', ...where, ramp: RAMP_ID, expectedStepIndex: 0 },
    });
    expect(r.isError).toBeFalsy();
    expect(calls[0].body).toEqual({ expectedStepIndex: 0 });
  });

  it('abort sends percent and refuses without it', async () => {
    const { api, calls } = mockApi([
      { method: 'POST', path: `${RAMPS}/${RAMP_ID}/abort`, json: ramp({ status: 'Aborted' }) },
    ]);
    const client = await connectClient({ api, org: ORG });
    const missing = await client.callTool({ name: 'manage_rollout_ramp', arguments: { action: 'abort', ...where, ramp: RAMP_ID } });
    expect(missing.isError).toBe(true);
    expect(calls).toHaveLength(0);
    const r = await client.callTool({ name: 'manage_rollout_ramp', arguments: { action: 'abort', ...where, ramp: RAMP_ID, percent: 0 } });
    expect(r.isError).toBeFalsy();
    expect(calls[0].body).toEqual({ percent: 0 });
  });

  it('a write without ramp is refused before the call', async () => {
    const { api, calls } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({ name: 'manage_rollout_ramp', arguments: { action: 'pause', ...where } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/requires ramp/);
    expect(calls).toHaveLength(0);
  });

  it('manage_rollout_ramp is destructive', async () => {
    const { api } = mockApi([]);
    const client = await connectClient({ api, org: ORG });
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'manage_rollout_ramp')?.annotations?.destructiveHint).toBe(true);
  });

  // RolloutRampStartChecks.EnsureCanStartAsync throws BadRequestException for both gates: a 400 bad_request
  // whose message starts with the code.
  it('explains PLAN_FEATURE_UNAVAILABLE on start', async () => {
    const { api } = mockApi([
      {
        method: 'POST',
        path: `${ENV}/rules/${RULE_ID}/ramp`,
        status: 400,
        json: { error: 'bad_request', message: 'PLAN_FEATURE_UNAVAILABLE: Rollout ramps are available on the Team plan and above.' },
      },
    ]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({ name: 'manage_rollout_ramp', arguments: { action: 'start', ...where, rule: RULE_ID, steps } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Team plan or above/);
    expect(text(r)).toMatch(/paused or aborted/);
  });

  it('explains FEATURE_NOT_ENABLED on start', async () => {
    const { api } = mockApi([
      {
        method: 'POST',
        path: `${ENV}/default-rule/ramp`,
        status: 400,
        json: { error: 'bad_request', message: 'FEATURE_NOT_ENABLED: Rollout ramps are not enabled.' },
      },
    ]);
    const client = await connectClient({ api, org: ORG });
    const r = await client.callTool({ name: 'manage_rollout_ramp', arguments: { action: 'start', ...where, rule: 'default', steps } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not enabled for this organization yet/);
  });
});
