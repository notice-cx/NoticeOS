import { SELF, env } from 'cloudflare:test';
import { storedProviderCost } from '@noticeos/contract';
import { mediavineCoverage } from '@noticeos/contract/ledger-coverage';
import { javascriptInstant, type SqlValue } from '@noticeos/postgres';
import { configDocumentKey } from '../../../scripts/config-documents.mjs';
import { EGRESS_BEACONS, EGRESS_DOWN_RULE_ID } from '../src/egress.js';
import { HEALTH_STATE_SELECT, storedHealthRow, type StoredHealthRow } from '../src/integration-health-store.js';
import { clearRawSignals } from './clear-raw-signals';
import { noteReached } from './store-fence';

/** Drive the Worker end-to-end (through its router) against the test Postgres store. */
export async function call(request: Request): Promise<Response> {
  return SELF.fetch(request);
}

/**
 * Clear the mutable tables between tests (the seeded `assets` rows stay). This
 * pool version has no per-test storage isolation, so each test resets its own
 * slate: the raw reports in R2, the stored credentials, and the Postgres
 * tables below. No D1 table holds a test's rows any more.
 */
export async function reset(): Promise<void> {
  await clearRawSignals(env.RAW_SIGNALS);
  await forgetCredentials();
  await emptyTablesHoldingRows(EMPTIED_BEFORE_EACH_TEST);
}

/**
 * The Postgres tables `reset()` empties: the rows a test writes there, which
 * the application role may not remove (the owner does, `emptyTables`).
 */
const EMPTIED_BEFORE_EACH_TEST = [
  'workspace_mutation_audit',
  'counter_readings',
  'egress_checks',
  'integration_health_events',
  'integration_capability_state',
  'capability_targets',
  'ledger_entries',
  'mediavine_daily',
  'mediavine_runs',
  'mediavine_sites',
  'mediavine_state',
  'integration_leases',
  'hygiene_checks',
  'reclamation_targets',
  'pulses',
  'flags',
  'flag_evidence',
  'flag_tunes',
  'notifications',
  'alert_daily_counts',
  'job_runs',
  'task_snapshots',
  'task_daily_counts',
  'signal_observations',
  'signal_runs',
  'measurement_series',
  'annotations',
  'watch_windows',
  'watch_window_readings',
  'archive_runs',
  'archive_objects',
  'research_log',
  'asset_insight_snapshots',
];

/** Empty these tables, as the owner, once any of them holds a row. One read
 * asks, so a test that wrote none costs no owner statement: each is a
 * connection of its own on the cluster's private socket, from Vitest's own
 * process (vitest.config.ts, scripts/postgres-test-cluster.mts). They are emptied together, in
 * one statement, because Postgres truncates a table only with every table
 * whose foreign key references it (a Mediavine run with its daily facts),
 * even an empty one. */
export async function emptyTablesHoldingRows(tables: readonly string[]): Promise<void> {
  for (const table of tables) if (!/^[a-z][a-z0-9_]*$/u.test(table)) throw new TypeError(`not a table name: ${table}`);
  if (tables.length === 0) return;
  const [found] = await env.STORE.read((tx) =>
    tx.query<{ holding: boolean }>(
      `SELECT ${tables.map((table) => `EXISTS (SELECT 1 FROM noticeos.${table})`).join(' OR ')} AS holding`,
    ),
  );
  if (found?.holding) await emptyTables([...tables]);
}

/** Each monitored target's stored latest attempt (on Postgres, bead
 * ro-ujb9.76.5.6), as the health read gets it, in the order the targets were
 * named. */
export async function storedHealthStates(): Promise<StoredHealthRow[]> {
  const rows = await env.STORE.read((tx) => tx.query<StoredHealthRow>(`${HEALTH_STATE_SELECT} ORDER BY t.target_seq`));
  return rows.map(storedHealthRow);
}

/** A stored health transition, with the target it is about. */
export type StoredHealthEvent = {
  event_id: string; provider: string; capability: string; asset: string; kind: 'failed' | 'changed' | 'recovered';
  failure_kind: string | null; safe_code: string | null; started_at: string; recorded_at: string; evidence_source: string; evidence_id: string;
};

/** Every stored health transition, the earliest-started first. */
export async function storedHealthEvents(): Promise<StoredHealthEvent[]> {
  const rows = await env.STORE.read((tx) =>
    tx.query<StoredHealthEvent>(
      `SELECT e.event_id, t.provider, t.capability, COALESCE(t.asset_id, '') AS asset, e.kind, e.failure_kind, e.safe_code,
              e.started_at, e.recorded_at, e.evidence_source, e.evidence_id
         FROM noticeos.integration_health_events e
         JOIN noticeos.capability_targets t ON t.workspace_id = e.workspace_id AND t.target_seq = e.target_seq
        ORDER BY e.started_at, e.recorded_at, e.event_id COLLATE "C"`,
    ),
  );
  return rows.map((row) => ({ ...row, started_at: javascriptInstant(row.started_at), recorded_at: javascriptInstant(row.recorded_at) }));
}

