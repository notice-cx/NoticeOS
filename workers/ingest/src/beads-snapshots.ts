// The beads-snapshot writer — one photograph of what every portfolio repo has
// in flight (db/migrations/0017_beads_snapshots.sql). On Postgres,
// `noticeos.task_snapshots`, since bead ro-ujb9.76.4.3.
//
// The producer is the poller in `scripts/os-up.mjs`, which shells the `bd` CLI
// once a minute against each spoke in `config/beads.json` and POSTs the result.
// The consumers are the Tower's read-only /work board, which reads only the
// newest row, and the Wall's feed, which replays the last day's photographs for
// tasks closed and filed — so an older row keeps only those two lists
// (`supersededPayload`) and leaves after two days.
//
// Two things this validator deliberately does NOT do, both for the same reason
// — a snapshot is a cache of a THIRD-PARTY tracker's state, and a store that
// rejects the portfolio's real shape is worse than one that records it:
//
//   1. It does not check `asset` against the `assets` table. The annotation and
//      revenue lanes do, because those rows are evidence about a property and a
//      typo there corrupts the ledger. A snapshot is coordination state; an
//      asset id that has drifted out of `config/beads.json` should surface on
//      the board as an unrecognized project, not cost the other five projects
//      their snapshot.
//   2. It does not pin `status` to an enum. `bd` ships seven statuses and lets
//      an operator add custom ones (`bd config set status.custom`); encoding
//      that list here would turn a `bd` config change into a 422 on a lane that
//      is only trying to write down what it saw.
//
// What it DOES enforce is shape and size: every field is the right type, the
// lists are bounded, and the strings cannot grow without limit. The payload is
// stored as the JSON the store queries (jsonb), so this is the only thing
// standing between the poller and the column.
//
// THE ONE-GENERATION-SKEW RULE (learned the hard way, 2026-08-01)
//
// A new count field must be OPTIONAL on the way in for at least one release.
// The producer and this route are different processes with different reload
// semantics: the Worker is hot-reloaded by `wrangler dev` the instant the file
// is saved, while the poller is a plain `node scripts/os-up.mjs` that keeps
// running the code it started with until the operator restarts it. So there is
// always a window — minutes or days wide — where a live poller is one
// generation behind a live route.
//
// `counts.highPriority` was added as REQUIRED and that window was immediate:
// every snapshot POST began failing 422 `counts.highPriority must be a whole
// number`, and the /work board went stale while the hub itself was perfectly
// healthy. A validator that rejects the shape its own producer is currently
// sending has stopped protecting the store and started being the outage — which
// is the same lesson as the two exclusions above, arriving from our own side of
// the wire instead of `bd`'s.
//
// Tolerant does NOT mean lossy. An absent count is stored ABSENT, never
// defaulted to 0, because a reader can tell "not measured" from "measured zero"
// only if we never conflate them — and on a property card those two render as
// very different claims. A count that IS sent still has to be valid.

import { BEADS_HANDOFF_KINDS } from '@noticeos/contract/task-snapshot';
import type { BeadsIssueInput, BeadsEpicInput, BeadsCountsInput, BeadsProjectInput, BeadsPanelReviewInput, BeadsHandoffInput, BeadsSnapshotInput, BeadsHandoffKind } from '@noticeos/contract/task-snapshot';
export type { BeadsIssueInput, BeadsEpicInput, BeadsCountsInput, BeadsProjectInput, BeadsPanelReviewInput, BeadsHandoffInput, BeadsSnapshotInput, BeadsHandoffKind } from '@noticeos/contract/task-snapshot';
import { javascriptInstant } from '@noticeos/postgres';
import { rollUpBeadsDay, type BeadsDailyProject } from './beads-daily.js';
import {
  ASSET_ID_MAX,
  FUTURE_SKEW_MS,
  Issues,
  enumValue,
  isoDate,
  nonNegativeInteger,
  optionalString,
  pastInstant,
  requiredString,
} from './routes/validate.js';

/** How much history the table keeps (bead `ro-ujb9.76.16`). A snapshot is a
 * cache of a state that already lives in the hub, so a row is kept only while
 * something reads it. The Tower reads the newest row; the one reader of older
 * rows is the Wall's feed (`FEED_TASKS_SQL`, apps/tower/worker/wall-feed.ts),
 * which replays the photographs from 6 PM the day before, local time
 * (`feedWindowStart`, apps/tower/shared/wall-feed.ts) — at most 31 hours back,
 * a DST change included. Two days covers that with margin. It was seven days
 * until 2026-09-24, when the table held 39.2 MB of photographs nothing read
 * (docs/artifacts/integration-monitoring/capacity-readback-2026-09-24.json);
 * db/migrations/0017's comment records the original seven. */
export const BEADS_SNAPSHOT_RETENTION_DAYS = 2;

