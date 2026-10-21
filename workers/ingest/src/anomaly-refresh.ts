import { COUNT_FORECAST_MODEL, PulseEnvelope, REPORT_MAX_AGE_HOURS, evaluatePulse, isLegacyEnvelopeCountWarning } from '@noticeos/contract';
import type { RuleVerdict } from '@noticeos/contract';
import type { Transaction, WorkspaceStore } from '@noticeos/postgres';
import { StoredAnomalyRefreshReceipt, StoredCountWarningInputs, type StoredAnomalyRefreshPlan, type StoredAnomalyRefreshResult } from '@noticeos/contract';
import { holdCountAlerts } from './alert-store.js';
import { pulseDay, ruleConfigFromConstants, seasonalHistorySpanDays, seasonalInputsFrom, shiftDate } from './db.js';

export const REFRESH_PLAN_MS = 10 * 60_000;
const MAX_FLAGS = 200;
const MAX_METRICS = 64;
const MAX_ROW_BYTES = 65_536;
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_BYTES = 512 * 1024;
const CENTRAL = ['flow-poisson-low', 'flow-lowvol-window'];

export class RefreshRefused extends Error {
  constructor(readonly code: string) { super(code); }
}
function refuse(code: string): never { throw new RefreshRefused(code); }
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
function parsed(value: string | null): Record<string, unknown> | null {
  try { return record(JSON.parse(value ?? 'null')); } catch { return null; }
}

interface ReportRow extends Record<string, unknown> {
  id: string; date: string; generated: string; received: string; envelope: string | null;
}
interface FlagRow extends Record<string, unknown> {
  id: string; number: string; pulse: string | null; date: string | null; metric: string | null;
  rule: string; inputs: string | null; disposition: string | null; resolved: string | null;
  snooze: string | null; original: string | null;
  safe: boolean; context: string | null;
}
interface Change {
  flag: string; metric: string; reason: string;
}
interface Addition {
  metric: string; rule: string; message: string; inputs: Record<string, unknown>;
}
interface Snapshot {
  report: ReportRow;
  flags: FlagRow[];
  verdicts: RuleVerdict[];
  fingerprint: unknown;
}

/** A bounded, workspace-scoped snapshot. Apply holds the same count lock as
 * ingestion; row locks serialize operator decisions and configuration edits. */
