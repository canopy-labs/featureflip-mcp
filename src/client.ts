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
  ifMatch?: string;
}

// ETags are quoted strings, and the quotes are part of the value. An agent copying the etag
// out of JSON often drops them; the API then answers 412 for every write, which reads as a
// concurrent change and sends the agent round a re-read loop that can never succeed.
function quoteEtag(value: string): string {
  return /^(W\/)?".*"$/.test(value) ? value : `"${value}"`;
}

export function enc(segment: string): string {
  return encodeURIComponent(segment);
}

// Gateway statuses a rolling deploy produces while pods drain. 503 is the one
// Envoy synthesises when it cannot reach a pod at all, so the request never ran.
const TRANSIENT_STATUSES = new Set([502, 503, 504]);
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);
const BACKOFF_MS = [250, 1000];

export class FeatureflipApi {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly opts: {
      token: string;
      baseUrl: string;
      fetchImpl?: typeof fetch;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    return (await this.requestWithEtag<T>(method, path, options)).data;
  }

  /** request(), plus the response's ETag: what a later write passes back as ifMatch. */
  async requestWithEtag<T = unknown>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<{ data: T; etag?: string }> {
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
    if (options.ifMatch) headers['If-Match'] = quoteEtag(options.ifMatch);

    // A request that is safe to replay retries every transient failure. An unkeyed
    // POST retries only a 503: after a 502/504 or a dropped connection it may already
    // have been applied, and replaying it would report a spurious conflict. A write
    // carrying If-Match is the same: if the first attempt landed, the replay's If-Match
    // no longer matches and the agent would be told its own write was someone else's.
    const replayable =
      (IDEMPOTENT_METHODS.has(method) && !options.ifMatch) || options.idempotencyKey !== undefined;
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      const retriesLeft = attempt < BACKOFF_MS.length;
      try {
        response = await this.fetchImpl(url.toString(), { method, headers, body });
      } catch (err) {
        if (!replayable || !retriesLeft) throw err;
        await this.sleep(BACKOFF_MS[attempt]);
        continue;
      }
      const retryable = replayable ? TRANSIENT_STATUSES.has(response.status) : response.status === 503;
      if (!retryable || !retriesLeft) break;
      await response.body?.cancel();
      await this.sleep(BACKOFF_MS[attempt]);
    }

    const etag = response.headers.get('etag') ?? undefined;
    if (response.status === 204) return { data: undefined as T, etag };

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

    return { data: (await response.json()) as T, etag };
  }
}
