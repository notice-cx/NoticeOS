// The beads-snapshot writer: one photograph of what every task project has in
// flight, produced by the runner's poller and read by the Tower's board (the
// newest row only) and the Wall's feed (the last day's photographs).
//
// A snapshot is a cache of a third-party tracker's state, so this validator
// enforces shape and size and nothing more: `asset` is not checked against the
// `assets` table (a drifted id should surface as an unrecognized project, not
// cost the other projects their snapshot), and `status` is not pinned to an
// enum (`bd` lets an operator add custom ones). A new count field must be
// optional on the way in for at least one release: the poller keeps running
// the code it started with until restarted, so a validator that rejects what
// its own producer is sending is the outage. Tolerant is not lossy: an absent
// count is stored absent, never defaulted to 0.

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

/** How much history the table keeps. The Tower reads the newest row; the one
 * reader of older rows is the Wall's feed, which reaches at most
 * `WALL_FEED_REACH_HOURS` back. Two days covers that with margin. */
export const BEADS_SNAPSHOT_RETENTION_DAYS = 2;

/** The farthest back the Wall's feed reads a photograph, in hours: 6 PM the day
 * before, seen just before the next local midnight, plus a DST hour. A mirror
 * of `feedWindowStart` (apps/tower/shared/wall-feed.ts), which this workerd
 * module cannot import; a test on each side pins the 31. */
export const WALL_FEED_REACH_HOURS = 31;

/**
 * What a photograph keeps once a newer one replaces it: per project, only what
 * is still read from an old row (the Wall's feed and the daily rollup's
 * backfill). The queues, epics and lists are read only from the newest row,
 * which is never compacted. An unreadable payload is returned as it is:
 * compaction must never turn a damaged row into a plausible one.
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

/** A sanity bound on a malformed body, not a portfolio limit. */
export const BEADS_MAX_PROJECTS = 64;
/** The outer bound on what the poller may send per list. */
export const BEADS_MAX_ITEMS = 50;
export const BEADS_ID_MAX = 128;
export const BEADS_TITLE_MAX = 512;
export const BEADS_ASSIGNEE_MAX = 128;
export const BEADS_STATUS_MAX = 64;
export const BEADS_TYPE_MAX = 64;
/** `bd` uses P0–P4; the headroom keeps a custom scale from failing the write. */
export const BEADS_PRIORITY_MAX = 9;
export const BEADS_ERROR_MAX = 500;
export const BEADS_PREFIX_MAX = 32;
/** How many priority bands a queue-shape array carries (`bd` ships P0–P4). */
export const BEADS_PRIORITY_BANDS = 5;
/** A sanity bound on a malformed body. */
export const BEADS_MAX_EPICS = 100;
export const BEADS_PANEL_REVIEW_STATUSES = ['open', 'closed'] as const;
/**
 * The Tower surfaces that file work, as the emitter writes them
 * (`apps/tower/src/lib/task-handoff.ts`). Wider than `decisions.kind`: a page
 * decision and an alert file a bead but keep no operator display state.
 * `parseHandoff` drops an unrecognized kind's own row and stores the rest,
 * because a kind a later Tower invents must not blank the board.
 */
export { BEADS_HANDOFF_KINDS } from '@noticeos/contract/task-snapshot';
export const BEADS_HANDOFF_STATUSES = ['open', 'closed'] as const;
/** The poller ranks and truncates before it gets here; this is the same ceiling
 * every other per-project list carries. */
export const BEADS_MAX_HANDOFFS = BEADS_MAX_ITEMS;
/** A normalized query or a card key. */
export const BEADS_KEY_MAX = 512;
export type BeadsSnapshotResult =
  | {
      ok: true;
      capturedAt: string;
      projects: number;
      pruned: number;
      /** The board was the same as the latest row's, whose captured_at was
       * touched instead of inserting a duplicate. */
      unchanged?: true;
      /** How many calendar days the daily rollup holds after this capture. */
      historyDays: number;
    }
  | { ok: false; error: 'validation'; issues: { path: string; code: string; message: string }[] };

/** The normalized row body. Normalizing rather than storing the caller's object
 * means an extra key the poller grows tomorrow cannot silently become part of
 * the Tower's contract. */
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
 * a reader never has to tell `undefined` from `null`. */
interface StoredPanelReview {
  beadId: string;
  panelDate: string;
  dueAt: string | null;
  status: 'open' | 'closed';
  closedAt: string | null;
}

/** The normalized handoff. `closedAt` is always a key; null unless closed. */
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

/** An ISO instant that may be absent. Tolerates a future value: `updated_at`
 * comes from the hub's clock, not ours. */
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
  // not (a poller that is broken).
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
  // An absent count must leave no key behind, so a reader sees "not measured"
  // instead of a zero.
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

/** The queue-shape array, or undefined when this poller does not send one. A
 * short or long array is a producer bug, not skew, so it is rejected rather
 * than padded into a confident distribution. */
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

/** One epic grouping row: the shape is enforced, the vocabulary is not. */
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
 * The panel-review state, three-valued: `undefined` means the key was absent
 * (this poller did not look), `null` that it looked and found none. A
 * malformed one records issues and fails the whole write: "the reviewer's
 * state is garbled" must not be stored as "there is nothing to review".
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
  // An open review with a close time is a contradiction, not skew: stored as-is
  // it would let a card render "reviewed" over work nobody has finished.
  if (status === 'open' && closedAt !== null) {
    issues.add(`${path}.closedAt`, 'custom', `${path}.closedAt must be absent on an open review`);
    return null;
  }
  return { beadId, panelDate, dueAt, status, closedAt };
}

