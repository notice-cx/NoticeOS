# Design

*How the Tower and the TV Wall look, read and feel, and why. This is taste
with intent, written so a builder can compose rather than invent. Where a
rule is enforced, the code that enforces it is named; the code is the source
of truth, and this document describes it.*

## The stack

What the Tower is built from, as it stands in `apps/tower/package.json`:

- **Vite + React + TypeScript**, one single-page app with React Router. The
  app's Worker and the ingest Worker run in one workerd runtime behind one
  Vite server (`scripts/README.md`); the Docker Compose application container
  and the demo profile ship the same runtime, pinned. The Cloudflare plugin
  supplies the Worker runtime; it is not the host.
- **Tailwind v4, CSS-first.** No `tailwind.config.js`: `@import "tailwindcss"`
  and an `@theme inline` block in `src/index.css` are the whole configuration.
- **shadcn-style components we own** in `components/ui/` (button, badge, card,
  command, popover, sheet, table) on Radix primitives where the behaviour is
  hard (popover, slot) and **cmdk** for the command palette.
- **Charts are inline SVG**, on the desk and the Wall alike, drawn from three
  marks in `components/surface/ChartMarks.tsx`. There is no charting library
  and no table library: `Table` in `components/ui/table.tsx` is ours, and it
  reflows into labelled cards on a phone.
- **TanStack Query** with polling for every read. **lucide-react** for glyphs.
  **Sonner** for toasts, mounted only through `AppToaster`
  (`lib/toaster.tsx`). Motion is CSS: keyframes and transitions under
  `motion-safe:` / `motion-reduce:`, no animation library.

Dark is the default theme, because the Wall is dark; `.light` is the desk's
variant. A dark subtree inside a light page (`[data-theme="dark"]`, the TV
preview in the layout editor) re-resolves the same variables, so the editor
draws the television as the television draws itself.

## Tokens

Colour, type and spacing are defined once, in CSS, and components consume
them by name. The identity lives in `apps/tower/public/brand/notice.css`
(canvas, surface, raised, ink, muted, line, the accent, success, danger,
warning, cyan, violet, the two fonts, radii and two motion durations), shared
with the standalone reference page `public/design-system.html` and described
in [brand](brand.md). `apps/tower/src/index.css` maps that identity to the
application's aliases, redefines them for `.light`, and exposes everything
through `@theme inline` as `--color-*`, `--text-*` and `--spacing-*`
utilities. A hex or pixel literal in a component is the smell to look for in
review: it means a fact now has two derivations, and the second one will
drift. The one exception the CSS itself names is a size that exists for a
single mark, declared as a token for that mark.

The families, and what each means:

- **Attention: `error` / `warn` / `info`.** The severity of a flag, and
  nothing else wears these. `info` is a slate, not a blue, so it never
  competes with the accent. `urgent` is one measured step between `warn` and
  `error` so the countdown's proximity ramp can escalate without inventing a
  rival scale; it is not a fourth severity and no flag maps to it.
- **`milestone` emerald**, reserved for milestone-*kind* items. A win is green
  because it is a win, not because it is healthy.
- **Recorded workflow execution: `healthy` / `error` / neutral.** Green is a
  recorded success, red a recorded failure, grey is paused, skipped, never run
  or unknown. A green run says the job finished; it says nothing about the
  business outcome.
- **Integration connectivity: `connected` / `error` / neutral.** Whether the
  OS can consume a source end to end. Provider artwork beside it is identity,
  never status.
- **Business identities: money and people.** `financial-revenue` cyan is
  money; `traffic` azure is people, visitors, search clicks. `financial-cost`
  violet is the cost series. These are *who a line is*, never a verdict on it:
  a falling traffic line is still azure. The hues were chosen by measurement
  so money, people, the accent and the severities stay apart on the TV's
  black and the desk's light canvas (`test/brand-identity.test.ts`).
- **Provider colour: `search-bing`.** One provider identity token, always
  beside the word "Bing", never alone, never on the Wall (it shares the blue
  family with `traffic`).
