// Pure task snapshot reads and derivation; shared unchanged with the standalone poller.
import { gateReason, gateTitle } from '../packages/contract/src/task-gate.mjs';
import {
  HANDOFF_LABEL as TASK_HANDOFF_LABEL,
  HANDOFF_LABELS,
  TASK_METADATA,
  taskMetadataValue,
} from '../packages/contract/src/task-metadata.mjs';
import { panelReviewEntry, panelReviewListArgs } from "./panel-review-summary.mjs";
import { BEADS_ERROR_MAX, beadsFailure, beadsInstant, beadsText } from "./task-snapshot-values.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// The Tower handoff join (bead `ro-248`, docs/playbooks/task-key-chain.md).
//
// A Tower finding or query decision is handed off as a ready-to-run `bd create`
// (apps/tower/src/lib/task-handoff.ts) that an agent executes in the property's
// own repo. That bead carries `noticeos_*` metadata (`reindex_*` on a bead filed
// before the NoticeOS rename, read the same way) naming the finding it came
// from — which means the register can be asked the question the Tower could not
// answer before: has this finding already been filed as work?
//
// This is the READ side of that grammar, and it is a CONTRACT with the emitter:
// the label and the three metadata keys below are copied from task-handoff.ts,
// and renaming either side silently empties a marker on every finding card.
//
// It is a filtered query per spoke, not a slice of the lists this poller
// already captures, and that is the whole point: those lists are capped heads
// (ten ready, five recently closed), so a bead filed a month ago or closed last
// week falls outside all of them. A join that can only see the head of a queue
// answers "no bead was ever filed" for work that plainly was.
// ─────────────────────────────────────────────────────────────────────────────

/** The label every Tower handoff bead carries — `HANDOFF_SOURCE_LABEL` in
 * apps/tower/src/lib/task-handoff.ts. The lane is one `bd list --label-any`
 * away, which also finds the `reindex-handoff` beads filed before the rename. */
export const HANDOFF_LABEL = TASK_HANDOFF_LABEL;
/** The finding/query identity, byte-exact. Read from METADATA and never from
 * the `key:` label: `bd` splits label values on commas, so a query containing
 * one arrives as two labels, and the label deliberately carries a lossy slug. */
export const HANDOFF_KEY_FIELD = TASK_METADATA.key.name;
/** Which Tower surface raised it. This is wider than `decisions.kind`: page
 * rows file work but carry no mark/dismiss display state. */
export const HANDOFF_KIND_FIELD = TASK_METADATA.kind.name;
/** Which property it was raised for. */
export const HANDOFF_ASSET_FIELD = TASK_METADATA.asset.name;
/** The only four surfaces that emit a handoff — queries, findings, page
 * decisions, and alerts. A bead claiming anything else is not one of ours,
 * whatever label it wears. Kept in step with `BEADS_HANDOFF_KINDS`
 * (workers/ingest/src/beads-snapshots.ts) and the emitter's own list
 * (apps/tower/src/lib/task-handoff.ts); the ingest validator now drops an
 * unrecognized kind's own row rather than the project (`ro-05hb`), so the two
 * lists drifting is a missing marker and no longer a blank board. */
export const HANDOFF_KINDS = ['query', 'finding', 'page', 'alert'];
/**
 * How many filed beads one spoke may REPORT — a rendering bound, not a truth
 * bound, and the same order of magnitude as the other per-project lists (the
 * ingest route's own ceiling is 50 items).
 *
 * The read below is unlimited so the dedupe sees every attempt; the truncation
 * happens after ranking, so what a saturated property loses is its OLDEST
 * SHIPPED work — a finding from last year whose bead closed and was never
 * proven, which is the least useful marker on the page. Open work is never
 * dropped short of fifty simultaneously-open handoffs for one property, which
 * is a planning problem and not a rendering one.
 */
export const HANDOFF_LIMIT = 50;