/** One handoff row this validator has no vocabulary for. Held so a snapshot
 * reports its unknown kinds in one line instead of one per row. */
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

/** Built apart from the printing so the suite can pin its shape. */
export function droppedHandoffEvent(dropped: DroppedHandoff[]): DroppedHandoffEvent {
  return { event: 'beads_handoff_kind_unknown', dropped };
}

/** What `parseHandoff` returns for a kind it has never heard of. Distinct from
 * `null`, which still fails the whole write. */
const UNKNOWN_KIND = 'unknown-kind';

/**
 * One handoff bead. `kind` and `status` are pinned to enums because both are
 * the OS's own vocabulary, but they fail differently: an unrecognized `status`
 * is a producer bug (the poller computes it) and fails the write; an
 * unrecognized `kind` is the ordinary sound of a newer Tower surface arriving,
 * and costs its own row rather than the project's whole list. A kind that is
 * absent, not a string, or empty still fails. An open bead carrying a close
 * time is a contradiction rather than skew.
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
 * and empty are different facts and both survive. A row whose kind this Worker
 * does not know is skipped; every other malformation still fails the write. */
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
    // The path is the fallback only when the asset id itself failed to parse.
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
  // A failed project must not also claim work, or a half-read repo would
  // quietly look healthy on the board.
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
    // `null` is a value here, not an absence.
    ...(panelReview === undefined ? {} : { panelReview }),
    // Absent leaves no key; `[]` is stored as `[]`, because "asked, nobody has
    // filed anything" is the only measurement that lets a card say untouched.
    ...(handoffs === undefined ? {} : { handoffs }),
  };
}

/**
 * Validate one snapshot and store it, then drop everything older than the
 * retention window. `capturedAt` defaults to now and may be backdated, but not
 * post-dated: a snapshot from the future would sit at the top of the board
 * forever and make a dead poller look fresh.
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

  // One line per snapshot naming every kind this Worker skipped, not one per
  // row: the poller runs once a minute. Silence would be worse than noise: the
  // surface degrades invisibly, and this line is where the skew shows.
  if (dropped.length > 0) {
    console.warn(JSON.stringify(droppedHandoffEvent(dropped)));
  }

  const payload = JSON.stringify({ projects });

  // One transaction, one writer at a time: a capture reads the newest row and
  // then touches, replaces or compacts it, so each takes the workspace's
  // snapshot lock first.
  return env.STORE.write(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('noticeos.task_snapshots:' || $1, 0))`, [tx.workspaceId]);

    // An unchanged board touches the latest row's captured_at instead of
    // inserting a duplicate: the Tower ages the board off the newest
    // captured_at and retention prunes by it, while the history keeps one row
    // per distinct state. The store compares the two as jsonb values. The same
    // order the Tower's reader uses (apps/tower/worker/beads-snapshot.ts).
    const [latest] = await tx.query<{ snapshot_id: bigint; captured_at: string; payload: string; same: boolean }>(
      `SELECT snapshot_id, captured_at, payload::text AS payload, payload = $1::jsonb AS same
         FROM noticeos.task_snapshots
        ORDER BY captured_at DESC, snapshot_id DESC
        LIMIT 1`,
      [payload],
    );

    // The day's rollup runs on every capture, the deduplicated touch included:
    // an unchanged board still moves the day on at midnight, and a quiet day's
    // flat line is the interesting one.
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
      // newer, and walking the newest row behind an older one would hand the
      // Tower a compacted photograph.
      await tx.execute(
        `UPDATE noticeos.task_snapshots SET captured_at = GREATEST(captured_at, $1::timestamptz) WHERE snapshot_id = $2`,
        [capturedAt, latest.snapshot_id],
      );
      // Retention still sweeps on a touch, so a long-unchanged board does not
      // exempt its older distinct states from the window.
      const pruned = await tx.execute(
        `DELETE FROM noticeos.task_snapshots WHERE captured_at < $1::timestamptz AND snapshot_id <> $2`,
        [cutoff, latest.snapshot_id],
      );
      return { ok: true, capturedAt, projects: projects.length, pruned, unchanged: true, historyDays } as const;
    }

    // Only the newest row keeps the whole photograph: the row this capture
    // replaces is compacted (`supersededPayload`), and a backdated capture that
    // lands behind the newest row is stored compacted from the start.
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

    // Bounded history, enforced on the way in. The row just written is excluded
    // explicitly, so a heavily backdated snapshot is not deleted by its own
    // insert; so is the newest row when this one landed behind it.
    const newestId = isNewest || !latest ? inserted.snapshot_id : latest.snapshot_id;
    const pruned = await tx.execute(
      `DELETE FROM noticeos.task_snapshots WHERE captured_at < $1::timestamptz AND snapshot_id NOT IN ($2, $3)`,
      [cutoff, inserted.snapshot_id, newestId],
    );

    return { ok: true, capturedAt, projects: projects.length, pruned, historyDays } as const;
  });
}
