import { resolveCredential } from './credentials.js';
import { observeIntegration, tryHealthConnection, type HealthConnection } from './integration-health-context.js';
import { MediavineClient, MediavineError, dates, pacificDay, publishedPart, shiftDate, type Period, type PortfolioRevenue, type Report, type Session, type Site } from '@noticeos/mediavine';
import { MEDIAVINE_REVENUE_SOURCE } from '@noticeos/contract/revenue-sources';
import type { ConnectFacts, MediavineResult, MediavineSettings, MediavineStatus, MediavineSync, PutCredentialInput, PutCredentialResult, DeleteCredentialResult, ScheduledRunResult } from '@noticeos/contract';
import { mediavineSyncOn } from '@noticeos/contract';
import type { FileJsonSetOp, JsonValue } from '../../../scripts/config-documents.mjs';
import { applyConfigOps, getConfigDocument, forgetConfigCache } from './config-store.js';
import { credentialSummary, deleteCredential, putCredential, recordCredentialOutcome, saveMediavineSession } from './credentials.js';
import { javascriptInstant, type Transaction } from '@noticeos/postgres';
import { MEDIAVINE_LEASE, mediavineClient, mediavineMessage, withMediavineLease, type MediavineOptions } from './mediavine-connection.js';
import { WATCHED_REQUEST_TIMEOUT_MS } from './shared.js';
import { enqueueRevenueNotifications } from './revenue-notifications.js';