/** The farthest back the Wall's feed reads a photograph, in hours: 6 PM the
 * day before, seen just before the next local midnight, is 30 hours, plus a DST
 * hour. A MIRROR of what `feedWindowStart` (apps/tower/shared/wall-feed.ts)
 * computes, which this workerd module cannot import; a test on each side pins
 * the 31 (workers/ingest/test/beads-snapshot.test.ts,
 * apps/tower/test/wall-feed.test.ts). */
export const WALL_FEED_REACH_HOURS = 31;

/**
 * What a photograph keeps once a newer one replaces it: per project, only what
 * is still read from an old row (bead `ro-ujb9.76.16`).
 *
 * - the Wall's feed reads each project's `asset` and its `recentlyClosed` and
 *   `recentlyCreated` lists — an item's `id`, `title` and `closedAt` /
 *   `createdAt` (`FEED_TASKS_SQL`);
 * - the daily rollup's one-time backfill reads `asset`, `ok`, `counts` and each
 *   closed item's `id` and `closedAt` (`readSnapshotProjects`, ./beads-daily).
 *
 * The ready and in-flight queues, epics, deferred and waiting lists, handoffs
 * and panel review are read only from the NEWEST row, which is never compacted
 * — they are most of a photograph's bytes. An unreadable payload is returned as
 * it is: compaction must never turn a damaged row into a plausible one.
 */
export function supersededPayload(payload: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return payload;
  }
  if (!isPlainRecord(parsed) || !Array.isArray(parsed.projects)) return payload;
  const projects = parsed.projects.filter(isPlainRecord).map((project) => {
    const closed = Array.isArray(project.recentlyClosed) ? project.recentlyClosed : [];
    const created = Array.isArray(project.recentlyCreated) ? project.recentlyCreated : undefined;
    return {
      asset: project.asset,
      ok: project.ok,
      counts: project.counts,
      recentlyClosed: closed
        .filter(isPlainRecord)
        .map((item) => ({ id: item.id, title: item.title, closedAt: item.closedAt ?? null })),
      ...(created === undefined
        ? {}
        : {
            recentlyCreated: created
              .filter(isPlainRecord)
              .map((item) => ({ id: item.id, title: item.title, createdAt: item.createdAt ?? null })),
          }),
    };
  });
  return JSON.stringify({ projects });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Six spokes today (config/beads.json). The ceiling is a sanity bound on a
 * malformed body, not a portfolio limit. */
export const BEADS_MAX_PROJECTS = 64;
/** The board shows ~10 ready / ~10 in-flight / ~5 recently closed per project;
 * the poller truncates to those. This is the outer bound on what it may send. */
export const BEADS_MAX_ITEMS = 50;
export const BEADS_ID_MAX = 128;
export const BEADS_TITLE_MAX = 512;
export const BEADS_ASSIGNEE_MAX = 128;
export const BEADS_STATUS_MAX = 64;
export const BEADS_TYPE_MAX = 64;
/** `bd` uses P0–P4; the extra headroom keeps a custom scale from failing the
 * whole write. */
export const BEADS_PRIORITY_MAX = 9;
export const BEADS_ERROR_MAX = 500;
export const BEADS_PREFIX_MAX = 32;









/** How many priority bands a queue-shape array carries (`bd` ships P0–P4). */
export const BEADS_PRIORITY_BANDS = 5;
/** Six epics in this repo today; the ceiling bounds a malformed body. */
export const BEADS_MAX_EPICS = 100;






export const BEADS_PANEL_REVIEW_STATUSES = ['open', 'closed'] as const;




/**
 * The Tower surfaces that file work, as the EMITTER writes them
 * (`apps/tower/src/lib/task-handoff.ts`).
 *
 * WIDER than `decisions.kind`, which is only `query` and `finding`: a page
 * decision and an alert file a bead but keep no operator display state, so they
 * are handoff kinds without being decision kinds.
 *
 * This list was `['query', 'finding']` while the poller already sent `page`
 * (`ro-05hb`), and every snapshot carrying one 422'd — taking the whole
 * portfolio's board down for the sake of one row. Widening it is only half the
 * fix: `parseHandoff` now drops an unrecognized kind's OWN row and stores the
 * rest, because this validator and the poller are different processes on
 * different reload clocks (the one-generation-skew rule above), and for the
 * whole of that window a kind a later Tower invents would otherwise blank the
 * board rather than go unrendered.
 */
export { BEADS_HANDOFF_KINDS } from '@noticeos/contract/task-snapshot';
export const BEADS_HANDOFF_STATUSES = ['open', 'closed'] as const;
/** The outer bound on what one project may send. The poller ranks and truncates
 * to `HANDOFF_LIMIT` (scripts/runner/task-snapshot.mjs) before it gets here; this is the same
 * ceiling every other per-project list already carries, so a runaway producer
 * cannot turn a coordination cache into an unbounded column. */
export const BEADS_MAX_HANDOFFS = BEADS_MAX_ITEMS;
/** A key is a normalized query or a card key. Long enough for a real query,
 * bounded so a malformed body cannot become the payload. */
