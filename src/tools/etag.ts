import * as z from 'zod/v4';

// Optimistic concurrency on /api/v1: a GET returns a strong ETag (a hash of the
// representation, not a version number), and a PUT carrying it as If-Match is refused
// with 412 if the resource changed in between. That turns a lost update into an error
// the agent can act on, instead of a silent overwrite of someone else's change.

export const etagOutput = {
  type: 'string',
  description:
    'ETag of what was read. Pass it as ifMatch on the matching update so the write is refused (412) ' +
    'instead of overwriting a change made since.',
};

export function ifMatchParam(getTool: string) {
  return z
    .string()
    .optional()
    .describe(
      `etag from ${getTool}. The write is refused with 412 if the resource changed since that read; ` +
        're-read and re-apply. Omit to write unconditionally.',
    );
}

/** The API body with its ETag added, when the response carried one. */
export function withEtag<T extends object>({ data, etag }: { data: T; etag?: string }): T & { etag?: string } {
  return etag ? { ...data, etag } : data;
}