interface Lane { mediavineSiteId?: string; mediavineEnabled?: boolean; status?: string; revenueHolidayCalendar?: MediavineSettings['holidayCalendar'] }
interface Register { assets?: Record<string, Record<string, Lane>> }
/** A site's retry state, `next_attempt_at` in epoch milliseconds as the sync compares it. */
interface State { site_id: string; target_date: string | null; attempts: number; next_attempt_at: number | null; auth_blocked: boolean }
/** An instant the store returned, in epoch milliseconds; null stays null. */
const epochMs = (instant: string | null): number | null => (instant === null ? null : Date.parse(javascriptInstant(instant)));
/** Integer cents from the store (int8), as the number every caller reads. */
function cents(value: bigint): number {
  const exact = Number(value);
  if (!Number.isSafeInteger(exact)) throw new RangeError(`${value} cents is past 2^53 and no longer exact`);
  return exact;
}
const centsOrNull = (value: bigint | null): number | null => (value === null ? null : cents(value));
const FILE = 'config/integrations.json';
async function register(env: IngestEnv): Promise<Register> {
  forgetConfigCache(env.STORE);
  return (await getConfigDocument(env, FILE)).body as Register;
}
function laneFor(config: Register, asset: string): Lane {
  return config.assets?.[asset]?.['ad-network'] ?? {};
}
function enabled(lane: Lane): boolean {
  // A mapped site syncs until its Data sources row says Not using, the one
  // rule the Tower and the monitoring read too (`mediavineSyncOn`).
  return mediavineSyncOn(lane);
}
async function validateSiteAssignment(env: IngestEnv, config: Register, asset: string, siteId: string): Promise<void> {
  const previous = await env.STORE.read((tx) => tx.query<{ asset: string; site_id: string }>(
    'SELECT asset_id AS asset, site_id FROM noticeos.mediavine_sites WHERE asset_id = $1 OR site_id = $2', [asset, siteId]));
  if (previous.some(row => row.asset !== asset || row.site_id !== siteId)) throw new MediavineError('invalid', 'This asset already has revenue assigned elsewhere. Keep the original asset and Mediavine site mapping.');
  if (Object.entries(config.assets ?? {}).some(([id, lanes]) => id !== asset && lanes['ad-network']?.mediavineSiteId === siteId)) throw new MediavineError('invalid', 'This Mediavine site is already assigned to another asset.');
}
function settingOp(asset: string, field: string, held: unknown, value: JsonValue): FileJsonSetOp {
  const pointer = `/assets/${asset.replaceAll('~', '~0').replaceAll('/', '~1')}/ad-network/${field}`;
  return { kind: 'file-json-set', file: FILE, pointer, value,
    ...(held === undefined ? { expectAbsent: true as const } : { expect: held as JsonValue }) };
}
async function writeSettings(env: IngestEnv, input: MediavineSettings, lane: Lane): Promise<void> {
  // This door starts a sync and never records a decline: Not using is the
  // site's own row, which saves the reason with it (`declineOps`).
  const starts = input.enabled && !(input.holidayCalendar !== undefined && enabled(lane) && input.siteId === lane.mediavineSiteId);
  const result = await applyConfigOps(env, { actor: 'operator', reason: 'Configure Mediavine revenue sync', ops: [
    settingOp(input.asset, 'mediavineSiteId', lane.mediavineSiteId, input.siteId),
    settingOp(input.asset, 'mediavineEnabled', lane.mediavineEnabled, input.enabled),
    ...(starts ? [settingOp(input.asset, 'status', lane.status, 'needs-setup')] : []),
    ...(input.holidayCalendar === undefined ? [] : [settingOp(input.asset, 'revenueHolidayCalendar', lane.revenueHolidayCalendar, input.holidayCalendar)]),
  ] });
  if (!result.ok) throw new MediavineError('invalid', `Settings could not be saved (${result.error}). Reload and try again.`);
}
export async function saveMediavineSettings(env: IngestEnv, input: MediavineSettings): Promise<MediavineResult<MediavineStatus>> {
  try {
    if (!input || typeof input.asset !== 'string' || typeof input.siteId !== 'string' || typeof input.enabled !== 'boolean') throw new MediavineError('invalid', 'Choose an asset and whether automatic sync is enabled.');
    if (input.holidayCalendar !== undefined && !['none', 'US', 'CA', 'US,CA'].includes(input.holidayCalendar)) throw new MediavineError('invalid', 'Choose a supported holiday calendar.');
    await withMediavineLease(env, async () => {
      const config = await register(env); const lane = laneFor(config, input.asset);
      await validateSiteAssignment(env, config, input.asset, input.siteId);
      if (!config.assets?.[input.asset]?.['ad-network']) throw new MediavineError('invalid', 'This asset has no ad revenue data source.');
      // Switching a running sync off is a decline, and a decline carries its
      // reason: it is the Ad revenue row's Not using, never this door.
      if (!input.enabled && enabled(lane)) throw new MediavineError('invalid', 'Stop this sync with Not using on the asset’s Ad revenue row.');
      // Only a site newly named or newly enabled is checked against the account:
      // a forecast-calendar save on a syncing site changes neither.
      if (input.enabled && !(input.siteId === lane.mediavineSiteId && enabled(lane))) {
        const credential = await credentialSummary(env, 'mediavine');
        if (credential?.source !== 'store') throw new MediavineError('auth', 'Connect Mediavine before enabling automatic sync.');
        const [cached] = await env.STORE.read((tx) => tx.query<{ sites: string | null }>(
          'SELECT sites::text AS sites FROM noticeos.integration_leases WHERE lease_key = $1', [MEDIAVINE_LEASE]));
        const sites = JSON.parse(cached?.sites ?? '[]') as Site[];
        if (!sites.some(site => site.id === input.siteId)) throw new MediavineError('invalid', 'Load your Mediavine sites and choose one this account can access.');
      }
      await writeSettings(env, input, lane);
      // Disable cancels retries; a fresh explicit enable can recover a failed connection.
      if (input.holidayCalendar === undefined || input.enabled !== enabled(lane) || input.siteId !== lane.mediavineSiteId) {
        await env.STORE.write((tx) => tx.execute('DELETE FROM noticeos.mediavine_state WHERE asset_id = $1', [input.asset]));
      }
    }, {}, true);
    return { ok: true, value: await mediavineStatus(env, input.asset) };
  } catch (error) { return { ok: false, message: mediavineMessage(error) }; }
}
export async function putMediavineCredential(env: IngestEnv, input: PutCredentialInput): Promise<PutCredentialResult> {
  try {
    return await withMediavineLease(env, async () => {
      const result = await putCredential(env, input);
      if (result.ok) {
        await env.STORE.write((tx) => tx.execute(
          'UPDATE noticeos.integration_leases SET sites = NULL, sites_checked_at = NULL, auth_blocked = false, last_error = NULL WHERE lease_key = $1',
          [MEDIAVINE_LEASE]));
        await env.STORE.write((tx) => tx.execute('UPDATE noticeos.mediavine_state SET auth_blocked = false'));
      }
      return result;
    }, {}, true);
  } catch (error) { return { ok: false, error: 'store_unavailable', message: mediavineMessage(error) }; }
}

/**
 * The connect panel's press for Mediavine: sign in with the typed login and
 * list the account's sites, keeping the login only if Mediavine accepts it.
 * Runs under the one Mediavine lease, so no sync or probe interleaves. The
 * session and the site list the sign-in produced are kept with the login, so
 * the panel's list that follows asks Mediavine nothing more. The answer is a
 * verdict, never Mediavine's own words.
 */
