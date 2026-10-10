# 10 — Control Tower UX

*The Tower is the operator's control surface over the loop — not a reporting
afterthought. Design persona: **one person at the desk** — a workspace's
owner, operator or viewer — in three contexts: an office TV across the room,
a desk browser for decisions, a phone for approvals and the kill switch.
Design for pre-attentive scanning, not reading. State uses concise text plus a glyph where
useful (doc 14 "state is scannable and never color-only"), hierarchy is strong, each
surface has one primary action (doc 14 principle 4), and noise control is aggressive —
alert fatigue lands faster and harder here, which makes doc 02's volume-aware
flag rules load-bearing accessibility, not tuning niceties.*

**Hosted scope.** Preserve that simple, glanceable desk inside each
workspace. Hosted customers initially join by invitation; owners, operators
and viewers receive the capabilities defined in
[doc 23](23-configuration-ownership.md). The public demo is a real workspace
with read-only visitors and separate simulated activity. The standalone
release relies on the access boundary in
[`README.md`](../README.md#deployment-status); hosted isolation is not yet
certified. Live auth activation remains an explicit operator action under
`AGENTS.md`.

## Principles

1. **Glanceable, then drillable.** Every screen answers its question from
   3 meters away. Every actionable number links to an **existing** evidence
   view; if that view is not built, the number stays plain rather than becoming
   a dead link.
2. **Data freshness on every sourced metric tile.** Each data widget states the age of its source
   once (from the ingest-freshness pulse) — a stale tile that looks current is
   how silent failures survive ([doc 06](06-operations.md)). Freshness does not
   substitute for a chart's time domain: a primary trend prints its own actual
   first/last dates.
3. **Severity owns attention color.** Color encodes the flag **severity** enum
   exactly as [doc 02](02-signal-contract.md) defines it: `error` red / `warn`
   amber / `info` slate. `milestone` is a **kind**, not a severity and takes the
   reserved emerald accent. Two scoped operational states also use green:
   a reporting asset with no open error/warn is healthy-green, and a
   connected/working integration is green. An asset with no report remains
   gray; a not-working source is error red and not-configured is neutral gray.
   Visible alert/report copy plus checks / `!` / dashed treatment and hover
   labels keep those states non-color-only. Provider identity and completed
   like-for-like performance may use their scoped chart tokens; attention color
   remains reserved for attention.
4. **Standard components, current patterns.** shadcn-class primitives, tabular
   numerals, dark theme (TV-first), command palette (⌘K) — real for
   **navigation**, not yet for everything (see the shell section below) —
   keyboard-first at the desk. No bespoke chart exotica — line, bar,
   spark, delta chips.
5. **Every operator action is a recorded input.** Approvals, vetoes, boosts,
   undos, and snoozes are Learn signals and timeline annotations — the operator
   is part of the loop, not outside it.

## The desk shell

Every desk route renders inside one layout route: a persistent left sidebar and
one page header.

- **The sidebar** is the nine desk nouns in the operator's order: Home,
  Workflows, Sites, Alerts, Tasks, Financials, System health, Integrations,
  Settings — Tasks only once a task source is connected. Its footer
  holds what
  is not a page — Search…, the TV dashboard with an Edit pencil to
  `/wall/edit`, and the light/dark toggle. A setting saves in the field
  being edited, so no write path is parked in the chrome. `/dev/kitchen-sink`
  and `/dev/asset-states` stay dev-only routes reached by URL and are not in the
  nav: they are a reviewer's surface, and the nav is the operator's list of
  places the product goes. The current item carries `aria-current="page"`; a
  site's page lights Sites. Below `md` the column becomes a top bar with a menu
  button that
  opens the same content as a drawer.
- **Sites carries the portfolio**. Under the
  Sites entry, one row per site: its favicon, its display name, a severity dot
  **only** when it has an open warning or error, and a muted slash **only**
  when it is retired. A row lights on **any tab** of its site and the Sites
  entry lights with it: the row says which site, the entry says where in the
  product you are. The order is
  the index's default (the payload's own seed order) with **retired sunk to the
  foot** behind the switched-off slash; a quiet **Add a site** row closes the
  list; and above twelve sites the nav shows the first twelve plus **All
  sites…**, because a sidebar that scrolls has stopped being a fixed list you
  scan. The chevron beside the Sites link collapses it and the choice is
  remembered per browser — expanded by default on the desk, collapsed by default
  in the small-screen drawer, which is opened to go one specific place. Before
  the first read lands the list draws as many nameless muted rows as it drew
  last time, so nothing below it jumps and no placeholder can be mistaken for a
  site. A workspace with no sites yet shows only Add a site. ⌘K is still the
  keyboard-first path to the same place; this is the pointer-first one.
- **The page header** states what a page is: title, description, breadcrumb,
  right-aligned actions, and an inline meta slot for an age badge or a period.
  No page carries its own cart; the task page carries a back link to the page
  it was opened from. On the asset page the
  identity row (favicon, name, severity, domain, status badges) IS the heading.
