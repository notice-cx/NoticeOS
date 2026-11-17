import { ADSENSE_READ_SCOPE as READ_SCOPE, amountToMinorUnits, siteHost, type CollectNowSite, type DiscoveredSite, type ScheduledRunResult } from '@noticeos/contract';
import { adSenseAssignments, isAdSenseSite } from '@noticeos/contract/configuration';
import { isSupportedCurrency } from '@noticeos/contract/money';
import { calendarOffset } from '@noticeos/contract/reporting-calendar';
import { ADSENSE_REVENUE_SOURCE } from '@noticeos/contract/revenue-sources';
import type { Transaction } from '@noticeos/postgres';
import { publishCurrentIntegration, resolveCredential } from './credentials.js';
import { refreshGoogleAccessToken } from './google-auth.js';
import { eligibleAssets } from './hygiene.js';
import { observeIntegration, tryHealthConnection } from './integration-health-context.js';
import { claimLease, releaseLease } from './integration-leases.js';
import { LANE_REGISTER, type LaneRegister } from './lane-mapping.js';
import { asRecord, stringField } from './shared.js';
import { boundedResponseJson, SignalError } from './signal-store.js';

const API = 'https://adsense.googleapis.com/v2/';
const ACCOUNT = /^accounts\/pub-[0-9]+$/u;
const REPORT_ID = /^[a-zA-Z0-9:_-]+$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_PAGES = 20;
const REPORT_LIMIT = 62;
export const ADSENSE_REVENUE_CAPABILITY = 'adsense-revenue';

type Target = { asset: string; site: string };
type Report = { currency: string; days: Map<string, number> };
type Window = { start: string; end: string };

function invalid(): never {
  throw new SignalError('adsense_invalid_response', 'Google returned an unreadable AdSense response.');
}

function list(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid();
  return value;
}

function object(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? invalid();
}

async function get(path: string, token: string, fetchImpl: typeof fetch, query?: URLSearchParams) {
  const url = new URL(path, API);
  if (query) url.search = query.toString();
  const answer = await fetchImpl(url, {
    headers: { authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(12_000),
  });
  if (!answer.ok) {
    await answer.body?.cancel();
    throw new SignalError(`adsense_http_${answer.status}`, 'Google refused an AdSense request.');
  }
  return object(await boundedResponseJson(answer, 'AdSense', 512_000));
}

async function readPages(path: string, field: string, token: string, fetchImpl: typeof fetch) {
  const rows: unknown[] = [];
  let page: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const query = new URLSearchParams({ pageSize: '100' });
    if (page) query.set('pageToken', page);
    const result = await get(path, token, fetchImpl, query);
    rows.push(...list(result[field]));
    const next = stringField(result, 'nextPageToken');
    if (!next) return rows;
    if (next === page) invalid();
    page = next;
  }
  return invalid();
}

async function accessToken(fields: Record<string, string>, fetchImpl: typeof fetch): Promise<string> {
  const { ADSENSE_CLIENT_ID: clientId, ADSENSE_CLIENT_SECRET: clientSecret, ADSENSE_REFRESH_TOKEN: refreshToken } = fields;
  if (!clientId || !clientSecret || !refreshToken) throw new SignalError('adsense_credential_missing', 'Connect AdSense in Integrations.');
  return refreshGoogleAccessToken({ clientId, clientSecret, refreshToken, account: null, scopes: [READ_SCOPE] }, fetchImpl, READ_SCOPE);
}

export function adSenseFailure(error: unknown): 'refused' | 'unreachable' {
  return error instanceof SignalError && /(?:_http_(?:400|401|403)|_revoked|_scope|_credential_missing)$/.test(error.code)
    ? 'refused' : 'unreachable';
}

async function accounts(token: string, fetchImpl: typeof fetch) {
  return (await readPages('accounts', 'accounts', token, fetchImpl)).map(value => {
    const name = stringField(object(value), 'name');
    if (!name || !ACCOUNT.test(name)) invalid();
    return name;
  });
}

export async function checkAdSense(fields: Record<string, string>, fetchImpl: typeof fetch): Promise<'accepted' | 'refused' | 'unreachable'> {
  try {
    const token = await accessToken(fields, fetchImpl);
    return (await accounts(token, fetchImpl)).length ? 'accepted' : 'refused';
  } catch (error) {
    return adSenseFailure(error);
  }
}