export const BEADS_KEY_MAX = 512;



export type BeadsSnapshotResult =
  | {
      ok: true;
      capturedAt: string;
      projects: number;
      pruned: number;
      /** The board was the same as the latest row's, whose captured_at was
       * touched instead of inserting a duplicate (ro-3xa). */
      unchanged?: true;
      /** How many calendar days the daily rollup holds after this capture
       * (bead `ro-78qo.23`). */
      historyDays: number;
    }
  | { ok: false; error: 'validation'; issues: { path: string; code: string; message: string }[] };

/** The normalized row body — what actually lands in `payload`. Normalizing
 * rather than storing the caller's object verbatim means an extra key the
 * poller grows tomorrow cannot silently become part of the Tower's contract. */
interface StoredIssue {
  id: string;
  title: string;
  status: string;
  priority: number;
  issueType: string;
  assignee: string | null;
  updatedAt: string | null;
  closedAt: string | null;
  parent: string | null;
  deferUntil: string | null;
  /** Present only when the poller sent it. */
  createdAt?: string;
}

interface StoredEpic {
  id: string;
  title: string;
  status: string;
  priority: number;
  total: number;
  closed: number;
  counts: { open: number; inProgress: number; blocked: number; deferred: number };
  priorities: number[];
}

/** The normalized review. `dueAt` and `closedAt` are always present as keys so
 * a reader never has to tell `undefined` from `null` on a field it renders;
 * `closedAt` is null unless the review is closed. */
interface StoredPanelReview {
  beadId: string;
  panelDate: string;
  dueAt: string | null;
  status: 'open' | 'closed';
  closedAt: string | null;
}

/** The normalized handoff. `closedAt` is always a key so a reader never has to
 * tell `undefined` from `null` on a field it renders; it is null unless the
 * bead is closed. */
interface StoredHandoff {
  kind: BeadsHandoffKind;
  key: string;
  beadId: string;
  status: 'open' | 'closed';
  closedAt: string | null;
}

interface StoredProject {
  asset: string;
  prefix: string;
  ok: boolean;
  error: string | null;
  counts: BeadsCountsInput;
  priorities?: number[];
  epics?: StoredEpic[];
  deferred?: StoredIssue[];
  recentlyCreated?: StoredIssue[];
  waiting?: StoredIssue[];
  waitingUrgent?: number;
  panelReview?: StoredPanelReview | null;
  handoffs?: StoredHandoff[];
  ready: StoredIssue[];
  inProgress: StoredIssue[];
  recentlyClosed: StoredIssue[];
}

function asObjectArray(
  issues: Issues,
  value: unknown,
  path: string,
  maxLength: number,
): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) {
    issues.add(path, 'invalid_type', `${path} must be an array`);
    return null;
  }
  if (value.length > maxLength) {
    issues.add(path, 'too_big', `${path} must hold at most ${maxLength} items`);
    return null;
  }
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < value.length; i++) {
    const entry = value[i];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      issues.add(`${path}.${i}`, 'invalid_type', `${path}.${i} must be an object`);
      return null;
    }
    out.push(entry as Record<string, unknown>);
  }
  return out;
}

/** An ISO instant that may be absent. Unlike `pastInstant` this tolerates a
 * future value: `updated_at` comes from the hub's clock, not ours, and a
 * second of skew must not cost the snapshot. */
function optionalInstant(issues: Issues, value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    issues.add(path, 'invalid_type', `${path} must be an ISO-8601 datetime string`);
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    issues.add(path, 'invalid_format', `${path} must be an ISO-8601 datetime`);
    return null;
  }
  return new Date(parsed).toISOString();
}

function parseIssue(issues: Issues, raw: Record<string, unknown>, path: string): StoredIssue | null {
  const id = requiredString(issues, raw.id, `${path}.id`, BEADS_ID_MAX);
  const title = requiredString(issues, raw.title, `${path}.title`, BEADS_TITLE_MAX);
  const status = requiredString(issues, raw.status, `${path}.status`, BEADS_STATUS_MAX);
  const issueType = requiredString(issues, raw.issueType, `${path}.issueType`, BEADS_TYPE_MAX);
  const priority = nonNegativeInteger(issues, raw.priority, `${path}.priority`, BEADS_PRIORITY_MAX);
  const assignee = optionalString(issues, raw.assignee, `${path}.assignee`, BEADS_ASSIGNEE_MAX);
  const updatedAt = optionalInstant(issues, raw.updatedAt, `${path}.updatedAt`);
  const closedAt = optionalInstant(issues, raw.closedAt, `${path}.closedAt`);
  const parent = optionalString(issues, raw.parent, `${path}.parent`, BEADS_ID_MAX);
  const deferUntil = optionalInstant(issues, raw.deferUntil, `${path}.deferUntil`);
  const createdAt = optionalInstant(issues, raw.createdAt, `${path}.createdAt`);

  if (id === null || title === null || status === null || issueType === null || priority === null) {
    return null;
  }
  return {
    id, title, status, priority, issueType, assignee, updatedAt, closedAt, parent, deferUntil,
    // No key at all from an older poller, so its photographs stay byte-identical.
    ...(createdAt === null ? {} : { createdAt }),
  };
}

