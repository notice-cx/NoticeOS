# 14 — UI implementation standards (the Tower)

*The design system is the crystallization principle
([doc 05](05-execution-and-accountability.md)) applied to UI: decisions made
once, by the smartest reviewer, so implementing agents compose instead of
invent. Without this doc, every agent re-derives UI taste and the Tower grows
four button styles by Phase 2. UX behavior lives in
[doc 10](10-control-tower.md); this doc is the layer beneath it: libraries,
tokens, and the anti-duplication mechanics. Choices verified against the
mid-2026 landscape (2026-07-03); each carries a revisit trigger.*

## The stack (decided)

| Layer | Choice | Why / notes | Revisit trigger |
|---|---|---|---|
| App | **Vite + React + TS on Cloudflare Workers** | Portfolio standard, non-negotiable. SPA — ignore the RSC narrative entirely (common agent-confusion source; we have no RSC server). | never (portfolio-level) |
| Components | **shadcn/ui on the Radix engine + Tailwind v4** | Copy-in by design (we own the source — no runtime dep, no upgrade churn); the 2026 de-facto standard; and now the explicitly **agent-optimized** stack: shadcn MCP server (registry browse/install), shadcn/skills, and composition docs measurably cut agent hallucination. Radix over Base UI for training-data depth + battle-testing. | Base UI engine only if we hit real combobox/nested-menu pain — same component API, planned migration path |
| Styling | **Tailwind v4, CSS-first** | Greenfield gotchas agents must know: `@theme` in CSS (no `tailwind.config.js`), `@import "tailwindcss"` (no `@tailwind` directives), `bg-linear-to-*` not `bg-gradient-to-*`. | major-version release |
| Charts (panels) | **shadcn Chart (Recharts v3)** | The React-native default, themed via tokens, deep agent familiarity. ECharts is the documented escape hatch for heatmap/large-data drill-downs. | if a panel needs >~2k live points |
| Charts (the Wall) | **Small inline SVGs in one chart language** *(bead `ro-trai.19`)* | Every small chart — D28's month chart, today by hour, the 30-day lines, visitors and money, search clicks, and the desk's `Sparkline` — is drawn from three marks in `components/surface/ChartMarks.tsx`: **`ChartLine`**, a monotone cubic (`lib/chart-path.ts`, Fritsch–Carlson — through every reading, never above or below the readings either side, so smoothing states nothing the data does not), round caps and joins, with a `ghost` form for a comparison (dashed, low-contrast neutral) and a `projection` form (dashed in the series' own ink at reduced strength); **`ChartArea`**, the wash under a line, its ink easing to nothing at the baseline (never a flat block), feathered at a right end that stops mid-chart; and **`ChartDot`**, a round-stroke point on a surface ring. **A halo marks now** — today's hour, today's running total — and **a pulse marks a series still being counted** (today by hour); settled ends are plain dots and nothing moves under reduced motion. Strokes are sized for 3 m: hero lines 4 px, tile lines 3.5–4 px, row lines 2.5 px, ghosts 2–2.5 px. Bars (the one-site visitors) are HTML columns with 4 px rounded tops and one gap, the day still counted hatched. The live minute pulse (`MinutePulse`, bead `ro-trai.27`) is a strip of whole-pixel bars, a bar a minute: the newest five in full ink, the rest muted, a quiet minute a tick on the floor, an unread minute nothing. Axes are the first and last day (and noon for the day) in muted micro type beside, never on, the plot; the floor is a 1 px hairline; there are no legends. Colour comes from the caller's token (`currentColor`). `Spark` and `DailyBars` remain the older TV-card charts with week bands and hover readouts; provider comparisons on the desk use `HeroChart`. The 2026-07-29 audit removed uPlot: a chart instance + observer + React width state did not fit a fixed grid with a few dozen points. | measured SVG frame time or point density fails the Wall budget |
| Tables | **TanStack Table (headless) + shadcn data-table block**, `@tanstack/react-virtual` for long lists | The queue and registry are exactly this: sortable/filterable ranked tables with custom row actions rendered in our own components. AG Grid rejected: heavy styled dep + enterprise gating — against copy-in. | never for this app class |
| Data | **TanStack Query + `refetchInterval` polling** for v1 | Read-mostly dashboard off the D1 store; polling is the boring-correct choice. If the Wall wants push later: SSE into the Query cache, or a Durable Object with the WebSocket Hibernation API (no idle GB-s). **TanStack DB: evaluated, skipped** — built for complex local queries + optimistic writes; we're read-mostly. | Wall refresh latency actually annoying the operator |
| Palette / icons / misc | **cmdk** (via shadcn `Command`) · **lucide-react** · **Sonner** toasts · **Motion** for the few transitions · class-based dark mode | All shadcn defaults = zero novel decisions for agents. | — |

## The Notice identity (D35)

*Adopted 2026-09-23 (decision D35, bead `ro-ujb9.77.3`); it replaces the
Signal `rx` mark and Signal accent approved on 2026-09-09.* The app wears the
identity www.notice.cx wears: the Notice mark, a NoticeOS wordmark in Stack
Sans Notch and the website's blue. The permanent
[interactive reference](http://localhost:5173/design-system.html) and
[brand guidelines](brand/README.md) cover identity, palette, typography,
geometry, motion and product examples. `public/brand/notice.css` is the
shared source for brand colours, the two local fonts (Inter for the interface,
Stack Sans Notch for the wordmark only, each with its SIL OFL licence) and
geometry tokens; `src/index.css` maps them to application utilities and
retains specialized operational scales. The standalone reference never calls
product APIs. `BrandLockup` owns the wordmark and `NoticeMark` the mark — an
inline SVG in the current ink, 1.4 capitals tall — at sidebar, mobile and TV
sizes; the favicon set is the website's own.

**The blue is a brand colour, never a state.** `--brand-blue` is the website's
`#2745d4` in both themes and the light theme's accent; on the dark canvas the
accent is `#b0b9ff`, the tint the website draws its blue in on dark surfaces
(the blue itself reads 2.9:1 there). The accent feeds `--primary`,
`--primary-hover`, `--accent-soft` and `--ring` — primary actions, selected
navigation, active execution and focus — and nothing else: no severity,
status or series token may point at it (`apps/tower/test/brand-identity.test.ts`).

**Measured apart, as D35 requires.** Distances from the accent to every
colour that carries meaning, with the palette validator's two measures (OKLab
ΔE ×100 to the eye / under protan–deutan simulation, Machado 2009), on the
theme's own canvas. The same test fails if a named pair drops under the
validator's floors, 8 to the eye or 6 colour-blind:

| Meaning-bearing colour | Dark (`#b0b9ff`) | Light (`#2745d4`) |
|---|---|---|
| `error` | 19.5 / 15.3 | 35.1 / 25.2 |
| `warn` · `pace-behind` | 21.9 / 21.1 | 32.9 / 29.9 |
| `info` | 8.8 / 8.3 | 18.6 / 16.9 |
| `urgent` | 26.8 / 25.0 | 39.5 / 31.2 |
| `healthy` · `connected` | 20.8 / 14.6 | 27.9 / 24.7 |
| `trend-positive` · `pace-on` | 23.0 / 17.0 | 32.0 / 28.2 |
| `trend-negative` · `pace-far-behind` | 24.3 / 20.1 | 34.4 / 24.6 |
| `traffic` | 16.6 / 13.6 | 11.1 / 8.0 |
| `search-bing` | 11.6 / 6.0 | 10.9 / 7.2 |
| `financial-revenue` | 13.1 / 6.4 | 20.0 / 17.1 |
| `financial-cost` | 6.4 / 4.7 | 11.4 / 4.5 |

Two consequences. The light theme's `traffic` azure moved from
`oklch(0.48 0.19 265)` — 3.1 from the Notice blue, the same colour to the
eye — to `oklch(0.55 0.15 256)`, the dark theme's family, which still reads as
text on the light canvas (4.6:1). And the pairs under the validator's 15
normal-vision floor are ones that never meet as equals: the accent marks a
control or a selection, never a data mark or a state dot, and every state and
series it sits near carries its word or glyph (the Info chip, "Bing", the
Revenue/Cost legend and line styles). The expense violet was closer still
under the Signal accent (4.5 / 0.6 dark). A future accent change reruns this
table.

Inputs use the stronger `input` boundary token, checked above 3:1 in both
surfaces. Primary text/action/state pairs are checked at 4.5:1 or better
(the dark accent is 10.2:1 on the canvas and 6.9:1 on `accent-soft`; the light
accent 7.3:1 on white). Metrics retain tabular numerals. The Wall keeps its
true-black canvas and existing fit/type budgets; identity changes must be
reviewed at TV dimensions (`docs/artifacts/rename-2026-09-23/`).

## Tokens (define once; agents consume, never invent)

- **Colors:** severity is the attention color system — `error` red /
  `warn` amber / `info` slate per doc 02's severity enum, plus the reserved
  emerald accent for milestone-**kind** items. Scoped non-attention systems
  are defined below. Observed workflow execution uses `healthy` green for
  recorded success, `error` red for failure and neutral gray for paused,
  skipped, never-run or unknown states, with distinct text/glyphs. Historical
  success never implies that a stale runtime is working or that an LLM/business
  outcome was correct ([doc 22](22-workflows-research-and-design.md)).
  Asset headers use the site's favicon as identity and render a
  severity dot only for an open warning/error; healthy and unknown dots are
  intentionally absent. Integration connectivity uses `connected` green /
  `error` red / neutral gray. Completed
  like-for-like chart comparisons use
  `trend-positive` green and `trend-negative` red at three intensity steps:
  <10%, 10–25%, and ≥25% absolute change. Checks, `!`, bar/reference geometry,
  and arrows keep both systems non-color-only; provisional values stay neutral.
  A genuinely live split-flap value uses dedicated `live-up` / `live-down`
  text and surface tokens to name its last snapshot movement. They are explicit
  low-chroma OKLCH values, not browser-dependent runtime color mixing: the
  old-to-new turn carries the direction without color, the initial reading is
  neutral, and the tint never represents performance or provider health.
  `search-bing` blue is the one provider-identity token and is always paired
  with the visible word “Bing”; it never communicates health or performance.
  Financial comparisons use `financial-revenue` cyan and `financial-cost` violet as
  series identity, never as good/bad judgments. Revenue is solid, Cost dashed,
  and Net neutral/dotted, with one shared labeled legend/control row. Main
  charts offer keyboard point inspection and a collapsible exact-values table.
  **One key per drawn mark, and the key is the toggle** *(2026-09-24, bead
  `ro-ujb9.12`, prior art [`briefs/2026-09-24-chart-clarity.md`](briefs/2026-09-24-chart-clarity.md))*:
  `HeroChart` keys each series by its line exactly as drawn — tone, pattern and
  one of three weights (lead 2.5 px, reference 1.5 px, the daily values under
  an average 1 px at half strength) — in foreground ink words, never the brand
  accent; with more than one series each key is an `aria-pressed` toggle, off
  dimmed and struck through. A trailing average keys its bold line and its
  faint daily line; the hollow end point is keyed "Provisional". A
  **reference** series (the same weekday last week) is thinner, dotted, in
  `--spark` and never averaged or washed, so the lead reads first. On
  /financials the KPI sparklines wear the same revenue/cost/net identity as the
  month chart — the delta chip beside each carries the verdict — overriding
  doc 21's "the spark takes the delta's tone" for that page's three money
  series only. Every series tone clears 3:1 on the card in both themes and a
  key's words 4.5:1 (`test/chart-series-contrast.test.ts`; the measured ratios
  are in the brief).
  These are desk-chart conventions; the TV Wall retains its specialized,
  distance-readable widgets and true-black canvas.
  **`traffic` azure is the Wall's audience series identity** *(added
  2026-09-23, bead `ro-trai.19`)*: daily visitors, a site's 30-day trend and
  search clicks wear it beside money's `financial-revenue` cyan, so on the TV
  "people" and "money" read apart before a word is read. It is IDENTITY, never
  a judgment — a falling traffic line is still azure; direction and verdict
  stay with the weekly % and its trend tones. It was chosen by measurement on
  the TV's black (OKLab ΔE ×100): 22 from revenue cyan, 16 from the `info`
  slate (so an audience line never reads as an informational state), 24 from
  the pace green. It shares the blue family with `search-bing` (ΔE 7), so the
  two never draw on one chart: Bing's blue stays on the desk beside the word
  "Bing", and the Wall reads search clicks as one audience series. The desk's
  compact trends stay `--spark` neutral.
  **Today's pace is a scoped comparison scale of its own** *(operator
  decision 2026-09-30, bead `ro-trai.48`)*: today's completed hours against
  the same hours on the same weekday last week — `pace-on` green when ahead,
  neutral at exact equality, `pace-behind` amber for any deficit down to a
  0.60 ratio, `pace-far-behind` red below 0.60. The tokens are aliases of
  `trend-positive`, `warn` and
  `trend-negative`: this is the one sanctioned use of the warn HUE as a
  comparison step rather than a warning, scoped to the pace — "a little behind
  last week at this hour" is not an alert, and nothing else may borrow it.
  Colour is never alone: the Wall shows the arrow and %, with ahead, behind or
  on pace in its accessible description; desk comparisons keep those words
  beside the figure. The Wall's small completed-hours cutoff sits in a corner,
  leaving the chart's width to the plot and percentage (bead `ro-trai.51`).
  A missing comparison receives no verdict. Revenue projections against a
  finished month stay neutral, with above, below or level with stated in words.
  One derivation, `paceTone` in `components/DeltaChip.tsx`, decides the step for
  every pace the Tower draws (the Wall's rows and one-site tile — line, wash,
  now point and % — the old asset card and the desk's Today column).
  **Real-visitor speed ratings add no tokens** *(2026-09-22, beads
  `ro-ghis.2` / `ro-ghis.3`)*: a Core Web Vitals verdict against Google's
  lines is a measured pass or fail, so it follows the "missing/failing follows
  severity" rule below rather than becoming a fourth scale — **poor** wears
  `error` with ✕, **needs improvement** `warn` with !, **good** neutral ink with
  ✓, always beside the rating word (`StateChip` critical / caution /
  affirmative). A metric with no measurements is gray and says so; it never
  borrows "good". Doc 21 keeps colour to severity and provider, and a green
  "good" would spend the health colour on a fact that is not asset health.
  The `clock-face` / `clock-ink` / `clock-segment*` tokens are neutral material
  and illumination for the dark digital-watch widget, not another state scale;
  weekday/date/time text and lit/unlit segment geometry carry the information.
  The `urgent` token *(added 2026-07-31)* is the one step between `warn` amber
  and `error` red, so the countdown's five proximity bands
  ([doc 10](10-control-tower.md)) escalate along the attention ramp
  (`muted-foreground` → `foreground` → `warn` → `urgent` → `error`) instead of
  inventing a rival scale. It is **not** a fourth severity: doc 02's
  `info|warn|error` enum is unchanged and no flag may map to it. Its two hot
  bands also tint the segment surface with the existing severity-chip idiom
  (`border-<token>/40 bg-<token>/10`) rather than a new surface token; a
  background is an escalation the quiet bands must not spend.
  The `chart-distorted` / `chart-distorted-band` pair *(added 2026-09-04, bead
  `ro-kukv.8`)* marks a day a provider's reporting timezone change moved hours
  into or out of. It is **not** a severity and not an alert — nothing is wrong
  with the asset; the day is simply not comparable — but it sits in the warn
  hue at lower chroma than `warn`, because the ⚠ that already states this fact
  in prose is warn and one fact may not wear two colors, while two marked
  columns must never outshout a real alert dot on the same card. The band is a
  tinted `chart-week-band`; the ink draws the day's bracket and pin.
  A color literal in a component is a review-blocking smell.
- **State is scannable and never color-only** *(revised 2026-07-29)*:
  boolean and enum states use a short text label, with a registry glyph where
  it improves scanning. Color is supplementary: missing/failing follows the
  severity scale; operator-declined and not-applicable stay neutral/muted.
  The `milestone` emerald token remains reserved for milestone-kind outcomes;
  the reserved `healthy` token may only represent evidenced health where a
  surface genuinely needs it. Do not turn every state into a pill: compact table text plus
  one glyph is often clearer. A state expressed only by color fails accessibility;
  repeated text + chip + control for one fact still fails the
  one-representation rule. **Nor is a reason only a `title` attribute**
  *(2026-09-24, bead `ro-ujb9.14`)*: a keyboard, a phone and a
  non-focusable span never show one. A missing value's dash is the trigger of
  its own `InfoTooltip` (hover, focus and tap; a page scroll moves the panel,
  it does not close it); `SeverityDot` draws error, warning and healthy as a
  circle, a triangle and a check; a stale age or a late report adds the clock
  with a mark. Chart values are reached by focusing the plot and stepping it
  with the arrow keys, the readout the pointer shows.
- **A task's priority is not a severity** *(added 2026-09-24, bead
  `ro-ujb9.200`)*: priority marks — the task board's row mark, `PriorityBar`
  and the task page's priority chip — never wear `error` / `warn` / `info`, and
  rank by ink weight instead (a filled `!` for top, a ringed `!` for high, a
  muted `◦` below), while a row whose register comes from what it is keeps that
  register at every priority (an ask waiting on the operator is `warn`, a top
  one too).
