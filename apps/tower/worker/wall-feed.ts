import { minorToMajorUnits } from '@noticeos/contract/money';
// GET /api/wall/feed — what just happened, across the store: a read-only
// union of stored events. Nothing is inferred; an empty window is an empty
// feed. Every statement reads only the window (6 PM yesterday in the OS time
// zone) through an index and carries a row cap; the per-asset reads are
// driven from the small `assets` registry so each asset seeks its own
// `(asset, time)` range. `test/wall-feed.test.ts` asserts every plan.
//
// Folding, in this order: collections fold per provider per run, and only a
// provider's newest run is a line; revenue folds per report day, nightly
// reports per night, spend per provider per run, insight refreshes per run,
// and the OS's own successful deploys into one line for the whole window;
// consecutive foldable lines of the same kind within 15 minutes fold with a
// count. A failure never folds into a success and is never superseded.

import { javascriptInstant, type SqlValue, type WorkspaceStore } from "@noticeos/postgres";
import { readSites } from "./asset-registry";
import { cents } from "./ledger-history";
import { configDocumentFile } from "../../../scripts/config-documents.mjs";
import { assetDisplayName } from "@noticeos/contract/asset-name";
import { INTEGRATION_MONITORS } from "@noticeos/contract/integration-health";
import { settledAtSql } from "./flag-scope";
import { SCHEDULED_JOBS } from "../../../scripts/scheduled-jobs.mjs";
import { osDeployOutcome, type OsDeployOutcome } from "../../../scripts/os-deploy-events.mjs";
import { translateAlert } from "../shared/alert-language";
import { siteCount } from "../shared/site-noun";
import {
  WALL_FEED_FOLD_MS,
  WALL_FEED_LABEL,
  WALL_FEED_LIMIT,
  feedSentence,
  feedWindowStart,
  type WallFeedItem,
  type WallFeedKind,
  type WallFeedPayload,
  type WallFeedTone,
} from "../shared/wall-feed";
import { JSON_HEADERS } from "./http";

/** Rows any one statement may return. */
export const FEED_SOURCE_CAP = 500;
/** How far back a rowid tail reaches on a table with no time index. */
export const FEED_TAIL_ROWS = 500;
/** How often the task hub's photographs are sampled across the window. A
 * closure stays in a project's five-most-recent list until five more close,
 * so a quarter hour catches every one but a burst. */
export const FEED_SNAPSHOT_STEP_MINUTES = 15;
/** Slack on the tables whose index is on the START of a run. */
const RUN_START_SLACK_MS = 2 * 86_400_000;

// ─── the statements ─────────────────────────────────────────────────────────

/** Each site's alerts through its (site, fired_at) index — the registry
 * first, then one bounded seek per site — every alert as its newest reading
 * states it, never one a same-day report retry replaced. */
export const FEED_FLAGS_FIRED_SQL = `SELECT f.flag_number::int AS id, a.asset_id AS asset, f.fired_at AS at, f.severity, f.metric, f.message,
       f.rule_id AS "ruleId", f.rule_inputs::text AS "ruleInputs"
  FROM noticeos.assets a
  CROSS JOIN LATERAL (
        SELECT c.flag_number, c.fired_at, c.severity, c.metric, c.message, c.rule_id, c.rule_inputs
          FROM noticeos.current_flags c
         WHERE c.workspace_id = a.workspace_id AND c.asset_id = a.asset_id AND c.fired_at >= $1::timestamptz
         ORDER BY c.fired_at DESC
         LIMIT $2) f
 ORDER BY f.fired_at DESC LIMIT $2`;

/** The settled-time index (`flags_asset_settled`, on `settledAtSql`) seeks
 * resolutions, one site at a time; `resolved_at` leads the expression, so on a
 * resolved row it IS the settled time. */
export const FEED_FLAGS_RESOLVED_SQL = `SELECT f.flag_number::int AS id, a.asset_id AS asset, f.resolved_at AS at, f.severity, f.metric, f.message,
       f.rule_id AS "ruleId", f.rule_inputs::text AS "ruleInputs"
  FROM noticeos.assets a
  CROSS JOIN LATERAL (
        SELECT c.flag_number, c.resolved_at, c.severity, c.metric, c.message, c.rule_id, c.rule_inputs
          FROM noticeos.current_flags c
         WHERE c.workspace_id = a.workspace_id AND c.asset_id = a.asset_id
           AND ${settledAtSql("c")} >= $1::timestamptz
           AND c.resolved_at IS NOT NULL
         ORDER BY c.resolved_at DESC
         LIMIT $2) f
 ORDER BY f.resolved_at DESC LIMIT $2`;

/** Transitions only (failed, changed, recovered): the store records one when
 * a source's state moves, not on every attempt. The window's newest through
 * the (workspace, recorded time) index, each with the target it is about. */
export const FEED_HEALTH_SQL = `SELECT e.event_id AS "eventId", t.provider, t.capability, t.asset_id AS asset, e.recorded_at AS at,
       e.kind, e.failure_kind AS "failureKind", e.evidence_source AS "evidenceSource", e.evidence_id AS "evidenceId"
  FROM noticeos.integration_health_events e
  JOIN noticeos.capability_targets t ON t.workspace_id = e.workspace_id AND t.target_seq = e.target_seq
 WHERE e.recorded_at >= $1::timestamptz
 ORDER BY e.recorded_at DESC LIMIT $2`;

/** Driven from the site list, each site's lane seeking its newest runs down
 * the runs' (site, lane, finish) index; a LATERAL read per lane keeps that
 * order. Runs that finished in the same instant come in the order they were
 * written. */
export const FEED_SIGNAL_FAILURES_SQL = `SELECT r.run_id AS id, r.asset_id AS asset, r.integration, r.finished_at AS at
  FROM noticeos.assets a
 CROSS JOIN (VALUES ('ga4'), ('gsc'), ('bing-webmaster')) AS lanes(integration)
 CROSS JOIN LATERAL (
       SELECT r.run_id, r.run_seq, r.asset_id, r.integration, r.finished_at
         FROM noticeos.signal_runs r
        WHERE r.workspace_id = a.workspace_id AND r.asset_id = a.asset_id
          AND r.integration = lanes.integration AND r.finished_at >= $1::timestamptz
          AND r.status = 'error'
        ORDER BY r.finished_at DESC, r.run_seq
        LIMIT $2) r
 ORDER BY r.finished_at DESC, r.run_seq LIMIT $2`;

