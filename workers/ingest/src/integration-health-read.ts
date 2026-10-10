import {
  INTEGRATION_MONITORS, INTEGRATION_MONITORING_GAPS, INTEGRATION_CADENCE_HOURS, REPORT_STALE_MULTIPLIER,
  integrationCapabilityHealth, integrationScopeKey, type IntegrationHealthItem, type IntegrationHealthPayload,
  type IntegrationMonitorDefinition, type IntegrationProviderId, type IntegrationObservation,
} from '@noticeos/contract';
import { javascriptInstant, type Transaction, type WorkspaceStore } from '@noticeos/postgres';
import { getConfigDocument } from './config-store.js';
import { resolveCredential } from './credentials.js';
import { resolveGoogleCredential } from './google-oauth.js';
import { googleTargets, googleCredentialResolver } from './google-signals.js';
import { healthConnection, healthScope, type HealthConnection } from './integration-health-context.js';
import { HEALTH_STATE_SELECT, healthFailure, healthId, observationFromRow, storedHealthRow, type StoredHealthRow } from './integration-health-store.js';
import { parseFeedTargets } from './calendar.js';
import { integrationArchivePlan, BING_ARCHIVE_FAMILIES, type Ga4CustomDimensionConfig } from './signal-dumps.js';
import { loadBingPortfolioCandidates, bingSiteMapping } from './bing-client.js';
import { dataForSeoCandidates, dataForSeoTarget, dataForSeoFamiliesFor, DATAFORSEO_REPORT_CADENCE_DAYS, type SerpPanelConfig } from './dataforseo-dumps.js';
import { clarityCandidates, resolveClarityTokens, CLARITY_REPORT } from './clarity-dumps.js';
import { POSTHOG_KEY_SLOT, posthogCandidates, resolvePosthogKeys } from './posthog-dumps.js';
import { POSTHOG_ACCOUNT_KEY_SLOT } from './posthog-account.js';
import { POSTHOG_FAMILIES, mediavineSyncOn } from '@noticeos/contract';
import { cellDeclined, posthogSettings, type LaneRegister } from './lane-mapping.js';

type Spec = { connection: HealthConnection; capability: string; asset?: string; target?: string; family?: string; detail?: string; report?: string; reportDate?: string; paused?: boolean; requiredSince?: string | null; observations?: IntegrationObservation[]; lastSuccessAt?: string | null; nextAttemptAt?: string | null };
interface SignalRow { id: string; asset: string; integration: string; property_ref: string; started_at: string; finished_at: string; status: string; error_code: string | null; credential_ref: string; provider_truncated?: number }
interface DumpRow extends Omit<SignalRow, 'started_at'> { requested_at: string; report: string; report_date: string; last_success_at: string | null; scope_count: number; failure_count: number; family_rank: number }
type EventRow = { workspace_id: string; event_id: string; provider: string; connection_revision: string; capability: string; asset: string; target_id: string; family: string; recorded_at: string; kind: 'failed' | 'changed' | 'recovered' };
/** `where` over the target `t` and state `s`. A failure first, then the
 * newest; a tie in the order its target was named. */
async function healthStates(tx: Transaction, where: string, params: readonly (string | readonly string[])[], limit: number): Promise<StoredHealthRow[]> {
  const rows = await tx.query<StoredHealthRow>(`${HEALTH_STATE_SELECT}
    WHERE ${where}
    ORDER BY CASE WHEN s.outcome = 'failure' THEN 0 ELSE 1 END, s.started_at DESC, t.target_seq LIMIT ${limit}`, params);
  return rows.map(storedHealthRow);
}
/** One site's targets, or the account's (asset ''), as the LAST parameter,
 * `$n`: an account's target names no site, so it binds none. */
