// Pure task snapshot reads and derivation; shared unchanged with the standalone poller.
import { gateReason, gateTitle } from '../packages/contract/src/task-gate.mjs';
import { HANDOFF_LABELS, TASK_METADATA, taskMetadataValue } from '../packages/contract/src/task-metadata.mjs';
import { BEADS_HANDOFF_KINDS } from '../packages/contract/src/task-snapshot.mjs';
import { panelReviewEntry, panelReviewListArgs } from "./panel-review-summary.mjs";
import { BEADS_ERROR_MAX, beadsFailure, beadsInstant, beadsText } from "./task-snapshot-values.mjs";

// The Tower handoff join: one key carried from the finding to the task filed
// for it, so the finding can show its task. A handoff (apps/tower/src/lib/
// task-handoff.ts) carries `noticeos_*` metadata (`reindex_*` on older
// tasks, read the same way) naming the finding it came from. The label and
// the three metadata keys below are a contract with that emitter: renaming
// either side silently empties the marker on every finding card. It is a
// filtered query per spoke, not a slice of the capped lists this poller
// captures, because a task filed a month ago falls outside all of them.

/** The label every Tower handoff task carries; `--label-any` also finds the
 * older `reindex-handoff` label. */
export { HANDOFF_LABEL } from '../packages/contract/src/task-metadata.mjs';
/** The finding/query identity, byte-exact. Read from metadata and never from
 * the `key:` label: `bd` splits label values on commas, and the label carries
 * a lossy slug. */
export const HANDOFF_KEY_FIELD = TASK_METADATA.key.name;
/** Which Tower surface raised it. This is wider than `decisions.kind`: page
 * rows file work but carry no mark/dismiss display state. */
export const HANDOFF_KIND_FIELD = TASK_METADATA.kind.name;
/** Which property it was raised for. */
export const HANDOFF_ASSET_FIELD = TASK_METADATA.asset.name;
/** The surfaces that emit a handoff: the contract's list, which the ingest
 * validator reads too. */
export const HANDOFF_KINDS = BEADS_HANDOFF_KINDS;
/**
 * How many filed tasks one spoke may report — a rendering bound, not a truth
 * bound (the ingest route's own ceiling is 50 items). The read is unlimited so
 * the dedupe sees every attempt; truncation happens after ranking, so a
 * saturated property loses its oldest shipped work first.
 */
export const HANDOFF_LIMIT = 50;

/**
 * Every handoff task one spoke holds, any status. Closed tasks are asked for in
 * the same call: only a closed task tells "shipped, not proven" from
 * "untouched". `--limit 0` means unlimited, because several tasks can carry one
 * key (a refiled finding) and the choice has to be made over all of them.
 */
export function handoffListArgs(repoDir) {
  return [
    '-C',
    repoDir,
    'list',
    '--label-any',
    HANDOFF_LABELS.join(','),
    '--status',
    'open,in_progress,blocked,deferred,closed',
    '--json',
    '--limit',
    '0',
  ];
}

/** One task's handoff metadata, or null when it carries none. `bd list --json`
 * omits the key entirely for a task with no metadata. */
function handoffMetadata(row) {
  const metadata = row?.metadata;
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : null;
}

/**
 * The spoke's handoff tasks, one per rendered query, finding, page or alert
 * row. A task naming a different asset than the spoke's is dropped: finding
 * keys are rule ids every property's analyzer emits, so a task filed in the
 * wrong repo would attach to an unrelated property's finding. A task carrying
 * no handoff asset is kept. One task per (kind, key): an open task always
 * wins, then the most recently closed.
 */