/**
 * Every handoff bead one spoke holds, any status.
 *
 * Closed beads are asked for in the SAME call, which none of the queue reads
 * do: a finding whose work shipped last month and a finding nobody ever filed
 * both have no open bead, and only the closed one tells them apart — which is
 * exactly the difference between "shipped, not proven" and "untouched".
 *
 * `--limit 0` means unlimited, exactly as the counting reads use it: several
 * beads can carry one key (a refiled finding), and picking which one to show
 * has to happen over all of them rather than over whichever page `bd` returned.
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

/** One bead's handoff metadata, or null when it carries none. `bd list
 * --json` omits the key entirely for a bead with no metadata (verified against
 * bd 1.1.2, 2026-08-03) and returns a parsed object otherwise. */
function handoffMetadata(row) {
  const metadata = row?.metadata;
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : null;
}

/**
 * The spoke's handoff beads, one per rendered query, finding, page, or alert
 * row.
 *
 * `asset` is the SPOKE's asset, and a bead naming a different one is dropped.
 * That is not defensiveness about a typo: finding keys are rule ids
 * (`item-openers`, `gsc-decline-1`) that every property's analyzer emits, so a
 * bead filed in the wrong repo — the one failure the handoff text warns about
 * by name — would otherwise attach to a completely unrelated property's finding
 * that happens to share the key. A bead carrying no handoff asset at all is
 * kept: the repo it was filed in already answers which property it belongs to.
 *
 * One bead per (kind, key), because the marker is a state and not a count. An
 * OPEN bead always wins — work in flight is the live fact — and among closed
 * ones the most recently closed, so a finding refiled after a first attempt
 * reads as the attempt that is actually current.
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
    // No key or an unknown surface: a labelled bead nothing can be joined to.
    // Dropped rather than guessed — a marker on the wrong finding is worse than
    // no marker, because it claims work that is not about it.
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
  // Ranked, then truncated, then sorted. The rank decides WHAT survives a
  // saturated property (see HANDOFF_LIMIT); the final sort makes the payload a
  // function of the hub's state rather than of the order `bd` answered in, so
  // two identical hubs produce two identical snapshots.
  return [...byKey.values()]
    .sort(handoffRank)
    .slice(0, HANDOFF_LIMIT)
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
}

/** Which of two beads for the same finding is the one to show. Negative means
 * `a` wins: open over closed, then the newer close, then the lower id — the
 * last purely so a tie is decided by the data rather than by list order. */