/** Make the store refuse every health state it is handed, as the owner, until
 * the returned undo runs: a monitoring store that fails. */
export async function refuseHealthStates(): Promise<() => Promise<void>> {
  await asOwner(`CREATE FUNCTION noticeos.refuse_health_state() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture rejection'; END $$;
CREATE TRIGGER refuse_health_state BEFORE INSERT ON noticeos.integration_capability_state FOR EACH ROW EXECUTE FUNCTION noticeos.refuse_health_state();`);
  return () => asOwner(`DROP TRIGGER refuse_health_state ON noticeos.integration_capability_state;
DROP FUNCTION noticeos.refuse_health_state();`);
}

/** Make the store refuse the report runs it is handed — every one, or only
 * the stored ones (`success`, `unchanged`) — with `message`, as the owner,
 * until the returned undo runs: a store that fails while keeping a report. */
export async function refuseArchiveRuns(
  { stored = false, message = 'the store refused the write' }: { stored?: boolean; message?: string } = {},
): Promise<() => Promise<void>> {
  if (/'/.test(message)) throw new TypeError('refuseArchiveRuns: a message without quotes');
  await asOwner(`CREATE FUNCTION noticeos.refuse_archive_run() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '${message}'; END $$;
CREATE TRIGGER refuse_archive_run BEFORE INSERT ON noticeos.archive_runs FOR EACH ROW${stored ? " WHEN (NEW.status <> 'error')" : ''} EXECUTE FUNCTION noticeos.refuse_archive_run();`);
  return () => asOwner(`DROP TRIGGER refuse_archive_run ON noticeos.archive_runs;
DROP FUNCTION noticeos.refuse_archive_run();`);
}

/** One count read from the store: `sql` selects `n`, cast to int. */
export async function storedCount(sql: string, params: readonly SqlValue[] = []): Promise<number> {
  const [row] = await env.STORE.read((tx) => tx.query<{ n: number }>(sql, params));
  return row?.n ?? 0;
}

/** A ledger entry booked by hand — by an import, a restore, a fixture — in
 * the ledger's own terms: a 'YYYY-MM' month, integer cents. */
export interface HandEntry {
  /** The identity to book it under (OVERRIDING SYSTEM VALUE), as a D1 test
   * named an id; left out, the store hands out the next. */
  entryId?: number;
  kind: 'revenue' | 'cost';
  asset: string;
  period: string;
  family: string;
  amountMinor: number;
  bookingState: 'estimated' | 'reconciled';
  currency?: string;
  source?: string | null;
  supersedesId?: bigint | number | null;
  note?: string | null;
  externalId?: string | null;
  recordedAt?: string;
}

/** Book one entry through the application role, its coverage read from its
 * note by the one rule the importer and the ledger route apply
 * (@noticeos/contract/ledger-coverage). Its identity (what a correction links
 * to) and its number. */
export async function bookEntry(entry: HandEntry): Promise<{ entryId: bigint; number: number }> {
  const identity = entry.entryId !== undefined;
  const [row] = await env.STORE.write((tx) =>
    tx.query<{ entry_id: bigint; entry_number: bigint }>(
      `INSERT INTO noticeos.ledger_entries
         (workspace_id, kind, asset_id, period_month, family, amount_minor, currency, source, booking_state,
          supersedes_id, note, external_id, recorded_at, coverage_end${identity ? ', entry_id' : ''})
       ${identity ? 'OVERRIDING SYSTEM VALUE' : ''}
       VALUES ($1::uuid, $2, $3, $4::date, $5, $6, $7, $8, $9, $10, $11, $12, COALESCE($13::timestamptz, now()),
               $14::date${identity ? ', $15' : ''})
       RETURNING entry_id, entry_number`,
      [
        tx.workspaceId,
        entry.kind,
        entry.asset,
        `${entry.period}-01`,
        entry.family,
        entry.amountMinor,
        entry.currency ?? 'USD',
        entry.source ?? null,
        entry.bookingState,
        entry.supersedesId ?? null,
        entry.note ?? null,
        entry.externalId ?? null,
        entry.recordedAt ?? null,
        mediavineCoverage(
          { kind: entry.kind, family: entry.family, source: entry.source ?? null, note: entry.note ?? null },
          entry.period,
        ).end,
        ...(identity ? [entry.entryId!] : []),
      ],
    ),
  );
  return { entryId: row!.entry_id, number: Number(row!.entry_number) };
}

/** Revenue in cents over the one financial read every page makes
 * (`noticeos.financial_ledger`), for one site or all. */
export async function effectiveRevenueMinor(asset?: string): Promise<number> {
  const [row] = await env.STORE.read((tx) =>
    tx.query<{ n: bigint }>(
      `SELECT COALESCE(SUM(amount_minor), 0)::bigint AS n FROM noticeos.financial_ledger
        WHERE kind = 'revenue' AND ($1::text IS NULL OR asset_id = $1)`,
      [asset ?? null],
    ),
  );
  return Number(row?.n ?? 0n);
}

/** Forget these providers' stored credentials (all, when none are named):
 * each connection, and with it every secret it held, as a disconnect does. */
export async function forgetCredentials(providers?: string[]): Promise<void> {
  await env.STORE.write((tx) =>
    tx.execute('DELETE FROM noticeos.integration_connections WHERE $1::text[] IS NULL OR provider = ANY($1::text[])', [
      providers ?? null,
    ]),
  );
}

/** One provider's stored credential as the store keeps it: its connection and
 * that connection's current secret version, instants as JavaScript writes
 * them. Null when nothing is stored. */
export interface StoredCredentialRow {
  provider: string;
  scope: string;
  secret_version: number;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  key_version: number;
  field_names: string[];
  asset_ids: string[];
  account: string | null;
  scopes: string[];
  expires_at: string | null;
  expiry_source: string | null;
  /** numeric(14,6) as the store prints it: six decimals, never a float. */
  balance_usd: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
}

export async function storedCredential(provider: string): Promise<StoredCredentialRow | null> {
  type Stored = Omit<StoredCredentialRow, 'field_names' | 'asset_ids' | 'scopes'> & {
    field_names: string;
    asset_ids: string;
    scopes: string;
  };
  const [row] = await env.STORE.read((tx) =>
    tx.query<Stored>(
      `SELECT c.provider, c.scope, s.secret_version, s.ciphertext, s.iv, s.key_version, s.field_names, s.asset_ids,
              c.account, c.scopes, c.expires_at, c.expiry_source, c.balance_usd,
              c.created_at, c.updated_at, c.last_used_at, c.last_ok_at, c.last_error
         FROM noticeos.integration_connections c
         JOIN noticeos.connection_secrets s ON s.workspace_id = c.workspace_id AND s.connection_id = c.connection_id
        WHERE c.provider = $1
        ORDER BY s.secret_version DESC
        LIMIT 1`,
      [provider],
    ),
  );
  if (row === undefined) return null;
  const instant = (value: string | null) => (value === null ? null : javascriptInstant(value));
  return {
    ...row,
    field_names: JSON.parse(row.field_names) as string[],
    asset_ids: JSON.parse(row.asset_ids) as string[],
    scopes: JSON.parse(row.scopes) as string[],
    expires_at: instant(row.expires_at),
    created_at: javascriptInstant(row.created_at),
    updated_at: javascriptInstant(row.updated_at),
    last_used_at: instant(row.last_used_at),
    last_ok_at: instant(row.last_ok_at),
  };
}

/** A stored connection's last verdict, as its card reads it; null when
 * nothing is stored. */
export async function credentialVerdict(
  provider: string,
): Promise<{ lastOkAt: string | null; lastError: string | null } | null> {
  const stored = await storedCredential(provider);
  return stored === null ? null : { lastOkAt: stored.last_ok_at, lastError: stored.last_error };
}

/** How many secret versions the store holds, across every connection. */
export async function storedSecretCount(): Promise<number> {
  const [row] = await env.STORE.read((tx) =>
    tx.query<{ n: number }>('SELECT count(*)::int AS n FROM noticeos.connection_secrets'),
  );
  return row?.n ?? 0;
}

/** Set a stored connection's times and verdict by hand, as the application
 * may: a test that needs one connected long ago, or failing since an hour. */
export async function setConnection(
  provider: string,
  columns: { updated_at?: string; last_used_at?: string | null; last_ok_at?: string | null; last_error?: string | null },
): Promise<void> {
  const names = Object.keys(columns) as (keyof typeof columns)[];
  for (const name of names) if (!/^[a-z_]+$/u.test(name)) throw new TypeError(`not a column: ${name}`);
  const changed = await env.STORE.write((tx) =>
    tx.execute(
      `UPDATE noticeos.integration_connections
          SET ${names.map((name, index) => `${name} = $${index + 2}${name === 'last_error' ? '' : '::timestamptz'}`).join(', ')}
        WHERE provider = $1`,
      [provider, ...names.map((name) => columns[name] ?? null)],
    ),
  );
  if (changed !== 1) throw new Error(`${provider} has no stored connection to set`);
}

/**
 * Run `sql` as the owner of this runtime's Postgres copy (or, with `other`,
 * its second copy; vitest.config.ts): the Postgres counterpart of a D1 test
 * running any statement on its store, for rows the application role may never
 * change or remove — settings and their changes are kept for good in the
 * product.
 */
export async function asOwner(sql: string, { other = false }: { other?: boolean } = {}): Promise<void> {
  noteReached(other ? 'env.POSTGRES_OTHER' : 'env.POSTGRES');
  const ran = await env.TEST_POSTGRES.fetch('http://test-postgres/owner', { method: 'POST', body: JSON.stringify({ sql, other }) });
  if (!ran.ok) throw new Error(`the owner could not run ${sql}: ${ran.status} ${await ran.text()}`);
}

/** Empty these tables of the noticeos schema, as the owner. */
export async function emptyTables(tables: string[], { other = false }: { other?: boolean } = {}): Promise<void> {
  for (const table of tables) if (!/^[a-z][a-z0-9_]*$/u.test(table)) throw new TypeError(`not a table name: ${table}`);
  await asOwner(`TRUNCATE ${tables.map((table) => `noticeos.${table}`).join(', ')};`, { other });
}

/** Remove these settings documents and their changes, as the owner: a store
 * that holds none of them, so each reads from the copy compiled in. */
export async function forgetConfigDocuments(files: string[], { other = false }: { other?: boolean } = {}): Promise<void> {
  const keys = files.map((file) => {
    const key = configDocumentKey(file);
    if (key === null) throw new TypeError(`not a config document: ${file}`);
    return `'${key}'`;
  });
  await asOwner(
    `DELETE FROM noticeos.config_changes WHERE document_key IN (${keys.join(', ')});\nDELETE FROM noticeos.config_documents WHERE document_key IN (${keys.join(', ')});`,
    { other },
  );
}

/** Stub outbound fetch: route url -> response factory; unknown urls throw. */
export function stubFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    const handler = routes[url];
    if (!handler) throw new Error(`unexpected fetch: ${url}`);
    return handler();
  }) as typeof fetch;
}