const assetIs = (asset: string, n: number) => (asset === '' ? 't.asset_id IS NULL' : `t.asset_id = $${n}`);
const assetParam = (asset: string): string[] => (asset === '' ? [] : [asset]);
const definition = (provider: IntegrationProviderId, capability: string): IntegrationMonitorDefinition => {
  const found = INTEGRATION_MONITORS[provider].find(item => item.id === capability);
  if (!found) throw new Error('Unknown integration monitor');
  return found;
};
const familyKey = (report: string, date: string) => JSON.stringify([report, date, '', '']);
const familyReport = (family: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(family);
    return Array.isArray(parsed) && typeof parsed[0] === 'string' ? parsed[0] : null;
  } catch { return null; }
};
/**
 * Archive lanes whose provider only answers with its current state, so a
 * report date whose collection never reached the provider can never be asked
 * for again. Once such a connection has a later attempt that did not fail at
 * the network, the old network failure stops counting as current. Only a
 * network failure: a refusal is hidden by nothing but a success of its own
 * date, and dated archives (GA4, Search Console, PostHog windows) are asked
 * again instead. A date-less family's newest attempt breaks a `requested_at`
 * tie by the newest date.
 */
const CURRENT_STATE_ARCHIVES = new Set(['bing-webmaster', 'clarity', 'dataforseo']);
const since = (now: number, hours: number) => new Date(now - hours * REPORT_STALE_MULTIPLIER * 3_600_000).toISOString();

/**
 * One daily lane's last 50 collection attempts on one property, newest first,
 * and its newest success since the connection last changed. Attempts that
 * started in the same instant come in the order they were written.
 */
async function readDailyRuns(
  store: WorkspaceStore,
  asset: string,
  lane: string,
  target: string,
  changedAt: string | null,
): Promise<{ runs: SignalRow[]; success: { finished_at: string } | undefined }> {
  type Run = {
    id: string; asset: string; integration: string; property_ref: string; started_at: string; finished_at: string;
    status: string; error_code: string | null; credential_ref: string;
  };
  const [runs, [success]] = await store.read((tx) =>
    Promise.all([
      tx.query<Run>(
        `SELECT run_id AS id, asset_id AS asset, integration, property_ref, started_at, finished_at, status, error_code, credential_ref
           FROM noticeos.signal_runs
          WHERE asset_id = $1 AND integration = $2 AND property_ref = $3
          ORDER BY started_at DESC, run_seq
          LIMIT 50`,
        [asset, lane, target],
      ),
      tx.query<{ finished_at: string }>(
        `SELECT finished_at
           FROM noticeos.signal_runs
          WHERE asset_id = $1 AND integration = $2 AND property_ref = $3 AND status = 'success'
            AND ($4::timestamptz IS NULL OR started_at >= $4::timestamptz)
          ORDER BY started_at DESC, run_seq
          LIMIT 1`,
        [asset, lane, target, changedAt],
      ),
    ]),
  );
  return {
    runs: runs.map((row) => ({ ...row, started_at: javascriptInstant(row.started_at), finished_at: javascriptInstant(row.finished_at) })),
    success: success && { finished_at: javascriptInstant(success.finished_at) },
  };
}

/**
 * The Bing properties a site's collections were saved under, each once, in
 * byte order, at most 50: its daily runs' and its report runs'.
 */
async function savedBingProperties(env: IngestEnv, asset: string): Promise<{ property_ref: string }[]> {
  return env.STORE.read((tx) =>
    tx.query<{ property_ref: string }>(
      `SELECT property_ref
         FROM (SELECT property_ref FROM noticeos.signal_runs WHERE asset_id = $1 AND integration = 'bing-webmaster'
               UNION
               SELECT property_ref FROM noticeos.archive_runs WHERE asset_id = $1 AND integration = 'bing-webmaster') saved
        ORDER BY property_ref COLLATE "C"
        LIMIT 50`,
      [asset],
    ),
  );
}

/** A read of saved evidence only. No provider requests, probes, deliveries or
 * health writes occur here. Failure of one inventory leaves other providers
 * visible, with completeness explicitly unknown. */
