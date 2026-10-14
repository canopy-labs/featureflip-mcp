import { ApiError } from './client.js';

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

export function okJson(data: unknown): ToolResult {
  const content: ToolResult['content'] = [{ type: 'text', text: JSON.stringify(data, null, 2) }];
  // Every tool declares an outputSchema (tools/outputs.ts), and the SDK refuses a result
  // without structuredContent once one is declared. It must be an object; every tool
  // returns one, and the text stays for clients that read only content.
  const isObject = data !== null && typeof data === 'object' && !Array.isArray(data);
  return isObject ? { content, structuredContent: data as Record<string, unknown> } : { content };
}

export function errorResult(err: unknown): ToolResult {
  if (err instanceof ApiError) {
    const e = err.envelope;
    const lines = [`Featureflip API error ${err.status} (${e.error}): ${e.message}`];
    if (e.fields) lines.push(`Field errors: ${JSON.stringify(e.fields)}`);
    if (e.did_you_mean?.length) lines.push(`Did you mean: ${e.did_you_mean.join(', ')}`);
    if (e.next_actions?.length) {
      lines.push(`Next actions: ${e.next_actions.map((a) => `${a.method} ${a.path}`).join('; ')}`);
    }
    if (e.retry_after != null) lines.push(`Rate limited — retry after ${e.retry_after}s.`);
    if (err.status === 404) {
      lines.push(
        'Note: 404 can also mean the public Management API is not enabled for this organization yet, ' +
          'or a service token does not include this project.',
      );
    }
    if (err.status === 412) {
      lines.push(
        'The resource changed since it was read. If you passed ifMatch, re-read it (get_flag / get_targeting / ' +
          'get_segment), re-apply your change to what you read, and retry with the new etag. Otherwise the tool ' +
          'read it itself and lost a race: call it again.',
      );
    }
    if (e.docs_url) lines.push(`Docs: ${e.docs_url}`);
    return { content: [{ type: 'text', text: lines.join('\n') }], isError: true };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

export async function run(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return errorResult(err);
  }
}
