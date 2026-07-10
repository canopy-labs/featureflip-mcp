import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { FeatureflipApi } from '../src/client.js';
import { createServer } from '../src/server.js';
import type { ToolContext } from '../src/tools/context.js';

export interface Route {
  method: string;
  path: string | RegExp;
  status?: number;
  json?: unknown;
}

export interface RecordedCall {
  method: string;
  url: string;
  body?: unknown;
}

export function mockApi(routes: Route[]): { api: FeatureflipApi; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const pathname = new URL(url).pathname;
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes.find(
      (r) =>
        r.method === method &&
        (typeof r.path === 'string' ? r.path === pathname : r.path.test(pathname)),
    );
    if (!route) {
      return new Response(
        JSON.stringify({ error: 'not_found', message: `no mock for ${method} ${pathname}` }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }
    const status = route.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(route.json ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  return { api: new FeatureflipApi({ token: 'ffp_test', baseUrl: 'https://api.test', fetchImpl }), calls };
}

export async function connectClient(ctx: ToolContext): Promise<Client> {
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}
