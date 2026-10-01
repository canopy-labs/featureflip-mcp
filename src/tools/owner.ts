import * as z from 'zod/v4';
import type { components } from '../generated/api-types.js';
import type { ToolContext } from './context.js';

type Me = components['schemas']['MeResponse'];

export const ownerFilter = z
  .string()
  .optional()
  .describe('Only flags with this owner: an email, "me" for the token\'s own user, or "none" for unowned flags');

/**
 * Turns the tool's `owner` argument into the /api/v1 `owner=` value, which takes only an email or
 * `none`. `me` is looked up through /api/v1/me. A service token has no user, so `me` is refused:
 * dropping the filter would silently answer "my flags" with every flag.
 */
export async function resolveOwner(ctx: ToolContext, owner: string | undefined): Promise<string | undefined> {
  const value = owner?.trim();
  if (!value) return undefined;
  if (value.toLowerCase() !== 'me') return value;
  const me = await ctx.api.request<Me>('GET', '/api/v1/me');
  if (me.type !== 'user' || !me.email) {
    throw new Error(
      'owner "me" needs a personal access token (ffp_...). A service token has no user, so it owns no flags; ' +
        'pass an owner email instead.',
    );
  }
  return me.email;
}
