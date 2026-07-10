import { describe, it, expect } from 'vitest';
import { mockApi, connectClient } from './helpers.js';

const EXPECTED_TOOLS = [
  'list_projects', 'list_environments', 'list_segments', 'get_segment',
  'list_flags', 'get_flag', 'create_flag', 'update_flag', 'delete_flag',
  'archive_flag', 'restore_flag', 'toggle_flag', 'update_flag_environment_config',
  'flag_status', 'get_targeting', 'update_targeting', 'manage_variation', 'find_stale_flags', 'wrap_feature',
];

describe('full tool surface', () => {
  it('registers exactly the 19 spec tools, every one titled and annotated', async () => {
    const { api } = mockApi([]);
    const client = await connectClient({ api, org: 'acme' });
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.description, tool.name).toBeTruthy();
      const a = tool.annotations ?? {};
      // every tool declares at least one behavioral hint or is an explicit non-destructive write ({})
      expect('readOnlyHint' in a || 'destructiveHint' in a || Object.keys(a).length === 0).toBe(true);
    }
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort();
    expect(readOnly).toEqual(
      [
        'list_projects', 'list_environments', 'list_segments', 'get_segment',
        'list_flags', 'get_flag', 'flag_status', 'get_targeting', 'find_stale_flags',
      ].sort(),
    );
    const destructive = tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name).sort();
    expect(destructive).toEqual(
      [
        'delete_flag', 'archive_flag', 'toggle_flag', 'update_flag_environment_config',
        'update_targeting', 'manage_variation',
      ].sort(),
    );
  });
});