/** What workerd says when a request never completed: no status, one opaque
 * sentence — the same for a dead uplink, a refused connection and DNS that
 * never resolved (src/egress.ts). */
export const WORKERD_TRANSPORT_ERROR = 'internal error; reference = 0d9f4a2c';

/**
 * A lane's fetch fake with the house uplink cut (bead ro-aed0).
 *
 * Every request fails at the transport level, the way 2026-08-08 looked from
 * inside the OS — the egress beacons included — unless `through(url)` lets it
 * reach the lane's own fake, which is how a test says "the uplink died after
 * this call". `beaconUp` lets the reference sites answer: the OS can reach the
 * world and only the provider is dark, which is the case the gate must never
 * make quieter.
 */
export function cutUplink(
  fetchImpl: typeof fetch,
  opts: { beaconUp?: boolean; through?: (url: string) => boolean } = {},
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if ((EGRESS_BEACONS as readonly string[]).includes(url)) {
      if (opts.beaconUp) return new Response('h=1', { status: 200 });
      throw new Error(WORKERD_TRANSPORT_ERROR);
    }
    if (opts.through?.(url)) return fetchImpl(input, init);
    throw new Error(WORKERD_TRANSPORT_ERROR);
  }) as typeof fetch;
}

/** Probe rounds the egress gate has stored (on Postgres). */
export async function storedEgressChecks(): Promise<number> {
  const [row] = await env.STORE.read((tx) => tx.query<{ n: number }>('SELECT count(*)::int AS n FROM noticeos.egress_checks'));
  return row?.n ?? 0;
}

