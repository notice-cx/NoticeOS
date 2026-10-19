// Page speed for every site from the Chrome UX Report API: the 75th percentile
// of Largest Contentful Paint, Interaction to Next Paint and Cumulative Layout
// Shift that real Chrome users saw on the site's origin over CrUX's trailing
// 28 days, for phones and desktops. Free, keyed by origin, and asked with one
// API key that identifies only the Google Cloud project its quota counts
// against. One reading per site per day in `hygiene_checks` (check
// `crux-vitals`), written through hygiene.ts's `writeReading`. No alert rule
// reads it yet.

import type { CredentialSource } from '@noticeos/contract';
import { credentialConnected, recordCredentialOutcome, resolveCredential } from './credentials.js';
import { EGRESS_NOT_ASKED, EgressGate, type EgressRunOutcome, egressExplains, watchTransport } from './egress.js';
import { eligibleAssets, writeReading, type HygieneAsset } from './hygiene.js';
import { observeIntegration, tryHealthConnection } from './integration-health-context.js';
import { laneDeclined, type LaneRegister } from './lane-mapping.js';

export const CRUX_CHECK_ID = 'crux-vitals';
/** The credential field, and its legacy env binding name. */
export const CRUX_KEY_FIELD = 'CRUX_API_KEY';
/** The integration-health capability one site's daily reading is recorded under. */
export const CRUX_DAILY_CAPABILITY = 'crux-daily';

const API_URL = 'https://chromeuxreport.googleapis.com/v1/records:queryRecord';
const REQUEST_TIMEOUT_MS = 15_000;
/** The form factors read for each site, the first one preferred for the headline. */
export const CRUX_FORM_FACTORS = ['PHONE', 'DESKTOP'] as const;
export type CruxFormFactor = (typeof CRUX_FORM_FACTORS)[number];
const METRICS = ['largest_contentful_paint', 'interaction_to_next_paint', 'cumulative_layout_shift'] as const;

/**
 * An origin no installation owns (IANA-reserved), asked when a key must be
 * checked before any site exists. The key is checked before the origin, so a
 * "no data" answer proves the key as well as a record does.
 */
export const CRUX_KEY_CHECK_ORIGIN = 'https://example.com';

/** One form factor's p75s. LCP and INP in milliseconds; CLS unitless. */
export interface CruxVitals {
  lcp: number | null;
  inp: number | null;
  cls: number | null;
  /** The dates CrUX aggregated, `YYYY-MM-DD`. */
  collectionPeriod: { firstDate: string; lastDate: string } | null;
}

/** What one `records:queryRecord` call answered. Transport failures throw. */
export type CruxAnswer =
  | { kind: 'record'; vitals: CruxVitals }
  | { kind: 'no-data' }
  | { kind: 'refused'; status: number }
  | { kind: 'rate-limited'; status: number }
  | { kind: 'failed'; status: number };

function finite(value: unknown): number | null {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
}

function p75(metrics: Record<string, unknown>, name: string): number | null {
  const metric = metrics[name];
  if (metric === null || typeof metric !== 'object') return null;
  const percentiles = (metric as { percentiles?: unknown }).percentiles;
  if (percentiles === null || typeof percentiles !== 'object') return null;
  return finite((percentiles as { p75?: unknown }).p75);
}

function isoDate(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const { year, month, day } = value as { year?: unknown; month?: unknown; day?: unknown };
  if (typeof year !== 'number' || typeof month !== 'number' || typeof day !== 'number') return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The p75s of one CrUX record, or null when the body is not a record. */
export function parseCruxRecord(body: unknown): CruxVitals | null {
  if (body === null || typeof body !== 'object') return null;
  const record = (body as { record?: unknown }).record;
  if (record === null || typeof record !== 'object') return null;
  const metrics = (record as { metrics?: unknown }).metrics;
  if (metrics === null || typeof metrics !== 'object') return null;
  const period = (record as { collectionPeriod?: unknown }).collectionPeriod;
  const firstDate = period && typeof period === 'object' ? isoDate((period as { firstDate?: unknown }).firstDate) : null;
  const lastDate = period && typeof period === 'object' ? isoDate((period as { lastDate?: unknown }).lastDate) : null;
  const m = metrics as Record<string, unknown>;
  return {
    lcp: p75(m, 'largest_contentful_paint'),
    inp: p75(m, 'interaction_to_next_paint'),
    cls: p75(m, 'cumulative_layout_shift'),
    collectionPeriod: firstDate && lastDate ? { firstDate, lastDate } : null,
  };
}

/**
 * One `records:queryRecord` call. The key travels in a header, never in the
 * URL, so no error message or log line can carry it. Throws only when no
 * response came back.
 */
export async function queryCrux(
  apiKey: string,
  origin: string,
  formFactor: CruxFormFactor | null,
  fetchImpl: typeof fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<CruxAnswer> {
  const response = await fetchImpl(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ origin, ...(formFactor ? { formFactor } : {}), metrics: METRICS }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 404) {
    // CrUX holds too little traffic for this origin and form factor.
    await response.body?.cancel();
    return { kind: 'no-data' };
  }
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    return { kind: 'refused', status: response.status };
  }
  if (response.status === 429) {
    await response.body?.cancel();
    return { kind: 'rate-limited', status: response.status };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { kind: 'failed', status: response.status };
  }
  const vitals = parseCruxRecord(await response.json().catch(() => null));
  return vitals ? { kind: 'record', vitals } : { kind: 'failed', status: response.status };
}

