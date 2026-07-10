import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { enc } from '../../client.js';
import { okJson, run } from '../../errors.js';
import type { ToolContext } from '../context.js';
import type { components } from '../../generated/api-types.js';

type FlagListItem = components['schemas']['PublicFlagListItem'];
type FlagListPage = components['schemas']['PublicFlagListItemPagedResult'];
// The environments endpoint returns the same PublicFlagEnvConfigResponse shape used by
// flag_status — only environmentKey/isEnabled are consumed here.
type EnvState = components['schemas']['PublicFlagEnvConfigResponse'];

const MAX_CANDIDATES = 50;

export function registerStaleFlagTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'find_stale_flags',
    {
      title: 'Find stale flags',
      description:
        'Find flags that look ready for code cleanup: not updated in N days AND either enabled in every environment ' +
        '(verify rollout is complete before removing — per-rule percentage ramps are not inspected) ' +
        'or disabled in every environment (dead — remove flag and code path). ' +
        `Checks at most ${MAX_CANDIDATES} candidates per call.`,
      inputSchema: z.object({
        project: z.string(),
        days: z.number().int().min(1).optional().default(30).describe('Minimum age in days since last update'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ project, days }) =>
      run(async () => {
        const base = `/api/v1/orgs/${enc(ctx.org)}/projects/${enc(project)}/flags`;
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

        // Only candidates with a key/name/updatedAt we can act on are useful here; the generated
        // types mark these optional/nullable (mirroring C# nullable-reference metadata) even though
        // the real API always populates them for list items.
        const candidates: (FlagListItem & { key: string; name: string; updatedAt: string })[] = [];
        let cursor: string | undefined;
        do {
          const page = await ctx.api.request<FlagListPage>('GET', base, {
            query: { archived: false, limit: 100, cursor },
          });
          candidates.push(
            ...(page.items ?? []).filter(
              (f): f is FlagListItem & { key: string; name: string; updatedAt: string } =>
                !!f.key && !!f.name && !!f.updatedAt && new Date(f.updatedAt).getTime() < cutoff,
            ),
          );
          cursor = page.next_cursor ?? undefined;
        } while (cursor);

        const truncated = candidates.length > MAX_CANDIDATES;
        const toCheck = candidates.slice(0, MAX_CANDIDATES);

        const stale: { key: string; name: string; updatedAt: string; reason: string; environments: number }[] = [];
        for (const f of toCheck) {
          // GET .../environments returns a bare JSON array of EnvState, not { items: [...] }
          const envs = await ctx.api.request<EnvState[]>('GET', `${base}/${enc(f.key)}/environments`);
          if (envs.length === 0) continue;
          const allOn = envs.every((e) => e.isEnabled);
          const allOff = envs.every((e) => !e.isEnabled);
          if (!allOn && !allOff) continue;
          stale.push({
            key: f.key,
            name: f.name,
            updatedAt: f.updatedAt,
            reason: allOn ? 'enabled-everywhere' : 'disabled-everywhere',
            environments: envs.length,
          });
        }

        return okJson({
          project,
          olderThanDays: days,
          checked: toCheck.length,
          truncated,
          ...(truncated ? { note: `Only the first ${MAX_CANDIDATES} of ${candidates.length} candidates were checked.` } : {}),
          stale,
        });
      }),
  );
}