export async function discoverAdSense(fields: Record<string, string>, fetchImpl: typeof fetch): Promise<DiscoveredSite[]> {
  const token = await accessToken(fields, fetchImpl);
  const sites: DiscoveredSite[] = [];
  for (const account of await accounts(token, fetchImpl)) {
    for (const value of await readPages(`${account}/sites`, 'sites', token, fetchImpl)) {
      const record = object(value);
      const ref = stringField(record, 'name');
      const label = stringField(record, 'domain');
      if (!isAdSenseSite(ref) || !ref.startsWith(`${account}/sites/`) || !label) invalid();
      sites.push({
        lane: 'adsense', ref, label, host: siteHost(label),
        mapping: { adsenseSite: ref }, ready: record.state === 'READY',
      });
    }
  }
  return sites;
}

function reportWindow(now: number, timeZone: string): Window {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const firstOfMonth = `${today.slice(0, 7)}-01`;
  return {
    start: `${calendarOffset(firstOfMonth, -1).slice(0, 7)}-01`,
    end: calendarOffset(today, -1),
  };
}

async function siteReport(target: Target, range: Window, token: string, fetchImpl: typeof fetch): Promise<Report | null> {
  const site = await get(target.site, token, fetchImpl);
  const id = stringField(site, 'reportingDimensionId');
  if (site.name !== target.site || !id || !REPORT_ID.test(id)) invalid();

  const query = new URLSearchParams({
    dateRange: 'CUSTOM', reportingTimeZone: 'GOOGLE_TIME_ZONE',
    metrics: 'ESTIMATED_EARNINGS', filters: `OWNED_SITE_ID==${id}`, limit: String(REPORT_LIMIT),
  });
  query.append('dimensions', 'DATE');
  query.append('dimensions', 'OWNED_SITE_ID');
  for (const [field, date] of [['startDate', range.start], ['endDate', range.end]] as const) {
    const [year, month, day] = date.split('-');
    query.set(`${field}.year`, year!);
    query.set(`${field}.month`, String(Number(month)));
    query.set(`${field}.day`, String(Number(day)));
  }
  const account = target.site.split('/').slice(0, 2).join('/');
  const result = await get(`${account}/reports:generate`, token, fetchImpl, query);
  const rows = list(result.rows);
  if (Number(result.totalMatchedRows ?? 0) !== rows.length || rows.length > REPORT_LIMIT) invalid();
  if (rows.length === 0) return null;
  const headers = list(result.headers).map(object);
  const dateIndex = headers.findIndex(header => header.name === 'DATE');
  const siteIndex = headers.findIndex(header => header.name === 'OWNED_SITE_ID');
  const amountIndex = headers.findIndex(header => header.name === 'ESTIMATED_EARNINGS');
  const currency = stringField(headers[amountIndex] ?? null, 'currencyCode');
  if (dateIndex < 0 || siteIndex < 0 || !currency || !isSupportedCurrency(currency)) invalid();

  const days = new Map<string, number>();
  for (const row of rows) {
    const cells = list(object(row).cells).map(object);
    const date = stringField(cells[dateIndex] ?? null, 'value');
    const raw = stringField(cells[amountIndex] ?? null, 'value');
    if (!date || !DATE.test(date) || date !== calendarOffset(date, 0) || date < range.start || date > range.end ||
        days.has(date) || cells[siteIndex]?.value !== id || !raw || !/^-?\d+(?:\.\d+)?$/u.test(raw)) invalid();
    const amount = amountToMinorUnits(Number(raw), currency);
    if (!Number.isSafeInteger(amount)) invalid();
    days.set(date, amount);
  }
  return { currency, days };
}

async function persistReport(tx: Transaction, target: Target, report: Report, owner: string, at: string): Promise<void> {
  const [document] = await tx.query<{ body: LaneRegister }>(
    "SELECT body FROM noticeos.config_documents WHERE document_key = 'config/integrations.json' FOR SHARE");
  if (document && !adSenseAssignments(document.body).some(row => row.asset === target.asset && row.site === target.site && !row.paused)) {
    throw new SignalError('adsense_mapping_changed', 'The AdSense mapping changed during collection.');
  }
  const [other] = await tx.query(
    'SELECT 1 FROM noticeos.revenue_observations WHERE source = $1 AND account_ref = $2 AND asset_id <> $3 LIMIT 1',
    [ADSENSE_REVENUE_SOURCE, target.site, target.asset]);
  if (other) throw new SignalError('adsense_mapping_used', 'This AdSense site already has revenue assigned to another asset.');

  await tx.execute(
    `INSERT INTO noticeos.revenue_observations
       (workspace_id, asset_id, source, account_ref, revenue_date, amount_minor, currency, run_ref, recorded_at)
     SELECT $1::uuid, $2, $3, $4, incoming.day, incoming.amount, $5, $6, $7::timestamptz
       FROM unnest($8::date[], $9::bigint[]) AS incoming(day, amount)
      WHERE NOT EXISTS (
        SELECT 1 FROM noticeos.current_revenue r WHERE r.asset_id = $2 AND r.source = $3 AND r.account_ref = $4
          AND r.revenue_date = incoming.day AND r.item_ref IS NULL AND r.currency = $5 AND r.amount_minor = incoming.amount)`,
    [tx.workspaceId, target.asset, ADSENSE_REVENUE_SOURCE, target.site, report.currency, owner, at,
      [...report.days.keys()], [...report.days.values()]]);
}

