# The phone's first screen is the page's answer (2026-09-24, bead `ro-ujb9.13`)

The operator reads the Tower on a phone, has ADHD, and needs the state at a
glance with no words. At 390×844 four pages spent their first screen on
machinery — strips two rows deep, rows of selects, a site card per screen —
before the thing the page exists to show. Rows that open, rows that expand and
rows that do nothing looked alike on a touch screen with no hover to tell them
apart. This brief measures that, records how three best-in-class products
handle the same screen, and states the rule once. The rule is built in the
shared components, so every page that uses them follows.

Captures, the capture script and both measurement reports:
`docs/artifacts/mobile-first-screen-2026-09-24/` (private historical evidence).
The rule itself is doc 21's acceptance line
["The phone's first screen is the page's answer"](../21-surface-design.md#acceptance-for-any-surface-built-to-this-doc).

## What the phone showed (before)

Isolated journey fixture, 390×844, dark. "One site" is `journey.example` with
Bing collected, the task source connected, one finding and a failing uptime
check (one open error alert). "Several" adds two more sites and 84 days of ad
revenue. The **answer** is the first thing the page exists to show: a site row
on Sites, an alert on Alerts, a task on Tasks, and on Home the first thing that
needs you (the Needs you or Open alerts figure, or a Waiting on you row).
"Page controls" leaves out a KPI's own ⓘ and selection.

| Page | Sites | Answer starts at | Page controls above it | Answer rows on the first screen | Rows whose look and action disagree |
|---|---|---|---|---|---|
| Home | one | **942px** (below the screen) | 2 (the site link, View data) | 0 of 5 | 0 |
| Home | several | 336px | 0 | 4 of 5 | 3 (site cards open with nothing saying so) |
| Sites | one | 131px | 1 | 1 of 1 | 1 |
| Sites | several | 243px | 5 | **1 of 3** (a site card was 330px) | 3 |
| Alerts | one / several | **655 / 707px** | 4 / 5 (tabs and 2–3 selects) | 1 of 1 | 0 |
| Tasks | one / several | **630px** | 5 (New task, 3 selects, a label box) | 1 of 2 | 0 |

What caused it, in the shared parts:

1. **The KPI strip stacked two columns deep on a phone.** Alerts' six KPIs took
   380px and Tasks' six 330px before the list. Home's three status KPIs left an
   empty grey fourth cell (capture; private historical evidence).
2. **Every filter was always out.** Alerts drew two rows of selects, Tasks four
   selects and a text box, all above the list. Only Sites folded its filters,
   by hand, in its own code.
3. **A site on a phone was a 330px card of eight labelled lines**, so Sites'
   first screen held one of three sites
   (capture; private historical evidence).
   The card opened the site on a tap but showed no mark saying so: the table's
   chevron cell was dropped on phones as "chrome".
4. **Home stacked in desk order.** With one site the site's chart came first and
   Needs you / Open alerts landed at 942px, off the screen
   (capture; private historical evidence).
5. **A row that opens a page ended in ↗**, which reads as "leaves the product",
   and is also the leading glyph for a recommendation row. Rows that expand end
   in ⌄; a static row has neither. The three grammars existed (bead
   `ro-ujb9.13`'s first pass, `f206d48`) but a table row that opens had none.
6. **Sidebar site names were cut with an ellipsis** that a thumb cannot open;
   the full name only lived in a desktop hover.

## Prior art

Researched 2026-09-24. Three products an operator uses on a phone, plus the
platform rule for a row that opens.

- **Plausible Analytics — top stats half-width, filters behind one button.**
  The top stats are one row on a desk and half-width cells on a phone
  (`w-1/2 … lg:w-auto` in `top-stats.js`), and "you can click on a particular
  metric to display it in the top graph". The filter bar keeps the pills that
  fit and folds the rest into one button with a `+N` badge ("See 2 more filters
  and actions").
  https://plausible.io/docs/guided-tour ·
  https://github.com/plausible/analytics/blob/master/assets/js/dashboard/stats/graph/top-stats.js ·
  https://github.com/plausible/analytics/blob/master/assets/js/dashboard/nav-menu/filters-bar.tsx
- **Linear — the list first, options behind one button.** The mobile app opens
  on the inbox ("the inbox keeps you informed about high-priority tasks … tap to
  take action"). On any view, grouping, ordering and properties sit behind one
  Display options button at the top right.
  https://linear.app/mobile · https://linear.app/docs/display-options ·
  https://linear.app/docs/inbox
- **Vercel Web Analytics — metrics as tabs over one chart, the period in view.**
  Visitors, Page Views and Bounce rate are tabs above one chart; the timeframe
  stays in a dropdown at the top right; panels show the top entries with View
  All.
  https://vercel.com/docs/analytics
- **Apple Human Interface Guidelines — the disclosure indicator.** "If you need
  to let people drill into a list or table row's subviews, use a disclosure
  indicator accessory control" — the › chevron; an info button reveals details
  and does not navigate.
  https://developer.apple.com/design/human-interface-guidelines/lists-and-tables

**Adopted:**

- Plausible's and Vercel's strip: on a phone the KPIs are **one row**. Up to
  three share it; four or more swipe a cell and a half per screen, the selected
  one brought into view so the chart under it never names a KPI you cannot see.
- Plausible's and Linear's fold: **filters and sort sit behind one Filters
  button** that carries how many are on. The period stays in view (Plausible,
  Vercel): it changes what every number means.
- Linear's inbox-first order: **Home on a phone leads with what needs you**.
- Apple's disclosure indicator: **› opens, ⌄ expands, no mark does nothing.**
  A table row that opens draws its › on the phone card.

## The rule (doc 21's acceptance line)

At 390×844 the first screen holds the page's answer:

1. **The answer first.** The first answer row starts in the top half of the
   screen (≤ 422px). Above it: the header's one primary action, one Filters
   press, a period and a tab bar — nothing else.
2. **Controls fold behind one press** (`FilterBar`); the button carries the
   number of filters on; a period stays in view.
3. **A strip is one row** (`KpiStrip`): three KPIs side by side, four or more
   swipe with the selected one in view.
4. **A row that looks interactive is interactive, and one that is not looks
   static** (`ListRow`, `TableRow opens`): › opens a page, ⌄ expands in place,
   no mark means no action and no hover.
5. **A stacked row is its key status**; what it folds is on the page its ›
   opens.

## What changed (after)

| Page | Sites | Answer starts at | Page controls above it | Answer rows on the first screen | Disagreeing rows |
|---|---|---|---|---|---|
| Home | one | **147px** | 0 | 2 of 5 | 0 |
| Home | several | **147px** | 0 | 5 of 5 | 0 |
| Sites | one | 131px | 1 | 1 of 1 | 0 |
| Sites | several | 223px | 5 (Add a site, Filters & sort, 7d · 28d · 90d) | **3 of 3** | 0 |
| Alerts | one / several | **403px** | 3 (Open, History, Filters) | 1 of 1 | 0 |
| Tasks | one / several | **377px** | 2 (New task, Filters) | 2 of 2 | 0 |

Built once, in the shared parts:

- `components/surface/KpiStrip.tsx` — the phone strip is one row (three in a
  row; four or more swipe; the selected KPI scrolled into view once per
  selection). A KPI's note keeps its own line height in a narrow cell.
- `components/surface/FilterBar.tsx` (new, registry entry) — `FilterBar`, and
  its parts `FilterFold` / `FilterToggle` / `FilterControls`. Sites, Alerts
  (Open and History) and Tasks use it; on a desk the controls lay out exactly as
  before.
- `components/surface/ListPanel.tsx` — a `to` row ends in ›; both affordances
  carry `data-row-affordance`.
- `components/ui/table.tsx` — `TableRow opens`: the pointer, and the stacked
  card's ›.
- `routes/assets/AssetsTable.tsx` (Sites and Home) — on a phone a site is its
  name, state marks, today, the users line and tasks; search clicks, net and
  the report age fold (the site's page leads with them; the report is one of
  the state marks).
- `routes/HomeRoute.tsx` — on a phone: status, the site, the rows that need
  you, the money, the sites. The desk's order is its DOM order, unchanged.
- `components/AppShell.tsx` — a sidebar site name wraps to two lines instead of
  an ellipsis.

Desk and tablet: the 1440 captures differ from before only in the ›
replacing ↗ at the end of Home's Waiting on you rows. At 768 the site table's
box is under 40rem, so it is already the stacked card and follows the phone
rule.

Flows: no flow gained a step. The flow gate's walks do not use the folded
filters.