async function snapshot(tx: Transaction, asset: string, nowMs: number, lock: boolean): Promise<Snapshot> {
  const [site] = await tx.query<{ status: string }>(
    `SELECT status FROM noticeos.assets WHERE asset_id = $1${lock ? ' FOR SHARE' : ''}`, [asset]);
  if (!site) refuse('unknown_asset');
  if (site.status === 'retired' || site.status === 'pre-launch') refuse('asset_not_active');
  const [settings] = await tx.query<{ body: string | null; version: number }>(
    `SELECT CASE WHEN octet_length(body::text) <= 65536 THEN body::text END AS body, version FROM noticeos.config_documents WHERE document_key = 'constants'${lock ? ' FOR SHARE' : ''}`);
  if (!settings) refuse('settings_not_seeded');
  if (!settings.body) refuse('input_limit');
  const config = ruleConfigFromConstants(JSON.parse(settings.body));
  if (!(config.alpha > 0 && config.alpha < 1)) refuse('invalid_settings');
  const [latest] = await tx.query<ReportRow>(
    `SELECT pulse_id::text AS id, pulse_date AS date, generated_at AS generated, received_at AS received,
            CASE WHEN octet_length(envelope::text) <= $2 THEN envelope::text END AS envelope
       FROM noticeos.current_pulses WHERE asset_id = $1 ORDER BY pulse_date DESC LIMIT 1`, [asset, MAX_ROW_BYTES]);
  if (!latest) refuse('no_report');
  if (!latest.envelope) refuse('input_limit');
  const current = PulseEnvelope.safeParse(JSON.parse(latest.envelope));
  if (!current.success || current.data.asset !== asset || pulseDay(current.data.generatedAt) !== latest.date) refuse('invalid_report');
  const generated = Date.parse(current.data.generatedAt);
  if (Date.parse(latest.generated) !== generated || !Number.isFinite(Date.parse(latest.received))) refuse('invalid_report');
  if (!Number.isFinite(generated) || generated > nowMs || Date.parse(latest.received) > nowMs) refuse('future_report');
  if (nowMs - generated > REPORT_MAX_AGE_HOURS * 3_600_000) refuse('stale_report');
  if (Object.keys(current.data.metrics).length > MAX_METRICS) refuse('input_limit');
  const rows = await tx.query<ReportRow>(
    `SELECT pulse_id::text AS id, pulse_date AS date, generated_at AS generated, received_at AS received,
            CASE WHEN octet_length(envelope::text) <= $4 THEN envelope::text END AS envelope
       FROM noticeos.current_pulses WHERE asset_id = $1 AND pulse_date >= $2::date AND pulse_date < $3::date
       ORDER BY pulse_date`, [asset, shiftDate(latest.date, -seasonalHistorySpanDays(config)), latest.date, MAX_ROW_BYTES]);
  if (rows.some((row) => row.envelope === null) || rows.reduce((n, row) => n + size(row.envelope), size(latest.envelope)) > MAX_INPUT_BYTES) refuse('input_limit');
  const history = new Map<string, PulseEnvelope>();
  for (const row of rows) {
    const result = PulseEnvelope.safeParse(JSON.parse(row.envelope!));
    if (result.success && result.data.asset === asset && pulseDay(result.data.generatedAt) === row.date
      && Date.parse(result.data.generatedAt) < generated) history.set(row.date, result.data);
  }
  // Acquire row locks before the evidence read: a joined SELECT's snapshot
  // predates waits and can otherwise omit evidence committed while it waits.
  {
    const locked = await tx.query<{ id: string }>(`SELECT f.flag_id::text AS id FROM noticeos.flags f
      LEFT JOIN noticeos.pulses p ON p.workspace_id=f.workspace_id AND p.pulse_id=f.pulse_id
      WHERE f.asset_id=$1 AND f.kind='anomaly' AND f.rule_id IN ('flow-poisson-low','flow-lowvol-window','asset-declared')
        AND f.replaced_by_pulse_id IS NULL AND (f.resolved_at IS NULL OR p.pulse_date=$2::date)
      ORDER BY f.flag_id LIMIT 201${lock ? ' FOR UPDATE OF f' : ''}`, [asset, latest.date]);
    if (locked.length > MAX_FLAGS) refuse('input_limit');
  }
  const flags = await tx.query<FlagRow>(
    `SELECT f.flag_id::text AS id, f.flag_number::text AS number, f.pulse_id::text AS pulse,
            p.pulse_date AS date, CASE WHEN octet_length(f.metric) <= $3 THEN f.metric END AS metric, f.rule_id AS rule,
            CASE WHEN octet_length((CASE WHEN e.observed_at IS NULL THEN f.rule_inputs ELSE e.rule_inputs END)::text) <= $3
              THEN (CASE WHEN e.observed_at IS NULL THEN f.rule_inputs ELSE e.rule_inputs END)::text END AS inputs,
            f.disposition, f.resolved_at AS resolved, f.snooze_until AS snooze,
            (coalesce(octet_length(f.metric),0) <= $3 AND coalesce(octet_length(f.rule_inputs::text),0) <= $3 AND coalesce(octet_length(e.rule_inputs::text),0) <= $3
              AND coalesce(octet_length(f.disposition_note),0) <= $3
              AND (f.rule_id <> 'asset-declared' OR coalesce(octet_length(p.envelope::text),0) <= $3)) AS safe,
            CASE WHEN coalesce(octet_length(f.rule_inputs::text),0)+coalesce(octet_length(e.rule_inputs::text),0)
              +coalesce(octet_length(f.message),0)+coalesce(octet_length(e.message),0)+coalesce(octet_length(f.disposition_note),0)
              +coalesce(octet_length(f.hypothesis_ref),0)+coalesce(octet_length(f.incident_ref),0) <= $3
              THEN jsonb_build_array(f.rule_inputs,f.message,f.disposition_at,f.ack_expiry,f.hypothesis_ref,f.incident_ref,
                f.disposition_note,e.observed_at,e.severity,e.rule_inputs,e.message)::text END AS context,
            CASE WHEN f.rule_id = 'asset-declared' AND octet_length(p.envelope::text) <= $3 THEN p.envelope::text END AS original
       FROM noticeos.flags f LEFT JOIN noticeos.pulses p ON p.workspace_id = f.workspace_id AND p.pulse_id = f.pulse_id
       LEFT JOIN LATERAL (SELECT observed_at, severity, rule_inputs, message FROM noticeos.flag_evidence
         WHERE workspace_id = f.workspace_id AND flag_id = f.flag_id ORDER BY observed_at DESC LIMIT 1) e ON true
      WHERE f.asset_id = $1 AND f.kind = 'anomaly' AND coalesce(e.severity,f.severity) = 'warn'
        AND f.rule_id IN ('flow-poisson-low','flow-lowvol-window','asset-declared')
        AND f.replaced_by_pulse_id IS NULL AND (f.resolved_at IS NULL OR p.pulse_date = $2::date)
      ORDER BY f.flag_id LIMIT 201`, [asset, latest.date, MAX_ROW_BYTES]);
  if (flags.length > MAX_FLAGS || flags.some((f) => !f.safe || f.context === null)
    || size(JSON.stringify(flags)) > MAX_INPUT_BYTES) refuse('input_limit');
  const verdicts = evaluatePulse(current.data, { config, ...seasonalInputsFrom(history, current.data, config), requireHistoricalBaseline: true });
  return { report: latest, flags, verdicts, fingerprint: { workspace: tx.workspaceId, asset, model: COUNT_FORECAST_MODEL,
    status: site.status, settings, latest, rows, flags } };
}

