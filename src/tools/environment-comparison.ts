import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { enc } from '../client.js';
import { errorResult, okJson, run } from '../errors.js';
import type { ToolContext } from './context.js';
import { apiOutput } from './outputs.js';
import { flagParam, pagination, projectParam, reasonParam } from './params.js';

export function registerEnvironmentComparisonTools(server: McpServer, ctx: ToolContext): void {
  const projectBase = (project: string) => `/api/v1/orgs/${enc(ctx.org)}/projects/${enc(project)}`;

  server.registerTool(
    'compare_environments',
    {
      title: 'Compare environments',
      description:
        'Compare flag configuration between two environments: which flags differ and in which sections ' +
        '(state, defaultVariation, strategy, rules, prerequisites). Returns only differing flags unless ' +
        'different_only is false. To see exactly what would change for one flag, preview copy_flag_config (Team plan and above, Member role).',
      inputSchema: z.object({
        project: projectParam,
        base: z.string().describe('Base environment key'),
        other: z.string().describe('Environment key to compare against'),
        different_only: z.boolean().optional().describe('Only flags whose configuration differs (default true)'),
        tag: z.string().optional().describe('Only flags with this tag'),
        owner: z.string().optional().describe('Owner email, or "none" for unowned flags'),
        ...pagination,
      }),
      outputSchema: apiOutput('GET /api/v1/orgs/{org}/projects/{project}/compare'),
      annotations: { readOnlyHint: true },
    },
    async ({ project, base, other, different_only, tag, owner, limit, cursor }) =>
      run(async () =>
        okJson(
          await ctx.api.request('GET', `${projectBase(project)}/compare`, {
            query: { base, other, differentOnly: different_only ?? true, tag, owner, limit, cursor },
          }),
        ),
      ),
  );

  server.registerTool(
    'copy_flag_config',
    {
      title: 'Copy flag config between environments',
      description:
        "Copy one flag's targeting (default variation, strategy, rules, prerequisites) from one environment into " +
        'another. On/off is copied only with include_state: true. Previews by default (dry_run: true) and changes ' +
        "nothing; review `before`/`after`, `changedSections` and `warnings`, then call again with dry_run: false plus " +
        "the preview's sourceETag and targetETag as source_etag/target_etag to apply. If the apply is refused with " +
        '412, something changed since the preview: preview again. Applying needs both ETags, and the same ' +
        '`source` and `include_state` as the preview (the ETags record environment state, not the request). ' +
        'Team plan and above.',
      inputSchema: z.object({
        project: projectParam,
        flag: flagParam,
        source: z.string().describe('Environment key to copy from'),
        target: z.string().describe('Environment key to copy into'),
        include_state: z.boolean().optional().describe('Also copy the on/off state (default false). When applying, use the same value as the preview'),
        dry_run: z.boolean().optional().describe('Preview only, change nothing (default true). Pass false to apply, with both ETags from a preview made with the same source and include_state'),
        source_etag: z.string().optional().describe("sourceETag from the preview; the apply is refused (412) if the source changed since"),
        target_etag: z.string().optional().describe("targetETag from the preview; the apply is refused (412) if the target changed since"),
        reason: reasonParam,
      }),
      outputSchema: apiOutput('POST /api/v1/orgs/{org}/projects/{project}/flags/{flag}/environments/{env}/copy'),
      annotations: { destructiveHint: true },
    },
    async ({ project, flag, source, target, include_state, dry_run, source_etag, target_etag, reason }) => {
      if (dry_run === false && (!source_etag || !target_etag)) {
        return {
          content: [
            {
              type: 'text',
              text:
                'Applying needs both source_etag and target_etag from a preview: call copy_flag_config with ' +
                'dry_run: true first, then apply with its sourceETag and targetETag.',
            },
          ],
          isError: true,
        };
      }
      try {
        return okJson(
          await ctx.api.request(
            'POST',
            `${projectBase(project)}/flags/${enc(flag)}/environments/${enc(target)}/copy`,
            {
              body: {
                source,
                includeState: include_state ?? false,
                dryRun: dry_run ?? true,
                expectedSourceETag: source_etag,
                expectedTargetETag: target_etag,
              },
              reason,
            },
          ),
        );
      } catch (err) {
        return errorResult(err, {
          preconditionFailedHint:
            'The source or target changed since the preview; run copy_flag_config with dry_run: true again, ' +
            'then apply with the new sourceETag/targetETag.',
        });
      }
    },
  );
}
