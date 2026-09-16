export interface McpConfig {
  token: string;
  baseUrl: string;
  org?: string;
}

export const MISSING_TOKEN_MESSAGE =
  'FEATUREFLIP_TOKEN is required. Create one in the Featureflip dashboard — ' +
  'Settings → API Tokens (personal token, ffp_...) or Organization Settings → Service Tokens (ffs_...) — ' +
  'and set it in your MCP client config.';

/**
 * Returns null instead of throwing when no token is configured, so the server can
 * still start and advertise its tool definitions to a client that is only
 * inspecting the surface (registries, `tools/list` probes, first-run editors).
 */
export function tryLoadConfig(env: Record<string, string | undefined> = process.env): McpConfig | null {
  const token = env.FEATUREFLIP_TOKEN?.trim();
  if (!token) return null;
  const baseUrl = (env.FEATUREFLIP_API_URL?.trim() || 'https://api.featureflip.io').replace(/\/+$/, '');
  const org = env.FEATUREFLIP_ORG?.trim() || undefined;
  return { token, baseUrl, org };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  const config = tryLoadConfig(env);
  if (!config) throw new Error(MISSING_TOKEN_MESSAGE);
  return config;
}
