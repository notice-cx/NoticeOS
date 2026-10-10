import { INTEGRATION_MONITORS, integrationFailureMessage, integrationScopeKey, type IntegrationFailureKind, type IntegrationHealthScope, type IntegrationObservation } from '@noticeos/contract';
import { javascriptInstant, type Transaction, type WorkspaceStore } from '@noticeos/postgres';

export type HealthCode = IntegrationFailureKind | 'rate-limit-daily' | 'rate-limit-hourly';
export function healthFailure(code: unknown): { failure: IntegrationFailureKind; code: HealthCode } {
  const value = typeof code === 'string' ? code : '';
  // `clarity_daily_cap_reached`: Clarity's ten calls a day.
  if (value === 'rate-limit-daily' || /daily-(tokens|requests)|daily_cap/.test(value)) return { failure: 'rate-limit', code: 'rate-limit-daily' };
  if (value === 'rate-limit-hourly' || /hourly-tokens/.test(value)) return { failure: 'rate-limit', code: 'rate-limit-hourly' };
  if (/429|quota|rate.limit/.test(value)) return { failure: 'rate-limit', code: 'rate-limit' };
  // `clarity_token_rejected` is Clarity's 401/403.
  if (/401|403|auth|credential|grant|access|permission|token_rejected/.test(value)) return { failure: 'access', code: 'access' };
  if (/budget|balance|credit/.test(value)) return { failure: 'budget', code: 'budget' };
  // `local_store_failed`: the provider answered and this machine could not keep
  // it; NoticeOS's fault, never the provider's.
  if (/cache_unavailable|coordination|monitoring|local_store/.test(value)) return { failure: 'monitoring', code: 'monitoring' };
  if (/timeout|network|request_failed|unreachable/.test(value)) return { failure: 'network', code: 'network' };
  if (/incomplete|partial|missing_date/.test(value)) return { failure: 'incomplete-report', code: 'incomplete-report' };
  if (/invalid_response|invalid.report|parse|malformed|not_calendar/.test(value)) return { failure: 'invalid-report', code: 'invalid-report' };
  if (/config|mapping|timezone/.test(value)) return { failure: 'configuration', code: 'configuration' };
  return { failure: 'provider', code: 'provider' };
}

/**
 * What went wrong in a failed collection, in the words a site's own row uses
 * (`integrationFailureMessage` over `healthFailure`): one entry per kind, in
 * the order first met, without the closing period. A provider card's verdict
 * is these, then its counted values, joined by ` · `, never the ingest's codes.
 */
export function failureWords(codes: readonly unknown[]): string[] {
  return [...new Set(codes.map((code) => (integrationFailureMessage(healthFailure(code)) ?? 'Failed').replace(/\.$/, '')))];
}

/** `1 of 1 property`, `2 of 3 properties`: a counted value on a verdict. */
export function countOf(part: number, whole: number, one: string, many: string): string {
  return `${part} of ${whole} ${whole === 1 ? one : many}`;
}

export async function healthId(parts: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(parts));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function instant(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error('Invalid monitoring timestamp');
  return new Date(value).toISOString();
}
export type RecordedObservation = IntegrationObservation & { evidenceSource: string; evidenceId: string };
/** Where an observation's evidence is, in the collectors' words, and as the
 * store names it: by its Postgres table (`integration_health_events.evidence_source`), so
 * a provider report's run is `archive_runs`. */
const EVIDENCE: Readonly<Record<string, string>> = {
  live: 'live', calendar: 'calendar', delivery: 'delivery', probe: 'probe',
  signal_runs: 'signal_runs', signal_dump_runs: 'archive_runs', mediavine_runs: 'mediavine_runs',
};

/** The monitored target a scope names (`noticeos.capability_targets`), found
 * or made once: its number, as text. An account's target names no site. */