/** Open `os-egress-down` flags — the one fact a dead uplink is allowed to leave. */
export async function openEgressFlags(): Promise<number> {
  return pgCount(`SELECT count(*) AS n FROM noticeos.current_flags WHERE rule_id = $1 AND resolved_at IS NULL`, [
    EGRESS_DOWN_RULE_ID,
  ]);
}

// --- Reports and alerts, on Postgres (bead ro-ujb9.76.5.2) --------------------

/** The rows of one statement on this runtime's Postgres copy, read as the
 * application reads them. */
export async function pgRows<T extends Record<string, unknown>>(sql: string, params: SqlValue[] = []): Promise<T[]> {
  return env.STORE.read((tx) => tx.query<T>(sql, params));
}

/** A statement's first row on this runtime's Postgres copy, or null: where a
 * test read D1's `.first()`. */
export async function pgFirst<T extends Record<string, unknown>>(sql: string, params: SqlValue[] = []): Promise<T | null> {
  return (await pgRows<T>(sql, params))[0] ?? null;
}

/** A statement's rows on this runtime's Postgres copy as D1's `.all()`
 * answered them (`results`), so a test's reads of them stay as they were. */
export async function pgAll<T extends Record<string, unknown>>(sql: string, params: SqlValue[] = []): Promise<{ results: T[] }> {
  return { results: await pgRows<T>(sql, params) };
}

