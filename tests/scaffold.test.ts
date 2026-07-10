import { describe, it, expect } from 'vitest';
import { PKG_VERSION } from '../src/index.js';
import pkg from '../package.json';

describe('package scaffold', () => {
  it('exposes the package version', () => {
    // publish-mcp.yml patches package.json to the tag version before running tests, so
    // asserting against a hardcoded '0.1.0' would fail on every future release tag.
    expect(PKG_VERSION).toBe(pkg.version);
    expect(PKG_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