function parseIssueList(
  issues: Issues,
  value: unknown,
  path: string,
): StoredIssue[] | null {
  const rows = asObjectArray(issues, value, path, BEADS_MAX_ITEMS);
  if (!rows) return null;
  const out: StoredIssue[] = [];
  for (let i = 0; i < rows.length; i++) {
    const parsed = parseIssue(issues, rows[i]!, `${path}.${i}`);
    if (!parsed) return null;
    out.push(parsed);
  }
  return out;
}

function parseCounts(
  issues: Issues,
  value: unknown,
  path: string,
): BeadsCountsInput | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    issues.add(path, 'invalid_type', `${path} must be an object`);
    return null;
  }
  const raw = value as Record<string, unknown>;
  const open = nonNegativeInteger(issues, raw.open, `${path}.open`);
  const ready = nonNegativeInteger(issues, raw.ready, `${path}.ready`);
  const inProgress = nonNegativeInteger(issues, raw.inProgress, `${path}.inProgress`);
  const blocked = nonNegativeInteger(issues, raw.blocked, `${path}.blocked`);
  const closedRecent = nonNegativeInteger(issues, raw.closedRecent, `${path}.closedRecent`);

  // Absent is tolerated (a poller one generation behind); present-but-wrong is
  // not (a poller that is broken). Those are different failures and only the
  // first one is somebody else's clock.
  const optional = (value: unknown, key: string) =>
    value === undefined || value === null
      ? undefined
      : nonNegativeInteger(issues, value, `${path}.${key}`);
  const highPriority = optional(raw.highPriority, 'highPriority');
  const deferred = optional(raw.deferred, 'deferred');
  const waiting = optional(raw.waiting, 'waiting');

  if (
    open === null ||
    ready === null ||
    inProgress === null ||
    blocked === null ||
    closedRecent === null ||
    highPriority === null ||
    deferred === null ||
    waiting === null
  ) {
    return null;
  }
  // Spread rather than assign: an absent count must leave NO key behind, so a
  // reader sees "this poller did not measure it" instead of a zero it can only
  // read as "nothing is urgent here".
  return {
    open,
    ...(highPriority === undefined ? {} : { highPriority }),
    ready,
    inProgress,
    blocked,
    closedRecent,
    ...(deferred === undefined ? {} : { deferred }),
    ...(waiting === undefined ? {} : { waiting }),
  };
}

/** The queue-shape array, or undefined when this poller does not send one.
 * Exactly `BEADS_PRIORITY_BANDS` whole numbers — a short or long array is a
 * producer bug, not skew, so it is rejected rather than padded into a shape
 * that would render as a confident distribution. */
function parsePriorities(
  issues: Issues,
  value: unknown,
  path: string,
): number[] | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    issues.add(path, 'invalid_type', `${path} must be an array`);
    return null;
  }
  if (value.length !== BEADS_PRIORITY_BANDS) {
    issues.add(
      path,
      'invalid_format',
      `${path} must hold exactly ${BEADS_PRIORITY_BANDS} bands`,
    );
    return null;
  }
  const out: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const band = nonNegativeInteger(issues, value[i], `${path}.${i}`);
    if (band === null) return null;
    out.push(band);
  }
  return out;
}

/** One epic grouping row. Same discipline as everything else here: the shape
 * is enforced, the vocabulary is not — `status` stays whatever `bd` called it. */
function parseEpic(issues: Issues, raw: Record<string, unknown>, path: string): StoredEpic | null {
  const id = requiredString(issues, raw.id, `${path}.id`, BEADS_ID_MAX);
  const title = requiredString(issues, raw.title, `${path}.title`, BEADS_TITLE_MAX);
  const status = requiredString(issues, raw.status, `${path}.status`, BEADS_STATUS_MAX);
  const priority = nonNegativeInteger(issues, raw.priority, `${path}.priority`, BEADS_PRIORITY_MAX);
  const total = nonNegativeInteger(issues, raw.total, `${path}.total`);
  const closed = nonNegativeInteger(issues, raw.closed, `${path}.closed`);
  const priorities = parsePriorities(issues, raw.priorities, `${path}.priorities`);

  const rawCounts = raw.counts;
  if (rawCounts === null || typeof rawCounts !== 'object' || Array.isArray(rawCounts)) {
    issues.add(`${path}.counts`, 'invalid_type', `${path}.counts must be an object`);
    return null;
  }
  const c = rawCounts as Record<string, unknown>;
  const open = nonNegativeInteger(issues, c.open, `${path}.counts.open`);
  const inProgress = nonNegativeInteger(issues, c.inProgress, `${path}.counts.inProgress`);
  const blocked = nonNegativeInteger(issues, c.blocked, `${path}.counts.blocked`);
  const deferred = nonNegativeInteger(issues, c.deferred, `${path}.counts.deferred`);

  if (
    id === null || title === null || status === null || priority === null ||
    total === null || closed === null || open === null || inProgress === null ||
    blocked === null || deferred === null || priorities === null || priorities === undefined
  ) {
    if (priorities === undefined) {
      issues.add(`${path}.priorities`, 'invalid_type', `${path}.priorities is required on an epic`);
    }
    return null;
  }
  return {
    id, title, status, priority, total, closed,
    counts: { open, inProgress, blocked, deferred },
    priorities,
  };
}

