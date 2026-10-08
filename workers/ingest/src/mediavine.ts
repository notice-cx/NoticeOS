import { resolveCredential } from './credentials.js';
import { observeIntegration, tryHealthConnection, type HealthConnection } from './integration-health-context.js';
import { MediavineClient, MediavineError, dates, pacificDay, shiftDate, type Report, type Session, type Site } from '@noticeos/mediavine';
import type { ConnectFacts, MediavineResult, MediavineSettings, MediavineStatus, MediavineSync, PutCredentialInput, PutCredentialResult, DeleteCredentialResult, ScheduledRunResult } from '@noticeos/contract';
import { mediavineSyncOn } from '@noticeos/contract';
import type { FileJsonSetOp, JsonValue } from '../../../scripts/config-documents.mjs';
import { applyConfigOps, getConfigDocument, forgetConfigCache } from './config-store.js';
import { credentialSummary, deleteCredential, putCredential, recordCredentialOutcome, saveMediavineSession } from './credentials.js';
import { javascriptInstant } from '@noticeos/postgres';
import { MEDIAVINE_LEASE, mediavineClient, mediavineMessage, withMediavineLease, type MediavineOptions } from './mediavine-connection.js';

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
  // A mapped site syncs until its Data sources row says Not using — the one
  // rule the Tower and the monitoring read too (`mediavineSyncOn`, bead
  // `ro-ujb9.96.7.6`), so the connect panel's Start is what starts it.
  return mediavineSyncOn(lane);
}
async function validateSiteAssignment(env: IngestEnv, config: Register, asset: string, siteId: string): Promise<void> {
  const previous = await env.STORE.read((tx) => tx.query<{ asset: string; site_id: string }>(
    'SELECT asset_id AS asset, site_id FROM noticeos.mediavine_sites WHERE asset_id = $1 OR site_id = $2', [asset, siteId]));
  if (previous.some(row => row.asset !== asset || row.site_id !== siteId)) throw new MediavineError('invalid', 'This site already has revenue assigned elsewhere. Keep the original asset and site mapping.');
  if (Object.entries(config.assets ?? {}).some(([id, lanes]) => id !== asset && lanes['ad-network']?.mediavineSiteId === siteId)) throw new MediavineError('invalid', 'This Mediavine site is already assigned to another asset.');
}
function settingOp(asset: string, field: string, held: unknown, value: JsonValue): FileJsonSetOp {
  const pointer = `/assets/${asset.replaceAll('~', '~0').replaceAll('/', '~1')}/ad-network/${field}`;
  return { kind: 'file-json-set', file: FILE, pointer, value,
    ...(held === undefined ? { expectAbsent: true as const } : { expect: held as JsonValue }) };
}
async function writeSettings(env: IngestEnv, input: MediavineSettings, lane: Lane): Promise<void> {
  // This door STARTS a sync and never records a decline (bead
  // `ro-ujb9.96.7.21`): Not using is the site's own row, which saves the reason
  // with it (`declineOps`, apps/tower/shared/lane-decline.ts), so no `skipped`
  // cell is ever written here without one.
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
    if (!input || typeof input.asset !== 'string' || typeof input.siteId !== 'string' || typeof input.enabled !== 'boolean') throw new MediavineError('invalid', 'Choose a site and whether automatic sync is enabled.');
    if (input.holidayCalendar !== undefined && !['none', 'US', 'CA', 'US,CA'].includes(input.holidayCalendar)) throw new MediavineError('invalid', 'Choose a supported holiday calendar.');
    await withMediavineLease(env, async () => {
      const config = await register(env); const lane = laneFor(config, input.asset);
      await validateSiteAssignment(env, config, input.asset, input.siteId);
      if (!config.assets?.[input.asset]?.['ad-network']) throw new MediavineError('invalid', 'This asset has no ad revenue data source.');
      // Switching a running sync off is a decline, and a decline carries its
      // reason: it is the Ad revenue row's Not using, never this door.
      if (!input.enabled && enabled(lane)) throw new MediavineError('invalid', 'Stop this sync with Not using on the site’s Ad revenue row.');
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
/** How long the connect panel's Checking waits on Mediavine for each call —
 * a person is watching it. */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * THE CONNECT PANEL'S PRESS FOR MEDIAVINE (bead `ro-ujb9.96.7.6`): sign in with
 * the typed login and list the account's sites — the free read Test makes —
 * and keep the login only if Mediavine accepts it. It runs under the one
 * Mediavine lease, so no sync or probe interleaves with it, and a login that
 * is refused changes nothing already stored. What the sign-in produced is kept
 * with the login: the session (so the next call does not sign in again) and
 * the site list (so the panel's list that follows asks Mediavine nothing more).
 * The answer is a verdict, never Mediavine's own words.
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
          transport(input, { ...init, signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) })) as typeof fetch,
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
 * Forget the login and its session. The sites' mappings stay as they are, as
 * every other provider's do (bead `ro-ujb9.96.7.6`): with no login nothing
 * syncs, and connecting again lists them as already mapped — rather than
 * each one reading Not using, a reason nobody gave.
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
    // Ties on one instant go to the attempt written last, as D1's rowid did.
    env.STORE.read(async (tx) => ({
      last: (await tx.query<RunRow>(
        `SELECT attempted_at, message, start_date, end_date, summary_minor, daily_minor, difference_minor
           FROM noticeos.mediavine_runs WHERE asset_id = $1 ORDER BY attempted_at DESC, run_seq DESC LIMIT 1`, [asset]))[0],
      success: (await tx.query<RunRow>(
        `SELECT attempted_at, message, start_date, end_date, summary_minor, daily_minor, difference_minor
           FROM noticeos.mediavine_runs WHERE asset_id = $1 AND outcome = 'success' ORDER BY attempted_at DESC, run_seq DESC LIMIT 1`, [asset]))[0],
      daily: await tx.query<{ date: string; amount_minor: bigint }>(
        'SELECT report_date AS date, amount_minor FROM noticeos.mediavine_current_daily WHERE asset_id = $1 ORDER BY report_date DESC LIMIT 90', [asset]),
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

/** One collected report: its run and every changed daily figure, together. */
export async function persistReport(env: Pick<IngestEnv, 'STORE'>, asset: string, report: Report): Promise<string> {
  const runId = crypto.randomUUID();
  const days = report.daily.map((day) => {
    if (day.revenueMinor === null) throw new MediavineError('incomplete', 'Mediavine has not reported every requested day yet.');
    return { date: day.date, amountMinor: day.revenueMinor };
  });
  // One transaction: a run and every changed daily observation land together.
  // A day is written only when its current figure differs, one statement a
  // day in the report's order, so a day repeated in one report reads the
  // figure the report wrote before it, as it did in D1's batch.
  await env.STORE.write(async (tx) => {
    await tx.execute(
      'INSERT INTO noticeos.mediavine_sites (workspace_id, site_id, asset_id) VALUES ($1::uuid, $2, $3) ON CONFLICT DO NOTHING',
      [tx.workspaceId, report.site.id, asset]);
    const [run] = await tx.query<{ run_seq: bigint }>(
      `INSERT INTO noticeos.mediavine_runs (workspace_id, run_id, asset_id, site_id, start_date, end_date, attempted_at, outcome,
                                            summary_minor, daily_minor, difference_minor)
       VALUES ($1::uuid, $2, $3, $4, $5::date, $6::date, $7::timestamptz, 'success', $8, $9, $10)
       RETURNING run_seq`,
      [tx.workspaceId, runId, asset, report.site.id, report.period.start, report.period.end, report.fetchedAt,
        report.summaryMinor, report.dailyMinor, report.differenceMinor]);
    for (const day of days) {
      await tx.execute(
        `INSERT INTO noticeos.mediavine_daily (workspace_id, run_seq, asset_id, site_id, report_date, amount_minor, recorded_at)
         SELECT $1::uuid, $2::bigint, $3::text, $4::text, $5::date, $6::bigint, $7::timestamptz
          WHERE NOT EXISTS (SELECT 1 FROM noticeos.mediavine_current_daily
                             WHERE asset_id = $3::text AND site_id = $4::text AND report_date = $5::date AND amount_minor = $6::bigint)`,
        [tx.workspaceId, run!.run_seq, asset, report.site.id, day.date, day.amountMinor, report.fetchedAt]);
    }
  });
  return runId;
}

export async function syncMediavine(env: IngestEnv, input: MediavineSync, options: MediavineOptions & { automatic?: boolean } = {}): Promise<MediavineResult<MediavineStatus> & Pick<ScheduledRunResult, 'outcome'>> {

  const now = options.nowMs ?? Date.now(); const clock = pacificDay(now);
  let outcome: ScheduledRunResult['outcome'] = 'skipped';
  let monitoringAvailable = true;
  try {
    await withMediavineLease(env, async (assertLease) => {
      const config = await register(env); const lane = laneFor(config, input.asset);
      if (!enabled(lane)) throw new MediavineError('invalid', 'Enable this asset’s Mediavine sync first.');
      const siteId = lane.mediavineSiteId!;
      await validateSiteAssignment(env, config, input.asset, siteId);
      const [stored] = await env.STORE.read((tx) => tx.query<Omit<State, 'next_attempt_at'> & { next_attempt_at: string | null }>(
        'SELECT site_id, target_date, attempts, next_attempt_at, auth_blocked FROM noticeos.mediavine_state WHERE asset_id = $1', [input.asset]));
      const state: State | undefined = stored && { ...stored, next_attempt_at: epochMs(stored.next_attempt_at) };
      // Before 6:10 a.m. Pacific the newest complete day is the one before
      // yesterday: a sync pressed then (the connect panel's first collection,
      // Refresh) collects through it rather than failing; the schedule waits.
      if (!clock.ready && (options.automatic || (input.end !== undefined && input.end >= clock.yesterday))) throw new MediavineError('incomplete', 'Yesterday’s report is collected after 6:10 a.m. Pacific.');
      const end = input.end ?? (clock.ready ? clock.yesterday : shiftDate(clock.yesterday, -1));
      if (end > clock.yesterday || (input.start === undefined) !== (input.end === undefined)) throw new MediavineError('invalid', 'Choose both dates, ending no later than yesterday.');
      const [last] = await env.STORE.read((tx) => tx.query<{ day: string | null }>(
        'SELECT MAX(report_date) AS day FROM noticeos.mediavine_current_daily WHERE asset_id = $1', [input.asset]));
      // First sync fills this month; after an outage, one request covers missed days. The usual run asks only for yesterday.
      const monthStart = `${end.slice(0, 7)}-01`;
      const desiredStart = input.start ?? (last?.day && last.day < monthStart ? shiftDate(last.day, 1) : monthStart);
      const baseline = input.start ?? (desiredStart < shiftDate(end, -365) ? shiftDate(end, -365) : desiredStart);
      const held = await env.STORE.read((tx) => tx.query<{ report_date: string }>(
        'SELECT report_date FROM noticeos.mediavine_current_daily WHERE asset_id = $1 AND report_date BETWEEN $2::date AND $3::date',
        [input.asset, baseline, end]));
      const heldDates = new Set(held.map(day => day.report_date));
      const missing = dates({ start: baseline, end }).filter(day => !heldDates.has(day));
      const start = input.start ?? missing[0] ?? end;
      const period = { start, end }; dates(period);
      if (options.automatic && missing.length === 0) return;
      if (options.automatic && state?.auth_blocked) return;
      const attempts = state?.target_date === clock.yesterday ? state.attempts : 0;
      if (options.automatic && (attempts >= 3 || (state?.next_attempt_at !== null && state?.next_attempt_at !== undefined && state.next_attempt_at > now))) return;
      const [recent] = await env.STORE.read((tx) => tx.query<{ attempted_at: string }>(
        'SELECT attempted_at FROM noticeos.mediavine_runs WHERE asset_id = $1 ORDER BY attempted_at DESC LIMIT 1', [input.asset]));
      if (recent && epochMs(recent.attempted_at)! > now - 900_000) throw new MediavineError('busy', 'A sync was attempted recently. Wait 15 minutes before another refresh.');
      const at = new Date(now).toISOString();
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
        const runId = await persistReport(env, input.asset, report);
        monitoringAvailable = await observeIntegration(env, health, { capability: 'mediavine-revenue', asset: input.asset, target: siteId, observedAt: report.fetchedAt, attemptId: runId, evidenceSource: 'mediavine_runs', ok: true });
        outcome = 'ran';
        await env.STORE.write((tx) => tx.execute(
          `INSERT INTO noticeos.mediavine_state (workspace_id, asset_id, site_id, target_date, attempts) VALUES ($1::uuid, $2, $3, $4::date, 0)
           ON CONFLICT (workspace_id, asset_id) DO UPDATE SET site_id = excluded.site_id, target_date = excluded.target_date,
             attempts = 0, next_attempt_at = NULL, last_error = NULL, auth_blocked = false`,
          [tx.workspaceId, input.asset, siteId, clock.yesterday]));
        await recordCredentialOutcome(env, 'mediavine', { ok: true, at });
      } catch (error) {
        if (error instanceof MediavineError && error.kind === 'busy') return;
        const message = mediavineMessage(error);
        const auth = error instanceof MediavineError && (error.kind === 'auth' || error.kind === 'permission');
        const next = auth || attempts + 1 >= 3 ? null : Math.max(now + (attempts === 0 ? 20 : 40) * 60_000, error instanceof MediavineError ? error.retryAt ?? 0 : 0);
        const runId = crypto.randomUUID();
        await env.STORE.write(async (tx) => {
          await tx.execute(
            `INSERT INTO noticeos.mediavine_runs (workspace_id, run_id, asset_id, site_id, start_date, end_date, attempted_at, outcome, message)
             VALUES ($1::uuid, $2, $3, $4, $5::date, $6::date, $7::timestamptz, $8, $9)`,
            [tx.workspaceId, runId, input.asset, siteId, start, end, at,
              error instanceof MediavineError && error.kind === 'incomplete' ? 'incomplete' : 'failed', message]);
          await tx.execute(
            `INSERT INTO noticeos.mediavine_state (workspace_id, asset_id, site_id, target_date, attempts, next_attempt_at, last_error, auth_blocked)
             VALUES ($1::uuid, $2, $3, $4::date, $5, $6::timestamptz, $7, $8)
             ON CONFLICT (workspace_id, asset_id) DO UPDATE SET target_date = excluded.target_date, attempts = excluded.attempts,
               next_attempt_at = excluded.next_attempt_at, last_error = excluded.last_error, auth_blocked = excluded.auth_blocked`,
            [tx.workspaceId, input.asset, siteId, clock.yesterday, attempts + 1, next === null ? null : new Date(next), message, auth]);
        });
        monitoringAvailable = await observeIntegration(env, health, { capability: 'mediavine-revenue', asset: input.asset, target: siteId, observedAt: at, attemptId: runId, evidenceSource: 'mediavine_runs', ok: false, code: error instanceof MediavineError ? error.kind : 'network', nextAttemptAt: next ? new Date(next).toISOString() : null });
        if (auth) await recordCredentialOutcome(env, 'mediavine', { ok: false, error: message, at });
        throw error;
      }
    }, options);
    return { ok: true, value: await mediavineStatus(env, input.asset), outcome, ...(!monitoringAvailable ? { monitoringAvailable: false } : {}) };
  } catch (error) { return { ok: false, message: mediavineMessage(error), ...(!monitoringAvailable ? { monitoringAvailable: false } : {}), outcome: error instanceof MediavineError && error.kind === 'busy' ? 'skipped' : 'failed' }; }
}

export async function runMediavine(env: IngestEnv, options: MediavineOptions = {}): Promise<ScheduledRunResult> {
  const skipped: ScheduledRunResult = { outcome: 'skipped', detail: 'No Mediavine report is due.' };
  if (!pacificDay(options.nowMs ?? Date.now()).ready) return skipped;
  const config = await register(env);
  const targets = Object.entries(config.assets ?? {}).filter(([, lanes]) => enabled(lanes['ad-network'] ?? {}));
  if (targets.length === 0 || (await credentialSummary(env, 'mediavine'))?.source !== 'store') return skipped;
  const [connection] = await env.STORE.read((tx) => tx.query<{ auth_blocked: boolean }>(
    'SELECT auth_blocked FROM noticeos.integration_leases WHERE lease_key = $1', [MEDIAVINE_LEASE]));
  if (connection?.auth_blocked) return { outcome: 'skipped', detail: 'Mediavine needs to be reconnected.' };
  let ran = 0; let failed = 0;
  for (const [asset] of targets) {
    const result = await syncMediavine(env, { asset }, { ...options, automatic: true });
    if (result.outcome === 'ran') ran++;
    if (result.outcome === 'failed') failed++;
    console.log(JSON.stringify({ event: 'mediavine_sync', asset, outcome: result.outcome, ...(result.ok ? {} : { message: result.message }) }));
  }
  return failed ? { outcome: 'failed', detail: `${failed} Mediavine syncs failed; ${ran} completed.` } : ran ? { outcome: 'ran', detail: `${ran} Mediavine syncs completed.` } : skipped;
}
