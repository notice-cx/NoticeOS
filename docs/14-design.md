# Design

*How the Tower and the TV Wall look and behave, and why. These are design
choices with their reasons, written so a builder can reuse existing patterns
instead of inventing new ones. Where a rule is enforced, the code that
enforces it is named; the code is authoritative, and this document describes
it.*

## The stack

What the Tower is built from, as it stands in `apps/tower/package.json`:

- **Vite + React + TypeScript**, one single-page app with React Router. The
  app's Worker and the ingest Worker run in one workerd runtime behind one
  Vite server (`scripts/README.md`); the Docker Compose application container
  and the demo profile ship the same runtime, pinned. The Cloudflare plugin
  supplies the Worker runtime; it is not the host.
- **Tailwind v4, CSS-first.** No `tailwind.config.js`: `@import "tailwindcss"`
  and an `@theme inline` block in `src/index.css` are the whole configuration.
- **shadcn-style components kept in this repo** in `components/ui/` (button,
  badge, card, command, popover, sheet, table) on Radix primitives where the
  behaviour is hard (popover, slot) and **cmdk** for the command palette.
- **Charts are inline SVG**, on the Tower's pages and the Wall alike, drawn
  from three marks in `components/surface/ChartMarks.tsx`. There is no
  charting library and no table library: `Table` in `components/ui/table.tsx`
  is written here, and it reflows into labelled cards on a phone.
- **TanStack Query** with polling for every read. **lucide-react** for icons.
  **Sonner** for toasts, mounted only through `AppToaster`
  (`lib/toaster.tsx`). Motion is CSS: keyframes and transitions under
  `motion-safe:` / `motion-reduce:`, no animation library.

Dark is the default theme, because the Wall is dark; `.light` is the variant
for the Tower's pages. A dark subtree inside a light page
(`[data-theme="dark"]`, the TV preview in the layout editor) re-resolves the
same variables, so the editor shows the TV layout in the same colours the TV
uses.

## Tokens

Colour, type and spacing are defined once, in CSS, and components use them by
name. The brand identity is defined in `apps/tower/public/brand/notice.css`
(canvas, surface, raised, ink, muted, line, the accent, success, danger,
warning, cyan, violet, the two fonts, radii and two motion durations), shared
with the standalone reference page `public/design-system.html` and described
in [brand](brand.md). `apps/tower/src/index.css` maps that identity to the
application's aliases, redefines them for `.light`, and exposes everything
through `@theme inline` as `--color-*`, `--text-*` and `--spacing-*`
utilities. In review, look for hex or pixel literals in components: each one
defines a value a second time, and that copy goes out of date when the token
changes. The one exception, noted in the CSS, is a size used by a single mark,
declared as a token for that mark.

The families, and what each means:

- **Attention: `error` / `warn` / `info`.** The severity of a flag, and
  nothing else uses these colours. `info` is a slate grey rather than a blue,
  so it is never confused with the accent. `urgent` is one measured colour
  step between `warn` and `error`, so the countdown's colour can escalate as a
  deadline nears without a separate colour scale; it is not a fourth severity
  and no flag maps to it.
- **`milestone` emerald**, reserved for milestone-*kind* items. The green
  marks a win; it does not mean healthy.
- **Recorded workflow execution: `healthy` / `error` / neutral.** Green is a
  recorded success, red a recorded failure, grey is paused, skipped, never run
  or unknown. A green run means the job finished; it shows nothing about the
  business outcome.
- **Integration connectivity: `connected` / `error` / neutral.** Whether
  NoticeOS can read a source end to end. A provider's logo beside it
  identifies the provider and never shows status.
- **Business identities: money and people.** `financial-revenue` cyan is
  money; `traffic` azure is people, visitors, search clicks. `financial-cost`
  violet is the cost series. These colours mark *what a line measures*, never
  whether it is good or bad: a falling traffic line is still azure. The hues
  were chosen by measurement so money, people, the accent and the severities
  stay distinguishable on the TV's black background and the light background
  of the Tower's pages (`test/brand-identity.test.ts`).
- **Provider colour: `search-bing`.** One provider identity token, always
  beside the word "Bing", never alone, never on the Wall (it shares the blue
  family with `traffic`).
- **Trend and pace.** `trend-positive` / `trend-negative` are the diverging
  scale for a *completed* like-for-like comparison, at three intensities.
  `pace-on` / `pace-behind` / `pace-far-behind` are aliases of those and
  `warn`, scoped to today's hours against the same hours last week: "a little
  behind" uses the warn colour as one step of a comparison rather than as a
  warning, and nothing else may reuse it that way. `paceTone` in
  `components/DeltaChip.tsx` is the one place the step is chosen.
