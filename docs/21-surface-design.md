# 21 — Surface design: how a desk page is composed

*Decided 2026-09-05 (D24). The operator's brief: "avoid overwhelming the user,
while providing the most impactful overviews in the most visually stunning way."
This document is the contract every desk surface is built against, from the
smallest component to the page. [Doc 14](14-ui-standards.md) owns the tokens
and the registry rule; [doc 17](17-ui-lexicon.md) owns the words; this owns the
composition. Where they disagree, this one is the newer decision.*

The original reference mockup, `briefs/2026-09-05-surface-redesign-mockup.html`,
is private historical evidence, excluded from the public source. It illustrated
the asset Overview, Growth tab and Home with one site's real 90-day series.
This document is the rule; the mockup was an illustration. The current
[component registry](../apps/tower/src/components/REGISTRY.md) identifies the
shipped components.

## Why

On 2026-09-05 the asset page's Growth tab measured **10,139px** tall at 1440
wide, the Overview passed **2,600px** before its first chart, and the first
screen was a grid of same-weight rectangles each carrying its own heading, its
own explanatory paragraph and its own config-file chip. The 90-day GSC, Bing and
GA4 charts that once said at a glance how an asset was doing had sunk below a
wall of tables. Every card was individually honest and the page as a whole was
unreadable: everything, all at once, in the same size.

The operator's diagnosis, verbatim: "a bunch of scattered, misaligned
rectangular cards with unrelated numbers, tons of small-text prose that the user
is exposed to by default every single time they visit, with no visual hierarchy
or taste." The bar named: PostHog and Ahrefs — information clarity, density,
visual language, graphical components, interactivity.

## Principles

1. **One question per screen.** A surface answers one question and its first
   screen is the whole answer. Asset Overview: *how is it doing, what needs me,
   what matters.* Home: *what needs me, how is the portfolio doing.* Anything
   that answers a different question is a tab or a link, not a section below.
2. **Charts lead; numbers ride them.** A KPI is one unit — value, delta against
   the prior period, sparkline — fused to the chart it selects. A number
   without its series is noise; a chart without its number is decoration.