/** A site's newest successful run per integration: only the newest says
 * anything; of two that finished in the same instant, the one written first. */
export const FEED_SIGNAL_LATEST_SQL = `SELECT r.asset_id AS asset, r.integration, r.finished_at AS at, r.run_id AS id
  FROM noticeos.assets a
 CROSS JOIN (VALUES ('ga4'), ('gsc'), ('bing-webmaster')) AS lanes(integration)
 CROSS JOIN LATERAL (
       SELECT r.run_id, r.run_seq, r.asset_id, r.integration, r.finished_at
         FROM noticeos.signal_runs r
        WHERE r.workspace_id = a.workspace_id AND r.asset_id = a.asset_id
          AND r.integration = lanes.integration AND r.finished_at >= $1::timestamptz
          AND r.status = 'success'
        ORDER BY r.finished_at DESC, r.run_seq
        LIMIT 1) r
 ORDER BY r.asset_id COLLATE "C", r.integration COLLATE "C"`;

/** Each lane's runs asked since the run-start slack, one seek per lane down
 * the runs' (lane, asked) index; two finished in one instant, the later
 * written first. An unknown price is no spend. */
export const FEED_DUMPS_SQL = `SELECT d.run_id AS id, d.asset_id AS asset, d.integration, d.report, d.finished_at AS at, d.status,
       COALESCE(d.cost_usd, 0)::float8 AS "costUsd"
  FROM (VALUES ('ga4'), ('gsc'), ('bing-webmaster'), ('dataforseo'), ('clarity'), ('posthog')) AS lanes(integration)
 CROSS JOIN LATERAL (
       SELECT r.run_id, r.asset_id, r.integration, r.report, r.finished_at, r.status, r.cost_usd, r.run_seq
         FROM noticeos.archive_runs r
        WHERE r.integration = lanes.integration
          AND r.requested_at >= $1::timestamptz AND r.finished_at >= $2::timestamptz
        ORDER BY r.finished_at DESC, r.run_seq DESC
        LIMIT $3) d
 ORDER BY d.finished_at DESC, d.run_seq DESC LIMIT $3`;

/** Driven from the site list so each site seeks its own (site, time) range.
 * A run is known by its own text id, the one its health event names. */
export const FEED_MEDIAVINE_RUNS_SQL = `SELECT m.run_id AS id, m.asset_id AS asset, m.attempted_at AS at, m.outcome
  FROM noticeos.assets a
  JOIN noticeos.mediavine_runs m
    ON m.workspace_id = a.workspace_id AND m.asset_id = a.asset_id AND m.attempted_at >= $1::timestamptz
 ORDER BY m.attempted_at DESC, m.run_seq DESC LIMIT $2`;

/** Each successful run's newest report day and what it earned, a day known by
 * its workspace's number. */
export const FEED_REVENUE_SQL = `SELECT d.daily_number AS id, m.asset_id AS asset, d.report_date AS day, d.amount_minor AS "amountMinor", d.recorded_at AS at
  FROM noticeos.assets a
  JOIN noticeos.mediavine_runs m
    ON m.workspace_id = a.workspace_id AND m.asset_id = a.asset_id AND m.attempted_at >= $1::timestamptz AND m.outcome = 'success'
  JOIN noticeos.mediavine_daily d
    ON d.workspace_id = m.workspace_id AND d.run_seq = m.run_seq
   AND d.report_date = (SELECT MAX(x.report_date) FROM noticeos.mediavine_daily x
                         WHERE x.workspace_id = m.workspace_id AND x.run_seq = m.run_seq)
 ORDER BY d.recorded_at DESC, d.daily_id DESC LIMIT $2`;

/** Each site's checks since the window's first day through the (site, check,
 * day) index; readings of one instant, newest written first. */
export const FEED_HYGIENE_SQL = `SELECT h.reading_number::text AS id, h.asset_id AS asset, h.observed_at AS at
  FROM noticeos.assets a
  JOIN noticeos.hygiene_checks h
    ON h.workspace_id = a.workspace_id AND h.asset_id = a.asset_id
   AND h.check_id IN ('html-depth','robots-ai-access','sitemap','page-structure')
   AND h.observed_on >= $1::date
 WHERE h.observed_at >= $2::timestamptz
 ORDER BY h.observed_at DESC, h.reading_id DESC LIMIT $3`;

/** Money booked: the newest `FEED_TAIL_ROWS` entries by the workspace's own
 * number (the ledger keeps no time index), read down its (workspace, number)
 * index. A change entry names no money. */
export const FEED_LEDGER_SQL = `SELECT l.entry_number AS id, l.kind, l.asset_id AS asset, to_char(l.period_month, 'YYYY-MM') AS period,
       l.family, l.currency, l.amount_minor AS "amountMinor", l.recorded_at AS at
  FROM (SELECT * FROM noticeos.ledger_entries ORDER BY entry_number DESC LIMIT $1) l
 WHERE l.recorded_at >= $2::timestamptz AND l.kind IN ('revenue', 'cost')
 ORDER BY l.recorded_at DESC, l.entry_number ASC LIMIT $3`;

/** Paid lookups bought in the window, through the log's (workspace, bought)
 * index, a lookup known by its workspace's number; of two bought in one
 * instant, the later numbered first. An unknown price is no spend. */
export const FEED_RESEARCH_SQL = `SELECT r.research_number::int AS id, r.asset_id AS asset, r.provider,
       COALESCE(r.cost_usd, 0)::float8 AS "costUsd", r.bought_at AS at
  FROM noticeos.research_log r
 WHERE r.bought_at >= $1::timestamptz
 ORDER BY r.bought_at DESC, r.research_number DESC LIMIT $2`;

/** Each asset's newest two analyses, for assets whose newest is inside the
 * window, by the order the store keeps two by
 * (`noticeos.insight_snapshot_is_kept`): the site list first, then each site's
 * snapshots down their (site, generated) index. Only finding keys and titles
 * leave the store, in the order the analysis listed them. */