- **Surface kinds: `surface-money` / `-alert` / `-win` / `-neutral`.** A
  card's *subject*, as a low-chroma tint on its top edge with one inner
  highlight line. A tint never shows severity: an alert card has the alert
  tint whether its alert is warn or error, and the severity is shown by the
  dot and the word. `glass` is for chrome only, never for a surface showing
  numbers.
- **Chart tokens.** `chart-week-band` for alternating calendar weeks,
  `chart-distorted` for a day a reporting-timezone change made incomparable
  (a caveat about the measurement, in a paler warn, never an alert), and
  `spark` for the neutral compact trend.
- **The visual kit's tokens.** `viz-track` is the empty track a bar or a band
  fills, `viz-grid` the thin line a grid or an axis is drawn with, and
  `shadow-raised` the one shadow a screen's main region may have. The Tower's
  type sizes above Tailwind's steps (`text-display`, `text-figure`,
  `text-figure-sm`, `text-micro`) are listed in `THEME_TEXT_SIZES`
  (`lib/utils.ts`) so a class merge never drops them.
- **The Wall's scale.** Every type size on the TV (`text-wall-*`) and every
  gap between its regions (`spacing-wall-*`) is a token, because the Wall is
  the one surface with a fixed height and its whitespace is limited. The
  brand accent colour is used for primary actions, selection and focus, and
  no state or series token refers to it.

## The acceptance checklist

A screen is done when someone would take a screenshot of it to show what
NoticeOS can do: the main information is a chart or graphic before it is a
sentence, the most important thing is the largest, every number shows what it
is compared with, time is on the screen, a broken part is highlighted where it
appears, and nothing is squeezed, clipped or broken mid-word. A screen made of
blocks of text is an unfinished design. Before a screen ships, check its
screenshot at desktop and phone width; the answer to each of these must be
yes:

1. Can a reader tell good from bad quickly, without reading a sentence?
2. Is the most consequential thing the largest and the first thing a reader
   sees?
3. Does every figure show its comparison (a change against a named baseline,
   a target, or its usual range) and its recent history?
4. Is time drawn: a series, a strip, a timeline with the current time marked?
   And does every line show its dates: a small line or strip without a full
   axis has its first and last date under it, so every small chart can be
   placed in time?
5. Are things of the same kind grouped into one combined view instead of one
   card each?
6. Is every problem drawn on the thing it is about?
7. Does every name, figure and sentence fit its box at every width?
8. Is colour used only for data and state, with one coloured element per
   region?

## Principles

**One subject per screen, shown as a chart or graphic first.** Each screen
covers one subject, and its first screenful shows all of it. Home shows how
the business is doing, what is broken and what needs the operator's
attention. A site's Overview shows how the site is doing, what needs
attention and what matters. Sites shows which sites need attention. Anything
on a different subject is a tab or a link, not a section further down. Charts
and graphics show the information; words give what a chart cannot: a name, a
cause, an action.

**Choose the form from the shape of the data.** Each kind of data has a form
that can be read quickly, and the kit has a component for it:

| The data is | Draw it as | In the kit |
|---|---|---|
| a quantity over time | its series with a comparison: the comparison series as a faint dashed line or the usual level as a dashed line, the newest value at its end | `HeroChart`, `Sparkline`, `BarStrip` |
| progress through a period | the period so far against its projected total and the last period's total | `PaceBar` |
| a reading against its normal | the usual range as a band, the reading as a marker, the result as a word | `NormalBand` |
| parts of a whole | one split bar whose legend is the figures | `SegmentBar` |
| units compared on one measure | rows divided by thin lines, with an inline line or bar and the value at the end | `PortfolioRows` |
| many units × many states | a grid, one cell per pair, the state as fill, the age in the failing cell | `HealthGrid` |
| events in time | rows on a time axis with the current time marked, problems as spans from onset to now | `EventTimeline` |
| how things connect or flow | nodes and edges, each node in its state with its live count, the broken one highlighted in place | `FlowGraph` |
| where things are | a map, when place is the data (visitors by country), never as decoration | — |
| a queue | its size, the spread of its items' ages, then the rows with age as a bar length | `DecisionQueue` |
| a quantity over time and who contributed it | columns split by contributor in neutral colours, each contributor named beside the newest complete column, the current column outlined | `StackedWeeks` |
| a contest over a window | each contestant's running total over the window up to now, the leader in milestone green, each place named at the end of its line | `RaceChart` |
| open problems | one ranked panel: new since the operator last looked first, the long-standing ones collapsed | `IncidentList` |
| several measures, each against its own earlier window | rows divided by thin lines: the figure, its days against the earlier level, the change as a bar from one shared zero line | `ChangeRows` |
| a count narrowing step by step | bars on one scale, each with its share of the step before; a step with no measurement hatched | `FunnelBars` |

