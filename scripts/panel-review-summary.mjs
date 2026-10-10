// Pure panel-review convention; no installation or runtime imports.
import { TASK_METADATA, taskMetadataValue } from "../packages/contract/src/task-metadata.mjs";
import { beadsText, beadsInstant } from "./task-snapshot-values.mjs";
// The panel-review convention: one task per property per collection day,
// filed in that property's own tracker when its weekly collection lands, due
// a week later. Closing it means every row went through the decision rules
// and every gap was routed to a task or a named no-action rule
// (config/serp-panel.README.md). The trigger is the weekly collection, of
// which the panel is one family, so a property without a panel owes the same
// review with the panel walk left out.
//
// A review is identified by its metadata (`noticeos_panel_asset` +
// `noticeos_panel_date`, or the `reindex_*` pair an older review carries;
// packages/contract/src/task-metadata.mts reads both). Two title forms, one
// identity: a property with a panel says "serp panel", one without says
// "signal collection"; the dedupe fallback reads both, because the title is
// what identifies a task whose metadata `bd` did not hand back.
//
// Shared vocabulary: the poller (runner/task-snapshot.mjs) reads these tasks
// into the board's payload and the filer writes them. The label, the title
// and the two metadata keys are a contract with the Tower; a rename here
// silently empties a card there.

/** The label every review task carries. Both lanes find them by it. */
export const PANEL_REVIEW_LABEL = 'panel-review';
/** Audit tombstone for a task the filer created from evidence that was later
 * proved incomplete. The task remains in history, but neither dedupes a future
 * valid collection nor appears on the Wall as work the operator reviewed. */
export const INVALID_PANEL_REVIEW_LABEL = 'invalid-automation';
/** The metadata that says which panel a task is about. Prefixed with the
 * product's name because these tasks live in property repos, whose trackers
 * carry other conventions too. An older review carries `reindex_panel_*`,
 * read as well. */
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
/** Both title forms, one capture: `serp panel` for a panel property, `signal
 * collection` for the panel-less form. */
const PANEL_REVIEW_TITLE_RE = /^Triage the (\d{4}-\d{2}-\d{2}) (?:serp panel|signal collection) for \S/;

/** The task's title. It carries the collection day because it is the
 * fallback the readers below use when `bd` hands back a task without its
 * metadata. `hasPanel` picks the noun and nothing else. */
export function panelReviewTitle(asset, panelDate, hasPanel = true) {
  const what = hasPanel ? 'serp panel' : 'signal collection';
  return `Triage the ${panelDate} ${what} for ${asset}`;
}

/**
 * When the review is due, as the YYYY-MM-DD `bd --due` takes. Measured from
 * the panel day, never from when the filer noticed: a runner catching up
 * after downtime must not hand the reviewer extra days.
 */
export function panelReviewDueDate(panelDate) {
  if (!PANEL_DATE_RE.test(panelDate)) return null;
  const parsed = Date.parse(`${panelDate}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed + PANEL_REVIEW_DUE_DAYS * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Every review task one spoke holds, any status. One query for both lanes: if
 * the poller and the filer asked different questions, the filer could file a
 * duplicate the board would then fail to show.
 */
export function panelReviewListArgs(repoDir) {
  return [
    '-C',
    repoDir,
    'list',
    '--label',
    PANEL_REVIEW_LABEL,
    // Including closed: a property that finished its review this morning and
    // one that has never had a panel both have no open review, and only the
    // closed task separates them.
    '--status',
    'open,in_progress,blocked,deferred,closed',
    '--json',
    '--limit',
    String(PANEL_REVIEW_LIMIT),
  ];
}

/**
 * Which panel day a review task is about, or null if it is not one of ours.
 * Metadata first; the title is the fallback, because `bd`'s list JSON omits
 * metadata for a task that carries none.
 */
export function panelReviewPanelDate(row) {
  const tagged = taskMetadataValue(row?.metadata, 'panelDate');
  if (typeof tagged === 'string' && PANEL_DATE_RE.test(tagged.trim())) return tagged.trim();
  const match = PANEL_REVIEW_TITLE_RE.exec(typeof row?.title === 'string' ? row.title : '');
  return match ? match[1] : null;
}

/** A false automated review stays in the ledger for audit, but leaves both
 * operational readers. The string fallback keeps snapshots from thinner `bd`
 * clients safe. */
export function invalidPanelReview(row) {
  const labels = Array.isArray(row?.labels)
    ? row.labels
    : typeof row?.labels === 'string'
      ? row.labels.split(',')
      : [];
  return labels.some((label) => beadsText(label).trim() === INVALID_PANEL_REVIEW_LABEL);
}

/**
 * Has this panel day already been reviewed, or asked about? Open and closed
 * both count: re-filing against a closed review would ask for the same triage
 * twice.
 */
export function panelReviewAlreadyFiled(rows, panelDate) {
  if (!Array.isArray(rows)) return false;
  return rows.some(
    (row) => !invalidPanelReview(row) && panelReviewPanelDate(row) === panelDate,
  );
}

/**
 * What the board reports for one property: the open review if there is one,
 * else the most recently closed, so a card can tell a property that finished
 * its triage from one that never had a panel. `bd`'s richer statuses collapse
 * to open/closed: in_progress, blocked and deferred are all not triaged yet.
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
  // Newest panel first in both passes.
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