- **`/assets` is canonical; `/properties` is an alias.** The sidebar reads
  **Sites** while the URL keeps the code's noun:
  `/assets` is the index and `/assets/:id` the page, and
  [doc 14](14-design.md) maps *asset* to *site* on screen. `/properties` and
  `/properties/:id` redirect to them with the hash intact.
  Every deep link the Tower has ever emitted — an alert's change chip to
  `#timeline`, a matrix cell to `#integrations` — still lands where it aimed.
  The index is a table, and with two or more sites it **filters and sorts,
  with the state in the URL** (`?status=&automation=&attention=&sort=&range=`,
  the `useSearchParams` mechanism `/alerts` established, so a narrowed table is
  a link): lifecycle status is a native `<select>` carrying a count per option,
  automation and attention are chips carrying their registry glyph and their
  count so every number is on screen at once (doc 14's glance rule),
  the ordering is a `<select>` and the table's header cells, every ordering but
  Name puts the most first with seed order as the default and as the
  tie-break, and a line above the table states what is shown — "3 of 6 sites ·
  status: live · sorted by open alerts" — with a Clear link beside it.
- **`/wall` stays outside the shell.** The TV has no navigation, and its tokens
  assume the dark emissive palette, so the theme class is applied by the shell
  and removed when the shell unmounts. A light desk can never reach the
  television.
- **⌘K jumps to any page or asset**. ⌘K or
  Ctrl+K anywhere inside the shell — and a **Search…** button in the sidebar
  footer, because a shortcut nothing points at is a shortcut only its author
  knows and a touch operator has no modifier key — opens a palette listing every
  page (the nine nouns, less Tasks without a task source, plus the TV and its
  layout editor) and every asset by display name, with its
  favicon, its domain and a severity dot when it has an open warning or error.
  Typing filters, Enter navigates, Escape closes, and focus returns to whatever
  had it. What the operator jumped to last is remembered and leads the list while
  the query is empty. With a task source connected, a query shaped like a task
  id offers one extra row that opens `/tasks/<id>`. This makes **principle 4
  partly real**: the palette
  navigates, it does not act. Running commands from it — approve, snooze, file —
  is [doc 16](16-replacing-the-chat-workflow.md) § L (the Ask console), which needs a verb vocabulary and
  a confirmation story before it can ship. The palette is mounted by the shell,
  so `/wall` does not have it: the television has no keyboard and nowhere to go.

## Home: the morning brief

`/` is the Morning Brief (`apps/tower/src/routes/HomeRoute.tsx`): a greeting
line with three small figures, at most five highlight cards since the operator
last looked (the first the big thing), Decide at three rows with their verbs
on the row, the sites in seed order with one health word each, and a finish
line. The composition is [doc 14 § Home](14-design.md); the words are
[doc 14 § Altitude](14-design.md). Every money figure quotes the same rule
every other surface quotes (`portfolioHeadline`), so Home can never state a
different net than the Sites page or the Wall; the task rows exist only with a
task source connected.

- **With one site**, Home leads with that site's own numbers and chart
  (`OneSiteLead`, the Overview's lead) and draws no table of one.
- **Home carries none of the TV's chrome**: no clock, no countdown, no meetings
  panel. `/wall` renders those, and the countdown editor is on `/settings`,
  which is where a control for a screen in another room belongs.
- **Until a site has its first number, Home is a first-run guide instead of all
  of the above** (`firstRunSite`, `apps/tower/shared/first-run.ts`): one card —
  a sentence saying what NoticeOS does, then three steps for the newest site
  (add a site, connect its first source, see the first number) — and no tile,
  list or table around it, because a zero claims something was measured.
- **Every quantity on the page carries the shape that makes it legible at a
  glance** (doc 14's rule): each answers something the figure cannot
  (direction, share, shape, or which is worst); nothing added is decoration.

## Settings page

`/settings` is **one place to
change anything that applies to the whole portfolio.**

Six sections,
General first, each with an anchor id that selects it — only the selected
section renders — and a left section list on `lg` that reads
as the page's outline. **General** holds the time zone, the monthly data cap
and the value of your time, and `#clock` and `#budget` land on it. **Task projects** is listed
once a task source is connected or a project is saved. The rows below
describe each part:

| Section | Holds | What the eye reads first |
|---|---|---|
| **General → Time zone** (`#clock`) | the operator's timezone — the IANA zone every intraday chart is drawn in (`config/constants.json` `os_time_zone`) | what time it is in that zone right now, because two neighbouring zone names look equally plausible until you see the clock they produce |
| **TV dashboard** (`#tv-dashboard`) | the door to the layout editor (`/wall/edit`), and the countdown the wall display shows — emoji, label, target | the **Edit layout** button, then the countdown widget itself. With none configured the block offers **Set a countdown** — the countdown is optional — and the SECTION always renders, because every install has a TV layout whether or not it counts down to anything |
| **General → Budget** (`#budget`) | monthly data cap, the value of your time; what happens at the cap is a **Stops at the budget** chip beside the meter | a meter of month-to-date data spend against the cap. **Every cap here has a meter**: the OS makes no model calls of its own, so there is no inference cap to state |
| **Alert rules** (`#alert-rules`) | anomaly sensitivity, minimum daily volume to test, low-volume window | sensitivity against the conventional 0.05 ceiling; the window as its share of a week |
| **Data collection** (`#data-collection`) | the schedules of the collections no connection feeds (nightly reports, live counters, local research — a connection-fed collection's schedule is on that connection's Manage panel on Integrations), the declared cadence knobs — the panel history window and the panel freshness bar — and every pull endpoint | the window in weeks and its cost per pass; the freshness bar as a meter **inside** the window, which is the one thing that number cannot say alone. An enabled/paused chip per pull lane |
| **Ownership** (`#entities`) | the legal entities that own sites (`config/entities.json`) — slug, name, form, jurisdiction | *Sites by owner*: each entity's sites as favicons, and the sites nobody owns under a **No owner** chip, each linking to its Identity card |
| **Task projects** (`#task-hub`) | the project map — site, task prefix, database — **editable**, plus the read-only connection; a deployed build shows the map as a read-only list | the site's favicon beside its row; after an Add, the steps the file cannot do |

**Saves go through the write lane, and what is editable is what the lane
licenses — never a taste decision.** The timezone, the countdown, the caps and
the rules are ordinary fields because `config/constants.json` and
`config/tower.json` are wholesale-editable.

**Two more sections save** through a permission narrower than that allowlist:

- The **task-hub project map** is a declared *register*,
  which licenses rows being added, removed and edited at one container and
  nothing else in its file.
- The **cadence** numbers are **declared knobs** — one exact
  pointer each (`config/signal-panels.json` `/refresh/windowDays` and
  `/refresh/freshnessMaxAgeDays`), carrying the same field rule a register column
  carries. How often the counter cards are read is the counters job's schedule,
  not a knob. Everything else in both files is still refused, and the refusal names
  the pointers that would have worked. Each field shows **what changing it
  costs** beside itself as values — a wider panel window buys more history for
  $0.00 a pass, because a refresh pass makes zero provider calls. The page
  offers the two panel knobs; the counters interval is not on it. A cadence an
  operator can move without being told the price is a trap, not a setting.

What is still read-only, and why: the **pull registry** (an endpoint is edited on
its own asset's page, where the rest of that asset's wiring is) and the task
hub's **connection** (its port lives in three files that must agree). Every
other field saves to the store in any deployment; only where the store
cannot take a write (unseeded, or without the config tables) do the fields
lock, and the page says so once (`SavesPaused`).

**A row is not always the whole job, and Task hub says so.** Mapping a project in
`config/beads.json` does not create the database its tasks live in or point the
repo at the hub, so the section answers an Add with the remaining operator steps
from [`config/beads.README.md`](../config/beads.README.md) as four steps — the
`bd init` command filled in with the project just added, the
`.beads/config.yaml` fix, the freeze register, and the entry that links the
checkout in the installation's `task-host.json` — each as text to copy,
labelled with where it goes. The runner re-reads the map **every tick** (one
minute), so a new project reaches the Tasks board without restarting `os:up`, and
reads as unreadable until those steps are done. The **hub connection** is shown
read-only, as a lock and its value, and it crosses into the browser only while
`vite` is serving, compiled out of a deployed bundle exactly like the runner lane.

`GET /api/settings` is a **pure builder over the resolved config** — each
stored document, or the compiled copy where none is stored
(`apps/tower/worker/config-source.ts`) — and both of its store reads are total:
the page an operator opens to fix something must not be able to go blank
because the database is empty or unreachable. Its budget and alert-rule
rows come from the same builders the asset page uses, so the two surfaces cannot
disagree about what `alpha` is called or which file owns it.

## The Wall (TV mode)

**What the Wall shows is [doc 14](14-design.md)**: a slim strip, the month's
revenue beside Needs you, one row per site and a live feed. The sections below
keep the route, refresh, layout document and editor mechanics; doc 14 owns what
is on the screen.

**One payload, two renderings, two routes.** `/wall` is the TV: full-screen,
auto-refreshing from one no-cache payload every 60s and its feed
(`/api/wall/feed`) every 30s, beside the GA4 realtime, calendar and connection
reads, read-only, dark, and — with
one exception — free of interaction. The exception is the
**Home** link: a browser that lands on `/wall` otherwise has no way out of it.
It is the strip's brand, and there is no header row above the strip.
It is the route's only link and only control. The desk is
where implemented evidence drill-downs (principle 1) live; the TV never needs a
mouse. A failed poll keeps the **last-good values** (never blank, never a
spinner) and the strip says how old they are — the only time the Wall states
its payload's age.

The TV rendering is its own frame: doc 14's budget (a 24/32 px page inset, 20 px
between stacked regions, 28 px between regions side by side) on tokens in
`index.css`. It does not shrink away dates, labels, alert meaning or state.

**The television says Tasks, like every other screen**:
`scripts/ui-lexicon.test.mjs` does not exempt the Wall, so the system's own
nouns cannot come back on any surface ([doc 14](14-design.md)). The Wall
draws no task strips at all; urgent tasks are Needs you's count.

**The setup checklist ring stays a desk element**:
its meaning lives in a hover a television has no pointer for, nobody sets up an
integration from the sofa, and a site with no report yet is one quiet row on the
Wall ("No data yet") — see [doc 14](14-design.md).

### The Wall draws a layout document

**Everything on the TV is a saved document, not this route's source.**
[Doc 14](14-design.md) says the operator arranges tiles from a fixed library
and never authors new tile types,
which is a component-registry PR ([doc 14](14-design.md)). The composition
is a `WallLayout`: rows top to bottom, each holding widgets with a weight
each, and one row taking the remaining screen height. A row may also hold a
**column** that stacks rows of its own, one level deep, so a widget can run the
full height beside several ([doc 14](14-design.md) § Regions).

- **The contract** is [`scripts/wall-layout.mts`](../scripts/wall-layout.mts),
  which [`apps/tower/shared/wall-layout.ts`](../apps/tower/shared/wall-layout.ts)
  re-exports with its types: the widget library (each type with its operator label, default and
  minimum width, whether only one may exist, whether it may hide when empty, and
  which settings it honours), the layout document, the one validator for "can the
  Wall draw this", the non-blocking warnings, and the version history a Save and
  a Revert produce. It is shared by three parties — the renderer, the editor, and
  the write lane — so none of them holds a second opinion.
- **Where it lives**: `config/tower.json` at pointer `/wall`, as the current
  layout plus the versions it replaced, newest first, capped at twenty. It is
  read into the polled payload by `parseWallConfig`, exactly as the countdown is
  read, so a Wall on another device converges within 60 seconds. The document
  lives in the store; the shape is the same.
- **The default** is `DEFAULT_WALL_LAYOUT`, the arrangement in
  [doc 14](14-design.md) § Regions: the strip, then a
  column — revenue beside Needs you, the site rows under them — beside the
  full-height feed. **A fresh install's `/wall` is `null`, or absent** — both
  mean "nothing saved; draw the default" — so the default has exactly one
  representation and it is in the code rather than restated in the file. `/wall`
  is a declared document, so the write lane reads a stored `null` as absent and
  the first Save creates the key
  ([`config/tower.README.md`](../config/tower.README.md)).
  `apps/tower/test/wall-canvas.test.tsx` pins the default's
  rows, weights and regions.
- **The library is five widgets** — strip, revenue, Needs you, sites, feed.
  Seven older types (alerts, portfolio net, System, clock, meetings,
  countdown, the asset cards) are **retired types**: a saved layout that names
  one is still read — never
  refused, never blank — as the default, the editor says so in one warning
  chip, and its Save is guarded by the value as saved (`WallConfig.retired`,
  which is read-side only and refused at every write door). A fresh layout
  naming a retired type is refused like any undrawable one.
- **Widths are weights, not columns.** A row's widgets share its width in
  proportion to their `width` — the `fr` a CSS grid track takes — with a floor
  (`minWidthRem`) below which that widget's content clips. The Wall is fitted to
  one 1920×1080 screen (`pnpm wall:fit`), and its rows were tuned in fractions.
- **A widget with nothing to show renders nothing and yields its track**, the
  countdown/meetings rule applied to every widget the library
  marks that way; a row whose every widget is hiding draws nothing at all. The
  five each draw their own empty state (doc 14 § Regions), so none is marked
  today; the rule stays for the next widget that needs it.
- **The renderer is `WallCanvas`, and the editor's preview is the same
  component** — a preview drawn by a second renderer is a preview that can lie.
  Selection and drag chrome reach it through one render-prop slot; `/wall`
  passes none and imports nothing about editing, because edit mode is never on
  the television.
- **A layout the Wall could not draw is refused before it is written, at every
  door.** The contract's validator runs inside the shared changeset pipeline
  (`scripts/wall-layout.mjs`, called by `scripts/config-documents.mjs`), so the
  dev write lane, `PUT /api/config`, the ingest's `applyConfigOps` and
  `pnpm config:apply` all refuse with the validator's own sentence — the same
  words the editor prints under Save — and `parseDashboardConfig` fails
  `vite build` on a compiled `config/tower.json` it cannot parse, while a stored
  document it cannot parse falls back to the compiled copy.
  The layout is written whole, at `/wall` or `/wall/layout`: a row or a width
  lifted out of its document cannot be judged on its own.
- **It is composed at `/wall/edit`**: a **desk** page inside
  the shell, reached from `/settings` → TV dashboard and from the command
  palette, and never from the television. It previews `WallCanvas` at 1920×1080
  scaled to the pane, saves through the ordinary settings write path with
  an optional one-line version note, and keeps the versions it replaced with a Revert
  per entry. The preview is a **query container**, so the
  type ramp and every widget's breakpoints read the 1920 box rather than the
  desk's window and the arrangement on screen is the television's at any width;
  `pnpm wall:fit` remains the check that measures the real screen, which is the
  only thing that can see a font the kiosk failed to load.

## Alerts page

**Two views, and the view is the URL.** `/alerts` is **Open** and
`/alerts/history` is **History**, on the same `Tabs` contract the asset page's
tabs keep — so a view can be bookmarked, pasted into a task, and reached
with Back. A segment nobody built lands on Open *and corrects the URL to say so*,
because the tab bar matches on the path and a page that rendered Open under a bar
with nothing selected would be lying about where the operator is. A tab link
carries the site and severity filters the other view can honour
(`carriedFilters`), so the narrowing survives the switch; `kind` and History's
page stay behind.

### Open

`/alerts` is every open error and warning in one `ListPanel`, one row per
condition that opens in place to its Evidence and its actions (`FlagActions`,
File task, the way to its site), plus three filters: site (with two or more
sites), severity and kind. **The filter state lives in the URL**
(`useSearchParams`), so a filtered view is a link that can be bookmarked, pasted
into a task, or reached from an asset page. They are native `<select>`s in the
desk's existing input chrome — three enum pickers do not justify a component
(doc 14).

Above both tabs, a strip of **tiles** counts the whole portfolio whatever the
filters say — open, errors, warnings, opened this week, median age, settled
this week — and the list says what is on screen (*"3 of 8 open"*) only when a
filter narrows it. The **errors** and **warnings** tiles are a different fact
from the total and the one that decides
whether the list is read now: nine open is a shrug when it is nine warnings and
an emergency when it is nine errors. Each row keeps its own severity and its
recurrence — except the cross-asset group row, which expands to one
actionable sub-row per
asset and carries no recurrence at all. A filtered blank says
*"No open alerts match these filters"* and never the all-clear line: a dropdown
must not be able to report the portfolio healthy. With nothing open at all it
states the shared all-clear.

**A fourth action, on rule-driven rows only: Tune rule.** Mark read, Snooze and Resolve all say what the operator did with
this EVENT; Tune changes what would produce it. It opens a panel holding the
rule's three settings with a **30-day preview** above them — *"Would have fired
3 times in the last 30 days"*, plus the thirty days drawn in order with the
would-fire days marked and the days it really fired marked beneath, recomputing
as a value changes. The number is produced by `POST /api/alerts/backtest` → the
ingest `backtestRule` RPC, which re-runs `evaluatePulse` over the stored pulses
against the same four-matching-weekday baselines the nightly lane uses; it is
read-only and writes no flag, no disposition and no config. Rows whose rule a
pulse replay cannot honestly serve — `ingest-freshness`, `asset-declared`, the
watch-window verdicts — get **no trigger at all**, because a preview for them
could only be invented.

The settings in that panel are the same portfolio-wide ones `/settings#alert-rules`
owns, written through the same write lane, and **the panel says so first**, with
one *Applies to every site* chip above the fields. That is deliberate rather than
a reversal of the per-asset editor removed below: the editor still lives where
the scope is obvious, and what the alert row adds is the one thing that page
cannot have — an asset in front of it to replay against.

### Snoozed — what the operator put off, and until when

Below the list, and absent entirely when nothing is parked, `/alerts` carries a
**Snoozed (N)** section: one row per snoozed condition with its asset, its
translated headline, the date it comes back as glyph + countdown, and an
**Unsnooze** that ends the wait now. It exists because a snooze that produced no
visible row would be a mute with a friendlier name.

It is deliberately **below** the open list and never merged into it — a parked
row is not asking for anything yet, and one list holding both would put the
count the operator reads first out of reach — and it **ignores the three
filters above**, which narrow what needs attention now, where this is the
standing ledger of what was silenced. A ledger a dropdown can shorten is a
ledger that can hide the row it was set to hide.

Its scope is **wider than the open list's**: the
list above shows error and warning, because that is what the portfolio owes an
answer about, but **Snooze is offered on every open row of the asset page's
Alerts tab** — info and milestone included — so the ledger lists **every parked
row**: an info row parked there is findable in a portfolio list, not only in
that one asset's alert history. Nothing about the portfolio's
**counts** widens with it: `attention`, each site's open error/warn tallies
and their worst severity all keep the error/warn scope
`worker/wall-payload.ts` applies. This is a ledger, not a queue, and it stays short
by construction — it holds only what somebody chose to park.

A snoozed row belongs to **Open**, not History: nobody decided anything about
the condition, they deferred it, and the store agrees — the three alert states,
open, snoozed and settled, are defined once in
`packages/contract/src/flag-open.ts`, and a snooze hands the same row back on
its date. Filing it under History would be the page claiming a decision the
operator has not made. It enters History only when it settles — resolved or
marked read — and until then "Settled · 7d" does not count it.

### History

**An alerts page without history is half of what the noun means** in every
comparable product.

`/alerts/history` is every **settled** alert — resolved or acknowledged, never a
snooze that is still running — across the portfolio, newest close first. It is ordered by *when each row closed*, not
when it fired: a condition that ran for six weeks and closed yesterday belongs at
the top of a list about what settled. Rows are **one per firing** and each stands
for itself; the grouping the open list applies is for live conditions, and two
rows the operator dispositioned on different days are two decisions the audit
trail must show separately.

It reads its own narrow `GET /api/alerts/history` rather than a slice of
`/api/wall`, because the wall payload is what a television polls every sixty
seconds and a paged archive has no business riding along with it. **Paging is
offset + limit and it states a total** — `26–27 of 60 settled`, once, with Newer
and Older carrying direction and no numbers of their own. A cursor would be the
better shape for an append-only log, but this list is ordered by a column the
operator's own clicks write, so there is no stable frontier a cursor could name
honestly; and a reader paging an archive needs to know where they are in it. The
asset and severity filters live in the URL exactly as Open's do, and changing one
returns to the first page, because page four of a list that no longer exists is
not page four of anything. A **page param the read cannot make sense of is
refused**, not defaulted: a corrupted `?offset=` that quietly
answered page one was indistinguishable from a link that worked, so an operator
who shared "page 4" and got page 1 back had nothing to notice. The refusal is
`400` carrying the size of the archive, and the page renders it the way
`/financials` renders a month the ledger cannot answer — the value quoted back,
what does exist stated, and the way out offered. A filter it cannot read is
still dropped rather than refused: a widened list shows its own mistake. Severity here offers **Info** as well, which the open
list never can: a milestone is an event, always info-severity, and it settles
like anything else.

Every row is the **same component the asset page draws** (`AlertRow`, moved into
the registry when this became its second surface), so a settled alert cannot say
one thing here and another on its asset's Alerts tab. It adds the two facts a
portfolio surface owes and an asset page does not:

- **which asset**, as that asset's own favicon plus a link into its Alerts tab;
- **how long it stayed open**, as a rule between a filled dot and a hollow one
  whose length is the duration, log-scaled from an hour to a month, with the
  duration in words beside it. "Fired 9d ago" and "resolved 2d ago" are both
  recencies; the question a list of closed alerts raises is *which of these
  dragged on*, and doing that subtraction per row is exactly the arithmetic doc
  14's visuals rule says a shape should do instead. The ink is
  neutral — severity owns the row's only color, and a long-running warning is not
  a more severe warning — and a row with no closing time recorded draws no rule
  at all, because unmeasurable is not instant.

The view is **read-only**. Settled rows carry no Mark read / Resolve pair: there
is nothing left to act on, and disposition stays where it has always been, on
`PATCH /api/flags/:id` from the Open view and the asset page. A filtered blank
says *"No settled alerts match these filters"* and an empty archive says *"No
settled alerts yet"* — the same rule Open follows, for the same reason.

## Financials page

**Asset financial ownership.**
`/assets/:id/financials` owns that asset's saved daily ad revenue and monthly
accounting. Its 7/28/90-day selector applies to daily earnings; monthly booked
net, separate forecasts and the entry audit remain independent of that range.
Daily bars use current saved Mediavine revisions and preserve calendar gaps;
missing dates never become zero. Exact amounts are available by pointer,
keyboard and the date table. Overview retains its brief financial snapshot
and links here. Activity owns event history; its former ledger lives on
Financials. Existing `#pnl` and `#ledger` links select the financial tab.

`/financials` is the portfolio's accounting for an operator **reading** rather
than glancing: the month-by-month trajectory, the per-asset split, where each
cost figure came from, the domain schedule behind the summed `infra` rows, and
what the page knows it does not know. It is two-tier by construction — asset nets
carry DIRECT cost only and portfolio overhead is subtracted once, visibly, on
asset #0's own line — and it opens on the latest month that holds rows, with the
month in the URL (`?period=YYYY-MM`) so a figure being checked against a receipt
is a link somebody can send.

**Financial responsibilities.**

| Surface | Operator question | Financial content |
|---|---|---|
| Wall revenue and site rows | What happened yesterday? | The month's revenue with its projection and yesterday's saved ad revenue estimate or its missing-report state (`RevenueHero`); each site's month so far → pace when supported |
| Asset Overview | How is this asset doing? | A brief monthly financial snapshot linked to its Financials tab |
| Asset Financials | What is this asset earning and costing? | Daily ad revenue, reported-day average, monthly booked net, separate estimates and entry audit |
| Portfolio Financials | Where is the startup making and spending money? | Selected-month revenue/cost/net and reconciliation, daily revenue across reporting sources, asset contributions, shared overhead, monthly history and cost configuration |

Portfolio daily bars follow the selected month and stop at the last completed
reporting day. The source list names the chart's coverage; other revenue sources
remain in monthly accounting. Solid bars mean every source in that coverage set
reported; outlined bars are observed subtotals with missing assets named in the
readout and data table. A missing date has no bar, and a reported zero retains a
zero mark. Incomplete asset coverage withholds the average rather than presenting
an artificially low daily average. Coverage is against currently mapped sources
and assets with reports in the selected month; it is not a historical connection
uptime claim. Provider revisions are read from `mediavine_current_daily` without
changing stored history.

Monthly summaries remain above the daily chart; asset contribution rows link to
their own Financials tabs. The monthly revenue/cost/net trajectory and ledger
table share the **Month by month** disclosure. Cost provenance and configuration
stay on Portfolio Financials. Monthly subscriptions and shared overhead are
never spread into invented daily costs or profit.

**It edits its own inputs.** A collapsed
**Declared costs** panel below *Where the cost comes from* holds the two config files
the cost half of the ledger is built from — the subscriptions nobody meters
([`config/recurring-costs.json`](../config/recurring-costs.README.md), the
*Stated* rows) and the domain orders being amortized
([`config/domain-costs.json`](../config/domain-costs.README.md), the *Amortized*
ones) — as two `CollectionEditor` tables. Adding, changing and removing a row
goes through the same validated write lane a settings knob uses: one changeset
per action, its exact inverse behind the Undo said under the cell (a removed
row's Undo rides the toast), and the financials
read invalidated after the save so the month totals and the period picker's
months recompute without a reload. A row the schema refuses (a month that is not
`YYYY-MM`, a negative amount, an `asset` that is not an asset id, an `id`
already in the list) is refused **in the browser, beside the field**, and never
becomes a request. Where the store cannot take a write both tables lock and the
page states the reason **once** (`SavesPaused`).

It **replaced the read-only *Domain schedule* card** rather than joining it:
that card listed the same five stored fields the register now holds, and doc 14
allows one representation per fact. What it had that a register does not — the
amortization — is stated once for the whole list in the domain table's own
subtitle (orders, cash paid, how many are still spreading into the shown month)
and once per site in the **Declared, by site** strip: each site's favicon,
what the two files say should book for it this month, and a share bar. That
strip is deliberately *not* the *Direct cost* column above it — that is what the
ledger booked, this is what the files say should book, and they differ whenever
`cost-import` has not run yet, which is the first thing to check when a figure
looks low.

The rows cross the payload **verbatim and in file order** (`recurringCosts`,
`domainOrders` on `/api/financials`), because a collection editor addresses an
array row by its index: a convenience sort would point a Save at a different
subscription. Past eight rows the editor filters and sorts a table itself, and
each row keeps its index in the file (`NARROWS_FROM`).

## Integrations page

`/integrations` is where a provider gets **connected**, and it is its own page.
It and `/health` answer different questions and both keep
their address: **Health** answers *is everything working*, from collector
evidence, per asset × lane; **Integrations** answers *what am I connected with,
and can I connect something*, from the credential store, per account.

One row per provider, grouped (Traffic & search, Revenue, Coordination, then
Tasks), each
with its logo, its name, **one status** and one action — Connect, Reconnect or
Manage. The status is one of `CONNECTION_LABELS`
(`apps/tower/shared/connection-status.ts`): Not connected · Not checked · Key
accepted · Collecting · Working · Overdue · Failing · Not using · Unknown, a
glyph-led chip in integration connectivity's tones ([doc 14](14-design.md)).
A provider's own page (`?provider=<id>`) carries:

- **One verdict**: whether it last worked and when — the probe the operator just
  ran, else the stored error while it is failing, else the stored last success.
  A `Test connection` runs one real authenticated call and answers with a glyph,
  a sentence and a time ([doc 14](14-design.md): validation comes from a
  collector attempt, never from a manual health toggle).
- **Which sites use it** (*Used by N sites*), as their own favicons, each
  linking to that site's Sources tab.
- **A Connect form built from the provider's field schema**
  (`packages/contract`, re-exported by the Tower rather than mirrored), so a
  provider or a field added there gets its input for free: a
  password is masked, a service-account JSON is pasted or uploaded, feed URLs are
  one per line. **No value is ever echoed back** — the API returns field names
  and timestamps only, so a stored field reads *set* and Reconnect opens empty
  inputs, because a pre-filled password field is a claim that the browser knows
  the password.
- **Disconnect behind one inline confirmation** (`ConnectionActions`) that
  names what stops — the sites, then what is deleted — and whose button names
  the provider. It is the one confirm
  on a page whose other write follows undo-over-confirm: there is nothing
  to undo a deleted plaintext back to, and it silently stops every lane the
  credential powers, which is what the confirmation names before it asks.

**This surface is never read-only.** Every
write here is a **store** write, so it behaves identically in a deployed Worker
and on the operator's Mac: there is no 501 path and no "this deployment cannot
save" sentence for a credential.

**Three bootstrap states can stop Connect** (`CredentialBlocker` in
`packages/contract`), and any can be outstanding alone:
the `credentials` table has to exist (the migration is operator-applied — DB
migrations are a forever-forbidden surface, AGENTS.md — so a checkout that has
pulled this feature has the code and not the table), and `CREDENTIALS_KEY` has
to be set and usable. The page states each **once at the top**, in the order they have to
be cleared, each with the OS's own sentence carrying its exact command — a fact
about the deployment belongs above the cards, not repeated on each of them.
Being told about one of them at a time would be two trips.

The rest of the page still renders underneath: a provider reading its credential
from the environment file is working, and says so. **Disconnect stays live even
then**, since forgetting a credential nobody can read any more is exactly when
you need to.

One more designed state, easy to miss. A provider that connects in the panel
shows the details to the provider first and stores them only once accepted,
stamped **Key accepted** (`workers/ingest/src/credential-connect.ts`); any other
provider's credential stored a second ago reads
**not tested yet**, because a save resets what the store knows about outcomes —
what the old key proved says nothing about the new one. That is a hollow ring
and a sentence with the Test button beside it, never an empty slot.

## The Queue (desk mode) — planned improvements

The Decide output as a ranked, reviewable table. This is where the operator
**overrides the machine**, cheaply and legibly.

- **Columns:** rank · asset · change-class · title · predicted Δ$/mo ·
  P(success) · fully-loaded cost · score · measurability tier · autonomy tier ·
  status.
- **Row expander — "why this rank":** the full hypothesis card: scoring inputs,
  causal path to a ledger family, kill criterion, **the data it cites**
  (integration sources per [doc 11](11-integrations.md)) — explainability is
  what makes overriding an informed act rather than a veto of a black box.
- **Operator actions (single-key):** `a` approve · `b` boost (pin above the
  fold; recorded with reason) · `v` veto (reason required — vetoes are prime
  Learn signal: the policy predicted value the operator rejected) · `e` edit
  card (until it ships: its change entry then freezes the prediction) ·
  `p` park (auto-surfaces at its kill date). Bulk select. Filter by
  asset/class/tier.
- **Explore sleeve is visually distinct** (its 15% has different rules; the
  operator should see which bets are deliberate speculation).
- Approvals honor the autonomy ladder: T1 approval dispatches a build; T2+
  classes flow through without stopping here — the queue still *shows* them,
  pre-ship, with a hold button (a hold is an override, recorded).

## The Tasks page (desk mode)

`/tasks`, in the sidebar as **Tasks** once a task source is connected.
`/work` is an older address and redirects here: the Tower emitted that link
into notes and commit messages, and a 404 on a path that used to answer is
worse than two paths for one page.

The one place that answers *"what is in flight across the portfolio, right
now?"* ([`config/beads.README.md`](../config/beads.README.md)) — and the
place the operator ANSWERS it from rather than reads it and opens a terminal.
The word on the page is **task** ([doc 14](14-design.md)): `bd` keeps its own
noun in the CLI and the ids, where it names the tool's object rather than
ours.

**What it reads.** The newest row of `beads_snapshots`
([`noticeos.beads_snapshots`](../db/postgres/migrations/0001_baseline.sql)),
plus its daily rollup (`beads_daily_counts`). The Tower cannot reach the task hub — the hub speaks MySQL
and lives on the operator's Mac — so the local runner
([`scripts/os-up.mjs`](../scripts/os-up.mjs)) shells `bd` once a minute per
spoke and POSTs what it saw to `POST /api/beads-snapshot`. Only the **latest**
snapshot is rendered: the table keeps two days
(`BEADS_SNAPSHOT_RETENTION_DAYS`) for the Wall's feed, but falling back to an older row would hide exactly the
failure the age chip exists to reveal.

**Layout** (`apps/tower/src/routes/tasks/TasksBoard.tsx`): the filter row, a
KPI strip, Waiting on you, then every other task in one table, each row
expanding in place. A project the poller could not read is named in one banner
with Retry; before any snapshot the page leads to Connect.

**A local task lane, and it is the operator's.** An agent still claims and closes with `bd`, in the repo where
the work is, because that is where it has the context to be honest about it.
The operator does not need a second tool for the most frequent action in the
product. The hub is a Dolt
(MySQL) server on the local host that a Worker cannot reach, but
the `os:up` Vite process can: `apps/tower/vite/task-lane.ts` serves
`/api/tasks/*` and `/api/gates/*` by running `bd` inside the repository the
saved task projects name, joined to the installation's `task-host.json`
(`scripts/task-project-config.mts`) — the same projects the poller reads.

Three guards, all load-bearing. **Same origin**, the shared boundary the config
lane uses (`apps/tower/vite/lane.ts`) — there is no authentication on the LAN
Tower and none is being added, so what must be impossible is another site
steering this browser into a write here. **An allowlist of twelve verbs** —
five reads (`list`, `ready`, `show`, `comments`, `epic status`) and seven writes
(`create`, `update` incl. `--claim` and `--defer`, `close -r`, `comments add`,
`human respond`, `human dismiss`, `gate resolve`) — checked *before* anything is
spawned, so `bd delete`, `bd sql`, `bd import` and the rest are not commands
this lane can be talked into. And **`--actor` on every write**, set to this
checkout's own `git user.name`, so the hub's interaction log says the operator
did it rather than guessing. `bd`'s stderr comes back verbatim in `detail`; a
non-zero exit is a `502 bd_failed`, never a silent nothing.

**A deployed build keeps the snapshot board, and says why.** `apply: "serve"`
compiles the lane out of every build by construction, so there is nothing to
guard there: the Worker answers `GET /api/tasks/capabilities` with
`{live: false}` plus the reason, and `501 read_only_deployment` on every other
task path (`apps/tower/worker/tasks-route.ts`). The `/api/work` snapshot still
renders everywhere — the board degrades to what it always was rather than
breaking.

**The board is a board you can act on.**

- **The inbox leads the page, across every project.** Waiting on you sits at
  the top, because those rows are the only ones on
  this board the OS physically cannot move. Ordering is gate, then
  priority, then longest untouched, in the warn register. An ask's verbs are
  **Answer**, which opens a box under the row and runs `bd human
  respond`, writing the answer as a comment and closing the ask — so an empty
  answer is never sent — and **Dismiss** (`bd human dismiss`, a permanent
  decline). A gate's verb is neither: it is **Approve** (`bd gate resolve`),
  because releasing a wait condition is not answering a question. All three
  land after an Undo window (`lib/answer-queue.ts`).
- **Five filters, and every one of them is the URL** —
  `?project=&status=&priority=&label=&assignee=` (`useSearchParams`, the
  mechanism `/alerts` established and `/assets` extended), so a narrowed board is
  a link that can be bookmarked or pasted into a task. Project, status, priority
  and assignee are `<select>`s with a count per option; label is free text. On
  the snapshot read the label field is not drawn (unless a link already set
  it) — the poller does not carry labels, and a field that can never match is
  not a filter.
- **Every row leads with one mark** (✓ closed, ◦ parked or normal, ! for top or
  high priority in its tone) and **expands in place**: Claim (`bd update
  --claim`, atomic), Close (an inline REQUIRED reason —
  completion is evidence and the closer cites what proves it), Defer (a date);
  its id links to `/tasks/:id`. The actions open in the row rather than a
  dialog: every one of
  these is a sentence about the row the operator is looking at, and a modal would
  hide it. These writes are not Tower-local, so [doc 14](14-design.md)'s
  undo-over-confirm does not apply — principle 1 does, and the inline field IS
  the "show, then ask".
- **A status `bd` invented renders** as its own raw value. The board must never
  map an unknown status onto one it is not.
- **Live rows come from the lane, one read per project**, in
  `config/beads.json` order — untruncated, with labels, blocker-aware `ready`,
  and gate metadata. Epic containers are excluded from the rows and the counts,
  which is the same exclusion the poller makes, so the two reads cannot disagree
  about a number. A gate that resolves itself (timer, `gh:run`) appears nowhere.
- **Closed-this-week is always the snapshot's.** The lane can list closed tasks
  but not "closed in the last seven days" — `bd list --status closed` is all
  time — so the quiet momentum lane keeps reading the poller's bounded window in
  both modes. One fact, one source.

**`/tasks/:id` answers**, because the board links every row there and a link the
product itself emits must never 404. **New task** opens the composer (below)
on `?new=1`.

**One board, two surfaces.** The board is
`TasksBoard` (`apps/tower/src/routes/tasks/TasksBoard.tsx`), and an
asset page's **Tasks** tab — `/assets/:id/tasks`, between Alerts and Activity —
renders that same component with `project` pinned to that asset's spoke. Not a
second board: the asset tab is the index with one prop set, so a claim, a close,
an answered ask or a filter behaves identically on both, and neither can quietly
drift from the other. The tab drops only what the page around it already says —
the project `<select>`, the project clause in the summary line, the project name
on each inbox row, and the section's own name heading (the task PREFIX stays,
because a header cannot give it and it is the half of an id the operator types).
The pinned project never enters the query string: it is the page, not a control,
so a link copied from the tab carries only the filters the operator actually set.
A site with no
task project gets a designed empty state, *No task project for this site*, with
**Add a task project** — "nothing to do" and "nobody ever mapped
this asset to a repo" are different facts, and only one of them is good news.
The tab LABEL carries the asset's open-task count, with the inbox glyph beside it
when something there is waiting on the operator; an asset with no spoke carries
no count at all, because unknown is not zero. **New task** is offered on the tab too, on the same `?new=1`: the
composer opens prefilled to that project and offered only that project's spoke,
so filing from an asset page cannot land the task somewhere the page is not.

**The task page.** `/tasks/:id` is the page every monospace task id in the
Tower points at — the finding's filing badge, the query and page decision
rows, the asset timeline's resolved refs, and the task index — because
`HandoffBeadBadge`'s id is a link. The page carries the task whole —
description and acceptance criteria
rendered as Markdown, labels, assignee, priority, defer date, parent epic with
its `Meter` of children closed, blocked-by and blocks with each dependency's own
status glyph, the comments oldest-first with a composer, and a compact activity
timeline (filed, claimed, commented, closed). Status and priority are the
header's glyph-led chips in the lifecycle vocabulary (`STATUS_FACE`) — open circle,
in-progress dot, blocked ban, parked snowflake, closed tick — and because that
chip is the page's one *display* of each fact, the editors below it are controls
with no second chip beside them (doc 14). Every field saves in place through the
lane with a toast carrying **Undo** (doc 14 principle 5, the same idiom as
`KnobEditor`); **Claim** and **Close** are the two primary actions and a close
carries its reason, because completion is evidence. A task filed from a Tower
handoff also links **back** to the section that raised it — `noticeos_kind` picks
the anchor (`#insights`, `#query-visibility`, `#page-decisions`) on
`noticeos_asset`'s page — so the `noticeos_*` grammar
([`config/beads.README.md`](../config/beads.README.md) §Handoff metadata) is
readable in both directions. Markdown is rendered by a small parser in the route
that emits React elements and never a string of HTML, so a `<script>` in a
task's description is text by construction and only `http(s)`, `mailto:` and
site-relative links are made at all; the Tower ships no Markdown dependency. A **deployed** build has no lane: the page renders the row
the once-a-minute snapshot holds, says the rest needs the lane, and shows Claim
and Close disabled with that reason.
**File a task with a button.** Every handoff the
Tower copies ends in a `bd create` command, and its last step — paste this into a
terminal standing in the right repo — is the one that fails: filing from the
wrong directory files against the wrong asset, silently and permanently.
`TaskComposer` is the operator's path to the *same* task. A **File task** sits
beside Copy Markdown on the executive findings, the query decisions, the page
decisions and the alert rows on `/alerts`, and it is what **New task**
on `/tasks` opens for work no finding raised. It opens a slide-over already
holding the title, project, priority, labels and metadata that command carries,
because both are rendered from one function (`taskHandoffPrefill`,
`apps/tower/src/lib/task-handoff.ts`); `test/task-composer.test.tsx` parses the
emitted command back apart and fails if they diverge. On the index the composer
is a URL state (`?new=1`, the mechanism every filter there already uses) and
inherits the **project filter** when one is set, so narrowing the board to an
asset and pressing New task does not ask again which asset it is. Filing lands
the operator on the task's own page, `/tasks/<id>`, through the toast.

Three things it deliberately does not do. It does **not** file on one click: the
judgment step between an observation and a commitment is the rule that keeps
`bd ready` meaning "work somebody chose" (`config/beads.README.md`
§"Observations are not commitments"), so the composer shows what it is about to
file and waits. It does **not** let the handoff labels or the `noticeos_*`
metadata be edited — they are the join the poller reads and the
`HandoffBeadBadge` renders, and a hand-corrected `key:` files a task that never
comes back to the row; the composer states what the metadata *means* instead
("Linked to a finding"). And it does **not** replace Copy Markdown, which is the
agent's path, carries the whole evidence brief rather than only the task, and is
the only path in a deployed build — where the button renders disabled carrying
the lane's own sentence rather than vanishing.

`/alerts` gains a fourth handoff kind, `alert`, keyed on `flags.id` rather than
the rule id: one rule fires many times on one asset, and only the flag id names
the firing on screen. Filing does not touch the flag's own lifecycle — *somebody
is working on it* and *the condition stopped* are different facts, so Mark read
and Resolve keep meaning exactly what they meant. A **grouped** never-reported
row offers no File task at all: it stands for several assets that
each have their own flag, so there is no single firing for `noticeos_key` to
name, and work on a portfolio-wide condition is one task the operator writes
rather than four the band guesses at.

**The badge for the `page` and `alert` kinds**: a filed `page` task shows on
its page decision row (`PageDecisions`). No alert row draws the badge for an
`alert` task yet.

Tasks remain **coordination state, not signals** ([doc 01](01-architecture.md),
[doc 06](06-operations.md)): nothing on this board enters the pulse envelope,
and a task's existence is never evidence about an asset.

**Task screens belong to a connected task source.** A new installation has no task source, and then no screen
shows a task surface: no Tasks in the sidebar or the palette, no Needs you tile
or Waiting on you on Home, no task count in the Wall's Needs you, no Tasks tab,
Needs you or File task on a site, no Tasks column or Open tasks on Assets. Tasks
reached by its address (or a site's Tasks tab, or a task page by link) is one
door, **Connect a task source**, to the **Tasks** group on Integrations, where
each source is a row with one status and one action like every provider. The
beads hub is the first source. Its Connect opens the connect panel over
Integrations: the site, its task prefix and database, and
Connect, which saves the project through the `task-hub-spokes` register — the
same audited write Settings → Task projects makes — and then shows the host
steps with Copy while the panel reads Collecting, and Working once the runner
has read the project. Once read, its Manage is Settings → Task projects, which
edits the saved rows.

*Connected is derived, never stored:* for beads, the runner's newest snapshot
read at least one task project. The runner reads the saved projects every
minute and files a snapshot only when the hub answered, and an installation
with no project files an empty one — so that one fact holds both "set up here"
and "answering". An installation whose projects are saved but not yet read
shows the row as Collecting and still no task screen.

*The seam* is `apps/tower/worker/task-source.ts`: each source answers the same
questions — is it connected, the board (`GET /api/work`), the Needs you counts
(the Wall payload's `operator`, `null` without a source), a site's inbox — from
one reading per request, and `GET /api/task-source` says which source every task
screen shows. The actions a source allows are the `/api/tasks/*` contract
(`shared/tasks.ts`), answered by the local beads lane or read-only elsewhere. A
later source (Linear, GitHub Issues) is an adapter there and a row on
Integrations; an installation connected to beads behaves exactly as it did.

## The Registry (desk mode) — shipped changes

Reverse-chronological ledger of everything landed, each row the full evidence
chain from [doc 05](05-execution-and-accountability.md):

- **Row:** shipped-at · asset · class · title · autonomy tier used · watch
  status (`watching n days left | cleared | reverted | frozen`) · predicted
  (as its change entry froze it at ship) vs realized (once an entry
  superseding it books one; interval, not point) · guard status.
- **Drill-down = the audit trail:** hypothesis card → build run (cost, model,
  tokens) → verifier evidence (re-executed checks, artifacts) → ship annotation
  → watch telemetry → attribution entry. The registry doubles as the random-
  audit UI — an audit is just a deep read of this page with fresh eyes.
- **Undo, per change, one click.** Every row has `Undo` for as long as its
  revert path is valid: confirmation + required reason → the Act machinery
  executes the revert (same rails as auto-rollback), annotates the timeline,
  books the ledger close-out, and feeds Learn (an operator undo is a strong
  negative label the calibration must eat). Rows whose revert window has
  degraded (subsequent changes stacked on top) say so explicitly and offer
  "revert via new change" instead — the UI never pretends undo is cleaner
  than it is.

## The Runbook library (desk mode)

Per [doc 05](05-execution-and-accountability.md): every runbook with its
version, **diff since last approved version**, permission manifest, per-run
track record (runs, escalations, failures), and one-click approve / revoke.
Reviewing here is what grants real-world capabilities (push/merge/spend) —
so this page is designed like a code review, not a settings toggle: the
operator sees exactly what they're authorizing before they authorize it.

## Adding an asset

**Add a site** — the Sites header, step 1 of Home's first-run card and the
sidebar — opens one question over the page: the domain (`/assets/new` is the
Sites page with it open). The name and icon are inferred, one optional press says the site has not
launched, and Add writes the asset row and then commits its config entries as a
single changeset, landing on the asset's Data sources.

The flow, its refusals, the write order and the designed failure states are
specified once, in [doc 14](14-design.md); the routes it writes through are
in [the Tower's README](../apps/tower/README.md).

## Asset detail (drill-down)

### The page is tabbed, and the tab is the URL

`/assets/:id` is **Overview**, and `/assets/:id/growth`, `/financials`,
`/search`, `/alerts`, `/tasks`, `/activity`, `/sources`, `/settings` are the
other eight (`apps/tower/src/routes/asset-detail/AssetTabs.tsx`; Tasks only once
a task source is connected). Above the bar, on every tab: the page header
(identity, source marks, the page-wide range). Below it, **only the active tab's
sections are mounted**, each tab reading its own view.

| Tab | What it holds |
|---|---|
| **Overview** | The data-setup banner with its ring while the asset is being set up, the lead numbers, the financial snapshot, open alerts, *What matters* (top three) and the asset's totals |
| **Growth** | Audience and search charts over the range, what else is collected, and product use |
| **Financials** | This asset's ledger and P&L |
| **Search** | The tracked-panel board, query decisions, page decisions and the search context |
| **Alerts** | Open alerts, those no longer current, and history |
| **Tasks** | The Tasks board pinned to this asset's project |
| **Activity** | The timeline with its event composer and outcome-check composer, the watches strip, link outreach — what happened on this asset |
| **Sources** | Data sources, the setup checklist, the scheduled lanes (asset #0), daily metrics, site health |
| **Settings** | Asset management — see below, including **Tracked search terms** |

**Why tabs**: question-shaped groupings (*"Where is growth moving?"*, *"What
happened before?"*, *"Can I trust the inputs?"*) are right, but one very long
scroll of collapsed disclosures under a sticky navigator never tells a
stranger where they are, and a deep link into a collapsed section has to open
it programmatically before it can scroll. "Trust" is not a heading.

**A tab states its own condition** (doc 14's visuals rule): Alerts
carries the open count beside a severity dot of the worst one, Activity the
number of outcome checks still running, Sources a severity dot for its worst
source (failing red, overdue amber) with the tally on hover. A tab
with nothing to say carries nothing.

### The Settings tab manages the tracked panels

A **Tracked search terms** card on the Settings tab edits the two documents
that decide what the panel *is*; the Search tab keeps the tracked-panel board
that reads the panel back:

- **Tracked queries** — the terms the weekly DataForSEO lane buys a live result
  page for ([`config/serp-panel.json`](../config/serp-panel.README.md)). Add,
  relabel with the bet the term measures, remove; one changeset each, with its
  Undo.
- **Panel refresh** — this asset's row on the standing refresh roster
  ([`config/signal-panels.json`](../config/signal-panels.README.md)): on or off,
  the reason, the note, the date.

Three things about it are decisions rather than details:

- **The spend is stated where the spend is decided.** A tracked term is not a
  setting — it is a standing weekly bill *and* a standing weekly review
  obligation — so above the Add control the section prints the panel's own weekly
  cost and its size against the query ceiling as a **meter**, and names the guard
  that already exists: the portfolio's monthly data cap on `/settings`, which the
  collector reserves against before every family and fails closed under. **No
  second guard was invented**, and the price is not a per-row column: every term
  costs the same two calls, so twenty-eight identical cells would be one fact
  rendered twenty-eight times (doc 14). The ceiling is refused in the form as
  well as by the collector, so a term over it cannot land in the file and fail
  the whole panel on the following Monday. The refresh roster carries no meter at
  all, because a refresh pass makes zero provider calls at any cadence.
- **An asset with no panel is a real state, and Add a site's silence is
  respected.** Adding a site deliberately writes nothing to
  `config/serp-panel.json` at creation; here, the first term filed creates the
  asset's whole entry, and removing the last term takes the entry away rather
  than leaving an empty list — which the collector refuses and which reads to a
  human as neither "buys a panel" nor "does not".
- **The roster row may be changed but not removed.** Membership there is an
  invariant — every asset has a row, including the ones that are off — so the row
  leaves with its asset, through the Settings tab's Delete, and the only Add this
  surface offers is the one that repairs a missing row.

### The setup checklist

An asset in `onboarding` or `baselining` carries **what is left
before it goes live** on its Sources tab: identity, its data sources (each lane with its own state
and, for a skipped one, its reason), the first nightly report, and the 28-day
baseline — or, for a site that has never sent a nightly report, the report as
one optional, uncounted step. Each row is a glyph, the current reading in
one sentence, and a link to
where the work is done — the Settings tab, the Sources tab, `/health` for the
baseline.

The same items are a small **ring** on the Overview's *Data setup* banner, with
**Review data setup** beside it: one arc per counted item, filled as items
resolve, with the whole sentence in its hover. Both readings come from one
function (`apps/tower/shared/asset-setup.ts`), and it returns nothing at all for
a live asset — which is how the ring and the panel disappear together rather
than by two surfaces each deciding for themselves.

The banner leads the Overview rather than sitting under *What matters now* on purpose:
findings are ranked out of evidence, and a fortnight-old asset has almost none,
so on exactly the assets this panel is for, the section beneath it is empty by
construction. Nothing here is tickable — every line is derived from the asset's
own state, and a box the operator could tick without doing the work would be the
one part of the page that can lie. The four items, the exit test they use, and
why the Wall does not draw the ring are specified in
[doc 14](14-design.md).

**Deep links keep working.** Every anchor the page has ever emitted —
`#setup`, `#insights`, `#growth-evidence`, `#performance`, `#query-visibility`,
`#page-decisions`, `#product-use`, `#alerts`, `#alert-history`, `#timeline`,
`#details`, `#integrations`, `#configuration` — maps to its tab: the hash
selects the tab (a `replace` navigation, so Back still leaves the page), then
scrolls to the section where one still carries it (`#alerts`, `#alert-history`
and `#details` only select their tab). A hash the page does not own is still left alone. The
outcome-check composer opened from a Growth row switches to Activity and seeds
itself there; the seed lives at the route, so it survives the switch.

### The Settings tab is asset management

Nine sections — the seven below, plus **Card totals** (`config/counters.json`)
and **Tracked search terms** (above) — each field saving in place through the
write lane with an Undo, and a stale write refused visibly:

- **Identity** — the **display name saves in place** (a store column, so it works
  in every deployment; the write invalidates the wall and asset-detail reads, so
  the sidebar, Home's assets table and this page's header follow without a
  reload). Domain and asset id are read-only and each says the ONE reason it
  cannot move: every stored observation was collected against that host, and the
  id is the key the store filed this asset's whole history under.
- **Lifecycle** — the stepper is the one display of the current stage; a
  *"Change stage…"* picker names a target and saves `assets.status` through the
  store lane, which works in every deployment.
- **Automation** — the `sense_only` toggle, where the selected segment carries
  the state's color and dot rather than a chip beside it.
- **Data collection** — the fetch endpoint and the nightly-fetch switch save
  the `pull.json` document to the store in any deployment; cadence is a
  link to `/settings#data-collection`, and wire format, auth source, last report
  and the metric map stay read-only with their owners.
- **Alert rules in force** — the thresholds this asset is judged against,
  **read-only**, with one line each pointing at `/settings#alert-rules` and
  `/settings#budget`, because every one of them is portfolio-wide. The values
  still belong here (doc 14); the editor belongs where the scope is obvious.
  **This tab has no editor**, and Tune rule on the alerts above does not
  change that. The distinction
  is evidence, not location: an always-on set of fields under one asset's page
  invites a portfolio-wide edit while looking like an asset setting, whereas Tune
  is opened deliberately from one firing, leads with the portfolio scope, and
  exists to show what a change would have done — which is the reason to touch
  these values at all, and the one thing neither this tab nor `/settings` can
  say.
- **Archive** — the one action that leaves the Tower, so it follows doc 14
  principle 1 rather than principle 5: an inline confirmation names what stops as
  glyph rows (data collection, alerts, its card on Home and the TV dashboard)
  *before* it moves `assets.status` to `retired`. A retired asset shows
  **Restore** in its place, returning it to the stage it left.
- **A stage move is an event on the asset**.
  `assets.status` records where an asset IS and not where it had
  been. Every write that
  moves the stage (Archive, Restore, each *Change stage…* pick, and the Undo in
  their toast) also writes an **annotation**: `kind: config`, and a `ref` of
  `lifecycle:<from>><to>` which is both the machine-readable record and part of
  the row's `(asset, at, kind, ref)` identity. Restore READS the most recent
  recorded move into `retired` and offers **Restore to** the stage it came from,
  beside an *Archived (date)* chip. **No new column and no new annotation kind**, because both
  would be a migration and migrations are operator-only (AGENTS.md); `config` is
  the closest honest existing member — a stage is a stored setting on the asset,
  edited from this tab under the `db · assets row` owner. An asset with no
  recorded move gets a stage picker (Live first) beside **Restore** and a *No
  recorded stage* chip. The Activity tab gets the moves for free, rendered as the sentence
  *"Stage moved from Baselining to Retired"* rather than the ref (doc 14).
- **No Delete** — a site is never deleted, a mistaken add included: the store
  is history, and the Postgres model gives the application no DELETE on a site
  ([`db/postgres/README.md`](../db/postgres/README.md)). Archive is the one
  way out. Adding the domain again answers *Already added* and opens the site
  that holds it — by the id the store names, which an imported site can hold
  under another id — at its Restore card (`#restore`) when it is archived.

The tabs are an executive asset dive, ordered by the
operator questions rather than by system wiring:

1. identity/health, with the same working/error/unconfigured source icons in
   the header row as the Sites table's State cell;
2. a stacked performance view over the page-wide range (7, 28 or 90 days, 28
   by default): GA4 daily active-user bars, then
   separate date-aligned Google/Bing web-search clicks and impressions.
   Sunday-start weekly bands remain aligned across all charts; the longer axis
   labels calendar months to avoid thirteen colliding week captions. A
   responsive query-decision table follows with one row per normalized query.
   Each row states whether to act, investigate, protect, or wait; names the
   concrete condition; keeps the source evidence visible; and proposes one
   bounded next step. A restrained row rail, surface, icon, and chip treatment
   separates observed loss (red), actionable opportunity (amber),
   investigation (info), protect/growth (positive), and wait (neutral).
   Every row can copy an agent-ready Markdown brief containing asset
   identity, the decision rationale, exact evidence and comparison windows,
   the suggested action, source names, and limitations. Google and Bing retain
   observed impressions,
   equal-window change, and average position; DataForSEO adds modelled
   monthly demand in the site's saved market (United States · English by
   default), current organic position, difficulty, and AI
   Overview citation evidence. A first DataForSEO snapshot is useful
   immediately; locally observed rank movement appears only after the same
   query/page pair exists in a second snapshot. The Search tab shows three
   decision rows, with additional queries and source
   limitations progressively disclosed.
   "Has this query been picked up?" is answered by the
   **task somebody filed from it**, not by the fact that the operator copied its
   Markdown. The row renders the same `HandoffBeadBadge` the
   finding card does — task id plus open/closed, muted, no state word — joined
   by the handoff's own `noticeos_key` through the task snapshot, so it appears
   within one poll cycle of the `bd create` actually being run. A filed row
   sorts *below* unfiled rows inside its own priority band and the
   fold prefers an unfiled example of a decision kind, so work nobody has picked
   up stays on top by construction. A row with no task renders **no filing
   marker at all**. `decisions` keeps just the display states it really owns,
   `marked` and `dismissed`.
   What the
   searcher wants and what the current rank is worth in visits are exactly the
   inputs an act-vs-wait judgement is made from. The intent renders as a
   short lowercase token beside the query — it qualifies the query, so it is
   deliberately not a second chip competing with the decision chip — and the
   visit estimate joins the market evidence line as modelled demand, never
   merged with observed impressions.
   Where an asset runs a tracked
   SERP panel ([doc 08 §S1b](08-seo-geo-signals.md)), the query table stops
   recommending copy work it knows will not be read. Two rules join the nine
   positional ones, and both are deliberately about *restraint*: a decision that
   would have said "sharpen the title" on a query whose AI Overview does not
   cite us moves from **act** to **investigate** — the click is consumed above
   the results, so a rewrite buys churn and no reach — and a query the overview
   *does* cite becomes **protect** whichever way its rank is moving, because the
   one reliable way to lose a citation is to rewrite the passage that earned it.
   A decline is not discarded on the way: it is stated inside the protect call.
   The evidence is a **✧** glyph beside the lane chip, in three weights — solid
   for cited, outline for shown-and-not-cited, ghosted for a page read with no
   overview on it. No severity color: an AI Overview is a fact about the result
   page, not an alert. The glyph is absent for a query nobody tracks, which is
   why the checked-and-clear case gets its own quiet mark rather than nothing —
   absence has to keep meaning *unknown*. Untracked queries, and queries whose
   overview failed to load, behave exactly as they did before the panel existed.
   Below the three headline charts, an
   **Also collected** row draws more of what the 15-minute collectors
   write: GA4 sessions, page views, and events, plus
   Search Console click rate and average position. Each is a label, a current
   value, and one neutral `Spark` — smaller than the charts above, because it is
   context for them rather than a fourth thing to read first. Average position
   is lower-is-better, so its direction chip states *improvement*, the same
   inversion the query table already applies: an up arrow means the same thing
   on every surface even where the underlying number fell, and the tile says so
   in words. A series with fewer than three observations is omitted rather than
   drawn as an empty tile;
3. **What matters now**: one responsive, color-coded decision list of deterministic
   warning signs, recommendations, discoveries, and product insights derived
   from the daily GA4/GSC/BWT and weekly DataForSEO archives. Every row answers
   priority/type, finding, meaning/next move, and proof/handoff. The DataForSEO
   context strip is the Search tab's **Search context**, led by traffic value.
   A finding whose
   handoff somebody actually filed shows that task — its id and whether it
   is still open — as a quiet muted marker in the proof/handoff cell, joined by
   the `noticeos_key` the handoff wrote into the task's metadata
   ([§Handoff metadata](../config/beads.README.md#handoff-metadata)) and read off the same
   once-a-minute `beads_snapshots` photograph the Tasks board uses. A
   closed task reads as **shipped, not proven** and never retires the finding —
   only a watch-window verdict does — and a finding with no task, or an asset
   the poller could not ask about, shows nothing at all;
4. active alert lifecycle, pulse metrics, booked P&L, the annotation
   timeline, and the watches registered against it;
5. full integration evidence;
6. **Settings**, the asset's own management tab (see above).

**Page decisions** ** is the query table's twin on the
grain an operator edits: one row per page present in both seven-date Search
Console windows, in the same act / investigate / protect / wait lanes, with the
same evidence-and-next-step columns and the same copyable `bd create` handoff.
It shares the query table's lane vocabulary and none of its rules — a page is
judged on movement in its own clicks, impressions, and average position — and it
applies the two tracked-panel rules through the page's leading query, so a page
whose largest query is walled by an AI Overview is demoted out of the copy-work
lane exactly as that query is. The page family carries no query dimension, so
its totals cannot be grounding-decontaminated; the lane states the exclusion it
applied to the leading-query join instead, labelled so nobody reads it as a
correction to the numbers above it. A page row carries the same filed-task badge
the query table does, joined on the page URL: `page` is a handoff kind in every
list that has to agree — the emitter, the poller, the ingest validator, and the
Tower's own reader — and a drift guard in `scripts/handoff-kinds.test.mjs`
fails the build when one of them falls behind (the fourth kind is `alert`).
Every anchor it
offers also accepts an inbound deep link, so a link mailed or pasted from
elsewhere lands on the named section rather than silently doing nothing. The
Data sources list's **Connect account** opens `/integrations`.

**Every lane card carries that asset's own half of the integration, editable in
place**. Under the verdict — which is the
doc-14 disclosure order, configuration below the answer — each card holds a
**Mapping** section (*Market* for DataForSEO), holding two things:

- **The mapping** — which GA4 property this asset is, which Search Console or
  Bing site, which DataForSEO location and language. Each field is validated by
  the `asset-lane` declaration before it is sent and again when it lands, so a
  pasted `properties/123456789` is refused *naming the field* rather than
  becoming next Monday's collector error. **The collectors read these
  fields**, and each card says which of the two sentences
  is true of THIS asset: a mapped lane says the collector asks for this value, an
  unmapped one names the source it still falls back to (the Google credential's
  own property map, the asset's own domain, the US/English DataForSEO baseline).
  Both say when a save gets there — the next collection run where the Workers
  read the stored document, the next restart while they read the copy compiled
  into them. A field whose consequence is
  overstated is worse than one with none.
- **The posture**, and only the two states an operator genuinely decides: *Not
  set up* and *Skipped*, offered as **Not using** (with its reason) and **Use
  again**. **The state chip above is untouched by it.** Working, Overdue
  and Failing are read from the latest collector run and Not applicable from
  the catalog's scope rule, so none is offered as a choice — this system has
  never had a health toggle and does not grow one here. A decline is refused
  until the reason is on record, which is `config/integrations.json`'s own
  invariant enforced before the write rather than caught after it.

**One action per row, and no checklist.** The row's status — the connection model's `laneStatus`
(`apps/tower/shared/connection-status.ts`) — is the proof, so the card carries
no setup checklist and no docs path, and its section is named for what it holds
(*Mapping*, or *Market* for DataForSEO). A row shows a status or exactly one
action: **Connect**, which for a provider that connects in the panel opens that
panel over the site's own page with the site first
(`apps/tower/src/routes/integrations/ProviderConnectPanel.tsx`, the same wiring
`/integrations` opens), or **Fix** on a failing source. DataForSEO's location
and language codes are one **Market** select, by name
(`apps/tower/shared/site-markets.ts`), both codes written in one save. The
Google picker's state beside its box is a short value — *Reading Google…*,
*Google did not answer*, *Google gave no list*, *No GA4 properties* — never a
sentence telling the operator to type.

**The two Google fields are a picker, not a text box.** The connected
account's own list —
`GET /api/integrations/google/properties`, one read shared by both cards — fills
them, showing each property's name, its account or permission level, and the
`ref` that actually gets stored, because the ref is what a collector error will
name. Picking writes the same `file-json-set` at the same pointer the box wrote,
with the same validation and the same Undo. **The box never goes away**: a
service-account install has no sign-in to ask, a property the account cannot see
is in no list, and a discovery that failed must cost the operator nothing — so a
lane whose list is missing says why in one line and stays typable, and a picker
that has a list keeps a *Not in the list? Type it instead* disclosure under it. A
value the file holds but the account does not list stays selected, labelled as
not being in the connected account, so opening the picker never quietly proposes
replacing it.

**The GA4 lane's card also carries what this asset has DECLARED about its GA4
property, editable in place**: the events it
calls **value events** ([`config/value-events.json`](../config/value-events.README.md))
and the event parameters already registered as **custom dimensions**
([`config/ga4-custom-dimensions.json`](../config/ga4-custom-dimensions.README.md)).
Both decide what the collectors do here — the first is what the nightly read compares against
GA4's own key-event counts, the second is what makes the JavaScript-error archive
ask this asset at all rather than skip it in silence — so each list carries that
consequence as its own line rather than only its file name. They sit on the GA4
card because the card already answers *is this lane working*, and this is the
other half of the same question; configuration below the verdict is the doc-14
disclosure order, not a demotion. **Neither list touches GA4.** The measurement
channel is operator-only by invariant: listing an event does not make it a key
event, listing a parameter does not register a dimension, and a row for a
dimension nobody registered still makes the collector fail loudly rather than
record an empty success. An asset with no entry — the state most assets are in,
because absence in these files means *not declared* — shows an empty list with
**Add**, and that first row files the asset's own entry, since a pointer never
creates structure. On a build with no write lane the pair states the deployment's
sentence **once** above both, rather than each table whispering it.

Two evidence facts. First, the **nightly archive lane** —
the largest collector the OS runs — has its per-provider
health ride as an additional evidence line on the GA4, Search Console, and
Bing Webmaster lanes it belongs to, in the register and on the asset page. It
is evidence, not a vote: the 15-minute collector is the fresher and more direct
observation of the same feed, so it keeps deciding the lane's state, and the
standing rule holds — a lane still speaks only from its own observations, and
says nothing at all where it has none. Second, **System health** and
**Settings** carry a month-to-date meter for the one lane that costs money to read:
**Data spend**, $X of $Y in the month, against the portfolio `monthly_caps.data_usd`
that fails closed. When that cap is what stopped a pull, the DataForSEO lane says
so in those words rather than reporting a provider error — a guardrail that
worked and an outage are different events, and blaming the provider for our own
limit would send the operator to the wrong place.

Each executive finding keeps its source report, evidence window, primary
magnitude, why-it-matters explanation, confidence, exact evidence, and
limitation attached. The scan row keeps the interpretation, why it matters,
primary proof, and Copy Markdown handoff visible; detailed facts and limitations
expand in place. Error red identifies warning signs, warn amber identifies
recommendations, info identifies discoveries, and general insights stay
neutral—this is scan navigation, not alert lifecycle. Marked findings pin to
the top. Dismissed findings leave the active list but stay recoverable.
Those decisions belong to the asset, not
to the browser that made them: they are recorded in the store and travel to
every screen the operator opens. They still neither resolve alerts nor edit the
immutable snapshot. The list applies each one optimistically and puts the
finding back if the write fails, and the first time a device with the older
browser-local preferences opens an asset whose record is empty, it lifts
those preferences into the store silently and forgets its own copy.
A **Copy Markdown** action serializes
the complete contract—kind, claim, summary, primary metric, why it matters,
evidence, raw source ids, window, confidence, and limitation—for an
implementation agent without detaching the recommendation from its evidence.
The shared copy helper uses the modern Clipboard API on secure origins and a
temporary selected textarea during the same click gesture on plain-HTTP LAN
origins such as `<machine>.local`.
Missing provider rows remain unknown and can never produce a deprecation
recommendation. These rows are interpretations, not flags or causal claims;
alerts retain their own operator lifecycle, and deploy annotations/outcome
watch still decide whether an action worked.

Raw provider rows remain in private R2. The offline analyzer publishes only a
compact, content-addressed snapshot—including bounded per-provider query
movers and current search-intelligence summary—to Postgres, which preserves the rule
that Tower renders from the central store (the live reads are listed under
Build notes).

### Timeline: recording a change, and watching what it did

The Timeline's **Record** action opens one form with two choices, **Something
happened** and **Watch an outcome**. Something happened asks what happened (the
six schema kinds, in doc 14's words), when, and a description. Backdating is
the default posture rather than an edge case — a title batch is annotated on
the day it shipped even when it is written down a month later — so the time
field is pre-filled
with now and stays editable, and a time in the future is refused, because an
event may not claim to have happened after the outcomes it explains. Re-posting
an identical event is the same event, not a second one.

Below the timeline, a **Watches** strip states the pre-registered outcome checks
running against this asset ([doc 03](03-attribution.md)): the measured series,
the next due check date, and how many of the registered checks have been read;
then the recently closed ones with what they concluded. It is read-only by
construction — registration and evaluation both live in the ingest worker — and
it renders nothing at all when no watch exists, because a section offering no way
to create one would be a dead end rather than an invitation.

### Link outreach: the reclamation pipeline as state

An asset that has run a broken-link reclamation campaign (find the lost link,
pitch the linking page, track the reply) gains a **Link outreach**
panel on its Activity tab: a single funnel line — *to pitch → sent → opened →
clicked → replied → link updated* — followed by the ten targets that moved most
recently, each with its domain, stage, and the date it reached it. A stage with
no rows is omitted rather than printed as a zero, because an unstarted stage is
not a measurement. The two exits from the funnel — hosts marked never-pitch, and
targets whose broken link has since gone from the page — follow as one quiet
line with the campaign total, since neither is work in progress.

The state it shows lives in `noticeos.reclamation_targets`; a target list
with no status columns and send state kept in prose cannot enforce the
playbook's own conversion band or its no-double-pitch rule.

**No write UI, deliberately.** Status changes arrive through
`scripts/reclamation-import.mjs` (an idempotent import through the ingest's
door, `--dry-run` to review it first), and a *won* link is a person confirming the change on the page —
never a rule. `scripts/signal-insights.mjs`'s `reclamation-match` rule can notice
that an open target has started sending referral traffic and say so; it asks the
operator to look, and marks nothing. A campaign that scores its own wins cannot
be graded against the band that decides whether to run the next wave. As with
the Watches strip, the section renders nothing for an asset with no campaign.

Future asset additions remain context-pack
status, concentration risk, and queue/registry slices.

## Phone mode

Three things only, fast: approve/veto from the queue, mark alerts read/resolve, and
the **kill switch** (behind confirmation; executes the [doc 06](06-operations.md)
procedure). If it works one-handed on a phone in under 15 seconds, it's right.
The kill switch is the one of the three that does not exist yet: doc 06's
mechanism is unbuilt, so nothing on the desk offers it.

**The desk IS the phone, reflowed** — no parallel mobile app, no second
component set ([doc 14](14-design.md)), and nothing
hidden at 390px that the desk shows. Below `md` the sidebar becomes a top bar
with a menu button opening the same nav as a drawer, with the asset list
collapsed (a drawer is opened to go one place). Below `sm` four things change,
each declared once:

| What | Where it is declared | Why |
|---|---|---|
| A wide table reflows into one labelled card per row — keyed to the table's own box (a container query under 40rem), not the screen | `stacked` on `Table` (`components/ui/table.tsx`), with `label` on each `TableCell` | Every table already scrolled inside its own box, so no page ever scrolled sideways — but Resolve sat 87px past the right edge of `/alerts` and Home's nine-column row showed two and a half columns. The card carries every cell, each in front of its own column name |
| The tab strip is one line that scrolls inside itself | `components/Tabs.tsx` | Nine asset tabs would wrap into ragged rows whose selected underline draws in mid-air above the divider. The strip scrolls; the page never does, and the selected tab is scrolled into it |
| Every button, field and nav row is at least 44px | `max-sm:min-h-11` in `ui/button.tsx`, `ui/command.tsx`, the field chrome, and `max-md:min-h-11` in `AppShell` | The desk's densities were set for a pointer: 36px, 32px, 30px |
| A config register past **eight rows** filters, and folds each row to one line | `NARROWS_FROM` in `components/CollectionEditor.tsx`, over `foldedWhenStacked` / `foldWhenStacked` / `onlyWhenStacked` on `Table` | The reflow above trades width for height and a long register spends it all: a page with one long register runs to roughly 33 screens at 390×844. Nothing is hidden — the fold is one line per row (its key, its second column, a chevron) until it is opened, and opening it gives back every field at the 44px floor. Finding a row on a phone is a search rather than a scroll, which is what the filter box is |

Every desk route is reviewed at 390×844 and 430×932. The structural guards — which classes decide which reflow — are
pinned in `apps/tower/test/components.test.tsx`, because jsdom has no layout and
what regresses silently is a class somebody deleted while tidying. One
horizontal scroller is deliberate and remains: the tab strip.

## Build notes

Tower render data comes from the central store, except two live reads the
ingest Worker makes when the Tower asks — GA4 realtime (`/api/ga4/realtime`)
and the calendar feeds — because the crons already paid for everything else and
the Tower must be fast and cheap to leave on a TV all day. The narrow
alert-lifecycle endpoint writes only the existing flag's disposition/resolution
fields (`snooze_until` included, `ack_expiry` cleared), on every open firing
of a recurring condition at once, plus a `flag_tunes` row for a tune
(`apps/tower/worker/flag-actions.ts`). Its validation lives in
`apps/tower/worker/flag-route.ts` rather than inline in the router — a date has
rules (in the future, inside a 90-day horizon, stored normalized; the horizon is
`apps/tower/shared/snooze.ts`) and validation
no test can reach is validation that drifts. Because snooze is the one
disposition that **expires**, what counts as an open alert is
time-dependent, and `packages/contract/src/flag-open.ts` is the single SQL
definition every payload composes (re-exported by `apps/tower/worker/flag-scope.ts`). A second narrow
endpoint writes only the operator's own decisions —
`POST/DELETE /api/assets/:id/decisions`, one current row per asset + query
or finding (`noticeos.decisions`), same-origin only. It stores
what the operator *decided*, never what a provider *observed*: an absent row
means untouched, a cleared decision is deleted rather than tombstoned, and no
evidence table is touched. Repeating a decision is idempotent, so the record
carries when a judgement was first made and when it last actually changed —
which is what the Learn loop grades predictions against. A third narrow
endpoint records one timeline annotation —
`POST /api/assets/:id/annotations`, same-origin only, sharing the same guard and
error vocabulary. Like the watch windows, an asset's editable columns, an
asset's creation and removal, credentials and config, it is an operator lane
the Tower does **not** write
itself: the row is written by the ingest worker, which owns the `annotations`
table, through `createAnnotation()` on its WorkerEntrypoint — the private INGEST
Service Binding, beside the GA4 realtime read. The canonical
route, ingest's `POST /api/annotations`, is behind `env.OPERATOR_TOKEN`, and the
Tower is served unauthenticated on the trusted LAN — holding the operator bearer
there would put every operator-authed ingest lane one LAN request away. Over the
binding, the binding itself is the capability and no credential crosses. The
kind vocabulary, backdating rule, `(asset, at, kind, ref)` identity and field
caps have exactly one home (`workers/ingest/src/annotations.ts`); the Tower
route keeps only the same-origin guard, the JSON envelope, and the mapping from
ingest's write result to its own error codes.
Auto-refresh polls the store. TV mode is a route (`/wall`) with no chrome; the
access proxy the standalone operator provides covers both. Hosted access
must cover both through the workspace authority in doc 23.