function handoffRank(a, b) {
  return (
    Number(a.status === 'closed') - Number(b.status === 'closed') ||
    (b.closedAt ?? '').localeCompare(a.closedAt ?? '') ||
    a.beadId.localeCompare(b.beadId)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Beads snapshot poller — the hub's state, once a minute, into the central
// store so the Tower can render it (db/postgres/migrations/0001_baseline.sql,
// docs/10 "Work").
//
// The Tower cannot read the hub: it is a Worker, the hub speaks MySQL, and the
// hub is on this Mac. So this process — which can reach both — shells the `bd`
// CLI once per spoke and POSTs what it saw to the ingest worker. `bd` resolves
// its own server-mode connection settings from each repo's `.beads/config.yaml`,
// so the poller never holds hub credentials; it only says WHERE to look (-C).
//
// This is a READ. The poller never creates, closes, or edits a bead — writes
// happen where the work happens, via `bd` in each repo. (The panel-review filer
// and the push-state filer, runner/panel-review.mjs and runner/push-state.mjs,
// are the two deliberate exceptions, and
// each is a separate lane on a separate schedule precisely so this one stays a
// read.)
// ─────────────────────────────────────────────────────────────────────────────

/** How many of each list a project reports. The board shows the head of the
 * queue, not the queue: a project with 200 ready beads is a planning problem,
 * and rendering all 200 would not help anyone see it. */
export const BEADS_READY_LIMIT = 10;
export const BEADS_IN_PROGRESS_LIMIT = 10;
export const BEADS_CLOSED_LIMIT = 5;
/** Newest-filed work a project reports, so the Wall feed can say "New task"
 * the minute one is filed (bead `ro-trai.7`). Capped like the closed list. */
export const BEADS_CREATED_LIMIT = 5;
/** "Recently closed" means closed within this many days — the "what moved?"
 * window, at day grain because `bd --closed-after` takes a date. */
export const BEADS_CLOSED_WINDOW_DAYS = 7;
/** `bd`'s documented default priority, used when a bead carries none. */
const BEADS_DEFAULT_PRIORITY = 2;
/** The `bd` type that is a CONTAINER rather than work. An epic holds other
 * beads; nobody claims one, closes one by doing it, or is blocked by one being
 * open. Counting them inflates every "how much is left?" number by however much
 * structure a repo happens to use — six epics turned the OS project's 33 claimable
 * beads into 39 on 2026-08-01. Filtered here, at the only place that can see
 * the untruncated lists, so no consumer has to re-derive it (a truncated list
 * cannot: `bd ready` returned 39 rows and the stored list keeps 10). */
export const BEADS_CONTAINER_TYPE = 'epic';
/** P0–P1. The urgency question a property card asks, and the one thing about a
 * queue that cannot wait for someone to open the board. */
export const BEADS_HIGH_PRIORITY_MAX = 1;
/** `bd` ships P0–P4, so a queue's shape is five numbers. Sent alongside the
 * scalar counts because "33 open" and "33 open, 5 of them P0" are the same
 * number describing two completely different mornings — and a card that only
 * ever shows the total makes the operator open the board to find that out.
 * Computed here for the same reason every other count is: the lists are
 * truncated to ten downstream, so nothing else can see the whole distribution. */
export const BEADS_PRIORITY_BANDS = 5;
/** `bd`'s own token for deliberately parked work (category `frozen`, glyph ❄).
 * It is deliberately absent from every other read here: none of them ask for
 * it, which is exactly how a deferral used to become a disappearance. */
export const BEADS_DEFERRED_STATUS = 'deferred';

/** The oldest close still worth showing, as the YYYY-MM-DD `bd` expects. */
export function beadsClosedSince(nowMs) {
  return new Date(nowMs - BEADS_CLOSED_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The reads that make one project's snapshot, keyed by what they answer.
 *
 * Why several and not one: `bd list` reports each bead's STORED status, which
 * says nothing about whether its dependencies are done — `bd ready` and
 * `bd blocked` are the blocker-aware questions, and re-deriving them here from
 * dependency ids would be a second implementation of `bd`'s own semantics,
 * drifting the first time it learns a new one. Closed beads are a separate call
 * because they are the only ones the store keeps a time window on.
 *
 * `--limit 0` means unlimited: the counts must be true even though the lists
 * are truncated afterwards.
 *
 * The last two are OPTIONAL (`BEADS_OPTIONAL_READS`): a project whose `bd`
 * cannot answer them still files a snapshot, and the board falls back to its
 * flat lists. They are enhancements to how work is GROUPED and what is visibly
 * parked — not the work itself — so failing a whole project over them would
 * trade a real outage for a missing nicety.
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
    // Epic containers with their ALL-TIME child progress. `bd epic status` is
    // the only source for that denominator: the closed list above is a trailing
    // week, so an epic whose children were finished last month would otherwise
    // read as 0% done.
    epics: ['-C', repoDir, 'epic', 'status', '--json'],
    // The operator label set: beads carrying `human` — a decision, a
    // credential, an admin-console step. This is NOT yet the inbox because it
    // also includes parked, blocked and in-progress rows; summarizeBeadsProject
    // intersects it with this same poll's `ready` result. `bd human list` and
    // `bd list -l human` return the same set (verified 2026-08-02); this one has
    // the documented respond/dismiss verbs the operator ultimately acts with.
    human: ['-C', repoDir, 'human', 'list', '--json'],
    // Open gates. They do NOT carry the `human` label, so the read above cannot
    // see them (verified) — and a human gate is the sharpest form of waiting on
    // the operator, because it holds a bead out of `bd ready` until resolved.
    gates: ['-C', repoDir, 'gate', 'list', '--json'],
    // Deliberately parked work (`❄ deferred`, bd's own `frozen` category).
    // Invisible until now, because every other read asks for open/in-progress/
    // blocked/closed and deferred is none of them — a silent deferral, which
    // doc 05 forbids.
    deferred: ['-C', repoDir, 'list', '--status', 'deferred', '--json', '--limit', '0'],
    // This property's SERP-panel triage state — the same query the filer uses to
    // decide whether to write one (see panelReviewListArgs).
    panelReview: panelReviewListArgs(repoDir),
    // Work filed from this property's Tower handoffs, so a finding card can see
    // its own bead. Its own filtered read for the same reason panelReview has
    // one: the lists above are capped heads, and the bead for a finding is
    // routinely older or longer-closed than any of them reach.
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
    // When the bead was filed: the only field that tells a new task from an
    // old one (bead `ro-trai.7`).
    createdAt: beadsInstant(row?.created_at),
    // The epic this bead belongs to (`bd`'s own `parent`, backed by a
    // parent-child dependency edge). null = un-epiced, which the board groups
    // as the remainder rather than hiding.
    parent: beadsText(row?.parent) || null,
    // When a parked bead asks to be looked at again. Only deferred beads carry
    // one; it is the whole reason a deferral is a decision rather than a
    // disappearance.
    deferUntil: beadsInstant(row?.defer_until),
  };
}

/**
 * The ask inside a gate's description — the one reader the Tower's live task
 * read shares (packages/contract/src/task-gate.mts, bead ro-ujb9.201), so the
 * snapshot and the live board can never title one gate two ways.
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

/** How many epics and parked beads one project may report. Both are bounded for
 * the same reason the work lists are: the board shows the head of a queue, not
 * the queue, and an unbounded payload is a column that grows without a reader. */
export const BEADS_EPIC_LIMIT = 25;
export const BEADS_DEFERRED_LIMIT = 15;
/** The operator inbox is a top-N, not a queue: if there are twelve things
 * waiting on him the answer is not to render twelve. */
export const BEADS_WAITING_LIMIT = 10;
/** `bd gate --help`: only a `human` gate waits on a person. A timer or a
 * GitHub gate resolves itself and is nobody's inbox item. */
export const BEADS_HUMAN_GATE = 'human';

/**
 * One epic's grouping row: the container, plus what its children are doing.
 *
 * `total`/`closed` come from `bd epic status`, which counts ALL children ever —
 * the only honest denominator for progress, since this poller's closed list is
 * a trailing week and an epic finished last month would otherwise read 0%.
 * The status counts and the priority shape come from the live children, so they
 * agree with the lists the board renders beneath.
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
 * Turn one project's four `bd` results into its snapshot entry.
 *
 * Pure: the caller owns spawning, so the tests feed recorded `bd` output. Any
 * non-zero exit, unparseable stdout or invalid issue-list shape fails THIS
 * project only — one missing sibling repo must never cost the other five their
 * snapshot.
 *
 * The ready list keeps `bd`'s own order. It already ranks by blocker-awareness
 * then priority, and re-sorting it here would silently disagree with what an
 * agent running `bd ready` in that repo is told to work on next.
 *
 * Epic-type containers are dropped from every list BEFORE anything is counted
 * or truncated (`BEADS_CONTAINER_TYPE`). This is the only place in the system
 * that can do it: the counts are the only untruncated view of the hub, so a
 * consumer holding the stored payload can no more subtract the epics from a
 * 39-item queue than it can name them.
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
    // These required commands return issue arrays, including [] when empty
    // (verified with bd 1.1.2). Unlike the optional human/gate reads below,
    // literal null is not their empty-list representation. Reject malformed
    // rows too: silently dropping a missing id would undercount the queue.
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
  // Whether we LOOKED, which is not the same as finding none. A project whose
  // `bd` could not answer must not report "0 parked" — that is a measurement
  // nobody took, and the skew rule says absent stays absent.
  const sawDeferred = Array.isArray(parsed.deferred);
  const deferred = sawDeferred ? work(beadsIssues(parsed.deferred)) : [];
  // Same distinction, one level up: a poller that could not run the read sends
  // NO key, and a poller that ran it and found nothing sends `null`. The store
  // keeps both, because "we never asked" must not render as "nothing to
  // triage" — which is the exact silence this whole lane exists to break.
  const sawPanelReview = Array.isArray(parsed.panelReview);
  // Same distinction again, and it is the whole honesty of the finding marker:
  // an ABSENT key means this poller never asked the register, while an empty
  // list means it asked and nobody has filed anything for this property. Only
  // the second one licenses a card to say a finding is untouched.
  const sawHandoffs = Array.isArray(parsed.handoffs);

  // What is waiting on the OPERATOR, from two reads that do not overlap:
  // blocker-aware READY beads that also carry `human`, and open gates of
  // await_type `human`. `bd human list` is only the label source — by itself it
  // also returns deferred, blocked and in-progress rows, which are not actions
  // the operator can take now. `bd ready` is already the hub's authoritative
  // answer to that question, so intersection beats reimplementing blockers,
  // deferrals and status here. A gate stays separate because resolving it is
  // itself the action that releases the bead it holds out of `bd ready`.
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
          // The inbox exists so the operator can act without investigating, and
          // "Gate: human" names the mechanism rather than the ask. Its reason is
          // the ask, so it takes the title slot — which already means "the best
          // label we have for this row" (a blank title falls back to the id).
          return { ...issue, title: gateTitle(issue.title, row?.description) };
        })
        .filter((issue) => issue.id !== '')
    : [];
  const waiting = [...humanGates, ...humanBeads]
    // A gate first, then by priority, then oldest activity first — the ask
    // nobody has touched is the one rotting.
    // A gate first (it is holding work hostage, not merely asking), then by
    // priority, then oldest activity first — the ask nobody has touched is the
    // one rotting. `bd`'s own issue_type already says which is which, so no
    // extra field rides the payload to carry it.
    .sort(
      (a, b) =>
        Number(b.issueType === 'gate') - Number(a.issueType === 'gate') ||
        a.priority - b.priority ||
        (a.updatedAt ?? '').localeCompare(b.updatedAt ?? ''),
    );
  // Gates are urgent regardless of their stored priority because they hold a
  // blocked bead out of `bd ready`. For ordinary human asks the portfolio's
  // existing P0/P1 definition applies. This rides separately from the bounded
  // waiting list so a Wall total can never be re-derived from a truncated head.
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
      // Stored status `open` — not started. `ready` and `blocked` are subsets of
      // it, split by whether anything is in the way, so the three chips answer
      // three different questions rather than partitioning one number.
      open: active.filter((issue) => issue.status === 'open').length,
      // Cuts ACROSS the other four: a P0 can be open, in flight, or blocked.
      // Deliberately not a partition — the question is "how much of this is
      // urgent?", which every status can answer yes to.
      highPriority: active.filter((issue) => issue.priority <= BEADS_HIGH_PRIORITY_MAX).length,
      ready: ready.length,
      inProgress: inProgress.length,
      blocked: blocked.length,
      closedRecent: closed.length,
      // Parked, and therefore in NONE of the counts above: `open` comes from a
      // read that never asks for it, and it stays out of the ready math on
      // purpose. The point of carrying it is that parked is visible, not that
      // parked is counted as active.
      ...(sawDeferred ? { deferred: deferred.length } : {}),
      // Waiting on the operator. Human beads are a FILTER over `ready`, while
      // human gates live outside the work queue. The count is never added to a
      // queue total; its purpose is to move those ready rows into the stronger
      // operator-inbox lane without listing them twice.
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
