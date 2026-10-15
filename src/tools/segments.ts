import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { enc } from '../client.js';
import { errorResult, okJson, run } from '../errors.js';
import type { ToolContext } from './context.js';
import { apiOutput, apiOutputWith, endpoint, nullable, oneOfOutputs, shape } from './outputs.js';
import { etagOutput, ifMatchParam, withEtag, writtenEtagOutput } from './etag.js';
import { pagination, projectParam } from './params.js';

export function registerSegmentTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_segments',
    {
      title: 'List user segments',
      description:
        'List reusable user segments in a project. Segments are referenced from targeting rules via userSegmentId.',
      inputSchema: z.object({
        project: z.string().describe('Project key'),
        ...pagination,
      }),
      outputSchema: apiOutput('GET /api/v1/orgs/{org}/projects/{project}/segments'),
      annotations: { readOnlyHint: true },
    },
    async ({ project, limit, cursor }) =>
      run(async () =>
        okJson(
          await ctx.api.request(
            'GET',
            `/api/v1/orgs/${enc(ctx.org)}/projects/${enc(project)}/segments`,
            { query: { limit, cursor } },
          ),
        ),
      ),
  );

  server.registerTool(
    'get_segment',
    {
      title: 'Get user segment',
      description: 'Get one user segment (its conditions, id, and metadata) by key or id.',
      inputSchema: z.object({
        project: z.string().describe('Project key'),
        segment: z.string().describe('Segment key or id'),
      }),
      outputSchema: apiOutputWith('GET /api/v1/orgs/{org}/projects/{project}/segments/{segment}', { etag: etagOutput }),
      annotations: { readOnlyHint: true },
    },
    async ({ project, segment }) =>
      run(async () =>
        okJson(
          withEtag(
            await ctx.api.requestWithEtag<object>(
              'GET',
              `/api/v1/orgs/${enc(ctx.org)}/projects/${enc(project)}/segments/${enc(segment)}`,
            ),
          ),
        ),
      ),
  );

  const segmentCondition = z.object({
    attribute: z.string().describe('Context attribute name, e.g. plan, country, user_id'),
    operator: z
      .string()
      .describe(
        'Case-sensitive: Equals, NotEquals, Contains, NotContains, GreaterThan, LessThan, GreaterThanOrEqual, ' +
          'LessThanOrEqual, In, NotIn, MatchesRegex, StartsWith, EndsWith, Before, After, SemverEquals, ' +
          'SemverGreaterThan, SemverGreaterThanOrEqual, SemverLessThan, SemverLessThanOrEqual',
      ),
    values: z.array(z.string()).describe('Values compared against the attribute'),
    negate: z.boolean().optional().default(false).describe('Invert the match'),
  });
  type Condition = { attribute: string | null; operator: string | null; values: string[] | null; negate: boolean };
  // The GET body carries ids and _actions the PUT does not take; send only the request shape.
  const plain = (c: Condition) => ({ attribute: c.attribute, operator: c.operator, values: c.values, negate: c.negate });

  server.registerTool(
    'manage_segment',
    {
      title: 'Create, update, or delete a user segment',
      description:
        'Manage reusable user segments, which targeting rules reference by userSegmentId. action=create needs key + ' +
        'name (+ conditions); action=update needs segment and changes only the fields you pass (conditions replaces ' +
        'the whole list; description: "" clears it); action=delete needs segment. On update, pass ifMatch (the ' +
        'etag from get_segment) so a change someone made since you read it is not overwritten. ifMatch is ' +
        'rejected on create and delete: the API cannot make those conditional.',
      inputSchema: z.object({
        action: z.enum(['create', 'update', 'delete']).describe('create needs key + name; update and delete need segment'),
        project: projectParam,
        segment: z.string().optional().describe('Segment key or id; required for update and delete'),
        key: z.string().optional().describe('New segment key, required for create; immutable afterwards'),
        name: z.string().optional().describe('Display name; required for create'),
        description: z.string().optional().describe('What the segment means; "" clears it'),
        conditions: z
          .array(segmentCondition)
          .optional()
          .describe('Conditions a user must match to be in the segment; on update, replaces the whole list'),
        ifMatch: ifMatchParam('get_segment'),
      }),
      outputSchema: oneOfOutputs(
        endpoint('POST /api/v1/orgs/{org}/projects/{project}/segments'),
        shape(
          {
            segment: { type: 'string' },
            updated: { type: 'boolean' },
            name: nullable('string'),
            description: nullable('string'),
            conditions: { type: ['array', 'null'], items: { type: 'object' } },
            etag: writtenEtagOutput,
          },
          ['segment', 'updated'],
        ),
        shape({ deleted: { type: 'string' } }, ['deleted']),
      ),
      annotations: { destructiveHint: true },
    },
    async ({ action, project, segment, key, name, description, conditions, ifMatch }) =>
      run(async () => {
        const base = `/api/v1/orgs/${enc(ctx.org)}/projects/${enc(project)}/segments`;
        // The API refuses If-Match on POST and DELETE. Writing without it would quietly drop the
        // precondition the agent asked for, so a delete could erase a change made since its read.
        if (ifMatch !== undefined && action !== 'update') {
          return errorResult(
            new Error(`ifMatch is only supported on action=update; action=${action} cannot be made conditional`),
          );
        }
        if (action === 'create') {
          if (!key || !name) return errorResult(new Error('action=create requires key and name'));
          // POST returns 201 with the created segment — pass it through. The API requires conditions.
          return okJson(
            await ctx.api.request('POST', base, { body: { key, name, description, conditions: conditions ?? [] } }),
          );
        }
        if (!segment) return errorResult(new Error(`action=${action} requires segment (see list_segments)`));
        const path = `${base}/${enc(segment)}`;
        if (action === 'update') {
          const { data: current, etag: readEtag } = await ctx.api.requestWithEtag<{
            name: string | null;
            description: string | null;
            conditions: Condition[] | null;
          }>('GET', path);
          const body = {
            name: name ?? current.name,
            description: description ?? current.description,
            conditions: conditions ?? (current.conditions ?? []).map(plain),
          };
          // PUT returns 204 No Content — confirm what was applied instead.
          const { etag } = await ctx.api.requestWithEtag('PUT', path, { body, ifMatch: ifMatch ?? readEtag });
          return okJson(withEtag({ data: { segment, updated: true, ...body }, etag }));
        }
        // DELETE returns 204 No Content.
        await ctx.api.request('DELETE', path);
        return okJson({ deleted: segment });
      }),
  );
}