- **Trend and pace.** `trend-positive` / `trend-negative` are the diverging
  scale for a *completed* like-for-like comparison, at three intensities.
  `pace-on` / `pace-behind` / `pace-far-behind` are aliases of those and
  `warn`, scoped to today's hours against the same hours last week: "a little
  behind" borrows the warn hue as a step of a comparison, not as a warning,
  and nothing else may borrow it. `paceTone` in `components/DeltaChip.tsx` is
  the one place the step is chosen.
- **Surface kinds: `surface-money` / `-alert` / `-win` / `-neutral`.** A
  card's *subject*, as a low-chroma tint on its top edge with one inner
  highlight line. A tint is never a verdict: an alert card is tinted alert
  whether its alert is warn or error, and the severity rides the dot and the
  word. `glass` is for chrome only, never for a surface carrying numbers.
- **Chart furniture.** `chart-week-band` for alternating calendar weeks,
  `chart-distorted` for a day a reporting-timezone change made incomparable
  (a caveat about the measurement, in a quieter warn, never an alert), and
  `spark` for the neutral compact trend.
- **The visual kit's furniture.** `viz-track` is the empty track a bar or a
  band fills, `viz-grid` the hairline a grid or an axis is ruled in, and
  `shadow-raised` the one elevation a screen's hero region may take. The
  desk's type scale above Tailwind's steps (`text-display`, `text-figure`,
  `text-figure-sm`, `text-micro`) is listed in `THEME_TEXT_SIZES`
  (`lib/utils.ts`) so a class merge never drops it.
- **The Wall's scale.** Every type step on the TV (`text-wall-*`) and every
  gap between its regions (`spacing-wall-*`) is a token, because the Wall is
  the one surface with a fixed height and whitespace there is budget. The
  brand accent feeds primary actions, selection and focus, and no state or
  series token points at it.

## The bar

A screen is done when someone would screenshot it to show what NoticeOS can
do: the answer is a picture before it is a sentence, the most important thing
is the biggest, every number says what it is compared with, time is on the
screen, the broken part lights up where it lives, and nothing is squeezed,
clipped or broken mid-word. Rectangles of text are an unfinished design, not a
house style. Before a screen ships, its screenshot at desktop and phone width
answers yes to each of these:

1. Can a glance tell good from bad without reading a sentence?
2. Is the most consequential thing the largest and the first the eye lands on?
3. Does every figure carry its yardstick (a change against a named baseline, a
   target, or its usual range) and its recent history?
4. Is time drawn: a series, a strip, a timeline with now on it? And does every
   line say when: a small line or strip without a full axis carries its first
   and last date under it, so no squiggle is left unplaced in time?
5. Are same-kind things grouped into one composite rather than one card each?
6. Is every problem drawn on the thing it is about?
7. Does every name, figure and sentence fit its box at every width?
8. Is colour spent on data and state, with one thing to look at per region?

## Principles

**One question per screen, answered with a picture first.** A surface answers
one question and its first screen is the whole answer. Home: *how is the
business doing, what is broken, and what needs me.* A site's Overview: *how is
it doing, what needs me, what matters.* Sites: *which one needs me.* Anything
that answers a different question is a tab or a link, not a section further
down. Pictures carry the answer; words carry what a picture cannot: a name, a
cause, a verb.

**Choose the form from the shape of the data.** Each kind of data has a form
that reads at a glance, and the kit has it:

