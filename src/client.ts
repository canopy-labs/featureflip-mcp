export interface ErrorEnvelope {
  error: string;
  message: string;
  docs_url?: string;
  fields?: Record<string, string[]>;
  retry_after?: number;
  did_you_mean?: string[];
  next_actions?: { method: string; path: string }[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly envelope: ErrorEnvelope,
  ) {
    super(envelope.message);
    this.name = 'ApiError';
  }
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  idempotencyKey?: string;
}

export function enc(segment: string): string {
  return encodeURIComponent(segment);
}

export class FeatureflipApi {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: { token: string; baseUrl: string; fetchImpl?: typeof fetch }) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(this.opts.baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.opts.token}`,
      Accept: 'application/json',
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

    const response = await this.fetchImpl(url.toString(), { method, headers, body });

    if (response.status === 204) return undefined as T;

    if (!response.ok) {
      let envelope: ErrorEnvelope;
      try {
        envelope = (await response.json()) as ErrorEnvelope;
        if (typeof envelope?.error !== 'string') throw new Error('not an envelope');
      } catch {
        envelope = { error: `http_${response.status}`, message: `HTTP ${response.status} from ${url.pathname}` };
      }
      throw new ApiError(response.status, envelope);
    }

    return (await response.json()) as T;
  }
}