/**
 * Whether CrUX accepts a key: one call, no form factor, on `origin`. A record
 * and "no data" both mean the key was accepted. Never throws.
 */
export async function checkCruxKey(
  apiKey: string,
  origin: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<'accepted' | 'refused' | 'rate-limited' | 'unreachable'> {
  try {
    const answer = await queryCrux(apiKey, origin, null, fetchImpl, timeoutMs);
    if (answer.kind === 'record' || answer.kind === 'no-data') return 'accepted';
    if (answer.kind === 'refused') return 'refused';
    return answer.kind === 'rate-limited' ? 'rate-limited' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

/** The origin CrUX keys a stored domain under. */
export function cruxOrigin(host: string): string {
  return `https://${host}`;
}

// --- the daily job ----------------------------------------------------------

export interface CruxOutcome {
  asset: string;
  /** `measured`: a reading with figures; `no-data`: a reading saying CrUX holds
   * too little traffic; `failed`: no reading; `unmeasured`: the OS was offline. */
  status: 'measured' | 'no-data' | 'failed' | 'unmeasured';
  /** The stored `value_num`: the headline LCP p75 in ms, or null. */
  lcp: number | null;
  errorCode: string | null;
}

export interface CruxRunResult {
  /** False when no key is connected: the run asked nothing and wrote nothing. */
  connected: boolean;
  attempted: number;
  /** Sites given a reading, with figures or with "no data". */
  succeeded: number;
  failed: number;
  outcomes: CruxOutcome[];
  egress: EgressRunOutcome;
  monitoringAvailable?: false;
}

export interface CruxOptions {
  nowMs?: number;
  fetchImpl?: typeof fetch;
  /** Override the eligible-site query (tests inject their own sites). */
  sites?: HygieneAsset[];
  /** Only these assets (a collect-now press). The membership rule is unchanged. */
  assets?: readonly string[];
  laneRegister?: LaneRegister;
  egress?: EgressGate;
}

/** The two form factors of one origin, or the first answer that was not a
 * record or no-data, which then speaks for the site. */
async function readOrigin(
  apiKey: string,
  origin: string,
  fetchImpl: typeof fetch,
): Promise<{ kind: 'read'; byFormFactor: Record<CruxFormFactor, CruxVitals | null> } | Exclude<CruxAnswer, { kind: 'record' } | { kind: 'no-data' }>> {
  const byFormFactor: Record<CruxFormFactor, CruxVitals | null> = { PHONE: null, DESKTOP: null };
  for (const formFactor of CRUX_FORM_FACTORS) {
    const answer = await queryCrux(apiKey, origin, formFactor, fetchImpl);
    if (answer.kind === 'record') byFormFactor[formFactor] = answer.vitals;
    else if (answer.kind !== 'no-data') return answer;
  }
  return { kind: 'read', byFormFactor };
}

const hasData = (read: Record<CruxFormFactor, CruxVitals | null>) => CRUX_FORM_FACTORS.some((formFactor) => read[formFactor] !== null);

/**
 * Read each eligible site's page speed and store one reading per site. A site
 * whose bare domain CrUX does not know is asked once more at `www.`, the way
 * the hygiene sweep asks a home page. No key connected is no work, not a
 * failure; a refused key stops the run, since every site shares it.
 */
export async function runCruxVitals(env: IngestEnv, options: CruxOptions = {}): Promise<CruxRunResult> {
  const nowMs = options.nowMs ?? Date.now();
  const at = new Date(nowMs).toISOString();
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolved = await resolveCredential(env, 'crux');
  const apiKey = resolved.fields[CRUX_KEY_FIELD];
  if (!apiKey && !(await credentialConnected(env, 'crux', resolved))) {
    console.log(JSON.stringify({ event: 'crux_not_connected' }));
    return { connected: false, attempted: 0, succeeded: 0, failed: 0, outcomes: [], egress: EGRESS_NOT_ASKED };
  }
  const source: CredentialSource = resolved.source;
  const health = await tryHealthConnection(env, 'crux', resolved);
  let monitoringAvailable = health !== null;
  const scope = options.assets === undefined ? null : new Set(options.assets);
  const sites = (options.sites ?? (await eligibleAssets(env)))
    .filter((site) => scope === null || scope.has(site.asset))
    .filter((site) => !laneDeclined(site.asset, 'crux', options.laneRegister));
  const gate = options.egress ?? new EgressGate(env, { lane: 'crux', fetchImpl, at });
  const transport = watchTransport(fetchImpl);
  const outcomes: CruxOutcome[] = [];

  const observe = async (site: HygieneAsset, ok: boolean, code?: string) => {
    const recorded = await observeIntegration(env, health, {
      capability: CRUX_DAILY_CAPABILITY, asset: site.asset, target: site.domain, observedAt: at, ok, code,
    });
    if (!recorded) monitoringAvailable = false;
  };

  let keyAnswered = false;
  let refused: number | null = null;
  for (const site of sites) {
    if (refused !== null) {
      outcomes.push({ asset: site.asset, status: 'failed', lcp: null, errorCode: `crux_http_${refused}` });
      await observe(site, false, 'access');
      continue;
    }
    if (!apiKey) {
      // Connected, but the stored key could not be opened.
      outcomes.push({ asset: site.asset, status: 'failed', lcp: null, errorCode: 'credential_unavailable' });
      await observe(site, false, 'credential');
      continue;
    }
    try {
      let origin = cruxOrigin(site.domain);
      let read = await readOrigin(apiKey, origin, transport.fetch);
      if (read.kind === 'read' && !hasData(read.byFormFactor) && !site.domain.startsWith('www.')) {
        const www = cruxOrigin(`www.${site.domain}`);
        const second = await readOrigin(apiKey, www, transport.fetch);
        if (second.kind !== 'read' || hasData(second.byFormFactor)) {
          origin = www;
          read = second;
        }
      }
      if (read.kind !== 'read') {
        if (read.kind === 'refused') refused = read.status;
        else keyAnswered = true;
        const errorCode = read.kind === 'rate-limited' ? 'crux_rate_limit' : `crux_http_${read.status}`;
        outcomes.push({ asset: site.asset, status: 'failed', lcp: null, errorCode });
        await observe(site, false, read.kind === 'refused' ? 'access' : read.kind === 'rate-limited' ? 'rate-limit' : 'provider');
        continue;
      }
      keyAnswered = true;
      const headline = CRUX_FORM_FACTORS.find((formFactor) => read.byFormFactor[formFactor] !== null) ?? null;
      const vitals = headline ? read.byFormFactor[headline]! : null;
      await writeReading(env, site.asset, CRUX_CHECK_ID, at, 'ok', vitals?.lcp ?? null, {
        origin,
        lcp: vitals?.lcp ?? null,
        inp: vitals?.inp ?? null,
        cls: vitals?.cls ?? null,
        formFactor: headline,
        collectionPeriod: vitals?.collectionPeriod ?? null,
        formFactors: read.byFormFactor,
        ...(headline === null ? { no_data: true } : {}),
      });
      outcomes.push({ asset: site.asset, status: headline ? 'measured' : 'no-data', lcp: vitals?.lcp ?? null, errorCode: null });
      await observe(site, true);
    } catch (error) {
      if (await egressExplains(gate, transport, error)) {
        gate.recordUnmeasured(site.asset);
        outcomes.push({ asset: site.asset, status: 'unmeasured', lcp: null, errorCode: 'os_egress_down' });
        continue;
      }
      outcomes.push({ asset: site.asset, status: 'failed', lcp: null, errorCode: 'request_failed' });
      await observe(site, false, 'network');
    }
  }

  // The key's own verdict: refused, or answered at least once.
  if (source === 'store' && (refused !== null || keyAnswered)) {
    await recordCredentialOutcome(env, 'crux', refused !== null
      ? { ok: false, error: `Chrome UX Report refused the key (HTTP ${refused}).`, at }
      : { ok: true, at });
  }
  const result: CruxRunResult = {
    connected: true,
    attempted: outcomes.length,
    succeeded: outcomes.filter((outcome) => outcome.status === 'measured' || outcome.status === 'no-data').length,
    failed: outcomes.filter((outcome) => outcome.status === 'failed').length,
    outcomes,
    egress: await gate.finalize(),
    ...(monitoringAvailable ? {} : { monitoringAvailable: false as const }),
  };
  console.log(JSON.stringify({
    event: 'crux_complete',
    attempted: result.attempted,
    succeeded: result.succeeded,
    failed: result.failed,
    errors: outcomes.filter((outcome) => outcome.status === 'failed').map(({ asset, errorCode }) => ({ asset, errorCode })),
    unmeasured: outcomes.filter((outcome) => outcome.status === 'unmeasured').length,
  }));
  return result;
}