| The data is | Draw it as | In the kit |
|---|---|---|
| a quantity over time | its series with a yardstick: the comparison as a ghost or a dashed usual level, the newest value at its end | `HeroChart`, `Sparkline`, `BarStrip` |
| progress through a period | the period so far against where it is heading and the last period's total | `PaceBar` |
| a reading against its normal | the usual range as a band, the reading as a marker, the verdict as a word | `NormalBand` |
| parts of a whole | one split bar whose legend is the figures | `SegmentBar` |
| units compared on one measure | ruled rows with an inline line or bar and the value at the end | `PortfolioRows` |
| many units × many states | a grid, one cell per pair, the state as fill, the age in the failing cell | `HealthGrid` |
| events in time | lanes on a time axis with now drawn, problems as spans from onset to now | `EventTimeline` |
| how things connect or flow | nodes and edges, each node in its state with its live count, the broken one lit where it sits | `FlowGraph` |
| where things are | a map, when place is the data (visitors by country), never as scenery | — |
| a queue | its size, its age spread, then the rows with age as a length | `DecisionQueue` |
| open problems | one ranked panel: new since the last look first, the long-standing folded | `IncidentList` |

A region is redesigned by the question it answers, not component by component:
five alert cards may become one grid and one ranked list, six site cards one
comparison panel. When no form in the kit fits a new kind of data, build the
form; the table above grows.

**Every number has a yardstick.** A figure is one unit of five parts: a label
naming the measure and its window ("Revenue, yesterday"), the figure, its
yardstick (a signed change against a named baseline, a target or the usual
range), its recent history, and one context line with the key values in bold.
`StatTile` is that unit at tile scale and `Kpi` in a strip. A number that
cannot say whether it is good is noise; a chart without its number is
decoration. A figure with no history yet says why rather than drawing a flat
line. Empty and first-run states earn a glyph and the next action, never a
paragraph.

**Rank by consequence; size follows rank.** A screen has one hero region, a
few modules and dense rows. Severity, freshness and money at stake decide
order, size and colour: what broke since the operator last looked leads and is
loudest, a problem open for over a week folds under its own heading, a healthy
site is quiet. Equal weight for unequal things is a bug.

**Group same-kind things; attach each to its subject.** Many alerts are one
board, many sites one comparison, many data sources one grid. A card per item
is the failure mode, not a layout. A failing data source lights its cell in its
site's row, a failed backup lights its node in the system graph, an alert sits
on the chart of the metric it is about: the operator never assembles the
picture from boxes scattered across the page.

**Annotate in place.** Label the mark rather than a legend: the newest value at
the line's end, a named reference point ("Busiest day · Jul 11 · $42"), shaded
bands for an outage, a measurement window or a usual range, a series' name at
its line. A legend is for a chart with no room for labels on its marks.

**Progressive disclosure.** Three rows by default, expand in place for
evidence, "All →" for the rest. Names, units, essential periods and the
compact stale / unknown / not-comparable marks stay visible; exact timestamps
and the method go on hover, focus or tap, in one shared tooltip rather than a
cluster of help icons. Material state, the thing that would change the
operator's next action, is never only inside a collapsed disclosure
(`apps/tower/shared/materiality.ts` maps every such condition to where it is
drawn).

**Show state; do not explain it.** The operator reads at a glance and across a
room. If a step needs a footnote to be used, the step is wrong: show the state
visually, infer or default the answer, or remove the step. Labels, states and
values should be enough to act; a finished flow never required reading a
sentence. `pnpm audit:copy` measures every visible string's length and reports
retired words, and `pnpm audit:flows` walks every flow at desktop and phone width
and counts its actions, screens, repeated checks and duplicated statuses.
Both are reports that inform design review: a long string or a longer walk is
a signal that a flow wants redesigning, not a number to argue with.

**A flow should feel short, and a new step must earn its place.** New
capability is usually a control on the current step. Connect panels are the
model: the key is pasted, tested and kept in one press, the matched sites
appear in the same panel, and *Start collecting* is the last press. One
status per subject per screen, shown where the operator acts on it; a list
that repeats one subject is grouped under it. Undo over confirm for anything
Tower-local; preview-then-commit for anything that deploys, spends or leaves
the Tower.