export const FEED_INSIGHTS_SQL = `SELECT a.asset_id AS asset, p.snapshot_id AS id, p.generated_at AS at, p.findings
  FROM noticeos.assets a
 CROSS JOIN LATERAL (
       SELECT q.snapshot_id, q.generated_at,
              (SELECT json_agg(json_build_array(i.value ->> 'key', i.value ->> 'title') ORDER BY i.n)::text
                 FROM json_array_elements(CASE json_typeof(q.payload -> 'items') WHEN 'array' THEN q.payload -> 'items' ELSE '[]'::json END)
                      WITH ORDINALITY AS i(value, n)) AS findings
         FROM noticeos.asset_insight_snapshots q
        WHERE q.workspace_id = a.workspace_id AND q.asset_id = a.asset_id
        ORDER BY q.generated_at DESC, q.created_at DESC, q.snapshot_id DESC
        LIMIT 2) p
 WHERE (SELECT max(n.generated_at) FROM noticeos.asset_insight_snapshots n
         WHERE n.workspace_id = a.workspace_id AND n.asset_id = a.asset_id) >= $1::timestamptz
 ORDER BY a.asset_id COLLATE "C", p.generated_at DESC`;

/** Each site's reports through its (site, received_at) index, one bounded
 * seek per site: a day's newest revision, numbered by the day. */
export const FEED_PULSES_SQL = `SELECT p.day_number::int AS id, a.asset_id AS asset, p.pulse_date::text AS date, p.received_at AS at
  FROM noticeos.assets a
  CROSS JOIN LATERAL (
        SELECT c.day_number, c.pulse_date, c.received_at
          FROM noticeos.current_pulses c
         WHERE c.workspace_id = a.workspace_id AND c.asset_id = a.asset_id AND c.received_at >= $1::timestamptz
         ORDER BY c.received_at DESC
         LIMIT $2) p
 ORDER BY p.received_at DESC LIMIT $2`;

/** Each site's changes through its (site, time) index, one bounded seek per
 * site; two at one instant, newest filed first. */
export const FEED_ANNOTATIONS_SQL = `SELECT n.annotation_number::int AS id, a.asset_id AS asset, n.at, n.kind, n.ref, n.note
  FROM noticeos.assets a
  CROSS JOIN LATERAL (
        SELECT c.annotation_number, c.at, c.kind, c.ref, c.note
          FROM noticeos.annotations c
         WHERE c.workspace_id = a.workspace_id AND c.asset_id = a.asset_id AND c.at >= $1::timestamptz
         ORDER BY c.at DESC, c.annotation_number DESC
         LIMIT $2) n
 ORDER BY n.at DESC, n.annotation_number DESC LIMIT $2`;

/** The documents registry, then each document's changes through its
 * (document, time) index. */
export const FEED_CONFIG_SQL = `SELECT c.change_number::text AS id, c.document_key AS "documentKey", c.reason, c.changed_at AS at
  FROM noticeos.config_documents cd
  JOIN noticeos.config_changes c
    ON c.workspace_id = cd.workspace_id AND c.document_key = cd.document_key AND c.changed_at >= $1::timestamptz
 ORDER BY c.changed_at DESC LIMIT $2`;

/** The window's failed firings through the (workspace, start) index; two
 * finished at one instant, the later recorded first. */
export const FEED_JOBS_SQL = `SELECT j.job_run_number::text AS id, j.job, j.finished_at AS at
  FROM noticeos.job_runs j
 WHERE j.started_at >= $1::timestamptz AND j.finished_at >= $2::timestamptz AND j.outcome = 'failed'
 ORDER BY j.finished_at DESC, j.job_run_id DESC LIMIT $3`;

/**
 * Tasks done and tasks filed, from the hub's snapshots. The table keeps a
 * snapshot only when the board changed; this reads the one in force at every
 * quarter hour of the window (and so the newest), each an index seek, and
 * unrolls only `recentlyClosed` by `closedAt` and `recentlyCreated` by
 * `createdAt` (absent from an older poller's snapshots). The same task in
 * several snapshots is one event: the oldest snapshot's line is kept, and the
 * deduplication happens before the source cap so repeated early snapshots
 * cannot crowd later work out. The store keeps two days of snapshots
 * (`BEADS_SNAPSHOT_RETENTION_DAYS`, workers/ingest/src/beads-snapshots.ts),
 * which covers this window's farthest reach; keep the two in step. An item's
 * time is the text the writer stored (`toISOString`), compared byte by byte.
 */
export const FEED_TASKS_SQL = `WITH RECURSIVE ticks(t) AS (
    SELECT $1::timestamptz
    UNION ALL
    SELECT t + interval '${FEED_SNAPSHOT_STEP_MINUTES} minutes' FROM ticks WHERE t < $2::timestamptz
  ),
  picks AS (
    SELECT DISTINCT (SELECT s.snapshot_id FROM noticeos.task_snapshots s WHERE s.captured_at <= ticks.t
                      ORDER BY s.captured_at DESC, s.snapshot_id DESC LIMIT 1) AS id
      FROM ticks
  ),
  first_seen AS (
SELECT DISTINCT ON (i.list, i.value ->> 'id')
       i.list, p.value ->> 'asset' AS asset, i.value ->> 'id' AS id, i.value ->> 'title' AS title, i.at
  FROM picks
  JOIN noticeos.task_snapshots s ON s.snapshot_id = picks.id
 CROSS JOIN LATERAL jsonb_array_elements(CASE jsonb_typeof(s.payload -> 'projects') WHEN 'array' THEN s.payload -> 'projects' ELSE '[]' END)
       WITH ORDINALITY AS p(value, n)
 CROSS JOIN LATERAL (
       SELECT l.list, e.value, e.n AS item_n, l.n AS list_n,
              e.value ->> (CASE l.list WHEN 'recentlyClosed' THEN 'closedAt' ELSE 'createdAt' END) AS at
         FROM (VALUES ('recentlyClosed', 1), ('recentlyCreated', 2)) AS l(list, n)
        CROSS JOIN LATERAL jsonb_array_elements(CASE jsonb_typeof(p.value -> l.list) WHEN 'array' THEN p.value -> l.list ELSE '[]' END)
              WITH ORDINALITY AS e(value, n)
       ) i
 WHERE i.at COLLATE "C" >= $3::text
 ORDER BY i.list, i.value ->> 'id', s.captured_at, s.snapshot_id, p.n, i.list_n, i.item_n
  )
SELECT list, asset, id, title, at FROM first_seen
 ORDER BY at COLLATE "C" DESC, list, id
 LIMIT $4`;

// ─── raw events ─────────────────────────────────────────────────────────────

interface Site {
  name: string;
  isOs: boolean;
}

/** One stored event, before the consecutive fold. */
interface FeedEvent {
  id: string;
  atMs: number;
  kind: WallFeedKind;
  label?: string;
  asset: string | null;
  text: string;
  tone: WallFeedTone;
  count?: number;
  /** Events sharing a key fold when consecutive; null never folds. */
  foldKey: string | null;
  /** The folded line's words for `n` events over `sites` sites. */
  many?: (n: number, sites: number) => string;
}