export function handoffEntries(rows, asset) {
  if (!Array.isArray(rows)) return [];
  const byKey = new Map();
  for (const row of rows) {
    const beadId = beadsText(row?.id);
    const metadata = handoffMetadata(row);
    if (beadId === '' || metadata === null) continue;
    const key = beadsText(taskMetadataValue(metadata, 'key'));
    const kind = beadsText(taskMetadataValue(metadata, 'kind'));
    // No key or an unknown surface: dropped rather than guessed, because a
    // marker on the wrong finding is worse than no marker.
    if (key === '' || !HANDOFF_KINDS.includes(kind)) continue;
    const owner = beadsText(taskMetadataValue(metadata, 'asset'));
    if (owner !== '' && owner !== asset) continue;
    const closed = beadsText(row?.status) === 'closed';
    const entry = {
      kind,
      key,
      beadId,
      status: closed ? 'closed' : 'open',
      closedAt: closed ? beadsInstant(row?.closed_at) : null,
    };
    const mapKey = `${kind}\0${key}`;
    const held = byKey.get(mapKey);
    if (!held || handoffRank(entry, held) < 0) byKey.set(mapKey, entry);
  }
  // Ranked, then truncated, then sorted: the rank decides what survives a
  // saturated property; the final sort makes the payload a function of the
  // hub's state rather than of the order `bd` answered in.
  return [...byKey.values()]
    .sort(handoffRank)
    .slice(0, HANDOFF_LIMIT)
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
}

/** Which of two tasks for the same finding is the one to show. Negative means
 * `a` wins: open over closed, then the newer close, then the lower id. */
function handoffRank(a, b) {
  return (
    Number(a.status === 'closed') - Number(b.status === 'closed') ||
    (b.closedAt ?? '').localeCompare(a.closedAt ?? '') ||
    a.beadId.localeCompare(b.beadId)
  );
}

// Task snapshot poller — the hub's state, once a minute, into the central
// store so the Tower can render it. The Tower cannot read the hub directly, so
// this process shells the `bd` CLI once per spoke and POSTs what it saw to the
// ingest worker. `bd` resolves its own connection settings from each repo's
// `.beads/config.yaml`, so the poller never holds hub credentials; it only
// says where to look (-C). This is a read: the poller never creates, closes
// or edits a task (runner/panel-review.mjs and runner/push-state.mjs are
// separate lanes that write).

/** How many of each list a project reports: the board shows the head of the
 * queue, not the queue. */
export const BEADS_READY_LIMIT = 10;
export const BEADS_IN_PROGRESS_LIMIT = 10;
export const BEADS_CLOSED_LIMIT = 5;
/** Newest-filed work a project reports, so the Wall feed can say "New task"
 * the minute one is filed. Capped like the closed list. */
export const BEADS_CREATED_LIMIT = 5;
/** "Recently closed" means closed within this many days — the "what moved?"
 * window, at day grain because `bd --closed-after` takes a date. */
export const BEADS_CLOSED_WINDOW_DAYS = 7;
/** `bd`'s documented default priority, used when a bead carries none. */
const BEADS_DEFAULT_PRIORITY = 2;
/** The `bd` type that is a container rather than work. Counting epics inflates
 * every "how much is left?" number, so they are filtered here, at the only
 * place that can see the untruncated lists. */
export const BEADS_CONTAINER_TYPE = 'epic';
/** P0–P1. The urgency question a property card asks, and the one thing about a
 * queue that cannot wait for someone to open the board. */
export const BEADS_HIGH_PRIORITY_MAX = 1;
/** `bd` ships P0–P4, so a queue's shape is five numbers. Computed here because
 * the lists are truncated downstream, so nothing else can see the whole
 * distribution. */
export const BEADS_PRIORITY_BANDS = 5;
/** `bd`'s own token for deliberately parked work (category `frozen`, glyph ❄).
 * No other read here asks for it, so this is the only read that sees it. */
export const BEADS_DEFERRED_STATUS = 'deferred';

