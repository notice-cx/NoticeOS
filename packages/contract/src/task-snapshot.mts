import type { TaskChoice, TaskChoices } from './task-choices.mjs';
import type { TaskResolution } from './task-resolution.mjs';

/** The ordinary task snapshot input shape, shared by native pollers and the
 * validated Worker writer. These facts grant no workspace authority. */
export const BEADS_HANDOFF_KINDS = ['query', 'finding', 'page', 'alert'] as const;
export type BeadsHandoffKind = (typeof BEADS_HANDOFF_KINDS)[number];

/** The most closes one project's `closes` carries. A poller whose read held
 * more sends none, so the week counts read as unknown rather than short. */
export const BEADS_CLOSES_MAX = 5000;

/** One bead, flattened to what a board row needs. */
export interface BeadsIssueInput {
  id: string;
  title: string;
  status: string;
  priority: number;
  issueType: string;
  assignee?: string | null;
  updatedAt?: string | null;
  closedAt?: string | null;
  /** The epic this bead hangs off (`bd`'s `parent`). Absent or null means
   * "group it in the remainder", never "invent a group". */
  parent?: string | null;
  /** When a parked bead asks to be reconsidered. Only deferred beads have one. */
  deferUntil?: string | null;
  /** When the bead was filed. Optional: an older poller sends none, and the
   * store then keeps no key rather than a guess. */
  createdAt?: string | null;
  /** Who filed it and the model they named, on `recentlyCreated` rows only.
   * Absent when the task names no filer, and from an older poller. */
  filedBy?: string | null;
  filedModel?: string | null;
  /** The options a person picks from, and the pick once made (task-choices.mts).
   * Absent when the task carries none, and from an older poller. */
  choices?: TaskChoices | null;
  choice?: TaskChoice | null;
  /** How a closed task's close ended, on a close that is not done, and the
   * task a duplicate names (task-resolution.mts). Absent on a done close, an
   * open task, and from an older poller. */
  resolution?: Exclude<TaskResolution, 'done'> | null;
  duplicateOf?: string | null;
}

/** One epic container plus what its children are doing. Entirely optional on
 * the wire: absent means this poller could not describe structure, and the
 * board falls back to flat lists rather than inventing grouping. */
export interface BeadsEpicInput {
  id: string;
  title: string;
  status: string;
  priority: number;
  /** ALL-TIME children, from `bd epic status` — the only honest progress
   * denominator, since the closed list here is a trailing week. */
  total: number;
  closed: number;
  counts: { open: number; inProgress: number; blocked: number; deferred: number };
  priorities: number[];
}

export interface BeadsCountsInput {
  open: number;
  /** P0+P1 across everything not closed. Cuts across the other counts rather
   * than partitioning them; computed by the poller from the untruncated `bd`
   * output. Optional, and absent is stored as absent, never as 0: a poller one
   * generation older than the store did not look, and must not report a zero. */
  highPriority?: number;
  /** Deliberately parked work. In none of the other counts. Optional under
   * the same rule as `highPriority`. */
  deferred?: number;
  /** Beads waiting on the operator — ready `human`-labelled work plus open
   * `human` gates. Optional. */
  waiting?: number;
  ready: number;
  inProgress: number;
  blocked: number;
  closedRecent: number;
}