const ms = (iso: string): number => Date.parse(iso);

/** Any other noun's count. A count of sites goes through `siteCount`
 * (shared/site-noun.ts). */
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const across = (text: string, sites: number) => (sites > 1 ? `${text} across ${siteCount(sites)}` : text);

function usd(minor: number): string {
  const whole = minor % 100 === 0 && Math.abs(minor) >= 10_000;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(minor / 100);
}

function monthDay(day: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(`${day}T12:00:00Z`),
  );
}

function monthName(period: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(
    new Date(`${period}-15T12:00:00Z`),
  );
}

/** The provider a collection row belongs to, in the room's words. */
function collector(integration: string): string {
  switch (integration) {
    case "ga4":
    case "gsc":
      return "Google";
    case "bing-webmaster":
      return "Bing";
    case "dataforseo":
      return "DataForSEO";
    case "clarity":
      return "Clarity";
    case "posthog":
      return "PostHog";
    case "mediavine":
      return "Mediavine";
    case "hygiene":
      return "Site checks";
    default:
      return integration;
  }
}

const FAILURE_WORDS: Record<string, string> = {
  access: "access denied",
  "rate-limit": "rate limited",
  budget: "out of budget",
  network: "network error",
  provider: "provider error",
  "invalid-report": "unreadable report",
  "incomplete-report": "incomplete report",
  configuration: "setup problem",
  monitoring: "could not save",
};

function monitorLabel(provider: string, capability: string): string {
  const monitors = (INTEGRATION_MONITORS as Record<string, readonly { id: string; label: string }[]>)[provider];
  return monitors?.find((monitor) => monitor.id === capability)?.label ?? collector(provider);
}

function jobLabel(job: string): string {
  const cron = job.startsWith("cron ") ? job.slice(5) : null;
  const found = SCHEDULED_JOBS.find((entry) => (cron ? !entry.local && entry.cron === cron : entry.id === job));
  return found?.label ?? job;
}

const CONFIG_FILE_WORDS: Record<string, string> = {
  "config/constants.json": "OS settings",
  "config/tower.json": "Tower settings",
  "config/integrations.json": "Data sources",
  "config/counters.json": "Counters",
  "config/alert-rules.json": "Alert rules",
  "config/beads.json": "Task projects",
};

