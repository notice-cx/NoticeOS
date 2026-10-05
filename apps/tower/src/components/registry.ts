// Machine-readable component index (doc 14: "the component registry is law").
// Check this BEFORE creating any component; a near-duplicate is a rejected
// completion, not a style note. Keep it in sync with REGISTRY.md and the
// /dev/kitchen-sink route: every entry must render there, in every state unless
// REGISTRY.md's "Kitchen-sink coverage" table records the exception and why.
//
// That sentence is now a GATE rather than a request (bead ro-6bhm):
// scripts/component-registry.test.mjs fails the build when a component under
// components/ has no entry here, when an entry names a file or an export that
// is gone, when an entry has no row in REGISTRY.md, or when it has no demo on
// the kitchen-sink page. KitchenSinkRoute imports this file and renders the
// entry names as the gallery's contents, so the index a reader sees IS this
// array — an index nothing reads is a suggestion.

export interface RegistryEntry {
  name: string;
  file: string;
  purpose: string;
  variants: string[];
}

export const COMPONENT_REGISTRY: RegistryEntry[] = [
  {
    name: "DemoViewerStatus",
    file: "components/DemoViewerStatus.tsx",
    purpose: "One synthetic/read-only identity on the desk and Wall, with scenario cutoff separate from real completed generation age (ro-ujb9.256.4). Unknown stays unknown and page polling never refreshes it. Presentation-only gallery inputs do not change viewer policy. Registry justification: operational status and source freshness badges do not identify the whole installation as synthetic.",
    variants: ["ordinary installation (absent)", "generation time unknown", "completed generation aging"],
  },
  {
    name: "IntegrationHealthPanel",
    file: "components/IntegrationHealthPanel.tsx",
    purpose: "Connections grouped by provider, then site (bead ro-ujb9.96.7.3), under a strip of four counts (sites failing, overdue, reports missing, sites working) that draw their daily record once three days exist (bead ro-ujb9.96.7.26): each provider is one row with its one connection status and compact facts (sites failing, reports missing, reports incomplete); the sites that need the operator sit under it with their own status, a failing site's reason on the row, and what to do plus which operations and missing dates when opened. Scoped to one provider it is that provider's Sites list. Unknown stays unknown: without a current read nothing reads fine. Replaces the operation list that repeated the provider name and took the worst of every stored attempt.",
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
      "The countdown as configured, read-only — the face the desk's CountdownWidget wraps with its Configure button and form. Registry justification (bead ro-ujb9.82): nothing drew the countdown without its settings form, and a module is downloaded whole. The seven-segment LocalClock and the TV-sized faces that lived beside it left with the pre-D28 Wall (bead ro-trai.20): the TV's time and countdown are WallStrip's.",
    variants: ["proximity far/approaching/near/soon/imminent", "reached (gray, off the ramp)"],
  },
  {
    name: "CountdownWidget / CountdownEditor",
    file: "components/DashboardWidgets.tsx",
    purpose:
      "The desk's configurable countdown: CountdownFace plus a Configure button and the countdown's one settings form (emoji, words, moment — one Save, one changeset, D18). CountdownEditor is exported for the Wall editor's strip pane, which renders this very form rather than a second one (doc 14's one-representation rule). The clock row this file also drew — seven-segment clock, meetings panel, countdown — left with the pre-D28 Wall (bead ro-trai.20).",
    variants: ["read-only face", "Configure open (the form)", "no countdown yet (the form makes the first)", "saves paused"],
  },
  {
    name: "WallCanvas",
    file: "components/WallCanvas.tsx",
    purpose:
      "The TV drawn from a layout DOCUMENT rather than a fixed tree (epic ro-lzmq, docs/15 flow D). Takes a WallLayout from shared/wall-layout — saved at config/tower.json /wall, defaulting to D28's arrangement (bead ro-trai.11, docs/25 § Regions: the strip; a column of revenue beside Needs you over the site rows; the full-height feed) — plus the polled payload, and renders rows top to bottom: each row a grid whose tracks are minmax(min(<spec.minWidthRem>rem, 100%), <widget.width>fr) in widget order, with the one `fill` row taking the height the others leave. It owns no widget of its own; D28's five types map onto components already in this registry (WallStrip, RevenueHero, NeedsYou, SiteRows, WallFeedWidget) — the seven the old Wall drew are retired types, a saved layout naming one drawn as the default — which is what keeps flow D's rule — the operator arranges tiles and never authors tile types — true in code. The tracks are an inline style because Tailwind generates arbitrary values from source text and would never have generated one computed from saved data; colour, type and spacing stay classes. The tracks are drawn in the TV's layout (`tv:`): the TV, the editor's preview, and every landscape screen at least 1024 px wide, which draws the TV's box zoomed by one scale (wallScreen, bead ro-trai.31); on a portrait tablet or a phone rows and columns dissolve and the widgets stack in one full-width column in each type's `stackOrder`: the strip, revenue, the site rows, Needs you, the feed (operator 2026-09-23, beads ro-trai.24 and ro-trai.29). A widget with a maxWidthRem (the feed, 30 rem) never takes what is left: past its cap the uncapped tracks widen, and on the TV the tracks are exactly the fr split. A widget with nothing to show renders nothing AND yields its track, and a row whose every widget hides renders nothing at all (lib/wall-widgets); D28's five each draw their own empty state, so none hides today. The `assets` setting narrows the site rows and Needs you to the listed ids in the LAYOUT's order, narrowing a cross-asset row to the assets this Wall shows rather than dropping it. The strip's time, meeting and countdown share one one-second tick held in a context inside the canvas, so the site rows are not redrawn every second. D28's frame is tokens: rows 20px apart, regions side by side 28px apart. `editing` is a render prop whose return value REPLACES a widget in its own grid track: the editor at /wall/edit previews through the exact component the television uses, and /wall passes none and imports nothing about editing. Since beads ro-ujb9.82 and ro-trai.11 that holds for the widgets too: every widget module the canvas imports is read-only, and the route-split journey fails if rule tuning, the config registers, task code or a retired widget's module reaches /wall.",
    variants: ["D28 default", "a pre-D28 save drawn as the default", "rows reordered", "widget removed", "widths and floors from the document", "site filter", "fill row", "editing slot", "column"],
  },
  {
    name: "WallFeed / WallFeedWidget",
    file: "components/wall/WallFeed.tsx",
    purpose:
      "The Wall's live feed column (bead ro-trai.9, docs/25-the-wall.md § Feed): what just happened, newest on top, from GET /api/wall/feed — stored events the Worker unions and folds, never synthesized activity. Each row is one line: a glyph tile toned by kind (tokens only; the glyph carries the kind so colour is never alone), the kind label and site, one sentence, and a clock time ('12:24', '7:40p' for yesterday). A row the column has not drawn slides in at the top (240 ms CSS keyframes, none under reduced motion) and keeps its tone's tint for two minutes; at most one arrival every 2 s, a burst queued oldest first. Rows older than 12 hours drop to muted ink; only whole rows are drawn; a failed poll keeps the rows, dims the live dot and says Reconnecting. Registry had nothing that draws an event stream: AttentionRail rotates open work and Timeline is the desk's per-asset history with its task badge. WallFeedWidget is the Wall's widget: the column polling its own 30-second read (useWallFeed).",
    variants: ["live rows (every tone)", "aged rows muted", "reconnecting (last rows kept)", "empty window", "arrival and whole-row fit (component test and journey)"],
  },
  {
    name: "DeltaChip",
    file: "components/DeltaChip.tsx",
    purpose: "Trend direction glyph and magnitude, neutral by default, with opt-in green/red intensity for completed like-for-like comparisons. Today's comparable-hours pace uses paceTone: positive green, zero neutral, negative through −40% amber, below −40% red. paceDirectionLabel supplies ahead, behind or on pace; the Wall shows it beside the arrow and percentage (operator 2026-09-30, ro-trai.48). One derivation colors chips and today's chart. A reporting-timezone change withdraws the color verdict; callers pair the still-visible percentage with TimeZoneCaveat. Percentage and comparison-window calculations remain independent of presentation.",
    variants: ["neutral", "positive subtle/clear/strong", "negative subtle/clear/strong", "flat", "verdict withdrawn (window spans a timezone change)", "pace on / a little behind / far behind"],
  },
  {
    name: "TimeZoneCaveat",
    file: "components/TimeZoneCaveat.tsx",
    purpose:
      "The shared warning glyph for a COMPARISON whose window straddles a reporting-timezone change (bead ro-tzq): the figure still shows, the glyph says it is not like-for-like and the title names the change. Its own file since bead ro-trai.14 (it lived beside the old Wall card, so the site page downloaded that card to draw one glyph). Registry justification: DistortedDayMarks marks a distorted DAY on a chart; nothing marked a straddled COMPARISON beside its chip.",
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
      "Neutral asset identity glyph for card/detail headers, loaded from the asset's own favicon with a monogram fallback; integration and alert state stay in their dedicated indicators. IT IS DECORATION and is aria-hidden (bead ro-hou2): all twelve call sites draw it beside a visible name, and the wrapper's old title leaked into the accessible NAME of every link and row it sat inside (accname step 2I) — the sidebar row announced as 'Example favicon Example'. A call site where the glyph would be the ONLY identity has to give the asset a name of its own; this component will not carry one.",
    variants: ["site icon", "failed-image fallback", "card", "detail", "decorative (no accessible name)"],
  },
  {
    name: "AgeBadge",
    file: "components/AgeBadge.tsx",
    purpose:
      "Per-tile data-age badge; amber past 2× lane cadence. Absence is a word and says WHICH absence (bead ro-kukv.10, doc 17 rule 6): a lane nothing has ever arrived on reads 'never' under a struck-through calendar, a timestamp the badge cannot parse reads 'unknown' under an alerting clock, and neither is an em-dash. The shared formatAge is deliberately unchanged — fifteen call sites interpolate it as '{age} ago', where a word would produce 'never ago' — so the word lives in the only place that knows it was handed no timestamp at all. Its sibling export NoNightlyReport (bead ro-ujb9.96.8) is the third absence — an asset declared as sending no nightly report owes none, so its slot is the Not using slash and 'No report' in the neutral token, never amber and never 'never'.",
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
      "Whether an asset's newest weekly DataForSEO collection has been triaged, on AgeBadge's chassis (bead ro-rkp). Three states told apart by GLYPH and tone with no status word anywhere — hourglass pending, clipboard-check reviewed, warning triangle overdue — and only the overdue one leaves the muted tone, taking `error` so a missed weekly obligation reads as a problem across a room. The visible text is always a duration (time left, age of the review, time past the deadline); direction is the glyph's job. Fourth state is ABSENCE: no collection landed inside the window, no review filed yet, or a beads snapshot predating the field all render nothing at all, because a marker on every card saying it has nothing to review would be portfolio-wide noise. A review is matched against the newest panel DAY, never against its own close time: a review about an older day falls back to pending rather than claiming the new panel was read, and a backfill writing a later finished_at for an older panel cannot promote it. TWO NOUNS, chosen by config/serp-panel.json membership (bead ro-z0g): a panel asset's marker reads 'SERP panel', an asset that buys none reads 'Signal collection' — the same pair the runner's filer titles the bead with (panelReviewTitle in scripts/runner/panel-review.mjs). Membership picks words only; since ro-478 every collecting asset owes the identical read.",
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
      "The asset page's statement of the obligation PanelReviewBadge marks on the Wall (bead ro-elf). The card is a drill-down TARGET — an overdue badge means 'open this page and act' — and the page said nothing at all about the review, so this spends the room the card lacks on the three facts the badge could only fit into a hover title: WHICH panel day is owed, WHEN triage was due, and the BEAD to close, ready to paste into `bd show`. Composes the badge itself rather than restating it, and takes the day from the shared `panelDayOf`, so the words can never name a different day than the marker beside them. The deadline is stated only while it is still the operator's; a finished review drops it. Only the overdue row leaves the quiet surface, taking the badge's error tint. Absence is inherited exactly, and it follows the LANDING rather than config/serp-panel.json (ro-1tu): no collection inside the window, or none filed, renders nothing whatsoever — while an asset that simply buys no panel DOES render, labelled 'Signal collection' instead of 'SERP panel' (bead ro-z0g).",
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
      "The AI-Overview mark for one tracked query, ONE PER SURFACE it was read on (bead ro-glf). Three weights and no color — solid cites us, outline shown-and-uncited, ghosted read-and-clear — because severity color belongs to the attention system and an AI Overview is a fact about the result page, not an alert. The fourth state has no weight on purpose: `unknown` is an overview that never loaded on that pull, and absence must keep meaning 'nobody could answer', which is why the read-and-clear case earns its own ghosted mark instead of no mark. Phone then desktop in the readings' own order (bead ro-e46.2), each mark naming its surface once more than one was read; a single-surface term draws one unprefixed mark. `unknownSurface` is the ONE thing its two callers disagree about and is a prop rather than a default: SerpPanelBoard passes 'blank' because its cell sits in a fixed row grid and a collapsed pair would slide the desktop mark under the phone column, while QueryVisibilityRankings passes 'omit' because its pair sits inline beside the decision chip with no column to align to and its evidence line already spells the unchecked surface in words. It exists because both files carried their own copy kept identical BY A COMMENT — fair at two lines off two booleans, a rejected near-duplicate once ro-e46.2 grew it into twenty lines with a device pair, surface prefixes, a shared state map, and data-aio-device attributes.",
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
      "How the asset's tracked-query SERP panel is DOING, before what each row is (bead ro-282.3). Six counts lead — tracked, ranking, top 10, top 3, AI Overviews, citations — the altitude a local markdown report opened with and the only line that survives a glance; the per-query rows follow, best rank first. Three semantics it exists to preserve, each a lie the obvious rendering tells: (1) the panel is a FIXED-DEPTH pull, so a query with no bestRank has no result inside the tracked depth and reads `>20`, never a blank and never 'not ranking'; (2) an unstated depth stays unstated — a legacy row with no tracked_depth gets 'inside tracked depth' with no number and an em dash, never an assumed 20; (3) unknown AI Overviews are unknown, so the two AI tiles count only rows the panel could answer for and QUOTE that denominator ('4 of 7 checked'), since dividing by the tracked count would spend every unknown as a 'no'. Counts come from the shared serpPanelScoreboard so the page and its test cannot hold two opinions of 'top 10'. The per-query AI glyph is the registry's AiOverviewGlyphs — literally the component QueryVisibilityRankings renders (bead ro-glf), not a second copy of its vocabulary. Absence is total: no panel, no block, an older snapshot, or a malformed one all render nothing — six zeroes on an asset that buys no panel would be a score it never played for. ROWS ARE TERMS, never (term, device) rows (bead ro-14d.1): the panel reads each term on the phone and the desktop, serpPanelTerms is the one way back from rows to terms, and every count goes through it — so a device split multiplies no denominator and a term unknown on both surfaces stays ONE unknown. The device shows as ONE glyph PER SURFACE in a single cell, phone then desktop, each labelled 'Phone:'/'Desktop:' (bead ro-e46.2, doc 17): doubled rows would multiply the tiles and a folded mark would answer a question the operator did not ask. One surface read draws one unprefixed mark; a surface whose overview never loaded holds a blank slot with the reason on hover. Rank stays ONE number, best across surfaces, with the per-surface split on hover. GROUPED BY THE BET each term measures (bead ro-282.5): a labelled panel gets a per-cluster line ('X of N in top 10', plus the AI clause only where that cluster was checked) computed by the SAME serpPanelScoreboard over that cluster's rows. Additive in both directions — a panel that labels nothing renders the identical single ungrouped list, and a partly-labelled panel keeps its unlabelled terms in one trailing run with no heading and no count line, never a fake cluster called 'Unlabelled'. CURRENT RESULT-PAGE COMPOSITION sits directly under each term since ro-e46.3: one compact lane per readable device, numbered top-three domains, organic-result count, our slot count and second URL, plus page features. The lane is absent for an unread or legacy result page, so unknown never becomes an empty neighborhood. One snapshot states only who is there now; movement remains a designed absence until a second collection is retained.",
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
      "Which side of the ledger's honesty split a figure came from — booked (money somebody confirmed) or forecast (reported, not reconciled). Composes StateChip: solid dot + affirmative for Reconciled, hollow notch + na for Forecast, so the split carries on FILL and TONE and survives a glance across a room or a grayscale screen. Extracted from the portfolio headline (bead ro-uwo.2) once asset cards needed it, and now also worn by the asset page's P&L tiles and recent-entries table (bead ro-jk7), which had grown a third visual language — a lowercase-word Badge saying 'reconciled'/'estimated' — for the fact the other two already stated. `bookingChipState` maps the STORE's word on a raw ledger row to the chip's, so rows and rollups over those same rows cannot drift apart.",
    variants: ["booked", "forecast", "from a raw row's booking_state"],
  },
  {
    name: "HandoffBeadBadge",
    file: "components/HandoffBeadBadge.tsx",
    purpose:
      "Whether a finding has already been filed as work in the asset's own repo (bead ro-248), joined by the handoff's `noticeos_key` metadata. Two encodings and no status word: the GLYPH carries the state (filled dot filed-and-open, circle-check recorded closed) and the weight steps down once closure is recorded; the visible text is the BEAD ID, because that is the actionable string — the commit quotes it, the watch window is keyed to it, and since bead ro-l1ed.3 it LINKS to /tasks/<id>, so the id opens the whole bead instead of being something to select and paste into a terminal. Both faces stay MUTED by design: a finding's severity is its loudest fact and a filing marker must not rival it. A closed bead is deliberately not a success tone — the key chain says closure records a decision, not shipment or outcome, and only a watch-window verdict retires the finding. Absence renders nothing at all, and covers two different facts on purpose (nobody filed one, or the register could not be asked) because neither licenses the card to say more.",
    variants: ["open", "closed", "closed undated", "not filed (renders nothing)"],
  },
  {
    name: "PriorityBar",
    file: "components/PriorityBar.tsx",
    purpose:
      "A queue's shape by priority, P0 at the hot end: SegmentBar with the P0..P4 ramp as its preset (bead ro-pbzu.8) — an ink-weight ramp that never wears an attention hue, because a task's priority is not a severity (doc 14, bead ro-ujb9.200) — so a hot band never vanishes into rounding and the bar carries its breakdown as a sentence. Home's assets table draws it beside each site's open-work counts. priorityFill(band) (bead ro-ujb9.240) hands the same ramp's ink to a split of the queue drawn elsewhere — the Sites page's urgent share — so no second scale sits beside the bar. Its own file since bead ro-trai.20 (it lived in the pre-D28 Wall's task panel). Registry justification: SegmentBar is the geometry; this is the one priority ramp over it.",
    variants: ["mixed priorities", "one hot band in many (minimum width)", "all default priority (calm)"],
  },
  {
    name: "ReportFreshness",
    file: "components/ReportFreshness.tsx",
    purpose:
      "How old a site's nightly report is — one age, amber past twice its cadence — or the neutral No report mark when none is expected (D29 amended). Home's assets table reads it in its Reported column. Its own file since bead ro-trai.20 (it lived beside the pre-D28 Wall card). Registry justification: AgeBadge ages any timestamp against any cadence; this is the nightly report's one rule, including when no report is owed.",
    variants: ["fresh", "stale (amber)", "no report expected", "declared none", "without the Updated word"],
  },
  {
    name: "SegmentBar",
    file: "components/SegmentBar.tsx",
    purpose:
      "The ONE segmented mass bar: how a total DIVIDES, as proportion. Named segments carry a token fill class (never a color literal); a non-empty segment never paints below its 3px minimum, so a lone P0 among 121 beads cannot vanish into a rounding error and make the bar lie by omission; and the bar always carries a sentence as its aria-label, because a proportion with nothing named is decoration. Registry justification (bead ro-pbzu.8): the shape existed only with the P0..P4 ramp welded into it (PriorityBar), and Meter — the neighbour — answers ONE value against a CAP with over-cap as its own amber state, so it cannot draw two meanings at once. PriorityBar is now this component with the priority ramp as its preset.",
    variants: ["two-segment share (warn + rest)", "severity split (error + warn)", "priority ramp (via PriorityBar)", "one band in 121 (minimum width)", "empty track"],
  },
  {
    name: "TuneRate",
    file: "components/TuneRate.tsx",
    purpose:
      "How often the operator answered one alert rule by tuning it (docs/15 flow E, bead ro-ayxy), over settled flags grouped by rule_id. Settings and the firing alert use this same component. SegmentBar shows the tuning share beside its counts and percentage; no firings or no settled alerts have their own empty states. Open tunes are named outside the settled rate. Each noticeos.flag_tunes row counts one decision, and a positive count prints Tuned N times in the window. TuneProposal offers File task or Keep it as it is when the rate crosses the proposal line with enough settled evidence; it never changes a guardrail. A decline belongs to the viewer and that evidence signature, so changed counts can ask again. Registry justification: SegmentBar owns the shape, while TuneRate owns the figures, denominator, empty states and proposal.",
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
      "The segmented completion ring: n of m DISCRETE things done, in a badge-sized footprint. One arc per item with a real gap between arcs, so the fact is COUNTED rather than estimated off a swept angle and two adjacent finished items cannot merge into one longer one. Monochrome — filled arcs are foreground ink over the muted track, the same pair Meter uses — because progress is not severity (Stepper's rule) and a half-finished setup must not spend an alarm colour the real alerts need; the encoding survives greyscale and colour-blindness because it is ink against ground rather than hue. The title is REQUIRED and carries the whole sentence (what it counts and what is left), since it is both the hover and the only thing a screen reader gets. `sm` (16px) is drawn by a site Overview's setup banner (StatusBanner's ring) and beside each open watch's next check on the Activity tab — the two screens that still draw it (checked when bead ro-trai.25 retired Stat and the alert table); `md` (28px) prints the done count in its middle. Registry justification (bead ro-28ma): nothing counted discrete steps at badge size. Meter is ONE value against a CAP and turns amber over it — a checklist has no cap and cannot go over. SegmentBar is how a total DIVIDES into named parts, a different question from how much is finished. Stepper is the read-only lifecycle PATH. Wizard's summary rail is form layout — a vertical spine of steps that cannot sit beside an asset's name. All four are LINEAR and full width, and at 16px a linear bar is three pixels tall and reads as a rule rather than a quantity.",
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
      "A page whose FIRST data read failed (bead ro-ujb9.218; docs/19 finding 15): the error dot, what could not be loaded in the page's own noun ('Couldn't load alerts'), why as a fact — the HTTP status the Tower answered, or 'No answer' when the fetch itself failed (`readFailureReason`) — and Try again, spinning while the retry is out. No sentence. `desk` sits where the page's first answer would; `wall` is the whole TV in its true black, whose own poll keeps trying underneath. A page that already holds a reading keeps it through a failed poll, so this is only ever the first read. Home, Sites, Alerts (open and history), Tasks, Integrations, the Wall, the asset page, Settings, the TV layout editor and Workflows draw it (the last three since bead ro-ujb9.242) — each said 'Waiting for the store…' or its own sentence before. Registry justification: EmptyState says a section HAS no data, a fact about the portfolio; RouteLoadFailure says the screen's CODE is gone and offers a new tab — neither says the store did not answer this read.",
    variants: ["desk · HTTP status", "desk · no answer, with a detail (the asset page's id)", "desk · retrying", "Wall (true black)"],
  },
  {
    name: "RouteLoading / RouteLoadFailure",
    file: "components/RouteLoading.tsx",
    purpose:
      "What stands in for a SCREEN while its code is fetched, and what a screen whose code can no longer be fetched becomes (bead ro-82x, the route split). Every screen is its own file since that split, so the first visit to an address waits for one. RouteLoading draws in the space the screen will take — the desk column (the page's own max width, padding and a full viewport of height, so the arrival moves nothing and adds no scrollbar) or the whole TV in the Wall's true black (`.wall-root` + `bg-background`) — and says only 'Loading': no number, no chart outline, no status colour and no page-shaped skeleton, because a placeholder that looks like data can be read as data, and a loading frame must never pass for a reading of the portfolio. The word waits 400ms before it fades in (`.route-loading-label`; no fade under reduced motion) because the code usually arrives before anyone could read it, while a polite status region announces it at once. The Wall's words are the ones the Wall shows while its first poll is out, so code loading and data loading read as one state. RouteLoadFailure is what a route resolves to when its import fails with the browser's could-not-fetch-module error — a tab opened before a rebuild or restart asking for files that are gone. It is drawn after the router has committed the new address. Its explicit Open app in new tab action keeps the current document and unsaved drafts intact (D41, bead ro-ujb9.298). Desk, Wall, panels and palette never reload automatically or store drafts. Neither wears a severity colour: nothing about any asset is wrong. Registry justification: EmptyState says a section HAS no data, which is a fact about the portfolio; this says the screen has not arrived yet, which is not — reusing it would make a loading frame claim an empty portfolio. The Wall's own 'Loading the Wall…' is its data state, inside the route, and cannot run before the route's code exists. PARTS OF A PAGE (bead ro-ujb9.84): the asset page's tabs and the command palette are fetched when opened (`lazyPart` in lib/lazy-route.tsx), and use the same two components in two more frames. `panel` is an asset tab's: the panel's own width and half a viewport of height under the header and tab bar that did load, 'Loading this section…' on the same delay, and 'This section didn't load' (an h2, since the page heading is still there) with the same explicit new-tab action. It is only seen on a first load whose tab code is slower than the asset's report — a tab switch keeps the previous tab until the next one's code is here. `palette` draws NOTHING while the palette's code arrives (an empty search box would be a control that does not work), and its failure is a box where the palette would be, 'Search didn't load', with Close beside the new-tab action and Escape and the backdrop dismissing it like the palette itself.",
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
      "Each source's one status as a row of marks: the asset header and Home's asset table (bead ro-ujb9.96.7.16). It draws `sourceReadings` (shared/connection-status laneStatus), the status the asset's Data sources rows and Integrations show, in IntegrationStateChip's tone and word: Working a green check, Failing a red !, Overdue an amber clock, Collecting a dashed circle, Unknown or Not checked a ? in a dashed box, Not connected a dashed box, Not using a slash, Doesn't apply a bar. The mark's accessible name is 'source: status'; One shared InfoTooltip trigger opens all source states and recorded evidence by hover, focus or tap, without expanding the compact row into separate phone targets. The Wall's TV-sized row left with the pre-D28 Wall (bead ro-trai.20); a failing source affects the site's compact health bars there.",
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
  },
  {
    name: "ExecutiveFindingsList",
    file: "components/ExecutiveFindingsList.tsx",
    purpose:
      "The ranked findings grouped by kind (Marked first, then warning signs, recommendations, discoveries, insights), each heading carrying its count, the rank running on unbroken across groups, and only the top finding expanded initially (bead ro-ujb9.96.6.8). Compact rows retain every material scan fact and the register join while actions and evidence open one decision at a time. Dismiss answers with an Undo toast rather than a sentence promising reversibility; review and restore stay in the header. Nothing here mutates alerts or provider evidence; suppressed findings stay named behind one 'N more below the top 8' disclosure.",
    variants: ["grouped by kind", "dismiss with Undo", "one focused + compact queue", "active", "marked-first", "all-dismissed", "review-dismissed", "filed findings", "register unavailable", "cut findings named", "cut findings disclosed", "nothing cut", "watch the outcome (metric from the finding's sources)", "no composer behind it (renders no action)"],
  },
  {
    name: "AnalysisEvidence / RecommendationReview",
    file: "components/AnalysisEvidence.tsx",
    purpose: "Shared saved-analysis clock and applicability display for findings, query/page suggestions, Overview, Growth and Search. One request-scoped provider supplies exact-family latest attempts, task snapshot and recorded decisions/changes. Pure recommendationValidity returns STRUCTURED checks — per source its analyzed window, latest report and status; linked tasks and the releases that name them; the recorded decision — without a Current verdict (bead ro-ujb9.96.6.8). A passive row shows a neutral ValidityChip only when its state is not the default 'Not rechecked'; the expanded 'Source dates' popover draws RecommendationFacts as a table; the same fields travel into handoffs as short lines. Registry justification: report-age badges cannot establish whether an interpretation still applies.",
    variants: ["state chip (non-default only)", "source-dates table", "dated analysis", "old analysis with fresh page", "unknown analysis/source dates", "newer exact-family report", "later failed attempt", "recorded task closure", "exactly linked deploy", "outdated task photograph", "recorded dismissal", "explicit older analysis", "passive disclosure label"],
  },
  {
    name: "AlertVerification",
    file: "components/AlertVerification.tsx",
    purpose: "Visible source-verification state for an alert, separate from its first firing and recorded open/closed state. Registry justification: AnalysisEvidence describes saved interpretations, while alert verification must distinguish current source confirmation, unresolved last-known conditions, ended sources and recorded closure. Shared alertVerificationLabel fails closed for missing, malformed or future confirmation timestamps; source-specific recency remains the read model's decision. Interactive mode uses one InfoTooltip with exact detection/confirmation/evaluation times, source and reason. Passive mode is a plain neutral span, inherits the caller's type scale and adds no buttons to a ListRow control or Wall. Recorded closure never claims source recovery; not-applicable covers event and decision records rather than live conditions.",
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
      "The desk's tab bar: an ARIA tablist whose tabs are NavLinks, so the ACTIVE TAB IS THE URL — it survives a reload, a bookmark and Back, and one hash→tab map is all a deep link needs. Registry had no tab primitive, and the asset page had grown the thing tabs exist to replace: one very long scroll of collapsed question disclosures under a sticky Jump-to navigator, where a deep link had to open a `<details>` programmatically before it could scroll (doc 19 finding 11, bead ro-pbzu.4). Keyboard follows the WAI-ARIA APG with MANUAL activation — arrows and Home/End move focus, Enter or Space opens the focused tab — because a panel here mounts charts and tables and activating on every arrow press would render five panels on the way to the sixth. Roving tabindex, so the bar is one tab stop. Each tab may carry a `count` and a `glyph` slot, which is how a tab states its own condition (doc 14's 2026-09-04 visuals rule): the asset page's Alerts tab shows the open count beside a SeverityDot of the worst one, Activity the number of outcome checks still running, Sources a tiny segmented working/degraded/not-set-up bar. A tab with nothing to say carries nothing — a zero badge on every tab is noise, not state. `TabPanel` is the single panel the router swaps; only the active tab's content mounts. A tab may also carry `onIntent`, called when a pointer rests on it or the keyboard focuses it — the moment before it is opened; the asset page fetches that tab's code there (bead ro-ujb9.84). THE STRIP IS ONE LINE THAT SCROLLS INSIDE ITSELF (bead ro-md80), not a wrapping row: seven asset tabs wrapped into three ragged rows on a phone, and a wrapped tablist draws the selected tab's underline in mid-air above the divider it belongs to. The divider hangs on the wrapper so the scroller cannot clip it, and the selected tab is brought in by the strip's own scrollLeft rather than scrollIntoView, which would also scroll every ancestor and jump the page.",
    variants: [
      "plain tabs",
      "active tab",
      "count badge",
      "glyph + count (severity dot)",
      "segmented ratio glyph",
      "keyboard roving focus",
      "strip scrolled to the selected tab",
    ],
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
      "Monospace path chip pointing at the file/table that OWNS a fact (doc 15 principle 10); LAN-safe click-to-copy. Badge is neutral chrome, not a copyable path affordance. An optional `hint` retargets the hover sentence at a reference to READ (the doc section a not-set-up source's setup steps live in) instead of an owner to edit.",
    variants: ["idle", "copied", "copy failed", "doc reference"],
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
      "Annotation timeline (deploy/model-change/config/incident/autonomy/external), relative time + absolute on hover. No vertical event list existed. AN EVENT NAMES THE TASK THAT CAUSED IT (bead ro-4ko): a ref resolving to a bead in the asset's beads_snapshots slice renders the same HandoffBeadBadge the finding card carries — one representation, never a badge beside a mono string — while an unresolved ref (a commit sha, a bead older than the snapshot, a null slice) stays the mono string it always was, since an unresolved ref is not a task-less event. A closed bead here is recorded closed, not proof of shipment or outcome: the verdict comes from a watch window carrying the same id.",
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
      "Supporting desk explanations on demand through a neutral info button or compact custom text. Registry justification: EvidencePopover is a structured health-evidence dialog and ChartEventMarkers owns dated chart events; neither is a general explanation affordance. Hover, keyboard focus and tap open a hoverable portalled panel clamped to the viewport; Escape and outside interaction dismiss it, and a page scroll moves it with its trigger rather than closing it (bead ro-ujb9.14), so a trigger reached by Tab below the fold stays open. A compact text trigger may be a missing value's dash. Click and keyboard events do not activate a containing navigation row. Children and custom triggers are noninteractive; actionable content belongs in a dialog or disclosure. Keep metric name, unit, essential period and material warnings visible. Never nest its button inside another button or link; selectable KPIs place it beside their selection control. Wall presentation is excluded.",
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
      "ONE PANEL, ONE PRESS: connect a provider on /integrations (bead ro-ujb9.96.7.1, epic ro-ujb9.96.7). Paste what the provider issued, press Connect; the ingest asks the provider FIRST and stores the credential only if it accepts, so the panel goes Checking → Key accepted (with what the answer proved: Bing's verified-site count, DataForSEO's credit) or shows the provider's refusal in plain words under the field. Registry justification: ProviderCard is the whole credential reference card with a four-step guided mode; nothing drew a single-screen save-and-test whose state can never run ahead of the provider's answer. Built for every provider kind the contract declares (IntegrationConnect); `key` is implemented, and the `next` slot after acceptance is where discovery and Start collecting go (bead ro-ujb9.96.7.2). Nothing is shown back: fields open empty, a refused secret is cleared, an accepted one leaves with the form.",
    variants: ["editing (empty, Get a key link)", "checking", "accepted: sites", "accepted: credit", "refused", "no answer", "field refused by the server", "cannot store yet (why at its top where the page has no banner)", "connected: status, Replace, Disconnect", "replaced: answer and Done", "accepted: region and projects (PostHog)", "sign-in (Google, GoogleSignInSetup)", "sheet", "inline (gallery)"],
  },
  {
    name: "ConnectionActions",
    file: "components/ConnectionActions.tsx",
    purpose:
      "THE CONNECTION'S OWN ACTIONS (bead ro-ujb9.96.7.10): Replace (named for the secret — Replace API key, Replace login) and Disconnect, drawn on the connection itself: ConnectPanel's connected view (its `manage` prop) and the top of a provider's page (ProviderCard, every step), instead of a Settings step and a typed id. Replace opens the key form; for a provider that connects in the panel the new key is shown to the provider before it is kept, so the old one collects until the new one passes, and a failing key's Replace leads. Disconnect keeps one confirmation because it cannot be undone: the sites that stop and what is deleted, as values, and a press that names the provider. Registry justification: the actions were private to ProviderCard; the panel needed the same pair.",
    variants: ["idle", "replacing (pressed)", "failing (Replace leads)", "no Replace (sign-in)", "confirming", "disconnecting", "refused"],
  },
  {
    name: "WhatLands",
    file: "components/WhatLands.tsx",
    purpose:
      "WHAT A NOTIFICATION CHANNEL CARRIES (bead ro-vu8d.23; its own file since ro-ujb9.96.7.14): each condition the ingest's notifier sends (NOTIFIED_CONDITIONS, one declaration) as a label and its cadence. Drawn on Discord's provider card and above the field in Discord's connect panel. Registry justification: it was ProviderCard's private helper; the connect panel needed it without carrying the whole card into a site's Data sources.",
    variants: ["will send (not connected)", "sends (connected)"],
  },
  {
    name: "CopyCommand",
    file: "components/CopyCommand.tsx",
    purpose:
      "ONE COMMAND, VERBATIM, WITH COPY BESIDE IT (bead ro-ujb9.96.6.19): the press for a state only the operator's own terminal clears — the credentials table's migration, a bootstrap key, the notifier's table, the legacy-env import. The Integrations page's setup blockers draw their state (StatusBanner's lead) and this; the notification and legacy-env cards draw it beside their chip. Registry justification: it was ProviderCard's private helper; the page's blockers needed the same control, and two copies would drift.",
    variants: ["a migration command", "a key command beside its binding", "copied"],
  },
  {
    name: "ConnectBlockers",
    file: "components/ConnectBlockers.tsx",
    purpose:
      "WHY NOTHING CAN BE CONNECTED YET (beads ro-ujb9.96.6.19, ro-ujb9.204, ro-e70g): one warn StatusBanner per blocker — no credentials table, no encryption key, an unusable key — its lead, the environment binding where there is one, and the command that clears it (CopyCommand). Said once per screen, where Connect is: the top of /integrations, or inside the connect panel a site's Data sources opens (ConnectPanel's `blocked`), since that page has no banner of its own; a panel over /integrations draws none. Registry justification: the Integrations page drew these inline; the site's connect panel needed the same state and command, and two copies would drift.",
    variants: ["no encryption key (binding and command)", "no credentials table (command only)", "in the connect panel"],
  },
  {
    name: "GoogleSignInSetup",
    file: "components/GoogleSignInSetup.tsx",
    purpose:
      "GOOGLE, CONNECTED BY SIGNING IN (bead ro-ujb9.96.7.7; mockup frames d-hosted, d-selfhost): ConnectPanel's body for a provider connected on its own consent screen (connect kind `sign-in`). Hosted — the host's verified OAuth client already there — it is the two read-only grants as chips and Continue with Google. Self-hosted it is the one-time setup as three presses and one file: turn on the three APIs and create a web client (deep links into the Cloud console, this Tower's redirect address with Copy), then drop the client_secret.json Google hands back, whose two values are stored and whose redirect list is checked against this address (a desktop or service-account file is refused, nothing stored). A consent screen in Testing signs out after seven days: a chip with Publish. An address Google will not return to makes the press the loopback address. After consent the panel reopens on the account's GA4 properties and Search Console sites, matched on one row (SitePicker). Registry justification: ProviderCard's GoogleSignIn is the page's five-step reference card with typed fields; the panel needed the same sign-in as one screen and a file.",
    variants: ["self-hosted: no client (steps, file, Testing chip)", "self-hosted: client stored", "self-hosted: redirect address not in the client", "self-hosted: file refused", "hosted: grants and one button", "address Google refuses: loopback press", "cannot store yet"],
  },
  {
    name: "SiteTokens",
    file: "components/SiteTokens.tsx",
    purpose:
      "A TOKEN PER SITE, PASTED ON THE SITE'S ROW (bead ro-ujb9.96.7.9, mockup frame b-clarity): ConnectPanel's body for a provider that issues one token per project and offers no free call to prove it (Clarity, connect kind `site-tokens`). Every site the provider serves is a row; a token arriving whole (a paste) is saved at once through PUT /api/integrations/:provider/site-token — merged into the per-site map in the ingest, never replacing another site's — and leaves the screen; typing waits for Enter or leaving the field; a refusal is said on the row. A held site wears IntegrationStateChip from the connection model. The proof is the export, so Run now runs it for the held sites with calls to spare and says what it spends (\"Run now · 1 of 10\", or \"1 of 3 left\" from the provider's meter). Registry justification: SitePicker matches an account's listed sites and has nothing to type; ProviderCard's AssetKeyFields replaced the whole map with one Save.",
    variants: ["held (status) and waiting for a paste", "saving", "refused on its row", "run: 1 of 10", "run: calls left", "run disabled"],
  },
  {
    name: "SitePicker",
    file: "components/SitePicker.tsx",
    purpose:
      "THE ACCOUNT'S SITES, MATCHED, AND ONE PRESS (bead ro-ujb9.96.7.2, epic ro-ujb9.96.7): ConnectPanel's second screen. Every portfolio asset is a row, ticked where the account holds a site on its own domain (a suggestion; nothing is written before Start), with the site it would be collected from, a market for a portfolio provider, a picker of unclaimed sites where the account lists nothing on its domain, the provider's own Add link, or a chip saying why it cannot be collected (Not using, Doesn't apply, Pre-launch, Not verified). Sites the account holds that match no asset are listed under the rows, never dropped. A metered provider states its spend before the press as label/value pairs over a Meter. Start writes the Data sources tab's own mapping ops (shared/lane-mapping-ops.ts) and runs the scheduled job's step now; each collected row then wears IntegrationStateChip from the connection model (Collecting until a result is stored), or the refusal (paused, already running) in words. AN UNTICKED BOX IS NOT A DECISION (bead ro-ujb9.96.7.18): unticking a row the scheduled job collects anyway opens DeclineReasons on the row and wears 'Still collected' (caution) until a reason is picked; the pick reads 'Not using' and is saved in the same Start press as the Data sources row's own decline ops (shared/lane-decline.ts), after which the collectors skip it. Nothing is preselected. Start then says both ('Start collecting · 1 site · 1 not using', or 'Save · 1 not using' when nothing is collected), and the spend preview counts every site the weekly job will bill, undecided ones included. Registry justification: ListPanel rows expand to evidence and carry one value; nothing drew a selectable, matched account-to-asset list with its commit.",
    variants: ["account: matched, picked, not in account, not verified, declined, unmatched sites", "unticked: still collected (reasons offered)", "unticked: not using (reason picked)", "portfolio: markets and spend preview", "PostHog: projects by name and number, funnels picked up", "Google: GA4 property and Search Console site on one row", "starting", "started: statuses", "started: saved as not using", "refused: paused", "loading", "no answer"],
  },
  {
    name: "DeclineReasons",
    file: "components/DeclineReasons.tsx",
    purpose:
      "WHY A DATA SOURCE IS NOT USED, AS ONE PRESS (beads ro-ujb9.96.7.13 and ro-ujb9.96.7.18; operator answer A, 2026-09-23). The three reasons the operator chose to offer — Don't use this product, Replaced by another tool, Not relevant for this site — as choice chips (pillChoiceClass), plus Other… for a line of their own (at most 82 characters, so the stored note fits the register's 90 with its prefix). A chip IS the decision: it hands its words to the caller, which writes the reason and the posture in one changeset (shared/lane-decline.ts declineOps) — at once with Undo in the toast on a Data sources row, or with Start in the connect panel. Nothing is preselected: a reason the product picked would be a reason nobody gave. The REASON: prefix the register's rule needs is the caller's write and is never shown. `selected` draws a chosen reason filled so it can be changed in place; a custom one takes the Other chip's place. Esc closes the typed line, then the chips. Registry justification: FlagActions' snooze expands presets in place for a different decision (when an alert comes back) and KnobEditor's segments pick an enum value to Save; nothing offered reason presets plus the operator's own words, committed by the press itself.",
    variants: ["chips (nothing chosen, with ✕)", "a preset chosen", "own reason chosen", "typing own reason", "saving (disabled)"],
  },
  {
    name: "AddSitePanel / AddSiteButton / NoSitesYet",
    file: "components/AddSite.tsx",
    purpose:
      "ADD A SITE IN ONE SCREEN (bead ro-ujb9.96.7.5, epic ro-ujb9.96.7; Plausible/Fathom: the domain is the only question). A centred Sheet over the page it was opened from: one Domain field; the name read off the domain at once (shared/asset-wizard siteNameFromDomain) and replaced by the site's own name when GET /api/site-name answers (shared/site-name.ts, Ahrefs' title-to-name pattern), shown with its source and the site's favicon, or its initial where none answers — neither ever holds Add up; one optional press, Not launched yet, which starts the asset in pre-launch. Refusals are short states beside the field: Already added (with the way to open it) at once, Not a domain once Add is pressed. Add writes through the wizard's own path — planWrites from the wizard's defaults, then lib/asset-operations (store row first, one changeset second) — and lands on the new asset's Data sources, where each source has its one Connect. Row added and setup not saved is its own state with Retry setup, which re-sends only the acknowledged plan. AddSiteButton is the way in: a Button that opens it in place, so adding a site is never a page; /assets/new is the same sheet over Assets for old links. NoSitesYet is an empty site list's door (bead ro-ujb9.96.6.18, D30): \"No sites yet\" with AddSiteButton beside it, the default of AssetsTable and the desk AssetsBand; a page whose header already offers Add a site shows the bare EmptyState instead, and the TV (nobody presses it) shows the words only. Registry justification: the only way to add an asset was the Wizard layout (retired with it), seven screens for one domain.",
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
      "One provider's credential and its connection evidence (ro-ujb9.211; doc 15 flow C). The header uses the shared ConnectionStatus and IntegrationStateChip vocabulary: Not connected, Not checked, Key accepted (Signed in or URL accepted where appropriate), Collecting, Working, Overdue, Failing, Not using, or Unknown. Checking belongs to the pending probe. Credential source is separate: legacy environment credentials retain their import controls, never a second connection-status label. ConnectionFacts carries missing or incomplete reports without turning coverage into a credential failure. Guided mode uses Connect, Choose sites, Verify and Settings; the reference card uses the same forms and evidence. Replace opens empty inputs; secrets are never echoed. Disconnect uses ConnectionActions: one confirmation names the sites that stop and the credential deleted, includes Google grant revocation where applicable, and the final press names the provider. No provider-id input is required. Read-only cards expose no mutation controls. Expiry remains a dated qualifier beside the status, not evidence that collection failed. Provider-declared fields, probe effects, per-site coverage, notification rules and stored budget/credit readings keep their existing components. Registry justification: a credential needs schema-driven input and provider proof; neither config-value editors nor lane-health matrices replace that contract.",
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
      "The shared Google start control inside ProviderCard. An explicit standalone href renders as a link; an owner-bound onStart callback renders as a button with no GET fallback. A pending hosted start disables the button. Registry justification: credential actions and probe recovery use the same link-or-button presentation without duplicating its transport distinction.",
    variants: ["standalone link", "hosted button", "hosted start pending"],
  },
  {
    name: "AlertRow",
    file: "components/AlertRow.tsx",
    purpose:
      "ONE ALERT as doc 21's ListRow, on every surface that shows one whole (beads ro-ju7f, ro-78qo.17): an asset's Current signals, its Alert history, and /alerts/history across the portfolio. It was a route-local FlagRow inside routes/asset-detail/CurrentState.tsx until /alerts/history became its second surface — the registry's own rule, that a fact rendered on two surfaces is a component and the second surface is where you find out. Copying it would have meant keeping five vocabularies in step by hand: the translated headline (shared/alert-language), the evidence popover, the Recurrence chip, the ChangeChip and the disposition footer. It also exports the two alert pieces /alerts and Home draw beside their own rows — the Recurrence chip (`16× in 27d`, a count as a glyph and a duration, nothing for a single firing) and AttentionAllClear, the one all-clear line — which lived beside a desk table no screen drew until that table left the Tower (bead ro-trai.25); their pure answers (isGrouped, memberNames, kindLabel, alertTaskHandoff) are lib/attention. TWO MODES, one difference each. `history` means SETTLED: the row loses the Mark read / Resolve pair, because there is nothing left to act on, and gains the OPEN SPAN — a rule between a filled dot and a hollow one whose LENGTH is how long the alert stayed open, on a log scale from an hour to a month, with the duration in words beside it. That span exists because 'fired 9d ago' and 'resolved 2d ago' are both recencies and the operator's question reading a list of closed alerts is which of these dragged on; deriving a duration from two relative ages, per row, is exactly the arithmetic doc 14's 2026-09-04 rule says a shape should do instead. Its ink is neutral: severity owns the row's only color, and a long-running warning is not a more severe warning. A row with no closing time recorded renders no span at all rather than a zero-length one, because unmeasurable is not instant. `asset` is the other mode: a PORTFOLIO surface names which asset the alert happened to — the PropertyFavicon that asset's own page wears as its heading, linking into that asset's Alerts tab — and the asset page passes nothing, because naming the asset on its own page is the same fact twice. THE TUNED CHIP survives the next decision (bead ro-bkcl): flags.disposition holds one slot, so Mark read and Snooze used to overwrite a tune and take the chip with it, leaving the row silent about a rule change the operator had already made. The tune is carried in the note behind shared/tune.ts's mark, wasTuned is the one predicate the row reads, and a settled row that was tuned and then answered another way carries BOTH — the disposition badge for what was done with the firing, the chip for what was done to the rule — with the quoted note trimmed to the decision's own half so the setting is stated once, in the chip's hover. IT IS A ListRow SINCE 2026-09-05 (bead ro-78qo.17). It drew a bordered card with everything on it at once — headline, kind, age, notified mark, three action buttons and a settled footer, on every row of every list — while /alerts had just been rebuilt to doc 21's one-line row (ro-78qo.7). Two layouts for one alert is the doc 14 failure doc 21 exists to end, so the fold happened in the component rather than on one surface: a closed row is a severity ring, a mark, the headline and one caption, with the age or the open span at the end, and everything the card printed by default is revealed IN PLACE when the row is opened. Nothing was removed. Because ListRow renders an <li>, the row is wrapped by AlertList — the <ul> and its chrome exported beside it, so the three call sites cannot land on three different gaps; it is deliberately not ListPanel, since each of those lists already sits under a heading its own surface owns and a second eyebrow would be duplication rather than a panel. The mark carries the state doc 21 gives it: the finding triangle while open, the quiet circle for a milestone, the check once settled — and a settled row KEEPS its severity tone, because how bad it was is the axis History is filtered on. The materiality marks (data-flag-kind, data-flag-severity, data-material-condition) ride the title span rather than the <li>, since ListRow forwards only className; bead ro-78qo.40 proposes the passthrough that would put them back on the row.",
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
      "Shared alert-lifecycle controls for the desk queue and asset alert row: mark this event read, park it until a date, or record its issue resolved, with one pending state and one recurrence meaning. Snooze (bead ro-c7qq) expands the button row IN PLACE into three presets and a date field rather than opening a popover the registry has no primitive for and the alerts table's scroll container would clip; it commits immediately with Undo in the toast (docs/15 principle 5), because unsnooze is a true inverse — it ends the snooze now and the same condition returns. The snoozed variant is the one a parked row gets: Unsnooze alone, since Mark read and Resolve on a row nobody is being shown are decisions made blind. Given a `ruleId` the OPEN row also renders TuneRuleAction (bead ro-u072) — a fourth verb of a different kind: the other three say what the operator did with this EVENT, Tune changes what would produce it. A separate component, because whether a rule has an honest replay is that component's decision rather than a list this row would have to keep in step; the parked branch is deliberately one action and the picker branch is a decision already in progress, so neither offers it.",
    variants: ["idle", "snooze picker (presets + date)", "snoozed (Unsnooze only)", "pending (inside desk Attention demo)", "with Tune (rule-driven alert)"],
  },
  {
    name: "SnoozeUntil",
    file: "components/SnoozeUntil.tsx",
    purpose:
      "When a parked alert comes back, as glyph + date + time remaining (bead ro-c7qq) — the 2026-09-04 rule that a state carries its own visual: 'Snoozed' says an operator clicked something, this says for how much longer. Two states because a snooze has two: a struck bell counting down while it is quiet, and a ringing bell with a past date once it has expired and the same condition is open again (unsnooze writes that same shape, ending the snooze now rather than erasing it). Registry entry rather than a route-local span because three surfaces render it, and the point is that they say it identically: AlertRow draws it in its disposition footer (so the asset page's alert history and /alerts/history agree), and the /alerts Snoozed list draws it beside its Unsnooze. Not StateChip: that colors a lifecycle state from a fixed vocabulary, this carries a date and a countdown.",
    variants: ["active (counting down)", "expired (back on the list)"],
  },
  {
    name: "BacktestStrip",
    file: "components/BacktestStrip.tsx",
    purpose:
      "WHAT A RULE SETTING WOULD HAVE DONE, as a shape (bead ro-u072). docs/15 principle 1 asks a rule edit to show 'would have fired 3 times in the last 30 days' before it saves; that sentence alone cannot be decided on, which is doc 14's visuals rule in one line — three firings inside one bad week is an incident that is over, three spread across the month is a rule that will interrupt the operator again on Thursday. Same number, opposite decisions, so the thirty days are laid out in order and WHERE is answered beside HOW MANY. TWO TRACKS, and the second is the point: above the line the REPLAY (what the candidate settings would do), below it REALITY (the days this rule actually fired, from stored flags), which answers what a pair of totals cannot — is the candidate quieter everywhere, or only on the days that were already worst. INK IS NEUTRAL: a replayed firing is not an open alert and a settled one is not attention, so neither track spends the severity palette (doc 14, the same choice the chart-distorted mark makes); the tracks are told apart by POSITION and shape, never by an opacity step. FOUR STATES, because 'it did not fire' hides three different facts — it ran and stayed quiet, it could not run (no four matching weekdays yet, or the metric was outside this rule's volume regime), or the asset filed no report at all — and a day with no report is drawn as a HOLE rather than a quiet day (docs/17 rule 6). Sunday–Saturday week bands with the newest week unshaded, per doc 14. No distorted-day marks, deliberately: those belong to provider-bucketed series, and this draws stored PULSE days, which a provider's reporting-timezone move does not touch (the boundary packages/contract/src/rules.ts states for the baselines these days are judged against).",
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
      "TUNE THIS RULE, from the alert it is being noisy on (bead ro-u072) — docs/15 flow E's sixth disposition, and the one the OS shipped a link to instead of a mechanism. The trigger sits beside Mark read, Snooze and Resolve and renders NOTHING for a rule a pulse replay cannot honestly serve (ingest-freshness, asset-declared, watch-window verdicts are not steered by these settings and are not reproducible from stored pulses), so an operator is never offered a preview that could only be invented. It opens a portalled panel — Escape, outside click, scroll and resize all close it — holding the BacktestStrip above the three portfolio alert-rule settings, each of them the shipped KnobEditor writing through the D18 lane, so a read-only deployment disables Save with the lane's own sentence while the preview still renders. The preview recomputes as a field changes (KnobEditor's `onDraft`, debounced in useRuleBacktest), which is the whole point: show, then ask. WHAT IT IS NOT is the per-asset rule editor doc 10 deliberately removed on 2026-09-04 — these three settings are portfolio-wide, so the scope is the panel's LEAD sentence rather than a footnote, every field repeats it as its scope note, and the panel ends in a link to /settings#alert-rules, which is still where the rules live. RuleTunePanel is the presentational half (it takes the settings, a preview state and a draft callback) so every state is reviewable in the gallery and in tests without a store. Since bead ro-ayxy it also draws TuneRate ABOVE the replay when the store's per-rule counts are passed to it — what this rule has already cost, before what a change would do, because the operator opening the panel has just decided one alert was noise and the fact that changes the decision is whether they have decided that about this rule four times already. Same read and same query key as /settings#alert-rules; no counts means no figure, never an invented one.",
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
  },
  {
    name: "KnobEditor",
    file: "components/KnobEditor.tsx",
    purpose:
      "Optional help is explicitly opt-in and uses InfoTooltip beside the field label. Existing explain and scopeNote stay visible; warnings, validation, units and destructive consequences must not move into help. " +
      "An EDITABLE setting: KnobRow's fact layout + a validated control and a Save that WRITES it (D18, bead ro-pbzu.5). A file-owned knob goes through the local config write lane, which archives the changeset and commits it; a store-owned column goes through the Worker. Local validation is unchanged — a value the field knows is wrong never becomes a request. The way back is the Undo beside the field (InlineSaveState; since bead ro-ujb9.96.7.12 there is no toast mode, so every setting present and future confirms, refuses and undoes the same way), not a confirm before the fact (docs/15 principle 5), and a deployed build (no filesystem) renders a file-owned field disabled with the deployment's own sentence beside it. `onDraft` (bead ro-u072) reports the buffered draft as it changes — the validated value, or null while the field holds something it would refuse — for the one caller that has to react BEFORE the Save: the alert-rule tuner, whose job is docs/15 principle 1. It changes nothing about what is written; only makeOp does that, and only on Save.",
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
      "A SAVE'S OUTCOME, BESIDE THE FIELD THAT MADE IT (bead ro-ujb9.96.7.12). Registry justification: KnobEditor drew 'Saved · Undo' inline since bead ro-ujb9.96.6.3, and a CollectionEditor cell and a Settings schedule row now save the same way — three private copies of one state would drift into three wordings. Saving… while the write is out; a check, 'Saved' and an Undo once it landed; 'Not saved' and the refusal's own words (one line, truncated, whole on hover and to a screen reader) when it did not — the refusal that used to be a corner toast the operator had to connect to the control they had just touched. No severity colour on success; the error ink only on a refusal. idle draws nothing. `subject` names the field the state is about (data-status-for), so two fields saved on one screen are two subjects rather than one status twice. After GitLab Pajamas' saving pattern (docs/briefs/2026-09-23-inline-save.md#prior-art).",
    variants: ["saving", "saved with Undo", "undoing", "refused with its reason", "idle (renders nothing)"],
  },
  {
    name: "SavesPaused",
    file: "components/SavesPaused.tsx",
    purpose:
      "SAVES ARE PAUSED — SAID ONCE, FOR THE WHOLE SCREEN (bead ro-p8qq). When the deployment answers writable:false (config store unreachable or not ready, or a build that cannot write), that is one fact about the DEPLOYMENT, and every editor used to print it under itself — an asset's Settings tab said it five times on one screen. A page that stacks editors renders this once (a StatusBanner: 'Saves paused' and the deployment's own reason) and passes statesReadOnly={false} to its editors, which then show only a lock. It renders nothing while saves work. Registry justification: StatusBanner is the line; this is the one reading that decides whether it is open and what it says, so /settings, /financials and an asset's Settings tab cannot word one state three ways.",
    variants: ["saves paused (the deployment's reason)", "saves work (renders nothing)"],
  },
  {
    name: "FunnelListEditor",
    file: "components/FunnelListEditor.tsx",
    purpose:
      "ONE LIST OF ORDERED LISTS, SAVED AS ONE VALUE (bead ro-ghis.1). An asset's PostHog funnels: each a name and 2-10 ordered steps, each step an event name optionally pinned to one page path. Registry has nothing that edits rows which each hold their own ordered sub-list — CollectionEditor edits flat register rows cell by cell and KnobEditor one scalar — so this buffers the whole list, judges it with the register field's own rule (the same function the store save runs) and writes ONE file-json-set, so funnels are never half-saved and the toast's Undo restores the whole list. Reuses fieldClass, Button and useConfigSave; a deployment that cannot save renders the list as text with its reason. PICKED MODE (bead ro-ujb9.96.7.24): given `saved` — the project's saved funnels read from the connected PostHog account — the list is picked rather than typed: each funnel a row with its own remove press, Add funnel a select of the saved ones not on the list, every change saved at once with InlineSaveState's Saved · Undo; the typed editor stays for an account that cannot be read.",
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
      "ONE LIST-SHAPED CONFIG REGISTER, EDITABLE (bead ro-x5gu.1) — KnobEditor's plural. Epic ro-x5gu puts a CRUD surface on every register at once (the recurring costs and domain orders on /financials, an asset's GA4 value events and tracked queries on its own tabs, the task-hub map on /settings; the data-source catalog left /settings as product definition, bead ro-ujb9.96.14), so without one primitive five surfaces would each have grown their own table, Add form, confirm and idea of what a valid row is. IT KNOWS NOTHING ABOUT ANY REGISTER: the columns are the declared fields in declared order, the control is chosen by the field's TYPE, the Add form is built from the same list, and a refusal is the same sentence the write lane would have answered with — all read from scripts/config-registers.mjs through shared/config-registers.ts, so a register gains a column by gaining a field and this file does not change. It BORROWS KnobEditor's semantics rather than inventing any: a cell buffers a draft and commits it with Save (or Enter), an invalid draft never becomes a request and says why under the input in error ink behind an error border, and the way back is the Undo in the toast rather than a confirm before the fact. The one thing it adds is REMOVE, which is not invertible in place — so it, alone, asks first, inline in the row rather than in a dialog the registry has no primitive for. Every action is exactly ONE guarded store write through useCollectionSave: an add is one insert, a remove one delete carrying the row as `expect`, an edit one set carrying the cell's own previous value; each carries its exact inverse, built from the same row at the same moment. Undoing a removal puts the row back WHERE IT WAS (bead ro-asj9): a delete splices, so an insert that could only append returned the row at the end and left its neighbours in an order nothing had asked for — visible wherever a table is drawn in file order, which /financials is. An indexed insert is RFC 6902's `add` for an array and is licensed for every array register whose rows have declared fields; config/pull.json, the one whose rows are opaque, still appends because nothing reads its order. The guard is unchanged (an insert has never carried an expect) and an index past the end of the list is refused loudly. Two edits cannot take the field's own pointer and set the whole row instead, guarded by the whole previous row: a row stored as a bare scalar (a string list, an unlabelled tracked query) has nothing below it to address, and CLEARING an optional field has to remove the key rather than write null into a config file. LOADING OFFERS NOTHING (bead ro-x5gu.9): a page still fetching has no rows and neither does an asset with no entry, so the skeleton owns the whole surface — no Add below it, nothing to Remove, and an open Add form closes if a refetch starts, because the seed-vs-append decision is only ever made against rows the page actually received. ABSENCE AND EMPTINESS ARE DIFFERENT STATES of a per-asset list, and the first Add is where that shows (bead ro-x5gu.3): rows arriving as null/undefined means the file has no entry for this asset at all — the common case in every per-asset register, since absence is 'not declared' by design — and because a pointer never creates structure, the first row files the asset's whole ENTRY through the holder register beside the list (holderOf), one insert reversed by one delete at the same pointer. An entry that exists and holds an empty array appends normally. A LONG REGISTER NARROWS ITSELF, AND THE ADDRESS TRAVELS WITH THE ROW (bead ro-x5gu.11): every op addresses a row by its POSITION in the file's array, so no page could hand over a filtered or sorted list — /costs/0 would have meant whichever row was first on screen, and /financials showed all 22 domain orders flat because of it. Doing it inside the component is what makes it safe: collectionRows still reads the file's own array, so a row keeps the token it had there, and the filter box and sortable headers only choose which rows to draw and in what order. Both appear past eight rows only; the count beside the box says n of m so a narrowed table never reads as a shrunken one, a filter matching nothing says so rather than borrowing the empty state, and a header cycles file order → ascending → descending → file order by the column's declared type. ON A PHONE THAT SAME REGISTER FOLDS (bead ro-c59x): ro-md80's reflow turns each row into a labelled card, which made every field reachable at 390px and paid for it in height — 22 domain orders x 6 fields is 132 labelled lines, and /financials measured 28,244px at 390x844. Past the same eight-row threshold a row is ONE line (its key, its second column, a chevron) until it is opened, and opening it gives back the whole card with every control at the 44px thumb floor; the fold uses @max-[40rem] in ui/table.tsx to measure the table container, so a wide table never folds. AND A COLUMN MAY BE COMPUTED: `derived` is a column the page works out from a row — /financials prints each domain order's amortized month and its term — drawn beside the declared ones and carrying no control, because nothing stores it and nothing addresses it. It DOES NOT FETCH — rows arrive as a prop from whatever payload the page already reads — so it never becomes a second reader of a file the page is already showing. An unavailable configuration store renders the whole table read-only with the lane's own sentence, exactly as an individual setting does; a surface stacking SEVERAL editors under one heading passes statesReadOnly={false} and says that sentence once above them, the way /settings' Budget does rather than leaving three fields to whisper it. A register may declare a `clusterField` (bead ro-cnsj) — the field naming a GROUP something downstream matches by exact string — and a label differing from one the list already spells only in case is refused in the collector's own words, because two spellings of one cluster are two bets in the readout and one in the operator's head; that rule needs only the rows, so no page supplies anything. A ROW RULE MAY LIVE IN ANOTHER FILE (bead ro-uko8): `refuseField` is a per-FIELD rule the declaration states but this component cannot check, because the fact it turns on is in a file it never opens — turning the panel-refresh roster ON asserts a live gsc/ga4/bing-webmaster lane in integrations.json, refused with that README's own sentence, shared with the apply pipeline so a hand-written changeset meets the same words; the page supplies the facts and the rule stays in the declaration. THREE THINGS THE DECLARATION CANNOT KNOW ARE THE PAGE'S TO SUPPLY (bead ro-x5gu.5), and none of them teaches this component the name of a register: `fieldOptions` is the value domain that only exists at runtime — which asset ids the store actually holds — offered as a native datalist beside the input and refused naming the field through candidateRefusal in the declaration itself, the same rule the apply pipeline asks with the roster file's keys (bead ro-x5gu.10), with an empty list read as 'the page has not answered' and refusing nothing. WHETHER THE LIST ALSO REFUSES EVERYTHING ELSE IS THE FIELD'S TO SAY (bead ro-g318): one prop did both jobs, which is right for a CLOSED domain (an asset id the OS does not have is a typo) and wrong for an open one — so the tracked-query Bet column offered no picker at all rather than one refusing every new cluster, and the operator retyped a bet by eye, which is exactly what clusterSpellingRefusal exists to catch. A field declaring `candidates: 'suggest'` gets the datalist and no refusal, so the bets a panel already names are one click away while naming a new one stays a legitimate edit and a case variant is still refused; `onAdded` fires once a row has landed, because a row is not always the whole job (a task-hub project still needs its database created and its repo pointed at the hub) and only the page knows which steps are left; `rowGlyph` draws the row's own identity mark beside the FIRST column, since an asset id is a domain and reads faster with its favicon. A FIELD MAY BE SET WHEN THE ROW IS CREATED AND NOT AFTERWARDS (bead ro-xhy5): three declared fields are join keys whose rename breaks something no table can show — the data-source catalog's `id` (every asset entry and every collector names the source by it), a recurring cost's `id` (part of the ledger's idempotency key, so a rename re-books every month already booked) and a domain order's `domain` (what the registrar's next export is reconciled against) — and each of them carried that warning in its `describe`, which is a tooltip on a control that still offered the edit. A field declaring `readOnly` renders as the stored value with the reason on it and no Save to press, while the Add form still asks for it because a new row must set its key; the write lane refuses the same set, so read-only is a rule rather than a suggestion a hand-written changeset can walk past — and refusing a hand-authored RENAME is the right answer, since a rename needs matching edits in files this pipeline cannot make. A field may also declare `defaultFrom` in the register itself — the Add form mirrors that field from its source until it is typed into directly, which is how a task-hub project's database follows its prefix without either value being derived in the file. Registry justification: Table is primitives with no behaviour, KnobEditor edits ONE value and has no notion of rows, and the wizard's forms capture a new asset once rather than maintaining a list.",
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
  },
  {
    name: "TaskComposer / FileTaskButton",
    file: "components/TaskComposer.tsx",
    purpose:
      "FILE A TASK WITH A BUTTON (D19, bead ro-l1ed.4). Every Tower handoff ended in a `bd create` command whose last step — paste it into a terminal standing in the right repo — is the step that fails: filing from the wrong directory files against the wrong asset. The slide-over is the operator's path to the same bead, opened prefilled from `taskHandoffPrefill` — the single computation the copied command is ALSO rendered from, so the two cannot describe different tasks. Fields: title, project (a select over config/beads.json's spokes, with the chosen asset's favicon beside it), type, priority in the board's own words (top/high/normal/low/lowest, never P-numbers), an optional parent epic validated against the chosen spoke's prefix, labels, description and acceptance criteria. The handoff labels (`noticeos-handoff`, `asset:`, `rule:`, `key:`) are pre-added and LOCKED and the `noticeos_*` metadata rides hidden, because they are the join the poller reads and the HandoffBeadBadge renders — an operator editing `key:` by hand would file a bead that never reappears on the row that raised it; what the composer shows instead is what the metadata MEANS, one 'Linked to a finding / a query decision / a page decision / an alert' chip, and a lock glyph on each locked label. TITLE, THEN ENTER (bead ro-ujb9.96.6.11): the first screen is title, project (defaulted from the board filter, the asset tab, the handoff or the only spoke) and priority, and Enter files; type, parent, labels, description and acceptance criteria wait under More, which opens by itself when a handoff filled any of them. No field carries a hint line. It refuses inline without a project or a title and shows `bd`'s own stderr on a refusal. On /tasks New task opens it IN PLACE through location state, so the page does not change under it (bead ro-ujb9.96.7.11), and ?new=1 still opens it from a link somebody can send; it inherits the board's project filter, taking its options from the board's own spoke rows rather than opening a second read of config/beads.json; a row's button owns its open state instead and mounts no form until pressed. Filing lands on /tasks/<id> through the toast, where every other bead id in the Tower already leads. Observations are still not commitments (config/beads.README.md): a person still decides to file, and the button replaced the paste rather than the judgment. Copy Markdown stays beside it — it is the AGENT's path, carries the whole evidence brief, and is the only path in a deployed build, which is why the trigger goes disabled with what to do on hover (READ_ONLY_TASKS_HINT — the deployment answers with a state code, never a sentence) rather than disappearing.",
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
      "THE TELEVISION AT TV GEOMETRY, WITH THE EDITOR'S CHROME ON IT (bead ro-lzmq.2, /wall/edit). The box is literally 1920x1080 — the geometry scripts/wall-fit-check.mjs measures — scaled to the pane with a transform, and what is inside it is WallCanvas (bead ro-lzmq.1), the very component /wall draws, reached through its `editing` slot. It supplies the `wall-root` scope itself, because WallRoute puts that class on the element ABOVE the canvas rather than on the canvas — without it the widgets would draw in desk tokens and the preview would be showing a Wall that does not exist. There is NO second layout engine, which is the whole point: a preview that drew the grid its own way would be a preview that lies, and this editor's one promise is that what is arranged here is what the television shows. THE CHROME COUNTER-SCALES, AND APPEARS ONE AT A TIME: at desk width the pane gives the box about a third of its natural size, so a drag handle drawn inside the transform would be four millimetres across and a 44px touch target 15 — the widget's toolbar carries the inverse scale through a --wall-chrome-scale CSS variable set from the same number the transform uses, so the two cannot disagree, and comes out the size a finger expects at every pane width. That has a cost the first capture made obvious: at full size, SEVEN toolbars over widgets about 110 screen pixels wide covered the whole television, so a toolbar is drawn only over the widget the operator is already pointing at (hovered, focused or selected) and the ring is the affordance the rest of the time. Below a quarter scale it is not drawn at all: on a phone a three-widget row gives each widget about 40 screen pixels while two controls are 76. Everything it holds is in WallWidgetPanel anyway, which never hides and is where a touch operator has to work regardless, since a touch never fires a drag. THE WIDGET IS A PICTURE: everything the canvas draws is pointer-events-none and aria-hidden here, so the Wall's own links cannot be operated through a preview and a screen reader does not read the assets grid twice — once as the portfolio and once as furniture — and the whole grid track is one named selection target instead. Arranging is NATIVE drag-and-drop: dataTransfer carrying one widget id under a private MIME type, so a drop from anywhere else in the browser is ignored, with the left/right half of the target deciding before/after because that is the only reading that can express 'put it last'. No dependency was added; the whole interaction is one string and two handlers. It also MEASURES, reporting the canvas's content height at its own 1920x1080 and never scaled — a scaled measurement would only ever say the pane is smaller than the TV — so the route can say how far past the TV a layout runs. It reports at EVERY screen width (bead ro-lzmq.5): `wall-root` is a query container and every breakpoint variant fires on it as well as on the viewport, so the widgets inside the box draw the television's arrangement and type on a phone exactly as on the kiosk. Until that landed they were ordinary responsive components keyed on the VIEWPORT, they all collapsed at 390, and the editor withheld the reading rather than announce that a layout fitting the television perfectly ran 1,235px past it. Registry justification: nothing previewed anything at another surface's geometry; Drill drills into a fact on the same surface, and the kitchen sink is a gallery of components rather than a scaled copy of a page.",
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
  },
  {
    name: "WallLibraryPanel",
    file: "components/wall/WallLibraryPanel.tsx",
    purpose:
      "THE FIXED WIDGET LIBRARY (bead ro-lzmq.2) — docs/15 flow D's 'the operator arranges widgets from a fixed library and never authors new tile types; that is a component-registry PR'. Every type the contract knows is listed ALWAYS, including the ones already on the Wall: a library that hid what was placed would answer 'what can this TV show' differently depending on what it currently shows, and the operator would have to remove a widget to find out whether a second one was possible. So a refused Add is dark WITH ITS REASON on the row, and the reason is the validator's own sentence — the same words the write lane would return if the layout reached it — rather than a second wording of one rule. Registry justification: it is not CollectionEditor, which maintains a config register's rows; this offers a fixed catalogue and never edits it.",
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
      "THE SELECTED WIDGET'S SETTINGS (bead ro-lzmq.2). Width is the contract's weight on its own step grid AND the share of the row it actually takes, both on screen, because 1.7 means nothing until you know what it is 1.7 OF. Move left / right / up / down is the KEYBOARD'S HALF OF THE DRAG — the same reducer action the drop dispatches — and a direction with nowhere to go is disabled rather than silently inert. A setting appears here only when the RENDERER applies it: the contract's spec.settings decides, which today means the asset filter on the two widgets whose content is per asset. Nothing ticked means EVERY ASSET, stated rather than pre-ticked, so a filter does not become a list somebody has to maintain each time an asset is added, and un-ticking the last one restores that state because an empty list is the one thing the contract refuses. A widget whose own configuration lives elsewhere renders THAT FORM: the countdown's panel is CountdownEditor, exported from DashboardWidgets for this one caller, because two forms for one landmark a click apart is exactly the failure the one-representation rule exists to prevent. THIS PANEL NAMES THAT WIDGET AND CHIPS THE OWNING FILE, and the borrowed form is embedded without a header of its own (bead ro-mgqo): the heading has to live here because it is also what a widget with nothing configured yet gets, and drawing it in both put the identical heading and the identical config/tower.json chip one line apart in a 19rem pane. Registry justification: KnobEditor edits one config value at one pointer and has no notion of a selection; this is the inspector for whatever is selected on another surface.",
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
  },
  {
    name: "WallRowsPanel",
    file: "components/wall/WallRowsPanel.tsx",
    purpose:
      "THE WALL'S ROWS, AS ROWS (bead ro-lzmq.2): the order, which row takes the remaining height, adding one, and taking an empty one away. It exists because WallCanvas's editing slot wraps WIDGETS and only widgets — deliberately, so the renderer never learns what a row control is — and row facts therefore need a surface of their own. It lists NO WIDGETS, though the temptation is obvious: the arrangement of widgets would then exist twice on one screen and the operator would have to work out which of the two they were changing. What it does take is a DROP, because an empty row draws nothing in the preview and without a target here a freshly added row could only be filled by adding a widget from the library. Remove is enabled on an EMPTY row only — a control labelled 'remove row' that also deleted three widgets would be deleting something its label never mentioned — and the remaining-height toggle carries a MARK as well as a fill, since doc 14 refuses a state carried by tone alone and one row of four looking slightly darker than the rest is exactly the difference nobody sees. Registry justification: Table is a primitive with no behaviour and CollectionEditor maintains a declared register's rows; a Wall row is neither, and its four operations are the layout document's own.",
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
      "The Wall's grouped header (docs/25-the-wall.md § Strip, ro-trai.49): brand and local clock/date, next meeting today, and a prominent days-left countdown in one sans family. The 96px TV strip has 16px vertical padding, shared label/value tokens and a small inset countdown-number tile. Scaled labels keep an 11px physical floor; portrait screens wrap whole groups. Locale formatting controls AM/PM; the clock has no seconds. The countdown has its own large number, unit, label and optional emoji; unset draws nothing, reached uses its own state. The brand is the Home link. A failed Wall poll retains values and adds their age. Aggregate source/system badges are removed; concrete OS, scheduler and spend problems join NeedsYou. Reuses existing clock, meeting and countdown derivations; no new standalone widget or editing flow.",
    variants: ["meeting today", "clear day", "countdown remaining", "countdown reached", "no countdown", "held payload", "TV and wrapping phone groups"],
  },
  {
    name: "WallVersions",
    file: "components/wall/WallVersions.tsx",
    purpose:
      "WHAT THE TELEVISION USED TO SHOW, AND THE WAY BACK (bead ro-lzmq.2, docs/15 principle 5). A REVERT IS A SAVE: it does not pop a stack — the layout it restores becomes current, the layout it replaced joins the history like any other, and the entry reverted TO stays exactly where it was — so a revert can itself be reverted, and the list is a record of what the television showed rather than an undo buffer that shortens as it is used. It asks for NO REASON, which is its one difference from Save: the reason is already written, the entry's own, and asking the operator to explain putting something back the way it was is the ceremony D18 retired. Each row is the operator's own words, the age of the save, and the shape of the layout it holds (rows and widgets), because a reason alone cannot say whether the thing being restored is the big rearrangement or the small one. Registry justification: Timeline is an asset's recorded events and AgeBadge is one age; nothing in the registry listed prior versions of a document with a way back to each.",
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
      "THE WALL'S REVENUE WIDGET (D28, docs/25-the-wall.md § Revenue, bead ro-trai.4): the month's revenue so far as the largest type on the screen (the display token, 7.5rem on the TV), 'on pace for $X' from the sites' ready revenue projections plus revenue no projection covers, the change against last month's total in NEUTRAL ink (a projection is not a completed comparison), yesterday's saved provider estimate summed over the sites with a revenue source and the days left ('yesterday $55.25 est. · 9 days left', bead ro-trai.32: a report not in is left out and counted, '1 of 2 sites'; none in is 'yesterday not reported yet', never $0; it stands under the reason while there is no pace), and the month as a running total — reported days solid, the pace dashed to the month's end, last month's total a dashed flat line labelled once, and the day the month passed (or is on pace to pass) it marked and named. Revenue wears financial-revenue, never green. The arithmetic is lib/wall-revenue over the Worker's revenue-projection; the figure is portfolioHeadline's, so the TV and the desk quote one number. An estimate says 'estimated' in the heading (PortfolioBand's rule). Registry justification: PortfolioBand states the month's NET in a narrow card with a monthly backdrop, and HeroChart is the desk's interactive chart with legends and toggles the TV cannot use; nothing drew a cumulative month against a flat prior-month total with the crossing day named. The chart is drawn in the charts' one language (ChartMarks, bead ro-trai.19): the month a monotone-smoothed 4px line over a wash of the revenue colour that fades to a hairline floor and feathers out at today, the pace dashed in the same colour at reduced strength, today's point with a halo, the crossing a small ring on last month's line, and last month's name top left above its line, where a running total that starts at nothing never is, so the words never sit on the curve. Everything lives in a stretched viewBox with non-scaling strokes and round-stroke dots, so it fills whatever height the band leaves without measuring the page.",
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
      "The Wall's asset region (docs/25-the-wall.md § Site rows and Density, ro-trai.46): site name/favicon with four-bar health, LiveUsers over the minute pulse, today's comparable-hours chart/pace, and four-week trend. No repeated month revenue or separate issue column. Signal level and color distinguish healthy, warning, error and unknown; accessible text names the issue while asset pages own details. Selected pulse totals occupy a second line using the shared counter resolver's labels, values and freshness without a group caption; missing stays absent, zero stays zero, stale uses AgeBadge. lib/wall-counters shares selection semantics with WallWidgetPanel: absent asset choice uses configured defaults; [] hides all; unknown saved IDs remain editable. Both row tiers fill the region using responsive type tokens and expanding charts. Four or more assets keep figures beside charts; two or three put larger figures above them. A single asset uses up to three existing focus tiles (today, visitors/money, search), omitting unavailable tiles. Shared column tracks keep figures aligned; content that cannot fit scrolls within the region. ChartMarks, LiveUsers, intradayUsersPace and fourWeeks retain their existing data and period rules. The site's name alone may ellipsize.",
    variants: ["default pulse totals", "per-asset selection", "explicit none", "missing/zero/stale totals", "healthy/warn/error/unknown health bars", "fresh/stale live reading", "no data", "four or more filling rows", "two or three larger rows", "one site focus tiles"],
  },
  {
    name: "LiveUsers",
    file: "components/wall/LiveUsers.tsx",
    purpose:
      "A SITE'S LIVE USERS ON THE WALL (bead ro-trai.27, D34 amending D28, docs/25-the-wall.md § Site rows): GA4 users in the last 30 minutes in neutral ink, counting to each new reading (useTweenedNumber), over a MinutePulse — the last 30 minutes one bar a minute, the newest five bright — with that bright end's own count ('88 · 5 min') over it in the traffic colour. One cell for every tier: a compact row (the count on the figure's line), a roomier row (the count on its own line, the pulse taller), a phone's stacked row and the one-site Today tile (the pulse widest). '30 min' is said once in the table's heading (LIVE_HEADING) and beside the figure where there is none. Stale (past three minutes, liveTrafficCardIssue) and failed (the last good reading this cell drew, kept by useLastGoodReading) both drop to muted ink with a clock and the reading's age where the 5-minute count was; no reading or no GA4 is a dash, never a zero. Registry justification: it is SiteRows' former live figure grown a pulse, in its own module so the rows and the tile share one cell.",
    variants: ["fresh", "stale with its age", "failed, last pulse kept", "pulse refused (figures only)", "no GA4", "compact row", "roomier row", "phone row", "one-site tile"],
  },
  {
    name: "NeedsYou / IssueGlyph",
    file: "components/wall/NeedsYou.tsx",
    purpose:
      "The Wall's top three actionable problems, errors first then newest, with site, concise line and age (docs/25-the-wall.md § Needs you). wallIssues merges alerts, failing sources, late reports and overdue reviews; withSystemIssues adds missing OS reports, failed or silent jobs and spending over daily pace using existing rules. Duplicate OS report problems merge. The full asset issue list drives each site's health bars; NeedsYou shows the top three and total count, with urgent human tasks counted by the heading. No carousel. IssueGlyph supplies severity shape as well as color. D29 sites never receive missing-nightly-report warnings. Reuses the established Wall issue derivation rather than a second alert system.",
    variants: ["top three with the rest counted", "urgent tasks beside the heading", "nothing broken but urgent tasks", "nothing needs you"],
  },
  {
    name: "AppShell / Sidebar",
    file: "components/AppShell.tsx",
    purpose:
      "The desk's one chrome (bead ro-pbzu.1): a persistent left sidebar and the layout route every desk page renders inside. Nothing in the registry navigated — Drill drills INTO a fact and PropertySectionNav jumps within one page — so each route drew its own idea of where to go next (a nav row on Home, '← Home' on /work and /health, '← All properties' on /financials and the asset page, the changeset cart on three pages out of five), and the operator's way around the product depended on which page they were standing on. The nav is the eight desk nouns in the operator's own order (Home, Assets, Alerts, Tasks, Financials, Health, Integrations, Settings) using react-router's NavLink, so the current page carries aria-current='page' rather than a class the assistive layer cannot see; Home alone is `end`, because otherwise `/` matches every path and nothing else could ever be current, and an asset page lights Assets because an asset page IS an asset. Label and URL say the SAME noun since D20 (bead ro-pbzu.6) — Assets at `/assets`, matching the ids, the API and the task labels the system already spoke; `/properties` and `/properties/:id` stay aliases and redirect to their `/assets` equivalents with the hash intact, so a link written either way resolves. The FOOTER holds what is not a page: the TV and the theme toggle. It carried the changeset cart until D18 (bead ro-pbzu.5) retired staging; a setting saves in the field being edited now, so no write path is parked in the chrome. The dev galleries are dev-only routes reached by URL and are deliberately not in the nav — they are a reviewer's surface, not an operator's. Below `md` the column becomes a top bar with a menu button opening the same content as a portal drawer (role=dialog, closing on Escape, backdrop, and any nav click). AppShell, not the theme hook, applies `.light` to the document and REMOVES it on unmount, because /wall renders outside this layout route and the TV's tokens assume the dark emissive palette. It introduces no color of its own — bg-card, border-border, bg-muted, text-muted-foreground, text-foreground, ring. ASSETS CARRIES THE PORTFOLIO (2026-09-04, bead ro-pbzu.9): one row per asset beneath that entry — PropertyFavicon for identity, the display name, a SeverityDot only for an open warn/error, and a muted stage glyph only where the asset is not live — each a link to where that site opens (sitePath in shared/first-run: its Data sources until its first number, its Overview after — bead ro-ujb9.96.7.4), lit by the site's address rather than by that tab, so a row lights on every tab of its asset and the Assets entry lights with it (the row says which asset, the entry says where in the product you are). Reaching an asset was three hops from anywhere for the page the operator opens most, and every asset-centric SaaS puts the objects you live in one click from everywhere. The stage glyph is Stepper's own lifecycleStepper() at nav scale — four muted segments filled to the current stage, no labels, no connectors — so the nav can never disagree with the asset page about which stage an asset is in, and it draws NOTHING for a live asset, the stance SeverityDot takes on the same row. Order is the index's default (the payload's seed order: /assets implements 'seed' by not sorting, so there is no helper to import) with retired sunk to the foot behind the desk's switched-off slash — chosen over an 'Archived (N)' disclosure, which would put a second collapsible state and a second stored preference into the chrome for a case the portfolio does not have yet. A quiet New asset row closes the list; above NAV_ASSET_LIMIT (12) the list shows the leading slice plus All assets…, a plain Link rather than a NavLink because it goes where the entry above already goes. Collapsible from a chevron that is its own control beside the link, remembered in localStorage (`noticeos:nav-assets`, every read and write in try/catch): the record holds the operator's choice AND the row count last drawn, and `open` stays ABSENT until the chevron is worked, because the desk column defaults open while the drawer defaults closed and writing a default down would hand the drawer a preference nobody expressed. The stored count is what the loading render reserves, so the nouns below Assets do not jump when the first poll lands; before any successful read it draws nothing at all, never a name-shaped placeholder. First run shows only New asset. It reads useWall() — the same cached query the desk pages already run — and the gallery passes `assets` instead, which keeps /dev/kitchen-sink off both the store and the remembered state. THE INTEGRATIONS ENTRY WEARS AN EXPIRY DOT (2026-09-05, bead ro-vu8d.8) when a portfolio-shared credential is inside its fourteen days — warn, or error once one has passed — pointing at the provider card, where Reconnect lives. That dot plus the card is the whole CEILING (decided 2026-09-05, bead ro-vu8d.19): neither /wall nor Home's Alerts list carries the fact. D15 gives it to the action list and both of those are roll-ups of that list; nobody can reconnect from a television, and WALL_PAYLOAD_INVENTORY already refuses the TV's scarcest space to a row nobody is asked to act on; the Wall says the true thing anyway once a credential actually stops a collector, as a degraded source rather than a fourteen-day prediction; and Home is a desk page, so the sidebar is already on it. The one hole that left was the SMALL SCREEN, where the sidebar hides behind the menu button, so the top bar wears the same dot from the same predicate and the same one-sentence hover (expiringCredentialSummary), pointer-events-none over the button so the whole target stays the button.",
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
      "Go-to-anything for the desk (bead ro-d298): ⌘K / Ctrl+K anywhere inside the shell, or the sidebar footer's Search button for a touch operator with no modifier key. doc 10 principle 4 has named a command palette since the Tower was a sketch and apps/tower/README.md deferred it; with a left sidebar and eight destinations it is the affordance a keyboard operator reaches for first, and the one they reach for most is an ASSET, which is why assets are a group here rather than a later phase. SCOPE IS NAVIGATION AND ONLY NAVIGATION — it moves the operator, it never acts for them; running commands from the palette is doc 16's flow L, a larger thing needing a verb vocabulary and a confirmation story. Three groups: Pages (the eight nav items plus the TV, with their own NAV_ITEMS icons and per-item keywords so 'revenue' finds Financials), Assets (favicon, display name, domain, and a severity dot ONLY for an open warn/error — identity is the favicon, exactly as on the cards), and Open task, offered when the query looks like a bead id (`^[a-z]{2,4}-[a-z0-9.]+$`) and force-mounted because cmdk would score the row against an id its own words do not contain. That row lands on /tasks/:id, the task page (bead ro-l1ed.3). RECENT selections are remembered in localStorage (`noticeos:palette-recent`, every read and write in try/catch — a broken convenience is not an outage) and lead the list while the query is empty, LIFTED OUT of their own group rather than drawn twice; a task is deliberately not remembered, being a lookup rather than a place. The ⌘K binding requires the modifier, which IS the guard that keeps a global shortcut from eating what the operator is typing into a filter field. It is mounted by AppShell, so it exists on every desk page and on none of /wall — the television renders outside the shell, has no keyboard, and stays read-only by construction. IT IS FETCHED ON FIRST OPEN (bead ro-ujb9.84): cmdk and this file are not in the shell's download. The shell owns the ⌘K binding and the Search button (lib/palette-launch.tsx holds the shortcut test), keeps the open as state from the very first press, and draws the palette from then on — nothing at all until its code has arrived, then the palette already open. The modifier pressed alone, or a pointer or focus on the Search button, fetches it first. Registry justification: nothing here searched or jumped. Drill drills INTO a fact on the same surface, PropertySectionNav jumps within one page, and AppShell/Sidebar is the list you read rather than the one you type at.",
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
      "One page header for every desk surface (bead ro-pbzu.1): title, description, breadcrumb, right-aligned actions, an inline meta slot, and a full-width children slot for tabs. The registry had no page-level heading at all — CardHeader/CardTitle title a CARD, and the routes had each grown their own heading size, their own back link, and their own idea of what chrome belonged in it. It carries no back link because navigation is the shell's job now, and it adds no state vocabulary: `title` is a ReactNode precisely so the asset page can keep its identity row (favicon, name, severity dot, domain, status badges) AS the h1 instead of repeating the name above a separate strip (doc 14, one representation per fact).",
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
    variants: ["Card", "CardHeader", "CardTitle", "CardContent", "CardFooter"],
  },
  {
    name: "Sheet",
    file: "components/ui/sheet.tsx",
    purpose:
      "A modal side sheet over the right edge of the desk (bead ro-ujb9.96.7.1): the desk behind is blurred and inert, Escape / the close control / a press on the desk close it, focus starts on the sheet's first field and returns to the control that opened it. On a phone it is the whole screen under the app bar. `placement=\"center\"` (bead ro-ujb9.96.7.5) is the same modal for a short question answered once — Add a site: a 440px card high in the middle of the desk, and on a phone the same card under the app bar rather than a whole screen for one field. Registry justification: TaskComposer and RuleTune each drew their own overlay inline; this is the one primitive a connect-style panel composes.",
    variants: ["desk: right edge, 430px", "phone: full width under the app bar", "center: one-question card (desk and phone)"],
  },
  {
    name: "Popover / PopoverTrigger / PopoverContent / PopoverAnchor",
    file: "components/ui/popover.tsx",
    purpose:
      "shadcn's Popover on Radix (bead ro-ujb9.219), in this theme's tokens: a focusable panel placed against its trigger. Opening moves keyboard focus into the panel; Escape, a press outside and focus leaving close it; focus goes back to the trigger unless the close put it on another control, so it is never dropped on the page. Portalled, kept inside the viewport, and a page scroll moves it rather than closing it. role=dialog with aria-expanded / aria-controls on the trigger. Registry justification: EvidencePopover was a hand-rolled portal with no focus management that closed on any scroll; InfoTooltip is a tooltip for label-length facts, not a dialog; Sheet is modal.",
    variants: ["open from a key or a press", "Escape / press outside return focus", "a press on another control keeps it", "follows a scroll"],
  },
  {
    name: "Table",
    file: "components/ui/table.tsx",
    purpose:
      "shadcn table primitives. `stacked` is the ONE phone mechanism and it is declared here once (bead ro-md80): below `sm` each row reflows into a labelled card, the header row hides because every label it held is now on the cell, and TableCell's `label` is painted from `data-label` by the table's own arbitrary-variant rules — so the parts know nothing about it and no surface grows a second row component. Nothing is hidden: an unlabelled cell stacks as a full-width line, an empty one is dropped, and a chrome-only cell says `dropWhenStacked` (a bare max-sm:hidden on the cell loses to the [&_td] rules — the specificity trap that attribute closes). A long table's rows also FOLD (bead ro-c59x): `foldedWhenStacked` on a TableRow hides every cell marked `foldWhenStacked` below `sm` and leaves the one marked `onlyWhenStacked` — the summary line the card shows in place of its fields, itself hidden from `sm` up where the header row already says it. Without `stacked` a table scrolls inside its own box exactly as it always did, which is the right answer for a raw-evidence disclosure.",
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
  },
  {
    name: "Command",
    file: "components/ui/command.tsx",
    purpose:
      "cmdk primitives — the filter/list/group/item machinery `CommandPalette` is built out of, vendored beside the other shadcn parts (doc 14's stack table names cmdk). Nothing else in the Tower opens a command menu, so this file has exactly one caller; it stays a primitive rather than folding into that caller because a second menu would otherwise copy the parts instead of importing them.",
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
      "The decision-lane VOCABULARY, drawn once (bead ro-427): the lane and tone types, the tone classes, each lane's word, the four-count strip above a decision table, and the two cell primitives both tables lay out with. Two surfaces classify evidence into the same four lanes — QueryVisibilityRankings over queries and PageDecisions over pages — and an operator reading down one asset page must meet one system rather than two, so the words and colours live in one module. It decides NO lane: each surface keeps its own rules, because a page and a query are judged on different evidence and a shared assessor would be one engine pretending two grains are the same. A third decision surface imports these rather than picking new words; that is what puts it in the registry despite having no face of its own.",
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
      "Asset-only 90-day search charts plus a color-coded responsive query-decision table. Each normalized query gets an explicit act/investigate/protect/wait assessment read as ONE VERDICT LINE — the label, an arrow, one short imperative naming the page (bead ro-ujb9.96.6.5; no rationale sentence, no 'Original suggestion:' prefix) — source evidence, and LAN-safe agent-ready Copy Markdown handoff with exact evidence/windows and limitations. Google/Bing observed impressions and equal-window movement stay distinct from DataForSEO modelled demand, current rank, difficulty, search intent, estimated visits at the current rank, and AI Overview evidence, which is ONE ✧ PER SURFACE — phone then desktop, drawn by the registry's AiOverviewGlyphs, the very component SerpPanelBoard renders on the same page (bead ro-glf), each mark labelled by surface (bead ro-e46.2). The evidence line names both where they disagree and SPELLS an unchecked surface rather than omitting it, so a missing mark cannot read as the two agreeing; both tracked-panel rules read ANY surface, since a citation on the phone is a citation to protect and an overview on the phone consumes the click there. Whether a query has already been picked up is the BEAD somebody filed from its handoff (same `HandoffBeadBadge` the finding card carries, joined by `noticeos_key`), never the fact that the operator copied the Markdown — copying is an intention and a bead is work, so a copy nobody ran now marks nothing and a filed row sinks below unfiled ones in its band (bead `ro-5e8.3`). A row also OPENS THE OUTCOME-CHECK COMPOSER (bead ro-5e8.5): copying hands the work off, this pre-registers how it will be judged before the numbers exist. The seed carries the number the row's decision is about — gsc/position for the lanes arguing about where the asset RANKS (near win, ranking opportunity, organic gap, weak, strong), gsc/clicks for the lanes about the traffic that ranking produces — and the composer marks the grain QUERY-SCOPED and sends the exact query for GSC series, whose evaluator reads only provider-final daily query archive rows; changing to a provider without query-grain history visibly becomes SITE-WIDE, missing query days remain missing, and the asset total is never substituted. Ghost-quiet under Copy Markdown, and a surface passing no onWatch (the gallery) renders no button. The Sources-and-limits drawer also carries each lane's own PROOF rows — today the grounding-exclusion check both movers lanes run before ranking anything (bead `ro-14d.2`) — and it renders them AT ZERO, because the row exists to prove the check ran: 'excluded nothing' and 'nobody checked' are different facts and the second one renders no row at all. Applicability is said ONCE: the list's shared state in its header, withheld when the screen already states it (statedState), and a row chip only where a row differs; Google and Bing comparing the same windows are one badge.",
    variants: ["recover", "near win", "ranking opportunity", "organic gap", "mixed", "weak", "strong", "growing", "wait", "intent token", "estimated visits", "secure copy", "HTTP LAN fallback", "copy failed", "three sources", "one source", "first DataForSEO baseline", "historical rank movement", "AI cited", "AI result shown", "AIO phone-vs-desktop split", "AIO surface never checked", "insufficient windows", "desktop", "mobile", "daily", "weekly", "irregular", "provisional Google tail", "filed (open bead)", "filed (closed bead)", "unfiled", "register not asked", "lane proof row", "lane proof row at zero", "lane ran no check (no row)", "watch the outcome (rank lane -> position)", "watch the outcome (traffic lane -> clicks)", "no composer behind it (renders no action)"],
  },
  {
    name: "ProductJourney",
    file: "components/ProductJourney.tsx",
    purpose:
      "The asset Growth tab's Product section (beads ro-ghis.2 / ro-ghis.3): what people do once they arrive, and where it breaks, from the executive snapshot's PostHog `product` block. One strip of daily use (people a day, page views, sessions — each with its sparkline — plus the main funnel's end-to-end rate against the week before), the funnels as Meter bars against their first step with the largest drop marked by ▼ and words, a 'Where it breaks' ListPanel GROUPED BY PAGE (bead ro-ujb9.96.6.5: a '/calculator' heading holding its speed, rage-click and error findings, most severe first; groups ranked by their worst finding; an unplaced error and a repeating once-only event under 'Whole site'; probable third-party noise its own group, last) — closed, the worst finding of each of the three worst places — a checks line naming every rule that found nothing as clear / not enough data / not collected. No explainer (bead ro-ujb9.96.6.5): no About and no header tooltip — PostHog's caveats are in docs 11 and 20 — and an opened row is labelled counts, an error-origin chip (site code / no source file / unknown) and one imperative where there is a fix, never a sentence. Speed ratings are StateChips in the attention tones (good = neutral ✓, needs improvement = caution !, poor = critical ✕), always with the rating word (doc 14). Each part prints its own window, because the families measure 28, 14 and 7 days. No product block renders one quiet line — not connected / connected but not collected yet / not collected for this asset — never a strip of zeros. Registry justification: nothing drew PostHog's families; `ProductUse` on the same tab is GA4 event totals with no series, funnel or breakage, and `ExecutiveFindingsList` renders findings, not the funnel shape or the ratings a finding is picked from. It composes SmallMultipleStrip, Meter, ListPanel/ListRow, StateChip, DeltaChip, InfoTooltip and SectionLabel and adds no primitive.",
    variants: ["full acceptance read", "thin read (not enough data checks)", "several funnels behind the expander", "no earlier week", "connected, not collected yet", "not connected", "not collected for this asset"],
  },
  {
    name: "PageDecisions",
    file: "components/PageDecisions.tsx",
    purpose:
      "The query table's four lanes on the grain an operator actually EDITS (bead ro-427). The page grain had cards and no verdicts: page-movers could say a page moved and nothing on the asset page said what to do about it. One row per page present in BOTH seven-date Search Console windows — a page reported in only one week is unknown rather than zero and is left out, which understates movement at the export boundary and is the direction that cannot invent a finding. Eight rules, each a label (what happened) and one short action (what to do) on the closed row, with the evidence behind it one press away (bead ro-ujb9.96.6.8). A click move names its LIKELY CAUSE on the evidence line that explains it — ranking moved a full position, impressions moved a fifth, else a release recorded inside the window, else the result page — so the operator is not asked to work it out. The rows' shared applicability state is said once in the list header; a row carries its own chip only where it differs. Rules: lost clicks (act), gaining clicks (protect), shown-rarely-clicked (act — a visible position converting below the ~2.1% a cited result earns is a snippet question before a ranking one), shown-more-taken-no-more (investigate), position-slipping (investigate), and no real change (wait), which STAYS in the table because a flat page is a finding and a missing row is not. The two tracked-panel rules apply through the page's LEADING QUERY — its largest by impressions on the grounding-decontaminated page/query series, not the one it earns most clicks on, since a harvest candidate is precisely a page whose biggest query takes few clicks — and both read `=== true`, so an untracked or never-loaded overview changes nothing. The totals are NOT grounding-decontaminated and the lane says so: a page row carries no query to classify, so the exclusion applies to the leading-query join alone and its evidence row is labelled for the join rather than for the numbers above it, present at zero like every other exclusion row. It shares the query table's lane words, tones, counts strip and cell primitives through `decision-lanes` and NONE of its rules, because a page and a query are judged on different evidence and one assessor would be an engine pretending two grains are the same. Its handoff is keyed on the absolute page URL (two assets can share a path) and carries noticeos_kind 'page'. The poller and payload accept that third HANDOFF kind without widening the decisions store; the shared HandoffBeadBadge shows the filed task on the row, and filed pages sink below unfiled peers inside their priority band (bead ro-e46.4).",
    variants: ["lost clicks", "gaining clicks", "shown rarely clicked", "walled by AI Overview", "AI Overview cites this page", "shown more taken no more", "position slipping", "no real change", "likely cause tagged", "release in window", "shared state in header", "AIO surface split", "AIO surface never checked (no line)", "leading query unknown", "fold (more than eight pages)", "filed (open bead)", "filed (closed bead)", "unfiled", "register not asked", "secure copy", "HTTP LAN fallback", "copy failed", "no two complete weeks (stated absence)"],
  },
  {
    name: "FilterBar / FilterFold / FilterToggle / FilterControls",
    file: "components/surface/FilterBar.tsx",
    purpose:
      "A page's filters and sort, folded behind ONE press on a phone (bead ro-ujb9.13, doc 21's phone first screen). Registry justification: Sites, Alerts and Tasks each drew their own filter row and only Sites folded it on a phone, by hand; at 390×844 the other two spent two rows of selects above the first alert or task. Below `sm` the controls wait behind one Filters button carrying the number narrowing the page (Plausible's +N filter button; Linear's one Display options button); from `sm` up the button is not drawn and the controls lay out exactly where they always did — `FilterBar` joins them to the page's own row with `display: contents`. A period is not a filter: a range stays in view beside the button (Plausible and Vercel keep the period picker in the top bar). `aside` holds a fact about the list (a board's age, where in an archive) and is never folded. `FilterFold` + `FilterToggle` + `FilterControls` are the parts, for a page whose button shares a row with something else (Sites puts it beside its range).",
    variants: ["phone: folded (the button only)", "phone: open", "active count on the button (Filters, 2 on)", "desk: the page's own row, no button", "aside kept beside the button", "parts: toggle in another row (Sites)"],
  },
  {
    name: "RangeSelector",
    file: "components/surface/RangeSelector.tsx",
    purpose:
      "The page's ONE range — 7d / 28d / 90d, default 28 (D24, operator-decided) — sitting in the page header and driving every delta, sparkline and chart below it (doc 21). Registry justification: the desk had no page-wide range at all; each chart carried its own 'last 90 days' subtitle, so one surface answered its one question over three different spans and nothing the operator changed moved more than one card. A row of `pillChoice` toggles rather than a select: three options read as a set, one press to change, and the 44px thumb floor arrives with the shared chrome (bead ro-md80).",
    variants: ["7d", "28d selected (the default)", "90d", "custom options", "phone (44px floor)"],
  },
  {
    name: "SectionLabel",
    file: "components/surface/SectionLabel.tsx",
    purpose:
      "The eyebrow every doc 21 section opens with: an 11px tracked uppercase title, one quiet caption of at most a sentence saying what the section IS, and one link at the right that takes the question elsewhere. Registry justification: it was built beside the two asset tabs that first needed it (ro-78qo.4), because two callers in one folder is layout rather than vocabulary — and Home's assets panel is the third caller, with the mockup putting the same header on every index page, which is where a second local copy becomes the near-duplicate this catalog exists to prevent (bead ro-78qo.27). It replaces SectionCard's header on a view surface: a card per section, each with a title, a paragraph and a config chip, is the shape doc 21 exists to end. The link's 44px target is CLAIMED from the row on a phone rather than added to it (OwnerChip's pattern, bead ro-9smi), so an eyebrow row stays 24px on the desk. It never renders a <summary> (bead ro-78qo.39): a disclosure's caller keeps the press target and its ring on the summary and wraps this header inside it, and `eyebrowClass` is exported beside the component for the two eyebrows that are a LABEL INSIDE A CONTROL (the panel toggles on /financials and /health, where an h2 inside a button is invalid) plus Kpi's and SmallMultiple's own labels. `ListPanel` drew the same three parts as its own header and now COMPOSES this one (bead ro-78qo.33), so the desk has a single eyebrow: the panel passes its card's padding as a class, its quiet count as the caption and its 'All' link as the action, and its own props did not change.",
    variants: ["title only", "with a caption", "with a link action", "with an owner chip (node slot)", "inside a summary", "as a panel header (Home's assets)", "inside ListPanel", "phone (44px floor claimed)"],
  },
  {
    name: "KpiStrip / Kpi",
    file: "components/surface/KpiStrip.tsx",
    purpose:
      "Desk headline metrics in one hairline-divided strip: label, value, comparable delta and an optional metric-specific spark. Names, units, essential scope, short plotted method and Not comparable/History unavailable verdicts remain visible. One InfoTooltip combines exact trend dates, comparison/history explanations and route-specific explanation content. A selectable KPI and its info button are sibling controls, never nested; a static KPI has no selection action. DeltaChip provides the like-for-like verdict; incomparable periods show no percentage. Raw, trailing-average and precomputed-average inputs remain distinct, with no double averaging. Standalone sparks expose plotted values by keyboard/touch; selection buttons use their equivalent accessible HeroChart. Wall metrics retain their independent TV layout.",
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
      "Interactive desk time series, independent of the Wall's purpose-built charts. Calendar-aligned daily lines and bars, monthly and step forms mark isolated observations, offer explicit point markers for sparse snapshots, and preserve missing-date breaks, signed or zero-based scales, calculation-only pre-roll, and provisional markers. One named key doubles as each series toggle; solid/dashed/dotted patterns identify Financials series without color, and the final visible series cannot be hidden. HTML text stays readable when SVG geometry stretches. Pointer, touch and keyboard inspection expose dated values; a native View data table provides an equivalent semantic data view. formatValue keeps exact readouts separate from compact axis labels. ChartEventMarkers anchors each annotation's original date and full explanation to its own hover/focus/tap target, grouping nearby targets when needed without moving the original dashed marks. Each provider owns its provisional boundary; averages exclude unfinished values, keep missing-date breaks and stop at that provider's last report. Partial seven-day averages disclose their available-report count in readouts and method help. Event and point readouts never compete.",
    variants: ["single/multiple series", "daily bars with zero and gaps", "outlined partial bars with dated coverage notes", "explicit calendar end", "series toggles and line patterns", "monthly", "signed (zero line inside plot)", "step", "average on/off", "weekend bands", "event hover/focus/tap", "grouped events with original dates", "provisional endpoint", "missing-date breaks", "pointer/keyboard dated values", "exact values with compact axes", "accessible data table", "180px pair height", "empty"],
  },
  {
    name: "ChartEventMarkers",
    file: "components/ChartEventMarkers.tsx",
    purpose:
      "Event-specific chart explanations for the desk HeroChart without replacing its geometry. Registry justification: EvidencePopover explains health evidence, not dated annotations, and SVG titles alone cannot be inspected reliably by keyboard or touch. Each marker has a 44px button and anchored disclosure on hover, focus or tap; desk dashed lines also open it. Nearby events share a target at narrow widths while the disclosure preserves every original date, label and detail. Escape, outside interaction and scrolling dismiss the disclosure; opening an event suppresses competing point readouts.",
    variants: ["single event", "same-date events", "nearby dates grouped", "full original detail", "hover/focus/tap", "dashed-line target", "Escape/outside dismissal", "existing Wall glyph retained", "viewport-clamped disclosure"],
  },
  {
    name: "ChartLine / ChartArea / ChartDot",
    file: "components/surface/ChartMarks.tsx",
    purpose:
      "THE CHARTS' ONE LANGUAGE (bead ro-trai.19, doc 14 § Charts): the three marks every small chart is drawn with — the Wall's month chart, today by hour, the 30-day lines, visitors and money, search clicks, and the desk's Sparkline. ChartLine is a monotone-smoothed line (lib/chart-path's Fritsch–Carlson curve: through every reading, never overshooting one) with round caps and joins, a `ghost` form for a comparison (dashed, low-contrast neutral ink) and a `projection` form (dashed in the series' own ink at reduced strength), dashes corrected for their round caps, and an optional casing of the surface so it reads across bars. ChartArea is the wash under a line: the series' ink easing to nothing at the baseline, with an optional feathered right end where a line stops mid-chart. ChartDot is a point drawn as a round zero-length stroke — round in any stretched viewBox — on a ring of the surface, with a soft halo at TV sizes, a hollow form for a provisional cap and a gentle pulse for a series still being counted (none under reduced motion). All three take their colour from currentColor, so the caller's token class decides a series' colour in one place, and every path eases to a new shape when a poll changes it. Registry justification: Spark, DailyBars and HeroChart are whole charts with their own axes, bands and readouts; nothing drew the marks themselves, which is why the Wall's four charts and Sparkline had grown four polylines, three flat fills and two kinds of dot.",
    variants: ["solid line", "ghost comparison", "projection", "cased line over bars", "wash", "wash feathered at now", "dot sm/md/lg", "hollow dot", "halo", "pulse (live)"],
  },
  {
    name: "MinutePulse",
    file: "components/surface/MinutePulse.tsx",
    purpose:
      "A SITE'S LIVE USERS MINUTE BY MINUTE (bead ro-trai.27, the Google Analytics realtime-card pattern, docs/briefs/2026-09-23-live-pulse.md): one bar a minute for the last 30 minutes, oldest on the left, scaled to the busiest minute; the newest five — the 5-minute window — in full ink and the 25 before them muted, so momentum reads from the shape. A minute nobody was active is a tick on the floor; a minute the reading did not cover (null) is nothing, never a zero. `dimmed` draws it in neutral ink for an old reading. Colour from currentColor (the traffic identity on the Wall); bars are butt-capped strokes on whole pixels in a 1:1 viewBox, so thirty 3px bars stay crisp, easing to a new height (chart-morph; none under reduced motion). Sizes: row, roomy, focus. Registry justification: ChartLine/ChartArea/ChartDot draw lines and points, not bars; VisitorsChart's bars are HTML columns filling a tile with a hatched day and a money line; DailyBars is a whole desk chart with axes and bands.",
    variants: ["live", "dimmed", "quiet minutes", "unread minutes", "row", "roomy", "focus"],
  },
  {
    name: "Sparkline",
    file: "components/surface/Sparkline.tsx",
    purpose:
      "Compact desk trends at three standard sizes: KPI 64x22, table cell 96x24, and full-width 30px high. No axes or grid; the caller labels the metric and scope. Raw, trailing-average and precomputed-average modes describe their actual method and date span accessibly; precomputed input is never averaged again. Optional pointer, touch and keyboard readouts show the plotted value first, identify an averaged window and its supplied coverage, and show raw values separately only when supplied. Lines are monotone-smoothed (they pass through every reading and never overshoot one) and an area is a wash that fades to the floor, both drawn by ChartMarks (bead ro-trai.19); the endpoint cap is a round stroke, so the wide size's stretched box never draws it as an ellipse. Missing points break the line; provisional endpoints are hollow. Empty data draws a dash whose accessible name includes the reason. keyboardReadout=false avoids nested controls inside a KPI selection button with an equivalent accessible HeroChart. SERIES_TONE_CLASS owns neutral, identity (provider, financial, and the Wall's `traffic`), comparison and severity tokens.",
    variants: ["kpi size", "table-cell size", "wide", "area", "raw daily/monthly values", "trailing average", "precomputed average (no double smoothing)", "dated method description", "plotted-value readout with raw value separate", "pointer/touch/keyboard", "provisional endpoint", "provider/financial/comparison tone", "single point", "missing-point break", "empty with accessible reason"],
  },
  {
    name: "SmallMultiple / SmallMultipleStrip",
    file: "components/surface/SmallMultiple.tsx",
    purpose:
      "A row of comparable measures in ONE bordered strip (doc 21): label, figure, what the figure is against ('avg 122 / day'), and the shape behind it. Registry justification: the asset page drew five product-use figures as five separate cards, each with its own border, heading and subtitle — five boundaries around five numbers that are only interesting beside each other. The strip is the boundary and the cells are hairlines. It carries the border `KpiStrip` deliberately does not, because a small-multiple row stands on its own under a section eyebrow rather than fusing to a chart. Its sparkline is full-width and FILLED, which is what makes five cells comparable at a glance and the reason they are drawn as a row rather than a list.",
    variants: ["five across", "six across", "two columns on a phone", "no series (figure only)", "headline unit", "comparison below headline", "explicit raw history", "dated chart caption", "secondary line", "hover readout"],
  },
  {
    name: "ListPanel / ListRow",
    file: "components/surface/ListPanel.tsx",
    purpose:
      "The desk's one list of things that need something (doc 21): an eyebrow title, a quiet count, one 'All' link, three rows by default, and a row that expands IN PLACE to its evidence and actions. Its header IS a SectionLabel (bead ro-78qo.33) — the eyebrow lives in one file and this panel supplies the card's padding around it. Registry justification: the same list existed three times — the asset page's `AttentionBand`, `ExecutiveFindingsList`'s default rendering and Home's operator inbox card — each with its own header, row shape and idea of how many rows is too many. The extra rows are DISCLOSED rather than dropped: a panel silently keeping four of seven is lying about the size of the queue, so the count sits in the header and the expander says how many are behind it. A row's mark is a RING plus a glyph, so severity is never colour-only (doc 14); `ok` is the one tone that is not a doc 02 severity — a finished thing among unfinished ones, in the health green that already means an evidenced all-clear. A row with no evidence does not expand, and expanding one moves nothing else on the page. A row also forwards a caller's `marks` — data attributes only — onto its own <li> (bead ro-78qo.40), because a mark that describes the ROW claims a smaller subtree than it means when it sits on a child; AlertRow's four materiality attributes are what earned it, and Sparkline's `data-spark` is the precedent. THE DECISION ON THE ROW (bead ro-ujb9.96.7.11, Linear Triage): `rowActions` puts a row's one decision beside its value without expanding it — a sibling of the row's own button, never inside it — and on a phone on its own line under the title; `below` holds the answer box a row action opens in place. The evidence and the rarer verbs stay in the expansion.",
    variants: ["three rows", "more behind the expander", "row expanded with evidence and actions (chevron)", "navigation via to with optional returnTo (the › disclosure chevron, bead ro-ujb9.13)", "static row (no affordance, no hover)", "two-line title", "captionWrap retains essential dates/status in a closed row", "error / warn / info / ok marks", "custom glyph", "value including zero with a micro label", "no value", "header link", "empty", "grouped by subject (first row of each of the first three groups; the expander opens every row in place)", "decision on the row (rowActions: Approve, Answer / Dismiss, File task, a source's Connect in place of its value, kept on the row's line on a phone with rowActionsInline — bead ro-ujb9.96.7.5)", "answer box under the row (below)"],
  },
  {
    name: "StatusBanner",
    file: "components/surface/StatusBanner.tsx",
    purpose:
      "One line at the top of a surface, for exactly as long as its state is open (doc 21): a ring or a dot, a bold lead, one sentence, one link. Registry justification: it replaces the asset page's Setup checklist SECTION — a full card with a heading, a paragraph and a list of steps sitting above the charts on every visit long after the operator had read it. The checklist keeps its home on Sources; what belongs above a view surface is the line that says setup is unfinished and where to finish it. `open={false}` renders NOTHING — not a collapsed strip, not a dismissed placeholder — because the contract is that it disappears when its state closes. It composes the registry's `ProgressRing` for a discrete step count and `SeverityDot` otherwise rather than drawing a mark of its own, and it spends no severity colour on its own box, so a banner can never become a fifth alarm competing with the real alerts under it. AppUpdateNotice in BrowserEntry composes this same banner for a changed or unavailable app release, with an explicit new-tab link; it never remounts the existing workspace or stores its drafts (D41, ro-ujb9.298).",
    variants: ["setup ring (n of m)", "severity dot", "no action", "link action", "button action", "closed (renders nothing)"],
  },
  {
    name: "About",
    file: "components/surface/About.tsx",
    purpose:
      "The one disclosure per screen that holds the prose (doc 21 principle 3): what the numbers are, where they come from, what provisional means. Closed by default, and that is the whole point — `defaultOpen` exists for this gallery and for a first run. Registry justification: nothing here was a disclosure for EXPLANATION. `Drill` opens evidence for one fact, `EvidencePopover` says where a figure came from, and a `SectionCard` subtitle is copy the reader cannot escape; the asset page had a paragraph under every heading, shown in full on every visit to a page the operator opens several times a day. A native `<details>`: no state, no motion, and find-in-page still reaches the text inside it.",
    variants: ["closed (the default)", "open", "custom summary"],
  },
];
