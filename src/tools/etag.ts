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

// The PUT's own response carries the ETag of what it wrote, so an agent can chain a second
// conditional write without re-reading. It is never fetched with a follow-up GET: that could
// return the ETag of someone else's later write, and the next ifMatch would then overwrite it.
export const writtenEtagOutput = {
  type: 'string',
  description:
    'ETag of what this write left behind. Pass it as ifMatch on the next update to chain writes without ' +
    're-reading. Absent when the API sent none; read the resource again before the next conditional write.',
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
