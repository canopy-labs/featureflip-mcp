export interface McpConfig {
  token: string;
  baseUrl: string;
  org?: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  const token = env.FEATUREFLIP_TOKEN?.trim();
  if (!token) {
    throw new Error(
      'FEATUREFLIP_TOKEN is required. Create one in the Featureflip dashboard — ' +
        'Settings → API Tokens (personal token, ffp_...) or Organization Settings → Service Tokens (ffs_...) — ' +
        'and set it in your MCP client config.',
    );
  }
  const baseUrl = (env.FEATUREFLIP_API_URL?.trim() || 'https://api.featureflip.io').replace(/\/+$/, '');
  const org = env.FEATUREFLIP_ORG?.trim() || undefined;
  return { token, baseUrl, org };
}
