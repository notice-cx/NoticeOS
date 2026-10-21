# 10 — Control Tower UX

*The Tower is the operator's control surface over the loop, designed as a core
part of the product rather than as a report added later. Design persona: **one
person** — a workspace's owner, operator or viewer — in three contexts: an
office TV across the room, a desktop browser for decisions, a phone for
approvals and the kill switch. Design so that a screen can be understood by
scanning it, without reading. State uses concise text plus a glyph where
useful (doc 14 "state is scannable and never color-only"), hierarchy is strong, each
surface has one primary action (doc 14 principle 4), and the number of alerts
is kept deliberately low: an operator shown too many alerts stops reading them,
and on these screens that happens sooner, so doc 02's volume-aware flag rules
are required for the Tower to be usable, not optional tuning.*

**Hosted scope.** Keep the same simple pages, quick to scan, inside each
workspace. Hosted customers initially join by invitation; owners, operators
and viewers receive the capabilities defined in
[doc 23](23-configuration-ownership.md). The public demo is a real workspace
with read-only visitors and separate simulated activity. The standalone
release relies on the access boundary in
[`README.md`](../README.md#deployment-status); hosted isolation is not yet
certified. Live auth activation remains an explicit operator action under
`AGENTS.md`.

## Principles

1. **Quick to scan, with detail one click away.** Every screen shows its main
   facts legibly from 3 meters away. Every actionable number links to an
   **existing** evidence view; if that view is not built, the number stays
   plain text rather than becoming a dead link.
2. **Data freshness on every sourced metric tile.** Each data widget shows the age of its source
   once (from the `ingest-freshness` check). A stale tile that looks current
   lets a failure go unnoticed ([doc 06](06-operations.md)). Freshness does not
   replace a chart's time domain: a primary trend prints its own actual
   first/last dates.
3. **Attention color is reserved for severity.** Color encodes the flag **severity** enum
   exactly as [doc 02](02-signal-contract.md) defines it: `error` red / `warn`
   amber / `info` slate. `milestone` is a **kind**, not a severity, and takes the
   reserved emerald accent. Two scoped operational states also use green:
   a reporting asset with no open error/warn is healthy-green, and a
   connected/working integration is green. An asset with no report remains
   gray; a not-working source is error red and not-configured is neutral gray.
   Visible alert/report copy plus checks / `!` / dashed treatment and hover
   labels mean those states are never shown by color alone. Provider identity and completed
   like-for-like performance may use their scoped chart tokens; attention colors
   are used only for things that need attention.
4. **Standard components, current patterns.** shadcn-class primitives, tabular
   numerals, dark theme (TV-first), command palette (⌘K) — built for
   **navigation** only so far (see the shell section below) —
   keyboard-first use in a desktop browser. No unusual custom chart types: line, bar,
   sparkline and delta chips only.
5. **Every operator action is a recorded input.** Approvals, vetoes, boosts,
   undos, and snoozes are recorded as Learn signals and timeline annotations, so
   the operator's actions are part of the loop's data.

## The app shell

Every Tower page except the Wall renders inside one layout route: a persistent
left sidebar and one page header.

- **The sidebar** lists the pages in the operator's order, and which pages
  it lists follows the person's view (`useView`, `sidebarItems` in
  `nav-items.ts`):

  | View | Sidebar entries |
  |---|---|
  | "I run the business" | Home, Sites, Tasks, Money, Settings |
  | "I build the product" | Home, Sites, Alerts, Tasks, Money, System health, Integrations, Settings |
  | "Everything" | Home, Workflows, Sites, Alerts, Tasks, Agents, Money, System health, Integrations, Settings |

  "Everything" is what a person sees before choosing a view, unless the
  workspace default (`config/tower.json` `/view`) names another. A page left
  out of the sidebar still opens from the palette and from any link. The
  sidebar's footer holds the items that are not pages — Search…, the TV dashboard with an Edit pencil to
  `/wall/edit`, and the light/dark toggle. A setting saves in the field
  being edited, so the sidebar and header hold no save controls. `/dev/kitchen-sink`
  and `/dev/asset-states` stay dev-only routes reached by URL and are not in the
  nav: they are for reviewers, and the nav lists only the pages an operator
  uses. The current item has `aria-current="page"`; on a
  site's page, Sites is highlighted. Below `md` the column becomes a top bar with a menu
  button that
  opens the same content as a drawer.
- **The Sites entry lists every site**. Under the
  Sites entry, one row per site: its favicon, its display name, a severity dot
  **only** when it has an open warning or error, and a muted slash **only**
  when it is retired. A row is highlighted on **any tab** of its site and the Sites
  entry is highlighted with it: the row shows which site, the entry shows where in the
  product you are. The order is
  the index's default (the payload's own seed order) with **retired sites moved to the
  bottom** behind the slash; an **Add a site** row with a plus icon ends the
  list; and above twelve sites the nav shows the first twelve plus **All
  sites…**, because a sidebar that scrolls is no longer a fixed list you can
  scan. The chevron beside the Sites link collapses it and the choice is
  stored per browser — expanded by default in a desktop browser, collapsed by default
  in the small-screen drawer, which is opened to go to one specific place. Before
  the first read finishes the list draws as many nameless muted rows as it drew
  last time, so nothing below it moves and no placeholder can be mistaken for a
  site. A workspace with no sites yet shows only Add a site. ⌘K is still the
  keyboard path to the same place; this is the pointer path.
- **The page header** shows what a page is: title, description, breadcrumb,
  right-aligned actions, and an inline meta slot for an age badge or a period.
  No page has its own list of pending changes; the task page has a back link to the page
  it was opened from. On the asset page the
  identity row (favicon, name, severity, domain, status badges) IS the heading.
- **`/assets` is canonical; `/properties` is an alias.** The sidebar shows
  **Sites** while the URL keeps the code's noun:
  `/assets` is the index and `/assets/:id` the page, and
  [doc 14](14-design.md) maps *asset* to *site* on screen. `/properties` and
  `/properties/:id` redirect to them with the hash intact.
  Every deep link the Tower has ever produced — an alert's change chip to
  `#timeline`, a matrix cell to `#integrations` — still opens the section it pointed to.
  The index is a table, and with two or more sites it **filters and sorts,
  with the state in the URL** (`?status=&automation=&attention=&sort=&range=`,
  the `useSearchParams` mechanism first used on `/alerts`, so a narrowed table is
  a link): lifecycle status is a native `<select>` with a count per option,
  automation and attention are chips with their registry glyph and their
  count so every number is on screen at once (a doc 14 rule),
  the ordering is a `<select>` and the table's header cells, every ordering except
  Name puts the highest value first with seed order as the default and as the
  tie-break, and a line above the table shows what is listed — "3 of 6 sites ·
  status: live · sorted by open alerts" — with a Clear link beside it.
- **`/wall` stays outside the shell.** The TV has no navigation, and its tokens
  are written for the dark palette, so the theme class is applied by the shell
  and removed when the shell unmounts. The light theme of the Tower's pages is
  never applied to the TV.
- **⌘K opens any page or asset**. ⌘K or
  Ctrl+K anywhere inside the shell opens a palette, and so does a **Search…**
  button in the sidebar footer, because a shortcut with no visible control is
  found only by people who already know it, and a touch screen has no modifier
  key. The palette lists every
  page in every view (the sidebar's pages of "Everything", plus the TV, its
  layout editor and Arrange the sites) and every asset by display name, with its
  favicon, its domain and a severity dot when it has an open warning or error.
  Typing filters, Enter navigates, Escape closes, and focus returns to the
  element that had it. The items the operator opened last are stored and listed first while
  the query is empty. With a task source connected, a query shaped like a task
  id adds one extra row that opens `/tasks/<id>`. A **Views** group lists
  "Switch to · \<view>" for each view the person is not in; selecting one
  saves it as the person's view, keeps their "What matters most?" picks and
  the page they are on. So far **principle 4 is only
  partly built**: the palette
  navigates but does not run actions. Running commands from it — approve, snooze, file —
  is [doc 16](16-replacing-the-chat-workflow.md) § L (the Ask console), which needs a list of verbs and
  a confirmation design before it can ship. The palette is mounted by the shell,
  so `/wall` does not have it: the TV has no keyboard and no other pages to open.

## Home: how the business is doing

`/` (`apps/tower/src/routes/HomeRoute.tsx`) shows how the business is
doing, what is broken and what needs the operator, from the data: the
month's money as the largest figure with yesterday's revenue and visitors beside it,
every site's data sources as one grid beside the ranked problems the grid does
not show and the decisions waiting, the sites compared, and the last 24 hours
on a time axis. The layout is specified in [doc 14 § Surfaces](14-design.md); the
wording rules are in [doc 14 § Lexicon](14-design.md). Every money figure uses the same
rule as every other surface (`monthRevenue`, `portfolioHeadline`), so Home
can never show a different month total than the Sites page or the Wall; the
decision rows exist only with a task source connected.