/** COUNT(*) over this runtime's Postgres copy: the statement's `n`. */
export async function pgCount(sql: string, params: SqlValue[] = []): Promise<number> {
  const [row] = await pgRows<{ n: bigint | number }>(sql, params);
  return Number(row?.n ?? 0);
}

/** One statement on this runtime's Postgres copy, as the application writes;
 * the rows it changed. */
export async function pgExecute(sql: string, params: SqlValue[] = []): Promise<number> {
  return env.STORE.write((tx) => tx.execute(sql, params));
}

/** One annotation, stored as the application stores it (on Postgres, bead
 * ro-ujb9.76.5.7): its workspace number back, the id a reader shows. */
export async function insertAnnotation(row: {
  asset: string;
  at: string;
  kind: string;
  ref?: string | null;
  note?: string | null;
}): Promise<number> {
  const [stored] = await env.STORE.write((tx) =>
    tx.query<{ n: bigint }>(
      `INSERT INTO noticeos.annotations (workspace_id, asset_id, at, kind, ref, note)
       VALUES ($1::uuid, $2, $3::timestamptz, $4, $5, $6)
       RETURNING annotation_number AS n`,
      [tx.workspaceId, row.asset, row.at, row.kind, row.ref ?? null, row.note ?? null],
    ),
  );
  return Number(stored!.n);
}

/** One alert, stored as a lane raises it: its workspace number back (what the
 * Tower shows and acts on). `pulseId` is the report's identity
 * (`reportId`), for an alert raised from a report. */
export async function insertFlag(flag: {
  asset: string;
  firedAt: string;
  severity: string;
  kind: string;
  ruleId: string;
  metric?: string | null;
  message?: string | null;
  ruleInputs?: string | null;
  pulseId?: bigint | null;
  /** The revision of the same day's report that replaced this alert. */
  replacedByPulseId?: bigint | null;
  disposition?: string | null;
  dispositionAt?: string | null;
  dispositionNote?: string | null;
  snoozeUntil?: string | null;
  resolvedAt?: string | null;
}): Promise<number> {
  const [row] = await env.STORE.write((tx) =>
    tx.query<{ id: number }>(
      `INSERT INTO noticeos.flags
         (workspace_id, asset_id, pulse_id, fired_at, severity, kind, metric, message, rule_id, rule_inputs,
          disposition, disposition_at, disposition_note, snooze_until, resolved_at, replaced_by_pulse_id)
       VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8, $9, $10::jsonb,
               $11, $12::timestamptz, $13, $14::timestamptz, $15::timestamptz, $16)
       RETURNING flag_number::int AS id`,
      [
        tx.workspaceId,
        flag.asset,
        flag.pulseId ?? null,
        flag.firedAt,
        flag.severity,
        flag.kind,
        flag.metric ?? null,
        flag.message ?? null,
        flag.ruleId,
        flag.ruleInputs ?? null,
        flag.disposition ?? null,
        flag.dispositionAt ?? null,
        flag.dispositionNote ?? null,
        flag.snoozeUntil ?? null,
        flag.resolvedAt ?? null,
        flag.replacedByPulseId ?? null,
      ],
    ),
  );
  return row!.id;
}

/** A report's identity in the store, for an alert that cites it: the newest
 * revision of that site's report for that day. */
export async function reportId(asset: string, date: string): Promise<bigint> {
  const [row] = await pgRows<{ pulse_id: bigint }>(
    `SELECT pulse_id FROM noticeos.current_pulses WHERE asset_id = $1 AND pulse_date = $2::date`,
    [asset, date],
  );
  if (!row) throw new Error(`no report for ${asset} on ${date}`);
  return row.pulse_id;
}

/** One stored report, as a site sends it: a new revision of its day. */
export async function insertPulse(report: {
  asset: string;
  date: string;
  receivedAt: string;
  generatedAt?: string | null;
  capabilities?: string[];
  envelope?: unknown;
}): Promise<bigint> {
  const [row] = await env.STORE.write((tx) =>
    tx.query<{ pulse_id: bigint }>(
      `INSERT INTO noticeos.pulses (workspace_id, asset_id, pulse_date, revision, generated_at, received_at, capabilities, envelope)
       SELECT $1::uuid, $2, $3::date, coalesce(max(revision), 0) + 1, $4::timestamptz, $5::timestamptz, $6::jsonb, $7::json
         FROM noticeos.pulses WHERE asset_id = $2 AND pulse_date = $3::date
       RETURNING pulse_id`,
      [
        tx.workspaceId,
        report.asset,
        report.date,
        report.generatedAt ?? null,
        report.receivedAt,
        JSON.stringify(report.capabilities ?? []),
        JSON.stringify(report.envelope ?? {}),
      ],
    ),
  );
  return row!.pulse_id;
}

