import type { FeatureflipApi } from '../client.js';

export interface ToolContext {
  api: FeatureflipApi;
  org: string;
}