- **Home is a list of modules, and the person's view picks them**
  (`HOME_MODULES` and `VIEW_LIBRARY` in `packages/contract/src/views.mts`,
  drawn by `routes/home/modules.tsx`). The paragraph above is the
  "Everything" view. "I run the business" draws Site health, the month's
  money, "The agents · this week" and the decisions; "I build the product"
  draws the month's money, "Where visitors come from · 4 weeks", "Worth a
  look", the problems, the decisions and the sites. A "What matters most?"
  pick moves its module to the front when the view draws it.
  - **Site health** (`HealthModule`) is one row per listed site with five
    dots, Up, Speed, Errors, Search and Code, from `techHealth`
    (`src/lib/tech-health.ts`), the calculation the site's Health tab and the
    TV's Site health widget also use.
  - **The agents · this week** (`FactoryModule`, `agentsWeek`) shows Building
    › Finished › Proven to work and the three newest lines.
  - **Where visitors come from · 4 weeks** (`ChannelsModule`) sums the listed
    sites' visits by channel, beside the funnel step that loses the most
    people.
  - **Worth a look** (`GapsModule`, `businessGaps`) ranks what the sites lack
    as a business (no income source, no data feeds, no task project, no code
    report, then the newest readings' opportunities), each row with "Make a
    task".
  - In the business view the summary sentence starts with the sites' health
    (`healthWords`: "2 of 3 sites are fine." and the site most in need of a
    look with its first problem) and states the count of broken things only
    when there is one.
  The card fields these modules read (`product`, `codebase`, `watches`,
  `channels`, `findings`) are filled by `apps/tower/worker/card-readings.ts`.
- **With one site**, Home starts with that site's own numbers and chart
  (`OneSiteLead`, the top section of the Overview) and draws no one-row table.
- **Home has none of the TV-only panels**: no clock, no countdown, no meetings
  panel. `/wall` renders those, and the countdown editor is on `/settings`,
  because the countdown is a control for a screen in another room.
- **Until a site has its first number, Home is a first-run guide instead of all
  of the above** (`firstRunSite`, `apps/tower/shared/first-run.ts`): one card —
  a sentence describing what NoticeOS does, then three steps for the newest site
  (add a site, connect its first source, see the first number) — and no tile,
  list or table around it, because a zero would imply that something was measured.
  Above the steps, until the person has a view of their own, the card shows
  "Which describes you?" and then, unless they chose "Everything", "What
  matters most?" with Continue and Skip (`routes/home/ViewSteps.tsx`). The
  steps work whether or not the questions are answered.
- **Every quantity on the page has a small visual beside it that makes it quick
  to read** (doc 14's rule): each visual shows something the number alone does not
  (direction, share, shape, or which is worst); none is decoration.

## Settings page

`/settings` is **one place to
change anything that applies to the whole portfolio.**

It is divided by the same tab bar a site's page uses, General first, and each
tab has its own URL: `/settings` is General and `/settings/<tab>` each of the rest.
There is no second navigation inside the page. **Installation** shows on a
standalone installation and **Members** to a hosted workspace's owner. Each
tab is one column of panels — a small label, then rows divided by thin lines —
and an address from before the tabs (`/settings#task-hub`, `#entities`,
`#alert-rules` and the rest) opens the tab that holds its section.
`#view`, `#clock` and `#budget` are General's three panels. The rows below
describe each tab:

| Tab | Holds | Shown most prominently |
|---|---|---|
| **General → Your view** (`/settings#view`) | the person's view ("I run the business", "I build the product", "Everything") as three radio cards, saved in the browser on change with Undo beside them; "At the top of Home", the "What matters most?" picks, toggled with Change; and "Workspace default · new people and the TV start from" (`config/tower.json` `/view`), changed with Change while settings can be saved and shown with a lock while they cannot | the three views with their one-line descriptions, the chosen one filled |
| **General → Clock** (`/settings#clock`) | the operator's timezone — the IANA zone every intraday chart is drawn in (`config/constants.json` `os_time_zone`) | the current time in that zone, because two neighbouring zone names look equally plausible until you see the time each one gives |
| **General → Budget** (`/settings#budget`) | monthly data cap, the value of your time; what happens at the cap is a **Stops at the budget** chip beside the meter | a meter of month-to-date data spend against the cap. **Every cap here has a meter**: NoticeOS makes no model calls of its own, so there is no inference cap to show |
| **Alert rules** (`/settings/alert-rules`) | a replay of the rules against a site's last 30 days, how often the operator responded to each rule by tuning it, then the thresholds: anomaly sensitivity, longest window | sensitivity against the conventional 0.05 ceiling; the longest window as its share of four weeks, with the quietest daily average it still tests |
| **Data collection** (`/settings/data-collection`) | the schedules of the collections that no connection supplies (nightly reports, live counters, local research — a connection-supplied collection's schedule is on that connection's Manage panel on Integrations), the two declared cadence settings — the panel history window and the panel freshness bar — and every pull endpoint | the window in weeks and its cost per pass; the freshness bar as a meter **inside** the window, which shows how the two values relate, something the bar's number alone does not show. An enabled/paused chip per pull endpoint |
| **TV dashboard** (`/settings/tv-dashboard`) | the link to the layout editor (`/wall/edit`), and the countdown the wall display shows — emoji, label, target | the **Edit layout** button, then the countdown widget itself. With none configured the panel offers **Set a countdown** — the countdown is optional — and the tab always renders, because every install has a TV layout whether or not it has a countdown |
| **Ownership** (`/settings/ownership`) | the legal entities that own sites (`config/entities.json`) — slug, name, form, jurisdiction | *Sites by owner*: each entity's sites as favicons, and the sites nobody owns under a **No owner** chip, each linking to its Identity card |
| **Task projects** (`/settings/task-projects`) | the read-only connection, then the project map — site, task prefix, database — **editable**; a deployed build shows the map as a read-only list | the site's favicon beside its row; after an Add, the remaining steps that saving the file does not do |

**Saves go through the config write path, and a field is editable exactly when
that path permits writing it; it is not a design choice.** The timezone, the countdown, the caps and
the rules are ordinary fields because `config/constants.json` and
`config/tower.json` may be edited as a whole.

**Two more sections save** through a permission narrower than that allowlist:

- The **task-project map** is a declared list (`CONFIG_REGISTERS` in
  `scripts/config-registers.mts`), which permits adding, removing and editing
  rows at one container and nothing else in its file.
- The **cadence** numbers are **declared settings** (`CONFIG_KNOBS`) — one exact
  pointer each (`config/signal-panels.json` `/refresh/windowDays` and
  `/refresh/freshnessMaxAgeDays`), with the same field rule as a column of a
  declared list. How often the counter cards are read is the counters job's schedule,
  not one of these settings. A write to anything else in either file is rejected, and the
  rejection message names the pointers that would have been accepted. Each field shows **what changing it
  costs** beside it as values — a wider panel window gives more history for
  $0.00 a pass, because a refresh pass makes zero provider calls. The page
  shows the two panel settings; the counters interval is not on it. The cost is
  shown so that an operator never changes a cadence without seeing its price.

What is still read-only, and why: the **pull registry** (an endpoint is edited on
its own asset's page, with the rest of that asset's connection settings) and the task
database's **connection** (its port is set in three files that must match). Every
other field saves to the store in any deployment; the fields lock only where the store
cannot accept a write (unseeded, or without the config tables), and the page shows
that once (`SavesPaused`).

**Saving a row is not always all the setup a project needs, and the Task
projects tab lists the rest.** Mapping a project in
`config/beads.json` does not create the database its tasks are stored in or connect the
repo to the task database, so after an Add the section shows the remaining operator steps
from [`config/beads.README.md`](../config/beads.README.md) as four steps:
**Initialize a new task database** (the `bd init` command filled in with the
project just added), **Keep it on the shared database**, **Prepare project
instructions**, and **Link the checkout here** (the entry that links the
checkout in the installation's `task-host.json`) — each as text to copy,
labelled with where it goes. The runner re-reads the map **every minute**,
so a new project appears on the Tasks board without restarting the app, and
is shown as unreadable until those steps are done. The **task database connection** is shown
read-only, as a lock and its value, and it is sent to the browser only while
`vite` is serving; it is compiled out of a deployed bundle with the rest of the
runner code (`__RUNNER_LANE__` in `vite.config.ts`).

`GET /api/settings` is a **pure builder over the resolved config** — each
stored document, or the compiled copy where none is stored
(`apps/tower/worker/config-source.ts`) — and both of its store reads always
return a value: the page an operator opens to fix something must not go blank
because the database is empty or unreachable. Its budget and alert-rule
rows come from the same builders the asset page uses, so the two surfaces always
show the same name for `alpha` and the same file it is stored in.

## The Wall (TV mode)

**What the Wall shows is specified in [doc 14](14-design.md)**: by default a slim strip and the loop
across the top, then the last 24 hours of problems above one row per site,
beside the month's revenue above the work. The sections below
cover the route, refresh, layout document and editor mechanics; doc 14 specifies what
is on the screen.

**One payload, two renderings, two routes.** `/wall` is the TV: full-screen,
updated from one payload and its feed (`/api/wall/feed`) when either changes
(see [how a page loads and stays current](#how-a-page-loads-and-stays-current)),
beside the GA4 realtime, calendar and connection reads, read-only, dark, and — with
one exception — without interactive controls. The exception is the
**Home** link: without it, a browser that opens `/wall` has no way to leave it.
It is the strip's brand, and there is no header row above the strip.
It is the route's only link and only control. The evidence drill-downs that
exist (principle 1) are on the Tower's other pages; the TV never needs a
mouse. A failed poll keeps the **last-good values** (never blank, never a
spinner) and the strip shows how old they are — the only time the Wall shows
its payload's age.

The TV rendering has its own frame: doc 14's spacing (a 24/32 px page inset, 20 px
between stacked regions, 28 px between regions side by side) on tokens in
`index.css`. It does not drop dates, labels, alert meaning or state to save space.

**The TV uses the word Tasks, like every other screen**:
`scripts/ui-lexicon.test.mjs` does not exempt the Wall, so the system's internal
nouns cannot reappear on any surface ([doc 14](14-design.md)). The Wall shows
tasks as the work chart: counts per project and what is waiting on the operator,
never a task's own text and never a link.

**The setup checklist ring appears only on the Tower's other pages**:
its meaning is in a hover, and a TV has no pointer; nobody sets up an
integration from across the room; and a site with no report yet is one row of
muted text on the Wall ("No data yet") — see [doc 14](14-design.md).

### The Wall draws a layout document

**Everything on the TV is drawn from a saved layout document, not hard-coded in
this route's source.**
[Doc 14](14-design.md) specifies that the operator arranges tiles from a fixed library
and never creates new tile types;
a new tile type is a component-registry PR ([doc 14](14-design.md)). The layout
is a `WallLayout`: rows top to bottom, each holding widgets with a weight
each, and one row taking the remaining screen height. A row may also hold a
**column** that stacks rows of its own, one level deep, so a widget can span the
full height beside several ([doc 14](14-design.md) § Regions).

- **The contract** is [`scripts/wall-layout.mts`](../scripts/wall-layout.mts),
  which [`apps/tower/shared/wall-layout.ts`](../apps/tower/shared/wall-layout.ts)
  re-exports with its types: the widget library (each type with its operator label, default and
  minimum width, whether only one may exist, whether it may hide when empty, and
  which settings it supports), the layout document, the one validator for "can the
  Wall draw this", the non-blocking warnings, and the version history a Save and
  a Revert produce. It is shared by three parts — the renderer, the editor, and
  the config write path — so all three apply the same rules.
- **Where it is stored**: `config/tower.json` at pointer `/wall`, as the current
  layout plus the versions it replaced, newest first, capped at twenty. It is
  read into the polled payload by `parseWallConfig`, exactly as the countdown is
  read, so a Wall on another device shows the new layout within 60 seconds. The document
  is kept in the store; its shape is the same.
- **The default** is `DEFAULT_WALL_LAYOUT`: the strip, then the loop, then
  two columns — the last 24 hours above the site rows, beside revenue above the
  work. Revenue sits beside the sites rather than above them because that is
  the only arrangement in which the TV's 1080 pixel rows fit the loop, the revenue band and seven
  sites' rows without clipping (`pnpm audit:wall-fit`). **A fresh install's `/wall` is `null`, or absent** — both
  mean "nothing saved" — and the TV then draws the preset of the workspace
  default view (`WALL_PRESETS`, chosen by `config/tower.json` `/view`), which
  is `DEFAULT_WALL_LAYOUT` for "Everything" and when no view is saved. The
  presets are defined once, in the code, and not repeated in the file; a saved
  layout always wins over a preset. `/wall`
  is a declared document, so the config write path treats a stored `null` as absent and
  the first Save creates the key
  ([`config/tower.README.md`](../config/tower.README.md)).
  `apps/tower/test/wall-canvas.test.tsx` checks the default's
  rows, weights and regions.
- **The library is thirteen widgets** — strip, the loop, the last 24 hours,
  sites, revenue, work, Needs attention, the feed, Agents, Site health, The
  agents, Visitors by channel and Next up; the default places the first six, the
  business and product presets place Site health, The agents and Visitors by
  channel, the business preset places Next up across the TV under the strip,
  and the rest are available for a layout that adds them.
  Seven older types (alerts, portfolio net, System, clock, meetings,
  countdown, the asset cards) are **retired types**: a saved layout that names
  one is still read — never
  rejected, never blank — and drawn as the default, the editor shows this in one warning
  chip, and its Save is checked against the value as saved (`WallConfig.retired`,
  which exists only on the read side and is rejected by every write path). A new layout
  naming a retired type is rejected like any layout the Wall cannot draw.
- **Widths are weights, not columns.** A row's widgets share its width in
  proportion to their `width` — the `fr` a CSS grid track takes — with a minimum
  (`minWidthRem`) below which that widget's content clips. The Wall is fitted to
  one 1920×1080 screen (`pnpm audit:wall-fit`), and its rows were tuned in fractions.
- **A widget with nothing to show renders nothing and gives its track to the
  other widgets**, the
  countdown/meetings rule applied to every widget the library
  marks that way; a row whose widgets are all hidden draws nothing at all.
  Every current widget draws its own empty state (a timeline with no problems shows Nothing broken,
  a work chart with no task data shows Tasks unknown), so none is marked today; the rule remains
  for a future widget that needs it.
- **The renderer is `WallCanvas`, and the editor's preview is the same
  component** — a preview drawn by a second renderer could differ from what the TV shows.
  Selection and drag controls are passed to it through one render-prop slot; `/wall`
  passes none and imports no editing code, because edit mode never runs on
  the TV.
- **A layout the Wall could not draw is rejected before it is written, on every
  write path.** The contract's validator runs inside the shared changeset pipeline
  (`scripts/wall-layout.mjs`, called by `scripts/config-documents.mjs`), so the
  dev config write path, `PUT /api/config`, the ingest's `applyConfigOps` and
  `pnpm config:apply` all reject it with the validator's own message — the same
  text the editor prints under Save — and `parseDashboardConfig` fails
  `vite build` on a compiled `config/tower.json` it cannot parse, while a stored
  document it cannot parse falls back to the compiled copy.
  The layout is written whole, at `/wall` or `/wall/layout`: a row or a width
  cannot be validated on its own, outside its document.
- **The layout is edited at `/wall/edit`**: a page inside
  the shell, reached from `/settings` → TV dashboard and from the command
  palette, and never from the TV. It draws `WallCanvas` at 1920×1080
  scaled to the pane and the window, and the operator arranges widgets on that
  picture: widgets dragged to the edge where they should go (stack, beside, new row),
  dividers dragged to resize, a Move menu on every widget for a keyboard or a
  tap, Undo and Redo over every change. It saves through the ordinary settings
  write path with a one-line version note, and keeps the versions it replaced
  with a Revert per entry. The Add a widget drawer's "Start from" lists each
  view's preset by the view's label; picking one replaces the whole
  arrangement as one step Undo reverses, and a version saved as a preset is
  named "Started from \<view>" when no note is written. The preview is a **query container**, so the
  type scale and every widget's breakpoints use the 1920 box rather than the
  browser window, and the arrangement on screen matches the TV's at any width;
  `pnpm audit:wall-fit` remains the check that measures the real screen, and it is the
  only check that catches a font the kiosk failed to load.

## Alerts page

**Two views, each with its own URL.** `/alerts` is **Open** and
`/alerts/history` is **History**, on the same `Tabs` contract the asset page's
tabs use — so a view can be bookmarked, pasted into a task, and reached
with Back. An unknown path segment opens Open *and replaces the URL with Open's*,
because the tab bar matches on the path, and Open rendered under a bar
with nothing selected would show the operator the wrong location. A tab link
keeps the site and severity filters the other view supports
(`carriedFilters`), so those filters stay set after the switch; `kind` and History's
page are dropped.

### Open

`/alerts` lists every open error and warning in one `ListPanel`, one row per
condition that opens in place to its Evidence and its actions (`FlagActions`,
File task, the link to its site), plus three filters: site (with two or more
sites), severity and kind. **The filter state is stored in the URL**
(`useSearchParams`), so a filtered view is a link that can be bookmarked, pasted
into a task, or reached from an asset page. They are native `<select>`s in the
Tower's existing input styling — three enum pickers do not justify a component
(doc 14).

Above both tabs, a strip of **tiles** counts the whole portfolio regardless of the
filters — open, errors, warnings, opened this week, median age, settled
this week — and the list shows how much is on screen (*"3 of 8 open"*) only when a
filter narrows it. The **errors** and **warnings** tiles show a different fact
from the total, and it is the fact the operator needs to decide
whether to read the list now: nine open alerts can wait when they are nine warnings and
are an emergency when they are nine errors. Each row keeps its own severity and its
recurrence — except the cross-asset group row, which expands to one
actionable sub-row per
asset and has no recurrence at all. A list emptied by filters shows
*"No open alerts match these filters"* and never the all-clear line: a filter
must not make the portfolio look healthy. With nothing open at all the page
shows the shared all-clear.

**A fourth action, on rule-driven rows only: Tune rule.** Mark read, Snooze and Resolve each record what the operator did with
this EVENT; Tune changes the rule that produces it. It opens a panel holding the
rule's three settings with a **30-day preview** above them — *"Would have fired
3 times in the last 30 days"*, plus the thirty days drawn in order with the
would-fire days marked and the days it really fired marked beneath, recomputed
as a value changes. The number is produced by `POST /api/alerts/backtest` → the
ingest `backtestRule` RPC, which re-runs `evaluatePulse` over the stored nightly reports
against the same four-matching-weekday baselines the nightly job uses; it is
read-only and writes no flag, no disposition and no config. Rows whose rule
cannot be replayed accurately from stored nightly reports — `ingest-freshness`, `asset-declared`, the
watch-window results — get **no Tune rule button at all**, because a preview for them
would have to be invented.

The settings in that panel are the same portfolio-wide ones shown on `/settings/alert-rules`,
written through the same config write path, and **the panel shows this first**, with
one *Applies to every site* chip above the fields. This is deliberate and does not
bring back the per-asset editor removed below: the editor stays on the page where
its portfolio-wide scope is obvious, and the alert row adds the one thing that page
cannot have — a specific asset to replay the rule against.

### Snoozed — what the operator put off, and until when

Below the list, and absent entirely when nothing is snoozed, `/alerts` has a
**Snoozed (N)** section: one row per snoozed condition with its asset, its
translated headline, the date it returns as glyph + countdown, and an
**Unsnooze** button that ends the snooze now. It exists because a snooze with no
visible row would hide an alert as completely as muting it.

It is deliberately **below** the open list and never merged into it — a snoozed
row needs no action yet, and one list holding both would mix snoozed rows into
the open count the operator checks first — and it **is not affected by the three
filters above**: those narrow what needs attention now, while this section is the
full record of what was snoozed. If a filter could shorten this record, it could
hide a snoozed alert a second time.

Its scope is **wider than the open list's**: the
list above shows errors and warnings, because those are the alerts that require
a response, but **Snooze is offered on every open row of the asset page's
Alerts tab** — info and milestone included — so this section lists **every snoozed
row**: an info row snoozed there can be found in a portfolio list, not only in
that one asset's alert history. The portfolio's
**counts** do not widen with it: `attention`, each site's open error/warn tallies
and their worst severity all keep the error/warn scope
`worker/wall-payload.ts` applies. This is a record, not a work queue, and it stays short
because it holds only what somebody chose to snooze.

A snoozed row belongs to **Open**, not History: nobody decided anything about
the condition, they deferred it, and the store treats it the same way — the three alert states,
open, snoozed and settled, are defined once in
`packages/contract/src/flag-open.ts`, and a snoozed row becomes open again on
its date. Listing it under History would show a decision the
operator has not made. It enters History only when it settles — resolved or
marked read — and until then "Settled · 7d" does not count it.

### History

**Every comparable product's alerts page includes a history of past alerts.**

`/alerts/history` lists every **settled** alert — resolved or acknowledged, never a
snooze that is still running — across the portfolio, newest close first. It is ordered by *when each row closed*, not
when it fired: a condition that ran for six weeks and closed yesterday belongs at
the top of a list of what settled. Rows are **one per firing** and are not
grouped; the grouping the open list applies is for live conditions, and two
rows the operator dispositioned on different days are two decisions the audit
trail must show separately.

The page reads its own narrow `GET /api/alerts/history` rather than a slice of
`/api/wall`, because the wall payload is what every open page and the TV
read again whenever it changes, and a paged archive should not be added to it. **Paging is
offset + limit and shows a total** — `26–27 of 60 settled`, once, with Newer
and Older showing direction and no numbers of their own. A cursor would suit an
append-only log better, but this list is ordered by a column that the
operator's own clicks write, so there is no stable position a cursor could point
to reliably; and a person paging an archive needs to know where they are in it. The
asset and severity filters are stored in the URL exactly as Open's are, and changing one
returns to the first page, because the old page number does not apply to the
new list. A **page parameter the server cannot parse is
rejected**, not replaced with a default: a corrupted `?offset=` that returned
page one without an error would look the same as a link that worked, so an operator
who shared "page 4" and received page 1 would have no sign of the error. The rejection is
`400` with the size of the archive, and the page renders it the way
`/financials` renders a requested month it cannot show — the requested value shown back,
what does exist listed, and a link out offered. A filter the server cannot read is
still dropped rather than rejected: the resulting list is wider than
expected, which makes the mistake visible. Severity here offers **Info** as well, which the open
list never can: a milestone is an event, always info-severity, and it settles
like any other alert.

Every row is the **same component the asset page draws** (`AlertRow`, moved into
the registry when this became its second surface), so a settled alert always
looks the same here and on its asset's Alerts tab. It adds the two facts a
portfolio list needs and an asset page does not:

- **which asset**, as that asset's own favicon plus a link into its Alerts tab;
- **how long it stayed open**, as a line between a filled dot and a hollow one
  whose length is the duration, log-scaled from an hour to a month, with the
  duration in words beside it. "Fired 9d ago" and "resolved 2d ago" are both
  times since an event; a reader of a list of closed alerts wants to know *which
  stayed open longest*, and doc 14's visuals rule requires a shape to show that
  instead of leaving the reader to subtract one date from the other on each row. The line is
  a neutral color — severity is the row's only color, and a long-running warning is not
  a more severe warning — and a row with no recorded closing time draws no line
  at all, because an unknown duration must not look like zero.

The view is **read-only**. Settled rows have no Mark read / Resolve pair: there
is nothing left to act on, and disposition stays where it has always been, on
`PATCH /api/flags/:id` from the Open view and the asset page. A list emptied by filters
shows *"No settled alerts match these filters"* and an empty archive shows *"No
settled alerts yet"* — the same rule Open follows, for the same reason.

## Money page

**A site's Money tab.**
`/assets/:id/financials` is the place for that asset's saved daily ad revenue and monthly
accounting. Its 7/28/90-day selector applies to daily earnings; monthly booked
net, separate forecasts and the entry audit remain independent of that range.
Daily bars use current saved Mediavine revisions and preserve calendar gaps;
missing dates never become zero. Exact amounts are available by pointer,
keyboard and the date table. Overview keeps its brief financial snapshot
and links here. Activity shows event history; the ledger it used to show is on
the Money tab. Existing `#pnl` and `#ledger` links select that tab.

`/financials`, the **Money** page, is the portfolio's accounting, for an operator who is **reading** in
detail rather than scanning: the month-by-month trajectory, the per-asset split, where each
cost figure came from, the domain schedule behind the summed `infra` rows, and
which figures are missing. It has two tiers by design — asset nets
include DIRECT cost only, and portfolio overhead is subtracted once, visibly, on
NoticeOS's own line — and it opens on the latest month that has rows, with the
month in the URL (`?period=YYYY-MM`) so a figure being checked against a receipt
is a link somebody can send.

**Financial responsibilities.**

| Surface | Operator question | Financial content |
|---|---|---|
| Wall revenue and site rows | What happened yesterday? | The month's revenue with its projection and yesterday's saved ad revenue estimate or its missing-report state (`RevenueHero`); each site's month so far → pace when supported |
| Asset Overview | How is this asset doing? | A brief monthly financial snapshot linked to its Money tab |
| A site's Money tab | What is this asset earning and costing? | Daily ad revenue, reported-day average, monthly booked net, separate estimates and entry audit |
| The Money page | Where is the startup making and spending money? | Selected-month revenue/cost/net and reconciliation, daily revenue across reporting sources, asset contributions, shared overhead, monthly history and cost configuration |

Portfolio daily bars follow the selected month and stop at the last completed
reporting day. The source list names the sources the chart covers; other revenue sources
remain in monthly accounting. Solid bars mean every source in that coverage set
reported; outlined bars are observed subtotals with missing assets named in the
readout and data table. A missing date has no bar, and a reported zero keeps a
zero mark. When asset coverage is incomplete the average is not shown, rather than
showing an artificially low daily average. Coverage is measured against currently mapped sources
and assets with reports in the selected month; it is not a measure of historical connection
uptime. Provider revisions are read from the revenue ledger's current figures
(`current_revenue`), for every source alike, without changing stored history.

Monthly summaries remain above the daily chart; asset contribution rows link to
their own Money tabs. The monthly revenue/cost/net trajectory and ledger
table share the **Month by month** disclosure. Cost provenance and configuration
stay on the Money page. Monthly subscriptions and shared overhead are
never spread into invented daily costs or profit.

**The page edits its own inputs.** A collapsed
**Declared costs** panel below *Where the cost comes from* holds the two config files
the cost half of the ledger is built from — the subscriptions nobody meters
([`config/recurring-costs.json`](../config/recurring-costs.README.md), the
*Stated* rows) and the domain orders being amortized
([`config/domain-costs.json`](../config/domain-costs.README.md), the *Amortized*
ones) — as two `CollectionEditor` tables. Adding, changing and removing a row
goes through the same validated config write path a setting uses: one changeset
per action, its exact inverse behind the Undo shown under the cell (a removed
row's Undo is in the toast), and the financials
read invalidated after the save so the month totals and the period picker's
months recompute without a reload. A row the schema rejects (a month that is not
`YYYY-MM`, a negative amount, an `asset` that is not an asset id, an `id`
already in the list) is rejected **in the browser, beside the field**, and is never
sent as a request. Where the store cannot accept a write both tables lock and the
page shows the reason **once** (`SavesPaused`).

The panel **replaced the read-only *Domain schedule* card** rather than sitting beside it:
that card listed the same five stored fields the editable table now holds, and doc 14
allows one representation per fact. The one thing the card showed that the table does not — the
amortization — is shown once for the whole list in the domain table's own
subtitle (orders, cash paid, how many are still spreading into the shown month)
and once per site in the **Declared, by site** strip: each site's favicon,
the amount the two files assign to it for this month, and a share bar. That
strip is deliberately different from the *Direct cost* column above it — the column is what the
ledger booked, the strip is what the files specify should be booked, and they differ whenever
`cost-import` has not run yet, which is the first thing to check when a figure
looks low.

The rows are sent in the payload **verbatim and in file order** (`recurringCosts`,
`domainOrders` on `/api/financials`), because a collection editor addresses an
array row by its index: sorting them for display would make a Save write to a different
subscription. Past eight rows the editor filters and sorts a table itself, and
each row keeps its index in the file (`NARROWS_FROM`).

## Integrations page

`/integrations` is where a provider is **connected**, and it is a separate page.
It and `/health` show different things and both keep
their address: **Health** shows *whether everything is working*, from collector
evidence, per asset × data source; **Integrations** shows *which providers are
connected, and lets the operator connect another*, from the credential store, per account.

One row per provider, grouped (Traffic & search, Revenue, Coordination, then
Tasks), each
with its logo, its name, **one status** and one action — Connect, Reconnect or
Manage. The status is one of `CONNECTION_LABELS`
(`apps/tower/shared/connection-status.ts`): Not connected · Not checked · Key
accepted · Collecting · Working · Overdue · Failing · Not using · Unknown, a
glyph-led chip in integration connectivity's tones ([doc 14](14-design.md)).
A provider's own page (`?provider=<id>`) shows:

- **One result**: whether it last worked and when — the probe the operator just
  ran, else the stored error while it is failing, else the stored last success.
  A `Test connection` runs one real authenticated call and shows the outcome as a glyph,
  a sentence and a time ([doc 14](14-design.md): validation comes from a
  collector attempt, never from a manual health toggle).
- **Which sites use it** (*Used by N sites*), as their own favicons, each
  linking to that site's Data sources tab.
- **A Connect form built from the provider's field schema**
  (`packages/contract`, re-exported by the Tower rather than copied), so a
  provider or a field added there gets its input with no Tower change: a
  password is masked, a service-account JSON is pasted or uploaded, feed URLs are
  one per line. **No value is ever sent back to the browser** — the API returns field names
  and timestamps only, so a stored field shows *set* and Reconnect opens empty
  inputs, because a pre-filled password field would mean the browser holds
  the password.
- **Disconnect behind one inline confirmation** (`ConnectionActions`) that
  lists what stops — the sites, then what is deleted — and whose button names
  the provider. It is the only confirmation
  on a page whose other writes use undo instead of confirmation: a deleted
  credential cannot be restored by an undo, and deleting it stops every data source
  that uses the credential with no other warning, so the confirmation lists those
  before the operator confirms.

**This surface is never read-only.** Every
write here is a **store** write, so it behaves identically in a deployed Worker
and in the operator's Docker stack. There is no 501 path and no "this deployment cannot
save" message for a credential.

**Three bootstrap states can block Connect** (`CredentialBlocker` in
`packages/contract`), and any one can occur alone:
the `credentials` table has to exist (the migration is operator-applied — DB
migrations are operator-only forever, AGENTS.md — so a checkout that has
pulled this feature has the code but not the table), and `CREDENTIALS_KEY` has
to be set and usable. The page shows each **once at the top**, in the order they have to
be fixed, each with NoticeOS's own message and its exact command — a fact
about the deployment goes above the cards, not repeated on each of them.
Showing them one at a time would make the operator fix one and then return
for the next.

The rest of the page still renders underneath: a provider that reads its credential
from the environment file is working, and its row shows that. **Disconnect stays available even
then**, because deleting a credential that can no longer be read is exactly what the
operator may need to do in that state.

One more designed state is easy to miss. For a provider that connects in the panel,
NoticeOS sends the details to the provider first and stores them only once the provider accepts them,
marked **Key accepted** (`workers/ingest/src/credential-connect.ts`); any other
provider's newly stored credential shows
**not tested yet**, because a save clears the stored test results —
a result for the old key does not apply to the new one. That state is a hollow ring
and a sentence with the Test button beside it, never an empty slot.

## The Queue — planned improvements

The Decide output as a ranked, reviewable table. This is where the operator
**overrides the automated ranking**, quickly and with the reasons visible.

- **Columns:** rank · asset · change-class · title · predicted Δ$/mo ·
  P(success) · fully-loaded cost · score · measurability tier · autonomy tier ·
  status.
- **Row expander — "why this rank":** the full hypothesis card: scoring inputs,
  causal path to a ledger family, kill criterion, **the data the card references**
  (integration sources per [doc 11](11-integrations.md)) — the operator sees
  the reasons behind a rank, so an override is an informed decision.
- **Operator actions (single-key):** `a` approve · `b` boost (pin to the
  top of the list; recorded with reason) · `v` veto (reason required — vetoes are a strong
  Learn signal: the policy predicted value the operator rejected) · `e` edit
  card (until it ships: its change entry then locks the prediction) ·
  `p` park (shown again automatically at its kill date). Bulk select. Filter by
  asset/class/tier.
- **The explore sleeve is visually distinct** (its 15% of build capacity has
  different rules; the operator should see which cards are deliberate speculation).
- Approvals follow the autonomy ladder: T1 approval starts a build; T2+
  classes proceed without stopping here — the queue still *shows* them,
  before they ship, with a hold button (a hold is a recorded override).

## The Tasks page

`/tasks`, in the sidebar as **Tasks** once a task source is connected.
`/work` is an older address and redirects here: the Tower wrote that link
into notes and commit messages, and a 404 on a path that used to work is
worse than two paths for one page.

The one place that shows *what work is in progress across the portfolio right
now* ([`config/beads.README.md`](../config/beads.README.md)) — and the
place the operator acts on it, without reading it here and then opening a terminal.
The word on the page is **task** ([doc 14](14-design.md)): `bd` keeps its own
noun in the CLI and the ids, where it names the tool's object rather than
NoticeOS's.

**What it reads.** The newest task snapshot the local runner stored: the Tower
cannot reach the task database, so the runner reads every project once a minute and
posts the result ([how](../workers/ingest/README.md#beads-snapshots-the-task-hub-photograph)).
Only the **latest** snapshot is rendered; falling back to an older row would
hide exactly the failure the age chip exists to show.

**Layout** (`apps/tower/src/routes/tasks/TasksBoard.tsx`): the filter row, a
KPI strip, Your decisions, then every other task in one table, each row
expanding in place. A project the runner could not read is named in one banner
with Retry; before any snapshot the page links to Connect.

**The local Tower runs `bd` commands for the operator.** An agent still claims and
closes with `bd`, in the repo where the work is, because that is where the agent has
the context to report its work accurately. The operator should not need a second tool
for the most frequent action in the product, so the local Tower runs the
operator's `bd` commands: a short allowlist of verbs, every write
signed with the operator's name, nothing reachable from another site. The
verbs, the guards and the rejections are written once, in
[the Tower's task commands](../config/beads.README.md#the-towers-task-lane--the-operators-hands-not-an-agents).
**A deployed build keeps the snapshot board, and shows why**: it cannot run `bd`,
so the board falls back to the read-only snapshot rather than breaking, shows this
once in a banner, and leaves its write controls disabled.

**The operator can act on the board directly.**

- **The inbox is at the top of the page, across every project.** Your decisions sits at
  the top, because those rows are the only ones on
  this board that NoticeOS cannot move forward without the operator. Ordering is gate, then
  priority, then longest untouched, in the warn color. A question's actions are
  **Answer**, which opens a box under the row and runs `bd human
  respond`, writing the answer as a comment and closing the question — so an empty
  answer is never sent — and **Dismiss** (`bd human dismiss`, a permanent
  decline). A gate's action is neither: it is **Approve** (`bd gate resolve`),
  because releasing a wait condition is not answering a question. All three
  take effect after an Undo window (`lib/answer-queue.ts`).
- **Five filters, all stored in the URL** —
  `?project=&status=&priority=&label=&assignee=` (`useSearchParams`, the
  mechanism first used on `/alerts` and extended on `/assets`), so a narrowed board is
  a link that can be bookmarked or pasted into a task. Project, status, priority
  and assignee are `<select>`s with a count per option; label is free text. On
  the snapshot read the label field is not drawn (unless a link already set
  it) — the snapshot does not include labels, and a field that can never match
  anything is not a useful filter.
- **Every row starts with one mark** (✓ closed, ◦ parked or normal, ! for top or
  high priority in its tone) and **expands in place**: Claim (`bd update
  --claim`, atomic), Close (an inline REQUIRED reason —
  completion needs evidence, so the person closing cites what proves it), Defer (a date);
  its id links to `/tasks/:id`. The actions open in the row rather than a
  dialog: each one
  concerns the row the operator is looking at, and a modal would
  cover it. These writes are not Tower-local, so [doc 14](14-design.md)'s
  undo-over-confirm does not apply — principle 1 does: the inline field shows
  the change before the operator confirms it.
- **A status the board does not recognise** (one `bd` added) renders as its own
  raw value. The board never maps an unknown status onto a different one.
- **Live rows come from `bd` run by the local Tower, one read per project**, in
  `config/beads.json` order — untruncated, with labels, blocker-aware `ready`,
  and gate metadata. Epic containers are excluded from the rows and the counts,
  the same exclusion the snapshot makes, so the two reads always give the same
  numbers. A gate that resolves automatically (timer, `gh:run`) is not listed.
- **Closed-this-week always comes from the snapshot.** The local `bd` commands can list closed tasks
  but not "closed in the last seven days" — `bd list --status closed` is all
  time — so the closed-this-week figure reads the snapshot's seven-day window in
  both modes, and the figure has one source.

**`/tasks/:id` exists**, because the board links every row there and a link the
product itself produces must never return 404. **New task** opens the composer (below)
on `?new=1`.

**One board, two surfaces.** The board is
`TasksBoard` (`apps/tower/src/routes/tasks/TasksBoard.tsx`), and an
asset page's **Tasks** tab — `/assets/:id/tasks`, between Alerts and Activity —
renders that same component with `project` fixed to that asset's task project. It is not a
second board: the asset tab is the index with one prop set, so a claim, a close,
an answered question or a filter behaves identically on both, and the two cannot
diverge. The tab drops only what the page around it already shows —
the project `<select>`, the project clause in the summary line, the project name
on each inbox row, and the section's own name heading (the task PREFIX stays,
because the header does not show it and it is the part of an id the operator types).
The fixed project never enters the query string: it is set by the page, not by a control,
so a link copied from the tab includes only the filters the operator actually set.
A site with no
task project gets a designed empty state, *No task project for this site*, with
**Add a task project** — "nothing to do" and "this asset was never mapped
to a repo" are different facts, and only the first is good news.
The tab LABEL shows the asset's open-task count, with the inbox glyph beside it
when something there is waiting on the operator; an asset with no task project shows
no count at all, because an unknown count must not be shown as zero. **New task** is offered on the tab too, on the same `?new=1`: the
composer opens prefilled with that project and offers only that project,
so a task filed from an asset page always goes to that asset's project.

**The task page.** `/tasks/:id` is the page every monospace task id in the
Tower links to — the finding's filing badge, the query and page decision
rows, the asset timeline's resolved refs, and the task index — because
`HandoffBeadBadge`'s id is a link. The page shows the whole task —
description and acceptance criteria
rendered as Markdown, labels, assignee, priority, defer date, parent epic with
its `Meter` of children closed, blocked-by and blocks with each dependency's own
status glyph, the comments oldest-first with a composer, and a compact activity
timeline (filed, claimed, commented, closed). Status and priority are the
header's glyph-led chips in the lifecycle vocabulary (`STATUS_FACE`) — open circle,
in-progress dot, blocked ban, parked snowflake, closed tick — and because that
chip is the page's one *display* of each fact, the editors below it are controls
with no second chip beside them (doc 14). Every field saves in place through the
local `bd` commands with a toast that has **Undo** (doc 14 principle 5, the same pattern as
`KnobEditor`); **Claim** and **Close** are the two primary actions and a close
requires its reason, because completion needs evidence. A task filed from a Tower
handoff also links **back** to the section that produced it — `noticeos_kind` selects
the anchor (`#insights`, `#query-visibility`, `#page-decisions`) on
`noticeos_asset`'s page — so the `noticeos_*` metadata format
([`config/beads.README.md`](../config/beads.README.md) §Handoff metadata) can be
followed in both directions. Markdown is rendered by a small parser in the route
that produces React elements and never a string of HTML, so a `<script>` in a
task's description is always rendered as text, and only `http(s)`, `mailto:` and
site-relative links are created; the Tower has no Markdown dependency. A **deployed** build cannot run `bd`: the page renders the row
the once-a-minute snapshot holds with a note that the rest requires the local Tower, and shows Claim
and Close disabled with that reason.
**File a task with a button.** Every handoff the
Tower copies ends in a `bd create` command, and its last step — paste this into a
terminal open in the right repo — is the step where mistakes happen: filing from the
wrong directory files against the wrong asset, with no error and no way to move it.
`TaskComposer` is the operator's path to the *same* task. A **File task** button sits
beside Copy Markdown on the executive findings, the query decisions, the page
decisions and the alert rows on `/alerts`, and it is what **New task**
on `/tasks` opens for work no finding produced. It opens a slide-over prefilled
with the title, project, priority, labels and metadata that command contains,
because both are produced by one function (`taskHandoffPrefill`,
`apps/tower/src/lib/task-handoff.ts`); `test/task-composer.test.tsx` parses the
produced command back into fields and fails if they differ. On the index the composer
is a URL state (`?new=1`, the mechanism every filter there already uses) and
takes the **project filter** when one is set, so after narrowing the board to an
asset and pressing New task the operator does not choose the asset again. After filing,
the toast links the operator to the task's own page, `/tasks/<id>`.

Three things it deliberately does not do. It does **not** file on one click: a
person choosing which observations become commitments is what keeps
`bd ready` meaning "work somebody chose" (`config/beads.README.md`
§"Observations are not commitments"), so the composer shows what it will
file and waits for confirmation. It does **not** let the handoff labels or the `noticeos_*`
metadata be edited — they are the join key the snapshot reads and the
`HandoffBeadBadge` renders, and a task filed with a hand-edited `key:` is never
matched back to its row; the composer shows what the metadata *means* instead
("Linked to a finding"). And it does **not** replace Copy Markdown, which is the
agent's path, contains the whole evidence brief rather than only the task, and is
the only path in a deployed build — where the button renders disabled with
the deployed build's own explanation rather than disappearing.

An alert row files the `alert` handoff kind (each kind's key is in
[Handoff metadata](../config/beads.README.md#handoff-metadata)). Filing does not
change the flag's own lifecycle — *somebody is working on it* and *the condition
stopped* are different facts, so Mark read and Resolve keep exactly the meaning
they had. A **grouped** never-reported
row offers no File task at all: it represents several assets that
each have their own flag, so there is no single firing for `noticeos_key` to
identify, and work on a portfolio-wide condition is one task the operator writes
rather than one generated task per asset.

**The badge for the `page` and `alert` kinds**: a filed `page` task shows on
its page decision row (`PageDecisions`). No alert row draws the badge for an
`alert` task yet.

Tasks remain **coordination state, not signals** ([doc 01](01-architecture.md),
[doc 06](06-operations.md)): nothing on this board enters the nightly report envelope,
and a task's existence is never evidence about an asset.

**Task screens appear only with a connected task source.** A new installation has no task source, and then no screen
shows a task surface: no Tasks in the sidebar or the palette, no Needs attention tile
or Your decisions on Home, no task count on the Wall (its work chart shows Tasks unknown), no Tasks tab,
Needs attention or File task on a site, no Tasks column or Open tasks on Assets. Opening Tasks
by its address (or a site's Tasks tab, or a task page by link) shows one
link, **Connect a task source**, to the **Tasks** group on Integrations, where
each source is a row with one status and one action like every provider.
Beads is the first source. Its Connect opens the connect panel over
Integrations: the site, its task prefix and database, and
Connect, which saves the project through the `task-hub-spokes` declared list — the
same audited write Settings → Task projects makes — and then shows the host
steps with Copy while the panel shows Collecting, and Working once the runner
has read the project. After the first read, its Manage link opens Settings → Task projects, which
edits the saved rows.

*Connected is calculated, never stored:* for Beads, it means the runner's newest snapshot
read at least one task project. The runner reads the saved projects every
minute and stores a snapshot only when the task database was reachable, and an installation
with no project stores an empty one — so that one fact covers both "set up here"
and "reachable". An installation whose projects are saved but not yet read
shows the row as Collecting and still no task screen.

*The adapter boundary* is `apps/tower/worker/task-source.ts`: each source provides the same
data — whether it is connected, the board (`GET /api/work`), the Needs attention counts
(the Wall payload's `operator`, `null` without a source), a site's inbox — from
one read per request, and `GET /api/task-source` returns which source every task
screen shows. The actions a source allows are the `/api/tasks/*` contract
(`shared/tasks.ts`), served by the local Beads commands or read-only elsewhere. A
later source (Linear, GitHub Issues) is an adapter there and a row on
Integrations; an installation connected to Beads works exactly as before.

## The Registry — shipped changes

A reverse-chronological ledger of every shipped change, each row the full evidence
chain from [doc 05](05-execution-and-accountability.md):

- **Row:** shipped-at · asset · class · title · autonomy tier used · watch
  status (`watching n days left | cleared | reverted | frozen`) · predicted
  (as its change entry recorded it at ship) vs realized (once a later entry
  that supersedes it records one; interval, not point) · guard status.
- **Drill-down = the audit trail:** hypothesis card → build run (cost, model,
  tokens) → verifier evidence (re-executed checks, artifacts) → ship annotation
  → watch telemetry → attribution entry. The registry is also the random-
  audit UI — an audit is a careful re-read of this page by a reviewer.
- **Undo, per change, one click.** Every row has `Undo` for as long as its
  revert path is valid: confirmation + required reason → the Act step
  runs the revert (the same mechanism as auto-rollback), adds a timeline annotation,
  records the ledger close-out, and sends a signal to Learn (an operator undo is a strong
  negative label the calibration must include). Rows whose revert is no longer
  clean (later changes built on top) show this explicitly and offer
  "revert via new change" instead — the UI never presents an undo as cleaner
  than it is.

## The Runbook library

Per [doc 05](05-execution-and-accountability.md): every runbook with its
version, **diff since last approved version**, permission manifest, per-run
history (runs, escalations, failures), and one-click approve / revoke.
Reviewing here is what grants real-world capabilities (push/merge/spend) —
so this page is designed like a code review, not a settings toggle: the
operator sees exactly what they're authorizing before they authorize it.

## Adding an asset

**Add a site** — the Sites header, step 1 of Home's first-run card and the
sidebar — opens a dialog over the page with one field: the domain (`/assets/new` is the
Sites page with the dialog open). The name and icon are inferred, one optional button marks the site as not yet
launched, and Add writes the asset row and then commits its config entries as a
single changeset, then opens the asset's Data sources.

The flow, its rejections, the write order and the designed failure states are
specified once, in [doc 14](14-design.md); the routes it writes through are
in [the Tower's README](../apps/tower/README.md).

## Asset detail (drill-down)

### The page is tabbed, and each tab has its own URL

`/assets/:id` is **Overview**, and `/assets/:id/growth`, `/financials`,
`/search`, `/codebase`, `/health`, `/alerts`, `/tasks`, `/activity`, `/sources`, `/settings` are the
other ten (`apps/tower/src/routes/asset-detail/AssetTabs.tsx`; Tasks only once
a task source is connected). The person's view chooses which of them the bar
shows (`siteTabs` in `VIEW_LIBRARY`); a link to a tab the view leaves out still
opens it, drawn last in the bar. Above the bar, on every tab: the page header
(identity, source marks, the page-wide range). Below it, **only the active tab's
sections are mounted**, each tab reading its own view.

| Tab | What it holds |
|---|---|
| **Overview** | The data-setup banner with its ring while the asset is being set up, the lead numbers, the financial snapshot, open alerts, *What matters* (top three) and the asset's totals |
| **Growth** | Audience and search charts over the range, what else is collected, and product use |
| **Money** | This asset's ledger and P&L |
| **Search** | The tracked-panel board, query decisions, page decisions and the search context |
| **Codebase** | One sentence on how the code changed in 30 days beside the site's visitors, five figures (lines of code, repeated code, unused code, hard-to-change functions, test coverage by size), a row of three checks the site's own workflow sends (**Build**, **Tests**, **Vulnerable packages**), lines of code over time with deploys marked, the languages, and the latest report's findings (repeated blocks, hard-to-change functions, unused, vulnerable packages), each with **Make a task**; before the first report, the ways to send one ([doc 27](27-codebase-health.md)) |
| **Health** | The five facts of Home's Site health (Up, Speed, Errors, Search, Code) as five word buttons, each opening the readings behind it in place; a fact with no reading shows "Not measured yet" with the link that connects it (`HealthTab.tsx`) |
| **Alerts** | Open alerts, those no longer current, and history |
| **Tasks** | The Tasks board pinned to this asset's project |
| **Activity** | The timeline with its event composer and outcome-check composer, the Watches strip, link outreach — what happened on this asset |
| **Sources** | Data sources, the setup checklist, the scheduled jobs (on NoticeOS's own page only), daily metrics, site health |
| **Settings** | Asset management — see below, including **Tracked search terms** |

**Why tabs**: grouping sections by question (*"Where is growth moving?"*, *"What
happened before?"*, *"Can I trust the inputs?"*) is right, but in one very long
scroll of collapsed disclosures under a sticky navigator a new reader cannot
tell where they are, and a deep link into a collapsed section has to open
it programmatically before it can scroll. "Trust" is not used as a heading.

**A tab label shows the tab's state** (doc 14's visuals rule): Alerts
shows the open count beside a severity dot for the worst one, Activity the
number of outcome checks still running, Sources a severity dot for its worst
source (failing red, overdue amber) with the tally on hover. A tab
with no state to show has only its name.

### The Settings tab manages the tracked panels

A **Tracked search terms** card on the Settings tab edits the two documents
that define the panel; the Search tab keeps the tracked-panel board
that shows the panel's results:

- **Tracked queries** — the terms the weekly DataForSEO collection buys a live result
  page for ([`config/serp-panel.json`](../config/serp-panel.README.md)). Add,
  relabel with the bet the term measures, remove; one changeset each, with its
  Undo.
- **Panel refresh** — this asset's row on the standing refresh roster
  ([`config/signal-panels.json`](../config/signal-panels.README.md)): on or off,
  the reason, the note, the date.
- **Collect now** — collects this site's tracked terms immediately, outside
  the Monday run, for example after a missed week. Pressing it opens the
  price first: the panel's cost on its last run for this site (**Last run**,
  or **At most** with what the budget gate reserves for one report family
  when there is no recorded price) and **This month**, the month's data spend against the cap,
  read from the stored run records. **Collect** runs only this site's SERP
  panel, through the same collector and budget gate as the Monday run. When
  the reserve would cross the monthly data cap, the card shows **Over the
  monthly data cap** and **Collect** is disabled; a press sent to the ingest
  anyway starts nothing and buys nothing. No MCP tool starts a collection.

Three things about it are deliberate design decisions:

- **The cost is shown where the operator adds a term.** A tracked term is more than a
  setting — it is a recurring weekly cost *and* a recurring weekly review
  task — so above the Add control the section shows the panel's own weekly
  cost and its size against the query ceiling as a **meter**, and names the limit
  that already exists: the portfolio's monthly data cap on `/settings`, which the
  collector reserves against before every family and fails closed under. **There is no
  second spending limit**, and the price is not a per-row column: every term
  costs the same two calls, so twenty-eight identical cells would show one fact
  twenty-eight times (doc 14). The ceiling is enforced in the form as
  well as by the collector, so a term over it cannot be saved to the file and make
  the whole panel fail on the following Monday. The refresh roster has no meter at
  all, because a refresh pass makes zero provider calls at any cadence.
- **An asset with no panel is a valid state, and the card leaves it so until a term is added.** Adding
  a site deliberately writes nothing to
  `config/serp-panel.json` at creation; here, the first term added creates the
  asset's whole entry, and removing the last term removes the entry rather
  than leaving an empty list — which the collector rejects and which a person
  cannot read as either "buys a panel" or "does not".
- **The roster row may be changed but not removed.** Membership there is an
  invariant — every asset has a row, including the ones that are off — so the row
  is never removed: a site is archived, never deleted (see **No Delete** below),
  and the only Add this section offers is the one that restores a missing row.

### The setup checklist

An asset in `onboarding` or `baselining` shows **what is left
before it goes live** on its Data sources tab: identity, its data sources (each with its own state
and, for a skipped one, its reason), the first nightly report, and the 28-day
baseline — or, for a site that has never sent a nightly report, the report as
one optional, uncounted step. Each row is a glyph, the current state in
one sentence, and a link to
where the work is done — the Settings tab, the Data sources tab, `/health` for the
baseline.

The same items are a small **ring** on the Overview's *Data setup* banner, with
**Review data setup** beside it: one arc per counted item, filled as items
are completed, with the whole sentence in its hover. Both views come from one
function (`apps/tower/shared/asset-setup.ts`), and it returns nothing at all for
a live asset — so the ring and the panel always disappear together, rather
than each surface applying its own test.

The banner is at the top of the Overview, above *What matters now*, on purpose:
findings are ranked from evidence, and a two-week-old asset has almost none,
so on exactly the assets this panel is for, the section beneath it is always
empty. Nothing here can be ticked by hand — every line is derived from the asset's
own state, and a box the operator could tick without doing the work could
show a step as done when it is not. The four items, the exit test they use, and
why the Wall does not draw the ring are specified in
[doc 14](14-design.md).

**Deep links keep working.** Every anchor the page has ever produced —
`#setup`, `#insights`, `#growth-evidence`, `#performance`, `#query-visibility`,
`#page-decisions`, `#product-use`, `#alerts`, `#alert-history`, `#timeline`,
`#details`, `#integrations`, `#configuration` — maps to its tab: the hash
selects the tab (a `replace` navigation, so Back still leaves the page), then
scrolls to the section where a section still has that id (`#alerts`, `#alert-history`
and `#details` only select their tab). A hash the page does not recognise is left unchanged. The
outcome-check composer opened from a Growth row switches to Activity and is
prefilled there; the prefill state is held at the route, so it is kept across the switch.

### The Settings tab is asset management

Nine sections — the seven below, plus **Card totals** (`config/counters.json`)
and **Tracked search terms** (above) — each field saving in place through the
config write path with an Undo, and a stale write rejected with a visible message:

- **Identity** — the **display name saves in place** (a store column, so it works
  in every deployment; the write invalidates the wall and asset-detail reads, so
  the sidebar, Home's assets table and this page's header update without a
  reload). Domain and asset id are read-only and each shows the ONE reason it
  cannot change: every stored observation was collected against that host, and the
  id is the key the store keeps this asset's whole history under. For a site
  with a domain that is not retired, **Icons** shows the light and dark icon every screen draws,
  each on a white and a black square, the outcome and time of the newest read
  of the home page, and **Read again**, which runs the 04:00 job's icon read
  for this site now through the ingest (`POST /api/assets/<id>/icons`).
  **Light icon** and **Dark icon** save an address to the site's row of
  `config/tower.json` `/sites`; the Tower builds every card's icons with that
  address in place of the read one.
- **Lifecycle** — the stepper is the one display of the current stage; a
  *"Change stage…"* picker selects a target stage and saves `assets.status` through the
  store write path, which works in every deployment.
- **Automation** — the `sense_only` toggle, where the selected segment has
  the state's color and dot rather than a chip beside it.
- **Data collection** — the fetch endpoint and the nightly-fetch switch save
  the `pull.json` document to the store in any deployment; cadence is a
  link to `/settings#data-collection`, and wire format, auth source, last report
  and the metric map stay read-only, each showing where it is set.
- **Alert rules in force** — the thresholds this asset is checked against,
  **read-only**, with one line each linking to `/settings#alert-rules` and
  `/settings#budget`, because every one of them is portfolio-wide. The values
  are still shown here (doc 14); the editor is on the page where the scope is obvious.
  **This tab has no editor**, and Tune rule on the alerts above does not
  change that. The difference between the two
  is the evidence Tune shows, not where it appears: a permanent set of fields on one asset's page
  would lead the operator to make a portfolio-wide edit that looks like an asset setting, whereas Tune
  is opened deliberately from one firing, shows the portfolio scope first, and
  exists to show what a change would have done — which is the reason to change
  these values at all, and the one thing neither this tab nor `/settings` can
  show.
- **Archive** — the one action here whose effects reach beyond the Tower, so it follows doc 14
  principle 1 rather than principle 5: an inline confirmation lists what stops as
  glyph rows (data collection, alerts, its card on Home and the TV dashboard)
  *before* it sets `assets.status` to `retired`. A retired asset shows
  **Restore** in its place, resuming monitoring. An explicit pre-launch hold is preserved.
- **Lifecycle is derived from collected data.** Before collection has recorded
  data the site is **Onboarding**; afterwards it is **Live**. The calculation
  reads stored collection history rather than a recent chart window. A source
  failure affects health without erasing the start of collection. Settings
  shows the computed stage and no progress-stage picker. **Begin monitoring**
  releases an explicit **Pre-launch** hold. **Archive** and **Restore** record
  human decisions as `config` annotations with `lifecycle:<from>><to>` refs.
  Restore reads the most recent archive to preserve a pre-launch hold;
  otherwise the active stage is computed again from collection history.
  Historical stage annotations remain on Activity.
- **No Delete** — a site is never deleted, a mistaken add included: the store
  is history, and the Postgres model gives the application no DELETE on a site
  ([`db/postgres/README.md`](../db/postgres/README.md)). Archive is the only
  way to take a site out of use. Adding the domain again shows *Already added* and opens the site
  that has that domain — by the id stored for it, which for an imported site can
  be a different id — at its Restore card (`#restore`) when it is archived.

The tabs give an executive view of the asset, ordered by the
operator's questions rather than by how the system is built:

1. identity/health, with the same working/error/unconfigured source icons in
   the header row as the Sites table's State cell;
2. a stacked performance view over the page-wide range (7, 28 or 90 days, 28
   by default): GA4 daily active-user bars, then
   separate date-aligned Google/Bing web-search clicks and impressions.
   Sunday-start weekly bands remain aligned across all charts; the longer axis
   labels calendar months to avoid thirteen colliding week captions. A
   responsive query-decision table follows with one row per normalized query.
   Each row shows whether to act, investigate, protect, or wait; names the
   concrete condition; keeps the source evidence visible; and proposes one
   bounded next step. A low-contrast row rail, surface, icon, and chip treatment
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
   Whether a query has been picked up is shown by the
   **task somebody filed from it**, not by whether the operator copied its
   Markdown. The row renders the same `HandoffBeadBadge` the
   finding card does — task id plus open/closed, muted, no state word — joined
   by the handoff's own `noticeos_key` through the task snapshot, so it appears
   within one snapshot cycle of the `bd create` actually being run. A filed row
   sorts *below* unfiled rows inside its own priority band and the
   rows shown before the list is expanded use an unfiled example of a decision kind where one exists, so work nobody has picked
   up always stays on top. A row with no task renders **no filing
   marker at all**. `decisions` stores only its own display states,
   `marked` and `dismissed`.
   The searcher's
   intent and the number of visits the current rank is worth are the
   inputs an act-vs-wait judgement is made from. The intent renders as a
   short lowercase token beside the query — it describes the query, so it is
   deliberately not a second chip of equal weight beside the decision chip — and the
   visit estimate is added to the market evidence line as modelled demand, never
   merged with observed impressions.
   Where an asset runs a tracked
   SERP panel ([doc 08 §S1b](08-seo-geo-signals.md)), the query table no longer
   recommends copy changes that searchers will not see. Two rules are added to the nine
   positional ones, and both deliberately recommend doing *less*: a decision that
   would have recommended "sharpen the title" on a query whose AI Overview does not
   cite the site moves from **act** to **investigate** — the searcher's click goes
   to the AI Overview above the results, so a rewrite causes churn and gains no visits — and a query the overview
   *does* cite becomes **protect** whichever way its rank is moving, because the
   most reliable way to lose a citation is to rewrite the cited passage.
   A decline is still shown: it is included in the protect recommendation.
   The evidence is a **✧** glyph beside the decision chip, in three styles — solid
   for cited, outline for shown-and-not-cited, faded for a result page read with no
   overview on it. No severity color: an AI Overview is a fact about the result
   page, not an alert. The glyph is absent for an untracked query, which is
   why the checked-and-clear case gets its own faded mark rather than nothing —
   no glyph must always mean *unknown*. Untracked queries, and queries whose
   overview failed to load, are handled exactly as they were before the panel existed.
   Below the three headline charts, an
   **Also collected** row draws more of the data the 15-minute collectors
   write: GA4 sessions, page views, and events, plus
   Search Console click rate and average position. Each is a label, a current
   value, and one neutral `Spark` — smaller than the charts above, because it gives
   context for them and is not meant to be read first. Average position
   is lower-is-better, so its direction chip shows *improvement*, the same
   inversion the query table already applies: an up arrow means improvement
   on every surface even where the underlying number fell, and the tile also shows this
   in words. A series with fewer than three observations is omitted rather than
   drawn as an empty tile;
3. **What matters now**: one responsive, color-coded decision list of deterministic
   warning signs, recommendations, discoveries, and product insights derived
   from the daily GA4/GSC/BWT and weekly DataForSEO archives. Every row shows
   priority/type, finding, meaning/next move, and proof/handoff. The DataForSEO
   context strip is the Search tab's **Search context**, with traffic value first.
   A finding whose
   handoff somebody actually filed shows that task — its id and whether it
   is still open — as a small muted marker in the proof/handoff cell, joined by
   the `noticeos_key` the handoff wrote into the task's metadata
   ([§Handoff metadata](../config/beads.README.md#handoff-metadata)) and read from the same
   once-a-minute `beads_snapshots` snapshot the Tasks board uses. A
   closed task is shown as **shipped, not proven** and never removes the finding —
   only a watch-window result does — and a finding with no task, or an asset
   the snapshot could not read, shows nothing at all;
4. active alert lifecycle, nightly-report metrics, booked P&L, the annotation
   timeline, and the outcome checks registered against it;
5. full integration evidence;
6. **Settings**, the asset's own management tab (see above).

**Page decisions** is the query table's counterpart at the
level an operator edits: one row per page present in both seven-date Search
Console windows, in the same act / investigate / protect / wait categories, with the
same evidence-and-next-step columns and the same copyable `bd create` handoff.
It shares the query table's decision categories and none of its rules — a page is
judged on movement in its own clicks, impressions, and average position — and it
applies the two tracked-panel rules through the page's leading query, so a page
whose largest query has an AI Overview above the results is moved out of the copy-work
category exactly as that query is. The page data has no query dimension, so
its totals cannot be grounding-decontaminated; the row shows the exclusion
applied to the leading-query join instead, labelled so nobody reads it as a
correction to the numbers above it. A page row has the same filed-task badge
as the query table, joined on the page URL: `page` is a handoff kind in every
list that must match — the code that writes handoffs, the snapshot reader, the ingest validator, and the
Tower's own reader — and a test in `scripts/handoff-kinds.test.mjs`
fails the build when one of them is missing a kind (the fourth kind is `alert`).
Every anchor on the page also works as an inbound deep link, so a link mailed or pasted from
elsewhere opens the named section rather than doing nothing. The
Data sources list's **Connect account** opens `/integrations`.

**Every data source card shows that asset's own part of the integration, editable in
place**. Under the status — the
doc-14 disclosure order puts configuration below the status — each card has a
**Mapping** section (*Market* for DataForSEO), with two things:

- **The mapping** — which GA4 property this asset is, which Search Console or
  Bing site, which DataForSEO location and language. Each field is validated by
  the `asset-lane` declaration before it is sent and again when it is received, so a
  pasted `properties/123456789` is rejected with a message *naming the field* rather than
  becoming next Monday's collector error. **The collectors read these
  fields**, and each card shows which of two statements
  is true of THIS asset: a mapped data source shows that the collector requests this value, an
  unmapped one names the source it still falls back to (the Google credential's
  own property map, the asset's own domain, the US/English DataForSEO baseline).
  Both show when a save takes effect — the next collection run where the Workers
  read the stored document, the next restart while they read the copy compiled
  into them. A description that overstates a field's effect is worse than
  no description.
- **The setup state**, limited to the two states an operator actually sets: *Not
  set up* and *Skipped*, offered as **Not using** (with its reason) and **Use
  again**. **This choice does not change the state chip above.** Working, Overdue
  and Failing are read from the latest collector run and Not applicable from
  the catalog's scope rule, so none is offered as a choice — NoticeOS has
  no manual health toggle and this does not add one. Choosing Not using is rejected
  until a reason is entered, which enforces `config/integrations.json`'s own
  invariant before the write rather than after it.

**One action per row, and no checklist.** The row's status — the connection model's `laneStatus`
(`apps/tower/shared/connection-status.ts`) — shows whether setup is done, so the card has
no setup checklist and no docs path, and its section is named for its content
(*Mapping*, or *Market* for DataForSEO). A row shows a status or exactly one
action: **Connect**, which for a provider that connects in the panel opens that
panel over the site's own page with the site first
(`apps/tower/src/routes/integrations/ProviderConnectPanel.tsx`, the same panel
`/integrations` opens), or **Fix** on a failing source. DataForSEO's location
and language codes are one **Market** select, by name
(`apps/tower/shared/site-markets.ts`), both codes written in one save. The
Google picker's state beside its box is a short value — *Reading Google…*,
*No response from Google*, *Google returned no list*, *No GA4 properties* — never a
sentence instructing the operator to type.

**The two Google fields have a picker.** The connected
account's own list —
`GET /api/integrations/google/properties`, one read shared by both cards — fills
them, showing each property's name, its account or permission level, and the
`ref` that actually gets stored, because a collector error message names the
ref. Picking writes the same `file-json-set` at the same pointer as typing in the box,
with the same validation and the same Undo. **The text box always remains**: a
service-account install has no sign-in to query, a property the account cannot see
is in no list, and a failed lookup must not block the operator — so a
data source whose list is missing shows why in one line and stays typable, and a picker
that has a list keeps a *Not in the list? Type it instead* disclosure under it. A
value the file holds but the account does not list stays selected, labelled as
not in the connected account, so opening the picker never suggests
replacing it.

**The GA4 card also shows what this asset has DECLARED about its GA4
property, editable in place**: the events it
calls **value events** ([`config/value-events.json`](../config/value-events.README.md))
and the event parameters already registered as **custom dimensions**
([`config/ga4-custom-dimensions.json`](../config/ga4-custom-dimensions.README.md)).
Both control what the collectors do here — the first is what the nightly read compares against
GA4's own key-event counts, the second is what makes the JavaScript-error archive
include this asset at all rather than skip it without notice — so each list shows that
effect on its own line rather than only its file name. They are on the GA4
card because the card already shows *whether this data source is working*, and these lists
configure what that data source collects; placing configuration below the status follows the doc-14
disclosure order and does not make it less important. **Neither list changes anything in GA4.** The measurement
channel is operator-only by invariant: listing an event does not make it a key
event, listing a parameter does not register a dimension, and a row for a
dimension nobody registered still makes the collector fail with a visible error rather than
record an empty success. An asset with no entry — the state most assets are in,
because absence in these files means *not declared* — shows an empty list with
**Add**, and that first row creates the asset's own entry, because a write at a
pointer never creates the structure that contains it. On a build with no config write path the pair shows the deployment's
message **once** above both, rather than once in each table.

Two facts about evidence. First, the **nightly archive collection** —
the largest collector NoticeOS runs — shows its per-provider
health as an additional evidence line on the GA4, Search Console, and
Bing Webmaster data sources it belongs to, in the integrations matrix (`IntegrationMatrix`) and on the asset page. It
is supporting evidence and does not set the state: the 15-minute collector is the fresher and more direct
observation of the same feed, so it still sets the data source's state, and the
standing rule holds — a data source's state comes only from its own observations, and
it shows nothing at all where it has none. Second, **System health** and
**Settings** show a month-to-date meter for the one data source that costs money to read:
**Data spend**, $X of $Y in the month, against the portfolio `monthly_caps.data_usd`
that fails closed. When that cap is what stopped a pull, the DataForSEO data source shows
that reason in those words rather than reporting a provider error — a limit that
worked and an outage are different events, and showing NoticeOS's own
limit as a provider error would send the operator to the wrong place.

Each executive finding keeps its source report, evidence window, primary
magnitude, why-it-matters explanation, confidence, exact evidence, and
limitation attached. The scan row keeps the interpretation, why it matters,
primary proof, and Copy Markdown handoff visible; detailed facts and limitations
expand in place. Error red identifies warning signs, warn amber identifies
recommendations, info identifies discoveries, and general insights stay
neutral—these colors help scanning and do not indicate an alert lifecycle state. Marked findings are pinned to
the top. Dismissed findings leave the active list but can be restored.
Those decisions are stored per asset, not
per browser: they are recorded in the store and appear on
every screen the operator opens. They do not resolve alerts or edit the
immutable snapshot. The list applies each one optimistically and restores the
finding if the write fails, and the first time a device with older
browser-local preferences opens an asset whose record is empty, it copies
those preferences into the store without notice and deletes its local copy.
A **Copy Markdown** action serializes
the complete contract—kind, claim, summary, primary metric, why it matters,
evidence, raw source ids, window, confidence, and limitation—for an
implementation agent without detaching the recommendation from its evidence.
The shared copy helper uses the modern Clipboard API on secure origins and a
temporary selected textarea during the same click gesture on plain-HTTP LAN
origins such as `<machine>.local`.
Missing provider rows remain unknown and can never produce a deprecation
recommendation. These rows are interpretations, not flags or causal claims;
alerts retain their own operator lifecycle, and deploy annotations and outcome
checks still determine whether an action worked.

Raw provider rows remain in private R2. The offline analyzer publishes only a
compact, content-addressed snapshot—including bounded per-provider query
movers and current search-intelligence summary—to Postgres, which keeps to the rule
that the Tower renders from the central store (the live reads are listed under
Build notes).

### Timeline: recording a change, and watching what it did

The Timeline's **Record** action opens one form with two choices, **Something
happened** and **Watch an outcome**. Something happened has three fields: what happened (the
six schema kinds, in doc 14's words), when, and a description. Backdating is
expected, not an edge case — a title batch is annotated on
the day it shipped even when it is written down a month later — so the time
field is prefilled
with the current time and stays editable, and a time in the future is rejected, because an
event cannot be recorded as happening after the outcomes it explains. Posting
an identical event again does not create a second event.

Below the timeline, a **Watches** strip lists the pre-registered outcome checks
running against this asset ([doc 03](03-attribution.md)): the measured series,
the next due check date, and how many of the registered checks have been read;
then the recently closed ones with their results. It is read-only — registration
and evaluation both run in the ingest worker — and
it renders nothing at all when no outcome check exists, because an empty section
with no way to create a check would give the operator nothing to do.

### Link outreach: the reclamation pipeline as state

An asset that has run a broken-link reclamation campaign (find the lost link,
pitch the linking page, track the reply) gets a **Link outreach**
panel on its Activity tab: a single funnel line — *to pitch → sent → opened →
clicked → replied → link updated* — followed by the ten targets that moved most
recently, each with its domain, stage, and the date it reached it. A stage with
no rows is omitted rather than printed as a zero, because an unstarted stage is
not a measurement. The two exits from the funnel — hosts marked never-pitch, and
targets whose broken link has since gone from the page — follow as one line of
small muted text with the campaign total, since neither is work in progress.

The state it shows is stored in `noticeos.reclamation_targets`; a target list
with no status columns and send state kept in prose cannot enforce the
playbook's own conversion band or its no-double-pitch rule.

**No write UI, deliberately.** Status changes arrive through
`scripts/reclamation-import.mjs` (an idempotent import through the ingest
Worker's write route, `--dry-run` to review it first), and a link is marked *won* only when a person confirms the change on the page —
never by a rule. `scripts/signal-insights.mjs`'s `reclamation-match` rule can detect
that an open target has started sending referral traffic and show it as a
discovery for the operator to check; the rule marks nothing. If a campaign counted
its own wins, its results could not be fairly compared with the conversion band
that determines whether to run the next wave. As with
the Watches strip, the section renders nothing for an asset with no campaign.

Planned asset-page additions: context-pack
status, concentration risk, and queue/registry slices.

## Phone mode

Three tasks only, each quick: approve/veto from the queue, mark alerts read/resolve, and
the **kill switch** (behind confirmation; runs the [doc 06](06-operations.md)
procedure). The target is that each can be done one-handed on a phone in under 15 seconds.
The kill switch is the one of the three that does not exist yet: doc 06's
mechanism is not built, so no Tower page offers it.

**The phone layout is the same Tower pages, reflowed** — no separate mobile app, no second
component set ([doc 14](14-design.md)), and nothing
hidden at 390px that a desktop browser shows. Below `md` the sidebar becomes a top bar
with a menu button opening the same nav as a drawer, with the asset list
collapsed (a drawer is opened to go to one place). Below `sm` four things change,
each declared once:

| What | Where it is declared | Why |
|---|---|---|
| A wide table reflows into one labelled card per row — keyed to the table's own box (a container query under 40rem), not the screen | `stacked` on `Table` (`components/ui/table.tsx`), with `label` on each `TableCell` | Every table already scrolled inside its own box, so no page ever scrolled sideways — but Resolve sat 87px past the right edge of `/alerts` and Home's nine-column row showed two and a half columns. The card has every cell, each after its own column name |
| The tab strip is one line that scrolls inside itself | `components/Tabs.tsx` | Nine asset tabs would wrap into uneven rows whose selected underline would be drawn above the divider instead of on it. The strip scrolls; the page never does, and the selected tab is scrolled into view |
| Every button, field and nav row is at least 44px | `max-sm:min-h-11` in `ui/button.tsx`, `ui/command.tsx`, the field styling, and `max-md:min-h-11` in `AppShell` | The desktop sizes were set for a mouse pointer: 36px, 32px, 30px |
| A config list past **eight rows** gets a filter box, and collapses each row to one line | `NARROWS_FROM` in `components/CollectionEditor.tsx`, over `foldedWhenStacked` / `foldWhenStacked` / `onlyWhenStacked` on `Table` | The reflow above uses height in place of width, and a long list uses a lot of height: a page with one long list runs to roughly 33 screens at 390×844. Nothing is hidden — a collapsed row is one line (its key, its second column, a chevron) until it is opened, and opening it shows every field at the 44px minimum. On a phone a row is found by searching rather than scrolling, which is what the filter box is for |

Every Tower page route is reviewed at 390×844 and 430×932. The structural checks — which classes control which reflow — are
tested in `apps/tower/test/components.test.tsx`, because jsdom has no layout and
the regression most likely to go unnoticed is a class somebody deleted while tidying. One
horizontal scroller is deliberate and stays: the tab strip.

## Build notes

### How a page loads and stays current

A production installation's image builds the Tower once (`vite build`), and its
server sends a browser that bundle: React's production build, the app's code
bundled by page and its icons in one file (`apps/tower/vite/built-client.ts`). It serves the bundle only when the bundle
was built from the source the server runs; a development stack, which follows
a checkout, serves the source modules. Every reply of 1 KB or more in JSON,
JavaScript, CSS, HTML or SVG is compressed with Brotli or gzip, except the
event stream below (`apps/tower/vite/compress-replies.ts`).

A page starts every read its first screen draws from at once and draws when
they have all answered, or after four seconds, whichever comes first
(`apps/tower/src/hooks/useFirstDraw.ts`); a later read never returns it to its
loading state. The Tasks page draws each project's live rows, not the saved
snapshot first and the live rows over it.

Every successful JSON read carries a validator: a hash of its content without
the time it was made (`generatedAt`, `readAt`, `capturedAt`). A browser that
sends the validator back and would receive the same content is answered 304
with no body, and the page uses the copy it holds in memory with the new times
(`apps/tower/shared/read-validator.ts`). Replies stay `no-store`, so the
browser's own cache holds none of them.

On a standalone installation, while any page is open, the Tower reads the task
snapshot, the sites' payload, the live feed and source health every 15 seconds
and sends every open page the names of the ones that changed, over one event
stream (`GET /api/changes`, `apps/tower/shared/change-topics.ts`). A page reads
again only what changed and stops polling those four while the stream is open;
when the stream drops it polls again, and when the stream returns it reads all
four once. One browser tab holds the stream and passes its events to the
Tower's other tabs in that browser. A hosted workspace has no stream and polls.

### What the Tower reads and writes

Tower render data comes from the central store, except two live reads the
ingest Worker makes on request from the Tower — GA4 realtime (`/api/ga4/realtime`)
and the calendar feeds — because the scheduled jobs have already collected and paid for everything else and
the Tower must be fast and cheap to leave on a TV all day. The narrow
alert-lifecycle endpoint writes only the existing flag's disposition/resolution
fields (`snooze_until` included, `ack_expiry` cleared), on every open firing
of a recurring condition at once, plus a `flag_tunes` row for a tune
(`apps/tower/worker/flag-actions.ts`). Its validation is in
`apps/tower/worker/flag-route.ts` rather than inline in the router — a date has
rules (in the future, inside a 90-day horizon, stored normalized; the horizon is
`apps/tower/shared/snooze.ts`), and validation
that no test can reach tends to become wrong without anyone noticing. Because snooze is the one
disposition that **expires**, what counts as an open alert is
time-dependent, and `packages/contract/src/flag-open.ts` is the single SQL
definition every payload uses (re-exported by `apps/tower/worker/flag-scope.ts`). A second narrow
endpoint writes only the operator's own decisions —
`POST/DELETE /api/assets/:id/decisions`, one current row per asset + query
or finding (`noticeos.decisions`), same-origin only. It stores
what the operator *decided*, never what a provider *observed*: an absent row
means untouched, a cleared decision is deleted rather than tombstoned, and no
evidence table is touched. Repeating a decision is idempotent, so the record
keeps when a judgement was first made and when it last actually changed —
which is what the Learn step grades predictions against. A third narrow
endpoint records one timeline annotation —
`POST /api/assets/:id/annotations`, same-origin only, sharing the same guard and
error codes. Like the outcome-check windows, an asset's editable columns, an
asset's creation and removal, credentials and config, it is an operator write
the Tower does **not** perform
itself: the row is written by the ingest worker, the only writer of the `annotations`
table, through `createAnnotation()` on its WorkerEntrypoint — the private INGEST
Service Binding, beside the GA4 realtime read. The canonical
route, ingest's `POST /api/annotations`, requires `env.OPERATOR_TOKEN`, and the
Tower is served without authentication on the trusted LAN — holding the operator bearer token
there would make every operator-authenticated ingest route reachable by a single request from the LAN. Over the
binding, access to the binding is the permission and no credential is sent. The
kind list, backdating rule, `(asset, at, kind, ref)` identity and field
caps are defined in one place (`workers/ingest/src/annotations.ts`); the Tower
route keeps only the same-origin guard, the JSON envelope, and the mapping from
ingest's write result to its own error codes.
Auto-refresh polls the store. TV mode is a route (`/wall`) with no navigation or header; the
access proxy the standalone operator provides covers both. Hosted access
must cover both through the workspace authority in doc 23.