3. **Progressive disclosure.** Three rows by default, expand in place for
   evidence, "All →" in the header for the rest. Names, units, essential periods
   and compact stale/unknown/incomparable states stay visible. Exact timestamps
   and detailed coverage are available on demand. The Wall is excluded: its
   composition, conventions and budget are [doc 25](25-the-wall.md) (D28).

   **3a. No interaction needs a paragraph** *(amended 2026-09-23, operator; beads
   `ro-ujb9.94`, `ro-ujb9.96.2`)*. If a step needs footnotes or a paragraph of
   explanation to be used, the step is wrong: show the state visually, infer or
   default the answer, or remove the step that needs it. `About` and
   `InfoTooltip` hold label-length supporting facts, never instructions or
   methodology; their content counts. This replaces the 2026-09-05 allowance for
   long methodology in one `About`. It is enforced, not reviewed:
   `scripts/ux-gate.mjs` fails any visible Tower string over 12 words (18 for a
   failure message, 24 for an accessible name) at edit time, at commit
   (`.githooks/pre-commit`) and in CI (`pnpm test:scripts`). The legacy
   offenders recorded in `apps/tower/ux-budget.json` are debt being removed to
   zero, not an allowance. An agent stopped by the gate who is unsure how to
   redesign researches how best-in-class modern products handle the same
   interaction and records product, source URL and adopted pattern in
   `docs/briefs/<flow>.md#prior-art` before building. Exceptions exist only for
   trust-safety, legal and destructive-confirmation facts; each needs an
   operator-approved bead and that prior-art section.

   **3b. A flow only gets shorter** *(amended 2026-09-23, operator; bead
   `ro-ujb9.95`, from the UX flow audit's rules, `ro-ujb9.93`)*. New capability
   is a control on the current step, never a new step.
   - **Zero words needed to act.** A flow finishes without reading a sentence:
     labels, states and values only.
   - **No empty steps.** Every screen change carries an input or a decision.
   - **Check once.** No verification or confirmation repeats within a flow.
   - **One status per subject per screen**, shown where the operator acts on it,
     never ahead of its proof.
   - **Group lists by subject.** A list that repeats one subject becomes a
     group headed by it; only timelines and logs, whose order is the meaning,
     are exempt (`data-order="chronological"`).
   - **Steps only go down.** A flow's actions, screens, page changes and words
     never grow; a new flow cites at least three researched comparables.

   Enforced, not reviewed: `apps/tower/e2e/flow-gate.mjs` walks every flow
   declared in `apps/tower/e2e/ux-flows.mjs` at desktop and phone in
   `pnpm test:journeys` (CI's fifth gate) and fails against
   `apps/tower/ux-flows.json`. The rule counts recorded there are legacy debt
   epic `ro-ujb9.96.7` removes to zero, not an allowance; a new flow enters
   with none. Exceptions follow 3a's terms.
4. **Hierarchy from scale, not boxes.** One card style. A card groups related
   things; it never holds one fact. Section titles are eyebrows (11px, tracked,
   uppercase, muted); the numbers are the large type. Owner chips, config-file
   paths and register names belong on Settings and Sources — never on a view
   surface.
5. **Colour is meaning.** Severity (error/warn/ok) and provider (Google/Bing)
   only. Everything else is neutral ink so red means red. No decorative accent.
6. **Rhythm.** 8px grid. One type scale: KPI 28/1.1, small-multiple value 20,
   heading eyebrow 11 tracked 0.08em, body 13, caption 12, micro 11. Tabular
   digits wherever numbers align. Card padding 16, gaps 14.
7. **Interactive where it pays.** Explicitly scoped range selector, provider toggles,
   hover readouts, click-to-select metric, rows that expand in place. Nothing
   decorative moves; `prefers-reduced-motion` is honoured.
8. **Honest by construction, quiet by default.** Provisional days are hollow
   points; timezone changes and deploys are marks on the axis; a missing figure
   is a dash with a discoverable reason, never a fabricated zero. Each event
   marker explains its own event on hover, focus or tap; a paragraph elsewhere
   is not a substitute for that connection.

## Component vocabulary

These are the components a desk surface is composed from. Each is one registry
entry (doc 14) with a kitchen-sink demo. Existing components are retired or
folded as noted; two components that draw the same shape is the failure this
list exists to prevent.

This boundary is desk-specific. The Wall's `Spark`, `DailyBars` and `Stat`
remain supported specialized components, not deferred replacements (D28 moves
the Wall's `DailyBars` to the site page; [doc 25](25-the-wall.md) lists what
the Wall keeps). Share
truthful data and event interactions where useful; preserve TV geometry,
comparison marks and glanceability (`ro-ujb9.26`, `ro-ujb9.41`).

| Component | Contract | Replaces |
|---|---|---|
| `RangeSelector` | `7d · 28d · 90d`; default **28d** (operator-decided). Drives the explicitly labeled traffic group. Accounting months, reported 24-hour counts and current-status snapshots state their independent periods. | ambiguous page-wide time scope |
| `KpiStrip` / `Kpi` | `label`, `value` (formatted), `delta` (vs the prior period of the same length; up/down/flat tone), `spark` (7-day average of the range), `selected`, `onSelect`. Rendered as one strip with hairline dividers; the selected KPI carries a 2px underline. | `Stat`, the four Home tiles, the asset "state" tiles |
| `HeroChart` | One time series surface: `series[]` (name, colour token, values), `range`, `avg7` overlay in bold with the raw line faint, weekend bands, `annotations[]` (date, glyph, label) as dashed marks, provisional last point hollow, hover readout with date and every visible series, provider toggles when there is more than one series, monthly and step variants. Height 240 on Overview, 180 in pairs. | Separate provider and signed-month charts, plus daily and intraday charts on the desk; specialized Wall charts remain supported |
| `Sparkline` | Actual dated observations, with missing-date breaks, optional explicitly named averaging, endpoint dot and optional area. The readout identifies the quantity drawn, distinguishing raw and averaged values. 64×22 inside a `Kpi`, 96×24 in a table cell, full-width 30 in a `SmallMultiple`. Never assume 28 points or silently replace a daily count with an average. | desk uses of `Spark`; not its TV presentation |
| `SmallMultiple` | `label`, `value`, optional `valueCaption`, `secondary`, and `spark` with a clear quantity and inspectable dates. A product count's comparison names the actual preceding report count; exact comparison dates and methodology can live in the section tooltip. Never put an unexplained "avg" beside the headline. | the product-use metric cards |
| `ListPanel` / `Row` | Header: eyebrow title, quiet count, "All →". Rows: severity glyph (ring + mark), title, caption, right-aligned value with a micro label; a row expands in place to show evidence and its actions; three rows by default. | `AttentionBand` on the asset page, `ExecutiveFindingsList`'s default rendering, the operator inbox card |
| `StatusBanner` | One line with a ring or dot, a bold lead, a sentence, a link. Appears only while its state is open and disappears when it closes. | the Setup checklist section (its full checklist moves to Sources) |
| `About` | The one disclosure per screen that holds the prose: what the numbers are, where they come from, what provisional means. Closed by default. | every `SectionCard` subtitle paragraph, "How these findings are produced" |
| `Table` | Unchanged (doc 14), plus a `Sparkline` cell type and the eyebrow header style. | — |

Retired from view surfaces: `OwnerChip` and config-path badges (they stay on
Settings, Sources and the kitchen sink), `SectionCard`'s multi-sentence subtitle,
per-card "Copy Markdown" affordances (they move into the expanded row's actions).

### As built (2026-09-05, bead `ro-78qo.1`)

The components live at `apps/tower/src/components/surface/<Name>.tsx` and their
arithmetic at `apps/tower/shared/surface.ts`. The prop names above are the ones
that shipped, with four deviations recorded here because page agents build
against this table:

- `HeroSeries` is `{ name, points, tone }` — `points` rather than *values*
  because every other series in this app is `SeriesPoint[]` under that name, and
  `tone` rather than a colour token because a component may not take a colour: it
  takes one of seven sanctioned meanings (`primary` / `bing` / `positive` /
  `negative` / `warn` / `error` / `neutral`) and resolves the token itself, which
  is what keeps doc 14's "a colour literal in a component is a review-blocking
  smell" true at the call site as well.
- The seven-day overlay is `average` (a boolean) plus `averageWindow` (its
  length), not `avg7`: the same chart draws a 28-day average on a 90-day range,
  and a prop named for one number cannot say so.
- `Kpi.delta` takes the whole `PeriodDelta` from `shared/surface`, not a
  formatted string — it carries `comparable` beside `tone`, and the KPI colours
  the movement only while the comparison stands (doc 14, bead `ro-jkp2`).
- The delta's direction glyph is `DeltaChip`'s arrow, not `▲` / `▼`. The rule's
  purpose — direction carried by a glyph so colour is never the only encoding —
  is met either way, and the registry already owns a delta: a second one drawn
  with text triangles would be exactly the near-duplicate this document exists
  to end, and it would have to be kept in step with the Wall's. `Kpi` therefore
  passes tone and meaning INTO `DeltaChip` rather than drawing its own.
- The row export is `ListRow`, not the table's bare `Row`: a component named
  `Row` in a repo with a `TableRow` and an `AlertRow` is a name that has to be
  qualified at every import. `ListPanel` holds the three-row default as `limit` and discloses the rest
  behind its own expander, rather than the page slicing before it renders. A
  panel that silently keeps four of seven is lying about the size of the queue.
- `HeroChart`'s y domain is **signed when the data is** (2026-09-05, bead
  `ro-78qo.28`): a drawn series with a negative point puts the scale's bottom
  below zero, draws the zero line inside the plot and fills the area toward it.
  It is behaviour rather than a prop, so no caller opts in — which means
  /financials' hero can be **net by month** itself, with revenue and cost as its
  toggles, rather than the two lines whose gap the net is.

The rules "Details the mockup settles" states are held by the components rather
than by each page: `Kpi` takes `improvement` (`"up"` / `"down"` / `"none"`) and
colours the delta only when the movement is good for THAT metric, muting it under
±2%, when the comparison is not like-for-like, or when direction has no meaning;
its sparkline takes the same tone and draws nothing at all under three points;
`periodDelta` takes `provisionalFrom` and anchors both windows on the last
COMPLETE day, so the delta excludes the day the provider is still counting;
`HeroChart` drops to 180px below `sm` through a custom property, since an inline
height beats every breakpoint there is.

Four `data-*` marks exist for the audit that measures the acceptance list below:
`data-kpi-strip` on the strip, `data-kpi` on each KPI and `data-spark` on its
series, `data-hero-chart` on the chart, `data-about` on the disclosure, and
`data-owner-chip` on every owner chip so "no owner chip on a view surface" is
measurable rather than asserted.

## Page templates

### Asset · Overview

```
Assets ›
[favicon] Example  example.com  (● Onboarding · 4 of 6 sources live)         Reported 14h ago  [7d|28d|90d]
Overview · Growth · Search · Alerts · Tasks 204 · Activity · Sources ● · Settings
[StatusBanner: Setting up · 3 of 4 done · Finish in Sources →]           (only while onboarding)
┌ KpiStrip: Active users · Sessions · Search clicks · Impressions · Net · Open alerts ┐
│ HeroChart for the selected KPI (range-wide, 7-day average, annotations)              │
└ footnote: bold = 7-day average · ▲ marks · latest day provisional ─────────────────┘
┌ ListPanel  Needs you (3 rows) ┐ ┌ ListPanel  What matters (3 rows, first expanded) ┐
PRODUCT USE · LATEST REPORTED 24 HOURS                                      Growth →
Report received [date/time and age]
┌ SmallMultiple ×5: 24h count · prior report average · raw dated history ┐
▸ About these numbers
```

**The lead is what the site has** *(2026-09-23, bead `ro-ujb9.146`)*. The strip
and hero above are the traffic lead. A site with no Analytics, Search Console or
Bing series leads instead with its daily ad revenue (the Financials tab's
`DailyRevenuePanel`), else PostHog's people, page views and sessions in the same
strip, else DataForSEO's latest rankings (four KPIs, each declaring its missing
series); only a site with none of these shows the four traffic dashes. One
composition, `SiteLead`, draws it here and on Home with one site.

Budget: at 1440×900 the first screen shows the header, the strip and the whole
hero chart. The Overview is one tab of one question; nothing else is on it.
Height ≤ 1,600px at 1440 with every list at its default three rows.

### Asset · Growth

Audience (Active users | Sessions) and Search (Clicks | Impressions) as
`HeroChart` pairs at 180px, the tracked-panel scoreboard as one `SmallMultiple`
strip (ranking / top 10 / top 3 / AI Overview shown / cites us / best move),
product use as a second strip. No tables. Height ≤ 1,400px.

### Asset · Search *(new tab)*

The tracked SERP panel board (`SerpPanelBoard`, collapsed to the scoreboard plus
the top movers by default, "Show all 28 →"), query decisions and page decisions
as `ListPanel`s collapsed to movers, competitors and backlinks as small strips.
Every table opens collapsed. The 10,000px scroll becomes disclosure.

**Before any tracked term** *(2026-09-23, bead `ro-ujb9.136`)*: with no panel,
no decisions and no search context the tab never opens blank. With search
numbers it leads with Growth's search pair (the same rendering) and a "Tracked
terms · none yet" row whose one button connects DataForSEO or opens Settings'
tracked panel; with none it is one empty state whose button connects the site's
first search source.

### Asset · Alerts, Tasks, Activity, Sources, Settings

Roles unchanged; restyled to the vocabulary: eyebrow headings, one card style,
prose behind `About`, owner chips only on Sources and Settings.

### Home

```
Home                                                             6 sites · updated 25m ago
┌ KpiStrip (not selectable): Net this month +spark · Needs you +bar · Open alerts +bar · System ┐
┌ ListPanel  Waiting on you (5) ┐ ┌ ListPanel  Alerts (5) ┐
┌ Table  Sites: name · state · users today +delta · 28-day sparkline · 7-day · net · tasks · reported ┐
```

The four separate tiles become one strip so the eye reads left to right once.

**One site** *(2026-09-23, bead `ro-ujb9.127`)*. With exactly one site the
portfolio is that site, so a comparison table of one row answers nothing. Home
leads with the site's own lead — the Overview's KPI strip fused to its hero
chart, from the Overview's own read, over 28 days — with the site's state marks
and its name as the way to its page at the end of the lead's header row. The
strip above and Waiting on you and Alerts follow; the census says only how old
the reading is. The Sites table returns from two sites.

```
Home                                                              updated 25m ago
┌ Traffic · last 28 days                         ● ⊕⊕⊕  Journey Example → ┐
│ KpiStrip (selectable) · HeroChart                                       │
┌ Net ┐ ┌ Needs you · Open alerts · System ┐
┌ ListPanel  Waiting on you ┐ ┌ ListPanel  Alerts ┐
```

### Index pages (Assets, Alerts, Tasks, Financials, Health, Integrations)

One eyebrow header with the filter row, one `Table` or one `ListPanel`, prose
behind `About`. Financials and Health gain a `HeroChart` at the top where they
already have a series (net by month; freshness by lane).

Settled per page on 2026-09-05 (design review of the live pages; baselines on
`ro-78qo.7`, `ro-78qo.12`, `ro-78qo.16`) — each page answers one question:

| Page | The question | First screen |
|---|---|---|
| Assets (Sites; from two sites — with none it is the header's Add a site and one empty state, with one it is that site's row, bead `ro-ujb9.128`) | How is each asset doing, and which one needs me? | A six-across `KpiStrip` (assets by state, users today, 28-day users, portfolio net, open alerts, open tasks) over **one comparison `Table`** — Home's assets table widened with `Sparkline` columns for Users (28d), Search clicks (28d) and Net (by month); header sorts; a row opens the asset. The per-asset cards (active bet, live counters, product totals) leave this page — the asset Overview holds them. |
| Alerts | What is firing, and how bad? | A `KpiStrip` (open, errors, warnings, fired this week, median age, resolved this week) over the Open/History tabs and filter row; one line per alert; the four actions live in the row's expansion, never printed under every row. |
| Tasks | What needs me, and what is the queue doing? | A `KpiStrip` (waiting on you, urgent, open, in progress, blocked, closed this week), a Waiting-on-you `ListPanel` at five rows with Respond/Dismiss as row actions, then the board as one `Table` paged 25 rows at a time, rows expanding in place. |
| Financials | Am I making money, and where? | A `KpiStrip` (net with its revenue · cost composition, revenue, cost, reconciled fraction, forecast) **fused to a monthly `HeroChart`** with revenue/cost toggles; the month picker is the header's range; the by-asset `Table` carries a net `Sparkline` per asset (from two sites, or with one site only while an overhead cost exists — then without the direct subtotal that would repeat its row, bead `ro-ujb9.129`); the month table sits behind a collapsed panel. Not-reconciled is the provisional treatment, not a hatch. |
| Health | What is broken or not set up? | A `KpiStrip` (sources working / degraded / not set up, credentials expiring, freshness) with the step-variant freshness `HeroChart`; "Unblock next" as a `ListPanel` at five rows (glyph by kind, affected assets as caption, the hint in the expanded row); the layered audit behind collapsed panels; no owner chips. |
| Integrations | Which providers are connected, and which need me? | A `StatusBanner` per thing needing the operator; providers as `ListRow`s (state dot, credential age, expiry, used-by count, last used) expanding to the card's fields; the OAuth setup steps appear only inside an expanded, unconnected provider; owner chips stay (a setup surface). |

## Acceptance for any surface built to this doc

- The first screen at 1440×900 answers the surface's one question without
  scrolling; a capture is attached to the bead.
- `pnpm ux:gate` passes, and a change that removes prose lowers
  `apps/tower/ux-budget.json` (`pnpm ux:baseline`) in the same commit. Essential
  units, periods and compact evidence warnings remain visible. Any `InfoTooltip`
  or `About` holds label-length facts only; test closed and opened states,
  opaque backgrounds in both themes, keyboard/tap access and viewport fit—not
  just HTML tag counts.
- No owner chip or config path on a view surface.
- Every number that can have a series shows one (`Kpi`, `Sparkline` or chart).
  A number whose shape is how a total divides rather than how it moves — the
  urgency split under "Needs you", the error/warning split under "Open
  alerts" — shows its `SegmentBar` instead and declares it
  (`data-composition`), so the audit counts a bar as the answer, not a gap
  (decided 2026-09-05 on `ro-78qo.6`). A number whose series does not exist yet
  declares it (`data-series="unavailable"`, the reason in
  `data-series-reason` — `Kpi`'s `seriesUnavailable`) and draws nothing in its
  place; the audit lists it, and the bead that will supply the series is named
  on the surface's bead.
- Range changes re-derive the metrics belonging to that control. Independent
  report, status and accounting periods stay unchanged and visibly labeled.
- **The phone's first screen is the page's answer** *(2026-09-24, bead
  `ro-ujb9.13`, [brief](briefs/2026-09-24-mobile-first-screen.md) with its
  prior art)*. At 390×844: the first answer row — a site, an alert, a task; on
  Home what needs you — starts in the top half of the screen, with nothing
  above it but the header's one primary action, one Filters press
  (`FilterBar`, carrying how many filters are on), a period and a tab bar. The
  strip is one row (`KpiStrip`: three share the width while their words fit;
  enlarged text can widen cells into horizontal scrolling). Sites and Tasks
  put their answer rows before aggregate summaries on phones. The selected
  KPI stays in view and the hero chart stays full-width. A row that looks
  interactive is interactive and one that is not looks static: › opens a page,
  ⌄ expands in place, no mark means no action and no hover (`ListRow`,
  `TableRow opens`). A stacked row is its key status; what it folds is on the
  page its › opens. The isolated `apps/tower/e2e/mobile-text-zoom.spec.ts` measures empty, loading,
  error and populated states in both themes at normal and doubled text size;
  it asserts rendered font growth, answer position, unclipped text and overflow.
- On a phone the 44px floor holds for **every control a thumb can hit** —
  buttons, links that act, inputs, selects, disclosure summaries, row
  affordances — not only the four classes bead `ro-md80` named (decided
  2026-09-05 on `ro-78qo.11`; inline links inside running text are the one
  exemption).
- `pnpm surface:audit` (bead `ro-78qo.9`) passes for the surface's routes: hero
  on the first screen, no unnecessary explanatory prose, zero owner chips, zero
  KPIs without a series, zero controls under 44px at 390. The baseline it is
  measured against is on that bead.
- `pnpm wall:fit` unaffected — the Wall is out of scope for this document; its
  contract is [doc 25](25-the-wall.md).
- Four gates green; REGISTRY.md rows and kitchen-sink demos for every component
  added or changed.

## Outcome (2026-09-05, epic `ro-78qo`)

Every desk surface was rebuilt against this document in one day, each one
reviewed by the design lead against the mockup before its bead closed. Page
heights at 1440 wide, browser-measured by `pnpm surface:audit` (baseline →
final); every route now passes the acceptance list with zero offenders.

| Surface | Baseline | Final | What changed |
|---|---|---|---|
| Asset · Overview | 3,517 | 1,174 | six KPIs fused to one hero chart, two lists at three rows, product multiples, About |
| Asset · Growth | 10,139 | 1,317 | two chart pairs, panel scoreboard, Also-collected strip |
| Asset · Search | — | 1,591 | new tab: panel, query and page decisions at three rows, context strip, the rest behind one disclosure |
| Asset · Sources | 9,334 | 1,580 | lane rows expanding to the card; setup checklist lives here |
| Asset · Activity | 3,947 | 1,077 | timeline, watches and months as rows and a strip |
| Asset · Settings | 4,028 | 2,488 | every field kept; the 29 tracked terms behind one disclosure |
| Home | 1,170 | 957 | one strip (a spark and three composition bars), two lists, one table with sparklines |
| Tasks | 32,495 | 1,715 | strip with 7-day history, Waiting-on-you at five rows, the board paged 25 rows |
| Assets | 1,673 | 900 | one comparison table with three sparkline columns and a 7/28/90 range |
| Alerts | 900 | 900 | strip over the list; the four actions moved into the row; 8 → 0 controls under 44px |
| Financials | 4,410 | 1,330 | four KPIs fused to a revenue/cost/net hero on a signed axis; by-asset sparklines |
| Health | 2,389 | 921 | coverage strip, last-reported multiples, Unblock next at five rows |
| Integrations | 2,929 | 900 | one provider list expanding to the card |

Rules the build added to the acceptance list: a KPI may declare a
**composition** (`data-composition`) or a **not-yet-existing series**
(`data-series="unavailable"` with the reason) instead of a sparkline; a
composition is an answer, a declaration is listed by the audit without failing
the route. Daily rollups (migrations 0032 and 0033) now give the Tasks,
Health and Alerts strips the history their numbers ride.

## Sequence (operator-decided)

1. Components and the asset page split into per-tab files.
2. Asset Overview, then Growth + Search, then the remaining asset tabs.
3. Home.
4. Index pages.

## Details the mockup settles

These are the calls an implementer would otherwise make differently on every
page. They are the rule; the mockup shows them.

**Type and spacing (Tailwind classes, doc 14 tokens).** KPI value `text-[28px]
leading-[1.1] font-semibold tracking-[-0.02em] tabular-nums`; small-multiple
value `text-xl font-semibold`; eyebrow `text-[11px] uppercase tracking-[0.08em]
text-muted-foreground font-semibold`; body `text-[13px]`; caption `text-xs
text-muted-foreground`; micro label under a row value `text-[10.5px] uppercase
tracking-[0.04em] text-muted-foreground`. Card `rounded-[10px] border
border-border bg-card`, padding `p-4`, grid gaps `gap-3.5`. One card radius,
one border, no shadows. Hairline dividers inside a strip use `border-border/60`.

**Deltas.** Compare the last N days to the N days before (N = range). Show a
percentage with the sign glyph (▲ ▼) and the tone: `text-trend-positive` when
the change is good for the metric, `text-trend-negative` when bad, muted when
under ±2% or when direction has no meaning (Net shows its composition instead:
"ads $441 · costs $5"). Up is good for users, sessions, clicks, impressions,
product counts; down is good for open alerts and errors. A KPI's sparkline takes
the same tone; a sparkline on a neutral metric is `text-muted-foreground`.

**Provider colours.** Google is `--foreground` — foreground ink, the neutral
line — and Bing is `--search-bing`, always beside the word "Bing" (doc 14). There
is no `--google` token and there must not be one: Google's line is not a colour,
it is the absence of one, and a token would make the default provider look like a
choice. Never a third provider colour without a token PR. Components take a
`tone` name (`primary` / `bing` / `positive` / `negative` / `warn` / `error` /
`neutral` / `muted`) and resolve the class themselves, so no call site holds a
colour.

**Missing and provisional.** A metric with fewer than three points shows a dash
in the value and no sparkline, and the About names why. The latest day of any
daily series is provisional until the provider closes it: hollow endpoint,
"provisional" in the hover readout, and the delta excludes it. Never a zero for
a day nobody reported.

**Row glyphs.** A ring 18px with a 1.5px border in the tone colour and a mark:
`!` urgent/open task, `△` warning or error finding, `↗` recommendation,
`◦` info/discovery, `✓` resolved. Tone by severity: error, warn, ok, muted. A
task's priority is not a severity: its mark ranks by ink weight, never by
these tones (doc 14).

**Tab bar.** Text tabs with a 2px underline on the active one; a count (`204`)
in muted digits after a tab that lists things; a warn pip after a tab that
holds something needing attention (Sources with an unset source). No icons.

**About.** One per screen, closed by default, `details` with a text summary
"About these numbers" (or "About this page"). It holds: what each number is,
where it comes from, what provisional means, and any caveat the old subtitles
carried. Sixty-eight characters wide at most. Essential metric units, time
periods and compact evidence states stay visible; exact dates and supporting
coverage/method explanations can use the section's `InfoTooltip`. A concise chart key identifies
event marks; event-specific detail belongs to the actual marker's hover,
keyboard-focus and tap disclosure, not a detached list below the chart.

**Empty states.** A ListPanel with nothing to show renders one calm line in the
row area ("Nothing needs you on this asset") and keeps its header. A strip with
no metered data renders the label and a dash. No illustration, no card-sized
message.

**Phone (below `sm`).** KPI strip one row with hairlines — up to three side by
side while words fit, with horizontal scrolling when enlarged text needs wider
cells; four or more always swipe (beads `ro-ujb9.13`, `ro-ujb9.239`); HeroChart full width at
180px; ListPanels stacked; SmallMultiples in two columns; filters and sort
behind one Filters press, the range selector in view beside it. The 44px floor
from `ro-md80` applies to every control.

## Definition of done and the review

A child of `ro-78qo` is done when: its four gates are green; `pnpm
surface:audit` passes for its routes (once `ro-78qo.9` lands) or, before that,
the agent's captures show the first screen and page height inside the budget;
and the **orchestrator has reviewed the 1440 and 390 captures against the
mockup and this document** and either merged or sent the work back with the
specific gap named. A page that passes its gates and fails the look is not done.