function parseEpicList(
  issues: Issues,
  value: unknown,
  path: string,
): StoredEpic[] | null | undefined {
  if (value === undefined || value === null) return undefined;
  const rows = asObjectArray(issues, value, path, BEADS_MAX_EPICS);
  if (!rows) return null;
  const out: StoredEpic[] = [];
  for (let i = 0; i < rows.length; i++) {
    const parsed = parseEpic(issues, rows[i]!, `${path}.${i}`);
    if (!parsed) return null;
    out.push(parsed);
  }
  return out;
}

/**
 * The panel-review state, three-valued.
 *
 * `undefined` = the key was absent (this poller did not look). `null` = it
 * looked and found none. Everything else must be a well-formed review — a
 * malformed one records issues and returns `null`, which never reaches the
 * store because `writeBeadsSnapshot` fails the whole write on any issue. That
 * is deliberate: "the reviewer's state is garbled" must not be stored as "there
 * is nothing to review", which is the more comfortable of the two lies.
 */
function parsePanelReview(
  issues: Issues,
  value: unknown,
  path: string,
): StoredPanelReview | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    issues.add(path, 'invalid_type', `${path} must be an object or null`);
    return null;
  }
  const raw = value as Record<string, unknown>;
  const beadId = requiredString(issues, raw.beadId, `${path}.beadId`, BEADS_ID_MAX);
  const panelDate = isoDate(issues, raw.panelDate, `${path}.panelDate`);
  const status = enumValue(issues, raw.status, `${path}.status`, BEADS_PANEL_REVIEW_STATUSES);
  const dueAt = optionalInstant(issues, raw.dueAt, `${path}.dueAt`);
  const closedAt = optionalInstant(issues, raw.closedAt, `${path}.closedAt`);

  if (beadId === null || panelDate === null || status === null) return null;
  // An open review with a close time is a contradiction, not skew: the producer
  // read both fields off the same bead. Stored as-is it would let a card render
  // "reviewed on the 9th" over work nobody has finished.
  if (status === 'open' && closedAt !== null) {
    issues.add(`${path}.closedAt`, 'custom', `${path}.closedAt must be absent on an open review`);
    return null;
  }
  return { beadId, panelDate, dueAt, status, closedAt };
}

/** One handoff row this validator has no vocabulary for. Held rather than
 * logged on the spot so a snapshot reports its unknown kinds in ONE line
 * instead of one per row — the same discipline the calendar lane's rrule
 * warning follows. */
export interface DroppedHandoff {
  /** The project the row came from, so the line names a repo to go and look in. */
  asset: string;
  kind: string;
  beadId: string;
}

export interface DroppedHandoffEvent {
  event: 'beads_handoff_kind_unknown';
  dropped: DroppedHandoff[];
}

/** The warning line, built apart from the printing so the suite can pin its
 * shape: inside workerd a test cannot see the lane's own console. */
export function droppedHandoffEvent(dropped: DroppedHandoff[]): DroppedHandoffEvent {
  return { event: 'beads_handoff_kind_unknown', dropped };
}

/** What `parseHandoff` returns instead of a row when the kind is one it has
 * never heard of. Distinct from `null`, which still fails the whole write. */
const UNKNOWN_KIND = 'unknown-kind';

/**
 * One handoff bead.
 *
 * `kind` and `status` ARE pinned to enums, unlike every `bd` status elsewhere in
 * this module — because neither is `bd`'s vocabulary. Both are the OS's own:
 * `kind` names the Tower surface that filed it, and `status` is the two-valued
 * collapse the poller performs.
 *
 * The two are NOT handled the same way when they fall outside their list, and
 * the asymmetry is the whole point of `ro-05hb`. An unrecognized `status` is a
 * producer bug — the poller itself computes that field from `bd`'s status, so a
 * third value means the poller is broken and the write should fail loudly. An
 * unrecognized `kind` is the opposite: the emitter is a Tower that ships
 * independently of this Worker, so a kind we do not know is the ordinary sound
 * of a newer surface arriving, and it costs its OWN row rather than the
 * project's whole list. Failing the project there blanks the board for every
 * finding on every property to avoid rendering one marker.
 *
 * A kind that is absent, not a string, or empty still fails: that is not a
 * surface a later Tower invented, it is a row too malformed to name one.
 *
 * An open bead carrying a close time is a contradiction rather than skew (the
 * producer read both off the same row), and stored as-is it would let a card
 * claim work shipped that nobody has finished.
 */