function recognized(flag: FlagRow): boolean {
  const inputs = parsed(flag.inputs);
  if (CENTRAL.includes(flag.rule)) {
    // Unknown future models stay intact during a rollback or mixed rollout.
    const base: unknown = JSON.parse(flag.context!)[0];
    return StoredCountWarningInputs.safeParse(base).success && StoredCountWarningInputs.safeParse(inputs).success
      && record(base)?.metric === flag.metric && inputs?.metric === flag.metric;
  }
  if (!flag.original || inputs?.source !== 'envelope' || inputs.metric !== flag.metric) return false;
  const original = PulseEnvelope.safeParse(JSON.parse(flag.original));
  return original.success && isLegacyEnvelopeCountWarning(inputs, original.data);
}

function changes(snapshot: Snapshot, nowMs: number) {
  const retire: Change[] = [], preserve: Change[] = [], create: Addition[] = [];
  const byMetric = new Map(snapshot.verdicts.map((v) => [String(v.inputs.metric), v]));
  const eligible = snapshot.flags.filter(recognized);
  for (const flag of snapshot.flags) {
    const metric = flag.metric ?? '';
    const decision = byMetric.get(metric);
    let reason: string;
    if (!eligible.includes(flag)) reason = 'independent-or-unknown-warning';
    else if (flag.resolved !== null || flag.disposition !== null
      && !(flag.disposition === 'snooze' && flag.snooze !== null && Date.parse(flag.snooze) <= nowMs)) reason = 'operator-or-settled-history';
    else if (!decision) reason = 'metric-not-reported';
    else if (decision.outcome === 'fired' && flag.pulse === snapshot.report.id && flag.rule === decision.ruleId
      && [canonical(decision.inputs), canonical(refreshInputs(decision.inputs, snapshot.report))].includes(canonical(parsed(flag.inputs)))) reason = 'already-current';
    else {
      retire.push({ flag: flag.number, metric, reason: decision.outcome === 'not-applicable' ? 'superseded-insufficient-evidence' : 'superseded-count-evaluation' });
      continue;
    }
    preserve.push({ flag: flag.number, metric, reason });
  }
  for (const decision of snapshot.verdicts.filter((v) => v.outcome === 'fired')) {
    const metric = decision.flag!.metric;
    const kept = eligible.filter((f) => f.metric === metric && !retire.some((r) => r.flag === f.number));
    const suppressed = kept.some((f) => f.date === snapshot.report.date
      || f.resolved === null && f.disposition === 'snooze' && f.snooze !== null && Date.parse(f.snooze) > nowMs);
    if (!suppressed) create.push({ metric, rule: decision.ruleId, message: decision.flag!.message, inputs: refreshInputs(decision.inputs, snapshot.report) });
  }
  return { retire, preserve, create };
}

function refreshInputs(inputs: Record<string, unknown>, report: ReportRow) {
  return { ...inputs, storedReportRefresh: { source: 'stored-report', model: COUNT_FORECAST_MODEL,
    reportId: report.id, reportGeneratedAt: report.generated } };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = record(value);
  return object ? `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}` : JSON.stringify(value);
}
const size = (value: string | null) => value === null ? 0 : new TextEncoder().encode(value).byteLength;
async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(bytes)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** Preview never writes. Apply re-reads all inputs and reconciles only the
 * latest report; it never ingests a report or confirms report freshness. */
