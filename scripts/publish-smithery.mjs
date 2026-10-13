#!/usr/bin/env node
// Publishes a released MCP Bundle (.mcpb) to Smithery, which lists a stdio
// server only as a bundle and keeps whichever one was published last (#2588).
//
// This calls Smithery's release API directly instead of `smithery mcp publish`,
// because the CLI (4.11.1) cannot publish a bundle that lists its tools. It
// forwards manifest.json's `tools` as the registry's MCP tools, which require
// `inputSchema`, and the MCPB manifest schema forbids `inputSchema` on a tool:
// every bundle with tools fails with one 400 per tool
// (smithery-ai/cli#787, #806, #814, #818; fixes #789/#791 are unmerged). The
// CLI's documented way out is to drop `tools`, which leaves the listing reading
// "No capabilities found". So the tools sent here are read off the bundle
// itself over stdio, schemas included, the same way build-mcpb.mjs checks them.
//
// The request is the one the CLI makes: a multipart PUT of `payload` (JSON) and
// `bundle` (the file) to /servers/<namespace>%2F<name>/releases, creating the
// server on a 404, then polling the release until Smithery settles it. The
// listing's name, homepage and icon are set afterwards from the manifest.
//
// Usage: SMITHERY_API_KEY=... node scripts/publish-smithery.mjs <bundle.mcpb> <namespace/name>
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const API = process.env.SMITHERY_BASE_URL ?? 'https://api.smithery.ai';
const FAILED = ['FAILURE', 'FAILURE_SCAN', 'INTERNAL_ERROR', 'CANCELLED'];
// The bundle carries icon.png, but Smithery takes the listing icon as a URL.
const ICON_URL = 'https://featureflip.io/brand/logo-512.png';

// MCPB `user_config` → the JSON Schema Smithery shows as the install form. Same
// conversion as the CLI's, for the flat keys a manifest uses.
export function toConfigSchema(userConfig) {
  if (!userConfig || Object.keys(userConfig).length === 0) return undefined;
  const properties = {};
  const required = [];
  for (const [key, field] of Object.entries(userConfig)) {
    const type = field.type === 'directory' || field.type === 'file' ? 'string' : field.type;
    const meta = {
      ...(field.title ? { title: field.title } : {}),
      ...(field.description ? { description: field.description } : {}),
      ...(field.default !== undefined ? { default: field.default } : {}),
    };
    properties[key] = field.multiple ? { type: 'array', items: { type }, ...meta } : { type, ...meta };
    if (field.required) required.push(key);
  }
  return { type: 'object', properties, required };
}

export function buildPayload(manifest, tools) {
  const runtime = manifest.server?.type;
  if (runtime !== 'node') throw new Error(`unsupported bundle runtime: ${runtime}`);
  const configSchema = toConfigSchema(manifest.user_config);
  return {
    type: 'stdio',
    runtime,
    serverCard: {
      serverInfo: { name: manifest.name, version: manifest.version },
      tools,
    },
    ...(configSchema ? { configSchema } : {}),
  };
}

// A release sets only what the server runs. The listing itself (its name, the
// homepage link that makes it worth having, the icon) is a separate PATCH, and a
// server created on first publish has none of it. Sent on every publish, so the
// manifest stays the one place it is written.
export function buildServerUpdate(manifest) {
  return {
    displayName: manifest.display_name ?? manifest.name,
    description: manifest.description,
    homepage: manifest.homepage,
    repositoryUrl: manifest.repository?.url?.replace(/\.git$/, ''),
    license: manifest.license,
    iconUrl: ICON_URL,
  };
}

// Started the way build-mcpb.mjs starts it: PATH only, so neither a token nor
// SMITHERY_API_KEY reaches the server, and tools/list must answer anyway.
async function listTools(bundleDir, manifest) {
  const args = manifest.server.mcp_config.args.map((a) => a.replaceAll('${__dirname}', bundleDir));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    env: { PATH: process.env.PATH ?? '' },
  });
  const client = new Client({ name: 'smithery-publish', version: '0.0.0' });

  const timeout = setTimeout(() => {
    console.error(`[publish-smithery] ${bundleDir} did not complete the MCP handshake within 60s`);
    process.exit(1);
  }, 60_000);
  timeout.unref();

  await client.connect(transport);
  const tools = [];
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  await client.close();
  clearTimeout(timeout);

  // The manifest's list is what Claude Desktop shows; the two must agree.
  const listed = manifest.tools.map((t) => t.name).sort();
  const served = tools.map((t) => t.name).sort();
  if (listed.join('\n') !== served.join('\n')) {
    throw new Error(`tools/list does not match the bundle manifest:\n  manifest: ${listed}\n  served:   ${served}`);
  }
  return tools;
}