function parseHandoff(
  issues: Issues,
  raw: Record<string, unknown>,
  path: string,
  asset: string,
  dropped: DroppedHandoff[],
): StoredHandoff | null | typeof UNKNOWN_KIND {
  if (
    typeof raw.kind === 'string' &&
    raw.kind !== '' &&
    !(BEADS_HANDOFF_KINDS as readonly string[]).includes(raw.kind)
  ) {
    dropped.push({
      asset,
      kind: raw.kind,
      beadId: typeof raw.beadId === 'string' ? raw.beadId : '',
    });
    return UNKNOWN_KIND;
  }
  const kind = enumValue(issues, raw.kind, `${path}.kind`, BEADS_HANDOFF_KINDS);
  const key = requiredString(issues, raw.key, `${path}.key`, BEADS_KEY_MAX);
  const beadId = requiredString(issues, raw.beadId, `${path}.beadId`, BEADS_ID_MAX);
  const status = enumValue(issues, raw.status, `${path}.status`, BEADS_HANDOFF_STATUSES);
  const closedAt = optionalInstant(issues, raw.closedAt, `${path}.closedAt`);

  if (kind === null || key === null || beadId === null || status === null) return null;
  if (status === 'open' && closedAt !== null) {
    issues.add(`${path}.closedAt`, 'custom', `${path}.closedAt must be absent on an open bead`);
    return null;
  }
  return { kind, key, beadId, status, closedAt };
}

/** The handoff list, or undefined when this poller does not send one. Absent
 * and empty are different facts and both survive: `[]` is stored as `[]`.
 *
 * A row whose kind this Worker does not know is SKIPPED and the list stands.
 * Every other malformation still fails the write, so "one garbled entry stored
 * as nothing was filed" — the comfortable lie — remains impossible. */
function parseHandoffList(
  issues: Issues,
  value: unknown,
  path: string,
  asset: string,
  dropped: DroppedHandoff[],
): StoredHandoff[] | null | undefined {
  if (value === undefined || value === null) return undefined;
  const rows = asObjectArray(issues, value, path, BEADS_MAX_HANDOFFS);
  if (!rows) return null;
  const out: StoredHandoff[] = [];
  for (let i = 0; i < rows.length; i++) {
    const parsed = parseHandoff(issues, rows[i]!, `${path}.${i}`, asset, dropped);
    if (parsed === UNKNOWN_KIND) continue;
    if (!parsed) return null;
    out.push(parsed);
  }
  return out;
}

/** An OPTIONAL issue list — absent stays absent, present must be valid. */
function parseOptionalIssueList(
  issues: Issues,
  value: unknown,
  path: string,
): StoredIssue[] | null | undefined {
  if (value === undefined || value === null) return undefined;
  return parseIssueList(issues, value, path);
}