export async function connectMediavine(
  env: IngestEnv,
  fields: Record<string, string>,
  options: Pick<MediavineOptions, 'fetchImpl' | 'nowMs'> = {},
): Promise<{ verdict: 'accepted'; facts: ConnectFacts } | { verdict: 'refused' } | { verdict: 'unreachable' } | Extract<PutCredentialResult, { ok: false }>> {
  const now = options.nowMs ?? Date.now();
  const transport = options.fetchImpl ?? fetch;
  try {
    return await withMediavineLease(env, async () => {
      let session: Session | null = null;
      const client = new MediavineClient({
        credentials: { email: fields.MEDIAVINE_USER ?? '', password: fields.MEDIAVINE_PASSWORD ?? '' },
        session: null,
        saveSession: async (value) => { session = value; },
        fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) =>
          transport(input, { ...init, signal: AbortSignal.timeout(WATCHED_REQUEST_TIMEOUT_MS) })) as typeof fetch,
        ...(options.nowMs === undefined ? {} : { now: () => now }),
      });
      let sites: Site[];
      try {
        sites = await client.sites();
      } catch (error) {
        // Mediavine saying no — a wrong login, two-factor, no site access — is
        // a refusal; anything else is Mediavine not answering usably.
        return error instanceof MediavineError && (error.kind === 'auth' || error.kind === 'permission')
          ? { verdict: 'refused' as const }
          : { verdict: 'unreachable' as const };
      }
      const stored = await putCredential(env, { provider: 'mediavine', fields });
      if (!stored.ok) return stored;
      await env.STORE.write((tx) => tx.execute(
        `UPDATE noticeos.integration_leases SET sites = $1::jsonb, sites_checked_at = $2::timestamptz, auth_blocked = false, last_error = NULL
          WHERE lease_key = $3`,
        [JSON.stringify(sites), new Date(now), MEDIAVINE_LEASE]));
      await env.STORE.write((tx) => tx.execute('UPDATE noticeos.mediavine_state SET auth_blocked = false'));
      if (session !== null) await saveMediavineSession(env, JSON.stringify(session));
      return { verdict: 'accepted' as const, facts: { sites: sites.length } };
    }, { nowMs: now }, true);
  } catch {
    // The lease is held by a sync already talking to Mediavine.
    return { verdict: 'unreachable' };
  }
}

/**
 * Forget the login and its session. The sites' mappings stay as they are:
 * with no login nothing syncs, and connecting again lists them as already
 * mapped rather than each reading Not using, a reason nobody gave.
 */
export async function disconnectMediavine(env: IngestEnv): Promise<DeleteCredentialResult> {
  return withMediavineLease(env, async () => {
    const result = await deleteCredential(env, 'mediavine');
    await env.STORE.write((tx) => tx.execute(
      'UPDATE noticeos.integration_leases SET sites = NULL, sites_checked_at = NULL WHERE lease_key = $1', [MEDIAVINE_LEASE]));
    await env.STORE.write((tx) => tx.execute('DELETE FROM noticeos.mediavine_state'));
    return result;
  }, {}, true);
}

/** One Mediavine attempt as the store keeps it; the money in integer cents. */
type RunRow = {
  attempted_at: string; message: string | null; start_date: string; end_date: string;
  summary_minor: bigint | null; daily_minor: bigint | null; difference_minor: bigint | null;
};

