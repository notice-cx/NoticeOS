// NIGHTLY REPORTS AND ALERTS, WRITTEN WHERE THE TOWER READS THEM (bead
// ro-ujb9.76.5.2): a test's reports, alerts, readings, tunes and notices go
// into its Postgres copy (`ctx.call`, test/sites.ts), whose sites
// must be added first. A copy written to serves that test alone, so a file
// writes these rows in the tests that read them, never in a seed every test
// runs (the port pattern, section 7).
//
// Each writer returns the number the Tower shows (`flag_number`, a report's
// `day_number`): the store hands numbers out, so a test names a row by what
// it got back, never by a number it chose.

import { javascriptInstant, type SqlValue, type WorkspaceStore } from "@noticeos/postgres";

/** One alert, in the D1 row's terms. */
export interface AlertRow {
  asset: string;
  firedAt: string;
  severity: string;
  kind: string;
  ruleId: string;
  metric?: string | null;
  message?: string | null;
  /** JSON text, or a value written as JSON. */
  ruleInputs?: string | Record<string, unknown> | null;
  /** The report's identity (`storeReport(...).pulseId`), for an alert raised from one. */
  pulseId?: bigint | null;
  /** The revision of the same day's report that replaced this alert. */
  replacedByPulseId?: bigint | null;
  disposition?: string | null;
  dispositionAt?: string | null;
  dispositionNote?: string | null;
  snoozeUntil?: string | null;
  ackExpiry?: string | null;
  hypothesisRef?: string | null;
  incidentRef?: string | null;
  resolvedAt?: string | null;
}

function inputsText(inputs: AlertRow["ruleInputs"]): string | null {
  if (inputs === undefined || inputs === null) return null;
  return typeof inputs === "string" ? inputs : JSON.stringify(inputs);
}

/** These alerts, in this order, in one write: each one's number. */
export async function storeAlerts(store: WorkspaceStore, alerts: AlertRow[]): Promise<number[]> {
  return store.write(async (tx) => {
    const numbers: number[] = [];
    for (const alert of alerts) {
      const [row] = await tx.query<{ n: number }>(
        `INSERT INTO noticeos.flags
           (workspace_id, asset_id, pulse_id, fired_at, severity, kind, metric, message, rule_id, rule_inputs,
            disposition, disposition_at, disposition_note, snooze_until, ack_expiry, hypothesis_ref, incident_ref,
            resolved_at, replaced_by_pulse_id)
         VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8, $9, $10::jsonb,
                 $11, $12::timestamptz, $13, $14::timestamptz, $15::timestamptz, $16, $17, $18::timestamptz, $19)
         RETURNING flag_number::int AS n`,
        [
          tx.workspaceId,
          alert.asset,
          alert.pulseId ?? null,
          alert.firedAt,
          alert.severity,
          alert.kind,
          alert.metric ?? null,
          alert.message ?? null,
          alert.ruleId,
          inputsText(alert.ruleInputs),
          alert.disposition ?? null,
          alert.dispositionAt ?? null,
          alert.dispositionNote ?? null,
          alert.snoozeUntil ?? null,
          alert.ackExpiry ?? null,
          alert.hypothesisRef ?? null,
          alert.incidentRef ?? null,
          alert.resolvedAt ?? null,
          alert.replacedByPulseId ?? null,
        ],
      );
      numbers.push(row!.n);
    }
    return numbers;
  });
}

/** One alert: its number. */
export async function storeAlert(store: WorkspaceStore, alert: AlertRow): Promise<number> {
  const [number] = await storeAlerts(store, [alert]);
  return number!;
}

/** One site's report for one day, in the D1 row's terms. */
export interface ReportRow {
  asset: string;
  date: string;
  receivedAt: string;
  generatedAt?: string | null;
  capabilities?: string[] | null;
  /** The report as received: JSON text as it is, or a value written as JSON. */
  envelope: unknown;
}

/** A stored report: its identity (what an alert cites) and its day's number
 * (what the Tower shows). */
export interface StoredReport {
  pulseId: bigint;
  number: number;
}

/** These reports, in this order, in one write: a second one for a site's day
 * is that day's next revision, as a same-day retry stores it. */
export async function storeReports(store: WorkspaceStore, reports: ReportRow[]): Promise<StoredReport[]> {
  return store.write(async (tx) => {
    const stored: StoredReport[] = [];
    for (const report of reports) {
      const [row] = await tx.query<{ pulse_id: bigint; n: number }>(
        `WITH added AS (
           INSERT INTO noticeos.pulses
             (workspace_id, asset_id, pulse_date, revision, generated_at, received_at, capabilities, envelope)
           SELECT $1::uuid, $2, $3::date, coalesce(max(revision), 0) + 1, $4::timestamptz, $5::timestamptz, $6::jsonb, $7::json
             FROM noticeos.pulses WHERE asset_id = $2 AND pulse_date = $3::date
           RETURNING pulse_id, pulse_number, revision, asset_id, pulse_date)
         SELECT a.pulse_id,
                coalesce((SELECT d.pulse_number FROM noticeos.pulses d
                           WHERE d.asset_id = a.asset_id AND d.pulse_date = a.pulse_date AND d.revision = 1),
                         a.pulse_number)::int AS n
           FROM added a`,
        [
          tx.workspaceId,
          report.asset,
          report.date,
          report.generatedAt ?? null,
          report.receivedAt,
          report.capabilities === undefined || report.capabilities === null ? null : JSON.stringify(report.capabilities),
          typeof report.envelope === "string" ? report.envelope : JSON.stringify(report.envelope),
        ],
      );
      stored.push({ pulseId: row!.pulse_id, number: row!.n });
    }
    return stored;
  });
}