/** An alert row in the terms the D1 tests read it: its workspace number as
 * `id`, JSON text for its inputs, instants as JavaScript writes them. */
export interface FlagRow {
  id: number;
  asset: string;
  pulse_id: bigint | null;
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
  resolved_at: string | null;
}

/** Every alert the operator can see (`current_flags`) matching `where`
 * (Postgres, over its own columns), oldest number first. */
export async function flagRows(where = 'true', params: SqlValue[] = []): Promise<FlagRow[]> {
  const instant = (value: string | null) => (value === null ? null : javascriptInstant(value));
  const rows = await pgRows<Omit<FlagRow, 'id'> & { id: number }>(
    `SELECT flag_number::int AS id, asset_id AS asset, pulse_id, fired_at, severity, kind, metric, message, rule_id,
            rule_inputs::text AS rule_inputs, disposition, disposition_at, disposition_note, snooze_until, resolved_at
       FROM noticeos.current_flags WHERE ${where} ORDER BY flag_number`,
    params,
  );
  return rows.map((row) => ({
    ...row,
    fired_at: javascriptInstant(row.fired_at),
    disposition_at: instant(row.disposition_at),
    snooze_until: instant(row.snooze_until),
    resolved_at: instant(row.resolved_at),
  }));
}

export interface TableCounts {
  total: number;
  h24: number;
  d7: number;
}