export async function mediavineStatus(env: IngestEnv, asset: string): Promise<MediavineStatus> {
  const lane = laneFor(await register(env), asset);
  const [credential, { last, success, daily, state }] = await Promise.all([
    credentialSummary(env, 'mediavine'),
    // Ties on one instant go to the attempt written last.
    env.STORE.read(async (tx) => ({
      last: (await tx.query<RunRow>(
        `SELECT attempted_at, message, start_date, end_date, summary_minor, daily_minor, difference_minor
           FROM noticeos.mediavine_runs WHERE asset_id = $1 ORDER BY attempted_at DESC, run_seq DESC LIMIT 1`, [asset]))[0],
      success: (await tx.query<RunRow>(
        `SELECT attempted_at, message, start_date, end_date, summary_minor, daily_minor, difference_minor
           FROM noticeos.mediavine_runs WHERE asset_id = $1 AND outcome = 'success' ORDER BY attempted_at DESC, run_seq DESC LIMIT 1`, [asset]))[0],
      daily: await tx.query<{ date: string; amount_minor: bigint }>(
        `SELECT revenue_date AS date, SUM(amount_minor)::bigint AS amount_minor FROM noticeos.current_revenue
          WHERE asset_id = $1 AND source = $2 GROUP BY revenue_date ORDER BY revenue_date DESC LIMIT 90`, [asset, MEDIAVINE_REVENUE_SOURCE]),
      state: (await tx.query<{ next_attempt_at: string | null }>(
        'SELECT next_attempt_at FROM noticeos.mediavine_state WHERE asset_id = $1', [asset]))[0],
    })),
  ]);
  const connected = credential?.source === 'store';
  const available = pacificDay(Date.now());
  const nextAttemptMs = epochMs(state?.next_attempt_at ?? null);
  return { asset, connected, enabled: enabled(lane), siteId: lane.mediavineSiteId ?? null,
    holidayCalendar: lane.revenueHolidayCalendar ?? 'none',
    availableThrough: available.ready ? available.yesterday : shiftDate(available.yesterday, -1),
    lastAttemptAt: last ? javascriptInstant(last.attempted_at) : null, lastSuccessAt: success ? javascriptInstant(success.attempted_at) : null,
    reportedThrough: daily[0]?.date ?? null, error: credential?.lastError ?? last?.message ?? null,
    nextAttemptAt: connected && enabled(lane) && nextAttemptMs ? new Date(nextAttemptMs).toISOString() : null,
    summaryMinor: centsOrNull(success?.summary_minor ?? null), dailyMinor: centsOrNull(success?.daily_minor ?? null),
    differenceMinor: centsOrNull(success?.difference_minor ?? null), comparisonStart: success?.start_date ?? null,
    comparisonEnd: success?.end_date ?? null,
    daily: daily.map((day) => ({ date: day.date, amountMinor: cents(day.amount_minor) })).reverse() };
}

/** One collected report: its run and every changed daily figure, together,
 * each figure into the revenue ledger under Mediavine's source. */
export async function persistReport(env: Pick<IngestEnv, 'STORE'>, asset: string, report: Report): Promise<string> {
  return env.STORE.write(tx => writeReport(tx, asset, report));
}

async function writeReport(tx: Transaction, asset: string, report: Report, batchId: string | null = null): Promise<string> {
  const runId = crypto.randomUUID();
  const days = report.daily.map((day) => {
    if (day.revenueMinor === null) throw new MediavineError('incomplete', 'Mediavine has not reported every requested day yet.');
    return { date: day.date, amountMinor: day.revenueMinor };
  });
  // One transaction: a run and every changed daily observation land together.
  // A day is written only when its current figure differs, one statement a
  // day in the report's order, so a repeated day reads the figure the report
  // wrote before it.
  // Serialize first-observation checks even when a report is written outside the collector lease.
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `noticeos.mediavine-revenue:${tx.workspaceId}:${asset}`,
  ]);
  await tx.execute(
    'INSERT INTO noticeos.mediavine_sites (workspace_id, site_id, asset_id) VALUES ($1::uuid, $2, $3) ON CONFLICT DO NOTHING',
    [tx.workspaceId, report.site.id, asset]);
  await tx.execute(
    `INSERT INTO noticeos.mediavine_runs (workspace_id, run_id, asset_id, site_id, start_date, end_date, attempted_at, outcome,
                                          summary_minor, daily_minor, difference_minor)
     VALUES ($1::uuid, $2, $3, $4, $5::date, $6::date, $7::timestamptz, 'success', $8, $9, $10)`,
    [tx.workspaceId, runId, asset, report.site.id, report.period.start, report.period.end, report.fetchedAt,
      report.summaryMinor, report.dailyMinor, report.differenceMinor]);
  for (const day of days) {
    await tx.execute(
      `INSERT INTO noticeos.revenue_observations (workspace_id, asset_id, source, account_ref, revenue_date, amount_minor,
                                                  currency, run_ref, recorded_at)
       SELECT $1::uuid, $2::text, $3::text, $4::text, $5::date, $6::bigint, 'USD', $7::text, $8::timestamptz
        WHERE NOT EXISTS (SELECT 1 FROM noticeos.current_revenue
                           WHERE asset_id = $2::text AND source = $3::text AND account_ref = $4::text
                             AND revenue_date = $5::date AND item_ref IS NULL AND amount_minor = $6::bigint)`,
      [tx.workspaceId, asset, MEDIAVINE_REVENUE_SOURCE, report.site.id, day.date, day.amountMinor, runId, report.fetchedAt]);
  }
  await enqueueRevenueNotifications(tx, { asset, source: MEDIAVINE_REVENUE_SOURCE, accountRef: report.site.id, runId, ...report.period, batchId });
  return runId;
}

/** How long after Mediavine answers without a figure for a day it is asked
 * again: under an hour, so the retry lands on the Mediavine tick an hour on. */
export const UNPUBLISHED_RETRY_MS = 55 * 60_000;