function configWords(file: string): string {
  const known = CONFIG_FILE_WORDS[file];
  if (known) return known;
  const stem = file.replace(/^config\//, "").replace(/\.json$/, "").replace(/[-_]/g, " ");
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

/** The line's word for each of the OS's own moves; a plain deploy keeps the
 * kind's own word. */
const OS_MOVE_LABEL: Record<OsDeployOutcome, string | undefined> = {
  deployed: undefined,
  "rolled-back": "Rolled back",
  failed: "Deploy failed",
};

/** A deploy annotation's own sentence: its note, or the version it made live. */
function deployText(row: AnnotationRow): string {
  const ref = row.ref ? row.ref.slice(0, 12) : null;
  return row.note?.trim() || (ref ? `New version ${ref} is live` : "New version is live");
}

const ANNOTATION_WORDS: Record<string, string> = {
  "model-change": "Model change",
  incident: "Incident",
  "autonomy-change": "Autonomy change",
  external: "External",
};

/** The headline's first clause: "Plans saved well below normal". */
function alertWords(row: FlagRow): string {
  let inputs: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = row.ruleInputs ? JSON.parse(row.ruleInputs) : null;
    inputs = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    inputs = null;
  }
  const { headline } = translateAlert({ ruleId: row.ruleId, ruleInputs: inputs, metric: row.metric, message: row.message });
  return headline.split(" — ")[0] ?? headline;
}

// ─── row shapes ─────────────────────────────────────────────────────────────

type FlagRow = {
  id: number;
  asset: string;
  at: string;
  severity: "info" | "warn" | "error";
  metric: string | null;
  message: string | null;
  ruleId: string;
  ruleInputs: string | null;
};
type HealthRow = {
  eventId: string;
  provider: string;
  capability: string;
  /** Null for an account's target, which names no site. */
  asset: string | null;
  at: string;
  kind: "failed" | "changed" | "recovered";
  failureKind: string | null;
  evidenceSource: string;
  evidenceId: string;
};
interface RunRow {
  id: string;
  asset: string;
  integration: string;
  at: string;
}
interface DumpRow extends RunRow {
  report: string;
  status: "success" | "unchanged" | "error";
  costUsd: number;
}
interface MediavineRow {
  id: string;
  asset: string;
  at: string;
  outcome: "success" | "incomplete" | "failed";
}
interface RevenueRow {
  id: number;
  asset: string;
  day: string;
  amountMinor: number;
  at: string;
}
type HygieneRow = {
  id: string;
  asset: string;
  at: string;
};
interface LedgerRow {
  currency: string;
  id: number;
  kind: "revenue" | "cost";
  asset: string;
  period: string;
  family: string;
  amountMinor: number;
  at: string;
}
interface ResearchRow {
  id: number;
  asset: string | null;
  provider: string;
  costUsd: number;
  at: string;
}
interface InsightRow {
  asset: string;
  id: string;
  at: string;
  findings: string | null;
}
type PulseRow = {
  id: number;
  asset: string;
  date: string;
  at: string;
};
interface AnnotationRow extends Record<string, unknown> {
  id: number;
  asset: string;
  at: string;
  kind: string;
  ref: string | null;
  note: string | null;
}
interface ConfigRow {
  id: string;
  file: string;
  reason: string | null;
  at: string;
}
type JobRow = {
  id: string;
  job: string;
  at: string;
};
type TaskRow = {
  list: "recentlyClosed" | "recentlyCreated";
  asset: string | null;
  id: string | null;
  title: string | null;
  at: string | null;
};

/** A collection attempt, whichever table recorded it. */
interface Attempt {
  id: string;
  asset: string;
  provider: string;
  atMs: number;
  ok: boolean;
}

// ─── clustering ─────────────────────────────────────────────────────────────

/** Rows newest first, chained into runs: a row joins the run above it when it
 * finished within the fold gap of that run's previous row. */
function runsOf<T extends { atMs: number }>(rows: readonly T[]): T[][] {
  const sorted = [...rows].sort((a, b) => b.atMs - a.atMs);
  const runs: T[][] = [];
  for (const row of sorted) {
    const current = runs.at(-1);
    const last = current?.at(-1);
    if (current && last && last.atMs - row.atMs <= WALL_FEED_FOLD_MS) current.push(row);
    else runs.push([row]);
  }
  return runs;
}

/** The newest run of each provider as one "Collected" line. Failures are
 * their own events elsewhere; this line counts them only to say "none". */
function collectedLines(attempts: readonly Attempt[]): FeedEvent[] {
  const byProvider = new Map<string, Attempt[]>();
  for (const attempt of attempts) {
    const list = byProvider.get(attempt.provider) ?? [];
    list.push(attempt);
    byProvider.set(attempt.provider, list);
  }
  const lines: FeedEvent[] = [];
  for (const [provider, list] of byProvider) {
    const successes = list.filter((attempt) => attempt.ok);
    const newest = runsOf(successes)[0];
    if (!newest) continue;
    const top = newest[0]!;
    const from = newest.at(-1)!.atMs - WALL_FEED_FOLD_MS;
    const to = top.atMs + WALL_FEED_FOLD_MS;
    const ok = new Set(newest.map((attempt) => attempt.asset));
    const failed = new Set(
      list.filter((attempt) => !attempt.ok && attempt.atMs >= from && attempt.atMs <= to && !ok.has(attempt.asset)).map((attempt) => attempt.asset),
    );
    const sites = siteCount(ok.size);
    lines.push({
      // Its own namespace: a source coming back shares the run's id.
      id: `collected:${top.id}`,
      atMs: top.atMs,
      kind: "collected",
      asset: ok.size === 1 ? top.asset : null,
      text: failed.size === 0 ? `${provider} · ${sites}, none failed` : `${provider} · ${ok.size} of ${siteCount(ok.size + failed.size)}`,
      tone: "neutral",
      count: newest.length,
      foldKey: null,
    });
  }
  return lines;
}

/** Spend per provider per run. */
function costLines(rows: readonly { id: string; asset: string | null; provider: string; atMs: number; usd: number }[], noun: string): FeedEvent[] {
  const byProvider = new Map<string, typeof rows[number][]>();
  for (const row of rows) {
    const list = byProvider.get(row.provider) ?? [];
    list.push(row);
    byProvider.set(row.provider, list);
  }
  const lines: FeedEvent[] = [];
  for (const [provider, list] of byProvider) {
    for (const run of runsOf(list)) {
      const top = run[0]!;
      const minor = Math.round(run.reduce((sum, row) => sum + row.usd, 0) * 100);
      const assets = new Set(run.map((row) => row.asset));
      lines.push({
        id: top.id,
        atMs: top.atMs,
        kind: "cost",
        asset: assets.size === 1 ? top.asset : null,
        text: `${provider} · ${usd(minor)} for ${plural(run.length, noun)}`,
        tone: "cost",
        count: run.length,
        foldKey: null,
      });
    }
  }
  return lines;
}

// ─── the consecutive fold ───────────────────────────────────────────────────

function fold(events: readonly FeedEvent[], sites: ReadonlyMap<string, Site>): WallFeedItem[] {
  const sorted = [...events].sort((a, b) => b.atMs - a.atMs || a.id.localeCompare(b.id));
  const groups: FeedEvent[][] = [];
  for (const event of sorted) {
    const group = groups.at(-1);
    const last = group?.at(-1);
    if (
      group &&
      last &&
      event.foldKey !== null &&
      last.foldKey === event.foldKey &&
      last.atMs - event.atMs <= WALL_FEED_FOLD_MS
    ) {
      group.push(event);
    } else {
      groups.push([event]);
    }
  }
  return groups.map((group) => {
    const top = group[0]!;
    const assets = new Set(group.map((event) => event.asset));
    const asset = assets.size === 1 ? top.asset : null;
    const count = group.reduce((sum, event) => sum + (event.count ?? 1), 0);
    const text = group.length === 1 ? top.text : (top.many?.(group.length, assets.size) ?? top.text);
    return {
      id: top.id,
      at: new Date(top.atMs).toISOString(),
      kind: top.kind,
      label: top.label ?? WALL_FEED_LABEL[top.kind],
      asset,
      site: asset ? (sites.get(asset)?.name ?? asset) : null,
      text: feedSentence(text),
      count,
      tone: top.tone,
    };
  });
}

// ─── the read ───────────────────────────────────────────────────────────────

export interface WallFeedDeps {
  now: Date;
  /** The saved `os_time_zone` — the window opens at 6 PM yesterday there. */
  osTimeZone: string;
  /** A later start than the window's; never an earlier one. */
  since?: string | null;
  /** Lines to return, 1..50. */
  limit?: number | null;
}

/** Mediavine attempts, revenue days and money booked since `since`: one read,
 * instants as JavaScript writes them, cents and numbers as exact numbers. */
async function moneyRows(
  store: WorkspaceStore,
  since: string,
  cap: number,
): Promise<{ mediavine: MediavineRow[]; revenue: RevenueRow[]; ledger: LedgerRow[] }> {
  const read = await store.read(async (tx) => ({
    mediavine: await tx.query<Omit<MediavineRow, "at"> & { at: string }>(FEED_MEDIAVINE_RUNS_SQL, [since, cap]),
    revenue: await tx.query<{ id: bigint; asset: string; day: string; amountMinor: bigint; at: string }>(FEED_REVENUE_SQL, [since, cap]),
    ledger: await tx.query<{ id: bigint; kind: LedgerRow["kind"]; asset: string; period: string; family: string; currency: string; amountMinor: bigint; at: string }>(
      FEED_LEDGER_SQL,
      [FEED_TAIL_ROWS, since, cap],
    ),
  }));
  return {
    mediavine: read.mediavine.map((row) => ({ ...row, at: javascriptInstant(row.at) })),
    revenue: read.revenue.map((row) => ({ ...row, id: Number(row.id), amountMinor: cents(row.amountMinor), at: javascriptInstant(row.at) })),
    ledger: read.ledger.map((row) => ({ ...row, id: Number(row.id), amountMinor: cents(row.amountMinor), at: javascriptInstant(row.at) })),
  };
}

/** Rows of a statement, each `at` in the form JavaScript writes. */
async function storeRows<T extends { at: string }>(
  store: WorkspaceStore,
  sql: string,
  ...params: SqlValue[]
): Promise<T[]> {
  const found = await store.read((tx) => tx.query<T>(sql, params));
  return found.map((row) => ({ ...row, at: javascriptInstant(row.at) }));
}

/** Settings saved since `since`, from the config store's change history. */
async function configRows(store: WorkspaceStore, since: string, cap: number): Promise<ConfigRow[]> {
  const found = await store.read((tx) =>
    tx.query<{ id: string; documentKey: string; reason: string | null; at: string }>(FEED_CONFIG_SQL, [since, cap]),
  );
  return found.map((row) => ({ id: row.id, file: configDocumentFile(row.documentKey), reason: row.reason, at: javascriptInstant(row.at) }));
}

/** Sources' transitions since `since`, from the store's health history. */
async function healthRows(store: WorkspaceStore, since: string, cap: number): Promise<HealthRow[]> {
  const found = await store.read((tx) => tx.query<HealthRow>(FEED_HEALTH_SQL, [since, cap]));
  return found.map((row) => ({ ...row, at: javascriptInstant(row.at) }));
}

/** Site checks read since `since`, from the store's site-check readings. */
async function hygieneRows(store: WorkspaceStore, since: string, cap: number): Promise<HygieneRow[]> {
  const found = await store.read((tx) => tx.query<HygieneRow>(FEED_HYGIENE_SQL, [since.slice(0, 10), since, cap]));
  return found.map((row) => ({ ...row, at: javascriptInstant(row.at) }));
}

/** Tasks done and filed since `since`, from the store's task photographs. */
async function taskRows(store: WorkspaceStore, since: string, now: string, cap: number): Promise<TaskRow[]> {
  return store.read((tx) => tx.query<TaskRow>(FEED_TASKS_SQL, [since, now, since, cap]));
}

/** Scheduled jobs that failed since `since`, from the store's job-run record. */
async function jobRows(store: WorkspaceStore, runStart: string, since: string, cap: number): Promise<JobRow[]> {
  const found = await store.read((tx) => tx.query<JobRow>(FEED_JOBS_SQL, [runStart, since, cap]));
  return found.map((row) => ({ ...row, at: javascriptInstant(row.at) }));
}

/** The line id of the collection row a transition's evidence names, so the
 * two are one event: the store names a provider report's run by its Postgres
 * table (`archive_runs`); its line keeps the id the feed has always given it
 * (`signal_dump_runs:`, the evidence kind's name in the contract). */
const EVIDENCE_LINE: Readonly<Record<string, string>> = {
  signal_runs: "signal_runs",
  archive_runs: "signal_dump_runs",
  mediavine_runs: "mediavine_runs",
};

/** The feed, every source read from this call's store. */
export async function buildWallFeed(store: WorkspaceStore, deps: WallFeedDeps): Promise<WallFeedPayload> {
  const nowIso = deps.now.toISOString();
  const windowStart = feedWindowStart(deps.now, deps.osTimeZone);
  const requested = deps.since && Number.isFinite(Date.parse(deps.since)) ? new Date(deps.since).toISOString() : null;
  const since = requested && requested > windowStart ? requested : windowStart;
  const limit = Math.max(1, Math.min(WALL_FEED_LIMIT, Math.trunc(deps.limit ?? WALL_FEED_LIMIT) || WALL_FEED_LIMIT));
  const runStart = new Date(Date.parse(since) - RUN_START_SLACK_MS).toISOString();
  const cap = FEED_SOURCE_CAP;

  const [
    assetRows,
    fired,
    resolved,
    health,
    signalFailures,
    signalLatest,
    dumps,
    { mediavine, revenue, ledger },
    hygiene,
    research,
    insights,
    pulses,
    annotations,
    configs,
    jobs,
    tasks,
  ] = await Promise.all([
    readSites(store),
    storeRows<FlagRow>(store, FEED_FLAGS_FIRED_SQL, since, cap),
    storeRows<FlagRow>(store, FEED_FLAGS_RESOLVED_SQL, since, cap),
    healthRows(store, since, cap),
    storeRows<RunRow>(store, FEED_SIGNAL_FAILURES_SQL, since, cap),
    storeRows<RunRow>(store, FEED_SIGNAL_LATEST_SQL, since),
    storeRows<DumpRow>(store, FEED_DUMPS_SQL, runStart, since, cap),
    moneyRows(store, since, cap),
    hygieneRows(store, since, cap),
    storeRows<ResearchRow>(store, FEED_RESEARCH_SQL, since, cap),
    storeRows<InsightRow>(store, FEED_INSIGHTS_SQL, since),
    storeRows<PulseRow>(store, FEED_PULSES_SQL, since, cap),
    storeRows<AnnotationRow>(store, FEED_ANNOTATIONS_SQL, since, cap),
    configRows(store, since, cap),
    jobRows(store, runStart, since, cap),
    taskRows(store, since, nowIso, cap),
  ]);

  const sites = new Map<string, Site>(assetRows.map((row) => [row.id, { name: assetDisplayName(row.isOs, row.displayName), isOs: row.isOs === 1 }]));
  const known = (asset: string | null): string | null => (asset && sites.has(asset) ? asset : null);
  const events = new Map<string, FeedEvent>();
  const inWindow = (atMs: number) =>
    Number.isFinite(atMs) && atMs >= Date.parse(since) && atMs <= deps.now.getTime() + 60_000;
  const add = (event: FeedEvent) => {
    if (!inWindow(event.atMs)) return;
    if (!events.has(event.id)) events.set(event.id, event);
  };

  // Alerts that fired, and alerts that resolved.
  for (const row of fired) {
    add({
      id: `flag:${row.id}`,
      atMs: ms(row.at),
      kind: "alert",
      asset: row.asset,
      text: alertWords(row),
      tone: row.severity,
      foldKey: `alert:${row.severity}`,
      many: (n, s) => across(plural(n, "alert"), s),
    });
  }
  for (const row of resolved) {
    add({
      id: `flag-resolved:${row.id}`,
      atMs: ms(row.at),
      kind: "resolved",
      asset: row.asset,
      text: alertWords(row),
      tone: "healthy",
      foldKey: "resolved",
      many: (n, s) => across(`${plural(n, "alert")} resolved`, s),
    });
  }

  // A source's state moving. A failure recorded against a collection row
  // shares that row's id, so the run below never adds a second line for it.
  for (const row of health) {
    const line = EVIDENCE_LINE[row.evidenceSource];
    const id = line ? `${line}:${row.evidenceId}` : `health:${row.eventId}`;
    const label = monitorLabel(row.provider, row.capability);
    const back = row.kind === "recovered";
    add({
      id,
      atMs: ms(row.at),
      kind: back ? "source-back" : "source-failed",
      asset: known(row.asset),
      text: back ? `${label} working again` : `${label}: ${FAILURE_WORDS[row.failureKind ?? ""] ?? "failed"}`,
      tone: back ? "healthy" : "error",
      foldKey: back ? "source-back" : "source-failed",
      many: back ? (n, s) => across(`${plural(n, "source")} back`, s) : (n, s) => across(`${plural(n, "source")} failed`, s),
    });
  }

  // Collections: every failure is an event; successes are one line per
  // provider, its newest run.
  const attempts: Attempt[] = [];
  const failure = (id: string, asset: string, at: string, what: string) =>
    add({
      id,
      atMs: ms(at),
      kind: "source-failed",
      asset,
      text: `${what} failed`,
      tone: "error",
      foldKey: "source-failed",
      many: (n, s) => across(`${plural(n, "source")} failed`, s),
    });
  for (const row of signalFailures) {
    failure(`signal_runs:${row.id}`, row.asset, row.at, `${collector(row.integration)} ${row.integration === "gsc" ? "Search Console" : row.integration === "ga4" ? "Analytics" : "report"}`);
    attempts.push({ id: `signal_runs:${row.id}`, asset: row.asset, provider: collector(row.integration), atMs: ms(row.at), ok: false });
  }
  for (const row of signalLatest) {
    attempts.push({ id: `signal_runs:${row.id}`, asset: row.asset, provider: collector(row.integration), atMs: ms(row.at), ok: true });
  }
  for (const row of dumps) {
    const ok = row.status !== "error";
    if (!ok) failure(`signal_dump_runs:${row.id}`, row.asset, row.at, `${collector(row.integration)} report`);
    attempts.push({ id: `signal_dump_runs:${row.id}`, asset: row.asset, provider: collector(row.integration), atMs: ms(row.at), ok });
  }
  for (const row of mediavine) {
    const ok = row.outcome === "success";
    if (!ok) failure(`mediavine_runs:${row.id}`, row.asset, row.at, "Ad revenue report");
    attempts.push({ id: `mediavine_runs:${row.id}`, asset: row.asset, provider: collector("mediavine"), atMs: ms(row.at), ok });
  }
  for (const row of hygiene) {
    // A check that finds a broken page is an alert of its own; the check
    // itself ran.
    attempts.push({ id: `hygiene_checks:${row.id}`, asset: row.asset, provider: collector("hygiene"), atMs: ms(row.at), ok: true });
  }
  for (const line of collectedLines(attempts.filter((attempt) => attempt.atMs >= Date.parse(since)))) add(line);

  // Revenue reported, per report day across sites.
  const byDay = new Map<string, RevenueRow[]>();
  for (const row of revenue) {
    const list = byDay.get(row.day) ?? [];
    list.push(row);
    byDay.set(row.day, list);
  }
  for (const [day, list] of byDay) {
    const latest = new Map<string, RevenueRow>();
    for (const row of list) {
      const held = latest.get(row.asset);
      if (!held || row.at > held.at) latest.set(row.asset, row);
    }
    const reports = [...latest.values()];
    const newest = list.reduce((a, b) => (b.at > a.at ? b : a));
    const minor = reports.reduce((sum, row) => sum + row.amountMinor, 0);
    add({
      id: `revenue:${day}:${newest.id}`,
      atMs: ms(newest.at),
      kind: "revenue",
      asset: reports.length === 1 ? newest.asset : null,
      text: reports.length === 1 ? `Reported ${usd(minor)} for ${monthDay(day)}` : `${siteCount(reports.length)} reported ${usd(minor)} for ${monthDay(day)}`,
      tone: "revenue",
      count: reports.length,
      foldKey: null,
    });
  }

  // Money booked into the ledger.
  for (const row of ledger) {
    const revenueRow = row.kind === "revenue";
    const family = revenueRow ? (row.family === "ads" ? "ad" : row.family === "subs" ? "subscription" : row.family) : row.family;
    add({
      id: `ledger:${row.id}`,
      atMs: ms(row.at),
      kind: revenueRow ? "revenue" : "cost",
      asset: known(row.asset),
      text: `Booked ${new Intl.NumberFormat("en-US", { style: "currency", currency: row.currency }).format(minorToMajorUnits(row.amountMinor, row.currency))} ${family} ${row.kind} for ${monthName(row.period)}`,
      tone: revenueRow ? "revenue" : "cost",
      foldKey: `ledger:${row.kind}`,
      many: (n, s) => across(`Booked ${plural(n, `${row.kind} entry`, `${row.kind} entries`)}`, s),
    });
  }

  // Spend: paid reports per provider per run, and paid research.
  const paid = dumps
    .filter((row) => row.costUsd > 0)
    .map((row) => ({ id: `cost:signal_dump_runs:${row.id}`, asset: row.asset, provider: collector(row.integration), atMs: ms(row.at), usd: row.costUsd }));
  for (const line of costLines(paid, "report")) add(line);
  const bought = research
    .filter((row) => row.costUsd > 0)
    .map((row) => ({ id: `cost:research_log:${row.id}`, asset: known(row.asset), provider: collector(row.provider), atMs: ms(row.at), usd: row.costUsd }));
  for (const line of costLines(bought, "lookup")) add(line);

  // Insights: refreshes per run, and every finding the newest analysis has
  // that the one before it did not.
  const byAsset = new Map<string, InsightRow[]>();
  for (const row of insights) {
    const list = byAsset.get(row.asset) ?? [];
    list.push(row);
    byAsset.set(row.asset, list);
  }
  const refreshed: { id: string; asset: string; atMs: number }[] = [];
  const findingsOf = (row: InsightRow | undefined): [string | null, string | null][] => {
    if (!row?.findings) return [];
    try {
      const parsed: unknown = JSON.parse(row.findings);
      return Array.isArray(parsed) ? (parsed as [string | null, string | null][]) : [];
    } catch {
      return [];
    }
  };
  for (const [asset, list] of byAsset) {
    const [newest, previous] = [...list].sort((a, b) => b.at.localeCompare(a.at));
    if (!newest || newest.at < since) continue;
    refreshed.push({ id: `insights:${newest.id}`, asset, atMs: ms(newest.at) });
    const before = new Set(findingsOf(previous).map(([key]) => key));
    // The first analysis an asset ever has is a refresh, not a pile of news.
    if (!previous) continue;
    for (const [key, title] of findingsOf(newest)) {
      if (!key || before.has(key)) continue;
      add({
        id: `finding:${newest.id}:${key}`,
        atMs: ms(newest.at),
        kind: "insights",
        label: "New finding",
        asset,
        text: title ?? key,
        tone: "neutral",
        foldKey: "finding",
        many: (n, s) => across(plural(n, "new finding"), s),
      });
    }
  }
  for (const run of runsOf(refreshed)) {
    const top = run[0]!;
    const assets = new Set(run.map((row) => row.asset));
    add({
      id: top.id,
      atMs: top.atMs,
      kind: "insights",
      asset: assets.size === 1 ? top.asset : null,
      text: assets.size === 1 ? "Insights refreshed" : `Insights refreshed for ${siteCount(assets.size)}`,
      tone: "neutral",
      count: run.length,
      foldKey: null,
    });
  }

  // Nightly reports, per night.
  const byNight = new Map<string, PulseRow[]>();
  for (const row of pulses) {
    const list = byNight.get(row.date) ?? [];
    list.push(row);
    byNight.set(row.date, list);
  }
  for (const [night, list] of byNight) {
    const newest = list.reduce((a, b) => (b.at > a.at ? b : a));
    const assets = new Set(list.map((row) => row.asset));
    add({
      id: `report:${night}:${newest.id}`,
      atMs: ms(newest.at),
      kind: "report",
      asset: assets.size === 1 ? newest.asset : null,
      text: assets.size === 1 ? "Nightly report received" : `Nightly reports from ${siteCount(assets.size)}`,
      tone: "neutral",
      count: list.length,
      foldKey: null,
    });
  }

  // Deploys and other recorded changes.
  const osDeploys: AnnotationRow[] = [];
  for (const row of annotations) {
    // The OS's own moves carry one of three fixed notes: a rollback and a
    // failed deploy are each their own line, never folded.
    const osMove = row.kind === "deploy" ? osDeployOutcome(row.note) : null;
    // The OS's successful deploys are maintenance, not the business: all of
    // them in the window are one line below.
    if (row.kind === "deploy" && sites.get(row.asset)?.isOs && (osMove === null || osMove === "deployed")) {
      osDeploys.push(row);
      continue;
    }
    if (osMove) {
      add({
        id: `annotation:${row.id}`,
        atMs: ms(row.at),
        kind: "deployed",
        label: OS_MOVE_LABEL[osMove],
        asset: row.asset,
        text: row.note!,
        tone: osMove === "failed" ? "error" : "neutral",
        foldKey: osMove === "deployed" ? "deployed" : null,
        many: (n, s) => across(plural(n, "deploy"), s),
      });
      continue;
    }
    const deploy = row.kind === "deploy";
    const config = row.kind === "config";
    const ref = row.ref ? row.ref.slice(0, 12) : null;
    const note = row.note?.trim() || null;
    add({
      id: `annotation:${row.id}`,
      atMs: ms(row.at),
      kind: deploy ? "deployed" : config ? "setting-saved" : "change",
      label: deploy || config ? undefined : ANNOTATION_WORDS[row.kind],
      asset: row.asset,
      text: deploy ? deployText(row) : (note ?? ref ?? ANNOTATION_WORDS[row.kind] ?? "Change recorded"),
      tone: "neutral",
      foldKey: deploy ? "deployed" : config ? "setting-saved" : `change:${row.kind}`,
      many: deploy
        ? (n, s) => across(plural(n, "deploy"), s)
        : config
          ? (n, s) => across(`${plural(n, "setting")} saved`, s)
          : (n, s) => across(plural(n, "change"), s),
    });
  }
  // Every successful deploy of the OS since last night is one line, at the
  // newest one's time, with the count. A failed deploy and a rollback stay
  // their own lines above. A site's own deploys keep their lines.
  const osDeploysInWindow = osDeploys
    .filter((row) => inWindow(ms(row.at)))
    .sort((a, b) => ms(b.at) - ms(a.at) || b.id - a.id);
  const newestOsDeploy = osDeploysInWindow[0];
  if (newestOsDeploy) {
    const n = osDeploysInWindow.length;
    add({
      id: `annotation:${newestOsDeploy.id}`,
      atMs: ms(newestOsDeploy.at),
      kind: "deployed",
      asset: newestOsDeploy.asset,
      text: n === 1 ? deployText(newestOsDeploy) : `${n} times since last night`,
      tone: "neutral",
      count: n,
      foldKey: null,
    });
  }

  // Settings saved in the Tower or by a script.
  for (const row of configs) {
    add({
      id: `config:${row.id}`,
      atMs: ms(row.at),
      kind: "setting-saved",
      asset: null,
      text: row.reason?.trim() || `${configWords(row.file)} saved`,
      tone: "neutral",
      foldKey: "setting-saved",
      many: (n) => `${plural(n, "setting")} saved`,
    });
  }

  // Scheduled jobs that came apart.
  for (const row of jobs) {
    const name = jobLabel(row.job);
    add({
      id: `job:${row.id}`,
      atMs: ms(row.at),
      kind: "job-failed",
      asset: null,
      text: `${name} failed`,
      tone: "error",
      foldKey: `job-failed:${row.job}`,
      many: (n) => `${name} failed ${n} times`,
    });
  }

  // Tasks done and tasks filed, once per task whichever snapshots held it.
  for (const row of tasks) {
    if (!row.id || !row.at) continue;
    const done = row.list === "recentlyClosed";
    add({
      id: `${done ? "task" : "task-filed"}:${row.id}`,
      atMs: ms(row.at),
      kind: done ? "task-done" : "task-filed",
      asset: known(row.asset),
      text: row.title?.trim() || row.id,
      tone: done ? "healthy" : "neutral",
      foldKey: null,
    });
  }

  const items = fold([...events.values()], sites).slice(0, limit);
  return { generatedAt: nowIso, since, items, limit };
}

/** `GET /api/wall/feed?since=&limit=` — read-only, so anything else is 405. */
export async function handleWallFeedRequest(
  request: Request,
  url: URL,
  store: WorkspaceStore,
  deps: Omit<WallFeedDeps, "since" | "limit">,
): Promise<Response> {
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
  const limitParam = url.searchParams.get("limit");
  try {
    const payload = await buildWallFeed(store, {
      ...deps,
      since: url.searchParams.get("since"),
      limit: limitParam === null ? null : Number(limitParam),
    });
    return Response.json(payload, { headers: JSON_HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: "wall_feed_failed", message }), { status: 500, headers: JSON_HEADERS });
  }
}