**Tabs are the only way a page in the Tower is divided into sections.** When
a page covers more than one subject, `Tabs` divides it: the same bar on a
site's page, Alerts, System health, Workflows and Settings. Each tab has its
own URL (the first tab the bare address, each other one a segment after it),
the arrow keys and Home/End move between tabs, and on a phone the tab strip
scrolls within its own row. A page never adds its own navigation beside the
app's sidebar, and an address from before a page had tabs still opens the tab
that holds its section. Inside a tab, the groups are panels, each starting
with a small uppercase section label.

Redesign a region around what it shows, not one component at a time: five
alert cards may become one grid and one ranked list, six site cards one
comparison panel. When no form in the kit fits a new kind of data, build the
form and add it to the table above.

**Every number has a comparison.** A figure is one unit of five parts: a label
naming the measure and its window ("Revenue, yesterday"), the figure, its
comparison (a signed change against a named baseline, a target or the usual
range), its recent history, and one context line with the key values in bold.
`StatTile` is that unit at tile scale and `Kpi` in a strip. A number shown
without anything to judge it by is not useful; a chart without its number is
decoration. A figure with no history yet shows the reason instead of a flat
line. Empty and first-run states show an icon and the next action, never a
paragraph.

**Rank by consequence; size follows rank.** A screen has one main region, a
few modules and compact rows. Severity, freshness and money at stake set
order, size and colour: what broke since the operator last looked comes first
and has the strongest colour, a problem open for over a week is collapsed
under its own heading, and a healthy site is shown in neutral colours. Giving
equal weight to things of unequal importance is a bug.

**Group things of the same kind; show each on its subject.** Many alerts are
one board, many sites one comparison, many data sources one grid. One card
per item is a design failure, not a layout. A failing data source highlights
its cell in its site's row, a failed backup highlights its node in the system
graph, and an alert appears on the chart of the metric it is about, so the
operator never has to piece the picture together from boxes scattered across
the page.

**Annotate in place.** Put labels on the marks instead of in a legend: the
newest value at the line's end, a named reference point ("Busiest day · Jul 11
· $42"), shaded bands for an outage, a measurement window or a usual range, a
series' name at its line. A legend is for a chart with no room for labels on
its marks.

**Progressive disclosure.** Three rows by default, expand in place for
evidence, "All →" for the rest. Names, units, essential periods and the
compact stale / unknown / not-comparable marks stay visible; exact timestamps
and the method go on hover, focus or tap, in one shared tooltip instead of a
cluster of help icons. Material state, the thing that would change the
operator's next action, is never only inside a collapsed disclosure
(`apps/tower/shared/materiality.ts` maps every such condition to where it is
drawn).

**Show state; do not explain it.** The operator reads quickly, sometimes from
across a room. If a step needs a footnote to be used, change the step: show
the state visually, infer or default the value, or remove the step. Labels,
states and values should be enough to act on; completing a flow should never
require reading a sentence. `pnpm audit:copy` measures every visible string's
length and reports retired words, and `pnpm audit:flows` runs through every
flow at desktop and phone width and counts its actions, screens, repeated
checks and duplicated statuses. Both are reports for design review: a long
string or a longer flow is a reason to consider redesigning the flow, not a
threshold to dispute.

**A flow should be short, and a new step needs a clear reason.** New
capability is usually a control on the current step. Connect panels are the
example to follow: one press tests and saves the pasted key, the matched sites
appear in the same panel, and *Start collecting* is the last press. One status
per subject per screen, shown where the operator acts on it; a list that
repeats one subject is grouped under it. Prefer Undo to a confirmation for
anything that stays inside the Tower; use preview-then-commit for anything
that deploys, spends money or acts outside the Tower.

**Boxes by role, depth by rank.** A panel holds a group (a board, a grid, a
comparison), never one fact; a region that is already distinct is not wrapped
in another box. The main region may be raised (`shadow-raised`) with a faint
tint of its identity colour; everything else is flat, with thin outlines.
Panel sizes differ because importance differs: the main region spans more of
the grid than the modules beside it. Section titles are small muted labels
(`SectionLabel`) and the numbers use the large type. The top line of a
`StatTile` marks its role on the screen (context, a problem, a win, money,
people), so a row of tiles is read in order: context, then the problem, then
what to do.

**Colour shows meaning and is used sparingly.** Colour is used for severity,
the two business identities, a provider beside its name, and the
recorded-execution and connectivity greens. Each region has one coloured
element to look at; the rest of its marks are neutral ink, so red stands out
and always means a problem when it appears: in a bar strip the newest day has
its identity colour and the days before it are grey; in a grid only the
failing cell is red. Colour goes on data and state, not on controls: a row's
action is grey until the pointer is over the row or the row has focus, and
the brand blue marks the screen's one primary action, a selection or focus,
never data. Hatching (`viz-hatch`) means nothing was measured there and never
a low value.

