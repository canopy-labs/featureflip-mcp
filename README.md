# @featureflip/mcp

MCP (Model Context Protocol) server for [Featureflip](https://featureflip.io) — manage feature flags
from AI coding assistants (Claude Code, Cursor, Copilot, Cline) and autonomous agents.

## Setup

1. Create an API token in the Featureflip dashboard:
   - **Personal token** (`ffp_...`): Settings → API Tokens — acts as you, for interactive editor use.
   - **Service token** (`ffs_...`): Organization Settings → Service Tokens — scoped machine identity for CI/agents.
2. Add the server to your MCP client:

### Claude Code

```bash
claude mcp add featureflip -e FEATUREFLIP_TOKEN=ffp_your_token -- npx -y @featureflip/mcp
```

### Cursor / Cline / generic JSON config

```json
{
  "mcpServers": {
    "featureflip": {
      "command": "npx",
      "args": ["-y", "@featureflip/mcp"],
      "env": { "FEATUREFLIP_TOKEN": "ffp_your_token" }
    }
  }
}
```

## Configuration

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `FEATUREFLIP_TOKEN` | yes | — | `ffp_`/`ffs_` API token |
| `FEATUREFLIP_API_URL` | no | `https://api.featureflip.io` | API base URL |
| `FEATUREFLIP_ORG` | no | auto | Org slug (needed only for multi-org personal tokens) |

## Tools

CRUD: `list_projects`, `list_environments`, `list_flags`, `get_flag`, `create_flag`, `update_flag`,
`delete_flag`, `archive_flag`, `restore_flag`, `toggle_flag`, `update_flag_environment_config`,
`get_targeting`, `update_targeting`, `manage_variation`, `list_segments`, `get_segment`

Workflows: `flag_status` (cross-environment view), `find_stale_flags` (cleanup candidates),
`wrap_feature` (create flag + get the SDK snippet for your language)

Full reference: https://featureflip.io/docs/integrations/mcp/

## Notes

- Flag **evaluation** is not exposed over MCP — use the [language SDKs](https://featureflip.io/docs) in application code.
- Every mutation is audit-logged and attributed to the token.
- License: Apache-2.0
