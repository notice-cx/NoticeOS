// The Tower's component index (doc 14). Before adding a component, check this
// list and the /dev/kitchen-sink route, which renders every entry: prefer
// reusing or extending an entry, and when a better component replaces an old
// one, replace the entry rather than adding a second. One or two sentences per
// `purpose` say what the component is for; the component's own file holds the
// rest.
//
// scripts/component-registry.test.mjs keeps this index honest: every `.tsx`
// under components/ has an entry, every entry resolves to a real export, and
// every entry has a demo on the kitchen-sink page (or a listed reason it has no
// face of its own). `demo` records which variants the gallery cannot stage and
// where they are pinned instead.

export interface RegistryEntry {
  name: string;
  file: string;
  purpose: string;
  variants: string[];
  /** Variants the gallery cannot stage, and where they are pinned instead. */
  demo?: string;
}

export const COMPONENT_REGISTRY: RegistryEntry[] = [
  {
    name: "PageAnswer",
    file: "components/surface/PageAnswer.tsx",
    purpose:
      "A screen's one answer, first (D44): one sentence at the display scale, a muted line under it and at most three figures (an eyebrow over a number) beside it. Every index page opens with one.",
    variants: ["sentence only", "with detail", "with figures", "with a verdict mark"],
  },
  {
    name: "FinishLine",
    file: "components/surface/FinishLine.tsx",
    purpose:
      "The end of a list the eye can finish (D44): one line saying the list is done and how old the reading is. On an empty queue it is the whole list, so empty and finished read the same.",
    variants: ["finished", "quiet (empty from the start)", "without an age"],
  },
  {
    name: "HighlightCard",
    file: "components/HighlightCard.tsx",
    purpose:
      "One thing that changed since you last looked (D44, doc 14 § Home): one kind, one sentence, one shape (a line, a line over its normal band, or a display figure) and at most one action. The card's tint is its kind; severity rides the dot and the word.",
    variants: ["alert (big)", "money", "people", "shipped", "win", "milestone (figure)", "bet"],
  },
  {
    name: "DemoViewerStatus",
    file: "components/DemoViewerStatus.tsx",
    purpose:
      "The synthetic read-only installation's identity on the desk and Wall, with the scenario cutoff kept separate from the completed generation's age. Unknown stays unknown and page polling never refreshes it.",
    variants: ["ordinary installation (absent)", "generation time unknown", "completed generation aging"],
  },
  {
    name: "IntegrationHealthPanel",
    file: "components/IntegrationHealthPanel.tsx",
    purpose:
      "Connections grouped by provider, then site, under a strip of four counts (sites failing, overdue, reports missing, sites working). Each provider is one row with its connection status and compact facts; the sites that need the operator sit under it with their status, the reason on the row, and what to do when opened. Without a current read nothing reads fine.",
    variants: ["needs you", "all connections", "provider sites", "failing site opened", "monitoring not confirmed", "counts with history"],
  },
  {
    name: "IntegrationLogo",
    file: "components/IntegrationLogo.tsx",
    purpose: "Locally served, original provider artwork beside a visible name, shared by catalog and setup views. Calendar feeds use CalendarDays and the beads task source the Tasks glyph (ListTodo); unknown or unavailable artwork uses Plug. Vendor colors are identity, never connection status.",
    variants: ["provider logos", "calendar", "fallback", "small", "default", "large"],
  },
  {
    name: "TaskSourceSection / TaskSourceRows / TaskHubUnavailable",
    file: "components/TaskSourceSection.tsx",
    purpose: "Core task database health beside Settings → Task projects (D32, bead ro-ujb9.246.3). TaskSourceRows presents actual snapshot availability and project count without gating Tasks navigation or task actions. TaskHubUnavailable leads an unmapped installation to this existing project manager. TaskProjectSteps retains the host commands after adding a project. Provider credentials stay on Integrations.",
    variants: ["checking", "no projects", "waiting for first read", "available", "partial failure", "stale", "unavailable", "project-management door", "host steps"],
  },
  {
    name: "BrandLockup",
    file: "components/BrandLockup.tsx",
    purpose: "The Notice mark (NoticeMark, drawn in the current ink) and the live NoticeOS wordmark in Stack Sans Notch (D35), shared by desktop navigation, the mobile header and TV. Product identity only; operational states use their own semantic tokens.",
    variants: ["default", "compact", "text"],
  },
  {
    name: "CountdownFace",
    file: "components/TimeFaces.tsx",
    purpose:
      "The countdown as configured, read-only: the face the desk's CountdownWidget wraps with its Configure button and form.",
    variants: ["proximity far/approaching/near/soon/imminent", "reached (gray, off the ramp)"],
  },
  {
    name: "CountdownWidget / CountdownEditor",
    file: "components/DashboardWidgets.tsx",
    purpose:
      "The desk's configurable countdown: CountdownFace plus a Configure button and the countdown's one settings form (emoji, words, moment; one Save, one changeset, D18). CountdownEditor is exported for the Wall editor's widget panel, which renders this same form rather than a second one.",
    variants: ["read-only face", "Configure open (the form)", "no countdown yet (the form makes the first)", "saves paused"],
  },
  {
    name: "WallCanvas",
    file: "components/WallCanvas.tsx",
    purpose:
      "The TV drawn from a WallLayout document (shared/wall-layout, saved at config/tower.json /wall) plus the polled payload: rows top to bottom, each a grid of widgets in the document's widths, the one `fill` row taking the height the others leave, and everything stacking into one column on a portrait tablet or phone. It owns no widget of its own; the five widget types map onto registry components, and `editing` is a render prop the Wall editor uses to preview through the exact component the television draws.",
    variants: ["D28 default", "a pre-D28 save drawn as the default", "rows reordered", "widget removed", "widths and floors from the document", "site filter", "fill row", "editing slot", "column"],
  },
  {
    name: "WallFeed / WallFeedWidget",
    file: "components/wall/WallFeed.tsx",
    purpose:
      "The Wall's live feed column (docs/25 § Feed): stored events from GET /api/wall/feed, newest on top, one line each (a glyph tile toned by kind, the kind and site, one sentence, a clock time), new rows sliding in and old rows dropping to muted ink. WallFeedWidget is the Wall widget polling its own 30-second read.",
    variants: ["live rows (every tone)", "aged rows muted", "reconnecting (last rows kept)", "empty window", "arrival and whole-row fit (component test and journey)"],
  },
  {
    name: "DeltaChip",
    file: "components/DeltaChip.tsx",
    purpose:
      "Trend direction glyph and magnitude, neutral by default, with opt-in green/red intensity for completed like-for-like comparisons; paceTone and paceDirectionLabel colour and name today's comparable-hours pace. A reporting-timezone change withdraws the colour verdict and callers pair the still-visible percentage with TimeZoneCaveat.",
    variants: ["neutral", "positive subtle/clear/strong", "negative subtle/clear/strong", "flat", "verdict withdrawn (window spans a timezone change)", "pace on / a little behind / far behind"],
  },
  {
    name: "TimeZoneCaveat",
    file: "components/TimeZoneCaveat.tsx",
    purpose:
      "The shared warning glyph for a comparison whose window straddles a reporting-timezone change: the figure still shows, the glyph says it is not like-for-like and the title names the change.",
    variants: ["window spans a timezone change", "clean window (renders nothing)"],
  },
  {
    name: "SeverityDot",
    file: "components/SeverityDot.tsx",
    purpose:
      "Health dot: error/warn when attention is open, green when a reporting asset is all-clear, neutral when health is unknown; also renders milestone events.",
    variants: ["error", "warn", "healthy", "info", "unknown", "milestone", "sm/md/lg"],
  },
  {
    name: "PropertyFavicon",
    file: "components/PropertyFavicon.tsx",
    purpose:
      "Neutral asset identity glyph for card and detail headers, loaded from the asset's own favicon with a monogram fallback. It is decoration and aria-hidden: every call site draws it beside a visible name.",
    variants: ["site icon", "failed-image fallback", "card", "detail", "decorative (no accessible name)"],
  },
  {
    name: "AgeBadge",
    file: "components/AgeBadge.tsx",
    purpose:
      "Per-tile data-age badge, amber past 2× lane cadence. Absence is a word that says which absence: 'never' for a lane nothing has ever arrived on, 'unknown' for a timestamp the badge cannot parse; the sibling NoNightlyReport marks an asset that owes no report in the neutral token.",
    variants: [
      "fresh",
      "amber",
      "last-good",
      "never reported",
      "unreadable timestamp",
      "no report owed (NoNightlyReport)",
    ],
  },
  {
    name: "PanelReviewBadge",
    file: "components/PanelReviewBadge.tsx",
    purpose:
      "Whether an asset's newest weekly collection has been triaged, on AgeBadge's chassis: pending, reviewed and overdue told apart by glyph and tone, the visible text always a duration, and nothing at all when there is nothing to review. It reads 'SERP panel' or 'Signal collection' by config/serp-panel.json membership.",
    variants: [
      "reviewed",
      "pending",
      "overdue",
      "stale close (new panel landed)",
      "no panel (signal-collection wording)",
      "nothing to review (renders nothing)",
    ],
  },
  {
    name: "PanelReviewLine",
    file: "components/PanelReviewLine.tsx",
    purpose:
      "The asset page's statement of the obligation PanelReviewBadge marks on the Wall: which panel day is owed, when triage was due and the bead to close. It composes the badge and inherits its absence exactly.",
    variants: [
      "pending",
      "overdue (error-tinted row)",
      "reviewed (no deadline)",
      "stale close (newer panel day named)",
      "dates missing (says less)",
      "no panel (signal-collection label)",
      "nothing to review (renders nothing)",
    ],
  },
  {
    name: "AiOverviewGlyphs",
    file: "components/AiOverviewGlyphs.tsx",
    purpose:
      "The AI-Overview mark for one tracked query, one per surface it was read on: three weights and no colour (solid cites us, outline shown-and-uncited, ghosted read-and-clear), phone then desktop, with `unknownSurface` deciding whether an unread surface holds a blank slot or is omitted. SerpPanelBoard and QueryVisibilityRankings draw this one component.",
    variants: [
      "cited (solid)",
      "uncited (outline)",
      "absent (ghosted)",
      "unknown",
      "phone-vs-desktop pair",
      "one surface read (unprefixed)",
      "unknown holds a blank slot",
      "unknown omitted",
      "panel does not cover the query (renders nothing)",
    ],
  },
  {
    name: "SerpPanelBoard",
    file: "components/SerpPanelBoard.tsx",
    purpose:
      "How the asset's tracked-query SERP panel is doing: six counts lead (tracked, ranking, top 10, top 3, AI Overviews, citations) from the shared serpPanelScoreboard, then one row per term, best rank first, grouped by the bet each term measures where the panel labels them, with the current result-page composition under each term. An unranked query reads `>depth`, unknown stays unknown, and no panel renders nothing.",
    variants: [
      "scoreboard + rows",
      "unranked query (>depth)",
      "unread query (—)",
      "amber partial coverage",
      "pale-yellow settled degradation",
      "unstated depth (no number claimed)",
      "AI Overview never checked",
      "phone-vs-desktop split (glyph pair)",
      "one surface read (single glyph)",
      "surface never checked (blank slot)",
      "current top-three domains per device",
      "one asset slot",
      "second asset slot + URL",
      "page features",
      "composition unread (renders nothing)",
      "labelled clusters (per-cluster line)",
      "mixed panel (trailing unlabelled run)",
      "unlabelled panel (one flat list)",
      "no panel (renders nothing)",
    ],
  },
  {
    name: "BookingChip",
    file: "components/BookingChip.tsx",
    purpose:
      "Which side of the ledger's honesty split a figure came from, booked or forecast, as a StateChip whose fill and tone carry the split. `bookingChipState` maps a raw ledger row's booking_state to the chip's.",
    variants: ["booked", "forecast", "from a raw row's booking_state"],
  },
  {
    name: "HandoffBeadBadge",
    file: "components/HandoffBeadBadge.tsx",
    purpose:
      "Whether a finding has already been filed as work in the asset's own repo, joined by the handoff's `noticeos_key`: the glyph carries open or closed, the visible text is the bead id linking to /tasks/<id>, and both faces stay muted beside the finding's severity. Nothing filed renders nothing.",
    variants: ["open", "closed", "closed undated", "not filed (renders nothing)"],
  },
  {
    name: "PriorityBar",
    file: "components/PriorityBar.tsx",
    purpose:
      "A queue's shape by priority, P0 at the hot end: SegmentBar with the P0..P4 ink-weight ramp as its preset, never an attention hue. priorityFill(band) hands the same ramp's ink to a split of the queue drawn elsewhere.",
    variants: ["mixed priorities", "one hot band in many (minimum width)", "all default priority (calm)"],
  },
  {
    name: "ReportFreshness",
    file: "components/ReportFreshness.tsx",
    purpose:
      "How old a site's nightly report is, one age amber past twice its cadence, or the neutral No report mark when none is expected (D29 amended). Home's assets table reads it in its Reported column.",
    variants: ["fresh", "stale (amber)", "no report expected", "declared none", "without the Updated word"],
  },
  {
    name: "SegmentBar",
    file: "components/SegmentBar.tsx",
    purpose:
      "The one segmented mass bar: how a total divides, as proportion. Named segments carry a token fill class, a non-empty segment never paints below its 3px minimum, and the bar always carries a sentence as its aria-label.",
    variants: ["two-segment share (warn + rest)", "severity split (error + warn)", "priority ramp (via PriorityBar)", "one band in 121 (minimum width)", "empty track"],
  },
  {
    name: "TuneRate",
    file: "components/TuneRate.tsx",
    purpose:
      "How often the operator answered one alert rule by tuning it, over settled flags grouped by rule_id, as a SegmentBar beside its counts and percentage; TuneProposal offers File task or Keep it as it is when the rate crosses the proposal line with enough settled evidence. Settings and the firing alert draw this same component.",
    variants: [
      "a rule the operator keeps quietening (with the proposal)",
      "answered every other way (0%)",
      "tunes still open, outside the rate",
      "fired, nothing settled yet",
      "over the line, too little settled to act on (no proposal)",
      "proposal declined",
      "no firings yet",
      "how many times a rule was tuned",
    ],
  },
  {
    name: "Meter",
    file: "components/Meter.tsx",
    purpose:
      "Token progress bar (spend vs cap); amber over cap. Used by the dormant SYSTEM band and by the register's month-to-date metered data spend against monthly_caps.data_usd.",
    variants: ["under", "near", "over"],
  },
  {
    name: "ProgressRing",
    file: "components/ProgressRing.tsx",
    purpose:
      "The segmented completion ring: n of m discrete things done in a badge-sized footprint, one arc per item with a real gap, monochrome because progress is not severity. The required title carries the whole sentence for the hover and the screen reader; `md` prints the done count in its middle.",
    variants: [
      "sm empty (0 of 4)",
      "sm partial (2 of 4)",
      "sm complete (4 of 4)",
      "md with centre count",
      "many segments (gap shrinks, never inverts)",
      "single segment",
    ],
  },
  {
    name: "EmptyState",
    file: "components/EmptyState.tsx",
    purpose: "Designed empty tile (never blank, never a spinner). `sm` is a list's own empty value under its heading — CollectionEditor's \"None yet\" (bead ro-ujb9.96.6.22) — at the heading's size, never louder than the heading it answers.",
    variants: ["title", "title+hint", "sm (a list's empty value)"],
  },
  {
    name: "ReadFailed",
    file: "components/ReadFailed.tsx",
    purpose:
      "A page whose first data read failed: the error dot, what could not be loaded in the page's own noun, why as a fact (the HTTP status, or 'No answer') and Try again. `desk` sits where the page's first answer would; `wall` is the whole TV in its true black.",
    variants: ["desk · HTTP status", "desk · no answer, with a detail (the asset page's id)", "desk · retrying", "Wall (true black)"],
  },
  {
    name: "RouteLoading / RouteLoadFailure",
    file: "components/RouteLoading.tsx",
    purpose:
      "What stands in for a screen while its code is fetched, and what a screen whose code can no longer be fetched becomes. RouteLoading says only 'Loading' in the space the screen will take (the desk column, the Wall, an asset tab's panel, or nothing for the palette); RouteLoadFailure offers an explicit Open app in new tab action and never reloads by itself (D41).",
    variants: [
      "desk loading",
      "Wall loading (true black)",
      "desk failure with explicit new-tab action",
      "Wall failure with explicit new-tab action",
      "asset tab loading (panel)",
      "asset tab failure with explicit new-tab action (panel)",
      "palette failure with explicit new-tab action",
    ],
  },
  {
    name: "DataSourceIcons",
    file: "components/DataSourceIcons.tsx",
    purpose:
      "Each source's one status as a row of marks on the asset header and Home's asset table, in IntegrationStateChip's tone and word, with one shared InfoTooltip opening every source state and its recorded evidence.",
    variants: [
      "working",
      "failing",
      "overdue",
      "collecting",
      "unknown",
      "not connected",
      "not using",
      "not applicable",
    ],
  },
  {
    name: "ScheduledLanesSummary / ScheduledLanesPanel",
    file: "components/ScheduledLanes.tsx",
    purpose:
      "Read-only scheduler health from the job-run record. The compact summary escalates failed, skipped, globally silent, and never-observed records without listing fifteen lanes on the Wall; asset #0's detail page renders every latest firing as a human-labelled visual matrix with outcome and age.",
    variants: ["healthy", "latest skipped", "latest failed", "scheduler silent", "not yet recorded", "full lane matrix"],
  },
  {
    name: "WorkflowStateLabel / WorkflowActivity / WorkflowStages / WorkflowScheduleTimeline / WorkflowStepOutputView",
    file: "components/WorkflowVisuals.tsx",
    purpose: "Observed workflow execution vocabulary, hourly history, dependency-stage inspector and upcoming schedule density. The annotation Timeline and asset lifecycle Stepper do not represent execution attempts, parallel work or schedule forecasts. Green requires a recorded successful execution; failures are red; skipped, paused and unknown states keep distinct labels/glyphs. Stage layout follows declared dependencies and selection reveals actual attempt evidence. Legacy runs never acquire invented stage success. All chart details support hover, focus and tap through InfoTooltip.",
    variants: ["succeeded", "failed", "running", "skipped", "paused", "never", "unknown", "waiting", "hourly history", "parallel stages", "legacy run", "upcoming schedule", "visual output", "missing output", "pending output"],
  },
  {
    name: "ExecutiveInsightRow",
    file: "components/ExecutiveInsightRow.tsx",
    purpose:
      "ADHD-focused saved-finding accordion. Its compact face keeps kind, rank, title, magnitude, original analysis confidence, applicability review and recorded task state visible. The expanded row exposes the original suggestion, exact evidence and handoff controls. Copied and filed briefs retain the same recheck caveat; closure, marking and collection never imply a verified outcome.",
    variants: ["compact", "focused open", "warning/error", "recommendation/warn", "discovery/info", "insight/neutral", "marked", "dismissed", "filed (open bead)", "filed (closed bead)", "secure copy", "HTTP LAN fallback", "copy failed"],
    demo:
      "Copy states depend on the clipboard context and are exercised in test/components.test.tsx.",
  },
  {
    name: "ExecutiveFindingsList",
    file: "components/ExecutiveFindingsList.tsx",
    purpose:
      "The ranked findings grouped by kind (Marked first, then warning signs, recommendations, discoveries, insights), each heading carrying its count and only the top finding expanded initially. Dismiss answers with Undo in the toast; suppressed findings stay named behind one disclosure.",
    variants: ["grouped by kind", "dismiss with Undo", "one focused + compact queue", "active", "marked-first", "all-dismissed", "review-dismissed", "filed findings", "register unavailable", "cut findings named", "cut findings disclosed", "nothing cut", "watch the outcome (metric from the finding's sources)", "no composer behind it (renders no action)"],
    demo:
      "Marked-first and review-dismissed come from clicking the populated demo; it passes no onWatch because the composer lives on an asset page.",
  },
  {
    name: "AnalysisEvidence / RecommendationReview",
    file: "components/AnalysisEvidence.tsx",
    purpose:
      "Shared saved-analysis clock and applicability display for findings, query and page suggestions, Overview, Growth and Search. recommendationValidity returns structured checks (per-source windows, linked tasks and releases, the recorded decision) without a Current verdict, drawn as a ValidityChip and a Source dates table.",
    variants: ["state chip (non-default only)", "source-dates table", "dated analysis", "old analysis with fresh page", "unknown analysis/source dates", "newer exact-family report", "later failed attempt", "recorded task closure", "exactly linked deploy", "outdated task photograph", "recorded dismissal", "explicit older analysis", "passive disclosure label"],
  },
  {
    name: "AlertVerification",
    file: "components/AlertVerification.tsx",
    purpose:
      "Visible source-verification state for an alert, separate from its first firing and its recorded open/closed state: confirmed with age, last known, source ended, recorded closed or not a live condition. Interactive mode opens one InfoTooltip with the exact times; passive mode is a plain neutral span.",
    variants: ["confirmed with age", "last known", "source ended", "recorded closed", "not a live condition", "invalid/future confirmation", "exact timestamp evidence", "passive Wall/list context"],
  },
  {
    name: "Drill",
    file: "components/Drill.tsx",
    purpose: "Desk-only evidence link requiring a real route; plain on the Wall.",
    variants: ["interactive+route", "static"],
  },
  {
    name: "Tabs / TabPanel",
    file: "components/Tabs.tsx",
    purpose:
      "The desk's tab bar: an ARIA tablist whose tabs are NavLinks, so the active tab is the URL, with manual activation, a roving tabindex, an optional `count` and `glyph` per tab, `onIntent` for fetching a tab's code before it opens, and a strip that scrolls inside itself on a phone. TabPanel is the single panel the router swaps.",
    variants: [
      "plain tabs",
      "active tab",
      "count badge",
      "glyph + count (severity dot)",
      "segmented ratio glyph",
      "keyboard roving focus",
      "strip scrolled to the selected tab",
    ],
    demo:
      "The scrolling strip is the viewport, not a prop; pinned in test/components.test.tsx.",
  },
  {
    name: "Stepper",
    file: "components/Stepper.tsx",
    purpose:
      "Horizontal lifecycle stepper (monochrome; progress isn't severity). `lifecycleStepper()` maps assets.status. Registry had no progress/step component.",
    variants: ["pre-launch", "onboarding", "baselining", "live", "retired (terminal)"],
  },
  {
    name: "OwnerChip",
    file: "components/OwnerChip.tsx",
    purpose:
      "Monospace path chip pointing at the file/table that OWNS a fact (doc 14 principle 10); LAN-safe click-to-copy. Badge is neutral chrome, not a copyable path affordance. An optional `hint` retargets the hover sentence at a reference to READ (the doc section a not-set-up source's setup steps live in) instead of an owner to edit.",
    variants: ["idle", "copied", "copy failed", "doc reference"],
    demo:
      "The phone target is the viewport, not a prop; pinned in test/components.test.tsx.",
  },
  {
    name: "KnobRow",
    file: "components/KnobRow.tsx",
    purpose:
      "One setting made legible: plain-language label + jargon, effective value, explainer, OwnerChip. The configuration/rules fact row. Nothing composed label+value+owner before.",
    variants: ["value-only", "with-explain", "with-owner", "with-scope"],
  },
  {
    name: "Timeline",
    file: "components/Timeline.tsx",
    purpose:
      "Annotation timeline (deploy, model change, config, incident, autonomy, external), relative time with the absolute on hover. An event whose ref resolves to a bead in the asset's snapshot renders HandoffBeadBadge; an unresolved ref stays the mono string.",
    variants: ["events", "empty", "bead ref (open)", "bead ref (shipped)", "unresolved ref (mono)", "no ref"],
  },
  {
    name: "StateChip",
    file: "components/StateChip.tsx",
    purpose:
      "A boolean/enum STATE as a dot glyph + label, colored by meaning (doc 14 'state is visual, never prose'). SeverityDot is severity-only; Badge has no meaning-color. `dot=hollow` = the operator-declined notch; `attention` = a soft halo for an unresolved state. `glyph` replaces the dot where the state's own vocabulary already owns a shape — the task lifecycle on /tasks/:id, from the one status face the Tasks board shares (routes/tasks/task-face.tsx, bead ro-ujb9.202) — since a dot there would say the tone twice and the state not at all. STATE_TONE[tone].text is the chip's ink for the same state drawn compact (glyph + word in a table cell).",
    variants: ["connected", "affirmative", "caution", "critical", "declined", "na", "neutral", "hollow dot", "attention halo", "lifecycle glyph"],
  },
  {
    name: "UnknownPriceCount",
    file: "components/UnknownPriceCount.tsx",
    purpose:
      "Unknown provider prices beside known spend, composed from StateChip. The registry has no shared unknown-price count: this wrapper owns its question glyph, accessible label and zero-count omission across the budget displays (ro-ujb9.75.1).",
    variants: ["unknown prices", "all priced (renders nothing)"],
  },
  {
    name: "IntegrationStateChip",
    file: "components/IntegrationStateChip.tsx",
    purpose:
      "THE ONE RENDERER OF A CONNECTION'S STATUS (bead ro-ujb9.96.7.3), composed from StateChip over shared/connection-status: Not connected, Not checked, an accepted connection named for what was given (Key accepted, Signed in, URL accepted — `accepted`, from the contract's acceptedAs, bead ro-ujb9.96.7.25), Collecting, Working, Overdue, Failing, Not using, Unknown, and Doesn't apply for a register cell. Glyph plus word, connectivity green only with proof. A register cell's recorded state is read in the same vocabulary. ConnectionFacts beside it draws the compact facts as chips, never sentences.",
    variants: ["every status", "signed in", "register state", "with count", "facts"],
  },
  {
    name: "InfoTooltip",
    file: "components/InfoTooltip.tsx",
    purpose:
      "Supporting desk explanations on demand through a neutral info button or a compact text trigger: hover, keyboard focus and tap open a hoverable portalled panel clamped to the viewport that follows a scroll; Escape and outside interaction dismiss it. Its content is noninteractive, it never sits inside another button or link, and the Wall never draws it.",
    variants: ["info glyph", "compact text trigger", "hover/focus/tap", "tap pinned", "hoverable panel", "Escape/outside dismissal", "narrow viewport", "separate KPI controls"],
  },
  {
    name: "EvidencePopover",
    file: "components/EvidencePopover.tsx",
    purpose:
      "The 'why this state' affordance on a lane whose effective state was adjusted by store evidence (doc 11 observed-evidence): a glyph → portalled plain-language panel (never clipped by the matrix scroll). Amber glyph for against-evidence, slate for supporting. Built on the ui Popover (bead ro-ujb9.219): opening moves focus into the panel, Escape or a press outside gives it back to the trigger, and a scroll keeps it open on its trigger. Not a tooltip — it is a dialog.",
    variants: ["against (amber)", "supporting (slate)", "closed"],
  },
  {
    name: "ChangeChip",
    file: "components/ChangeChip.tsx",
    purpose:
      "The 'something changed just before this' chip on an alert: the asset's timeline events inside the correlation window, named with Timeline's own glyph+word and dated against the alert ('deploy 14h before'). The glyph+word table is its own module, components/annotation-kind.ts, since bead ro-ujb9.85: the chip rides the TV's alert rail, and importing it from Timeline.tsx sent the desk timeline and HandoffBeadBadge to /wall. Renders NOTHING when nothing correlates. Neutral by design — StateChip colors a state, this is context, and the severity dot already owns how-bad.",
    variants: ["single (dated)", "same kind (counted)", "mixed kinds", "none (silent)", "linked / plain"],
  },
  {
    name: "IntegrationSummaryStrip",
    file: "components/IntegrationSummaryStrip.tsx",
    purpose:
      "The register's totals above the audit grid in the connection vocabulary (bead ro-ujb9.96.7.3): one IntegrationStateChip with a count per status, problems first, plus one line of reusable credentials still to add. Counts, never sentences.",
    variants: ["mixed", "all clear", "shared-credential line"],
  },
  {
    name: "IntegrationMatrix",
    file: "components/IntegrationMatrix.tsx",
    purpose:
      "Desktop cross-asset audit grid plus mobile asset accordions. Each cell reads the same status the asset's Data sources row reads (statusOf, from shared/connection-status laneStatus); without it, the register cell's own state in the same vocabulary. Mobile sorts failing first and opens one asset at a time. Layers are labelled, never explained.",
    variants: ["desktop grid", "mobile asset accordion", "expanded source", "derived row", "empty"],
  },
  {
    name: "ConnectPanel",
    file: "components/ConnectPanel.tsx",
    purpose:
      "One panel, one press: connect a provider on /integrations or from a site's Data sources. Paste what the provider issued and press Connect; the ingest asks the provider first and stores the credential only if it accepts, so the panel goes Checking → accepted (with what the answer proved) or shows the refusal in plain words under the field. Nothing is ever shown back.",
    variants: ["editing (empty, Get a key link)", "checking", "accepted: sites", "accepted: credit", "refused", "no answer", "field refused by the server", "cannot store yet (why at its top where the page has no banner)", "connected: status, Replace, Disconnect", "replaced: answer and Done", "accepted: region and projects (PostHog)", "sign-in (Google, GoogleSignInSetup)", "sheet", "inline (gallery)"],
  },
  {
    name: "ConnectionActions",
    file: "components/ConnectionActions.tsx",
    purpose:
      "The connection's own actions, Replace (named for the secret) and Disconnect, drawn on the connection itself: ConnectPanel's connected view and the top of a provider's card. Replace opens the key form; Disconnect keeps one confirmation naming the sites that stop and what is deleted.",
    variants: ["idle", "replacing (pressed)", "failing (Replace leads)", "no Replace (sign-in)", "confirming", "disconnecting", "refused"],
  },
  {
    name: "WhatLands",
    file: "components/WhatLands.tsx",
    purpose:
      "What a notification channel carries: each condition the ingest's notifier sends (NOTIFIED_CONDITIONS, one declaration) as a label and its cadence, on Discord's provider card and connect panel.",
    variants: ["will send (not connected)", "sends (connected)"],
  },
  {
    name: "CopyCommand",
    file: "components/CopyCommand.tsx",
    purpose:
      "One command, verbatim, with Copy beside it: the press for a state only the operator's own terminal clears (the credentials table's migration, a bootstrap key, the legacy-env import).",
    variants: ["a migration command", "a key command beside its binding", "copied"],
  },
  {
    name: "ConnectBlockers",
    file: "components/ConnectBlockers.tsx",
    purpose:
      "Why nothing can be connected yet: one warn StatusBanner per blocker (no credentials table, no encryption key, an unusable key) with its environment binding and the CopyCommand that clears it, said once per screen where Connect is.",
    variants: ["no encryption key (binding and command)", "no credentials table (command only)", "in the connect panel"],
  },
  {
    name: "GoogleSignInSetup",
    file: "components/GoogleSignInSetup.tsx",
    purpose:
      "Google, connected by signing in: ConnectPanel's body for the `sign-in` connect kind. Hosted, it is the two read-only grants and Continue with Google; self-hosted, the one-time client setup as three presses and a dropped client_secret.json whose redirect list is checked against this Tower's address. After consent the panel reopens on SitePicker.",
    variants: ["self-hosted: no client (steps, file, Testing chip)", "self-hosted: client stored", "self-hosted: redirect address not in the client", "self-hosted: file refused", "hosted: grants and one button", "address Google refuses: loopback press", "cannot store yet"],
  },
  {
    name: "SiteTokens",
    file: "components/SiteTokens.tsx",
    purpose:
      "A token per site, pasted on the site's row: ConnectPanel's body for a provider that issues one token per project with no free call to prove it (Clarity). A pasted token saves at once through PUT /api/integrations/:provider/site-token; Run now runs the export for the held sites and says what it spends.",
    variants: ["held (status) and waiting for a paste", "saving", "refused on its row", "run: 1 of 10", "run: calls left", "run disabled"],
  },
  {
    name: "SitePicker",
    file: "components/SitePicker.tsx",
    purpose:
      "The account's sites, matched to portfolio assets, and one press: ConnectPanel's second screen. Every asset is a row ticked where the account holds its domain, with the site it would be collected from or a chip saying why not; Start writes the Data sources tab's own mapping ops and runs the job now. Unticking a row the job collects anyway asks for a DeclineReasons pick and saves it as Not using in the same press.",
    variants: ["account: matched, picked, not in account, not verified, declined, unmatched sites", "unticked: still collected (reasons offered)", "unticked: not using (reason picked)", "portfolio: markets and spend preview", "PostHog: projects by name and number, funnels picked up", "Google: GA4 property and Search Console site on one row", "starting", "started: statuses", "started: saved as not using", "refused: paused", "loading", "no answer"],
  },
  {
    name: "DeclineReasons",
    file: "components/DeclineReasons.tsx",
    purpose:
      "Why a data source is not used, as one press: three preset reasons as choice chips plus Other… for a line of the operator's own. A chip is the decision; it hands its words to the caller, which writes the reason and the posture in one changeset. Nothing is preselected.",
    variants: ["chips (nothing chosen, with ✕)", "a preset chosen", "own reason chosen", "typing own reason", "saving (disabled)"],
  },
  {
    name: "AddSitePanel / AddSiteButton / NoSitesYet",
    file: "components/AddSite.tsx",
    purpose:
      "Add a site in one screen: a centred Sheet with one Domain field, the name read off the domain and replaced by the site's own when GET /api/site-name answers, an optional Not launched yet press, and refusals as short states beside the field. Add writes through the wizard's own path and lands on the new asset's Data sources. AddSiteButton opens it in place; NoSitesYet is an empty site list's door.",
    variants: ["empty (Add unavailable)", "domain typed: name from the domain", "name from the site", "already added (with Open)", "not a domain (after Add)", "not launched yet pressed", "adding", "cannot save here", "row added, setup not saved (Retry setup)", "the button that opens it", "no sites yet (the door)"],
  },
  {
    name: "ProviderCredentialForm / ProviderLink",
    file: "components/provider-card/ProviderCredentialForm.tsx",
    purpose: "ProviderCard's existing schema-driven credential form and provider deep link, extracted without changing validation, blank omission, uploads or callbacks (ro-ujb9.65). Its private field renderers stay together. ConnectPanel owns the separate save-and-test flow; this form retains the reference card's save callback. ProviderLink also serves the card's expiry row.",
    variants: ["text and password", "json paste or upload", "url-list", "asset-map", "field refusal", "saving"],
  },
  {
    name: "GoogleSignIn / StepNumber",
    file: "components/provider-card/GoogleSignIn.tsx",
    purpose: "ProviderCard's existing Google reference view, extracted intact (ro-ujb9.65): typed OAuth app setup, redirect address, connected grant and GA4 and Search Console discovery. GoogleSignInSetup remains ConnectPanel's distinct upload flow. StepNumber also serves the card's legacy-import steps. Existing ProviderCard gallery states exercise this view, with no duplicate demo.",
    variants: ["app missing", "ready", "redirect unusable", "connected", "revoked", "discovery pending or refused"],
  },
  {
    name: "ProviderCard",
    file: "components/ProviderCard.tsx",
    purpose:
      "One provider's credential and its connection evidence (doc 14 flow C): the header in the shared ConnectionStatus and IntegrationStateChip vocabulary, credential source kept separate from connection status, and guided mode (Connect, Choose sites, Verify, Settings) sharing the reference card's forms and evidence. Replace opens empty inputs, secrets are never echoed, and Disconnect goes through ConnectionActions.",
    variants: [
      "guided setup: connect, assets, verify, settings",
      "shared connection status (accepted, working, overdue, failing or unknown)",
      "legacy credential import (button or command)",
      "not connected (Connect; the form lists what is needed)",
      "failing (stored error)",
      "connect form: text + password",
      "connect form: json paste or upload",
      "connect form: url-list",
      "field refusal named under its input",
      "testing (spinner)",
      "probe ok / probe failed",
      "freshly stored: Not checked status, Not tested yet verdict",
      "disconnect: one confirmation naming sites and deletion",
      "cannot store yet (Connect disabled, Disconnect live)",
      "expiry: quiet countdown (far off)",
      "expiry: warn inside T-14d",
      "expiry: expired (connection status unchanged without failure evidence)",
      "expiry: none can be known (No expiry date, no field)",
      "expiry: operator records or removes a date",
      "grant revoked (no tick, neutral scopes, sign-in promoted)",
      "Test named by what it does (Send test message · Check keys)",
      "field: link beside the label, placeholder, grants as chips",
      "data budget spent (Paused until the next month)",
    ],
  },
  {
    name: "GoogleStartPress",
    file: "components/provider-card/GoogleStartPress.tsx",
    purpose:
      "The shared Google start control inside ProviderCard: a standalone href renders as a link, an owner-bound onStart callback as a button with no GET fallback, and a pending hosted start disables the button.",
    variants: ["standalone link", "hosted button", "hosted start pending"],
  },
  {
    name: "AlertRow",
    file: "components/AlertRow.tsx",
    purpose:
      "One alert as doc 14's ListRow on every surface that shows one whole (an asset's Current signals and Alert history, /alerts/history): a severity ring, a mark, the translated headline and one caption, with evidence, dated facts and verbs revealed in place when opened. `history` drops the actions and draws the open span; `asset` adds the asset's favicon and link on a portfolio surface. It also exports Recurrence, AttentionAllClear and AlertList.",
    variants: [
      "open (actions attached)",
      "open and tuned (chip among the actions)",
      "settled (no actions)",
      "open span short",
      "open span long",
      "no closing time (no span)",
      "acknowledged with note and expiry",
      "tuned, then marked read (badge + chip)",
      "recurring condition (count chip)",
      "milestone",
      "portfolio row (asset favicon + link)",
      "correlated change",
      "decision owed",
      "row opened in place (evidence, dated facts, verbs)",
      "already notified (dated mark)",
    ],
  },
  {
    name: "FlagActions",
    file: "components/FlagActions.tsx",
    purpose:
      "Shared alert-lifecycle controls for the desk queue and the asset alert row: Mark read, Snooze (expanding in place into three presets and a date, committed with Undo in the toast) and Resolve, with one pending state, plus TuneRuleAction on an open row given a `ruleId`. A parked row gets Unsnooze alone.",
    variants: ["idle", "snooze picker (presets + date)", "snoozed (Unsnooze only)", "pending (inside desk Attention demo)", "with Tune (rule-driven alert)"],
    demo:
      "The demo alert ids do not exist, so the route stages the action and its failure toast rather than a fake success.",
  },
  {
    name: "SnoozeUntil",
    file: "components/SnoozeUntil.tsx",
    purpose:
      "When a parked alert comes back, as glyph + date + time remaining: a struck bell counting down while it is quiet, a ringing bell with a past date once it has expired. AlertRow's footer and the /alerts Snoozed list draw it identically.",
    variants: ["active (counting down)", "expired (back on the list)"],
  },
  {
    name: "BacktestStrip",
    file: "components/BacktestStrip.tsx",
    purpose:
      "What a rule setting would have done, as a shape: thirty days laid out in order, the replay above the line and the days the rule actually fired below it, in neutral ink, with fired, quiet, unjudged and no-report days told apart. A day with no report is drawn as a hole, never a quiet day.",
    variants: [
      "judged (fired, quiet, unjudged, no report)",
      "quieter than reality",
      "nothing could be judged",
      "no reports at all",
      "week bands",
      "really-fired ticks",
    ],
  },
  {
    name: "RuleTunePanel / TuneRuleAction",
    file: "components/RuleTune.tsx",
    purpose:
      "Tune this rule from the alert it is noisy on (docs/15 flow E): the trigger renders nothing for a rule a pulse replay cannot honestly serve, and opens a portalled panel holding TuneRate, the BacktestStrip and the three portfolio alert-rule settings as KnobEditors, the preview recomputing as a field changes. RuleTunePanel is the presentational half, reviewable without a store.",
    variants: [
      "trigger (rule-driven alert)",
      "no trigger (rule with no replay)",
      "open panel",
      "ready preview",
      "replaying",
      "value the detector refuses",
      "replay refused",
      "read-only deployment (Save disabled, preview intact)",
      "with the rule's tune record (bead ro-ayxy)",
    ],
    demo:
      "The gallery renders the panel over a fake writer, not the fixed-position trigger; the trigger is pinned in test/rule-tune.test.tsx.",
  },
  {
    name: "KnobEditor",
    file: "components/KnobEditor.tsx",
    purpose:
      "An editable setting: KnobRow's fact layout plus a validated control and a Save that writes it (D18), through the local config write lane for a file-owned knob or the Worker for a store-owned column. The way back is the Undo beside the field (InlineSaveState); `onDraft` reports the buffered draft for a caller that previews before the Save; optional help is an InfoTooltip beside the label.",
    variants: [
      "text",
      "number",
      "local datetime",
      "select",
      "toggle",
      "saving",
      "saved with undo",
      "refused (stale)",
      "read-only deployment",
      "watched draft (onDraft)",
      "Saved · Undo beside the field — the only confirmation (bead ro-ujb9.96.7.12; no toast mode)",
      "pick-to-save select (autosave)",
      "inline refusal: Not saved and why beside the field, no toast (bead ro-ujb9.96.7.12)",
      "paused saves: a lock only, the reason said once by the page (statesReadOnly=false, bead ro-p8qq)",
    ],
  },
  {
    name: "InlineSaveState",
    file: "components/InlineSaveState.tsx",
    purpose:
      "A save's outcome beside the field that made it: Saving… while the write is out, a check and Undo once it landed, 'Not saved' and the refusal's own words when it did not; idle draws nothing. `subject` names the field the state is about.",
    variants: ["saving", "saved with Undo", "undoing", "refused with its reason", "idle (renders nothing)"],
  },
  {
    name: "SavesPaused",
    file: "components/SavesPaused.tsx",
    purpose:
      "Saves are paused, said once for the whole screen: when the deployment answers writable:false, a page that stacks editors renders one StatusBanner with the deployment's reason and passes statesReadOnly={false} to its editors. It renders nothing while saves work.",
    variants: ["saves paused (the deployment's reason)", "saves work (renders nothing)"],
  },
  {
    name: "FunnelListEditor",
    file: "components/FunnelListEditor.tsx",
    purpose:
      "One list of ordered lists, saved as one value: an asset's PostHog funnels, each a name and 2-10 ordered steps, buffered whole and written as one file-json-set so funnels are never half-saved. Given `saved` funnels from the connected account the list is picked rather than typed.",
    variants: [
      "saved funnels",
      "add / remove a funnel",
      "add / remove / reorder steps",
      "refused (the rule under the list)",
      "empty",
      "read-only",
      "picked from the project's saved funnels (bead ro-ujb9.96.7.24)",
    ],
  },
  {
    name: "CollectionEditor",
    file: "components/CollectionEditor.tsx",
    purpose:
      "One list-shaped config register, editable: KnobEditor's plural. It knows nothing about any register — the columns, controls, Add form and refusals all come from the field declarations in scripts/config-registers.mjs — and every action is one guarded store write carrying its exact inverse, with Remove alone asking first, inline. Past eight rows it filters, sorts and folds on a phone; the page supplies the runtime facts (`fieldOptions`, `derived` columns, `rowGlyph`, `onAdded`) and the declaration supplies the rules (`readOnly`, `defaultFrom`, `clusterField`, `refuseField`, `candidates`).",
    variants: [
      "rows (a column per declared field)",
      "inline edit (Save / Enter)",
      "refused field (rule under the input)",
      "add from the schema",
      "refused add (required field, duplicate key)",
      "refused add (outside the page's own list)",
      "a picker that suggests rather than refuses",
      "filtered (n of m)",
      "filtered to nothing",
      "sorted by a column",
      "a computed column",
      "a computed column that marks only the wrong rows",
      "folded on a phone (summary line)",
      "defaulted field following its source",
      "a fixed join key (text, with the reason)",
      "remove behind an inline confirm",
      "saved with undo",
      "refused (stale)",
      "scalar register (the row is the value)",
      "object register (keyed by asset id)",
      "row glyph (the key's own favicon)",
      "loading (the table's own shape)",
      "empty",
      "unfiled asset (the first row files the entry)",
      "read-only deployment",
      "read-only said once by the page",
      "outcome under every cell — Saved · Undo / Not saved (bead ro-ujb9.96.7.12)",
      "commit=auto: no Save, saved on pick or on leaving the cell; commit=save (default, money): the cell's own Save",
      "paused saves: a lock by the title, the reason said once by the page (statesReadOnly=false, bead ro-p8qq)",
    ],
    demo:
      "The phone fold is the viewport, not a prop; pinned in test/components.test.tsx.",
  },
  {
    name: "TaskComposer / FileTaskButton",
    file: "components/TaskComposer.tsx",
    purpose:
      "File a task with a button (D19): a slide-over opened prefilled from `taskHandoffPrefill`, the same computation the copied `bd create` command is rendered from. Title, project and priority first with Enter filing; type, parent, labels, description and acceptance criteria under More; the handoff labels and `noticeos_*` metadata locked. Filing lands on /tasks/<id>; a deployed build disables the trigger with the reason on hover.",
    variants: [
      "handoff prefill (locked labels, linked line)",
      "new task (nothing prefilled)",
      "index (opened in place, or by ?new=1; project filter inherited)", "on a finding's row, prefilled from its fields (title, what it measured, window, sources, evidence link)",
      "project chosen (favicon)",
      "refused (no project)",
      "refused (no title)",
      "refused (parent outside the spoke's prefix)",
      "filing",
      "filed (toast with the id)",
      "read-only deployment (disabled, lane's reason)",
    ],
  },
  {
    name: "WallPreview",
    file: "components/wall/WallPreview.tsx",
    purpose:
      "The television at TV geometry with the editor's chrome on it (/wall/edit): a literal 1920x1080 box scaled to the pane, holding WallCanvas itself through its `editing` slot, so there is no second layout engine. The chrome counter-scales, appears only over the pointed-at widget and drops below a quarter scale; arranging is native drag-and-drop; it measures the canvas's content height so the route can say how far past the TV a layout runs.",
    variants: [
      "default layout",
      "a rearranged layout",
      "selected widget",
      "widget hovered (its toolbar)",
      "drag hovering a target",
      "chrome dropped (phone)",
      "fit note stated",
      "fit note absent (the layout fits)",
      "read-only",
    ],
    demo:
      "The gallery's live editor reaches most states by use; the chrome-dropped face follows the pane width and the read-only face needs a deployment without the write lane, both pinned in test/wall-edit-route.test.tsx.",
  },
  {
    name: "WallLibraryPanel",
    file: "components/wall/WallLibraryPanel.tsx",
    purpose:
      "The fixed widget library (docs/15 flow D): every type the contract knows, always listed, with a refused Add dark on its row and the validator's own sentence as the reason.",
    variants: [
      "every type offered",
      "a unique type already placed (refused with the reason)",
      "no room left anywhere",
      "read-only",
    ],
  },
  {
    name: "WallWidgetPanel",
    file: "components/wall/WallWidgetPanel.tsx",
    purpose:
      "The selected widget's settings: its width as the contract's weight and as its share of the row, Move left/right/up/down as the keyboard's half of the drag, the settings its renderer applies (the asset filter), and for the countdown the embedded CountdownEditor itself under this panel's heading.",
    variants: [
      "nothing selected (the widgets on the Wall, one press each)",
      "width and share of the row",
      "a dead move direction (disabled)",
      "asset filter (every asset)",
      "asset filter (a subset)",
      "a widget with no settings",
      "the countdown's own form",
      "no countdown configured",
      "read-only",
    ],
    demo:
      "The gallery never selects the countdown: its panel is the live CountdownEditor and would write config/tower.json.",
  },
  {
    name: "WallRowsPanel",
    file: "components/wall/WallRowsPanel.tsx",
    purpose:
      "The Wall's rows as rows: the order, which row takes the remaining height, adding one, removing an empty one, and a drop target for a row the preview draws nothing for. It lists no widgets.",
    variants: [
      "three rows",
      "the fill row marked",
      "an empty row (drop target, removable)",
      "a full row (remove disabled)",
      "at the six-row ceiling",
      "read-only",
    ],
  },
  {
    name: "WallStrip",
    file: "components/wall/WallStrip.tsx",
    purpose:
      "The Wall's grouped header (docs/25 § Strip): brand and local clock/date, next meeting today, and a prominent days-left countdown in one sans family, scaled labels keeping an 11px floor and portrait screens wrapping whole groups. A failed Wall poll keeps the values and adds their age; concrete OS, scheduler and spend problems belong to NeedsYou.",
    variants: ["meeting today", "clear day", "countdown remaining", "countdown reached", "no countdown", "held payload", "TV and wrapping phone groups"],
  },
  {
    name: "WallVersions",
    file: "components/wall/WallVersions.tsx",
    purpose:
      "What the television used to show, and the way back: each row the operator's own words, the age of the save and the shape of the layout it holds. A revert is a save, so the list is a record rather than an undo stack, and it asks for no reason.",
    variants: [
      "several versions",
      "one version",
      "none at all",
      "reverting",
      "read-only",
    ],
  },
  {
    name: "RevenueHero",
    file: "components/wall/RevenueHero.tsx",
    purpose:
      "The Wall's revenue widget (D28, docs/25 § Revenue): the month's revenue so far as the largest type on the screen, 'on pace for $X' from the sites' projections, the change against last month in neutral ink, yesterday's estimate with the days left, and the month as a running total drawn in ChartMarks against last month's flat total with the crossing day named. The arithmetic is lib/wall-revenue; the figure is portfolioHeadline's, so the TV and the desk quote one number.",
    variants: [
      "on pace to pass last month",
      "passed last month",
      "learning (no pace yet)",
      "no revenue source",
      "yesterday all in",
      "yesterday 1 of 2 sites",
      "yesterday not reported yet",
    ],
  },
  {
    name: "SiteRows",
    file: "components/wall/SiteRows.tsx",
    purpose:
      "The Wall's asset region (docs/25 § Site rows and Density): site name and favicon with four-bar health, LiveUsers over the minute pulse, today's comparable-hours chart and pace, the four-week trend, and selected pulse totals on a second line. The rows fill the region: four or more assets keep figures beside charts, two or three put larger figures above them, one asset uses up to three focus tiles.",
    variants: ["default pulse totals", "per-asset selection", "explicit none", "missing/zero/stale totals", "healthy/warn/error/unknown health bars", "fresh/stale live reading", "no data", "four or more filling rows", "two or three larger rows", "one site focus tiles"],
  },
  {
    name: "LiveUsers",
    file: "components/wall/LiveUsers.tsx",
    purpose:
      "A site's live users on the Wall: GA4 users in the last 30 minutes in neutral ink, counting to each new reading, over a MinutePulse with the bright five-minute end's own count. Stale and failed readings drop to muted ink with their age; no reading is a dash, never a zero. One cell for every row tier and the one-site Today tile.",
    variants: ["fresh", "stale with its age", "failed, last pulse kept", "pulse refused (figures only)", "no GA4", "compact row", "roomier row", "phone row", "one-site tile"],
  },
  {
    name: "NeedsYou / IssueGlyph",
    file: "components/wall/NeedsYou.tsx",
    purpose:
      "The Wall's top three actionable problems, errors first then newest, with site, concise line and age (docs/14-design.md § Needs you). wallIssues merges alerts, failing sources, late reports and overdue reviews; withSystemIssues adds missing OS reports, failed or silent jobs and spending over daily pace using existing rules. Duplicate OS report problems merge. The full asset issue list drives each site's health bars; NeedsYou shows the top three and total count, with urgent human tasks counted by the heading. No carousel. IssueGlyph supplies severity shape as well as color. D29 sites never receive missing-nightly-report warnings. Reuses the established Wall issue derivation rather than a second alert system.",
    variants: ["top three with the rest counted", "urgent tasks beside the heading", "nothing broken but urgent tasks", "nothing needs you"],
  },
  {
    name: "AppShell / Sidebar",
    file: "components/AppShell.tsx",
    purpose:
      "The desk's one chrome: a persistent left sidebar with the eight desk nouns as NavLinks (aria-current, an asset page lighting Assets), one row per asset beneath Assets (favicon, a severity dot for open attention, a stage glyph where not live; collapsible and remembered in localStorage), a footer holding the TV, the theme toggle and the Search button, and below `md` a top bar whose menu button opens the same content as a drawer. The Integrations entry and the top bar wear the expiring-credential dot. AppShell applies `.light` to the document and removes it on unmount.",
    variants: [
      "sidebar (md and up)",
      "active item (aria-current)",
      "asset route lights Assets",
      "asset rows (favicon + severity dot + stage glyph)",
      "row lit on a tab URL",
      "retired at the foot",
      "overflow (All assets…)",
      "first run (New asset only)",
      "loading (reserved rows)",
      "asset list collapsed",
      "Integrations expiry dot (warn / expired)",
      "top bar + menu button (below md)",
      "top bar carrying the expiry dot",
      "drawer open (list collapsed)",
      "dark",
      "light",
      "footer search button (⌘K)",
    ],
  },
  {
    name: "CommandPalette",
    file: "components/CommandPalette.tsx",
    purpose:
      "Go-to-anything for the desk: ⌘K / Ctrl+K inside the shell, or the sidebar's Search button, scoped to navigation only. Three groups (Pages, Assets, Open task for a bead-shaped query), recent selections remembered in localStorage and lifted to the top while the query is empty; mounted by AppShell on every desk page and fetched on first open.",
    variants: [
      "closed",
      "open (pages + assets)",
      "recent first (empty query)",
      "filtered",
      "asset with open severity",
      "bead id → Open task",
      "no match",
      "inline (gallery)",
    ],
  },
  {
    name: "PageHeader",
    file: "components/PageHeader.tsx",
    purpose:
      "One page header for every desk surface: title, description, breadcrumb, right-aligned actions, an inline meta slot and a full-width children slot for tabs. It carries no back link (navigation is the shell's), and `title` is a ReactNode so the asset page's identity row can be the h1.",
    variants: [
      "plain title + description",
      "breadcrumb",
      "actions",
      "meta (age badge / period)",
      "rich title (identity row)",
      "children (tab slot)",
    ],
  },
  {
    name: "Button",
    file: "components/ui/button.tsx",
    purpose:
      "shadcn button (Radix Slot). Every size carries a 44px floor below `sm` (bead ro-md80): the three sizes were set for a pointer (36/32/36px) and the verbs the desk is opened on a phone for — Mark read, Snooze, Resolve — are all `sm`. `max-sm:` only, so desk density is untouched.",
    variants: ["default", "outline", "ghost", "sm/default/icon", "phone touch floor"],
    demo:
      "The phone touch floor is the viewport, not a prop; pinned in test/components.test.tsx.",
  },
  {
    name: "Badge",
    file: "components/ui/badge.tsx",
    purpose: "shadcn badge (neutral chrome; severity lives in SeverityDot/AgeBadge).",
    variants: ["default", "secondary", "outline"],
  },
  {
    name: "Card",
    file: "components/ui/card.tsx",
    purpose: "shadcn card + header/title/content/footer parts.",
    variants: ["Card", "CardHeader", "CardTitle", "CardContent", "CardFooter", "kind: money · alert · win · neutral (D44)"],
  },
  {
    name: "Sheet",
    file: "components/ui/sheet.tsx",
    purpose:
      "A modal side sheet over the right edge of the desk: the desk behind is blurred and inert, Escape, the close control or a press on the desk close it, focus starts on the first field and returns to the opener; on a phone it is the whole screen under the app bar. `placement=\"center\"` is the same modal as a 440px card for a short question answered once.",
    variants: ["desk: right edge, 430px", "phone: full width under the app bar", "center: one-question card (desk and phone)"],
  },
  {
    name: "Popover / PopoverTrigger / PopoverContent / PopoverAnchor",
    file: "components/ui/popover.tsx",
    purpose:
      "shadcn's Popover on Radix in this theme's tokens: a focusable role=dialog panel placed against its trigger, portalled and kept inside the viewport. Opening moves focus in; Escape, a press outside and focus leaving close it and return focus to the trigger; a page scroll moves it rather than closing it.",
    variants: ["open from a key or a press", "Escape / press outside return focus", "a press on another control keeps it", "follows a scroll"],
  },
  {
    name: "Table",
    file: "components/ui/table.tsx",
    purpose:
      "shadcn table primitives. `stacked` is the one phone mechanism, declared here once: below `sm` each row reflows into a labelled card painted from each cell's `label`, with `dropWhenStacked`, `foldWhenStacked` and `onlyWhenStacked` deciding what the card shows. Without it a table scrolls inside its own box.",
    variants: [
      "Table",
      "TableHeader",
      "TableBody",
      "TableRow",
      "TableHead",
      "TableCell",
      "stacked (labelled cards below sm)",
      "dropWhenStacked cell",
      "row that opens (pointer; the stacked card draws the › disclosure chevron — bead ro-ujb9.13)",
    ],
    demo:
      "The stacked reflow is the viewport, not a prop; the classes are pinned in test/components.test.tsx.",
  },
  {
    name: "Command",
    file: "components/ui/command.tsx",
    purpose:
      "cmdk primitives: the filter, list, group and item machinery CommandPalette is built from, vendored beside the other shadcn parts. A second command menu imports them rather than copying them.",
    variants: [
      "Command",
      "CommandDialog",
      "CommandInput",
      "CommandList",
      "CommandEmpty",
      "CommandGroup",
      "CommandItem",
      "CommandShortcut",
    ],
  },
  {
    name: "DecisionLaneSummary / MobileCellLabel / EvidenceLine",
    file: "components/decision-lanes.tsx",
    purpose:
      "The decision-lane vocabulary, drawn once: the lane and tone types, each lane's word and tone classes, the four-count strip above a decision table and the two cell primitives QueryVisibilityRankings and PageDecisions lay out with. It decides no lane; each surface keeps its own rules.",
    variants: [
      "act",
      "investigate",
      "protect",
      "wait",
      "counts strip",
      "mobile cell label",
      "evidence line",
      "AI Overview surface phrase",
    ],
  },
  {
    name: "QueryVisibilityRankings",
    file: "components/QueryVisibilityRankings.tsx",
    purpose:
      "Asset-only 90-day search charts plus a responsive query-decision table: each normalized query gets one act/investigate/protect/wait verdict line, its source evidence (Google and Bing observed impressions and movement kept distinct from DataForSEO modelled demand, rank, difficulty, intent and the per-surface AI Overview marks), a Copy Markdown handoff, the HandoffBeadBadge of any bead filed from it, and an outcome-check composer that pre-registers how the decision will be judged. Applicability is said once in the header and on a row only where it differs.",
    variants: ["recover", "near win", "ranking opportunity", "organic gap", "mixed", "weak", "strong", "growing", "wait", "intent token", "estimated visits", "secure copy", "HTTP LAN fallback", "copy failed", "three sources", "one source", "first DataForSEO baseline", "historical rank movement", "AI cited", "AI result shown", "AIO phone-vs-desktop split", "AIO surface never checked", "insufficient windows", "desktop", "mobile", "daily", "weekly", "irregular", "provisional Google tail", "filed (open bead)", "filed (closed bead)", "unfiled", "register not asked", "lane proof row", "lane proof row at zero", "lane ran no check (no row)", "watch the outcome (rank lane -> position)", "watch the outcome (traffic lane -> clicks)", "no composer behind it (renders no action)"],
    demo:
      "Copy states depend on the clipboard context, and the demo passes no onWatch because the composer lives on an asset page.",
  },
  {
    name: "ProductJourney",
    file: "components/ProductJourney.tsx",
    purpose:
      "The asset Growth tab's Product section: what people do once they arrive and where it breaks, from the executive snapshot's PostHog `product` block. A strip of daily use with sparklines and the main funnel's rate, the funnels as Meter bars with the largest drop marked, and a 'Where it breaks' ListPanel grouped by page; no product block renders one quiet line, never a strip of zeros.",
    variants: ["full acceptance read", "thin read (not enough data checks)", "several funnels behind the expander", "no earlier week", "connected, not collected yet", "not connected", "not collected for this asset"],
  },
  {
    name: "PageDecisions",
    file: "components/PageDecisions.tsx",
    purpose:
      "The query table's four lanes on the grain an operator actually edits: one row per page present in both seven-date Search Console windows, eight rules each a label and one short action with the evidence one press away, a click move naming its likely cause, and the two tracked-panel rules applied through the page's leading query. It shares the query table's lane words, tones and cell primitives through `decision-lanes` and none of its rules; its handoff is keyed on the absolute page URL.",
    variants: ["lost clicks", "gaining clicks", "shown rarely clicked", "walled by AI Overview", "AI Overview cites this page", "shown more taken no more", "position slipping", "no real change", "likely cause tagged", "release in window", "shared state in header", "AIO surface split", "AIO surface never checked (no line)", "leading query unknown", "fold (more than eight pages)", "filed (open bead)", "filed (closed bead)", "unfiled", "register not asked", "secure copy", "HTTP LAN fallback", "copy failed", "no two complete weeks (stated absence)"],
    demo:
      "Copy states depend on the clipboard context; register-unavailable is payload state with no visible fallback.",
  },
  {
    name: "FilterBar / FilterFold / FilterToggle / FilterControls",
    file: "components/surface/FilterBar.tsx",
    purpose:
      "A page's filters and sort, folded behind one Filters button carrying the active count below `sm`, and laid out in the page's own row from `sm` up. A period is not a filter and stays in view; `aside` holds a fact about the list and is never folded. FilterFold, FilterToggle and FilterControls are the parts for a page whose button shares a row with something else.",
    variants: ["phone: folded (the button only)", "phone: open", "active count on the button (Filters, 2 on)", "desk: the page's own row, no button", "aside kept beside the button", "parts: toggle in another row (Sites)"],
  },
  {
    name: "RangeSelector",
    file: "components/surface/RangeSelector.tsx",
    purpose:
      "The page's one range, 7d / 28d / 90d with 28 the default (D24), sitting in the page header and driving every delta, sparkline and chart below it. A row of `pillChoice` toggles rather than a select.",
    variants: ["7d", "28d selected (the default)", "90d", "custom options", "phone (44px floor)"],
  },
  {
    name: "SectionLabel",
    file: "components/surface/SectionLabel.tsx",
    purpose:
      "The eyebrow every doc 14 section opens with: an 11px tracked uppercase title, one quiet caption of at most a sentence and one link at the right that takes the question elsewhere. `eyebrowClass` is exported for an eyebrow that is a label inside a control, and ListPanel composes this one as its header.",
    variants: ["title only", "with a caption", "with a link action", "with an owner chip (node slot)", "inside a summary", "as a panel header (Home's assets)", "inside ListPanel", "phone (44px floor claimed)"],
  },
  {
    name: "KpiStrip / Kpi",
    file: "components/surface/KpiStrip.tsx",
    purpose:
      "Desk headline metrics in one hairline-divided strip: label, value, comparable delta (DeltaChip's like-for-like verdict, withheld for incomparable periods) and an optional metric-specific spark, with the Not comparable and History unavailable verdicts visible. One InfoTooltip combines the exact dates and explanations; a selectable KPI and its info button are sibling controls, never nested.",
    variants: ["selected/static", "comparable delta", "not comparable (percentage withheld)", "no previous period", "visible history-unavailable verdict", "raw daily/monthly spark", "trailing/precomputed average", "compact method caption", "combined explanation tooltip", "separate selection/info controls", "provisional endpoint", "value tone (healthy / warn / error)", "footer slot", "phone: two KPIs side by side", "phone: three KPIs in one row of three (bead ro-ujb9.13)", "phone: four or more KPIs in one swiping row, the selected one brought into view (bead ro-ujb9.13)"],
  },
  {
    name: "DailyRevenuePanel",
    file: "components/DailyRevenuePanel.tsx",
    purpose: "Saved daily revenue estimates with reporting coverage, exact dollar values and calendar gaps. Composes HeroChart bars and KpiStrip; the registry has no existing composition that owns daily earnings coverage and estimate context.",
    variants: ["reported earnings", "partial subtotals and missing assets", "zero", "missing dates", "no reports", "keyboard and date table", "mobile"],
  },
  {
    name: "HeroChart",
    file: "components/surface/HeroChart.tsx",
    purpose:
      "Interactive desk time series, independent of the Wall's purpose-built charts: calendar-aligned daily lines and bars, monthly and step forms, missing-date breaks, signed or zero-based scales, provisional markers and per-series toggles with line patterns that identify series without colour. Pointer, touch and keyboard inspection expose dated values, a View data table gives the equivalent semantic view, and ChartEventMarkers anchors each annotation's explanation.",
    variants: ["single/multiple series", "daily bars with zero and gaps", "outlined partial bars with dated coverage notes", "explicit calendar end", "series toggles and line patterns", "monthly", "signed (zero line inside plot)", "step", "average on/off", "weekend bands", "event hover/focus/tap", "grouped events with original dates", "provisional endpoint", "missing-date breaks", "pointer/keyboard dated values", "exact values with compact axes", "accessible data table", "180px pair height", "empty"],
  },
  {
    name: "ChartEventMarkers",
    file: "components/ChartEventMarkers.tsx",
    purpose:
      "Event-specific chart explanations for the desk HeroChart without replacing its geometry: each marker a 44px button with an anchored disclosure on hover, focus or tap, nearby events sharing a target at narrow widths while the disclosure keeps every original date, label and detail.",
    variants: ["single event", "same-date events", "nearby dates grouped", "full original detail", "hover/focus/tap", "dashed-line target", "Escape/outside dismissal", "existing Wall glyph retained", "viewport-clamped disclosure"],
  },
  {
    name: "ChartLine / ChartArea / ChartDot",
    file: "components/surface/ChartMarks.tsx",
    purpose:
      "The charts' one language (doc 14 § Charts): ChartLine, a monotone-smoothed line with `ghost` and `projection` forms and an optional casing over bars; ChartArea, the wash under a line with an optional feathered end; ChartDot, a round point with hollow, halo and pulse forms. All three take their colour from currentColor and ease to a new shape when a poll changes it.",
    variants: ["solid line", "ghost comparison", "projection", "cased line over bars", "wash", "wash feathered at now", "dot sm/md/lg", "hollow dot", "halo", "pulse (live)"],
  },
  {
    name: "MinutePulse",
    file: "components/surface/MinutePulse.tsx",
    purpose:
      "A site's live users minute by minute: one bar a minute for the last 30 minutes scaled to the busiest, the newest five in full ink and the rest muted, an inactive minute a tick on the floor and an uncovered minute nothing. Colour from currentColor; sizes row, roomy and focus.",
    variants: ["live", "dimmed", "quiet minutes", "unread minutes", "row", "roomy", "focus"],
  },
  {
    name: "Sparkline",
    file: "components/surface/Sparkline.tsx",
    purpose:
      "Compact desk trends at three standard sizes (KPI 64x22, table cell 96x24, full-width 30px high), no axes or grid; raw, trailing-average and precomputed-average modes describe their method and span accessibly, with optional pointer, touch and keyboard readouts. Drawn by ChartMarks: missing points break the line, provisional endpoints are hollow, empty data draws a dash with its reason. SERIES_TONE_CLASS owns the series tokens.",
    variants: ["kpi size", "table-cell size", "wide", "area", "raw daily/monthly values", "trailing average", "precomputed average (no double smoothing)", "dated method description", "plotted-value readout with raw value separate", "pointer/touch/keyboard", "provisional endpoint", "provider/financial/comparison tone", "single point", "missing-point break", "empty with accessible reason"],
  },
  {
    name: "SmallMultiple / SmallMultipleStrip",
    file: "components/surface/SmallMultiple.tsx",
    purpose:
      "A row of comparable measures in one bordered strip (doc 14): label, figure, what the figure is against ('avg 122 / day') and a full-width filled sparkline behind it. The strip is the boundary and the cells are hairlines.",
    variants: ["five across", "six across", "two columns on a phone", "no series (figure only)", "headline unit", "comparison below headline", "explicit raw history", "dated chart caption", "secondary line", "hover readout"],
  },
  {
    name: "ListPanel / ListRow",
    file: "components/surface/ListPanel.tsx",
    purpose:
      "The desk's one list of things that need something (doc 14): a SectionLabel header with a quiet count and one 'All' link, three rows by default with the rest disclosed behind an expander, and a row that expands in place to its evidence and actions. A row's mark is a ring plus a glyph, `marks` forwards data attributes onto its <li>, and `rowActions` puts a row's one decision beside its value with `below` holding the answer box it opens.",
    variants: ["three rows", "more behind the expander", "row expanded with evidence and actions (chevron)", "navigation via to with optional returnTo (the › disclosure chevron, bead ro-ujb9.13)", "static row (no affordance, no hover)", "two-line title", "captionWrap retains essential dates/status in a closed row", "error / warn / info / ok marks", "custom glyph", "value including zero with a micro label", "no value", "header link", "empty", "grouped by subject (first row of each of the first three groups; the expander opens every row in place)", "decision on the row (rowActions: Approve, Answer / Dismiss, File task, a source's Connect in place of its value, kept on the row's line on a phone with rowActionsInline — bead ro-ujb9.96.7.5)", "answer box under the row (below)"],
  },
  {
    name: "StatusBanner",
    file: "components/surface/StatusBanner.tsx",
    purpose:
      "One line at the top of a surface for exactly as long as its state is open (doc 14): a ProgressRing or a SeverityDot, a bold lead, one sentence, one link; `open={false}` renders nothing. AppUpdateNotice composes it for a changed or unavailable app release (D41).",
    variants: ["setup ring (n of m)", "severity dot", "no action", "link action", "button action", "closed (renders nothing)"],
  },
  {
    name: "About",
    file: "components/surface/About.tsx",
    purpose:
      "The one disclosure per screen that holds the prose (doc 14 principle 3): what the numbers are, where they come from, what provisional means. A native `<details>`, closed by default; `defaultOpen` exists for the gallery and a first run.",
    variants: ["closed (the default)", "open", "custom summary"],
  },
];