**Type has a scale, and numbers use its largest sizes.** `text-display`
(44 px) is a screen's lead figure, `text-figure` (30 px) a tile's,
`text-figure-sm` (22 px) a row's or a strip's; body and caption are `text-sm`
and `text-xs`, and `text-micro` (11 px) is the smallest: nothing on the
Tower's pages is set smaller. The largest type on a screen is a number or the
screen's one-line summary, never a greeting. Units, "est." and qualifiers are
a step lighter than their figure. On the Wall every size and gap is a token
with no exceptions. Tabular digits wherever numbers align, built into the stat
components instead of applied by hand.

**Layout fits the content.** Regions sit on a grid with spans by importance.
Components size themselves by their own container (`@container`), not the
viewport, so a panel in half the page lays out for half the page. Nothing is
cut to an ellipsis. When space runs short, a column is hidden before a name
is, and a name too long for the remaining space wraps between its words, never
mid-word and never one word per line. A label that must stay on one line
(inside a timeline bar, over a grid column, on a chart) is shown whole or not
at all (`FitLabel`). A filler line ("that's everything") is a line inside its
region, never a grid cell of its own.

**Motion shows a change.** A figure counts to its new value, a line is drawn
from start to end when its screen first renders, a bar or span grows from its
baseline, a new row fades in and slides up, the dashes along a live edge in a
graph move in the direction of flow, a source being collected has a ring that
repeatedly expands and fades, a halo marks *now* and a slow pulsing ring marks
a series still being counted. A page replacing the last one fades in and rises
a few pixels; while a navigation waits for the next page's code, the page
being left stays on screen and a thin line in the muted ink creeps across the
top of the window (`NavigationProgress`): nothing for the first 150 ms, at
least 300 ms once drawn, then it fills and fades. Nothing repeats unless live
data or a load still in progress drives it, and all of it stops under
`prefers-reduced-motion` (the `viz-*` classes in `src/index.css`). No photography, 3D renders, glass over numbers, or texture
that shows no data.

**Interactive where it helps.** A scoped range selector, series keys that
toggle, hover readouts, click-to-select a metric, rows that expand in place, a
grid cell or a graph node that opens the page for what it represents.

