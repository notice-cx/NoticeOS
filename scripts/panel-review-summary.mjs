// Pure panel-review convention; no installation or runtime imports.
import { TASK_METADATA, taskMetadataValue } from "../packages/contract/src/task-metadata.mjs";
import { beadsText, beadsInstant } from "./task-snapshot-values.mjs";
// ─────────────────────────────────────────────────────────────────────────────
// The panel-review convention — one bead per property per collection day.
//
// Doc 08 §S1b buys a live result page for a hand-picked set of head terms once
// a week. Reading it is the whole point, and until now nothing made anybody:
// nom's panel went three weeks unread. So a landing now files a bead in that
// property's OWN tracker, due a week later, and
// docs/playbooks/serp-opportunity-execution.md §"Panel review" says what
// closing it requires.
//
// The panel is the ANCHOR, not the whole scope (ro-540.2). Everything else the
// property collected that week — the 200-row ranked-keywords inventory, the
// link families, the LLM mentions, its own GSC/GA4/Bing exports — lands in the
// same panel dir on the same schedule and had no reader at all: the panel was
// the only collection that could produce a review obligation, so the broad
// inventory that answers "what do we rank for AT ALL" went the same way nom's
// panel did, unread. One landing, one review, the week's whole collection.
//
// AND THE TRIGGER IS THE COLLECTION, NOT THE PANEL (ro-478). Once the scope was
// the week's collection, anchoring on the panel left the trigger narrower than
// the thing it triggers: three properties bought five report families every
// Monday and had no entry in config/serp-panel.json, so they landed nothing
// and owed nothing — the exact
// failure this convention exists to end, just quieter. The filer now reads the
// weekly DataForSEO collection, of which the panel is one family, so a property
// that HAS a panel is unaffected (same day, same identity, same bead) and one
// that does not gets the same obligation with the panel walk left out.
//
// TWO TITLE FORMS, ONE IDENTITY. A review is identified by its metadata —
// `noticeos_panel_asset` + `noticeos_panel_date`, or the `reindex_*` pair a
// review filed before the NoticeOS rename carries (packages/contract/src/
// task-metadata.mts reads both) — so every bead filed before ro-478 still
// dedupes and still renders. Only the
// wording generalizes: a property with a panel keeps "serp panel" so its board
// row reads the same week to week, and one without says "signal collection"
// rather than naming a panel it does not have. The dedupe fallback below reads
// both forms, because the title is what identifies a bead whose metadata `bd`
// did not hand back.
//
// This block is the shared vocabulary. Two lanes speak it and must not drift:
// the poller (runner/task-snapshot.mjs) READS these beads into the board's
// payload, and the filer below WRITES them. The label, the title, and the two metadata keys are a
// contract with the Tower, not a house style — a rename here silently empties a
// card there.
// ─────────────────────────────────────────────────────────────────────────────

/** The label every review bead carries. Both lanes find them by it. */
export const PANEL_REVIEW_LABEL = 'panel-review';
/** Audit tombstone for a bead the filer created from evidence that was later
 * proved incomplete. The bead remains in history, but neither dedupes a future
 * valid collection nor appears on the Wall as work the operator reviewed. */
export const INVALID_PANEL_REVIEW_LABEL = 'invalid-automation';
/** The metadata that says which panel a bead is about. Prefixed with the
 * product's name because these beads live in PROPERTY repos, whose trackers
 * carry other people's conventions too. Written under the NoticeOS names; a
 * review filed before the rename carries `reindex_panel_*`, read as well. */
export const PANEL_REVIEW_ASSET_KEY = TASK_METADATA.panelAsset.name;
export const PANEL_REVIEW_DATE_KEY = TASK_METADATA.panelDate.name;
/** How long the reviewer has. A weekly panel triaged later than this is being
 * read against a result page the next collection has already replaced. */
export const PANEL_REVIEW_DUE_DAYS = 7;
/** Who the audit trail names. Deliberately not a person: nobody chose to file
 * this, a collection landing did. */
export const PANEL_REVIEW_ACTOR = 'os-up-panel-filer';
/** Bound on how many reviews one spoke may report. A weekly panel makes ~52 a
 * year; a repo past this has a different problem than an unread panel. */
export const PANEL_REVIEW_LIMIT = 200;

export const PANEL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Both title forms, one capture. `serp panel` is what every review filed
 * before ro-478 says and what a panel property still gets; `signal collection`
 * is the panel-less form. A reader that knew only one would look at half the
 * portfolio's reviews and conclude none had been filed. */
const PANEL_REVIEW_TITLE_RE = /^Triage the (\d{4}-\d{2}-\d{2}) (?:serp panel|signal collection) for \S/;

/** The bead's title. It carries the collection day in plain sight on purpose: it
 * is what the operator reads on a board row, and it is the fallback the readers
 * below use when `bd` hands back a bead without its metadata.
 *
 * `hasPanel` picks the noun and nothing else — the identity is the metadata pair
 * either way. It defaults to the panel wording so a caller that has forgotten
 * the flag produces the form the portfolio already reads. */