async function targetSeq(tx: Transaction, scope: IntegrationHealthScope): Promise<string> {
  const asset = scope.asset === '' ? null : scope.asset;
  const named = [scope.provider, scope.connection, scope.capability, scope.target, scope.family];
  const find = async () => (await tx.query<{ seq: string }>(
    `SELECT target_seq::text AS seq FROM noticeos.capability_targets
      WHERE provider = $1 AND connection_revision = $2 AND capability = $3 AND target_id = $4 AND family = $5
        AND ${asset === null ? 'asset_id IS NULL' : 'asset_id = $6'}`,
    asset === null ? named : [...named, asset],
  ))[0]?.seq;
  const found = await find();
  if (found !== undefined) return found;
  // A target another call is making at this moment: the insert waits for it,
  // and the next read sees it.
  const [made] = await tx.query<{ seq: string }>(
    `INSERT INTO noticeos.capability_targets (workspace_id, provider, connection_revision, capability, asset_id, target_id, family)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING RETURNING target_seq::text AS seq`,
    [tx.workspaceId, scope.provider, scope.connection, scope.capability, asset, scope.target, scope.family],
  );
  const seq = made?.seq ?? await find();
  if (seq === undefined) throw new Error('Monitoring target unavailable');
  return seq;
}

/** Event and current-state mutations form one transaction. An earlier-started
 * success can improve last-success evidence, but cannot clear a newer failure.
 * Report content and provider error prose are not accepted by this API.
 * Observations of one target are taken one at a time, so each reads the state
 * the one before it left. */