async function markCollected(tx: Transaction, asset: string, siteId: string, targetDate: string): Promise<void> {
  await tx.execute(
    `INSERT INTO noticeos.mediavine_state (workspace_id, asset_id, site_id, target_date, attempts) VALUES ($1::uuid, $2, $3, $4::date, 0)
     ON CONFLICT (workspace_id, asset_id) DO UPDATE SET site_id = excluded.site_id, target_date = excluded.target_date,
       attempts = 0, next_attempt_at = NULL, last_error = NULL, auth_blocked = false`,
    [tx.workspaceId, asset, siteId, targetDate]);
}

async function recordReportFailure(
  env: IngestEnv, asset: string, siteId: string, { start, end }: Period, targetDate: string,
  attempts: number, now: number, missedAt: string, health: HealthConnection | null, error: unknown,
): Promise<boolean> {
  const message = mediavineMessage(error);
  const auth = error instanceof MediavineError && (error.kind === 'auth' || error.kind === 'permission');
  // A report Mediavine has not finished is no failure: it is asked for
  // again every hour, uncounted, until its reporting day ends and the
  // next morning's run asks for the day again. Failures back off 20
  // then 40 minutes, three a day.
  const unfinished = error instanceof MediavineError && error.kind === 'incomplete';
  const failures = unfinished ? attempts : attempts + 1;
  const next = auth || failures >= 3 ? null : Math.max(now + (unfinished ? UNPUBLISHED_RETRY_MS : (attempts === 0 ? 20 : 40) * 60_000), error instanceof MediavineError ? error.retryAt ?? 0 : 0);
  const runId = crypto.randomUUID();
  await env.STORE.write(async (tx) => {
    await tx.execute(
      `INSERT INTO noticeos.mediavine_runs (workspace_id, run_id, asset_id, site_id, start_date, end_date, attempted_at, outcome, message)
       VALUES ($1::uuid, $2, $3, $4, $5::date, $6::date, $7::timestamptz, $8, $9)`,
      [tx.workspaceId, runId, asset, siteId, start, end, missedAt,
        error instanceof MediavineError && error.kind === 'incomplete' ? 'incomplete' : 'failed', message]);
    await tx.execute(
      `INSERT INTO noticeos.mediavine_state (workspace_id, asset_id, site_id, target_date, attempts, next_attempt_at, last_error, auth_blocked)
       VALUES ($1::uuid, $2, $3, $4::date, $5, $6::timestamptz, $7, $8)
       ON CONFLICT (workspace_id, asset_id) DO UPDATE SET target_date = excluded.target_date, attempts = excluded.attempts,
         next_attempt_at = excluded.next_attempt_at, last_error = excluded.last_error, auth_blocked = excluded.auth_blocked`,
      [tx.workspaceId, asset, siteId, targetDate, failures, next === null ? null : new Date(next), message, auth]);
  });
  const monitoringAvailable = await observeIntegration(env, health, { capability: 'mediavine-revenue', asset, target: siteId, observedAt: missedAt, attemptId: runId, evidenceSource: 'mediavine_runs', ok: false, code: error instanceof MediavineError ? error.kind : 'network', nextAttemptAt: next ? new Date(next).toISOString() : null });
  if (auth && error.permissionScope === 'account') {
    await recordCredentialOutcome(env, 'mediavine', { ok: false, error: message, at: new Date(now).toISOString() });
  }
  return monitoringAvailable;
}