type Options = { laneRegister?: LaneRegister; assets?: string[]; fetchImpl?: typeof fetch; nowMs?: number };
type AdSenseRun = ScheduledRunResult & { sites: CollectNowSite[]; databaseUpdateRequired?: true };

export async function runAdSenseRevenue(env: IngestEnv, options: Options): Promise<AdSenseRun> {
  const eligible = new Set((await eligibleAssets(env)).map(({ asset }) => asset));
  const targets = adSenseAssignments(options.laneRegister ?? LANE_REGISTER).filter(({ asset, paused }) => eligible.has(asset) && !paused);
  const requested = options.assets ? new Set(options.assets) : null;
  const selected = targets.filter(({ asset }) => requested === null || requested.has(asset));
  if (selected.length === 0) return { outcome: 'skipped', detail: 'No assets are mapped to AdSense.', sites: [] };

  const credential = await resolveCredential(env, 'adsense', 'store-only');
  if (credential.source !== 'store') return { outcome: 'skipped', detail: 'AdSense is disconnected.', sites: [] };
  const health = await tryHealthConnection(env, 'adsense', credential);
  const now = options.nowMs ?? Date.now();
  const at = new Date(now).toISOString();
  const fetchImpl = options.fetchImpl ?? fetch;
  const [source] = await env.STORE.read(tx => tx.query<{ time_zone: string }>(
    'SELECT time_zone FROM noticeos_ref.revenue_sources WHERE source = $1', [ADSENSE_REVENUE_SOURCE]));
  if (!source) return {
    outcome: 'failed', detail: 'The AdSense revenue source requires a database update.',
    sites: [], databaseUpdateRequired: true,
  };
  const range = reportWindow(now, source.time_zone);
  let token: string;
  try {
    token = await accessToken(credential.fields, fetchImpl);
  } catch (error) {
    const code = error instanceof SignalError ? error.code : 'adsense_unreachable';
    for (const target of selected) await observeIntegration(env, health, {
      capability: ADSENSE_REVENUE_CAPABILITY, asset: target.asset, target: target.site, observedAt: at, ok: false, code,
    });
    return { outcome: 'failed', detail: 'AdSense authorization failed.',
      sites: selected.map(({ asset }) => ({ asset, outcome: 'failed', code })) };
  }

  const duplicates = new Set<string>();
  const seen = new Set<string>();
  for (const { site } of targets) {
    if (seen.has(site)) duplicates.add(site);
    seen.add(site);
  }
  const sites: CollectNowSite[] = [];
  for (const target of selected) {
    const { asset, site } = target;
    const lease = `adsense:${site}`;
    const owner = crypto.randomUUID();
    let outcome: CollectNowSite['outcome'] = 'skipped';
    let code: string | null = null;
    try {
      if (duplicates.has(site)) throw new SignalError('adsense_mapping_duplicate', 'Assign an AdSense site to one asset.');
      const started = Date.now();
      if (!await claimLease(env.STORE, { key: lease, owner, nowMs: started, expiresAtMs: started + 60_000 })) {
        sites.push({ asset, outcome: 'skipped', code: 'in-flight' });
        continue;
      }
      try {
        const report = await siteReport(target, range, token, fetchImpl);
        if (report) {
          const published = await publishCurrentIntegration(env, 'adsense', credential, lease, owner,
            tx => persistReport(tx, target, report, owner, at));
          if (published) outcome = 'collected';
          else code = 'connection-changed';
        } else code = 'unpublished';
      } finally {
        await releaseLease(env.STORE, lease, owner);
      }
    } catch (error) {
      outcome = 'failed';
      code = error instanceof SignalError ? error.code : 'adsense_unreachable';
    }
    if (outcome !== 'skipped') await observeIntegration(env, health, {
      capability: ADSENSE_REVENUE_CAPABILITY, asset, target: site, observedAt: at, ok: outcome === 'collected', code,
    });
    sites.push({ asset, outcome, code });
  }
  const failed = sites.filter(site => site.outcome === 'failed').length;
  const collected = sites.filter(site => site.outcome === 'collected').length;
  return {
    outcome: failed ? 'failed' : collected ? 'ran' : 'skipped',
    detail: `${collected} AdSense reports collected${failed ? `, ${failed} failed` : ''}.`,
    sites,
  };
}
