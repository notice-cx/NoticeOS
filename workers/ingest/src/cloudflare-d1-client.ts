import { cloudflareAccountId, d1DatabaseId, d1Record, type D1Database } from '@noticeos/contract/cloudflare-d1';
export { cloudflareAccountId, d1DatabaseId, d1Record, type D1Database };
/** Account-scoped D1 API calls. Only fixed provider origins receive the token. */
export class CloudflareD1Error extends Error {
  constructor(readonly code: 'invalid_configuration' | 'access_denied' | 'rate_limited' | 'provider_unavailable' | 'invalid_response' | 'timeout' | 'too_large') {
    super(code);
  }
}
/** Bound the entire transport and body read, including a source that ignores abort. */
export async function d1Bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The operation may already have started before this bound was called.
    // Consume a late rejection even when cancellation wins immediately.
    void promise.catch(() => undefined);
    throw new CloudflareD1Error('timeout');
  }
  let abort = () => {};
  const deadline = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new CloudflareD1Error('timeout'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([promise, deadline]); }
  finally { signal.removeEventListener('abort', abort); }
}

export async function d1Api(account: string, token: string, suffix: string, options: {
  fetchImpl?: typeof fetch; signal?: AbortSignal; method?: 'GET' | 'POST'; body?: unknown;
} = {}): Promise<Record<string, unknown>> {
  if (!cloudflareAccountId(account) || !token.trim() || /[\r\n]/u.test(token)) throw new CloudflareD1Error('invalid_configuration');
  const signal = options.signal ?? AbortSignal.timeout(10_000);
  if (signal.aborted) throw new CloudflareD1Error('timeout');
  try {
    const response = await d1Bounded((options.fetchImpl ?? fetch)(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database${suffix}`, {
      method: options.method ?? 'GET', redirect: 'error', signal,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }), signal);
    if (response.status === 401 || response.status === 403) throw new CloudflareD1Error('access_denied');
    if (response.status === 429) throw new CloudflareD1Error('rate_limited');
    if (!response.ok) throw new CloudflareD1Error('provider_unavailable');
    const reader = response.body?.getReader();
    if (!reader) throw new CloudflareD1Error('invalid_response');
    let text = ''; let bytes = 0; let empty = 0; const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await d1Bounded(reader.read(), signal);
        if (chunk.done) break;
        if (!chunk.value.byteLength && ++empty > 64) throw new CloudflareD1Error('invalid_response');
        bytes += chunk.value.byteLength;
        if (bytes > 1024 * 1024) throw new CloudflareD1Error('too_large');
        text += decoder.decode(chunk.value, { stream: true });
      }
    } finally { await d1Bounded(reader.cancel(), AbortSignal.timeout(2000)).catch(() => undefined); }
    const payload = d1Record(JSON.parse(text + decoder.decode()));
    if (!payload || payload.success !== true) throw new CloudflareD1Error('invalid_response');
    return payload;
  } catch (error) {
    if (error instanceof CloudflareD1Error) throw error;
    throw new CloudflareD1Error(signal.aborted ? 'timeout' : 'provider_unavailable');
  }
}

/** Refuse an incomplete inventory instead of letting it weaken backup coverage. */
export async function listD1Databases(fields: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<D1Database[]> {
  const signal = AbortSignal.timeout(10_000);
  const databases = new Map<string, D1Database>();
  let expectedTotal: number | undefined;
  for (let page = 1; page <= 10; page++) {
    const payload = await d1Api(fields.CLOUDFLARE_ACCOUNT_ID ?? '', fields.CLOUDFLARE_API_TOKEN ?? '', `?page=${page}&per_page=100`, { fetchImpl, signal });
    if (!Array.isArray(payload.result) || payload.result.length > 100) throw new CloudflareD1Error('invalid_response');
    const info = d1Record(payload.result_info);
    for (const [key, expected] of [['page', page], ['per_page', 100], ['count', payload.result.length]] as const) {
      if (info?.[key] !== undefined && info[key] !== expected) throw new CloudflareD1Error('invalid_response');
    }
    const total = info?.total_count;
    if (total !== undefined) {
      if (!Number.isSafeInteger(total) || Number(total) < 0 || (expectedTotal !== undefined && total !== expectedTotal)) throw new CloudflareD1Error('invalid_response');
      expectedTotal = Number(total);
      if (expectedTotal > 1000) throw new CloudflareD1Error('too_large');
      const expectedCount = Math.min(100, expectedTotal - (page - 1) * 100);
      if (expectedCount < 0 || payload.result.length !== expectedCount) throw new CloudflareD1Error('invalid_response');
    }
    for (const value of payload.result) {
      const row = d1Record(value);
      if (!row || !d1DatabaseId(row.uuid) || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 160 || databases.has(row.uuid)) throw new CloudflareD1Error('invalid_response');
      databases.set(row.uuid, { id: row.uuid, name: row.name });
    }
    const pages = info?.total_pages;
    if (pages !== undefined && (!Number.isSafeInteger(pages) || Number(pages) < page)) throw new CloudflareD1Error('invalid_response');
    if (pages !== undefined && Number(pages) > 10) throw new CloudflareD1Error('too_large');
    if (pages !== undefined && expectedTotal !== undefined && pages !== Math.max(1, Math.ceil(expectedTotal / 100))) throw new CloudflareD1Error('invalid_response');
    if (expectedTotal !== undefined) {
      if (databases.size === expectedTotal) return [...databases.values()];
      if (payload.result.length !== 100) throw new CloudflareD1Error('invalid_response');
      continue;
    }
    if (pages !== undefined && page < Number(pages) && payload.result.length !== 100) throw new CloudflareD1Error('invalid_response');
    if (pages !== undefined ? page === pages : payload.result.length < 100) return [...databases.values()];
  }
  throw new CloudflareD1Error('too_large');
}