**Accurate by construction.** A provisional day is a hollow point; a
projection is dashed and neutral; a day the measurement cannot compare is
bracketed on the axis and its good-or-bad colour removed; a shipped change or
a timezone move is a mark on the axis with an explanation on hover, focus and
tap. A missing figure is shown as a word ("never", "unknown", "no report
owed"), never a made-up zero and never a bare dash in a labelled slot; a
*measured* zero is a number and is drawn. A failed poll keeps the last good
values with their age and shows that it is reconnecting. A comparison the
data cannot support shows "not comparable" instead of keeping its percentage
without its colour. Smoothing passes through every reading and never above or
below the readings either side, so a curve shows nothing that is not in the
data.

## Surfaces, as built

**`PageAnswer`** is at the top of every index page and site tab: one summary
sentence at the display size, a muted detail line and at most three figures (a
small label over a number) beside it, in place of a strip of equal boxes. "2
open alerts, both warnings" over the alert list; "1 of 7 sites at risk",
naming them, over the comparison table; "September net +$135 so far" over the
money chart.

**`FinishLine`** is the last line of a list short enough to read to the end:
"That's every open alert" and how old the data is. On an empty queue it is the
only line, so an empty list and a finished list look the same, and neither is
a blank panel.

**Home shows how the business is doing, what is broken and what needs the
operator's attention**, in that order, each as a chart or graphic. A small muted label
holds the greeting, the time since the operator last looked and how many
things changed in that time; under it one sentence summarises where the month
is heading and what is broken. The month's money is the main figure
(`MoneyHero`: the month so far as the largest figure on the screen, its
projected total against last month's total on a `PaceBar`, the month's days as
a `BarStrip`, and which sites the revenue came from), with yesterday's revenue
and visitors as `StatTile`s beside it. With no revenue source anywhere,
visitors come first and no money figure is drawn. Then every site's data
sources as one `HealthGrid`, where only problems are coloured, with the
System's own row, beside the ranked `IncidentList` of the problems the grid
does not draw, so each problem appears once, and the `DecisionQueue` under it.
Then the sites compared (`PortfolioRows`, in seed order; with only one site,
Home shows that site's own Overview strip and chart instead), and the last 24
hours as an `EventTimeline`. Home's layout depends on its own width: one
column, two from about 768 px of content, twelve from about 1150 px, so a
narrow window or a portrait monitor gets a layout made for it instead of a
squeezed desktop one.

**A site's Overview starts with the site's health**: the header shows one
health word (`siteHealth` in `lib/site-health.ts`, the same calculation Home,
the Sites page and the TV's site rows use) and one line of three facts
separated by dots. Below it the main row shows money, people, search and the
site's one product figure as `StatTile`s, each with its window, its change
against the days before, its recent days as a dated `BarStrip` and one context
line. The selected figure is drawn on the chart: bars with the days before as
a dashed level, the best and lowest day named on the bars, every shipped
change a labelled mark, and shaded spans for an open alert (drawn with its
onset and the rule's normal range), an outcome check or days not reported, so
causes and effects appear on one time axis. Then each data source's last 30
days as one row of day squares, starting with the source that failed most
recently, and the open alerts the chart does not already show. Bets, Needs
you, the search queries that moved most and the product cells follow.
Provider names appear only as a chart key beside their own line.

**A site's other tabs start with a chart or graphic of their main
information.** Growth: every series the site collects against the window
before, as `ChangeRows` above the four charts, the tracked terms as a
`FunnelBars` and product use as bars. Money: the month as one equation, its ad
revenue days against the usual day and the month against last month on a
`PaceBar`, then the accounting months as revenue and cost bars on one scale.
Search: the queries that moved, each drawn at its current position on the
results page against its earlier one, then the tracked terms with a rank track
on every row. Alerts: the last thirty days as an `EventTimeline`, one row per
condition, and each open reading on its `NormalBand`. Activity: the last
ninety days of changes and bets on one `EventTimeline`, a bet marked where it
was recorded and where its verdict arrived. Data sources: the connected
sources that supply the site's data as a `FlowGraph`, the failing one
highlighted in place, the rest named on one line. Settings is a form: one
column of panels at the width `/settings` uses.

**The Sites page shows which sites need attention.** Its summary names
those sites, beside where the month is heading and yesterday's visitors; one
bar splits every site by its health word, and its legend is the filter. The
comparison is the main element: `PortfolioRows` with the sources column, one
row per site with its people a day over four weeks (dated), yesterday's figure
against a week before, yesterday's revenue, its share of the month and its
data sources as small dots where only a failing or late source is coloured.

**Alerts shows what is broken and since when**: the summary, the last seven
days as an `EventTimeline` (open problems as bars to now, settled ones as
closed bars), then one board grouped by site, worst first, each reading drawn
on a `NormalBand` against the range its own rule computed, and anything open
for over a week collapsed under one line.

**Tasks shows the size and age of the queue**: the tasks waiting for the
operator as a `DecisionQueue` with the spread of their ages, closed and filed
a day over two weeks as two dated `BarStrip`s on one scale, each project's
week as the Wall's `WorkFlow` chart, and the most stuck epic as a `FlowGraph`
whose blocked edges are drawn as broken lines. The full task table follows, with each task's
assignee on its row.

**Agents shows who did the work**: the tasks closed in the last seven days
against the seven days before, eight weeks of closed tasks as `StackedWeeks`
split by who closed them, one row per worker (the task it holds, its last
seven days as a strip, its median time from claim to close), the week's
ranking of agents and the models they named as a `RaceChart`, the week's
trophies, and the claims and closes with their evidence as chips. A close is
counted for whoever closed the task; an agent is a worker that named a model.
Each worker's name carries an `AgentMark`: its maker's original artwork from
`public/agents`, chosen by the name and then the models it named, or the
name's first letter for a person or an unknown maker.

**Money shows one equation**: revenue − cost = net for the month, net the
largest, beside the month's days as a `BarStrip` (a day some source did not
report is outlined), the month against last month on a `PaceBar` and the split
by site. Then the costs, largest first, and the sites ranked by revenue with
their net by month. **System health** starts with the System as a `FlowGraph`
and, under it, every scheduled job's last seven days as one row of cells, the
newest failure named at the top.

**Settings is a form, laid out like one**: General, Alert rules, Data
collection, TV dashboard, Ownership and Task projects as tabs (Installation
and Members where they apply), each a single column of a readable width so a
field and the visual beside it stay close together on a wide screen. Every
group is a panel with its section label and rows divided by thin lines, the
same layout a site's Settings tab uses for its groups, so the two settings
pages look alike.

**Index pages** meet the same checklist: Sites, Alerts, Tasks, Money,
Integrations and Workflows each start with a `PageAnswer`; Alerts and Tasks
end with a `FinishLine`; a fact appears once per screen, so the selected item
in a navigation list is not repeated as a card title and a back link is not
repeated as a breadcrumb. Actions are on the row they act on: Snooze and
Resolve on an alert, Acknowledge and Tune in its expansion.

**Opening the Tower shows the Notice lockup until the first screen is
drawn.** `index.html` draws the boot splash before any script runs: the mark,
the NoticeOS wordmark and, under them, a thin line with one segment sweeping
from left to right. It shows nothing for its first 180 ms, so a fast start
goes straight to the screen. It stays while the session is checked and the
first screen's code and first reads arrive, then fades out over the drawn
screen in 240 ms (`lib/boot-splash.ts`). The first reads hold it for at most
2.5 seconds after the screen mounts and nothing holds it past 8 seconds; the
sign-in screen, the other session screens and a screen whose code could not
be fetched remove it at once. It never takes a click, and the Wall opens the
same way. It is drawn in the operator's theme, and always dark on the Wall.

**A screen still loading shows its shape, never a value.** While a page's
first read or its code is on its way, skeleton blocks in the empty-track
colour (`PageSkeleton`, `RouteLoading`) stand where its summary, chart, rows
or fields will be drawn, so nothing moves when they arrive, and one faint
highlight crosses them every 1.6 seconds. They appear after 180 ms, so a fast
load goes straight to the content, and they hold no digit, chart mark or
state colour, so a placeholder cannot pass for a reading; screen readers get
the page's words ("Loading…") at once. Switching pages or an asset's tabs
keeps the page or tab being left on screen until the next one's code is here;
the new one then fades in.

## The Wall

The TV shows five things, in the order a viewer reads them: the business's
position in its own cycle (the loop across the top: Sense, Attribute, Decide,
Act, Learn, each with its live count and state); current problems (the last
24 hours, one row per site and one for the System, every open problem a bar
from its onset to now, and the issue mark beside a site's name); progress
against this month (the revenue figure, its pace, the month's line against
last month's total); which sites need attention and how each is doing right
now (one row per site: live people, today against the same weekday last week,
a 30-day trend, the month's money); and whether work is moving (waiting on the
operator, in progress, done this week and blocked, one row per project, done
work as a bar extending left of a centre line and the open queue extending
right). Anything else belongs on the Tower page for its subject; the Needs
attention, live feed and agents widgets stay in the widget library for an
operator who wants them on the Wall.

The Wall is drawn from a layout document, not a fixed tree. `WallCanvas`
renders rows of nine widget types: the strip, the loop, revenue, the last 24
hours, Needs attention, the site rows, work, the feed and the agents' ranking. `scripts/wall-layout.mts`
defines the composition rules: how many rows and widgets a layout may hold,
that widths are weights sharing a row rather than columns, each widget's
minimum and maximum, which widgets are unique, which row takes the remaining
height, and the one-column order a portrait tablet or a phone stacks into. The
same validator runs on every path a layout can be written through, so the
editor, the config pipeline and the renderer always accept the same layouts.
The kit's components for the Tower's pages render on the TV inside
`.wall-root`, where their small type sizes are scaled for the distance the
Wall is viewed from.

The operator arranges widgets at `/wall/edit` and never authors widget types.
The editor shows the TV's own layout, rendered by the same component the TV
uses at 1920×1080 and scaled to fit the window, so the arrangement in the
editor is exactly what the TV shows. Its structure is a row of stacks: a row
holds columns side by side, a column stacks widgets. A dragged widget is
placed by the edge of the target the pointer is nearest, measured as a share
of the target so a long thin strip still has sides: top or bottom stacks the
two in one column, left or right makes a column beside it taking half its
width, a band between rows starts a new row. A line and a short label ("Above
Sites") show where the widget will land before the drop, and only where the
drop is allowed, so the line shows exactly what will happen and no rejection
message is needed. Every place a drag reaches is also an item in the widget's
Move menu, with Alt and the arrows as its keys and a screen-reader
announcement of where the widget went, because not every operator uses a
pointer (WCAG 2.5.7). The handles between columns and between stacked widgets
resize live, snap to quarters, thirds and halves, and stop at the smallest
size at which a neighbour stays legible; a widget drawn below that size shows
"Too narrow" instead of a broken chart. A column left with one widget is
replaced by that widget and an empty row is removed, so the layout never holds
a container nobody can see. Each change, including one drag of a handle, is
reversed by one Undo. The side panel holds only the selected widget's
settings, the Add drawer or the versions: no panel of controls repeats the
arrangement the preview already shows.

One chart style is used for every small chart on the TV and the sparklines on
the Tower's pages: a monotone line with round caps, an area fill that fades
to transparent at the baseline, a round point on a surface ring; a halo for
now, a pulsing ring for a value still being counted, plain dots for final
values; a faint dashed line for the comparison and a dashed line in the
series' own colour for a projection. First and last day in muted micro type
beside the plot, a thin baseline, no legends. Strokes are sized to be read at
three metres, and colour comes from the token the calling component passes.
The convention "today solid, last week dashed" is written down once, here,
and not on the screen.

The TV background is pure black so unused pixels emit no light; nothing on it
needs a pointer; state is never colour-only; a failed poll keeps last-good
values with their age. A landscape screen shows the TV's layout scaled by one
factor, with a minimum size for small type so it stays readable on a laptop; a
portrait screen stacks the widgets in one column. The Wall is the one surface
with a fixed height, so adding to it needs a design decision: `pnpm
audit:wall-fit` measures the live `/wall` at the TV's dimensions and reports
anything that overflows, including text overflow that changes no element's
box. Run it when a Wall surface grows; it is the only check that detects that
overflow.

## Operator flows

The flows that exist today, as `apps/tower/e2e/ux-flows.mjs` runs them, each
from its starting point to its result:

- **Connect Bing Webmaster Tools** — Integrations → the row's Connect panel:
  one key, tested and saved, sites matched, collecting.
- **Connect DataForSEO** — Integrations → Connect: login and password saved,
  spend shown, first reports collected.
- **Connect PostHog** — Integrations → Connect: one key, region found,
  projects matched, saved funnels imported, collecting.
- **Connect Microsoft Clarity** — Integrations: a token pasted on each site's
  row, saved on paste; Run now spends one of the day's calls.
- **Change a site's PostHog funnels** — the site's Data sources tab: pick one
  of the project's saved funnels on the row, saved on the pick.
- **Connect Mediavine** — Integrations → Connect: sign-in tested before it is
  saved, sites found and matched, synced.
- **Connect Google, self-hosted** — Integrations: console steps deep-linked,
  the client file dropped in, signed in, sites matched and collecting.
- **Connect Google, hosted** — Integrations: Continue with Google, sites
  matched and collecting.
- **Connect Discord** — Integrations → Connect: the webhook saved once its
  test message is delivered, the message shown before the press.
- **Connect calendar feeds** — Integrations: a secret feed address pasted on
  its row, read once before it is saved.
- **Open the core Tasks board** — Tasks, before any site exists: the board.
- **Add a site** — Add your first site: the domain, name inferred, ending on
  its Data sources.
- **New site to first data** — Add a site, then its Bing row's Connect: key,
  site matched, collecting.
- **Fresh install to the first number** — Add a site, connect Bing from its
  row, open the site: its clicks on screen.
- **Configure a site's data sources** — the site's Data sources: skip one with
  a reason, set a market.
- **Answer the inbox** — Tasks: approve a gate and answer a request, on the
  row.
- **Approve several decisions at once** — Tasks: Select, Select all, then one
  Approve for every selected approval, with one Undo.
- **File a task from a finding** — the site page: File task on the finding,
  prefilled.
- **File a task** — Tasks → New task.
- **Change the time zone** — Settings → General: saved on change, then Undo.
- **Change a portfolio setting** — Settings: the monthly data budget.
- **Change how often data is collected** — Integrations → a source's Manage
  panel: the collection's schedule.
- **Rotate a key** — Integrations → the connection: Replace API key, tested
  before it is saved.
- **Disconnect an integration** — Integrations → the connection: one
  confirmation naming what stops.
- **Arrange the TV Wall** — Edit beside the TV entry: on a desktop, drag a
  widget onto another's top edge to stack them; move the strip down through
  its Move menu (the phone's whole path); save.
- **Screen survey** — every main screen, populated: a pass that measures each
  page's statuses and lists, not a flow.

A new or changed flow is designed by whoever builds it, with the control on
the step where the operator already is. Its scripted run changes in the same
commit so the flow walker measures the flow that exists, and the line for it
is added here afterwards.

## Lexicon

The Tower's pages use plain English at the level of detail that suits the
person reading them. The system's own vocabulary — bead, spoke, lane, pulse,
knob, poller, hub, register, asset #0 — never appears on a screen; the words
on screen are *task*, *project*, *data source* or *scheduled job*, *nightly
report*, *setting*, *the System*. The on-screen noun for the thing in the
portfolio is **Site**, never *property*, which is reserved for the provider's
own GA4 and Search Console objects that the Data sources tab has to name. One
concept has one word everywhere; an alert's text states what happened and
which direction is good, in the verb, with the statistics behind the evidence
icon; a missing value is shown as a word, not a dash.

Every word also has a level: business, operational or technical. *Business*
surfaces — Home, Sites, Money, a site's Overview, the TV — use words about
money, people, visitors, bets, decisions and verdicts: on track, at risk,
still counting, verdict in three days. *Operational* surfaces — Alerts,
Tasks, Workflows, a site's Activity and Alerts tabs — may also use alert,
watch, change, run, shipped, reverted. *Technical* surfaces — Data sources,
System health, Integrations, Settings — may also name providers, jobs,
credentials and freshness. A surface uses words from its own level or a less
technical one, never a more technical one: a business surface shows "being
watched · verdict in 3 days", not "watch window"; "still counting", not
"provisional"; "people a day", not "GA4 users". A provider's name appears on a
business surface only as a key beside its own mark: a chart key beside its
line, or the header of its own column in a data-source grid.

The enforced word lists are `scripts/ui-lexicon.test.mjs` (the banned
coinages, each with the word to use instead, and the operational and technical
words banned on the business surfaces) and `scripts/ui-noun.test.mjs` (never
*property* for a site). Both check shipped text only — string literals and
JSX text — and both are exact lists, so widening either is a deliberate
decision, made in the same commit that widens the list.

## Components

Check `apps/tower/src/components/registry.ts` and the gallery at
`/dev/kitchen-sink` before building anything. The registry is the index a
reader sees — the gallery renders its entries — and
`scripts/component-registry.test.mjs` fails the build when a component has no
entry, an entry names a file or export that is gone, or an entry has no demo.
Prefer reuse; a near-duplicate (a second badge, a third card variant) is the
most expensive thing a builder can add, because every later agent will have
to choose between two. A new component's registry entry gives, in one line,
the need that no existing entry covers. A better component replaces the old
one at all its call sites instead of existing beside it.

The component set covers every shape of data the Tower draws, and is extended
when a new shape appears: the form table under Principles lists each form and
its component. `BarStrip`, `PaceBar`, `NormalBand`, `StatTile`, `HealthGrid`,
`EventTimeline`, `FlowGraph`, `PortfolioRows`, `DecisionQueue`,
`IncidentList`, `ChangeRows` and `FunnelBars` in `components/viz/` are the
kit, shown with invented figures at `/dev/visual-kit`. One `Card` with four
kinds. `PageAnswer`, `FinishLine`. `KpiStrip` / `Kpi` and `SmallMultiple` for
a figure combined with its series; `HeroChart` for a dated chart with keys,
event marks and keyboard inspection; `Sparkline` and `MinutePulse` for the
compact shapes. `ListPanel` / `ListRow` for three rows that expand in place or
link to more detail. `Table`, which stacks into labelled cards on a phone.
`SeverityDot`, `StateChip`, `DeltaChip`, `AgeBadge`, `Meter`, `ProgressRing`,
`PriorityBar` for a state or a quantity with its icon. `EmptyState`,
`ReadFailed`, `PageSkeleton` and `RouteLoading` so every surface has a
designed empty, failed and loading state, `Skeleton` for one block of a
loading shape, and `NavigationProgress` for a navigation under way. `InfoTooltip` and `EvidencePopover` for the fact behind the
figure. On the Wall: `WallStrip`, `RevenueHero`, `NeedsYou`, `SiteRows`,
`WallFeed`, and `WallCanvas` that composes them.

**Charts.** Tabular digits on every figure. One chart style on the Wall, from
`ChartMarks`; on the Tower's pages, `HeroChart` shows a key for each series
that matches its line exactly as drawn (tone, pattern, weight) in foreground
ink, and with more than one series each key is a toggle. Prefer a label on the
mark to a legend: the first and last date beside the plot, the value at the
halo, an event's own label at its mark, a series' name at its line; a legend
is for a chart with no room for labels, and the Wall uses no legends. A
provisional point is hollow and keyed as such beside the other marks; a
reference series is thinner and dotted so the main series is seen first; an
average is drawn only over completed observations, never over the shared
calendar axis, so a missing day never gets a value. A chart shows its own
actual start and end dates and labels what it plots (a raw count and a rolling
average are different quantities).

**Accessibility.** Radix primitives provide keyboard and ARIA behaviour; do
not override them. A state is never colour-only: an icon or a word appears
beside every colour, and a reason is never only in a `title` attribute,
because keyboard users, phones and non-focusable spans never show one — the
dash for a missing value opens its own tooltip, reachable by hover, focus and
tap. Chart values are reached by focusing the plot and stepping with the
arrow keys, the same readout the pointer shows; series keys expose their
on/off state to screen readers. Toasts mount through `AppToaster` only, so a
toast is one tab stop in the page's own theme. Contrast is checked at AA for
text and 3:1 for series on the card, in both themes
(`test/chart-series-contrast.test.ts`). A decorative logo (a favicon) is
`aria-hidden` and sits beside a visible name. The phone layout is the same
components at a responsive breakpoint, never a separate mobile set. The Wall
renders no interactive controls beyond one small muted link home, and its
event marks open read-only explanations that a viewer who only watches never
needs to open.