export async function readIntegrationHealth(env: IngestEnv, nowMs = Date.now()): Promise<IntegrationHealthPayload> {
  const payload: IntegrationHealthPayload = { generatedAt: new Date(nowMs).toISOString(), available: true, items: [], events: [] };
  let eventRows: EventRow[] = [];
  const limitedProviders = new Set<string>();
  let observerAvailable = true;
  try {
    eventRows = await env.STORE.read(async (tx) => {
      await tx.query('SELECT 1 FROM noticeos.integration_capability_state LIMIT 1');
      // The newest transitions; a tie newest-started first, then by id.
      const rows = await tx.query<EventRow>(`SELECT e.workspace_id, e.event_id, t.provider, t.connection_revision, t.capability, COALESCE(t.asset_id, '') AS asset,
          t.target_id, t.family, e.recorded_at, e.kind
        FROM noticeos.integration_health_events e
        JOIN noticeos.capability_targets t ON t.workspace_id = e.workspace_id AND t.target_seq = e.target_seq
        ORDER BY e.recorded_at DESC, e.started_at DESC, e.event_id COLLATE "C" LIMIT 100`);
      return rows.map(row => ({ ...row, recorded_at: javascriptInstant(row.recorded_at) }));
    });
  } catch { observerAvailable = false; payload.available = false; }
  const observed = new Map<string, StoredHealthRow>();
  const currentItems = new Map<string, IntegrationHealthItem>();
  let register: LaneRegister;
  let custom: Ga4CustomDimensionConfig;
  let panel: SerpPanelConfig;
  try {
    const reads = await Promise.all(['config/integrations.json', 'config/ga4-custom-dimensions.json', 'config/serp-panel.json'].map(file => getConfigDocument(env, file)));
    if (reads.some(read => read.source !== 'store' || read.version === null || !read.body || typeof read.body !== 'object')) throw new Error('Inventory unavailable');
    register = reads[0]!.body as LaneRegister;
    custom = reads[1]!.body as Ga4CustomDimensionConfig;
    panel = reads[2]!.body as SerpPanelConfig;
    if (!register.assets || typeof register.assets !== 'object') throw new Error('Inventory unavailable');
  } catch { return { ...payload, available: false }; }

  const add = async (spec: Spec) => {
    const def = definition(spec.connection.provider, spec.capability);
    const scope = await healthScope(spec.connection, spec.capability, spec.asset, spec.target, spec.family);
    const key = integrationScopeKey(scope);
    const stored = observed.get(key);
    const legacyUnverified = spec.observations !== undefined && spec.observations.length > 0 && !stored;
    // A source result cannot prove this connection recovered, but an unmatched
    // newer attempt does invalidate an older green monitoring result.
    const unrecordedAttempt = stored?.outcome !== 'failure' && spec.observations?.some(item =>
      item.attemptId !== stored?.attempt_id && Date.parse(item.startedAt) >= Date.parse(stored?.started_at ?? ''));
    const observations = stored ? [observationFromRow(stored)] : [];
    const latestAt = observations.reduce<string | null>((latest, item) => !latest || item.startedAt > latest ? item.startedAt : latest, null);
    // A display's old success is idle, never an unattended freshness promise.
    // A failure stays visible however old it becomes.
    const requiredSince = spec.requiredSince !== undefined ? spec.requiredSince
      : def.trigger === 'demand' && latestAt && nowMs - Date.parse(latestAt) < (spec.capability === 'ga4-realtime' ? 60_000 : spec.capability === 'ga4-hourly' ? 1_800_000 : 600_000) ? latestAt : null;
    const setup = def.evidence === 'setup-only';
    const projected = integrationCapabilityHealth({ scope, connection: !spec.connection.configured ? 'disconnected' : spec.paused ? 'paused' : 'connected',
      covered: !setup, observerAvailable: observerAvailable && !legacyUnverified && !unrecordedAttempt && !limitedProviders.has(spec.connection.provider), trigger: def.trigger, observations, requiredSince, nowMs });
    const state = setup && spec.connection.configured ? 'idle' : projected.state;
    // Public IDs are based on product identity, never on credentials or private targets.
    const id = await healthId([spec.connection.provider, spec.capability, spec.asset ?? '', spec.family ?? '', spec.detail ?? '']);
    const lastSuccess = stored?.last_success_finished_at ?? projected.lastSuccessAt;
    const item: IntegrationHealthItem = { id, provider: spec.connection.provider, capability: spec.capability, label: def.label, asset: spec.asset ?? null,
      // `detail` is display text; nothing downstream parses it.
      detail: spec.detail ?? null, report: spec.report ?? null, reportDate: spec.reportDate ?? null, state, lastAttemptAt: projected.latest?.startedAt ?? null,
      lastSuccessAt: lastSuccess && Date.parse(lastSuccess) <= nowMs ? lastSuccess : null,
      nextAttemptAt: spec.nextAttemptAt ?? projected.latest?.nextAttemptAt ?? null,
      failure: projected.latest?.failure ?? null, code: projected.latest?.code ?? null,
      action: def.action, coverage: setup ? 'setup' : 'monitored' };
    payload.items.push(item); currentItems.set(key, item);
  };
  const fromLegacy = async (connection: HealthConnection, capability: string, asset: string, target: string, family: string, source: SignalRow): Promise<IntegrationObservation> => {
    const failure = source.status === 'error' ? healthFailure(source.error_code) : source.provider_truncated === 1 ? healthFailure('incomplete-report') : null;
    return { scope: await healthScope(connection, capability, asset, target, family), attemptId: source.id,
      startedAt: source.started_at, finishedAt: source.finished_at, outcome: failure ? 'failure' : 'success',
      failure: failure?.failure ?? null, code: failure?.code ?? null, nextAttemptAt: null };
  };
  const afterEdit = (connection: HealthConnection, at: string) => !connection.changedAt || Date.parse(at) >= Date.parse(connection.changedAt);
  const daily = async (connection: HealthConnection, capability: string, asset: string, target: string, lane: string, hours: number, paused: boolean) => {
    const { runs, success } = await readDailyRuns(env.STORE, asset, lane, target, connection.changedAt ?? null);
    const history = runs.filter(row => afterEdit(connection, row.started_at));
    await add({ connection, capability, asset, target, detail: lane === 'bing-webmaster' ? target.split('?')[0] : undefined, paused, requiredSince: since(nowMs, hours), lastSuccessAt: success?.finished_at, observations: await Promise.all(history.map(row => fromLegacy(connection, capability, asset, target, '', row))) });
  };
  const archive = async (connection: HealthConnection, capability: string, asset: string, target: string, lane: string, plan: { report: string; date?: string; cadenceDays: number }[], paused: boolean) => {
    // Latest outcome of each exact report/date, plus its last successful attempt.
    // No age cut-off can make an unresolved failed date disappear.
    const dated = plan.filter(item => item.date);
    const history = (await env.STORE.read(tx => tx.query<Omit<DumpRow, 'provider_truncated'> & { provider_truncated: boolean }>(`SELECT *, (COUNT(*) OVER ())::int AS scope_count, (COUNT(*) FILTER (WHERE status = 'error' OR provider_truncated) OVER ())::int AS failure_count FROM (
      SELECT *, (ROW_NUMBER() OVER (PARTITION BY report ORDER BY requested_at DESC, report_date DESC, run_seq DESC))::int AS family_rank FROM (
      SELECT run_id AS id, asset_id AS asset, integration, property_ref, credential_ref, report, report_date, requested_at, finished_at, status, error_code, provider_truncated, run_seq,
        FIRST_VALUE(CASE WHEN status IN ('success','unchanged') AND NOT provider_truncated THEN finished_at END) OVER (PARTITION BY report, report_date ORDER BY CASE WHEN status IN ('success','unchanged') AND NOT provider_truncated THEN 0 ELSE 1 END, requested_at DESC, run_seq DESC) AS last_success_at,
        ROW_NUMBER() OVER (PARTITION BY report, report_date ORDER BY requested_at DESC, CASE WHEN status = 'error' OR provider_truncated THEN 0 ELSE 1 END, run_seq DESC) AS rank
      FROM noticeos.archive_runs WHERE asset_id = $1 AND integration = $2 AND property_ref = $3 AND ($4::timestamptz IS NULL OR requested_at >= $4::timestamptz)
      ) latest WHERE rank = 1 AND report = ANY($5::text[])
    ) families WHERE status = 'error' OR provider_truncated OR (report, report_date) IN (SELECT * FROM unnest($6::text[], $7::date[])) OR (family_rank = 1 AND report = ANY($8::text[]))
    ORDER BY CASE WHEN status = 'error' OR provider_truncated THEN 0 ELSE 1 END, requested_at DESC, run_seq DESC LIMIT 256`,
    [asset, lane, target, connection.changedAt || null, [...new Set(plan.map(item => item.report))], dated.map(item => item.report), dated.map(item => item.date!), plan.filter(item => !item.date).map(item => item.report)])))
      .map(row => ({ ...row, provider_truncated: row.provider_truncated ? 1 : 0, requested_at: javascriptInstant(row.requested_at), finished_at: javascriptInstant(row.finished_at), last_success_at: row.last_success_at === null ? null : javascriptInstant(row.last_success_at) }));
    // A capped list says so as a value, failures first, and its action opens
    // the full history.
    if ((history[0]?.scope_count ?? 0) > history.length) {
      const def = definition(connection.provider, capability);
      payload.items.push({ id: await healthId([connection.provider, capability, asset, 'overflow']), provider: connection.provider, capability, label: def.label, asset, report: null, reportDate: null, detail: `256 of ${history[0]!.scope_count} report dates · ${history[0]!.failure_count} unresolved failures`, state: 'unknown', lastAttemptAt: null, lastSuccessAt: null, nextAttemptAt: null, failure: 'monitoring', code: 'monitoring', action: 'Inspect report history for the full archive.', coverage: 'monitored' });
    }
    const families = new Map(plan.map(item => [item.report, item]));
    const wanted = new Map<string, { report: string; date: string; cadenceDays: number; row?: DumpRow }>();
    for (const item of plan) {
      // A family with no fixed date is represented by its NEWEST attempt. The
      // history is ordered failures first, so a plain find would stand an old
      // failed date in for the family and hide what it collected since; that
      // failed date keeps its own item below either way.
      const row = (item.date ? undefined : history.find(row => row.report === item.report && row.family_rank === 1))
        ?? history.find(row => row.report === item.report && (!item.date || row.report_date === item.date));
      const date = item.date ?? row?.report_date ?? '';
      wanted.set(familyKey(item.report, date), { ...item, date, row });
    }
    for (const row of history) {
      const planItem = families.get(row.report);
      if ((row.status === 'error' || row.provider_truncated === 1) && planItem) wanted.set(familyKey(row.report, row.report_date), { ...planItem, date: row.report_date, row });
    }
    if (observerAvailable) {
      const scope = await healthScope(connection, capability, asset, target);
      // Select current obligations and unresolved failures before applying the
      // bound. Resolved historical dates never consume current health coverage.
      const states = await env.STORE.read(tx => healthStates(tx,
        `t.provider = $1 AND t.connection_revision = $2 AND t.capability = $3 AND t.target_id = $4
          AND (s.outcome = 'failure' OR t.family = ANY($5::text[])) AND ${assetIs(asset, 6)}`,
        [scope.provider, scope.connection, capability, scope.target, [...wanted.keys()], ...assetParam(asset)], 257));
      if (states.length > 256) {
        payload.items.push({ id: await healthId([connection.provider, capability, asset, target, 'monitor-overflow']), provider: connection.provider, capability, label: definition(connection.provider, capability).label, asset, report: null, reportDate: null, detail: '256 of 257+ current reports and failures', state: 'unknown', lastAttemptAt: null, lastSuccessAt: null, nextAttemptAt: null, failure: 'monitoring', code: 'monitoring', action: 'Review report history for the full backlog.', coverage: 'monitored' });
      }
      for (const row of states.slice(0, 256)) {
        observed.set(integrationScopeKey(observationFromRow(row).scope), row);
        if (row.outcome !== 'failure') continue;
        const family: unknown = JSON.parse(row.family);
        if (!Array.isArray(family) || typeof family[0] !== 'string' || typeof family[1] !== 'string') throw new Error('Invalid report identity');
        const planItem = families.get(family[0]);
        if (planItem && !wanted.has(row.family)) wanted.set(row.family, { ...planItem, date: family[1], row: history.find(item => item.report === family[0] && item.report_date === family[1]) });
      }
      const network = CURRENT_STATE_ARCHIVES.has(lane)
        ? states.slice(0, 256).filter(row => row.outcome === 'failure' && row.failure_kind === 'network')
        : [];
      if (network.length > 0) {
        // The newest attempt of each report, for this asset on this connection,
        // that did not fail at the network. Across the asset's targets: a night
        // the site list never arrived files its failures under the bare domain,
        // and every later snapshot under the verified site it stood in for.
        // A report's families are the JSON text collection-attempt.ts writes
        // (`["report","date","",""]`), so each begins with its report's prefix.
        const reports = [...new Set(network.flatMap(row => familyReport(row.family) ?? []))];
        const answered = await env.STORE.read(tx => tx.query<{ report: string; answeredAt: string | null }>(
          `SELECT r.report, (SELECT max(s.started_at)
               FROM noticeos.capability_targets t
               JOIN noticeos.integration_capability_state s ON s.workspace_id = t.workspace_id AND s.target_seq = t.target_seq
              WHERE t.provider = $1 AND t.connection_revision = $2 AND t.capability = $3 AND starts_with(t.family, r.prefix)
                AND s.failure_kind IS DISTINCT FROM 'network' AND ${assetIs(asset, 6)}) AS "answeredAt"
             FROM unnest($4::text[], $5::text[]) AS r(report, prefix)`,
          [scope.provider, scope.connection, capability, reports, reports.map(report => `[${JSON.stringify(report)},`), ...assetParam(asset)]));
        const answeredAt = new Map(answered.flatMap(row => row.answeredAt === null ? [] : [[row.report, javascriptInstant(row.answeredAt)] as const]));
        for (const row of network) {
          const report = familyReport(row.family);
          if (report !== null && (answeredAt.get(report) ?? '') > row.started_at) wanted.delete(row.family);
        }
      }
    }
    for (const [family, item] of wanted) {
      const observations = item.row ? [await fromLegacy(connection, capability, asset, target, family, { ...item.row, started_at: item.row.requested_at })] : [];
      await add({ connection, capability, asset, target, family, detail: [item.report, item.date, ...(lane === 'bing-webmaster' ? [target.split('?')[0]] : [])].filter(Boolean).join(' · '),
        report: item.report || undefined, reportDate: /^\d{4}-\d{2}-\d{2}$/.test(item.date) ? item.date : undefined, paused,
        requiredSince: since(nowMs, item.cadenceDays * 24), observations, lastSuccessAt: item.row?.last_success_at });
    }
  };

  for (const provider of Object.keys(INTEGRATION_MONITORS) as IntegrationProviderId[]) {
    const providerStart = payload.items.length;
    try {
      const credential = await resolveCredential(env, provider);
      const connection = await healthConnection(env, provider, credential);
      if (observerAvailable) {
        const archives = INTEGRATION_MONITORS[provider].filter(def => def.evidence === 'signal_dump_runs').map(def => def.id);
        const states = await env.STORE.read(tx => healthStates(tx,
          `t.provider = $1 AND t.connection_revision = $2 AND t.capability <> ALL($3::text[])`, [provider, connection.revision, archives], 2049));
        if (states.length > 2048) { limitedProviders.add(provider); payload.available = false; }
        for (const row of states.slice(0, 2048)) observed.set(integrationScopeKey(observationFromRow(row).scope), row);
      }
      const defs = INTEGRATION_MONITORS[provider];
      if (!connection.configured) {
        for (const def of defs) await add({ connection, capability: def.id });
        continue;
      }
      for (const def of defs.filter(def => def.trigger === 'setup' || (def.trigger === 'event' && !['google-discovery', 'discord-delivery', 'dataforseo-credit'].includes(def.id)))) await add({ connection, capability: def.id });
      if (provider === 'google') {
        for (const family of ['Analytics', 'Search Console']) await add({ connection, capability: 'google-discovery', family, detail: family });
        const google = await resolveGoogleCredential(env);
        const targets = googleTargets(google, google.source, googleCredentialResolver(env), register);
        for (const target of targets) {
          const paused = cellDeclined(register.assets[target.asset]?.[target.integration]);
          if (target.integration === 'ga4') for (const capability of ['ga4-realtime', 'ga4-hourly']) await add({ connection, capability, asset: target.asset, target: target.propertyRef, paused });
          await daily(connection, `${target.integration}-daily`, target.asset, target.propertyRef, target.integration, INTEGRATION_CADENCE_HOURS.signals, paused);
          await archive(connection, `${target.integration}-archive`, target.asset, target.propertyRef, target.integration, await integrationArchivePlan(env.STORE, target, nowMs, custom), paused);
        }
      } else if (provider === 'bing-webmaster') {
        for (const target of await loadBingPortfolioCandidates(env.STORE)) {
          const mapped = bingSiteMapping(target.asset, target.domain, null, register)?.value;
          const saved = mapped ? [] : await savedBingProperties(env, target.asset);
          const refs = new Set<string>(mapped ? [mapped] : []);
          for (const row of saved) {
            if (row.property_ref === target.domain) { refs.add(row.property_ref); continue; }
            try { if (new URL(row.property_ref).hostname.replace(/^www\./, '') === target.domain.replace(/^www\./, '')) refs.add(row.property_ref); } catch { /* Invalid source identity is not inventory. */ }
          }
          if (!refs.size) refs.add(target.domain);
          const paused = cellDeclined(register.assets[target.asset]?.['bing-webmaster']);
          for (const ref of refs) {
            await daily(connection, 'bing-daily', target.asset, ref, 'bing-webmaster', INTEGRATION_CADENCE_HOURS.bingSignals, paused);
            await archive(connection, 'bing-archive', target.asset, ref, 'bing-webmaster', BING_ARCHIVE_FAMILIES, paused);
          }
        }
      } else if (provider === 'dataforseo') {
        await add({ connection, capability: 'dataforseo-credit' });
        for (const target of await dataForSeoCandidates(env.STORE)) await archive(connection, 'dataforseo-research', target.asset, dataForSeoTarget(target, '', register).propertyRef, 'dataforseo',
          dataForSeoFamiliesFor(target.asset, panel).map(report => ({ report, cadenceDays: DATAFORSEO_REPORT_CADENCE_DAYS[report] ?? 7 })), cellDeclined(register.assets[target.asset]?.dataforseo));
      } else if (provider === 'clarity') {
        const tokens = resolveClarityTokens(credential.fields.CLARITY_TOKENS, credential.legacySlots);
        for (const target of await clarityCandidates(env.STORE)) if (tokens.has(target.asset)) await archive(connection, 'clarity-export', target.asset, target.domain, 'clarity', [{ report: CLARITY_REPORT, cadenceDays: 1 }], cellDeclined(register.assets[target.asset]?.clarity));
      } else if (provider === 'posthog') {
        // One daily obligation per family an asset is actually due: a key AND a
        // saved region + project; funnels only where some are declared. The
        // account's one key is a key for every site.
        const keys = resolvePosthogKeys(credential.fields[POSTHOG_KEY_SLOT]);
        const accountKey = Boolean(credential.fields[POSTHOG_ACCOUNT_KEY_SLOT]);
        for (const target of await posthogCandidates(env.STORE)) {
          if (!accountKey && !keys.has(target.asset)) continue;
          const read = posthogSettings(target.asset, register);
          if (!read.ok) continue;
          const plan = POSTHOG_FAMILIES.filter((family) => family !== 'funnels' || read.settings.funnels.length > 0)
            .map((report) => ({ report, cadenceDays: 1 }));
          await archive(connection, 'posthog-archive', target.asset, `${read.settings.host}:${read.settings.projectId}`, 'posthog', plan, cellDeclined(register.assets[target.asset]?.posthog));
        }
      } else if (provider === 'calendar') {
        const raw: unknown = JSON.parse(credential.fields.CALENDAR_FEEDS ?? '{}');
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid feed inventory');
        const feeds = parseFeedTargets(credential.fields.CALENDAR_FEEDS);
        if (Object.keys(raw).length !== feeds.length) throw new Error('Invalid feed inventory');
        for (const feed of feeds) await add({ connection, capability: 'calendar-feed', target: feed.url ?? feed.label, family: feed.label, detail: feed.label });
      } else if (provider === 'discord') {
        await add({ connection, capability: 'discord-delivery', target: credential.fields.DISCORD_WEBHOOK_URL });
      } else if (provider === 'mediavine') {
        for (const [asset, lanes] of Object.entries(register.assets)) {
          const config = lanes?.['ad-network'];
          if (typeof config?.mediavineSiteId !== 'string') continue;
          const target = config.mediavineSiteId;
          // The site's attempts (a run is known by its own text id), its retry
          // time and its latest success since the connection last changed.
          const stored = await env.STORE.read(async (tx) => ({
            history: await tx.query<{ id: string; attempted_at: string; outcome: string }>(
              `SELECT run_id AS id, attempted_at, outcome FROM noticeos.mediavine_runs
                WHERE asset_id = $1 AND site_id = $2 ORDER BY attempted_at DESC, run_seq DESC LIMIT 50`, [asset, target]),
            retry: (await tx.query<{ next_attempt_at: string | null }>(
              'SELECT next_attempt_at FROM noticeos.mediavine_state WHERE asset_id = $1 AND site_id = $2', [asset, target]))[0],
            success: (await tx.query<{ attempted_at: string }>(
              `SELECT attempted_at FROM noticeos.mediavine_runs
                WHERE asset_id = $1 AND site_id = $2 AND outcome = 'success' AND ($3::timestamptz IS NULL OR attempted_at >= $3::timestamptz)
                ORDER BY attempted_at DESC LIMIT 1`, [asset, target, connection.changedAt || null]))[0],
          }));
          const history = stored.history.map(row => ({ ...row, attempted_at: javascriptInstant(row.attempted_at) })).filter(row => afterEdit(connection, row.attempted_at));
          const retryAt = stored.retry?.next_attempt_at ? javascriptInstant(stored.retry.next_attempt_at) : null;
          const observations = await Promise.all(history.map(row => fromLegacy(connection, 'mediavine-revenue', asset, target, '', { id: row.id, asset, integration: provider, property_ref: target, started_at: row.attempted_at, finished_at: row.attempted_at, status: row.outcome === 'success' ? 'success' : 'error', error_code: row.outcome === 'incomplete' ? 'incomplete-report' : 'provider', credential_ref: '' })));
          const success = stored.success ? javascriptInstant(stored.success.attempted_at) : undefined;
          await add({ connection, capability: 'mediavine-revenue', lastSuccessAt: success, asset, target, paused: !mediavineSyncOn(config), requiredSince: new Date(nowMs - 36 * 3_600_000).toISOString(), observations, nextAttemptAt: retryAt });
        }
      }
      if ((await healthConnection(env, provider)).revision !== connection.revision) throw new Error('Connection changed');
    } catch {
      payload.items.splice(providerStart);
      for (const [key, item] of currentItems) if (item.provider === provider) currentItems.delete(key);
      payload.available = false;
      payload.items.push({ id: `unknown-${provider}`, provider, capability: 'inventory', label: 'Monitoring unavailable', asset: null, detail: null, report: null, reportDate: null, state: 'unknown', lastAttemptAt: null, lastSuccessAt: null, nextAttemptAt: null, failure: 'monitoring', code: 'monitoring', action: 'Check the NoticeOS service and connection settings.', coverage: 'gap' });
    }
  }
  for (const [asset, lanes] of Object.entries(register.assets)) for (const [lane, cell] of Object.entries(lanes ?? {})) {
    const gap = INTEGRATION_MONITORING_GAPS[lane];
    if (!gap || cellDeclined(cell) || cell.status === 'needs-setup') continue;
    payload.items.push({ id: await healthId([asset, lane]), provider: lane, capability: lane, label: String(register.catalog?.find(item => item.id === lane)?.label ?? lane), asset, detail: null, report: null, reportDate: null, state: 'unmonitored', lastAttemptAt: null, lastSuccessAt: null, nextAttemptAt: null, failure: null, code: gap, action: 'Review this source’s setup and monitoring coverage.', coverage: 'gap' });
  }
  for (const event of eventRows) {
    const item = currentItems.get(integrationScopeKey({ workspace: event.workspace_id, provider: event.provider, connection: event.connection_revision, capability: event.capability, asset: event.asset, target: event.target_id, family: event.family }));
    if (item && Date.parse(event.recorded_at) <= nowMs) payload.events.push({ id: event.event_id, itemId: item.id, provider: item.provider, label: item.label, asset: item.asset, at: event.recorded_at, kind: event.kind });
  }
  return payload;
}