**Boxes by role, depth by rank.** A panel holds a group (a board, a grid, a
comparison), never one fact; a region that is already distinct is not wrapped
in another box. The hero region may be raised (`shadow-raised`) with a soft
wash of its identity ink; everything else sits flat on hairline rings. Panel
sizes differ because importance differs: the hero spans more of the grid than
the modules beside it. Section titles are quiet eyebrows (`SectionLabel`) and
the numbers are the large type. A `StatTile`'s top rule names its role on the
screen (context, a problem, a win, money, people), so a row of tiles reads as
an argument: context, then the problem, then what to do.

**Colour is meaning, rationed.** Severity, the two business identities, a
provider beside its name, and the recorded-execution and connectivity greens.
Each region has one thing coloured to look at; the rest of its marks are
neutral ink, so red means red when it appears: in a bar strip the newest day
wears its identity and the days before it are grey; in a grid only the failing
cell is red. Colour goes on data and state, not on controls: a row's verb is
quiet until the row is pointed at or focused, and the brand blue marks the
screen's one primary action, a selection or focus, never data. Hatching
(`viz-hatch`) is "nothing measured here" and never a low value.

**Type has a scale, and numbers own its top.** `text-display` (44 px) is a
screen's lead figure, `text-figure` (30 px) a tile's, `text-figure-sm` (22 px)
a row's or a strip's; body and caption are `text-sm` and `text-xs`, and
`text-micro` (11 px) is the floor: nothing on the desk is set smaller. The
largest type on a screen is a number or the screen's answer, never a greeting.
Units, "est." and qualifiers are a step lighter than their figure. On the Wall
every size and gap is a token with no exceptions. Tabular digits wherever
numbers align, baked into the stat components rather than applied by hand.

**Layout fits the content.** Regions sit on a grid with spans by importance.
Components size themselves by their own container (`@container`), not the
viewport, so a panel in half the page lays out for half the page. Nothing is
cut to an ellipsis. A squeezed column drops before a name does, and a name
too long for what is left wraps between its words, never mid-word and never a
word a line. A label that must stay on one line (inside a timeline bar, over a
grid column, on a chart) is shown whole or not at all (`FitLabel`). A filler line
("that's everything") is a line inside its region, never a grid cell of its
own.

**Motion carries a change.** A figure counts to its new reading, a line draws
in when its screen first paints, a bar or span grows from its baseline, a new
row arrives, a live edge in a graph carries its flow, a source being collected
breathes, a halo marks *now* and a slow pulse a series still being counted.
Nothing loops without live data behind it, and all of it stops under
`prefers-reduced-motion` (the `viz-*` classes in `src/index.css`). No
photography, 3D renders, glass over numbers, or texture that encodes nothing.

**Interactive where it pays.** A scoped range selector, series keys that
toggle, hover readouts, click-to-select a metric, rows that expand in place, a
grid cell or a graph node that opens what it stands for.

**Honest by construction.** A provisional day is a hollow
point; a projection is dashed and neutral; a day the measurement cannot
compare is bracketed on the axis and its colour verdict withdrawn; a shipped
change or a timezone move is a mark on the axis that explains itself on hover,
focus and tap. A missing figure is a named absence ("never", "unknown", "no
report owed"), never a fabricated zero and never a bare dash in a labelled
slot; a *measured* zero is a number and is drawn. A failed poll keeps the
last good values with their age and says it is reconnecting. A comparison the
data cannot support says "not comparable" rather than losing its colour and
keeping its percentage. Smoothing passes through every reading and never
above or below the readings either side, so a curve states nothing the data
does not.

## Surfaces, as built

**`PageAnswer`** opens every index page and site tab: one sentence at the
display scale, a muted detail line and at most three figures (an eyebrow over
a number) beside it, replacing a strip of equal boxes. "2 open alerts, both
warnings" over the alert list; "1 of 7 sites at risk", naming them, over the
comparison table; "September net +$135 so far" over the money chart.

**`FinishLine`** ends a list the eye can finish: "That's every open alert" and
how old the reading is. On an empty queue it is the whole list, so empty and
finished read the same, and neither is a blank panel.

**Home answers how the business is doing, what is broken and what needs
the operator**, in that order, each drawn. A quiet eyebrow carries the
greeting, the window since the operator last looked and how many things
changed in it; under it one sentence is the answer: where the month is
heading and what is broken. The month's money is the hero (`MoneyHero`: the
month so far as the largest figure on the screen, where it is heading against
last month's total on a `PaceBar`, the month's days as a `BarStrip`, and which
sites earned it), with yesterday's revenue and visitors as `StatTile`s beside
it. With no revenue source anywhere, visitors lead and no money figure is
drawn. Then every site's data sources as one calm `HealthGrid` with the
System's own row, beside the ranked `IncidentList` of the problems the grid
does not draw, so each problem appears once, and the `DecisionQueue` under it.
Then the sites compared (`PortfolioRows`, in seed order; one site draws its own
lead instead), and the last 24 hours as an `EventTimeline`. Home lays itself
out by its own width: one column, two from about 768 px of content, twelve
from about 1150 px, so a narrow window or a portrait monitor gets a layout
made for it rather than a squeezed desktop one.