async function planReport(env: IngestEnv, input: MediavineSync, now: number, automatic: boolean): Promise<{ period: Period; attempts: number } | null> {
  const clock = pacificDay(now);
  const [stored] = await env.STORE.read((tx) => tx.query<Omit<State, 'next_attempt_at'> & { next_attempt_at: string | null }>(
    'SELECT site_id, target_date, attempts, next_attempt_at, auth_blocked FROM noticeos.mediavine_state WHERE asset_id = $1', [input.asset]));
  const state: State | undefined = stored && { ...stored, next_attempt_at: epochMs(stored.next_attempt_at) };
  // Before 6:10 a.m. Pacific the newest complete day is the one before
  // yesterday: a sync pressed then (the connect panel's first collection,
  // Refresh) collects through it rather than failing; the schedule waits.
  if (!clock.ready && (automatic || (input.end !== undefined && input.end >= clock.yesterday))) throw new MediavineError('incomplete', 'Yesterday’s report is collected after 6:10 a.m. Pacific.');
  const end = input.end ?? (clock.ready ? clock.yesterday : shiftDate(clock.yesterday, -1));
  if (end > clock.yesterday || (input.start === undefined) !== (input.end === undefined)) throw new MediavineError('invalid', 'Choose both dates, ending no later than yesterday.');
  const [last] = await env.STORE.read((tx) => tx.query<{ day: string | null }>(
    'SELECT MAX(revenue_date) AS day FROM noticeos.current_revenue WHERE asset_id = $1 AND source = $2',
    [input.asset, MEDIAVINE_REVENUE_SOURCE]));
  // First sync fills this month; after an outage, one request covers missed days. The usual run asks only for yesterday.
  const monthStart = `${end.slice(0, 7)}-01`;
  const desiredStart = input.start ?? (last?.day && last.day < monthStart ? shiftDate(last.day, 1) : monthStart);
  const baseline = input.start ?? (desiredStart < shiftDate(end, -365) ? shiftDate(end, -365) : desiredStart);
  const held = await env.STORE.read((tx) => tx.query<{ revenue_date: string }>(
    `SELECT DISTINCT revenue_date FROM noticeos.current_revenue
      WHERE asset_id = $1 AND source = $2 AND revenue_date BETWEEN $3::date AND $4::date`,
    [input.asset, MEDIAVINE_REVENUE_SOURCE, baseline, end]));
  const heldDates = new Set(held.map(day => day.revenue_date));
  const missing = dates({ start: baseline, end }).filter(day => !heldDates.has(day));
  const period = { start: input.start ?? missing[0] ?? end, end };
  dates(period);
  if (automatic && missing.length === 0) return null;
  if (automatic && state?.auth_blocked) return null;
  const attempts = state?.target_date === clock.yesterday ? state.attempts : 0;
  if (automatic && (attempts >= 3 || (state?.next_attempt_at !== null && state?.next_attempt_at !== undefined && state.next_attempt_at > now))) return null;
  const [recent] = await env.STORE.read((tx) => tx.query<{ attempted_at: string }>(
    'SELECT attempted_at FROM noticeos.mediavine_runs WHERE asset_id = $1 ORDER BY attempted_at DESC LIMIT 1', [input.asset]));
  if (recent && epochMs(recent.attempted_at)! > now - 900_000) throw new MediavineError('busy', 'A sync was attempted recently. Wait 15 minutes before another refresh.');
  return { period, attempts };
}

/** `unfinished`: Mediavine answered, and a requested day has no figure yet. */
export async function syncMediavine(env: IngestEnv, input: MediavineSync, options: MediavineOptions & { automatic?: boolean } = {}): Promise<MediavineResult<MediavineStatus> & Pick<ScheduledRunResult, 'outcome'> & { unfinished?: true }> {

  const now = options.nowMs ?? Date.now(); const clock = pacificDay(now);
  // Set inside the lease's callback, so declared wide rather than narrowed.
  let outcome = 'skipped' as ScheduledRunResult['outcome'];
  let monitoringAvailable = true;
  try {
    await withMediavineLease(env, async (assertLease) => {
      const config = await register(env); const lane = laneFor(config, input.asset);
      if (!enabled(lane)) throw new MediavineError('invalid', 'Enable this asset’s Mediavine sync first.');
      const siteId = lane.mediavineSiteId!;
      await validateSiteAssignment(env, config, input.asset, siteId);
      const planned = await planReport(env, input, now, options.automatic === true);
      if (planned === null) return;
      const { period, attempts } = planned;
      const at = new Date(now).toISOString();
      // When this attempt is recorded as missing a day; after a stored part it
      // is that part's instant, so the missing day reads as the latest run.
      let missedAt = at;
      let health: HealthConnection | null = null;
      try {
        const credential = await resolveCredential(env, 'mediavine');
        health = await tryHealthConnection(env, 'mediavine', credential);
        const client = await mediavineClient(env, { ...options, assertLease, beforeRequest: async () => {
          await assertLease();
          const current = laneFor(await register(env), input.asset);
          if (!enabled(current) || current.mediavineSiteId !== siteId || (await credentialSummary(env, 'mediavine'))?.source !== 'store') {
            throw new MediavineError('busy', 'Mediavine sync was paused or disconnected.');
          }
        } }, credential);
        const report = await client.revenue(siteId, period);
        const current = laneFor(await register(env), input.asset);
        if (!enabled(current) || current.mediavineSiteId !== siteId) return;
        await assertLease();
        await validateSiteAssignment(env, await register(env), input.asset, siteId);
        if (!report.complete) throw new MediavineError('incomplete', 'Mediavine has not reported every requested day yet. Saved revenue is unchanged.');
        // The days before an unpublished one are stored now; the unpublished
        // day stays unknown and is asked for again (`UNPUBLISHED_RETRY_MS`).
        const published = publishedPart(report);
        const runId = published === null ? null : await persistReport(env, input.asset, published);
        if (runId !== null) { outcome = 'ran'; missedAt = report.fetchedAt; await recordCredentialOutcome(env, 'mediavine', { ok: true, at }); }
        if (published !== report) throw new MediavineError('incomplete', `Mediavine has not published revenue for ${report.unpublishedDates.join(', ')} yet. It is checked again every hour.`);
        monitoringAvailable = await observeIntegration(env, health, { capability: 'mediavine-revenue', asset: input.asset, target: siteId, observedAt: report.fetchedAt, attemptId: runId!, evidenceSource: 'mediavine_runs', ok: true });
        await env.STORE.write(tx => markCollected(tx, input.asset, siteId, clock.yesterday));
      } catch (error) {
        if (error instanceof MediavineError && error.kind === 'busy') return;
        monitoringAvailable = await recordReportFailure(env, input.asset, siteId, period, clock.yesterday, attempts, now, missedAt, health, error);
        throw error;
      }
    }, options);
    return { ok: true, value: await mediavineStatus(env, input.asset), outcome, ...(!monitoringAvailable ? { monitoringAvailable: false } : {}) };
  } catch (error) {
    const unfinished = error instanceof MediavineError && error.kind === 'incomplete';
    // Days before the unpublished one were stored: the sync worked, and the
    // status names the day still to come and when it is asked for again.
    if (unfinished && outcome === 'ran') {
      try { return { ok: true, value: await mediavineStatus(env, input.asset), outcome, ...(!monitoringAvailable ? { monitoringAvailable: false } : {}) }; } catch { /* reported below */ }
    }
    return { ok: false, message: mediavineMessage(error), ...(!monitoringAvailable ? { monitoringAvailable: false } : {}),
      ...(unfinished ? { unfinished: true as const } : {}),
      outcome: error instanceof MediavineError && error.kind === 'busy' ? 'skipped' : 'failed' };
  }
}

