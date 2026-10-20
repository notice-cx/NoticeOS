// Codebase report ingest: validate one envelope, append it as that site and
// day's next revision, then run the five codebase rules against the site's
// stored reports and write their alerts, all in one transaction.

import {
  CODEBASE_COMPARISON_MAX_DAYS,
  CODEBASE_COMPARISON_MIN_DAYS,
  CODEBASE_MEASURE_KEYS,
  CodebaseReport,
  codebaseRuleThresholds,
  evaluateCodebaseRules,
  pickComparisonReport,
  type CodebaseMeasures,
  type CodebaseRuleReport,
  type CodebaseRuleThresholds,
} from '@noticeos/contract';
import type { Transaction } from '@noticeos/postgres';
import constants from '../../../config/constants.json';
import { holdCondition } from './alert-store.js';
import { readCollectorConfigs } from './config-store.js';
import { shiftUtcDay, utcDay } from './shared.js';

/** What `POST /api/codebase-report` answers with on 201. */
export interface CodebaseReportWritten {
  /** The day's report number: its first revision's. */
  reportNumber: number;
  reportDate: string;
  revision: number;
}

export interface WriteCodebaseResult extends CodebaseReportWritten {
  raised: string[];
  resolved: number;
}

type CodebaseParseError = Extract<ReturnType<typeof CodebaseReport.safeParse>, { success: false }>['error'];

export type CodebaseIngestOutcome =
  | { ok: true; result: WriteCodebaseResult }
  | { ok: false; error: CodebaseParseError };

/**
 * The thresholds this write runs on: the stored constants document's
 * `codebase_rules` per key, then the compiled copy's, then the contract's.
 */
export async function codebaseThresholdsFor(env: Pick<IngestEnv, 'STORE'>): Promise<CodebaseRuleThresholds> {
  const { documents } = await readCollectorConfigs(env, ['config/constants.json']);
  return codebaseRuleThresholds(documents['config/constants.json'], codebaseRuleThresholds(constants));
}

export async function ingestCodebaseReport(
  env: Pick<IngestEnv, 'STORE'>,
  body: unknown,
  thresholds?: CodebaseRuleThresholds,
): Promise<CodebaseIngestOutcome> {
  const parsed = CodebaseReport.safeParse(body);
  if (!parsed.success) return { ok: false, error: parsed.error };
  const result = await writeCodebaseReport(env, parsed.data, thresholds ?? (await codebaseThresholdsFor(env)));
  return { ok: true, result };
}