function parseProject(
  issues: Issues,
  raw: Record<string, unknown>,
  path: string,
  dropped: DroppedHandoff[],
): StoredProject | null {
  const asset = requiredString(issues, raw.asset, `${path}.asset`, ASSET_ID_MAX);
  const prefix = requiredString(issues, raw.prefix, `${path}.prefix`, BEADS_PREFIX_MAX);
  if (typeof raw.ok !== 'boolean') {
    issues.add(`${path}.ok`, 'invalid_type', `${path}.ok must be a boolean`);
    return null;
  }
  const error = optionalString(issues, raw.error, `${path}.error`, BEADS_ERROR_MAX);
  const counts = parseCounts(issues, raw.counts, `${path}.counts`);
  const priorities = parsePriorities(issues, raw.priorities, `${path}.priorities`);
  const epics = parseEpicList(issues, raw.epics, `${path}.epics`);
  const deferred = parseOptionalIssueList(issues, raw.deferred, `${path}.deferred`);
  const recentlyCreated = parseOptionalIssueList(issues, raw.recentlyCreated, `${path}.recentlyCreated`);
  const waitingList = parseOptionalIssueList(issues, raw.waiting, `${path}.waiting`);
  const waitingUrgent =
    raw.waitingUrgent === undefined || raw.waitingUrgent === null
      ? undefined
      : nonNegativeInteger(issues, raw.waitingUrgent, `${path}.waitingUrgent`);
  const panelReview = parsePanelReview(issues, raw.panelReview, `${path}.panelReview`);
  const handoffs = parseHandoffList(
    issues,
    raw.handoffs,
    `${path}.handoffs`,
    // The path is the fallback only when the asset id itself failed to parse —
    // the write is already doomed then, and a dropped row still names something.
    asset ?? path,
    dropped,
  );
  const ready = parseIssueList(issues, raw.ready, `${path}.ready`);
  const inProgress = parseIssueList(issues, raw.inProgress, `${path}.inProgress`);
  const recentlyClosed = parseIssueList(issues, raw.recentlyClosed, `${path}.recentlyClosed`);

  if (
    asset === null ||
    prefix === null ||
    !counts ||
    priorities === null ||
    epics === null ||
    deferred === null ||
    recentlyCreated === null ||
    waitingList === null ||
    waitingUrgent === null ||
    handoffs === null ||
    !ready ||
    !inProgress ||
    !recentlyClosed
  ) {
    return null;
  }
  if (
    waitingUrgent !== undefined &&
    (counts.waiting === undefined || waitingUrgent > counts.waiting)
  ) {
    issues.add(
      `${path}.waitingUrgent`,
      'custom',
      `${path}.waitingUrgent must be no greater than counts.waiting`,
    );
    return null;
  }
  // A failed project must not also claim work. Reporting counts beside an error
  // is how a half-read repo would quietly look healthy on the board.
  if (
    !raw.ok &&
    (ready.length > 0 ||
      inProgress.length > 0 ||
      recentlyClosed.length > 0 ||
      (deferred?.length ?? 0) > 0 ||
      (recentlyCreated?.length ?? 0) > 0 ||
      (waitingList?.length ?? 0) > 0 ||
      (handoffs?.length ?? 0) > 0 ||
      (epics?.length ?? 0) > 0)
  ) {
    issues.add(`${path}.ok`, 'custom', `${path} reported an error but still carried issues`);
    return null;
  }
  if (!raw.ok && error === null) {
    issues.add(`${path}.error`, 'custom', `${path}.error is required when ok is false`);
    return null;
  }
  return {
    asset,
    prefix,
    ok: raw.ok,
    error,
    counts,
    ...(priorities === undefined ? {} : { priorities }),
    ...(epics === undefined ? {} : { epics }),
    ready,
    inProgress,
    recentlyClosed,
    ...(deferred === undefined ? {} : { deferred }),
    ...(recentlyCreated === undefined ? {} : { recentlyCreated }),
    ...(waitingList === undefined ? {} : { waiting: waitingList }),
    ...(waitingUrgent === undefined ? {} : { waitingUrgent }),
    // `null` is a value here, not an absence — see BeadsProjectInput.
    ...(panelReview === undefined ? {} : { panelReview }),
    // Absent leaves no key; `[]` is stored as `[]`, because "asked, nobody has
    // filed anything" is the only measurement that lets a card say untouched.
    ...(handoffs === undefined ? {} : { handoffs }),
  };
}

/**
 * Validate one snapshot and store it, then drop everything older than the
 * retention window.
 *
 * `capturedAt` defaults to now and may be backdated (a poller that queued a
 * tick behind a slow `bd` call still reports when it looked), but not
 * post-dated: a snapshot claiming to be from the future would sit at the top of
 * the board forever and make a dead poller look fresh.
 */
