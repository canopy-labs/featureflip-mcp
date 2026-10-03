import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ApiError, enc } from '../../client.js';
import { okJson, run } from '../../errors.js';
import type { ToolContext } from '../context.js';
import { ownerFilter, resolveOwner } from '../owner.js';
import type { components } from '../../generated/api-types.js';

type FlagListItem = components['schemas']['PublicFlagListItem'];
type FlagOwner = components['schemas']['PublicFlagOwner'];
type FlagListPage = components['schemas']['PublicFlagListItemPagedResult'];
// The environments endpoint returns the same PublicFlagEnvConfigResponse shape used by
// flag_status — only environmentKey/isEnabled are consumed here.
type EnvState = components['schemas']['PublicFlagEnvConfigResponse'];
type CandidatePage = components['schemas']['PublicFlagRemovalCandidatePagedResult'];

const stalenessTier = z.enum(['dead', 'stale']);

// Shared by every tool that leads an agent towards removing or archiving a flag.
const DEPENDENTS_FIRST =
  'A flag that other live flags list as a prerequisite has to be removed LAST, dependents first: ' +
  'archiving it while a dependent still names it makes that dependent fail its prerequisite check and serve ' +
  'its off variation, so archive_flag refuses it with FLAG_HAS_DEPENDENTS.';

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
        'decide which way to fold it. Every result carries expiresAtUtc, expired and owner (null when unowned). ' +
        'Pass owner to see one person\'s stale flags ("me" for your own) or "none" for the unowned ones. ' +
        'Every result also carries blockedBy: the live flags that still list it as a prerequisite, which have to be ' +
        'removed and archived before it ([] when none). blockedBy is null when the server did not classify the ' +
        'flag as a removal candidate, which means unknown, not unblocked. ' +
        DEPENDENTS_FIRST +
        ` Checks at most ${MAX_CANDIDATES} candidates per call, expired flags first.`,
      inputSchema: z.object({
        project: z.string(),
        days: z.number().int().min(1).optional().default(30).describe('Minimum age in days since last update'),
        owner: ownerFilter,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ project, days, owner }) =>
      run(async () => {
        const ownerQuery = await resolveOwner(ctx, owner);
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
            query: { archived: false, limit: 100, cursor, owner: ownerQuery },
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
          owner: FlagOwner | null;
          reason: string;
          environments: number;
          blockedBy: string[] | null;
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
            // owner is absent against an API that predates flag ownership; that reads as unowned.
            owner: f.owner ?? null,
            reason: allOn ? 'enabled-everywhere' : allOff ? 'disabled-everywhere' : 'past-expiry',
            environments: envs.length,
            blockedBy: null,
          });
        }

        // The server names a flag's live dependents only on removal-candidates, so join that in. The
        // stale tier is the widest classification it offers; a stale flag outside it stays null (unknown).
        let blockedByNote: string | undefined;
        if (stale.length > 0) {
          try {
            const blockedBy = new Map<string, string[]>();
            let candidateCursor: string | undefined;
            do {
              const page = await ctx.api.request<CandidatePage>('GET', `${base}/removal-candidates`, {
                query: { staleness: 'stale', limit: 100, cursor: candidateCursor },
              });
              for (const c of page.items ?? []) {
                // blockedBy is absent against an API that predates it; that reads as unknown, not unblocked.
                if (c.key && c.blockedBy) blockedBy.set(c.key, c.blockedBy);
              }
              candidateCursor = page.next_cursor ?? undefined;
            } while (candidateCursor);
            for (const f of stale) f.blockedBy = blockedBy.get(f.key) ?? null;
          } catch (err) {
            // The stale report stands on its own, so a failed lookup degrades to "unknown" rather than an error.
            if (!(err instanceof ApiError)) throw err;
            blockedByNote =
              `Could not read removal-candidates (${err.status} ${err.envelope.error}), so blockedBy is unknown ` +
              'for every flag. archive_flag still refuses any flag that a live flag depends on (FLAG_HAS_DEPENDENTS).';
          }
        }

        return okJson({
          project,
          olderThanDays: days,
          ...(ownerQuery ? { owner: ownerQuery } : {}),
          checked: toCheck.length,
          truncated,
          ...(truncated ? { note: `Only the first ${MAX_CANDIDATES} of ${candidates.length} candidates were checked.` } : {}),
          ...(blockedByNote ? { blockedByNote } : {}),
          stale,
        });
      }),
  );

  server.registerTool(
    'list_removal_candidates',
    {
      title: 'List removal candidates',
      description:
        'List the flags the server is confident can be removed from code, the same list the Featureflip flag cleanup ' +
        'GitHub Action works from. Each item has key, reason, status (Dead or Stale), treatment (true = keep the ' +
        'on-branch, false = keep the off-branch) and blockedBy: the live flags that still list it as a ' +
        'prerequisite. Only remove a flag whose blockedBy is empty. ' +
        DEPENDENTS_FIRST +
        ' staleness "dead" (the default) returns only dead flags, "stale" adds stale ones. Paginated via cursor.',
      inputSchema: z.object({
        project: z.string().describe('Project key'),
        staleness: stalenessTier.optional().describe('Minimum staleness tier: dead (default) or stale'),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ project, ...query }) =>
      run(async () =>
        okJson(
          await ctx.api.request('GET', `/api/v1/orgs/${enc(ctx.org)}/projects/${enc(project)}/flags/removal-candidates`, {
            query,
          }),
        ),
      ),
  );
}