export function panelReviewTitle(asset, panelDate, hasPanel = true) {
  const what = hasPanel ? 'serp panel' : 'signal collection';
  return `Triage the ${panelDate} ${what} for ${asset}`;
}

/**
 * When the review is due, as the YYYY-MM-DD `bd --due` takes.
 *
 * Measured from the PANEL DAY, never from when the filer noticed. A runner that
 * was down for three days and catches up must not hand the reviewer three extra
 * days — the deadline belongs to the data's age, not to ours.
 */
export function panelReviewDueDate(panelDate) {
  if (!PANEL_DATE_RE.test(panelDate)) return null;
  const parsed = Date.parse(`${panelDate}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed + PANEL_REVIEW_DUE_DAYS * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Every review bead one spoke holds, any status.
 *
 * ONE query, used by both lanes: the poller asks it to report triage state, and
 * the filer asks it to decide whether to write. If those two ever asked
 * different questions, the filer could file a duplicate the board would then
 * fail to show.
 */
export function panelReviewListArgs(repoDir) {
  return [
    '-C',
    repoDir,
    'list',
    '--label',
    PANEL_REVIEW_LABEL,
    // Every status INCLUDING closed, which none of the poller's other reads ask
    // for in one call: a property that finished its review this morning and one
    // that has never had a panel both have no OPEN review, and only the closed
    // bead separates them.
    '--status',
    'open,in_progress,blocked,deferred,closed',
    '--json',
    '--limit',
    String(PANEL_REVIEW_LIMIT),
  ];
}

/**
 * Which panel day a review bead is about, or null if it is not one of ours.
 *
 * Metadata first — `noticeos_panel_date` (or `reindex_panel_date` on a review
 * filed before the rename) is the convention's own field. The
 * title is the fallback, because `bd`'s list JSON omits metadata for a bead
 * that carries none, and reading a review a thinner filer wrote is strictly
 * better than deciding it does not exist and filing a duplicate beside it.
 */
export function panelReviewPanelDate(row) {
  const tagged = taskMetadataValue(row?.metadata, 'panelDate');
  if (typeof tagged === 'string' && PANEL_DATE_RE.test(tagged.trim())) return tagged.trim();
  const match = PANEL_REVIEW_TITLE_RE.exec(typeof row?.title === 'string' ? row.title : '');
  return match ? match[1] : null;
}

/** A false automated review stays in the ledger for audit, but leaves both
 * operational readers. Labels are normally an array; the string fallback keeps
 * snapshots from older/thinner `bd` clients safe. */
export function invalidPanelReview(row) {
  const labels = Array.isArray(row?.labels)
    ? row.labels
    : typeof row?.labels === 'string'
      ? row.labels.split(',')
      : [];
  return labels.some((label) => beadsText(label).trim() === INVALID_PANEL_REVIEW_LABEL);
}

/**
 * Has this panel day already been reviewed, or asked about?
 *
 * Open and closed both count. Re-filing against a review somebody has already
 * closed would ask for the same triage twice — and the second ask is the one
 * that teaches an operator to ignore the label.
 */
export function panelReviewAlreadyFiled(rows, panelDate) {
  if (!Array.isArray(rows)) return false;
  return rows.some(
    (row) => !invalidPanelReview(row) && panelReviewPanelDate(row) === panelDate,
  );
}

/**
 * What the board reports for one property: the open review if there is one,
 * else the most recently closed.
 *
 * Falling back to the closed one is the point. "No open review" is true of a
 * property that finished its triage this morning AND of one that has never had
 * a panel, and a card that cannot tell them apart can only ever say nothing.
 *
 * `bd`'s richer statuses collapse to open/closed here: in_progress, blocked and
 * deferred are all ways of not having triaged the panel yet.
 */
export function panelReviewEntry(rows) {
  if (!Array.isArray(rows)) return null;
  const reviews = [];
  for (const row of rows) {
    if (invalidPanelReview(row)) continue;
    const beadId = beadsText(row?.id);
    const panelDate = panelReviewPanelDate(row);
    if (beadId === '' || panelDate === null) continue;
    const closed = beadsText(row?.status) === 'closed';
    reviews.push({
      beadId,
      panelDate,
      dueAt: beadsInstant(row?.due_at),
      status: closed ? 'closed' : 'open',
      closedAt: closed ? beadsInstant(row?.closed_at) : null,
    });
  }
  // Newest panel first in both passes: if a property somehow has two open
  // reviews, the current panel is the one worth surfacing.
  const open = reviews
    .filter((review) => review.status === 'open')
    .sort((a, b) => b.panelDate.localeCompare(a.panelDate));
  if (open.length > 0) return open[0];
  const closed = reviews
    .filter((review) => review.status === 'closed')
    .sort(
      (a, b) =>
        (b.closedAt ?? '').localeCompare(a.closedAt ?? '') ||
        b.panelDate.localeCompare(a.panelDate),
    );
  return closed[0] ?? null;
}