/** One report. */
export async function storeReport(store: WorkspaceStore, report: ReportRow): Promise<StoredReport> {
  const [stored] = await storeReports(store, [report]);
  return stored!;
}

/** A reading of the alert numbered `alert` (flag_evidence), as a refreshing
 * lane appends one while its condition stays open. */
export async function storeReading(
  store: WorkspaceStore,
  alert: number,
  reading: { observedAt: string; severity: string; message?: string | null; ruleInputs?: string | Record<string, unknown> | null },
): Promise<void> {
  await store.write((tx) =>
    tx.execute(
      `INSERT INTO noticeos.flag_evidence (workspace_id, flag_id, observed_at, severity, message, rule_inputs)
       SELECT $1::uuid, f.flag_id, $3::timestamptz, $4, $5, $6::jsonb
         FROM noticeos.flags f WHERE f.flag_number = $2`,
      [tx.workspaceId, alert, reading.observedAt, reading.severity, reading.message ?? null, inputsText(reading.ruleInputs)],
    ),
  );
}

/** A notice the notifier recorded about the alert numbered `alert`. */
export async function storeAlertNotice(
  store: WorkspaceStore,
  alert: number,
  notice: { sentAt: string; channel?: string; condition?: string },
): Promise<void> {
  await store.write((tx) =>
    tx.execute(
      `INSERT INTO noticeos.notifications (workspace_id, channel, subject, subject_ref, occurrence, condition, sent_at)
       VALUES ($1, $2, 'alert', $3, '', $4, $5::timestamptz)`,
      [tx.workspaceId, notice.channel ?? "discord", String(alert), notice.condition ?? "new-error-alert", notice.sentAt],
    ),
  );
}

/** A tune recorded against the alert numbered `alert`. */
export async function storeTune(
  store: WorkspaceStore,
  alert: number,
  tune: { ruleId: string; setting: string; valueFrom: number; valueTo: number; tunedAt: string; actor?: string },
): Promise<void> {
  await store.write((tx) =>
    tx.execute(
      `INSERT INTO noticeos.flag_tunes (workspace_id, flag_id, rule_id, setting, value_from, value_to, tuned_at, actor)
       SELECT $1::uuid, f.flag_id, $3, $4, $5, $6, $7::timestamptz, $8
         FROM noticeos.flags f WHERE f.flag_number = $2`,
      [tx.workspaceId, alert, tune.ruleId, tune.setting, tune.valueFrom, tune.valueTo, tune.tunedAt, tune.actor ?? "operator"],
    ),
  );
}

/** An alert as it reads now, in the D1 row's terms: its number as `id`,
 * instants as JavaScript writes them, inputs as JSON text. */
export interface ReadAlert {
  id: number;
  asset: string;
  fired_at: string;
  severity: string;
  kind: string;
  metric: string | null;
  message: string | null;
  rule_id: string;
  rule_inputs: string | null;
  disposition: string | null;
  disposition_at: string | null;
  disposition_note: string | null;
  snooze_until: string | null;
  ack_expiry: string | null;
  hypothesis_ref: string | null;
  incident_ref: string | null;
  resolved_at: string | null;
}

type AlertDbRow = Omit<ReadAlert, never>;

/** Every alert the Tower reads (`current_flags`) matching `where`, over its
 * own columns, lowest number first. */
export async function readAlerts(store: WorkspaceStore, where = "true", params: SqlValue[] = []): Promise<ReadAlert[]> {
  const instant = (value: string | null) => (value === null ? null : javascriptInstant(value));
  const rows = await store.read((tx) =>
    tx.query<AlertDbRow>(
      `SELECT flag_number::int AS id, asset_id AS asset, fired_at, severity, kind, metric, message, rule_id,
              rule_inputs::text AS rule_inputs, disposition, disposition_at, disposition_note, snooze_until,
              ack_expiry, hypothesis_ref, incident_ref, resolved_at
         FROM noticeos.current_flags WHERE ${where} ORDER BY flag_number`,
      params,
    ),
  );
  return rows.map((row) => ({
    ...row,
    fired_at: javascriptInstant(row.fired_at),
    disposition_at: instant(row.disposition_at),
    snooze_until: instant(row.snooze_until),
    ack_expiry: instant(row.ack_expiry),
    resolved_at: instant(row.resolved_at),
  }));
}

/** The alert numbered `id` as it reads now, or undefined. */
export async function readAlert(store: WorkspaceStore, id: number): Promise<ReadAlert | undefined> {
  const [row] = await readAlerts(store, "flag_number = $1", [id]);
  return row;
}