/** A stored envelope's measures, keeping only numbers under known keys. */
function storedMeasures(envelope: string): CodebaseMeasures | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelope);
  } catch {
    return null;
  }
  const measures = (parsed as { measures?: unknown } | null)?.measures;
  if (typeof measures !== 'object' || measures === null) return null;
  const out: CodebaseMeasures = {};
  for (const key of CODEBASE_MEASURE_KEYS) {
    const value = (measures as Record<string, unknown>)[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/** The site's stored report the 30-day rules compare with, or null. */
async function comparisonReport(tx: Transaction, asset: string, reportDate: string): Promise<CodebaseRuleReport | null> {
  const rows = await tx.query<{ report_number: number; report_date: string; revision: number; commit: string; envelope: string }>(
    `SELECT day_number::int AS report_number, report_date::text AS report_date, revision, commit, envelope::text AS envelope
       FROM noticeos.current_codebase_reports
      WHERE asset_id = $1 AND report_date BETWEEN $2::date AND $3::date`,
    [asset, shiftUtcDay(reportDate, -CODEBASE_COMPARISON_MAX_DAYS), shiftUtcDay(reportDate, -CODEBASE_COMPARISON_MIN_DAYS)],
  );
  const readable = rows.flatMap((row) => {
    const measures = storedMeasures(row.envelope);
    return measures === null
      ? []
      : [{ reportNumber: row.report_number, reportDate: row.report_date, revision: row.revision, commit: row.commit, measures }];
  });
  return pickComparisonReport(reportDate, readable);
}

/**
 * Append the report and run the rules. Each rule the report can evaluate
 * first resolves that rule's open alert for the site, then raises a new one if
 * it fires. A rule it cannot evaluate (a measure absent, no comparison report)
 * leaves the site's alerts as they are. Resolution leaves an alert the
 * operator acknowledged or annotated alone; a snoozed alert is resolved only
 * when its rule no longer fires, and while its snooze runs the rule raises no
 * new one.
 */
export async function writeCodebaseReport(
  env: Pick<IngestEnv, 'STORE'>,
  report: CodebaseReport,
  thresholds: CodebaseRuleThresholds,
): Promise<WriteCodebaseResult> {
  const receivedAt = new Date().toISOString();
  const reportDate = utcDay(report.generatedAt);

  return env.STORE.write(async (tx) => {
    await holdCondition(tx, report.asset, `codebase-report:${reportDate}`);
    const [written] = await tx.query<{ revision: number; day_number: number }>(
      `WITH revision AS (
         SELECT coalesce(max(revision), 0) + 1 AS next FROM noticeos.codebase_reports
          WHERE asset_id = $2 AND report_date = $3::date
       ), written AS (
         INSERT INTO noticeos.codebase_reports
           (workspace_id, asset_id, report_date, revision, commit, ref, generated_at, received_at, envelope)
         SELECT $1::uuid, $2, $3::date, next, $4, $5, $6::timestamptz, $7::timestamptz, $8::json FROM revision
         RETURNING report_number, revision
       )
       SELECT w.revision,
              (CASE WHEN w.revision = 1 THEN w.report_number
                    ELSE (SELECT d.report_number FROM noticeos.codebase_reports d
                           WHERE d.asset_id = $2 AND d.report_date = $3::date AND d.revision = 1) END)::int AS day_number
         FROM written w`,
      [
        tx.workspaceId,
        report.asset,
        reportDate,
        report.repository.commit,
        report.repository.ref,
        report.generatedAt,
        receivedAt,
        JSON.stringify(report),
      ],
    );
    if (!written) throw new Error('codebase report insert returned no row');

    const current: CodebaseRuleReport = {
      reportNumber: written.day_number,
      reportDate,
      revision: written.revision,
      commit: report.repository.commit,
      measures: report.measures,
    };
    const comparison = await comparisonReport(tx, report.asset, reportDate);
    const raised: string[] = [];
    let resolved = 0;
    for (const verdict of evaluateCodebaseRules(current, comparison, thresholds)) {
      if (!verdict.evaluable) continue;
      await holdCondition(tx, report.asset, verdict.ruleId);
      resolved += await tx.execute(
        `UPDATE noticeos.flags SET resolved_at = $1::timestamptz
          WHERE asset_id = $2 AND rule_id = $3
            AND resolved_at IS NULL AND replaced_by_pulse_id IS NULL
            AND (disposition IS NULL OR ($4::boolean = false AND disposition = 'snooze'))`,
        [receivedAt, report.asset, verdict.ruleId, verdict.fired],
      );
      if (!verdict.fired) continue;
      const inserted = await tx.execute(
        `INSERT INTO noticeos.flags
           (workspace_id, asset_id, fired_at, severity, kind, metric, message, rule_id, rule_inputs)
         SELECT $1::uuid, $2, $3::timestamptz, $4, $5, $6, $7, $8, $9::jsonb
          WHERE NOT EXISTS (
            SELECT 1 FROM noticeos.flags
             WHERE asset_id = $2 AND rule_id = $8
               AND resolved_at IS NULL AND replaced_by_pulse_id IS NULL
               AND disposition = 'snooze' AND snooze_until > $3::timestamptz)`,
        [
          tx.workspaceId,
          report.asset,
          receivedAt,
          verdict.severity,
          verdict.kind,
          verdict.metric,
          verdict.message,
          verdict.ruleId,
          JSON.stringify(verdict.inputs),
        ],
      );
      if (inserted > 0) raised.push(verdict.ruleId);
    }
    return { reportNumber: written.day_number, reportDate, revision: written.revision, raised, resolved };
  });
}