**A site's Overview opens with a verdict**: the header carries one
health word (`siteHealth` in `lib/site-health.ts`, the same derivation Home,
the Sites page and the TV's site rows read) and one line of three facts
joined by dots. Below it the hero row is money, people, search and the site's
one product figure as `StatTile`s, each with its window, its change against
the days before, its recent days as a dated `BarStrip` and one context line.
The figure pressed is drawn on the chart: bars with the days before as a
dashed level, the best and lowest day named on the bars, every shipped change
a labelled mark, and shaded spans for an open alert (drawn with its onset and
the rule's normal range), an outcome check or days not reported, so cause and
effect sit on one axis. Then each data source's last 30 days as one row of
day squares, led by the source that broke most recently, and the open alerts
the chart does not already show. Bets, Needs you, the search movers and the
product cells follow. Provider names appear only as a chart key beside their
own line.

**Sites answers which one needs me.** The answer names the sites that do, beside
where the month is heading and yesterday's visitors; one bar splits every site
by its health word, and its legend is the filter. The comparison is the hero:
`PortfolioRows` with the sources column, one row per site with its people a day
over four weeks (dated), yesterday's figure against a week before, yesterday's
revenue, its share of the month and its data sources as pips where only a
failing or late source takes a colour.

**Alerts answers what is broken and since when**: the answer, the last seven
days as an `EventTimeline` (open problems as bars to now, settled ones as closed
bars), then one board grouped by site, worst first, each reading drawn on a
`NormalBand` against the range its own rule computed, and anything open for over
a week folded under one line.

**Tasks shows the queue's shape**: what waits on the operator as a
`DecisionQueue` with its age spread, closed and filed a day over two weeks as
two dated `BarStrip`s on one scale, each project's week as the Wall's
`WorkFlow` chart, and the most stuck epic as a `FlowGraph` whose blocked edges
are drawn broken. The full task table follows.

**Money is one equation**: revenue − cost = net for the month, net the largest,
beside the month's days as a `BarStrip` (a day some source missed is outlined),
the month against last month on a `PaceBar` and the split by site. Then where
the cost goes, largest first, and the sites ranked by revenue with their net by
month. **System health** leads with the System as a `FlowGraph` and, under it,
every scheduled job's last seven days as one row of cells, the newest failure
named at the top.

**Index pages** follow the same bar: Sites, Alerts, Tasks, Money,
Integrations and Workflows each open with a `PageAnswer`; Alerts and Tasks end
on a `FinishLine`; a fact appears once per screen, so a navigator's selected
item is not repeated as a card title and a back link is not repeated as a
breadcrumb. Actions sit on the row they act on: Snooze and Resolve on an
alert, Acknowledge and Tune in its expansion.

## The Wall

The TV answers five questions in the order the eye takes them: *where is the
business in its own cycle* (the loop across the top: Sense, Attribute, Decide,
Act, Learn, each with its live count and state); *is anything on fire* (the
last 24 hours, one row per site and one for the System, every open problem a
bar from its onset to now, and the issue mark beside a site's name); *are we
on track this month* (the revenue figure, its pace, the month's line against
last month's total); *which site needs me and how is each doing right now*
(one row per site: live people, today against the same weekday last week, a
30-day trend, the month's money); *is the work moving* (waiting on the
operator, in progress, done this week and blocked, one row per project, done
growing left of a centre line and the open queue right). Anything that
answers none of these lives on the desk page that owns it; Needs you and the
live feed stay in the library for a Wall that wants them.

The Wall is drawn from a layout document, not a fixed tree. `WallCanvas`
renders rows of eight widget types: the strip, the loop, revenue, the last 24
hours, Needs you, the site rows, work and the feed. `scripts/wall-layout.mts`
owns the composition rules: how many rows and widgets a layout may hold, that
widths are weights sharing a row rather than columns, each widget's floor and
cap, which widgets are unique, which row takes the remaining height, and the
one-column order a portrait tablet or a phone stacks into. The same validator
runs at every door a layout can be written through, so the editor, the config
pipeline and the renderer cannot disagree about what the Wall can draw. The
kit's desk components draw on the TV inside `.wall-root`, where their small
type steps are scaled to the Wall's reading distance.

The operator arranges widgets at `/wall/edit` and never authors widget types.
The editor is the television's own picture, drawn by the very component the
TV uses at 1920×1080 and scaled to fit the window, so what is arranged is what
the room will see. Its grammar is a row of stacks: a row holds columns side by
side, a column stacks widgets. A drag lands by the edge the pointer is nearest,
as a share of the widget so a long thin strip still has sides: top or bottom
stacks the two in one column, left or right makes a column beside it taking
half its width, a band between rows starts a new row. A line and its words
("Above Sites") show the landing before the drop, and only where the drop is
allowed, so the line is the promise and a refusal never has to be read. Every
place a drag reaches is also an item in the widget's Move menu, with Alt and
the arrows as its keys and an announcement of where the widget went, because a
pointer is not the only hand (WCAG 2.5.7). The handles between columns and
between stacked widgets resize live, snap to quarters, thirds and halves, and
stop at a neighbour's legible minimum; a widget drawn below it says "Too narrow"
rather than showing a broken chart. A column left holding one widget becomes
that widget again and an emptied row goes, so the layout never carries a
container nobody can see. Every change is one Undo; a drag of a handle is one.
The side holds only the selected widget's settings, the Add drawer or the
versions: no panel of controls restates the arrangement the picture already
shows.

One chart language, across every small chart on the TV and the desk's
sparklines: a monotone line with round caps, an area whose wash eases to
nothing at the baseline, a round point on a surface ring; a halo for now, a
pulse for still-counting, plain dots for settled ends; a ghost (dashed,
low-contrast) for the comparison and a dashed line in the series' own ink for
a projection. First and last day in muted micro type beside the plot, a
hairline floor, no legends. Strokes are sized to be read at three metres, and
colour comes from the caller's token. "Today solid, last week dashed" is
stated once, here, and nowhere on the screen.

The television is true black so unused pixels emit no light; nothing on it
needs a pointer; state is never colour-only; a failed poll keeps last-good
values with their age. A landscape screen draws the TV's layout zoomed by one
number, with small type floored so it stays readable on a laptop; a portrait
screen stacks the widgets in one column. The Wall is the one surface with a
fixed height, so growth is a design question: `pnpm audit:wall-fit` measures the
live `/wall` at the television's geometry and reports anything that spills,
including glyph overflow no element box reveals. Run it when a Wall surface
grows; it is the only thing that can see the answer.

## Operator flows

The flows that exist today, as `apps/tower/e2e/ux-flows.mjs` walks them, each
from where it starts to what it leaves behind:

- **Connect Bing Webmaster Tools** — Integrations → the row's Connect panel:
  one key, tested and kept, sites matched, collecting.
- **Connect DataForSEO** — Integrations → Connect: login and password kept,
  spend shown, first reports collected.
- **Connect PostHog** — Integrations → Connect: one key, region found,
  projects matched, saved funnels picked up, collecting.
- **Connect Microsoft Clarity** — Integrations: a token pasted on each site's
  row, saved on paste; Run now spends one of the day's calls.
- **Change a site's PostHog funnels** — the site's Data sources tab: pick one
  of the project's saved funnels on the row, saved on the pick.
- **Connect Mediavine** — Integrations → Connect: sign-in tested before it is
  kept, sites found and matched, synced.
- **Connect Google, self-hosted** — Integrations: console steps deep-linked,
  the client file dropped, signed in, sites matched and collecting.
- **Connect Google, hosted** — Integrations: Continue with Google, sites
  matched and collecting.
- **Connect Discord** — Integrations → Connect: the webhook kept once its test
  message is delivered, the message named before the press.
- **Connect calendar feeds** — Integrations: a secret feed address pasted on
  its row, read once before it is kept.
- **Open the core Tasks board** — Tasks, before any site exists: the board.
- **Add a site** — Add your first site: the domain, name inferred, landing on
  its Data sources.
- **New site to first data** — Add a site, then its Bing row's Connect: key,
  site matched, collecting.
- **Fresh install to the first number** — Add a site, connect Bing from its
  row, open the site: its clicks on screen.
- **Configure a site's data sources** — the site's Data sources: skip one with
  a reason, set a market.
- **Answer the inbox** — Tasks: approve a gate and answer an ask, on the row.
- **File a task from a finding** — the site page: File task on the finding,
  prefilled.
- **File a task** — Tasks → New task.
- **Change the time zone** — Settings → General: saved on change, then Undo.
- **Change a portfolio setting** — Settings: the monthly data budget.
- **Change how often data is collected** — Integrations → a source's Manage
  panel: the collection's schedule.
- **Rotate a key** — Integrations → the connection: Replace API key, tested
  before it is kept.
- **Disconnect an integration** — Integrations → the connection: one
  confirmation naming what stops.
- **Arrange the TV Wall** — Edit beside the TV entry: at a desk, drag a widget
  onto another's top edge to stack them; the strip down through its Move menu
  (the phone's whole path); save.
- **Screen survey** — every main screen, populated: a walk that measures each
  page's statuses and lists rather than a flow.

A new or changed flow is designed by whoever builds it, with the control on
the step where the operator already is. Its walk changes in the same commit
so the flow walker measures the flow that exists, and the line for it is added
here afterwards.

## Lexicon

The desk speaks plain English at the altitude of the person reading it. The
system's own vocabulary — bead, spoke, lane, pulse, knob, poller, hub,
register, asset #0 — never reaches a screen; the words on screen are *task*,
*project*, *data source* or *scheduled job*, *nightly report*, *setting*, *the
System*. The on-screen noun for the thing in the portfolio is **Site**, never
*property*, which belongs to the provider's own GA4 and Search Console objects
the Data sources tab has to name. One concept has one word everywhere; an
alert says what happened and which way is good, in the verb, with the
statistics behind the evidence glyph; a missing value is named, not dashed.

Every word also has an altitude. *Business* surfaces — Home, Sites, Money, a
site's Overview, the TV — speak in money, people, visitors, bets, decisions
and verdicts: on track, at risk, still counting, verdict in three days.
*Operational* surfaces — Alerts, Tasks, Workflows, a site's Activity and
Alerts tabs — may say alert, watch, change, run, shipped, reverted.
*Technical* surfaces — Data sources, System health, Integrations, Settings —
may name providers, jobs, credentials and freshness. A surface speaks at its
own altitude or lower, never higher: a business surface says "being watched ·
verdict in 3 days", not "watch window"; "still counting", not "provisional";
"people a day", not "GA4 users". A provider's name reaches a business surface
only as a key beside its own mark: a chart key beside its line, or the header
of its own column in a data-source grid.

The enforced word lists are `scripts/ui-lexicon.test.mjs` (the banned
coinages, each with the word to use instead, and the lower altitudes' words
banned on the business surfaces) and `scripts/ui-noun.test.mjs` (never
*property* for a site). Both read shipped text only — string literals and JSX
text — and both are exact lists, so widening either is a decision somebody
makes on purpose, in the same commit that widens the list.

## Components

Check `apps/tower/src/components/registry.ts` and the gallery at
`/dev/kitchen-sink` before building anything. The registry is the index a
reader sees — the gallery renders its entries — and
`scripts/component-registry.test.mjs` fails the build when a component has no
entry, an entry names a file or export that is gone, or an entry has no demo.
Prefer reuse; a near-duplicate (a second badge, a third card variant) is the
most expensive thing a builder can add, because every later agent will have
to choose between two. A new component states in one line what the registry
has nothing for. A genuinely better component replaces the old one and takes
its call sites, rather than living beside it.

The vocabulary covers every shape of data the Tower draws, and grows when a
new shape arrives: the form table under Principles names each form and its
component. `BarStrip`, `PaceBar`, `NormalBand`, `StatTile`, `HealthGrid`,
`EventTimeline`, `FlowGraph`, `PortfolioRows`, `DecisionQueue` and
`IncidentList` in `components/viz/` are the kit, staged with invented figures
at `/dev/visual-kit`. One `Card` with four kinds. `PageAnswer`,
`FinishLine`. `KpiStrip` / `Kpi` and `SmallMultiple` for a
figure fused to its series; `HeroChart` for a dated chart with keys, event
marks and keyboard inspection; `Sparkline` and `MinutePulse` for the compact
shapes. `ListPanel` / `ListRow` for three rows that expand in place or drill
in. `Table`, which stacks into labelled cards on a phone. `SeverityDot`,
`StateChip`, `DeltaChip`, `AgeBadge`, `Meter`, `ProgressRing`, `PriorityBar`
for a state or a quantity with its glyph. `EmptyState`, `ReadFailed` and
`RouteLoading` so every surface has its empty, failed and loading state
designed. `InfoTooltip` and `EvidencePopover` for the fact behind the figure.
On the Wall: `WallStrip`, `RevenueHero`, `NeedsYou`, `SiteRows`, `WallFeed`,
and `WallCanvas` that composes them.

**Charts.** Tabular digits on every figure. One chart language on the Wall,
from `ChartMarks`; the desk's `HeroChart` keys each series by its line exactly
as drawn (tone, pattern, weight) in foreground ink, and with more than one
series each key is a toggle. Prefer a label on the mark to a legend: the
first and last date beside the plot, the value at the halo, an event's own
label at its mark, a series' name at its line; a legend is for a chart with no
room for labels, and the Wall has none. A
provisional point is hollow and keyed as such beside the other marks; a
reference series is thinner and dotted so the lead reads first; an average
is drawn only over completed observations, never over the shared calendar
axis, so a missing day never acquires a value. A chart prints its own actual
start and end dates and names what it plots (a raw count and a rolling
average are different quantities).

**Accessibility.** Radix primitives carry keyboard and ARIA behaviour; do not
undo them. A state is never colour-only: a glyph or a word rides beside every
tone, and a reason is never only a `title` attribute, because a keyboard, a
phone and a non-focusable span never show one — the dash for a missing value
is the trigger of its own tooltip, reachable by hover, focus and tap. Chart
values are reached by focusing the plot and stepping with the arrow keys, the
same readout the pointer shows; series keys announce their state. Toasts mount
through `AppToaster` only, so a toast is one tab stop in the page's own theme.
Contrast is checked at AA for text and 3:1 for series on the card, in both
themes (`test/chart-series-contrast.test.ts`). Decorative identity (a
favicon) is `aria-hidden` and sits beside a visible name. The phone is the
same components at a responsive breakpoint, never a parallel mobile set. The
Wall renders no interactive chrome beyond one quiet link home, and its event
marks open read-only explanations that a passive viewer never needs to open.
