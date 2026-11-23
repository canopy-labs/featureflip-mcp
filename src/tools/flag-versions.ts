import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { enc, quoteEtag } from '../client.js';
import { errorResult, okJson, run } from '../errors.js';
import type { ToolContext } from './context.js';
import { apiOutput } from './outputs.js';
import {
  environmentParam,
  flagParam,
  freezeOverrideError,
  freezeOverrideParam,
  pagination,
  projectParam,
  reasonParam,
} from './params.js';

export function registerFlagVersionTools(server: McpServer, ctx: ToolContext): void {
  const versionsPath = (project: string, flag: string, environment: string) =>
    `/api/v1/orgs/${enc(ctx.org)}/projects/${enc(project)}/flags/${enc(flag)}/environments/${enc(environment)}/versions`;

  server.registerTool(
    'list_flag_versions',
    {
      title: 'List flag versions',
      description:
        "List one flag's configuration history in one environment, newest first: each version's number, time, " +
        'author, source (dashboard, api, mcp, schedule, ...), reason, on/off state and, for a restore, the version ' +
        'it restored. Pass a version to restore_flag_version to put that configuration back.',
      inputSchema: z.object({
        project: projectParam,
        flag: flagParam,
        environment: environmentParam,
        ...pagination,
      }),
      outputSchema: apiOutput('GET /api/v1/orgs/{org}/projects/{project}/flags/{flag}/environments/{env}/versions'),
      annotations: { readOnlyHint: true },
    },
    async ({ project, flag, environment, limit, cursor }) =>
      run(async () =>
        okJson(await ctx.api.request('GET', versionsPath(project, flag, environment), { query: { limit, cursor } })),
      ),
  );

  server.registerTool(
    'restore_flag_version',
    {
      title: 'Restore a flag version',
      description:
        "Put an earlier version of one flag's configuration in one environment back (default variation, strategy, " +
        'rules, prerequisites), as a new version. On/off is restored only with include_state: true. Previews by ' +
        'default (dry_run: true) and changes nothing; review `before`/`after`, `changedSections` and `warnings`, ' +
        "then call again with dry_run: false and the preview's targetETag as etag to apply. If the apply is refused with " +
        '412, the environment changed since the preview: preview again. Use the same include_state as the preview. ' +
        'A version that names a variation, segment or prerequisite flag that no longer exists cannot be restored. ' +
        'Previewing works on every plan; applying needs the Pro plan or above.',
      inputSchema: z.object({
        project: projectParam,
        flag: flagParam,
        environment: environmentParam,
        version: z.number().int().min(1).describe('Version number to restore, from list_flag_versions'),
        include_state: z
          .boolean()
          .optional()
          .describe('Also restore the on/off state (default false). When applying, use the same value as the preview'),
        dry_run: z
          .boolean()
          .optional()
          .describe('Preview only, change nothing (default true). Pass false to apply, with the etag from a preview'),
        etag: z
          .string()
          .optional()
          .describe("targetETag from the preview; the apply is refused (412) if the environment changed since"),
        reason: reasonParam,
        freeze_override: freezeOverrideParam,
      }),
      outputSchema: apiOutput(
        'POST /api/v1/orgs/{org}/projects/{project}/flags/{flag}/environments/{env}/versions/{number}/restore',
      ),
      annotations: { destructiveHint: true },
    },
    async ({ project, flag, environment, version, include_state, dry_run, etag, reason, freeze_override }) => {
      const bad = freezeOverrideError(freeze_override, reason);
      if (bad) return bad;
      if (dry_run === false && !etag) {
        return {
          content: [
            {
              type: 'text',
              text:
                "Applying needs the preview's targetETag as etag: call restore_flag_version with dry_run: true " +
                'first, then apply with its etag.',
            },
          ],
          isError: true,
        };
      }
      try {
        return okJson(
          await ctx.api.request('POST', `${versionsPath(project, flag, environment)}/${version}/restore`, {
            body: { dryRun: dry_run ?? true, includeState: include_state ?? false, expectedETag: etag === undefined ? undefined : quoteEtag(etag) },
            reason,
            freezeOverride: freeze_override,
          }),
        );
      } catch (err) {
        return errorResult(err, {
          preconditionFailedHint:
            'The environment changed since the preview; run restore_flag_version with dry_run: true again, ' +
            'then apply with the new targetETag as etag.',
        });
      }
    },
  );
}
