export type FailureKind = 'auth' | 'permission' | 'rate-limit' | 'unavailable' | 'invalid' | 'incomplete' | 'busy';
export class MediavineError extends Error {
  constructor(public readonly kind: FailureKind, message: string, public readonly retryAt: number | null = null) {
    super(message);
    this.name = 'MediavineError';
  }
}
export interface Session { accessToken: string; refreshToken: string; expiresAt: number }
export interface Site { id: string; title: string; domain: string }
export interface Period { start: string; end: string }
export interface RevenueDay { date: string; revenueMinor: number | null }
export interface Report {
  site: Site; period: Period; daily: RevenueDay[]; summaryMinor: number | null;
  dailyMinor: number | null; differenceMinor: number | null; complete: boolean;
  missingDates: string[]; fetchedAt: string;
}
export interface ClientOptions {
  credentials: { email: string; password: string };
  session?: Session | null;
  saveSession: (session: Session | null) => Promise<void>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  beforeRequest?: () => Promise<void>;
}
const ENDPOINT = 'https://api-publishers.mediavine.com/graphql';
const DAY_MS = 86_400_000;
const invalid = () => new MediavineError('invalid', 'Mediavine returned an unexpected report. No revenue was changed.');
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw invalid();
  return value;
}
function site(value: unknown): Site {
  const row = object(value);
  return { id: string(row.id), title: string(row.title), domain: string(row.domain) };
}
export function dateTime(date: string): number {
  const time = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date || date < '2000-01-01') throw invalid();
  return time;
}
export function shiftDate(date: string, days: number): string {
  return new Date(dateTime(date) + days * DAY_MS).toISOString().slice(0, 10);
}
export function dates(period: Period): string[] {
  const length = (dateTime(period.end) - dateTime(period.start)) / DAY_MS + 1;
  if (length < 1 || length > 366) throw new MediavineError('invalid', 'Choose a date range of 1–366 days.');
  return Array.from({ length }, (_, i) => shiftDate(period.start, i));
}
/** Mediavine's report day and existing daily-report readiness boundary. */
export const MEDIAVINE_REPORTING_CLOCK = Object.freeze({
  timeZone: 'America/Los_Angeles',
  label: 'Pacific',
  readyAfterMinute: 370,
});
export function pacificDay(now: number): { today: string; yesterday: string; ready: boolean } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: MEDIAVINE_REPORTING_CLOCK.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now)).map(({ type, value }) => [type, value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  return { today, yesterday: shiftDate(today, -1), ready: Number(parts.hour) * 60 + Number(parts.minute) >= MEDIAVINE_REPORTING_CLOCK.readyAfterMinute };
}
function minor(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid();
  const result = Math.round(value * 100);
  if (!Number.isSafeInteger(result) || Math.abs(value * 100 - result) > 0.00001) throw invalid();
  return result;
}
function portalDate(date: string): string {
  return `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}`;
}
export function normalizeReport(value: unknown, period: Period, now: number): Report {
  const data = object(value);
  const summaryMinor = minor(object(object(data.metricsSummary).summary).earnings);
  const rows = object(data.earningsReport).earnings;
  if (!Array.isArray(rows)) throw invalid();
  const expected = new Set(dates(period));
  const seen = new Set<string>();
  const daily = rows.map((value): RevenueDay => {
    const row = object(value);
    const date = string(row.date).replaceAll('/', '-');
    if (!expected.has(date) || seen.has(date)) throw invalid();
    seen.add(date);
    return { date, revenueMinor: minor(row.revenue) };
  }).sort((a, b) => a.date.localeCompare(b.date));
  const missingDates = [...expected].filter(date => !seen.has(date));
  const complete = summaryMinor !== null && missingDates.length === 0 && daily.every(day => day.revenueMinor !== null);
  const dailyMinor = complete ? daily.reduce((total, day) => total + day.revenueMinor!, 0) : null;
  if (dailyMinor !== null && !Number.isSafeInteger(dailyMinor)) throw invalid();
  return { site: site(data.internalSite), period, daily, summaryMinor, dailyMinor,
    differenceMinor: summaryMinor !== null && dailyMinor !== null ? summaryMinor - dailyMinor : null,
    missingDates, complete, fetchedAt: new Date(now).toISOString() };
}

/** Provider operations are serialized by the host. This client has no background jobs or hidden retries. */
export class MediavineClient {
  private session: Session | null;
  private signInAttempted = false;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  constructor(private readonly options: ClientOptions) {
    this.session = options.session ?? null;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
  }
  private async request(query: string, variables: Record<string, unknown>, token?: string): Promise<Record<string, unknown>> {
    await this.options.beforeRequest?.();
    let response: Response;
    try {
      response = await this.fetchImpl(ENDPOINT, {
        // Workers supports manual redirects; non-2xx handling below refuses them.
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20_000),
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ query, variables }),
      });
    } catch { throw new MediavineError('unavailable', 'Mediavine could not be reached.'); }
    const raw = response.headers.get('retry-after');
    const after = raw !== null && /^\d+$/.test(raw) ? this.now() + Number(raw) * 1000 : Date.parse(raw ?? '');
    const retryAt = Number.isFinite(after) ? Math.min(Math.max(after, this.now()), this.now() + 366 * DAY_MS) : null;
    if (response.status === 429) {
      await response.body?.cancel();
      throw new MediavineError('rate-limit', 'Mediavine asked us to wait before trying again.', retryAt ?? this.now() + 3_600_000);
    }
    if (response.status === 403) {
      await response.body?.cancel();
      throw new MediavineError('permission', 'Mediavine refused access. Check your account’s site permissions and reconnect.');
    }
    if (response.status === 401) {
      await response.body?.cancel();
      throw new MediavineError('auth', 'Mediavine declined the saved connection. Reconnect your account.');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new MediavineError('unavailable', `Mediavine is unavailable (HTTP ${response.status}).`, retryAt);
    }
    // Bound even a response without Content-Length before parsing it.
    const reader = response.body?.getReader();
    if (!reader) throw invalid();
    let body = ''; let bytes = 0; const decoder = new TextDecoder();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 2_000_000) { await reader.cancel(); throw invalid(); }
        body += decoder.decode(part.value, { stream: true });
      }
      body += decoder.decode();
    } catch (error) {
      if (error instanceof MediavineError) throw error;
      throw new MediavineError('unavailable', 'Mediavine stopped sending the report.');
    }
    let result: Record<string, unknown>;
    try { result = object(JSON.parse(body) as unknown); } catch { throw invalid(); }
    if (Array.isArray(result.errors) && result.errors.length > 0) {
      if (result.errors.some(error => {
        const record = object(error);
        return record.extensions && object(record.extensions).code === 'FORBIDDEN';
      })) throw new MediavineError('permission', 'Mediavine refused access. Check your account’s site permissions and reconnect.');
      const auth = result.errors.some(error => {
        const record = object(error);
        const code = record.extensions && object(record.extensions).code;
        return code === 'UNAUTHENTICATED' || code === 'UNAUTHORIZED' || /unauthenticated|unauthorized|invalid.*token|token.*expired/i.test(String(record.message));
      });
      throw auth ? new MediavineError('auth', 'Mediavine declined the saved connection. Reconnect your account.') : invalid();
    }
    return object(result.data);
  }
  private async save(value: unknown, previousRefresh = ''): Promise<string> {
    const result = object(value);
    if (result.twoFactorRequired === true) throw new MediavineError('auth', 'This Mediavine account requires two-factor sign-in. Automatic password sign-in is unavailable.');
    const expiresIn = result.expiresIn;
    if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) throw invalid();
    this.session = { accessToken: string(result.accessToken), refreshToken: typeof result.refreshToken === 'string' && result.refreshToken ? result.refreshToken : previousRefresh, expiresAt: this.now() + expiresIn * 1000 };
    await this.options.saveSession(this.session);
    return this.session.accessToken;
  }
  private async token(force = false): Promise<string> {
    if (!force && this.session && this.session.expiresAt > this.now() + 60_000) return this.session.accessToken;
    if (this.session?.refreshToken) {
      try {
        const result = await this.request('mutation RefreshAccessToken($refreshToken: String!) { unidashRefreshToken(refreshToken: $refreshToken) { accessToken expiresIn refreshToken } }', { refreshToken: this.session.refreshToken });
        return await this.save(result.unidashRefreshToken, this.session.refreshToken);
      } catch (error) {
        if (!(error instanceof MediavineError) || error.kind !== 'auth') throw error;
        this.session = null;
        await this.options.saveSession(null);
      }
    }
    if (this.signInAttempted) throw new MediavineError('auth', 'Mediavine declined the new connection. Reconnect your account.');
    this.signInAttempted = true;
    const result = await this.request('mutation NoticeOSSignIn($data: UnidashSignInInput!) { unidashSignIn(data: $data) { accessToken refreshToken expiresIn twoFactorRequired } }', { data: { email: this.options.credentials.email, password: this.options.credentials.password } });
    return this.save(result.unidashSignIn);
  }
  private async authenticated(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    const token = await this.token();
    try { return await this.request(query, variables, token); }
    catch (error) {
      if (!(error instanceof MediavineError) || error.kind !== 'auth') throw error;
      // One recovery per operation. A second rejection reaches the host and stops the retry schedule.
      return this.request(query, variables, await this.token(true));
    }
  }
  async sites(): Promise<Site[]> {
    const sites: Site[] = []; let after: string | null = null;
    for (let page = 0; page < 20; page++) {
      const data = await this.authenticated('query NoticeOSSites($after: String) { sitesForUser(first: 99, after: $after) { edges { node { id title domain } } pageInfo { hasNextPage endCursor } } }', { after });
      const connection = object(data.sitesForUser);
      if (!Array.isArray(connection.edges)) throw invalid();
      sites.push(...connection.edges.map(edge => site(object(edge).node)));
      const info = object(connection.pageInfo);
      if (info.hasNextPage === false) return sites;
      const cursor = string(info.endCursor);
      if (cursor === after) throw invalid();
      after = cursor;
    }
    throw invalid();
  }
  async revenue(siteId: string, period: Period): Promise<Report> {
    dates(period);
    const data = await this.authenticated(`query NoticeOSRevenue($siteId: ID!, $startDate: String!, $endDate: String!) {
      internalSite(siteId: $siteId) { id title domain }
      metricsSummary(data: { siteId: $siteId, startDate: $startDate, endDate: $endDate }) { summary { earnings } }
      earningsReport(data: { siteId: $siteId, startDate: $startDate, endDate: $endDate }) { earnings { date revenue } }
    }`, { siteId, startDate: portalDate(period.start), endDate: portalDate(period.end) });
    const report = normalizeReport(data, period, this.now());
    if (report.site.id !== siteId) throw invalid();
    return report;
  }
}