/** Build the exact Prometheus body `/api/internal/metrics` emits for these tables. */
export function promBody(tables: Record<string, TableCounts>): string {
  const lines = ['# HELP d1_row_count Total row count per D1 table.', '# TYPE d1_row_count gauge'];
  for (const [t, v] of Object.entries(tables)) lines.push(`d1_row_count{table="${t}"} ${v.total}`);
  lines.push(
    '# HELP d1_new_rows_count Rows inserted within the labeled window.',
    '# TYPE d1_new_rows_count gauge',
  );
  for (const [t, v] of Object.entries(tables)) {
    lines.push(`d1_new_rows_count{table="${t}",window="24h"} ${v.h24}`);
  }
  for (const [t, v] of Object.entries(tables)) {
    lines.push(`d1_new_rows_count{table="${t}",window="7d"} ${v.d7}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** A collection run as a test writes it, in the D1 row's own terms. */
export interface TestSignalRun {
  id: string;
  asset: string;
  integration: string;
  finished_at: string;
  /** Default: `finished_at`. */
  started_at?: string;
  status?: 'success' | 'error';
  credential_ref?: string;
  property_ref?: string;
  time_zone?: string | null;
  window_start?: string;
  window_end?: string;
  data_state?: 'final' | 'includes-provisional';
  provisional_from?: string | null;
  provider_rows?: number;
  /** Default: how many values are written with it. */
  observation_count?: number;
  error_code?: string | null;
  /** Default for a failed run: 'failed'. */
  error_message?: string | null;
}

/** One value a run changed. */
export interface TestSignalValue {
  date: string;
  metric: string;
  value: number;
}

/**
 * Collection runs and the values each changed, on Postgres where the
 * collectors write them (bead ro-ujb9.76.5.3), in one transaction through the
 * application role, in the order given: each value under the series its run
 * measured (site, provider, property, zone and metric), named on first use.
 */
export async function storeSignalRuns(runs: { run: TestSignalRun; values?: TestSignalValue[] }[]): Promise<void> {
  await env.STORE.write(async (tx) => {
    for (const { run, values = [] } of runs) {
      const status = run.status ?? 'success';
      const [row] = await tx.query<{ run_seq: bigint }>(
        `INSERT INTO noticeos.signal_runs
           (workspace_id, run_id, asset_id, integration, credential_ref, property_ref, time_zone,
            started_at, finished_at, status, window_start, window_end, data_state, provisional_from,
            provider_rows, observation_count, error_code, error_message)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::text, $8::timestamptz, $9::timestamptz, $10, $11::date, $12::date,
                 $13, $14::date, $15, $16, $17::text, $18::text)
         RETURNING run_seq`,
        [
          tx.workspaceId, run.id, run.asset, run.integration, run.credential_ref ?? 'test', run.property_ref ?? 'prop',
          run.time_zone ?? null, run.started_at ?? run.finished_at, run.finished_at, status,
          run.window_start ?? '2026-01-01', run.window_end ?? '2026-01-01', run.data_state ?? 'final',
          run.provisional_from ?? null, run.provider_rows ?? values.length, run.observation_count ?? values.length,
          run.error_code ?? null, run.error_message ?? (status === 'error' ? 'failed' : null),
        ],
      );
      if (values.length === 0) continue;
      const series = [tx.workspaceId, run.asset, run.integration, run.property_ref ?? 'prop', run.time_zone ?? null] as const;
      await tx.execute(
        `INSERT INTO noticeos.measurement_series (workspace_id, asset_id, integration, property_ref, time_zone, metric)
         SELECT DISTINCT $1::uuid, $2, $3, $4, $5::text, m.metric FROM unnest($6::text[]) AS m(metric)
         ON CONFLICT DO NOTHING`,
        [...series, values.map((value) => value.metric)],
      );
      await tx.execute(
        `INSERT INTO noticeos.signal_observations (workspace_id, run_seq, series_id, observed_date, value)
         SELECT $1::uuid, $6::bigint, s.series_id, v.observed_date, v.value
           FROM unnest($7::date[], $8::text[], $9::float8[]) WITH ORDINALITY AS v(observed_date, metric, value, place)
           JOIN noticeos.measurement_series s
             ON s.workspace_id = $1::uuid AND s.asset_id = $2 AND s.integration = $3 AND s.property_ref = $4
            AND s.time_zone IS NOT DISTINCT FROM $5::text AND s.metric = v.metric
          ORDER BY v.place`,
        [...series, row!.run_seq, values.map((value) => value.date), values.map((value) => value.metric), values.map((value) => value.value)],
      );
    }
  });
}

/** One run and the values it changed (`storeSignalRuns`). */
export async function storeSignalRun(run: TestSignalRun, values: TestSignalValue[] = []): Promise<void> {
  await storeSignalRuns([{ run, values }]);
}

// --- Provider reports, paid lookups and insight snapshots, on Postgres ---------
// (bead ro-ujb9.76.5.4)

/** An instant as JavaScript writes it (`toISOString`), in SQL: the form D1's
 * text held, so a test's string comparisons read as they did. */
const JS_INSTANT = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** The report runs in the D1 row's own terms, for a test to read where it read
 * the D1 manifest (`SELECT … FROM ${ARCHIVE_RUNS} WHERE …`): a run's object
 * key, hash and size beside it, instants as JavaScript writes them, the
 * truncation flag 0/1, an unknown price 0, and `run_seq`, the order runs were
 * written. */
export const ARCHIVE_RUNS = `(SELECT r.run_seq, r.run_id AS id, r.asset_id AS asset, r.integration, r.report,
        r.credential_ref, r.property_ref, r.report_date::text AS report_date,
        ${JS_INSTANT('r.requested_at')} AS requested_at, ${JS_INSTANT('r.finished_at')} AS finished_at,
        r.status, r.data_state, r.schema_version, r.provider_rows, r.request_count,
        r.provider_truncated::int AS provider_truncated, o.object_key, o.content_sha256,
        o.object_bytes::int AS object_bytes, r.error_code, r.error_message,
        COALESCE(r.cost_usd, 0)::float8 AS provider_cost_usd, r.cost_state
   FROM noticeos.archive_runs r
   LEFT JOIN noticeos.archive_objects o ON o.workspace_id = r.workspace_id AND o.object_seq = r.object_seq) AS archive`;

/** The paid lookups in the D1 row's own terms: a lookup's number as `id`, an
 * unknown price 0, instants as JavaScript writes them. */
export const RESEARCH_LOG = `(SELECT research_number::int AS id, asset_id AS asset, provider, endpoint, params_sha256,
        question, COALESCE(cost_usd, 0)::float8 AS cost_usd, cost_state, object_key, actor,
        ${JS_INSTANT('bought_at')} AS bought_at
   FROM noticeos.research_log) AS research`;

/** The insight snapshots in the D1 row's own terms: the payload as the text it
 * was stored as, instants as JavaScript writes them. */
export const INSIGHT_SNAPSHOTS = `(SELECT snapshot_id AS id, asset_id AS asset, ${JS_INSTANT('generated_at')} AS generated_at,
        window_start::text AS window_start, window_end::text AS window_end, source_archive_count,
        content_sha256, payload::text AS payload, ${JS_INSTANT('created_at')} AS created_at
   FROM noticeos.asset_insight_snapshots) AS snapshots`;

/** A provider report run as a test writes it, in the D1 row's own terms. */
export interface TestArchiveRun {
  id: string;
  asset: string;
  integration: string;
  report: string;
  report_date: string;
  finished_at: string;
  /** Default: `finished_at`. */
  requested_at?: string;
  status?: 'success' | 'unchanged' | 'error';
  /** Default: 'provider-snapshot'. */
  data_state?: 'provider-final' | 'revision-window' | 'provider-snapshot';
  credential_ref?: string;
  /** Default: the site's id. */
  property_ref?: string;
  provider_rows?: number;
  request_count?: number;
  provider_truncated?: boolean;
  /** A stored run's object. Default: a key of its own, made from its id. */
  object_key?: string;
  /** Default: 64 zeros. */
  content_sha256?: string;
  /** Default: 1. */
  object_bytes?: number;
  /** Defaults for a failed run: 'test_error', 'failed'. */
  error_code?: string;
  error_message?: string;
  /** What it cost, as its collector states it; kept by the store's one rule
   * (`storedProviderCost`). Default: 0. */
  provider_cost_usd?: number;
}

/**
 * Report runs on Postgres, where the collectors write them, in one
 * transaction through the application role, in the order given. A stored
 * run's object is recorded once per key, dated by the first run that names
 * it, as the collector records it; a key named again with other content is
 * refused, as the store refuses it.
 */
export async function storeArchiveRuns(runs: readonly TestArchiveRun[]): Promise<void> {
  await env.STORE.write(async (tx) => {
    for (const run of runs) {
      const status = run.status ?? 'success';
      const failed = status === 'error';
      let objectSeq: bigint | null = null;
      if (!failed) {
        const key = run.object_key ?? `raw/test/${run.integration}/${run.asset}/${run.report}/${run.report_date}/${run.id}.json.gz`;
        const [object] = await tx.query<{ object_seq: bigint }>(
          `WITH stored AS (
             INSERT INTO noticeos.archive_objects (workspace_id, object_key, content_sha256, object_bytes, first_stored_at)
             VALUES ($1::uuid, $2, $3, $4, $5::timestamptz)
             ON CONFLICT (workspace_id, object_key) DO NOTHING
             RETURNING object_seq)
           SELECT object_seq FROM stored
           UNION ALL
           SELECT object_seq FROM noticeos.archive_objects WHERE object_key = $2 AND content_sha256 = $3 AND object_bytes = $4`,
          [tx.workspaceId, key, run.content_sha256 ?? '0'.repeat(64), run.object_bytes ?? 1, run.finished_at],
        );
        if (object === undefined) throw new Error(`storeArchiveRuns: ${key} is already stored with other content`);
        objectSeq = object.object_seq;
      }
      const cost = storedProviderCost(run.integration, run.provider_cost_usd ?? 0);
      await tx.execute(
        `INSERT INTO noticeos.archive_runs
           (workspace_id, run_id, asset_id, integration, report, credential_ref, property_ref, report_date,
            requested_at, finished_at, status, data_state, schema_version, provider_rows, request_count,
            provider_truncated, object_seq, error_code, error_message, cost_usd, cost_state)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::date, $9::timestamptz, $10::timestamptz, $11, $12, 1, $13, $14,
                 $15, $16::bigint, $17::text, $18::text, $19::numeric, $20)`,
        [
          tx.workspaceId, run.id, run.asset, run.integration, run.report, run.credential_ref ?? 'test',
          run.property_ref ?? run.asset, run.report_date, run.requested_at ?? run.finished_at, run.finished_at,
          status, run.data_state ?? 'provider-snapshot', run.provider_rows ?? 0, run.request_count ?? 0,
          run.provider_truncated ?? false, objectSeq,
          failed ? (run.error_code ?? 'test_error') : null, failed ? (run.error_message ?? 'failed') : null,
          cost.usd, cost.state,
        ],
      );
    }
  });
}

/** One report run (`storeArchiveRuns`). */
export async function storeArchiveRun(run: TestArchiveRun): Promise<void> {
  await storeArchiveRuns([run]);
}

/** An insight snapshot as a test writes it, in the D1 row's own terms. */
export interface TestInsightSnapshot {
  id: string;
  asset: string;
  generated_at: string;
  payload: string;
  /** Default: now, as the store stamps it. */
  created_at?: string;
  window_start?: string | null;
  window_end?: string | null;
  /** Default: 1. */
  source_archive_count?: number;
  /** Default: the SHA-256 of the id. */
  content_sha256?: string;
}

/** Insight snapshots on Postgres, in one transaction, in the order given. */
export async function storeInsightSnapshots(snapshots: readonly TestInsightSnapshot[]): Promise<void> {
  const digests = await Promise.all(snapshots.map((snapshot) => snapshot.content_sha256 ?? testDigest(snapshot.id)));
  await env.STORE.write(async (tx) => {
    for (const [index, snapshot] of snapshots.entries()) {
      await tx.execute(
        `INSERT INTO noticeos.asset_insight_snapshots
           (workspace_id, snapshot_id, asset_id, generated_at, window_start, window_end,
            source_archive_count, content_sha256, payload, created_at)
         VALUES ($1::uuid, $2, $3, $4::timestamptz, $5::date, $6::date, $7, $8, $9::json,
                 COALESCE($10::timestamptz, now()))`,
        [
          tx.workspaceId, snapshot.id, snapshot.asset, snapshot.generated_at, snapshot.window_start ?? null,
          snapshot.window_end ?? null, snapshot.source_archive_count ?? 1, digests[index]!, snapshot.payload,
          snapshot.created_at ?? null,
        ],
      );
    }
  });
}

async function testDigest(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