export async function writeBeadsSnapshot(
  env: Pick<IngestEnv, 'STORE'>,
  input: BeadsSnapshotInput,
  nowMs: number = Date.now(),
): Promise<BeadsSnapshotResult> {
  const issues = new Issues();

  const capturedAt =
    input.capturedAt === undefined || input.capturedAt === null
      ? new Date(nowMs).toISOString()
      : pastInstant(issues, input.capturedAt, 'capturedAt', nowMs, FUTURE_SKEW_MS);

  const rawProjects = asObjectArray(issues, input.projects, 'projects', BEADS_MAX_PROJECTS);
  const projects: StoredProject[] = [];
  const dropped: DroppedHandoff[] = [];
  if (rawProjects) {
    for (let i = 0; i < rawProjects.length; i++) {
      const parsed = parseProject(issues, rawProjects[i]!, `projects.${i}`, dropped);
      if (parsed) projects.push(parsed);
    }
  }

  if (!issues.ok || !capturedAt || !rawProjects) {
    return { ok: false, error: 'validation', issues: issues.list };
  }

  // ONE line per snapshot naming every kind this Worker skipped, not one per
  // row: the poller runs once a minute and a Tower a generation ahead would
  // otherwise write the same warning 1,440 times a day. Silence would be worse
  // than noise here — the surface degrades invisibly (a marker that never
  // appears), so this line is the only place the skew is visible before someone
  // notices a badge missing.
  if (dropped.length > 0) {
    console.warn(JSON.stringify(droppedHandoffEvent(dropped)));
  }

  const payload = JSON.stringify({ projects });

  // ONE TRANSACTION, ONE WRITER AT A TIME. A capture reads the newest row and
  // then touches, replaces or compacts it, and unions its day into the rollup:
  // D1 ran such writes one after another, Postgres runs them side by side, so
  // each takes the workspace's snapshot lock first and the next waits for it.
  return env.STORE.write(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('noticeos.task_snapshots:' || $1, 0))`, [tx.workspaceId]);

    // 93.6% of the central store's bytes were byte-identical copies of this
    // payload, written once a minute through every quiet hour (ro-3xa: 127 MB
    // stored, 8 MB distinct). An unchanged board TOUCHES the latest row's
    // captured_at instead of inserting a duplicate: freshness semantics survive
    // (the Tower ages the board off the newest captured_at, and retention prunes
    // by it, so a long-quiet board neither reads stale nor prunes itself away)
    // while the history keeps one row per distinct state, which is what "NOT
    // append-only history, a cache" (db/0017) always meant. The store compares
    // the two as JSON values (jsonb), which the normalized payload makes the
    // same test as comparing its bytes.
    // The same order the Tower's reader uses (apps/tower/worker/beads-snapshot.ts),
    // so "the newest row" means one row on both sides of the wire.
    const [latest] = await tx.query<{ snapshot_id: bigint; captured_at: string; payload: string; same: boolean }>(
      `SELECT snapshot_id, captured_at, payload::text AS payload, payload = $1::jsonb AS same
         FROM noticeos.task_snapshots
        ORDER BY captured_at DESC, snapshot_id DESC
        LIMIT 1`,
      [payload],
    );

    // THE DAY'S ROLLUP RUNS ON EVERY CAPTURE, both branches below and the
    // deduplicated touch included (db/0032, bead `ro-78qo.23`). An unchanged board
    // still moves the day on at midnight, and a rollup that only ran on a CHANGED
    // board would skip a quiet day entirely — which is exactly the day whose flat
    // line is the interesting one.
    const rollup = await rollUpBeadsDay(
      tx,
      projects.map(
        (project): BeadsDailyProject => ({
          asset: project.asset,
          ok: project.ok,
          counts: project.counts,
          recentlyClosed: project.recentlyClosed.map((item) => ({
            id: item.id,
            closedAt: item.closedAt,
          })),
        }),
      ),
      capturedAt,
      nowMs,
    );
    const historyDays = rollup.days;
    const cutoff = new Date(nowMs - BEADS_SNAPSHOT_RETENTION_DAYS * 86_400_000).toISOString();

    if (latest?.same) {
      // Never backwards: a backdated tick that saw the same board says nothing
      // newer than the row already does, and walking the newest row behind an
      // older one would hand the Tower a compacted photograph (below).
      await tx.execute(
        `UPDATE noticeos.task_snapshots SET captured_at = GREATEST(captured_at, $1::timestamptz) WHERE snapshot_id = $2`,
        [capturedAt, latest.snapshot_id],
      );
      // Retention still sweeps on a touch: a board that stays unchanged for days
      // must not exempt its OLDER distinct states from the window.
      const pruned = await tx.execute(
        `DELETE FROM noticeos.task_snapshots WHERE captured_at < $1::timestamptz AND snapshot_id <> $2`,
        [cutoff, latest.snapshot_id],
      );
      return { ok: true, capturedAt, projects: projects.length, pruned, unchanged: true, historyDays } as const;
    }

    // ONLY THE NEWEST ROW KEEPS THE WHOLE PHOTOGRAPH (bead `ro-ujb9.76.16`). The
    // row this capture replaces keeps what the Wall's feed and the daily backfill
    // still read (`supersededPayload`) — at most one compaction per write — and a
    // backdated capture that lands behind the newest row is stored compacted from
    // the start, so the newest row is always whole.
    const isNewest = latest === undefined || capturedAt >= javascriptInstant(latest.captured_at);
    const [inserted] = await tx.query<{ snapshot_id: bigint }>(
      `INSERT INTO noticeos.task_snapshots (workspace_id, captured_at, payload)
       VALUES ($1::uuid, $2::timestamptz, $3::jsonb)
       RETURNING snapshot_id`,
      [tx.workspaceId, capturedAt, isNewest ? payload : supersededPayload(payload)],
    );
    if (!inserted) {
      throw new Error('beads_snapshot_write_failed: insert returned no row');
    }
    if (latest && isNewest) {
      // Left alone when compacting changes nothing (the store compares values).
      await tx.execute(
        `UPDATE noticeos.task_snapshots SET payload = $1::jsonb WHERE snapshot_id = $2 AND payload <> $1::jsonb`,
        [supersededPayload(latest.payload), latest.snapshot_id],
      );
    }

    // Bounded history, enforced on the way in so nothing has to remember to sweep
    // (db/0017). The row just written is excluded explicitly: a heavily backdated
    // snapshot would otherwise be deleted by its own insert, and a write is never
    // reported as successful and then silently undone. So is the newest row when
    // this one landed behind it: the board is never pruned down to a compacted
    // photograph.
    const newestId = isNewest || !latest ? inserted.snapshot_id : latest.snapshot_id;
    const pruned = await tx.execute(
      `DELETE FROM noticeos.task_snapshots WHERE captured_at < $1::timestamptz AND snapshot_id NOT IN ($2, $3)`,
      [cutoff, inserted.snapshot_id, newestId],
    );

    return { ok: true, capturedAt, projects: projects.length, pruned, historyDays } as const;
  });
}
