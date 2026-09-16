#!/usr/bin/env node
// Launches the built container exactly as an MCP registry inspector does —
// `docker run -i` over stdio, with NO credentials in the environment — and
// asserts it completes the handshake and enumerates the full tool surface.
//
// This covers a class the in-process tests structurally cannot: every test in
// tests/ imports src/ directly, so all of them pass even when the shipped
// artifact has no runnable entry point at all. That is exactly the state the
// public mirror was in — bin/featureflip-mcp.mjs imports ../dist/cli.mjs, which
// is build output the mirror never carries — and it is why Glama read
// `tools: []` and graded the server `Not graded` indefinitely.
//
// Usage: node scripts/docker-smoke.mjs [image-tag]
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import EXPECTED_TOOLS from '../tests/expected-tools.json' with { type: 'json' };

const image = process.argv[2] ?? 'featureflip-mcp:smoke';

const transport = new StdioClientTransport({
  command: 'docker',
  // No -e/--env: an inspector has no token, and tools/list must answer anyway.
  args: ['run', '--rm', '-i', image],
});

const client = new Client({ name: 'docker-smoke', version: '0.0.0' });

// A server that never opens the transport hangs here rather than failing, which
// in CI reads as a stuck job instead of a broken image. Fail loudly instead.
const timeout = setTimeout(() => {
  console.error(`[docker-smoke] ${image} did not complete the MCP handshake within 60s`);
  process.exit(1);
}, 60_000);
timeout.unref();

await client.connect(transport);
const { tools } = await client.listTools();
await client.close();
clearTimeout(timeout);

const actual = tools.map((t) => t.name).sort();
const expected = [...EXPECTED_TOOLS].sort();

if (actual.length !== expected.length || actual.some((name, i) => name !== expected[i])) {
  const missing = expected.filter((n) => !actual.includes(n));
  const unexpected = actual.filter((n) => !expected.includes(n));
  console.error(`[docker-smoke] tools/list did not match tests/expected-tools.json`);
  if (missing.length) console.error(`  missing:    ${missing.join(', ')}`);
  if (unexpected.length) console.error(`  unexpected: ${unexpected.join(', ')}`);
  process.exit(1);
}

console.log(
  `[docker-smoke] ok — ${actual.length} tools enumerated from ${image} with no credentials configured`,
);