- **One representation per fact** *(added 2026-07-06, after the first
  offender shipped: a row rendering "Enabled" four times)*: a surface
  states each fact **exactly once**. If a knob is editable, the control IS
  the state display — the selected option carries the state color/glyph;
  never a state chip *and* a control for the same value. Where a rich
  display exists (the lifecycle stepper), it is the single source and the
  edit affordance must not restate the current value (a "change…" menu,
  not a pre-filled select beside it). Ordinary forms show a plain-language
  label, effect, value and scope (doc 15 principle 9). Internal keys and
  storage paths add no useful choice; omit them, including repeated Technical
  details disclosures. Provider identifiers remain visible when needed to
  configure a connection. Visual richness means few, strong,
  non-repeating signals; restating one fact in four forms is clutter
  wearing a design system's clothes. Review test: count renderings of the
  same fact in one row — more than one fails.
- **Time belongs to the fact it qualifies** *(added 2026-07-29 after the
  rendered asset-card audit)*: report freshness is one explicit sentence at
  card level; a grouped stock total names its all-time grain once; an accounting
  value names its month once; and a time-series visual prints its own actual
  start/end dates. Desk summaries group selected-period traffic, monthly
  financials and latest recorded status separately; a traffic selector does
  not imply that monthly money or open work follows it. Stacked mobile rows
  retain the accounting month and booking state when their table header hides.
  A raw count and a rolling average are different quantities: state the plotted
  method and actual dates, and make its readout name the value actually drawn.
  Precomputed averages must not be averaged a second time. A comparison over
  seven available reports is not necessarily a complete seven-day window.
  Event marks explain their own events on hover, keyboard focus and tap;
  detailed descriptions detached below a chart are not a substitute. On desk
  screens, most supporting fine print belongs in the shared hover/focus/tap
  tooltip. Keep units, essential periods and compact evidence warnings visible;
  put exact timestamps and detailed calculation/coverage explanations on demand.
  Avoid multiple help icons for one card. Tooltips require defined opaque theme
  colors, viewport-safe placement and keyboard/touch access. Wall keys and source
  context remain visible for passive TV viewing.
  Never scatter an age badge, month, “last report,” point count,
  and window tag around an unlabelled line. “Incomplete today” and “the
  provider may revise a completed day” are different facts: only the partial
  calendar day gets provisional styling; append-only revisions stay audit data.
  **“Not finished” and “not comparable” are a third pair** *(added 2026-09-04,
  bead `ro-kukv.8`)*: a day a reporting-timezone change distorted is finished
  and its number will never move again, so it may not borrow the provisional
  dimming — that would claim the opposite of the truth. Its value stays exactly
  as the provider reported it and the caveat goes around the mark instead (a
  tinted band over the day's own slot, a dashed bracket, a pin), with the shared
  sentence naming what moved and by how many hours in the hover. Its
  week-on-week color verdict IS withdrawn, on both sides — a clean day measured
  against a distorted one is not like-for-like either. **The withdrawal covers
  aggregate chips, not only per-day marks** *(added 2026-09-05, bead
  `ro-jkp2`)*: EVERY week-on-week chip whose comparison window straddles a
  change goes neutral — the Wall/Home asset card's signal panel, the asset
  page's three headline charts, its five supporting tiles — because a page that
  answers one question with a neutral tile and a confident green headline above
  it is running two rules, not one. Observed figures and series stay, and
  `TimeZoneCaveat`'s ⚠ says why, stated once per section where several chips
  share one property's move. **Desk period deltas are stricter** *(2026-09-05,
  `ro-ujb9.4` / `ro-ujb9.14`)*: when `PeriodDelta.comparable` is false, suppress
  the numeric change and show “Not comparable” with an accessible reason.
  Unequal reporting coverage or a reporting-timezone change cannot become a
  credible growth percentage just by removing its color. This does not hide
  the actual observed value and does not alter the Wall's separate marked
  comparison presentation. The
  window a chip qualifies is the window it actually compares — anchored on the
  last COMPLETE rolling day, never on a provisional latest point — and one
  predicate, `spannedTimeZoneChange` in `apps/tower/src/lib/series.ts`, decides
  it for every surface rather than each chip retyping the fourteen days. The
  marked days are
  derived from `distortedByTimeZoneChange`, never from a date a component holds,
  and every surface that draws the series shows the same mark.
  Weekly-seasonal daily charts are stacked, share the same Sunday–Saturday
  calendar-week bands, and compare each completed day with the same weekday
  one week earlier. Their headline direction compares the latest complete
  seven-day average with the one seven days earlier, rather than allowing one
  cyclical weekday to define the trend. Fetch and retain seven calculation-only
  dates before the visible window so the first visible day is neither neutral
  nor missing a rolling line when earlier observations exist. Pre-roll dates
  must not widen the labeled 28-/90-day viewport. A rolling window may therefore show partial weeks
  at its edges; never anchor “weeks” to the first arbitrary visible date.
  The newest visible week is unshaded; parity alternates backward from it.
  Shaded weeks use the dedicated, full-opacity `chart-week-band` surface
  token—not a low-opacity generic muted fill—so their grouping remains legible
  on the dark Wall. Adjacent-day deltas are not presented as growth.
  A realtime trailing-window snapshot is not another freshness timestamp:
  label each window directly, order the broader **30 min** value before
  **5 min**, and put the provider snapshot time in hover detail. Genuinely live
  numeric snapshots may use a compact split-flap face, but durable totals stay
  visually static. Hold at least two digit positions to avoid jitter, animate
  only changed digits, keep the settled face continuous rather than bisecting
  it with a permanent hinge, keep the old face neutral, and give the complete
  new reading only a faint green/red movement tint. Announce the whole updated
  value and honor reduced motion. A request failure is
  unavailable/reconnecting, never a fabricated zero.
  The compact card's traffic story is today-first: draw today's reported
  OS-timezone hours (the operator's clock, `OS_TIME_ZONE`, configured as
  `config/constants.json` `os_time_zone`) over the complete
  same weekday last week before the historical charts. The axis caption names
  the zone. Preserve the full 24-hour x-domain, stop today's solid line at the
  newest reported hour, and represent later hours as missing rather than zero.
  Pace compares only equal elapsed hours. Because each provider hour is
  converted with the clock in force on its own date, the intraday pace compares
  the same real hours across a reporting-timezone change; its ⚠ marks only the
  two days the boundary move distorted, never every window that spans the
  change. Because hourly active-user
  observations overlap people, never sum them into the DAU headline; use the
  exact daily distinct-user observation.
