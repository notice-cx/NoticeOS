/** The ordinary task snapshot input shape, shared by native pollers and the
 * validated Worker writer. These facts grant no workspace authority. */
export const BEADS_HANDOFF_KINDS = ['query', 'finding', 'page', 'alert'] as const;
export type BeadsHandoffKind = (typeof BEADS_HANDOFF_KINDS)[number];

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
  /** The epic this bead hangs off (`bd`'s `parent`). Optional and nullable:
   * un-epiced work is the norm in a young repo, and an older poller sends none
   * at all — both mean "group it in the remainder", never "invent a group". */
  parent?: string | null;
  /** When a parked bead asks to be reconsidered. Only deferred beads have one. */
  deferUntil?: string | null;
  /** When the bead was filed (bead `ro-trai.7`). Optional: an older poller
   * sends none, and the store then keeps no key rather than a guess. */
  createdAt?: string | null;
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
  /** P0+P1 across everything not closed. Cuts across the other four rather than
   * partitioning them, and — like all of these — is computed by the poller from
   * the untruncated `bd` output, because the stored lists cannot support it.
   *
   * OPTIONAL, and absent is stored as absent — never as 0. See the
   * one-generation-skew rule in this module's header. */
  highPriority?: number;
  /** Deliberately parked work (`❄ deferred`). In NONE of the other counts: the
   * read they come from never asks for it. OPTIONAL under the same rule — a
   * poller that did not look must not report "0 parked". */
  deferred?: number;
  /** Beads waiting on the OPERATOR — ready `human`-labelled work plus open
   * `human` gates. A filter over ready plus gates, never another queue count.
   * OPTIONAL. */
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
  /** Open work per `bd` priority band, P0..P4 — the queue's shape rather than
   * its size. OPTIONAL, under the same one-generation-skew rule as
   * `counts.highPriority`: absent is stored absent, and the card draws no
   * distribution instead of drawing a flat one it invented. */
  priorities?: number[] | null;
  /** Epic grouping. OPTIONAL: absent means this poller cannot describe
   * structure, and the board renders its flat lists instead. */
  epics?: BeadsEpicInput[] | null;
  ready: BeadsIssueInput[];
  inProgress: BeadsIssueInput[];
  recentlyClosed: BeadsIssueInput[];
  /** Newest-filed work, newest first — what lets the Wall feed say "New
   * task" (bead `ro-trai.7`). OPTIONAL under the same rule: an older poller
   * sends none and the store keeps no key. */
  recentlyCreated?: BeadsIssueInput[] | null;
  /** Parked work, soonest wake-up first. OPTIONAL under the same rule. */
  deferred?: BeadsIssueInput[] | null;
  /** The operator's inbox for this project, most-blocking first. OPTIONAL. */
  waiting?: BeadsIssueInput[] | null;
  /** Urgent operator asks over the UNTRUNCATED inbox: all human gates plus
   * P0/P1 ready-human beads. Top-level because it describes the inbox list,
   * not another status count. OPTIONAL under the generation-skew rule. */
  waitingUrgent?: number;
  /**
   * SERP-panel triage state. Three-valued on purpose, and the two absences mean
   * different things:
   *   - key ABSENT — this poller did not look (an older generation, or a `bd`
   *     that could not answer). The card draws nothing.
   *   - `null` — it looked and this property has no review bead at all: either
   *     no panel has ever landed for it, or the filer has not run.
   *   - an object — the open review, or the newest closed one.
   * Collapsing the first two would let "we never asked" render as "nothing to
   * triage", which is the exact failure this whole lane exists to end.
   */
  panelReview?: BeadsPanelReviewInput | null;
  /**
   * Work filed from this property's Tower handoffs. OPTIONAL under the
   * one-generation-skew rule, and the two absences differ exactly as everywhere
   * else here: an ABSENT key means the poller never asked the register, while
   * `[]` means it asked and nobody has filed anything. A finding card may only
   * present itself as untouched off the second.
   */
  handoffs?: BeadsHandoffInput[] | null;
}

/**
 * Where this property stands on triaging its last SERP panel (doc 08 §S1b).
 *
 * The runner's filer creates one `panel-review` bead per property per panel day
 * (`scripts/os-up.mjs`); the poller reports the open one, or — when the work is
 * done — the most recently closed one, so a card can say "reviewed" rather than
 * only ever "nothing outstanding", which a property that has never had a panel
 * would say too.
 *
 * `status` is deliberately NOT `bd`'s vocabulary. A review is open or it is
 * closed; whether the reviewer marked it in_progress is a detail of how somebody
 * works, not a fact about whether the panel has been triaged.
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
 * One bead filed from a Tower handoff, joined to the finding that raised it
 * (bead `ro-248`): the task-key chain's second link, read back.
 *
 * The poller reads these off each spoke's `noticeos-handoff` label and keeps the
 * `noticeos_*` metadata that names the origin. `key` is `noticeos_key` byte for
 * byte — the same string the Tower renders a finding under — so the surface
 * matches by key alone, exactly as it already does for `decisions`.
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
