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
        'A flag whose expiry date (set_flag_expiry) has passed is always a candidate, however recently it was edited; ' +
        'if it is on in some environments and off in others its reason is past-expiry, meaning the owner has to ' +
        'decide which way to fold it. Every result carries expiresAtUtc and expired. ' +
        `Checks at most ${MAX_CANDIDATES} candidates per call, expired flags first.`,
      inputSchema: z.object({
        project: z.string(),
        days: z.number().int().min(1).optional().default(30).describe('Minimum age in days since last update'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ project, days }) =>
      run(async () => {
        const base = `/api/v1/orgs/${enc(ctx.org)}/projects/${enc(project)}/flags`;
        const now = Date.now();
        const cutoff = now - days * 24 * 60 * 60 * 1000;
        // expiresAtUtc is absent against an API that predates flag expiry; that reads as "no expiry".
        const isExpired = (f: FlagListItem) => !!f.expiresAtUtc && new Date(f.expiresAtUtc).getTime() <= now;

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
                !!f.key &&
                !!f.name &&
                !!f.updatedAt &&
                // A passed expiry date is declared intent, so a recent edit doesn't excuse it.
                (new Date(f.updatedAt).getTime() < cutoff || isExpired(f)),
            ),
          );
          cursor = page.next_cursor ?? undefined;
        } while (cursor);

        // Expired flags go first so the candidate cap can never drop them (stable sort keeps list order otherwise).
        candidates.sort((a, b) => Number(isExpired(b)) - Number(isExpired(a)));
        const truncated = candidates.length > MAX_CANDIDATES;
        const toCheck = candidates.slice(0, MAX_CANDIDATES);

        const stale: {
          key: string;
          name: string;
          updatedAt: string;
          expiresAtUtc: string | null;
          expired: boolean;
          reason: string;
          environments: number;
        }[] = [];
        for (const f of toCheck) {
          // GET .../environments returns a bare JSON array of EnvState, not { items: [...] }
          const envs = await ctx.api.request<EnvState[]>('GET', `${base}/${enc(f.key)}/environments`);
          if (envs.length === 0) continue;
          const expired = isExpired(f);
          const allOn = envs.every((e) => e.isEnabled);
          const allOff = envs.every((e) => !e.isEnabled);
          // A mixed flag has no obvious fold direction, so it only surfaces once its owner's date has passed.
          if (!allOn && !allOff && !expired) continue;
          stale.push({
            key: f.key,
            name: f.name,
            updatedAt: f.updatedAt,
            expiresAtUtc: f.expiresAtUtc ?? null,
            expired,
            reason: allOn ? 'enabled-everywhere' : allOff ? 'disabled-everywhere' : 'past-expiry',
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