export async function recordIntegrationObservation(store: WorkspaceStore, input: RecordedObservation): Promise<void> {
  if (!Object.entries(INTEGRATION_MONITORS).some(([provider, items]) => provider === input.scope.provider && items.some((item) => item.id === input.scope.capability)) || !Object.hasOwn(EVIDENCE, input.evidenceSource)) throw new Error('Unknown monitoring capability');
  if (Object.values(input.scope).some((part) => typeof part !== 'string' || part.length > 1024) || input.scope.workspace !== await store.workspaceId() || !input.scope.connection || !input.attemptId || input.attemptId.length > 256 || input.evidenceId.length > 256) throw new Error('Invalid monitoring identity');
  const started = instant(input.startedAt), finished = instant(input.finishedAt);
  if (finished < started) throw new Error('Invalid monitoring attempt interval');
  const safe = input.outcome === 'failure' ? healthFailure(input.code ?? input.failure) : null;
  const eventId = await healthId([integrationScopeKey(input.scope), input.attemptId, input.outcome, safe?.code]);
  const attempt = [input.attemptId, started, finished, input.outcome, safe?.failure ?? null, safe?.code ?? null];
  const evidence = [EVIDENCE[input.evidenceSource]!, input.evidenceId];
  await store.write(async (tx) => {
    const seq = await targetSeq(tx, input.scope);
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('noticeos.capability_targets:' || $1, 0))`, [seq]);
    await tx.execute(
      `WITH incoming (target_seq, attempt_id, started_at, finished_at, outcome, failure_kind, safe_code, evidence_source, evidence_id) AS (
         VALUES ($2::bigint, $3::text, $4::timestamptz, $5::timestamptz, $6::text, $7::text, $8::text, $9::text, $10::text))
       INSERT INTO noticeos.integration_health_events
         (workspace_id, event_id, target_seq, attempt_id, started_at, recorded_at, kind, failure_kind, safe_code, evidence_source, evidence_id)
       SELECT $1::uuid, $11, incoming.target_seq, incoming.attempt_id, incoming.started_at, incoming.finished_at,
         CASE WHEN incoming.outcome = 'success' THEN 'recovered' WHEN old.outcome = 'failure' THEN 'changed' ELSE 'failed' END,
         incoming.failure_kind, incoming.safe_code, incoming.evidence_source, incoming.evidence_id
       FROM incoming LEFT JOIN noticeos.integration_capability_state old
         ON old.workspace_id = $1::uuid AND old.target_seq = incoming.target_seq
       WHERE (old.attempt_id IS NULL OR incoming.started_at > old.started_at
           OR (incoming.started_at = old.started_at AND incoming.outcome = 'failure' AND old.outcome = 'success'))
         AND ((incoming.outcome = 'failure' AND (old.outcome IS NULL OR old.outcome <> 'failure' OR old.safe_code <> incoming.safe_code))
           OR (incoming.outcome = 'success' AND old.outcome = 'failure'))
       ON CONFLICT (workspace_id, event_id) DO NOTHING`,
      [tx.workspaceId, seq, ...attempt, ...evidence, eventId],
    );
    await tx.execute(
      `INSERT INTO noticeos.integration_capability_state AS state
         (workspace_id, target_seq, attempt_id, started_at, finished_at, outcome, failure_kind, safe_code, next_attempt_at, evidence_source, evidence_id)
       VALUES ($1::uuid, $2::bigint, $3, $4::timestamptz, $5::timestamptz, $6, $7, $8, $9::timestamptz, $10, $11)
       ON CONFLICT (workspace_id, target_seq) DO UPDATE SET
         attempt_id = excluded.attempt_id, started_at = excluded.started_at, finished_at = excluded.finished_at,
         outcome = excluded.outcome, failure_kind = excluded.failure_kind, safe_code = excluded.safe_code,
         next_attempt_at = excluded.next_attempt_at, evidence_source = excluded.evidence_source, evidence_id = excluded.evidence_id
       WHERE excluded.started_at > state.started_at
          OR (excluded.started_at = state.started_at AND excluded.outcome = 'failure' AND state.outcome = 'success')`,
      [tx.workspaceId, seq, ...attempt, input.nextAttemptAt ? instant(input.nextAttemptAt) : null, ...evidence],
    );
    if (input.outcome === 'success') {
      await tx.execute(
        `UPDATE noticeos.integration_capability_state SET last_success_started_at = $3::timestamptz, last_success_finished_at = $4::timestamptz
          WHERE workspace_id = $1::uuid AND target_seq = $2::bigint
            AND (last_success_started_at IS NULL OR last_success_started_at < $3::timestamptz)`,
        [tx.workspaceId, seq, started, finished],
      );
    }
  });
}

export async function tryRecordIntegrationObservation(store: WorkspaceStore, observation: RecordedObservation): Promise<boolean> {
  try {
    await recordIntegrationObservation(store, observation);
    return true;
  } catch {
    console.warn(JSON.stringify({ event: 'integration_monitoring_unavailable', provider: observation.scope.provider, capability: observation.scope.capability }));
    return false;
  }
}

export type StoredHealthRow = {
  workspace_id: string; provider: string; connection_revision: string; capability: string; asset: string; target_id: string; family: string;
  attempt_id: string; started_at: string; finished_at: string; outcome: 'success' | 'failure'; failure_kind: IntegrationFailureKind | null;
  safe_code: HealthCode | null; next_attempt_at: string | null; last_success_started_at: string | null; last_success_finished_at: string | null;
  evidence_source: string; evidence_id: string;
};

/** A state row joined to its target, the target's columns named as a scope
 * reads them (an account's target is asset ''). `FROM` and `WHERE` are the
 * reader's; `t` is the target, `s` the state. */
export const HEALTH_STATE_SELECT = `SELECT t.workspace_id, t.provider, t.connection_revision, t.capability, COALESCE(t.asset_id, '') AS asset, t.target_id, t.family,
    s.attempt_id, s.started_at, s.finished_at, s.outcome, s.failure_kind, s.safe_code, s.next_attempt_at,
    s.last_success_started_at, s.last_success_finished_at, s.evidence_source, s.evidence_id
  FROM noticeos.capability_targets t
  JOIN noticeos.integration_capability_state s ON s.workspace_id = t.workspace_id AND s.target_seq = t.target_seq`;

/** A row `HEALTH_STATE_SELECT` read, in the scope's workspace, its instants as
 * JavaScript writes them. */
export function storedHealthRow(row: StoredHealthRow): StoredHealthRow {
  const at = (value: string | null) => (value === null ? null : javascriptInstant(value));
  return {
    ...row,
    started_at: javascriptInstant(row.started_at), finished_at: javascriptInstant(row.finished_at), next_attempt_at: at(row.next_attempt_at),
    last_success_started_at: at(row.last_success_started_at), last_success_finished_at: at(row.last_success_finished_at),
  };
}

export function observationFromRow(row: StoredHealthRow): IntegrationObservation {
  const scope: IntegrationHealthScope = { workspace: row.workspace_id, provider: row.provider, connection: row.connection_revision, capability: row.capability, asset: row.asset, target: row.target_id, family: row.family };
  return { scope, attemptId: row.attempt_id, startedAt: row.started_at, finishedAt: row.finished_at, outcome: row.outcome, failure: row.failure_kind, code: row.safe_code, nextAttemptAt: row.next_attempt_at };
}