export async function refreshAnomalies(store: WorkspaceStore, asset: string, apply?: string, now?: number): Promise<StoredAnomalyRefreshResult> {
  const clock = () => now ?? Date.now();
  const work = async (tx: Transaction): Promise<StoredAnomalyRefreshResult> => {
    await tx.query("SELECT set_config('statement_timeout', '5s', true), set_config('lock_timeout', '5s', true)");
    let nowMs = clock();
    let prepared = nowMs;
    const job = `count-alert-refresh:${asset}`;
    if (apply !== undefined) {
      if (!/^\d{13}\.[a-f0-9]{64}$/.test(apply)) refuse('invalid_plan');
      prepared = Number(apply.split('.')[0]);
      if (prepared > nowMs) refuse('invalid_plan');
      await holdCountAlerts(tx, asset);
      const [receipt] = await tx.query<{ detail: string | null }>(
        `SELECT CASE WHEN octet_length(detail) <= 1048576 THEN detail END AS detail FROM noticeos.job_runs WHERE job = $1 AND started_at = $2::timestamptz`, [job, new Date(prepared).toISOString()]);
      if (receipt) {
        const result = StoredAnomalyRefreshReceipt.safeParse(parsed(receipt.detail));
        if (!result.success || result.data.applyToken !== apply || result.data.asset !== asset
          || result.data.mode !== 'applied' || result.data.model !== COUNT_FORECAST_MODEL
          || result.data.preparedAt !== new Date(prepared).toISOString()) refuse('invalid_plan');
        return { ...result.data, replayed: true };
      }
      if (nowMs - prepared > REFRESH_PLAN_MS) refuse('expired_plan');
    }
    const input = await snapshot(tx, asset, clock(), apply !== undefined);
    nowMs = clock();
    if (nowMs - Date.parse(input.report.generated) > REPORT_MAX_AGE_HOURS * 3_600_000) refuse('stale_report');
    if (apply !== undefined && nowMs - prepared > REFRESH_PLAN_MS) refuse('expired_plan');
    // Time-dependent decisions use the preview instant; apply also checks
    // that no snooze crossed its boundary while the preview was reviewed.
    const planned = changes(input, prepared);
    if (canonical(planned) !== canonical(changes(input, nowMs))) refuse('stale_plan');
    const hash = await digest({ prepared, snapshot: input.fingerprint, planned });
    const token = `${prepared}.${hash}`;
    if (apply !== undefined && apply !== token) refuse('stale_plan');
    const plan: StoredAnomalyRefreshPlan = { asset, model: COUNT_FORECAST_MODEL, reportDate: input.report.date,
      reportGeneratedAt: input.report.generated, preparedAt: new Date(prepared).toISOString(), expiresAt: new Date(prepared + REFRESH_PLAN_MS).toISOString(),
      applyToken: token, retire: planned.retire, preserve: planned.preserve,
      create: planned.create.map(({ message: _message, ...addition }) => addition),
      evaluations: input.verdicts.map((v) => ({ metric: String(v.inputs.metric), outcome: v.outcome,
        reason: typeof v.inputs.reason === 'string' ? v.inputs.reason : null,
        windowHours: typeof v.inputs.windowHours === 'number' ? v.inputs.windowHours : null })) };
    const at = new Date(nowMs).toISOString();
    const receipt: StoredAnomalyRefreshResult = { mode: 'applied', ...plan, appliedAt: at, replayed: false };
    if (size(JSON.stringify(receipt)) > MAX_RESULT_BYTES) refuse('output_limit');
    // Use Postgres's JSON text size, including its whitespace, so every new
    // flag remains readable under the same bound on the next refresh.
    const [additions] = await tx.query<{ safe: boolean }>(`SELECT coalesce(bool_and(
      octet_length((value->'inputs')::text)+octet_length(value->>'message') <= $2),true) AS safe
      FROM jsonb_array_elements($1::jsonb)`, [JSON.stringify(planned.create), MAX_ROW_BYTES]);
    if (!additions?.safe) refuse('output_limit');
    if (apply === undefined) return { mode: 'preview', replayed: false, ...plan };
    if (planned.retire.length) await tx.execute(
      `UPDATE noticeos.flags SET resolved_at = $1::timestamptz
        WHERE asset_id = $2 AND flag_number = ANY($3::bigint[]) AND resolved_at IS NULL
          AND (disposition IS NULL OR disposition='snooze' AND snooze_until <= $1::timestamptz) AND replaced_by_pulse_id IS NULL`,
      [at, asset, planned.retire.map((change) => change.flag)]);
    for (const addition of planned.create) await tx.execute(
      `INSERT INTO noticeos.flags (workspace_id, asset_id, pulse_id, fired_at, severity, kind, metric, message, rule_id, rule_inputs)
       VALUES ($1::uuid,$2,$3::bigint,$4::timestamptz,'warn','anomaly',$5,$6,$7,$8::jsonb)`,
      [tx.workspaceId, asset, input.report.id, input.report.generated, addition.metric, addition.message, addition.rule, JSON.stringify(addition.inputs)]);
    await tx.execute(
      `INSERT INTO noticeos.job_runs (workspace_id,job,started_at,finished_at,outcome,detail,recorded_at)
       VALUES ($1::uuid,$2,$3::timestamptz,$4::timestamptz,'ran',$5,$4::timestamptz)`,
      [tx.workspaceId, job, plan.preparedAt, at, JSON.stringify(receipt)]);
    return receipt;
  };
  return apply === undefined ? store.read(work) : store.write(work);
}
