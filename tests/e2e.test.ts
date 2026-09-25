import { describe, it, expect } from 'vitest';
import { mockApi, connectClient } from './helpers.js';
// Shared with scripts/docker-smoke.mjs, which asserts the same surface against
// the CONTAINER. Two copies of this list would drift, and the copy that drifted
// would be the one nothing notices — the container is inspected by registries,
// not by us.
import EXPECTED_TOOLS from './expected-tools.json' with { type: 'json' };

describe('full tool surface', () => {
  it('registers exactly the 24 spec tools, every one titled and annotated', async () => {
    const { api } = mockApi([]);
    const client = await connectClient({ api, org: 'acme' });
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.description, tool.name).toBeTruthy();
      const a = tool.annotations ?? {};
      // Every tool must state its behaviour explicitly. An empty {} is NOT
      // sufficient: the MCP spec defaults an absent destructiveHint to TRUE, so
      // an unannotated write is advertised to clients as destructive — the
      // opposite of the "explicit non-destructive write" this once assumed. The
      // previous form of this assertion also admitted {} as a third branch,
      // which made it true for every possible object and caught nothing.
      expect(
        'readOnlyHint' in a || 'destructiveHint' in a,
        `${tool.name} declares neither readOnlyHint nor destructiveHint`,
      ).toBe(true);
    }
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort();
    expect(readOnly).toEqual(
      [
        'list_projects', 'list_environments', 'list_segments', 'get_segment',
        'list_flags', 'get_flag', 'flag_status', 'get_targeting', 'find_stale_flags',
        'list_webhooks', 'list_webhook_deliveries',
      ].sort(),
    );
    const destructive = tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name).sort();
    expect(destructive).toEqual(
      [
        'delete_flag', 'archive_flag', 'toggle_flag', 'update_flag_environment_config',
        // update_flag is not metadata-only: clientSideVisible decides whether the
        // browser/React/Swift SDKs can see the flag at all, so a bad write breaks
        // client-side evaluation the same way a targeting change would.
        'update_flag',
        'update_targeting', 'manage_variation',
        // Deleting a subscription or retiring a secret stops deliveries a receiver relies on.
        'manage_webhook',
      ].sort(),
    );
    // The writes that cannot change what any caller is served: pinned so a future
    // tool cannot quietly join them, and so these stay distinguishable from an
    // unannotated one. set_flag_expiry is here because expiry is advisory only.
    // deliver_webhook sends an event to a receiver but changes nothing in Featureflip.
    const additive = tools
      .filter((t) => t.annotations?.destructiveHint === false)
      .map((t) => t.name)
      .sort();
    expect(additive).toEqual(
      ['create_flag', 'restore_flag', 'set_flag_expiry', 'wrap_feature', 'deliver_webhook'].sort(),
    );
  });
});
