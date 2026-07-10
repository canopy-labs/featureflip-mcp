import type { FeatureflipApi } from './client.js';
import type { components } from './generated/api-types.js';

type OrgListResponse = components['schemas']['OrganizationResponsePagedResult'];

export async function resolveOrg(api: FeatureflipApi, explicitOrg?: string): Promise<string> {
  if (explicitOrg) return explicitOrg;
  const orgs = await api.request<OrgListResponse>('GET', '/api/v1/orgs', { query: { limit: 100 } });
  const items = orgs.items ?? [];
  if (items.length === 1) {
    const slug = items[0].slug;
    if (!slug) throw new Error('The token can see one organization, but it has no slug set.');
    return slug;
  }
  if (items.length === 0) {
    throw new Error('The token can see no organizations. Check the token in the Featureflip dashboard.');
  }
  throw new Error(
    `The token can see ${items.length} organizations — set FEATUREFLIP_ORG to one of: ` +
      items.map((o) => o.slug ?? '?').join(', '),
  );
}