async function api(method, path, apiKey, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body instanceof FormData ? body : body && JSON.stringify(body),
    // A request that never answers must fail the step, not hold it to the job timeout.
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, body: text ? safeJson(text) : null, text };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function main() {
  const [bundleArg, name] = process.argv.slice(2);
  const apiKey = process.env.SMITHERY_API_KEY;
  if (!bundleArg || !name?.includes('/')) {
    console.error('usage: publish-smithery.mjs <bundle.mcpb> <namespace/name>');
    process.exit(2);
  }
  if (!apiKey) {
    console.error('[publish-smithery] SMITHERY_API_KEY is not set');
    process.exit(2);
  }
  const bundle = resolve(bundleArg);
  const server = encodeURIComponent(name);

  const dir = await mkdtemp(join(tmpdir(), 'featureflip-smithery-'));
  let payload;
  let update;
  try {
    execFileSync('unzip', ['-q', bundle, '-d', dir], { stdio: 'inherit' });
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    payload = buildPayload(manifest, await listTools(dir, manifest));
    update = buildServerUpdate(manifest);
    console.log(`[publish-smithery] ${name} v${manifest.version}, ${payload.serverCard.tools.length} tools`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const form = () => {
    const f = new FormData();
    f.append('payload', JSON.stringify(payload));
    return readFile(bundle).then((buf) => {
      f.append('bundle', new File([buf], basename(bundle)));
      return f;
    });
  };

  let res = await api('PUT', `/servers/${server}/releases`, apiKey, await form());
  if (res.status === 404) {
    // First publish. The server is created on demand, the namespace never is.
    const created = await api('PUT', `/servers/${server}`, apiKey, {});
    if (!created.ok) {
      throw new Error(`creating ${name} failed: ${created.status} ${created.text}`);
    }
    console.log(`[publish-smithery] created ${name}`);
    res = await api('PUT', `/servers/${server}/releases`, apiKey, await form());
  }
  if (!res.ok) throw new Error(`release upload failed: ${res.status} ${res.text}`);

  const { deploymentId } = res.body;
  console.log(`[publish-smithery] release ${deploymentId} accepted (${res.body.status})`);

  // A stdio release usually settles in the PUT itself. Otherwise poll, with a
  // deadline of our own, since a release that never settles must not pass.
  let release = res.body;
  let seen = 0;
  const deadline = Date.now() + 8 * 60_000;
  while (release.status !== 'SUCCESS') {
    if (FAILED.includes(release.status)) {
      const reason = release.logs?.find((l) => l.level === 'error')?.message ?? release.status;
      throw new Error(`release ${deploymentId} failed: ${reason}`);
    }
    if (Date.now() > deadline) throw new Error(`release ${deploymentId} still ${release.status} after 8 minutes`);
    await new Promise((r) => setTimeout(r, 3_000));
    const got = await api('GET', `/servers/${server}/releases/${deploymentId}`, apiKey);
    if (!got.ok) throw new Error(`polling release ${deploymentId} failed: ${got.status} ${got.text}`);
    release = got.body;
    for (const log of (release.logs ?? []).slice(seen)) console.log(`  [${log.stage}] ${log.message}`);
    seen = release.logs?.length ?? seen;
  }

  const patched = await api('PATCH', `/servers/${server}`, apiKey, update);
  if (!patched.ok) throw new Error(`updating the listing failed: ${patched.status} ${patched.text}`);
  console.log(`[publish-smithery] listing set: ${update.displayName}, homepage ${update.homepage}`);
  console.log(`[publish-smithery] ok, https://smithery.ai/servers/${name}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[publish-smithery] ${err.message}`);
    process.exit(1);
  });
}
