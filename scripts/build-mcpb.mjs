#!/usr/bin/env node
// Packs the built server as an MCP Bundle (.mcpb): the archive Claude Desktop
// installs in one click, and the only way Smithery lists a stdio server (its
// other route is a hosted Streamable HTTP endpoint, which we do not run — #2588).
//
// Run after `npm run build`. The bundle is dist/ + bin/ + the runtime
// dependencies, with manifest.json on top. Two fields of that manifest are
// never committed, so neither can drift from what actually ships:
//   - `version` comes from package.json, which the publish and mirror workflows
//     patch from the release tag.
//   - `tools` is read off the staged server over stdio, then checked against
//     tests/expected-tools.json the same way scripts/docker-smoke.mjs checks
//     the container.
//
// The packed file is then unpacked into a fresh directory and enumerated a
// second time, so what this script proves is the artifact, not the staging tree.
//
// icon.png is a copy of apps/landing/public/brand/logo-512.png, committed here
// because the bundle is built from this directory alone: the mirror carries no
// apps/, and Claude Desktop shows only an icon packed inside the bundle.
//
// Usage: node scripts/build-mcpb.mjs [output.mcpb]
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import EXPECTED_TOOLS from '../tests/expected-tools.json' with { type: 'json' };

// Pinned like every other tool a release job runs.
const MCPB_CLI = '@anthropic-ai/mcpb@2.1.2';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] ?? join(pkgDir, 'featureflip-mcp.mcpb'));

function mcpb(...args) {
  execFileSync('npx', ['--yes', MCPB_CLI, ...args], { stdio: 'inherit' });
}

// Same contract as docker-smoke.mjs: no FEATUREFLIP_* in the environment, the
// way a registry or a first-run client starts it, and tools/list must answer.
async function listTools(bundleDir) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(bundleDir, 'bin', 'featureflip-mcp.mjs')],
    env: { PATH: process.env.PATH ?? '' },
  });
  const client = new Client({ name: 'mcpb-build', version: '0.0.0' });

  const timeout = setTimeout(() => {
    console.error(`[build-mcpb] ${bundleDir} did not complete the MCP handshake within 60s`);
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
    throw new Error(
      `tools/list from ${bundleDir} did not match tests/expected-tools.json` +
        (missing.length ? `\n  missing:    ${missing.join(', ')}` : '') +
        (unexpected.length ? `\n  unexpected: ${unexpected.join(', ')}` : ''),
    );
  }
  return tools;
}

const pkg = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(pkgDir, 'manifest.json'), 'utf8'));

const stage = await mkdtemp(join(tmpdir(), 'featureflip-mcpb-'));
const unpacked = await mkdtemp(join(tmpdir(), 'featureflip-mcpb-check-'));
try {
  await cp(join(pkgDir, 'bin'), join(stage, 'bin'), { recursive: true });
  // Declarations are for the npm package's importers. A bundle is only ever run.
  await cp(join(pkgDir, 'dist'), join(stage, 'dist'), {
    recursive: true,
    filter: (src) => !src.endsWith('.d.ts'),
  });
  await cp(join(pkgDir, 'icon.png'), join(stage, 'icon.png'));
  await cp(join(pkgDir, 'LICENSE'), join(stage, 'LICENSE'));
  await cp(join(pkgDir, 'README.md'), join(stage, 'README.md'));

  // Runtime dependencies only, with no scripts to run on install. There is no
  // lockfile to install from here: the one governing this package is the
  // monorepo root's. Same trade the Dockerfile makes, for the same reason.
  const { devDependencies: _dev, scripts: _scripts, ...runtimePkg } = pkg;
  await writeFile(join(stage, 'package.json'), `${JSON.stringify(runtimePkg, null, 2)}\n`);
  execFileSync(
    'npm',
    ['install', '--omit=dev', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund'],
    { cwd: stage, stdio: 'inherit' },
  );

  const tools = await listTools(stage);
  manifest.version = pkg.version;
  manifest.tools = tools.map((t) => ({ name: t.name, description: t.description ?? '' }));
  await writeFile(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  mcpb('validate', join(stage, 'manifest.json'));
  await rm(output, { force: true });
  mcpb('pack', stage, output);

  mcpb('unpack', output, unpacked);
  await listTools(unpacked);

  console.log(`[build-mcpb] ok — ${output} (v${pkg.version}, ${tools.length} tools)`);
} finally {
  await rm(stage, { recursive: true, force: true });
  await rm(unpacked, { recursive: true, force: true });
}
