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
in `docs/brand/README.md`. `apps/tower/src/index.css` maps that identity to the
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
- **The Wall's scale.** Every type step on the TV (`text-wall-*`) and every
  gap between its regions (`spacing-wall-*`) is a token, because the Wall is
  the one surface with a fixed height and whitespace there is budget. The
  brand accent feeds primary actions, selection and focus, and no state or
  series token points at it.

## Principles

**One question per screen.** A surface answers one question and its first
screen is the whole answer. Home: *what changed since I last looked, and what
needs me.* A site's Overview: *how is it doing, what needs me, what matters.*
Sites: *which one needs me.* Anything that answers a different question is a
tab or a link, not a section further down.

**Charts lead; numbers ride them.** A number without its series is noise and
a chart without its number is decoration, so a KPI is one unit: value, delta
and the series it selects. The eye should read a shape before it reads a
word: a trend has its line, a spend its meter against the cap, a comparison
its signed delta, a state its glyph. If the visual answers nothing the figure
does not, it is decoration and does not ship. Empty and first-run states earn
a glyph and the next action, never a paragraph.

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
sentence. `pnpm ux:gate` measures every visible string's length and reports
retired words, and `pnpm ux:flows` walks every flow at desktop and phone width
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

**Hierarchy from scale, not boxes.** One card shape with four tints. A card
groups related things and never holds one fact; a region that is already
distinct is not wrapped in another rounded box. Section titles are quiet
eyebrows (`SectionLabel`: small, tracked, uppercase, muted) and the numbers
are the large type. Shadows stay off cards; depth comes from tint and the
highlight line.

**Colour is meaning.** Severity, the two business identities, a provider
beside its name, and the recorded-execution and connectivity greens. Every
other mark is neutral ink, so red means red when it appears. There is no
decorative accent: the brand blue marks a control, a selection or focus, and
nothing that carries data.

**Rhythm.** The desk uses Tailwind's type and spacing steps as its defaults
(`text-sm` and `text-xs` are the body and caption of most components), with a
handful of sizes a composition fixed once in one component: the 11 px eyebrow,
the 28 px KPI figure, a 13 px body line where the mockup wanted it. Those are
the pattern, not a licence: a size belongs to the role it names, set in one
place. On the Wall every size and gap is a token with no exceptions. The
scale is a default, not pixel law; what matters is that one role has one size
wherever it appears. Tabular digits wherever numbers align, baked into the
stat components rather than applied by hand.

**Interactive where it pays.** A scoped range selector, series keys that
toggle, hover readouts, click-to-select a metric, rows that expand in place.
Nothing decorative moves. A halo marks *now*, a slow pulse marks a series
still being counted, and both stop under `prefers-reduced-motion`; a feed row
slides in once and not at all for a reader who asked for less motion.

**Honest by construction, quiet by default.** A provisional day is a hollow
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

**`HighlightCard`** is one thing that changed since the operator last looked:
one kind (alert, money, people, shipped, win, milestone, bet), one short
sentence, one shape (a line, a line over its normal band, or a display figure)
and at most one verb. The card wears its kind's tint; the dot carries
severity for an alert, the money or people identity otherwise.

**`FinishLine`** ends a list the eye can finish: "That's every open alert" and
how old the reading is. On an empty queue it is the whole list, so empty and
finished read the same, and neither is a blank panel.

**Home is the Morning Brief.** A greeting line with three small figures:
yesterday's revenue, the month's pace and yesterday's visitors. Then at most
five highlight cards, the first drawn larger as the big thing, ranked by
severity, then dollars at stake, then kind; then the finish line that names
the next sweep. Then *Decide*: at most three rows with their verbs on the row
(Approve, Answer, Snooze). Then the sites in seed order, each with its one
health word. The OS never describes itself on Home unless something is
broken, and then the broken thing arrives as a highlight card. With one site,
the brief is that site's.

**A site's Overview opens with a verdict**: the header carries one
health word (`siteHealth` in `lib/site-health.ts`, the same derivation Home,
the Sites table and the TV's site rows read) and one line of three facts
joined by dots. Below it the hero row is money, people, search and the site's
one product figure, over one chart that carries every shipped change as a
labelled mark and every open watch window as a shaded span, so cause and
effect sit on one axis. Then bets ranked by dollars, Needs you, the search
movers, and product cells that say "normal" out loud. Provider names appear
only as a chart key beside their own line.

**Index pages** follow the same bar: Sites, Alerts, Tasks, Money,
Integrations and Workflows each open with a `PageAnswer`; Alerts and Tasks end
on a `FinishLine`; a fact appears once per screen, so a navigator's selected
item is not repeated as a card title and a back link is not repeated as a
breadcrumb. Actions sit on the row they act on: Snooze and Resolve on an
alert, Acknowledge and Tune in its expansion.

## The Wall

The TV answers four questions in the order the eye takes them: *is anything
on fire* (Needs you, and the issue mark beside a site's name); *are we on
track this month* (the revenue figure, its pace, the month's line against last
month's total); *which site needs me and how is each doing right now* (one row
per site: live people, today against the same weekday last week, a 30-day
trend, the month's money); *what just happened* (the live feed, newest on top,
from stored events the Worker unions, never synthesized activity). Anything
that answers none of these lives on the desk page that owns it.

The Wall is drawn from a layout document, not a fixed tree. `WallCanvas`
renders rows of five widget types: the strip, revenue, Needs you, the site
rows and the feed. `scripts/wall-layout.mts` owns the composition rules: how
many rows and widgets a layout may hold, that widths are weights sharing a row
rather than columns, each widget's floor and cap, which widgets are unique,
which row takes the remaining height, and the one-column order a portrait
tablet or a phone stacks into. The same validator runs at every door a layout
can be written through, so the editor, the config pipeline and the renderer
cannot disagree about what the Wall can draw. The operator arranges tiles at
`/wall/edit` and never authors tile types; the editor previews through the
very component the television uses.

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
fixed height, so growth is a design question: `pnpm wall:fit` measures the
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
- **Arrange the TV Wall** — Edit beside the TV entry: move one widget, save.
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
only as a chart key beside its own line.

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

The vocabulary is small on purpose. One `Card` with four kinds. `PageAnswer`,
`HighlightCard`, `FinishLine`. `KpiStrip` / `Kpi` and `SmallMultiple` for a
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
label at its mark; a legend is a last resort and the Wall has none. A
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