interface PlannedSite {
  asset: string;
  siteId: string;
  period: Period;
  attempts: number;
}

type CollectionOutcome = 'ran' | 'waiting' | 'failed' | 'skipped';

function holdsMediavineAccount(error: unknown): error is MediavineError {
  return error instanceof MediavineError && (error.retryAt !== null || error.kind === 'auth'
    || (error.kind === 'permission' && error.permissionScope === 'account'));
}

async function collectDailyRevenue(
  env: IngestEnv, assets: readonly string[], now: number, date: string, options: MediavineOptions,
  log: (asset: string, outcome: CollectionOutcome, message?: string) => void,
): Promise<string[]> {
  const history: string[] = [];
  const at = new Date(now).toISOString();
  await withMediavineLease(env, async assertLease => {
    const config = await register(env);
    const due: PlannedSite[] = [];
    for (const asset of assets) {
      const lane = laneFor(config, asset);
      if (!enabled(lane)) continue;
      try {
        await validateSiteAssignment(env, config, asset, lane.mediavineSiteId!);
        const plan = await planReport(env, { asset }, now, true);
        if (plan === null) log(asset, 'skipped');
        else if (plan.period.start !== date) history.push(asset);
        else due.push({ asset, siteId: lane.mediavineSiteId!, ...plan });
      } catch (error) {
        log(asset, error instanceof MediavineError && error.kind === 'busy' ? 'skipped' : 'failed', mediavineMessage(error));
      }
    }
    if (due.length === 0) return;
    const credential = await resolveCredential(env, 'mediavine');
    const health = await tryHealthConnection(env, 'mediavine', credential);
    const stillEnabled = (config: Register, target: PlannedSite) => {
      const lane = laneFor(config, target.asset);
      return enabled(lane) && lane.mediavineSiteId === target.siteId;
    };
    const client = await mediavineClient(env, { ...options, assertLease, beforeRequest: async () => {
      await assertLease();
      const current = await register(env);
      if (!due.some(target => stillEnabled(current, target)) || (await credentialSummary(env, 'mediavine'))?.source !== 'store') {
        throw new MediavineError('busy', 'Mediavine sync was paused or disconnected.');
      }
    } }, credential);
    const recordFailure = async (target: PlannedSite, error: unknown) => {
      await recordReportFailure(env, target.asset, target.siteId, target.period, date, target.attempts, now, at, health, error);
      log(target.asset, error instanceof MediavineError && error.kind === 'incomplete' ? 'waiting' : 'failed', mediavineMessage(error));
    };
    let portfolio: PortfolioRevenue;
    try {
      portfolio = await client.dailyRevenue(date, new Set(due.map(target => target.siteId)));
    } catch (error) {
      if (error instanceof MediavineError && error.kind === 'busy') throw error;
      const current = await register(env);
      for (const target of due) {
        if (stillEnabled(current, target)) await recordFailure(target, error);
      }
      // The lease records account-wide backoff before another request can start.
      if (holdsMediavineAccount(error)) throw error;
      return;
    }
    const current = await register(env);
    const published: { target: PlannedSite; report: Report }[] = [];
    const failures: { target: PlannedSite; error: MediavineError }[] = [];
    for (const target of due) {
      if (!stillEnabled(current, target)) continue;
      const report = portfolio.reports.get(target.siteId);
      if (report === undefined && portfolio.hasNextPage) history.push(target.asset);
      else if (report === undefined) failures.push({ target, error: new MediavineError('invalid', 'Mediavine did not return this site’s report.') });
      else if (report instanceof MediavineError) failures.push({ target, error: report });
      else if (!report.complete || report.unpublishedDates.length > 0) failures.push({
        target, error: new MediavineError('incomplete', `Mediavine has not published revenue for ${date} yet. It is checked again every hour.`),
      });
      else published.push({ target, report });
    }
    if (published.length > 0) {
      await assertLease();
      // Commit every published figure and notification from this response before waking delivery.
      const batchId = crypto.randomUUID();
      const saved = await env.STORE.write(async tx => {
        const runs = [];
        for (const { target, report } of published) {
          const runId = await writeReport(tx, target.asset, report, batchId);
          await markCollected(tx, target.asset, target.siteId, date);
          runs.push({ target, report, runId });
        }
        return runs;
      });
      await recordCredentialOutcome(env, 'mediavine', { ok: true, at });
      for (const { target, report, runId } of saved) {
        await observeIntegration(env, health, { capability: 'mediavine-revenue', asset: target.asset, target: target.siteId,
          observedAt: report.fetchedAt, attemptId: runId, evidenceSource: 'mediavine_runs', ok: true });
        log(target.asset, 'ran');
      }
    }
    for (const { target, error } of failures) await recordFailure(target, error);
  }, { ...options, nowMs: now });
  return history;
}