/** The oldest close still worth showing, as the YYYY-MM-DD `bd` expects. */
export function beadsClosedSince(nowMs) {
  return new Date(nowMs - BEADS_CLOSED_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The reads that make one project's snapshot, keyed by what they answer.
 * `bd list` reports each task's stored status, which says nothing about its
 * dependencies; `bd ready` and `bd blocked` are the blocker-aware questions,
 * and re-deriving them here would be a second implementation of `bd`'s
 * semantics. `--limit 0` means unlimited: the counts must be true even though
 * the lists are truncated afterwards. The `BEADS_OPTIONAL_READS` may fail
 * without costing the project its snapshot.
 */
export function beadsPollArgs(repoDir, closedSince) {
  return {
    // Everything not closed: the open/in-progress counts and the in-flight list.
    active: ['-C', repoDir, 'list', '--status', 'open,in_progress,blocked', '--json', '--limit', '0'],
    // Blocker-aware claimable work, in bd's own ranking.
    ready: ['-C', repoDir, 'ready', '--json', '--limit', '0'],
    // Open beads whose blockers are still open.
    blocked: ['-C', repoDir, 'blocked', '--json'],
    closed: [
      '-C',
      repoDir,
      'list',
      '--status',
      'closed',
      '--closed-after',
      closedSince,
      '--json',
      '--limit',
      '0',
    ],
    // Epic containers with their all-time child progress: the closed list
    // above is a trailing week, so an epic whose children were finished last
    // month would otherwise read as 0% done.
    epics: ['-C', repoDir, 'epic', 'status', '--json'],
    // Tasks carrying `human`. Not yet the inbox: it also includes parked,
    // blocked and in-progress rows, so summarizeBeadsProject intersects it
    // with this poll's `ready` result.
    human: ['-C', repoDir, 'human', 'list', '--json'],
    // Open gates. They do not carry the `human` label, so the read above
    // cannot see them; a human gate holds a task out of `bd ready` until
    // resolved.
    gates: ['-C', repoDir, 'gate', 'list', '--json'],
    // Deliberately parked work (`❄ deferred`, bd's own `frozen` category),
    // which no other read returns.
    deferred: ['-C', repoDir, 'list', '--status', 'deferred', '--json', '--limit', '0'],
    // This property's SERP-panel triage state — the same query the filer uses to
    // decide whether to write one (see panelReviewListArgs).
    panelReview: panelReviewListArgs(repoDir),
    // Work filed from this property's Tower handoffs, so a finding card can see
    // its own task. Its own read because the lists above are capped heads.
    handoffs: handoffListArgs(repoDir),
  };
}

/** Reads whose failure costs the snapshot nothing but its own enhancement. */
export const BEADS_OPTIONAL_READS = ['epics', 'deferred', 'human', 'gates', 'panelReview', 'handoffs'];

/** One `bd` issue object flattened to what a board row needs. Field names are
 * `bd`'s (snake_case); everything the OS stores is camelCase, and this is the
 * one place the two vocabularies meet. A bead with a blank title falls back to
 * its own id rather than rendering as an empty row. */
function beadsIssue(row) {
  const id = beadsText(row?.id);
  return {
    id,
    title: beadsText(row?.title, id),
    status: beadsText(row?.status, 'open'),
    priority:
      Number.isInteger(row?.priority) && row.priority >= 0 && row.priority <= 9
        ? row.priority
        : BEADS_DEFAULT_PRIORITY,
    issueType: beadsText(row?.issue_type, 'task'),
    assignee: beadsText(row?.assignee) || null,
    updatedAt: beadsInstant(row?.updated_at),
    closedAt: beadsInstant(row?.closed_at),
    // When the task was filed: the only field that tells a new task from an
    // old one.
    createdAt: beadsInstant(row?.created_at),
    // The epic this bead belongs to (`bd`'s own `parent`, backed by a
    // parent-child dependency edge). null = un-epiced, which the board groups
    // as the remainder rather than hiding.
    parent: beadsText(row?.parent) || null,
    // When a parked task asks to be looked at again. Only deferred tasks carry
    // one.
    deferUntil: beadsInstant(row?.defer_until),
  };
}

/**
 * The ask inside a gate's description — the one reader the Tower's live task
 * read shares (packages/contract/src/task-gate.mts), so the snapshot and the
 * live board never title one gate two ways.
 */
export { gateReason as beadsGateReason };

function beadsIssues(parsed) {
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((row) => beadsText(row?.id) !== '').map(beadsIssue);
}

/** A project that could not be read: named, honest, and carrying no work. The
 * board renders this as a degraded line, never as "nothing to do". */
export function beadsProjectError(project, error) {
  return {
    asset: project.asset,
    prefix: project.prefix,
    ok: false,
    error: String(error).slice(0, BEADS_ERROR_MAX),
    counts: { open: 0, highPriority: 0, ready: 0, inProgress: 0, blocked: 0, closedRecent: 0, deferred: 0, waiting: 0 },
    priorities: Array.from({ length: BEADS_PRIORITY_BANDS }, () => 0),
    epics: [],
    ready: [],
    inProgress: [],
    recentlyClosed: [],
    deferred: [],
    waiting: [],
  };
}

/** How many epics and parked tasks one project may report. */
export const BEADS_EPIC_LIMIT = 25;
export const BEADS_DEFERRED_LIMIT = 15;
/** The operator inbox is a top-N, not a queue. */
export const BEADS_WAITING_LIMIT = 10;
/** `bd gate --help`: only a `human` gate waits on a person. A timer or a
 * GitHub gate resolves itself and is nobody's inbox item. */
export const BEADS_HUMAN_GATE = 'human';

/**
 * One epic's grouping row: the container, plus what its children are doing.
 * `total`/`closed` come from `bd epic status`, which counts all children ever;
 * the status counts and the priority shape come from the live children, so
 * they agree with the lists the board renders beneath.
 */
function beadsEpicSummary(entry, childrenByParent) {
  const epic = entry?.epic;
  const id = beadsText(epic?.id);
  if (!id) return null;
  const kids = childrenByParent.get(id) ?? [];
  const priorities = Array.from({ length: BEADS_PRIORITY_BANDS }, () => 0);
  for (const kid of kids) {
    // Parked work is not queued work, so it stays out of the shape exactly as
    // it stays out of every other count.
    if (kid.status === BEADS_DEFERRED_STATUS) continue;
    priorities[Math.min(kid.priority, BEADS_PRIORITY_BANDS - 1)] += 1;
  }
  const byStatus = (status) => kids.filter((kid) => kid.status === status).length;
  return {
    id,
    title: beadsText(epic?.title, id),
    status: beadsText(epic?.status, 'open'),
    priority:
      Number.isInteger(epic?.priority) && epic.priority >= 0 && epic.priority <= 9
        ? epic.priority
        : BEADS_DEFAULT_PRIORITY,
    total: Number.isInteger(entry?.total_children) && entry.total_children >= 0 ? entry.total_children : 0,
    closed: Number.isInteger(entry?.closed_children) && entry.closed_children >= 0 ? entry.closed_children : 0,
    counts: {
      open: byStatus('open'),
      inProgress: byStatus('in_progress'),
      blocked: byStatus('blocked'),
      deferred: byStatus(BEADS_DEFERRED_STATUS),
    },
    priorities,
  };
}

/**
 * Turn one project's `bd` results into its snapshot entry. Pure: the caller
 * owns spawning. Any non-zero exit, unparseable stdout or invalid issue-list
 * shape fails this project only. The ready list keeps `bd`'s own order, which
 * is what an agent running `bd ready` in that repo is told. Epic-type
 * containers are dropped from every list before anything is counted or
 * truncated, the only place that can see the untruncated lists.
 */
/** @returns {import('../packages/contract/src/task-snapshot.mjs').BeadsProjectInput} */
export function summarizeBeadsProject(project, results) {
  const parsed = {};
  for (const key of ['active', 'ready', 'blocked', 'closed']) {
    const result = results?.[key];
    if (!result || result.code !== 0) {
      return beadsProjectError(project, beadsFailure(key, result));
    }
    try {
      parsed[key] = JSON.parse(result.stdout);
    } catch {
      return beadsProjectError(project, `bd ${key} returned unparseable JSON`);
    }
    // These required commands return issue arrays, including [] when empty.
    // Unlike the optional human/gate reads below, literal null is not their
    // empty-list representation. Reject malformed rows too: silently dropping
    // a missing id would undercount the queue.
    if (!Array.isArray(parsed[key]) || !parsed[key].every(
      (row) => row !== null && typeof row === 'object' && !Array.isArray(row) && beadsText(row.id) !== '',
    )) {
      return beadsProjectError(project, `bd ${key} returned invalid issue list JSON (expected an array of issues with non-empty ids)`);
    }
  }
  // The optional reads degrade to nothing rather than costing the project its
  // snapshot: a `bd` too old for `epic status` should give a flat board, not a
  // dark one.
  for (const key of BEADS_OPTIONAL_READS) {
    const result = results?.[key];
    if (!result || result.code !== 0) continue;
    try {
      const value = JSON.parse(result.stdout);
      // bd emits literal null for an empty human/gate list on some versions.
      // Only a successfully parsed, successful command earns this empty list;
      // missing/failed reads and unexpected object shapes remain unknown.
      parsed[key] = (key === 'human' || key === 'gates') && value === null ? [] : value;
    } catch {
      /* absent stays absent */
    }
  }

  const work = (issues) => issues.filter((issue) => issue.issueType !== BEADS_CONTAINER_TYPE);
  const active = work(beadsIssues(parsed.active));
  const ready = work(beadsIssues(parsed.ready));
  const blocked = work(beadsIssues(parsed.blocked));
  const closed = work(beadsIssues(parsed.closed));
  const inProgress = active.filter((issue) => issue.status === 'in_progress');
  // Whether we looked, which is not the same as finding none: a project whose
  // `bd` could not answer must not report "0 parked".
  const sawDeferred = Array.isArray(parsed.deferred);
  const deferred = sawDeferred ? work(beadsIssues(parsed.deferred)) : [];
  // A poller that could not run the read sends no key; one that ran it and
  // found nothing sends `null`. "We never asked" must not render as "nothing
  // to triage".
  const sawPanelReview = Array.isArray(parsed.panelReview);
  // An absent key means this poller never asked the register; an empty list
  // means it asked and nobody has filed anything. Only the second licenses a
  // card to say a finding is untouched.
  const sawHandoffs = Array.isArray(parsed.handoffs);

  // What is waiting on the operator, from two reads that do not overlap:
  // blocker-aware ready tasks that also carry `human`, and open gates of
  // await_type `human`. A gate stays separate because resolving it is itself
  // the action that releases the task it holds out of `bd ready`.
  const sawHuman = Array.isArray(parsed.human);
  const sawGates = Array.isArray(parsed.gates);
  // Either read can preserve known rows, but only BOTH license an exact total.
  // A successful empty human list cannot prove that a failed gate read is empty.
  const sawWaiting = sawHuman || sawGates;
  const completeWaiting = sawHuman && sawGates;
  const humanIds = new Set(
    Array.isArray(parsed.human)
      ? work(beadsIssues(parsed.human)).map((issue) => issue.id)
      : [],
  );
  const humanBeads = Array.isArray(parsed.human)
    ? ready.filter((issue) => issue.status === 'open' && humanIds.has(issue.id))
    : [];
  const humanGates = Array.isArray(parsed.gates)
    ? parsed.gates
        .filter(
          (row) => row?.await_type === BEADS_HUMAN_GATE && beadsText(row?.status) !== 'closed',
        )
        .map((row) => {
          const issue = beadsIssue(row);
          // "Gate: human" names the mechanism rather than the ask; its reason
          // is the ask, so it takes the title slot.
          return { ...issue, title: gateTitle(issue.title, row?.description) };
        })
        .filter((issue) => issue.id !== '')
    : [];
  const waiting = [...humanGates, ...humanBeads]
    // A gate first (it is holding work, not merely asking), then by priority,
    // then oldest activity first — the ask nobody has touched is the one
    // rotting.
    .sort(
      (a, b) =>
        Number(b.issueType === 'gate') - Number(a.issueType === 'gate') ||
        a.priority - b.priority ||
        (a.updatedAt ?? '').localeCompare(b.updatedAt ?? ''),
    );
  // Gates are urgent regardless of their stored priority because they hold a
  // blocked task out of `bd ready`. This rides separately from the bounded
  // waiting list so a Wall total is never re-derived from a truncated head.
  const waitingUrgent =
    humanGates.length +
    humanBeads.filter((issue) => issue.priority <= BEADS_HIGH_PRIORITY_MAX).length;

  // Epic structure, when this `bd` could answer for it. Children come from the
  // live lists (active + deferred) so the grouping always agrees with the rows
  // rendered under it; `bd epic status` supplies only the all-time progress.
  let epics;
  if (Array.isArray(parsed.epics)) {
    const childrenByParent = new Map();
    for (const issue of [...active, ...deferred]) {
      if (!issue.parent) continue;
      const kids = childrenByParent.get(issue.parent) ?? [];
      kids.push(issue);
      childrenByParent.set(issue.parent, kids);
    }
    epics = parsed.epics
      .map((entry) => beadsEpicSummary(entry, childrenByParent))
      .filter((entry) => entry !== null)
      // An epic with nothing live under it and nothing finished is structure
      // nobody has used yet — it would render as an empty card.
      .filter((entry) => entry.total > 0 || entry.counts.open + entry.counts.inProgress + entry.counts.blocked + entry.counts.deferred > 0)
      .slice(0, BEADS_EPIC_LIMIT);
  }

  // The queue's SHAPE, P0..P4. `bd` tolerates priorities above 4, so anything
  // beyond the scale folds into the last band rather than being dropped — an
  // unusual priority is still open work somebody has to do.
  const priorities = Array.from({ length: BEADS_PRIORITY_BANDS }, () => 0);
  for (const issue of active) {
    priorities[Math.min(issue.priority, BEADS_PRIORITY_BANDS - 1)] += 1;
  }

  return {
    asset: project.asset,
    prefix: project.prefix,
    ok: true,
    error: null,
    counts: {
      // Stored status `open` — not started. `ready` and `blocked` are subsets
      // of it, not a partition.
      open: active.filter((issue) => issue.status === 'open').length,
      // Cuts across the other four: a P0 can be open, in flight or blocked.
      highPriority: active.filter((issue) => issue.priority <= BEADS_HIGH_PRIORITY_MAX).length,
      ready: ready.length,
      inProgress: inProgress.length,
      blocked: blocked.length,
      closedRecent: closed.length,
      // Parked, and therefore in none of the counts above: visible, not
      // counted as active.
      ...(sawDeferred ? { deferred: deferred.length } : {}),
      // Waiting on the operator. Human tasks are a filter over `ready`, while
      // human gates live outside the work queue; the count is never added to a
      // queue total.
      ...(completeWaiting ? { waiting: waiting.length } : {}),
    },
    ...(completeWaiting ? { waitingUrgent } : {}),
    priorities,
    ...(epics === undefined ? {} : { epics }),
    ready: ready.slice(0, BEADS_READY_LIMIT),
    inProgress: inProgress.slice(0, BEADS_IN_PROGRESS_LIMIT),
    // Newest close first — the only list where recency, not rank, is the point.
    recentlyClosed: closed
      .slice()
      .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))
      .slice(0, BEADS_CLOSED_LIMIT),
    // Newest filed first, whatever became of it since: a task filed and
    // closed inside a minute was still filed. Gates are asks for approval,
    // not tasks; they reach the operator through `waiting`.
    recentlyCreated: [...new Map([...active, ...deferred, ...closed].map((issue) => [issue.id, issue])).values()]
      .filter((issue) => issue.createdAt !== null && issue.issueType !== 'gate')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, BEADS_CREATED_LIMIT),
    // Soonest wake-up first: a deferral's whole meaning is when it comes back.
    ...(sawDeferred
      ? {
          deferred: deferred
            .slice()
            .sort((a, b) => (a.deferUntil ?? '9999').localeCompare(b.deferUntil ?? '9999'))
            .slice(0, BEADS_DEFERRED_LIMIT),
        }
      : {}),
    ...(sawWaiting ? { waiting: waiting.slice(0, BEADS_WAITING_LIMIT) } : {}),
    ...(sawPanelReview ? { panelReview: panelReviewEntry(parsed.panelReview) } : {}),
    ...(sawHandoffs ? { handoffs: handoffEntries(parsed.handoffs, project.asset) } : {}),
  };
}
