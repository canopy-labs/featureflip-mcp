import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('throws with setup guidance when FEATUREFLIP_TOKEN is missing', () => {
    expect(() => loadConfig({})).toThrowError(/FEATUREFLIP_TOKEN/);
    expect(() => loadConfig({ FEATUREFLIP_TOKEN: '  ' })).toThrowError(/API Tokens/);
  });

  it('defaults baseUrl and strips trailing slashes', () => {
    const cfg = loadConfig({ FEATUREFLIP_TOKEN: 'ffp_abc' });
    expect(cfg).toEqual({ token: 'ffp_abc', baseUrl: 'https://api.featureflip.io', org: undefined });
    expect(loadConfig({ FEATUREFLIP_TOKEN: 'ffp_abc', FEATUREFLIP_API_URL: 'http://localhost:5000/' }).baseUrl)
      .toBe('http://localhost:5000');
  });

  it('passes through FEATUREFLIP_ORG', () => {
    expect(loadConfig({ FEATUREFLIP_TOKEN: 'ffs_x', FEATUREFLIP_ORG: 'acme' }).org).toBe('acme');
  });
});
