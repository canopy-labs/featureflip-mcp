import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { enc } from '../client.js';
import { errorResult, okJson, run } from '../errors.js';
import type { ToolContext } from './context.js';
import { ifMatchParam, withEtag, writtenEtagOutput } from './etag.js';
import { endpoint, oneOfOutputs, shape } from './outputs.js';
import { pagination, projectParam } from './params.js';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROUTE = 'GET /api/v1/orgs/{org}/change-freezes';

const notAnId = (field: string, value: string) =>
  errorResult(new Error(`${field} must be a UUID, not "${value}". See list_change_freezes.`));

export function registerChangeFreezeTools(server: McpServer, ctx: ToolContext): void {
  const base = () => `/api/v1/orgs/${enc(ctx.org)}/change-freezes`;

  server.registerTool(
    'list_change_freezes',
    {
      title: 'List change freezes',
      description:
        'List change freeze windows, or get one by passing freeze_id. A freeze blocks flag changes in the ' +
        'environments it covers (toggles, targeting, ramps, copies) until it ends; scheduled changes due inside it ' +
        'are held or failed per its policy. Filter by status (Upcoming, Active, Ended) and project. Each window ' +
        'shows its environments, end time, scheduledChangePolicy and the approvals that let scheduled changes ' +
        'through. A single get also returns an etag for manage_change_freeze action=update. Business plan and above.',
      inputSchema: z.object({
        freeze_id: z.string().optional().describe('Freeze id: get just that window instead of listing'),
        status: z.enum(['Upcoming', 'Active', 'Ended']).optional().describe('Only windows in this state'),
        project: projectParam.optional().describe('Only windows for this project key (project windows)'),
        ...pagination,
      }),
      outputSchema: oneOfOutputs(endpoint(ROUTE), endpoint(`${ROUTE}/{id}`)),
      annotations: { readOnlyHint: true },
    },
    async ({ freeze_id, status, project, limit, cursor }) =>
      run(async () => {
        if (freeze_id !== undefined && (status !== undefined || project !== undefined)) {
          return errorResult(new Error('freeze_id gets one window and cannot be combined with status or project filters'));
        }
        if (freeze_id === undefined) {
          return okJson(await ctx.api.request('GET', base(), { query: { status, project, limit, cursor } }));
        }
        if (!GUID.test(freeze_id)) return notAnId('freeze_id', freeze_id);
        return okJson(withEtag(await ctx.api.requestWithEtag('GET', `${base()}/${enc(freeze_id)}`)));
      }),
  );

  server.registerTool(
    'manage_change_freeze',
    {
      title: 'Create, edit, end, or delete a change freeze',
      description:
        'Manage change freeze windows. action=create makes a window: name + reason + environments (keys) or ' +
        'all_environments. Give starts_at and ends_at to schedule it; omit starts_at to start at once, and omit ' +
        'ends_at for an open-ended freeze (a scheduled window with starts_at needs ends_at). action=freeze_now starts ' +
        'at once and never takes starts_at; it may leave ends_at open until you end it. ' +
        'Pass project for a project window; omit it for an organization-wide one. scheduled_change_policy: Hold ' +
        '(default) keeps scheduled changes pending until the freeze ends, Fail fails them. action=update needs ' +
        'freeze_id and changes only the fields you pass (accepts ifMatch). action=end stops an active window now. ' +
        'action=delete removes an UPCOMING window. action=approve_scheduled_change (freeze_id + scheduled_change_id ' +
        '+ reason) lets one pending scheduled change apply inside the freeze; revoke_approval withdraws it. ' +
        'Needs the Business plan or above to create or approve, and an Admin token.',
      inputSchema: z.object({
        action: z
          .enum(['create', 'freeze_now', 'update', 'end', 'delete', 'approve_scheduled_change', 'revoke_approval'])
          .describe(
            'create and freeze_now need name + reason + environments or all_environments; update, end and delete need ' +
              'freeze_id; approve_scheduled_change needs freeze_id + scheduled_change_id + reason; revoke_approval needs ' +
              'freeze_id + scheduled_change_id',
          ),
        freeze_id: z.string().optional().describe('Freeze id (see list_change_freezes)'),
        name: z.string().optional().describe('Window name, e.g. "Black Friday code freeze"'),
        reason: z.string().optional().describe('Why the freeze exists (shown to people it blocks); for approve_scheduled_change, why the change may proceed'),
        project: projectParam.optional().describe('Project key for a project window; omit for organization-wide'),
        environments: z.array(z.string()).optional().describe('Environment keys the window covers, e.g. ["production"]'),
        all_environments: z.boolean().optional().describe('Cover every environment instead of listing them'),
        starts_at: z.string().optional().describe('ISO 8601 UTC start. create only: omit (or use freeze_now) to freeze immediately'),
        ends_at: z.string().optional().describe('ISO 8601 UTC end. On create: required when scheduling (with starts_at); omitting it with no starts_at makes an open-ended freeze. On update: omitting it leaves the end unchanged.'),
        scheduled_change_policy: z.enum(['Hold', 'Fail']).optional().describe('What happens to scheduled changes that come due inside the window (default Hold)'),
        scheduled_change_id: z.string().optional().describe('Scheduled change id, for approve_scheduled_change and revoke_approval'),
        ifMatch: ifMatchParam('list_change_freezes with freeze_id'),
        idempotency_key: z.string().uuid().optional().describe('Idempotency-Key (a UUID) for create, freeze_now, end and approve_scheduled_change'),
      }),
      outputSchema: oneOfOutputs(
        endpoint('POST /api/v1/orgs/{org}/change-freezes'),
        endpoint('PATCH /api/v1/orgs/{org}/change-freezes/{id}'),
        endpoint('POST /api/v1/orgs/{org}/change-freezes/{id}/approvals'),
        shape({ deleted: { type: 'string' }, etag: writtenEtagOutput }, ['deleted']),
      ),
      annotations: { destructiveHint: true },
    },
    async (a) =>
      run(async () => {
        const { action, freeze_id, name, reason, project, environments, all_environments, starts_at, ends_at } = a;
        const fail = (m: string) => errorResult(new Error(m));

        if (action === 'create' || action === 'freeze_now') {
          if (action === 'freeze_now' && starts_at) {
            return fail('freeze_now starts at once; use action=create with starts_at to schedule');
          }
          if (!name || !reason) return fail(`action=${action} requires name and reason`);
          if (!environments?.length && !all_environments) {
            return fail(`action=${action} requires environments (keys) or all_environments: true`);
          }
          if (action === 'create' && starts_at && !ends_at) {
            return fail('a scheduled freeze (starts_at set) requires ends_at; only freeze_now may be open-ended');
          }
          // freeze_now never sends startsAt: the server starts the window at once.
          const body = {
            name, reason, project,
            allEnvironments: all_environments ?? (environments?.length ? false : undefined),
            environmentKeys: environments,
            startsAt: action === 'create' ? starts_at : undefined,
            endsAt: ends_at,
            scheduledChangePolicy: a.scheduled_change_policy,
          };
          return okJson(await ctx.api.request('POST', base(), { body: compact(body), idempotencyKey: a.idempotency_key }));
        }

        if (!freeze_id) return fail(`action=${action} requires freeze_id (see list_change_freezes)`);
        if (!GUID.test(freeze_id)) return notAnId('freeze_id', freeze_id);
        const path = `${base()}/${enc(freeze_id)}`;

        if (action === 'update') {
          if (project !== undefined) return fail("a window's project cannot be changed; create a new window instead");
          const body = compact({
            name, reason, allEnvironments: all_environments, environmentKeys: environments,
            startsAt: starts_at, endsAt: ends_at, scheduledChangePolicy: a.scheduled_change_policy,
          });
          if (Object.keys(body).length === 0) return fail('action=update needs at least one field to change');
          return okJson(withEtag(await ctx.api.requestWithEtag('PATCH', path, { body, ifMatch: a.ifMatch })));
        }
        if (action === 'end') return okJson(await ctx.api.request('POST', `${path}/end`, { idempotencyKey: a.idempotency_key }));
        if (action === 'delete') {
          await ctx.api.request('DELETE', path);
          return okJson({ deleted: freeze_id });
        }

        const sc = a.scheduled_change_id;
        if (!sc) return fail(`action=${action} requires scheduled_change_id`);
        if (!GUID.test(sc)) return notAnId('scheduled_change_id', sc);
        if (action === 'approve_scheduled_change') {
          if (!reason) return fail('action=approve_scheduled_change requires reason');
          return okJson(
            await ctx.api.request('POST', `${path}/approvals`, {
              body: { scheduledChangeId: sc, reason },
              idempotencyKey: a.idempotency_key,
            }),
          );
        }
        await ctx.api.request('DELETE', `${path}/approvals/${enc(sc)}`);
        return okJson({ deleted: sc });
      }),
  );
}

function compact(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