export interface BeadsProjectInput {
  asset: string;
  prefix: string;
  ok: boolean;
  error?: string | null;
  counts: BeadsCountsInput;
  /** Open work per `bd` priority band, P0..P4. Optional under the same rule as
   * `counts.highPriority`: absent is stored absent, and the card draws no
   * distribution. */
  priorities?: number[] | null;
  /** Epic grouping. Optional: absent means this poller cannot describe
   * structure, and the board renders its flat lists instead. */
  epics?: BeadsEpicInput[] | null;
  ready: BeadsIssueInput[];
  inProgress: BeadsIssueInput[];
  recentlyClosed: BeadsIssueInput[];
  /** Newest-filed work, newest first, each with its filer when known.
   * Optional under the same rule. */
  recentlyCreated?: BeadsIssueInput[] | null;
  /** Parked work, soonest wake-up first. Optional under the same rule. */
  deferred?: BeadsIssueInput[] | null;
  /** The operator's inbox for this project, most-blocking first. Optional. */
  waiting?: BeadsIssueInput[] | null;
  /** Urgent operator asks over the untruncated inbox: all human gates plus
   * P0/P1 ready-human beads. Optional under the same rule. */
  waitingUrgent?: number;
  /**
   * SERP-panel triage state. Three-valued: key absent — this poller did not
   * look, and the card draws nothing; `null` — it looked and this property has
   * no review bead at all; an object — the open review, or the newest closed
   * one. "We never asked" must not render as "nothing to triage".
   */
  panelReview?: BeadsPanelReviewInput | null;
  /**
   * Work filed from this property's Tower handoffs. Optional under the same
   * rule: an absent key means the poller never asked, `[]` means it asked and
   * nobody has filed anything. A finding card may only present itself as
   * untouched off the second.
   */
  handoffs?: BeadsHandoffInput[] | null;
  /** Each worker and the model it named: closes in the closed window and
   * work it holds. Absent when nobody holds or closed work. */
  workers?: BeadsWorkerInput[] | null;
  /** The newest claims, closes and picks, newest first. Absent under the same rule. */
  recentWork?: BeadsWorkEventInput[] | null;
  /** Every close the closed read returned, which reaches further back than
   * `recentlyClosed`'s week so that this calendar week and last are whole:
   * what Done this week and Done last week count. Absent from an older
   * poller, and when the read held more closes than the store keeps. */
  closes?: BeadsClosesInput | null;
}

/** The closes one closed read returned, from the first UTC day it reached. */
export interface BeadsClosesInput {
  /** The read's first UTC day, YYYY-MM-DD. Whether a close on this day itself
   * was returned is the task client's choice, so only later days are whole. */
  since: string;
  items: BeadsCloseInput[];
}

/** One close: when it happened and, when nothing shipped, how it ended. */
export interface BeadsCloseInput {
  at: string;
  resolution?: Exclude<TaskResolution, 'done'> | null;
}

/** One worker and model. A close belongs to the closer NoticeOS recorded, else
 * to whoever held the task. */
export interface BeadsWorkerInput {
  id: string;
  model?: string | null;
  closedRecent: number;
  inProgress: number;
}

/** One claim, close or person's pick, with a close's evidence as the closer
 * gave it and a pick's option and label. */
export interface BeadsWorkEventInput {
  kind: 'claimed' | 'closed' | 'chosen';
  taskId: string;
  title: string;
  by: string;
  model?: string | null;
  at: string;
  evidence?: string | null;
  /** On a pick only. */
  option?: string | null;
  label?: string | null;
  /** On a close that is not done: how it ended. */
  resolution?: Exclude<TaskResolution, 'done'> | null;
}

/**
 * Where this property stands on triaging its last SERP panel. The runner's
 * filer creates one `panel-review` bead per property per panel day; the
 * poller reports the open one, or the most recently closed one, so a card can
 * say "reviewed" rather than only "nothing outstanding". `status` is not
 * `bd`'s vocabulary: a review is open or closed, and in_progress is a detail
 * of how somebody works.
 */
export interface BeadsPanelReviewInput {
  beadId: string;
  /** The panel day being triaged, YYYY-MM-DD — the collection's `report_date`,
   * carried through `noticeos_panel_date` on the bead. */
  panelDate: string;
  /** When the review is due (the convention: seven days after the panel day).
   * Null when `bd` reported none. */
  dueAt?: string | null;
  status: 'open' | 'closed';
  /** Set only on a closed review. */
  closedAt?: string | null;
}

/**
 * One bead filed from a Tower handoff, joined to the finding that raised it.
 * The poller reads these off each spoke's handoff label and keeps the
 * `noticeos_*` metadata that names the origin; `key` is `noticeos_key` byte
 * for byte, so the surface matches by key alone.
 */
export interface BeadsHandoffInput {
  /** Which Tower surface raised it — see `BEADS_HANDOFF_KINDS`. */
  kind: BeadsHandoffKind;
  /** The finding's card key, the normalized query, the page URL, or the flag
   * id. Byte-exact. */
  key: string;
  beadId: string;
  /** `bd`'s richer statuses collapse to two upstream. `closed` means shipped,
   * NOT proven — only a watch-window verdict retires a finding. */
  status: 'open' | 'closed';
  closedAt?: string | null;
}

export interface BeadsSnapshotInput {
  capturedAt?: string | null;
  projects: BeadsProjectInput[];
}