export async function runMediavine(env: IngestEnv, options: MediavineOptions = {}): Promise<ScheduledRunResult> {
  const skipped: ScheduledRunResult = { outcome: 'skipped', detail: 'No Mediavine report is due.' };
  const now = options.nowMs ?? Date.now();
  const clock = pacificDay(now);
  if (!clock.ready) return skipped;
  const config = await register(env);
  const targets = Object.entries(config.assets ?? {}).filter(([, lanes]) => enabled(lanes['ad-network'] ?? {}));
  if (targets.length === 0 || (await credentialSummary(env, 'mediavine'))?.source !== 'store') return skipped;
  const [connection] = await env.STORE.read((tx) => tx.query<{ auth_blocked: boolean }>(
    'SELECT auth_blocked FROM noticeos.integration_leases WHERE lease_key = $1', [MEDIAVINE_LEASE]));
  if (connection?.auth_blocked) return { outcome: 'skipped', detail: 'Mediavine needs to be reconnected.' };
  let ran = 0; let failed = 0; let waiting = 0;
  const log = (asset: string, outcome: CollectionOutcome, message?: string) => {
    if (outcome === 'ran') ran++;
    else if (outcome === 'waiting') waiting++;
    else if (outcome === 'failed') failed++;
    console.log(JSON.stringify({ event: 'mediavine_sync', asset, outcome, ...(message ? { message } : {}) }));
  };
  let history: string[] = [];
  try {
    history = await collectDailyRevenue(env, targets.map(([asset]) => asset), now, clock.yesterday, options, log);
  } catch (error) {
    if (error instanceof MediavineError && error.kind === 'busy') return skipped;
    if (!holdsMediavineAccount(error) || failed === 0) throw error;
  }
  for (const asset of history) {
    const result = await syncMediavine(env, { asset }, { ...options, automatic: true });
    log(asset, !result.ok && result.unfinished ? 'waiting' : result.outcome, result.ok ? undefined : result.message);
  }
  if (failed) return { outcome: 'failed', detail: `${failed} Mediavine syncs failed; ${ran} completed.` };
  if (ran) return { outcome: 'ran', detail: `${ran} Mediavine syncs completed.` };
  return waiting ? { outcome: 'skipped', detail: `Mediavine has not published yesterday’s revenue for ${waiting} ${waiting === 1 ? 'site' : 'sites'} yet; checked again every hour.` } : skipped;
}