- **Reduce recall and decision cost on operator surfaces** *(added
  2026-07-30)*: lead with the current decision—working/problem, growth/decline,
  or open work—then disclose provenance and implementation detail. Use common
  words in visible labels; internal enum names may remain in types and
  evidence. One shared legend governs repeated compact charts. Healthy or
  unavailable detail is omitted or compressed to one line, while errors and
  actionable work earn a full panel. Long pages provide a stable section
  navigator; small screens expose one asset or detail group at a time.
  Developer-only references belong below the primary operator flow. These rules
  implement W3C COGA guidance on
  [clear words](https://www.w3.org/WAI/WCAG2/supplemental/patterns/o3p01-clear-words/),
  [clear page structure](https://www.w3.org/WAI/WCAG2/supplemental/patterns/o2p03-page-structure/),
  [clear controls](https://www.w3.org/WAI/WCAG2/supplemental/patterns/o1p05-clear-controls/),
  and [orientation within a process](https://www.w3.org/WAI/WCAG2/supplemental/patterns/o1p04-clear-steps/).
- **Material state has a checked rendering contract** *(added 2026-08-04)*:
  [`apps/tower/shared/materiality.ts`](../apps/tower/shared/materiality.ts)
  is the exhaustive map from each material condition to its source,
  derivation, visual priority, Wall destination, asset destination, and
  empty/unknown/stale behavior. It covers open flags with kind and severity,
  freshness and never-reported lanes, OS and scheduled-runner health, budget,
  human gates, active changes, outcome watches, and rollback/failure state.
  Current material state belongs inside the Wall's fixed scan horizon or an
  asset page's first viewport; it may never exist only in a collapsed
  disclosure. Evidence, configuration, and history may be progressively
  disclosed after the verdict. The top-level Wall and asset payload
  inventories are exhaustive TypeScript records, so a new concern fails
  typecheck until its visual role is declared. Fixture tests then construct
  every material condition and require a visible state surface with glyph or
  geometry—not prose alone—including honest empty, unknown, and stale states.
- **A container must earn its boundary** *(added 2026-07-30)*: do not wrap an
  already distinct visual or a whole dashboard region in another rounded card.
  The Home/Wall layout is the frame for its clock, countdown, and asset
  grid; only individual assets retain boundaries because adjacency would
  otherwise merge their data. Editing controls do not justify an otherwise
  redundant container.
- **Copy controls work on the trusted LAN origin** *(added 2026-07-30)*:
  components never call `navigator.clipboard` directly. Use the shared
  clipboard helper, which prefers `Clipboard.writeText` in a secure context and
  synchronously selects a temporary off-screen textarea during the click
  gesture on plain-HTTP `<machine>.local`. Remove the field immediately and report
  failure only when both mechanisms fail.
- **The Wall no longer draws the source strip** *(2026-09-23, D28, bead
  `ro-i4gc`; the default since bead `ro-trai.11`)*: what `/wall` shows is
  [doc 25](25-the-wall.md). A failing or overdue source reaches the TV as its
  site's one issue mark, a Needs you row and the strip's one state; healthy
  sources draw nothing there. The strip below is the desk's rule (Home, the
  asset header, Sources), and there is no Wall scale of it any more.
- **Compact source icons show the effective direct-input inventory**
  *(added 2026-07-29; fixed inventory 2026-07-30)*: Home and asset
  detail headers show the same seven slots in the same order: nightly report,
  GSC, Bing Webmaster, GA4, Clarity, DataForSEO, and uptime. Collector-backed health comes
  from the latest stored attempt, never a manual status control or the mere
  presence of a tag/credential: fresh success is connected-green + check;
  error/stale is error-red + `!`; no run is gray + dashed; `skipped` and
  `not-applicable` stay visible as gray inactive states rather than changing the
  strip's shape, and since 2026-09-04 they wear **different glyphs** — a slash
  for the lane somebody switched off, a bar for the lane that was never in play
  — because they previously differed only in opacity, which is the one
  distinction a television across a room cannot carry. Hover/focus states the
  full source name, state, evidence detail, evidence time, and route to detail.
  Act/output/revenue lanes stay in the register. The desk's mark is small
  because it is read at arm's length with a hover behind it; a mark sized in a
  pixel literal (`text-[7px]`) is the same class of smell as a hex literal. *(The
  Wall-scale strip of bead `ro-kukv.9` — the `wall-mark` tokens, every one
  clearing `--wall-axis-size` — left the TV with D28's default, bead
  `ro-trai.11`; its code goes with bead `ro-trai.20`.)*
- **The Wall's card rhythm is a token, like its type scale**
  *(added 2026-09-04, bead `ro-pimj`; the asset card it sizes leaves the Wall
  with D28, whose region and row budget is [doc 25](25-the-wall.md#budget-1920--1080)
  — the rule that whitespace on the fixed-height Wall is a token, not a
  per-component choice, carries over to the rows)*: `--spacing-wall-card-pad` (the card's
  inset), `--spacing-wall-card-gap` (between a card's blocks, and between the
  Wall's own bands) and `--spacing-wall-card-row` (between rows inside one
  block) in `apps/tower/src/index.css`. `/wall` is the only surface in the
  product with a **fixed height**, and its vertical budget is spent by the
  tallest property column — a column that stacks two cards pays every one of
  these values twice. Whitespace there is not free space, so it is not a
  per-component choice: a compact card that writes its own `gap-2` is the same
  smell as one that writes its own font size. The desk keeps Tailwind's steps;
  it scrolls, and nothing on it is competing for 1080 pixels.
- **The Wall also works on a phone** *(2026-09-12, `ro-322h`)*: saved row
  weights describe the TV composition. Smaller canvases reflow widgets in
  saved order and scroll vertically; they never squeeze a widget to zero width
  or depend on horizontal scrolling. Asset cards adapt to their own width,
  including totals, live users and chart captions. Check 320–430px phones,
  tablet widths and the TV boundary when changing Wall layout. The editor's
  fixed TV preview continues to use the saved composition at any host width.
- **Run `pnpm wall:fit` when a Wall surface grows** *(bead `ro-pimj`)*: the
  check is the only thing that sees this, because jsdom has no layout and the
  TV clip in `index.css` hides the failure from the browser. `ro-pimj` was 64px
  of drift assembled four and twenty-four pixels at a time by commits that each
  looked reasonable alone — a mark row that grew 4px per card (`3cd01a4`), and a
  money fact the portfolio card genuinely owed (`6a03ad7`, +24px). Neither
  author could have seen it without running the check.
- **Type:** one sans for UI; **tabular numerals mandatory** on every metric
  (`font-variant-numeric: tabular-nums` baked into the stat components, not
  applied ad hoc).
- **Dark-first:** the Wall theme is the default theme; light mode is the
  variant. Contrast ≥ AA everywhere; the Wall is read at 3 meters — type
  scales for tiles are tokens, not per-component choices.
- **Spacing/radius/shadow:** the shadcn scale as-is. No bespoke values without
  a token PR. `/wall` opts into compact component composition: tighter page,
  band, card, and chart gaps while preserving type size, axes, labels, and
  evidence. Compact mode may remove chrome; it may not remove meaning.

- **A quantity or a state carries the visual that makes it legible at a glance**
  *(added 2026-09-04, operator direction during the SaaS restructure, epic
  `ro-pbzu`)*. Every page, section and component the desk ships answers its
  question with a shape before a sentence, wherever a shape answers better than
  the number alone: a trend figure has its sparkline (`Spark` / `DailyBars`), a
  spend has its meter against the cap (`Meter`), a queue has its priority mass
  bar (`PriorityBar`), a comparison has its signed delta (`DeltaChip`), a state
  has its glyph (`SeverityDot`, `StateChip`, `BookingChip`), an asset has its
  favicon, and a table whose rows own a series carries a compact spark column
  rather than a bare percentage. The bar is **high-fidelity, intuitive and
  practical**: the visual must answer something the figure does not — direction,
  share of a cap, the shape of a distribution, which of several is worst — or it
  is decoration and does not ship. Compose the registry's primitives; a new
  chart type is a registry PR with the usual justification. Empty and first-run
  states earn a glyph, never a paragraph. Reviews ask one question of every new
  surface: *what does the eye read before the words?* If the answer is "nothing",
  the surface is not finished.

## Anti-duplication mechanics (the part that actually prevents wheel-reinvention)

1. **The component registry is law.** `components/` carries an index
   (name → purpose → variants). Task contracts for UI work include a mandatory
   step: *check the registry before creating anything*; the verifier diffs new
   component names against it, and a near-duplicate (a second Badge, a third
   card variant) is a rejected completion, not a style note.
   (Proven pattern: one property's editorial kit — five agents in one day reused
   `Callout`/`StatHighlight`/`Dialog` without inventing rivals, because the
   kit existed and the contracts pointed at it.)
2. **The kitchen-sink route** (`/dev/kitchen-sink`, dev-only): every component
   in every state on one page. It is (a) the agent's visual reference,
   (b) the screenshot surface for visual verification, (c) the review page
   when a token changes. No Storybook — overhead without payoff for a
   single-operator tool.
3. **shadcn MCP + skills wired into the builder's toolchain** (catalog entry
   in [doc 11](11-integrations.md)): agents install/compose from the registry
   by name instead of hand-rolling near-copies of standard components.
4. **New-component budget:** genuinely new components require a one-line
   justification in the PR ("registry has nothing that…"), which keeps the
   registry the path of least resistance.

## Accessibility & modes

Radix primitives carry keyboard/aria; don't undo them. Toasts mount only
through `AppToaster` (`apps/tower/src/lib/toaster.tsx`), never a bare Sonner
`Toaster`: a toast is one Tab stop that keyboard focus passes through, and
leaving it never sends focus back to the control before it (bead
`ro-ujb9.87`), and it is drawn in the theme the page is (light on the light
desk, dark on the dark desk and the Wall; bead `ro-ujb9.117`). Phone mode
([doc 10](10-control-tower.md)) is the same components at a responsive
breakpoint — no parallel mobile component set, ever. The Wall route renders
no interactive chrome beyond one quiet header link back to Home
*(amended 2026-07-31: a route with no exit is a dead end, not a discipline)*;
everything else on it stays read-only by construction. Event markers may open
read-only hover, focus and tap explanations; inspecting an event is not an
editing control. These disclosures preserve the TV layout and need not be
opened for the Wall's ordinary glanceable reading.
