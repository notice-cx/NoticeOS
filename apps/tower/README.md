# apps/tower — the Control Tower

The operator's control surface over the loop (doc 10). Vite + React + TS running
as a Cloudflare Worker: one workspace is both the SPA and its API Worker over
the central Postgres store. Reads dominate, and the writes are few and named: an
operator's alert disposition/resolution and their decisions on findings go
straight to Postgres; the timeline annotation, the pre-registered outcome check, an
asset's editable settings columns, an asset row and every setting are proxied
to the worker that owns those tables over the private INGEST Service Binding
(settings live in the store, D22 — see below; the local dev server's lanes only
export them and run `bd`). Dark-first and TV-legible; severity owns
attention color, with the narrow working/error/unconfigured integration-source
palette defined in doc 14.

Current limitations and audited corrections are tracked in
[docs/19](../../docs/19-architecture-implementation-ux-audit.md).

## Routes

| Route | What | Chrome |
|---|---|---|
| `/wall` | **The TV.** Full-screen, dark, auto-refresh 60s, read-only: `WallCanvas` draws the layout saved at `config/tower.json` `/wall`, or D28's default ([doc 25](../../docs/25-the-wall.md)) — the strip, revenue beside Needs you, one row per asset, the live feed (its own 30s poll). Arranged at `/wall/edit`, never on the TV. | none — deliberately outside the shell |
| `/` | **The operator's overview.** The month's net, a status strip (needs you — once a task source is connected, D32 — open alerts, System posture), a Waiting-on-you inbox (same condition) beside the newest alerts, and a compact assets table; until the first collected number Home is the first-run guide, and with one asset that asset's own lead replaces the table (bead `ro-ujb9.127`). No clock, countdown, meetings, asset cards, or attention table — each lives on the page that owns it. | shell |
| `/assets` | The portfolio index: the interactive asset grid, narrowed by lifecycle status, automation and attention and ordered worst-first — the filter and sort state lives in the URL. `/properties` is an alias and redirects here. | shell |
| `/assets/new` | **Add a site** (bead `ro-qsoo`; one screen since `ro-ujb9.96.7.5`): the Assets page with the Add a site card open over it — the address the sidebar entry and old links use; Home's first run and the Assets header open the same card in place (`components/AddSite.tsx`). The domain is the only field; the name is read off it or from the site's own page (`GET /api/site-name`), and Add writes the store row and then commits the config entries as ONE changeset, landing on the asset's Data sources. Registered before `/assets/:id/:tab?` and static, so it is never read as an asset called *new*. | shell |
| `/assets/:id` | **Overview** — the asset's lead numbers, chart and totals; the header carries identity, each source's mark and the page-wide range (7 · 28 · 90 days, `?range=`, `asset-detail/useRange.ts`). The page is tabbed (bead `ro-pbzu.4`) and the tab is the URL; `/properties/:id` is an alias and redirects here, tab and hash preserved. | shell |
| `/assets/:id/growth` | Product use and the performance charts over the range. | shell |
| `/assets/:id/financials` | This asset's ledger and P&L. | shell |
| `/assets/:id/search` | The tracked-panel board, query and page decisions, competitors and linking domains (`ro-78qo.4`). | shell |
| `/assets/:id/alerts` | Open alerts and alert history for this asset. | shell |
| `/assets/:id/tasks` | **What is being done about this asset** (bead `ro-l1ed.5`): the `/tasks` board with the project filter pinned to this asset's spoke — the same `TasksBoard` component, so the inbox, the row menus and **New task** behave exactly as they do on the index. The project control, the project clause in the summary and the section's name heading are gone: the page above already names the asset. The tab appears once a task source is connected (D32); an asset with no task project gets the board's own empty state rather than an empty queue. | shell |
| `/assets/:id/activity` | What happened on this asset: the timeline with its event and outcome-check composers, the watches strip, link outreach. | shell |
| `/assets/:id/sources` | Where the numbers come from: data sources and their setup steps, scheduled lanes (asset #0), daily metrics, site health. | shell |
| `/assets/:id/settings` | **Asset management**: identity (the display name saves in place through the store lane; domain and asset id read-only with the reason each cannot move), lifecycle stage, automation, data collection, the alert rules in force (read-only, pointing at `/settings`), and the way out: Archive, and Restore on an archived site (`#restore`). A site is never deleted (operator, 2026-09-29, bead `ro-ujb9.76.4.5`); adding an archived site's domain again says *Already added* and opens it there. | shell |
| `/alerts` | **Open** — every open error and warning in one interactive table with per-row Mark read / Snooze / Resolve / File task, filtered by asset, severity and kind. The page is tabbed (bead `ro-ju7f`) and the tab is the URL; the filter state lives in the query string. | shell |
| `/alerts/history` | **History** — alerts that were resolved or acknowledged across the whole portfolio, newest close first, filtered by asset and severity and paged by offset. Each row names its asset (favicon + link into that asset's Alerts tab) and shows how long the alert stayed open. Read from `GET /api/alerts/history`. | shell |
| `/tasks` | **The portfolio's task index** (D19, bead `ro-l1ed.2`; `routes/tasks/TasksBoard.tsx`): the filter row (project · status · priority · label · assignee, all URL state), a KPI strip, Waiting on you at five rows, then every other task as one table 25 rows at a time, each row expanding in place for claim / close / defer and linking to `/tasks/:id`. Listed once a task source is connected (D32). Live through the task lane where `os:up` is serving; the once-a-minute snapshot with the actions disabled everywhere else. `/work` is its original path and redirects here. | shell |
| `/tasks/:id` | **One task, whole** (D19, bead `ro-l1ed.3`): description and acceptance criteria as Markdown, comments with a composer, blocked-by / blocks with each dependency's status glyph, the parent epic's child progress, and — for a task filed from a Tower handoff — a link back to the asset-page section that raised it. Status and priority are the header's glyph-led chips; labels, assignee, priority, status, parent and the defer date save in place with an Undo toast. Claim and Close are the two primary actions, disabled with the deployment's own reason where there is no lane. Every task id the Tower renders links here. | shell |
| `/financials` | The portfolio's accounting, for an operator reconciling against receipts — and where the two cost registers behind it are edited (bead `ro-x5gu.2`). | shell |
| `/health` | Connection health in layers, leading with what to unblock next. `/health/operations/:id?` is the OS's own scheduled operations — the Workflows page with `surface: "system"`. | shell |
| `/workflows/:id?` | Every scheduled collection and job: its state, last and next run, and its schedule editor; filters in the URL. | shell |
| `/integrations` | **One row per provider, grouped by what it is for, with one status and one action** (bead `ro-ujb9.96.7.1`): a provider connects in `ConnectPanel` over the list (`routes/integrations/ProviderConnectPanel.tsx`) — paste, Connect, the provider's answer, then the account's sites matched to assets and Start collecting — through `POST /api/integrations/:provider/connect`, and is managed there once connected (its sites, Replace, Disconnect); Google signs in instead (`ro-vu8d.3`), and a task source connects here too (D32). The field schema is the provider's own in `packages/contract`, which `apps/tower/shared/integrations-page.ts` re-exports rather than mirrors, so a field added there needs no Tower edit (bead `ro-vu8d.6`). No value is ever echoed back — a stored field reads *set*. Read from `GET /api/integrations/providers`; written with `PUT`/`DELETE /api/integrations/:provider/credential` and `POST /api/integrations/:provider/test`. **This page is never read-only**: credentials are store writes, so it works identically in a deployed Worker (there is no 501 path here). A missing or invalid encryption key blocks Connect and is stated once above the list (`connectBlockers`); Disconnect stays available. A failed store request returns an unavailable state. | shell |
| `/settings` | **Every portfolio-wide knob on one page** (bead `ro-pbzu.2`): General (time zone, data cap, value of your time) · Alert rules · Data collection · TV dashboard · Ownership · Task projects (listed once a task source is connected), bead `ro-ujb9.18`, each with an anchor id and a left section list on `lg`. The operator timezone, the countdown, the spend caps, the alert-rule defaults and the collection-cadence knobs (beads `ro-x5gu.6` / `ro-x5gu.8`) save in place to the store, each cadence stating what changing it costs; the data-source catalog is not a setting and left the page (bead `ro-ujb9.96.14`). The pull registry (edited on the asset's own page) stays a read-only row; Task projects are edited here on the local OS and read-only in a deployed view. TV dashboard is omitted entirely when no countdown is configured (`ro-py40`). Alert rules also carries the RECORD each rule has earned (bead `ro-ayxy`) — how often the operator answered it by tuning, from `GET /api/alerts/rules`, with the two limits that make it a floor stated on the page. | shell |
| `/wall/edit` | **The TV's layout editor** (bead `ro-lzmq.2`, docs/15 flow D): a desk page inside the shell; the preview is `WallCanvas` scaled, and Save is one `file-json-set` on `config/tower.json` at `/wall` through `useConfigSave`. Reached from the Edit beside the sidebar's TV entry, Settings and the palette — never from the TV. | shell |
| `/dev/kitchen-sink` | Every component in every state — the visual reference / review surface. | shell; **dev-only, reached by URL, not in the nav** (route registered only when `import.meta.env.DEV`) |

**The shell** (`src/components/AppShell.tsx`, bead `ro-pbzu.1`) is a layout
route: a persistent left sidebar (`w-60`, a drawer behind a menu button below
`md`) carrying the desk nouns (`components/nav-items.ts`; Tasks once a task
source is connected, D32), plus Search (⌘K), the TV link with its Edit and the
theme toggle. The dev galleries are not in it
either — they stay dev-only routes reached by URL. Every desk page states what it
is through one `PageHeader` and carries no back link and no chrome of its own.
`/wall` renders
outside the shell — it is read-only and its tokens assume the dark emissive
palette, so the theme class never reaches it.

**Assets carries the portfolio** *(bead `ro-pbzu.9`)*: under that one entry, a
row per asset — favicon, display name, a `SeverityDot` only for an open
warn/error, and the slash glyph only where the asset is retired. Each row opens
where the asset's next action is (`sitePath`: its Data sources until the first
number, its Overview after) and lights on every tab of that
asset while Sites lights with it. Order is the index's default — the payload's
seed order — with retired sunk to the foot; `Add a site` closes the list; above
twelve assets the list shows the first twelve plus `All sites…`. The chevron
collapses it, remembered in `localStorage` under `noticeos:nav-assets`, which
also records the row count so the loading render reserves the height it drew last
time instead of pushing the nouns below Assets down the column. The desk column
defaults open, the drawer defaults closed, and the stored `open` exists only once
the operator has actually worked the chevron. Data comes from `useWall()`; the
kitchen sink passes `assets` instead, which keeps the gallery off the store and
off the remembered state.

**On the asset URL:** `/assets` is canonical and `/properties` is an alias
that redirects to it (D20). On screen the noun is **Sites** (D31,
[doc 17](../../docs/17-ui-lexicon.md)); the URL, the asset ids, `/api/assets`
and the `asset:` task labels keep `asset`. `/properties` stays an alias forever,
so no link the Tower ever emitted can 404.

**On the asset page's tabs** *(bead `ro-pbzu.4`; **Tasks** added by
`ro-l1ed.5`)*: they are ONE route with an optional segment — `/assets/:id/:tab?`
— rather than one route each, so switching tabs changes a param instead of
remounting the page. That is load-bearing: the
outcome-check seed a Search row hands to the Activity composer lives at the
route and has to survive the switch. An unrecognized tab renders Overview rather
than 404ing. Every hash the page has ever emitted (`#timeline`, `#integrations`,
`#configuration`, …) maps to its tab in `HASH_TAB`: the hash selects the tab,
then scrolls to the section.

## API

`GET /api/wall` → the one payload the TV, Home and `/assets` read (see `shared/wall.ts`):
`portfolio` (current-month net over non-superseded ledger rows + monthly net
trend + first-run state), `system` (whether the OS's own report is owed and
in, today's metered data spend against the day's share of the cap — counted
over the report runs (`noticeos.archive_runs`) through the same `loadDataForSeoSpend` the Health page
reads, never the report envelope, bead `ro-sq42` — the ingest-freshness
summary and the scheduled lanes), `assets[]` (fixed seed order; worst open severity,
open error/warn counts, effective working/error/unconfigured data sources,
current monthly net, GA4 active-user and Google/Bing web-search daily series,
the revenue projection and yesterday's estimate, open work), `attention[]`
(open error/warn flags, a recurring rule's firings grouped into one row),
`snoozed[]`, `operator` (null without a task source, D32) and `dashboard`
(`config/tower.json`: the optional countdown and the saved Wall layout), plus
per-lane freshness timestamps for the age badges. A refresh computes only what
a screen draws: every key names its screen in `WALL_PAYLOAD_INVENTORY`
(`shared/materiality.ts`), and the MCP `list_properties` tool is the one reader
of the portfolio fields no screen draws (bead `ro-trai.44`). Every band has a
designed empty state; the empty store returns a fully-formed payload, never an
error.
`GET /api/wall/feed` is the live feed's own 30-second poll. `GET /api/health` →
`{ ok: true }`.

`GET /api/settings` → every portfolio-wide knob in one payload (see
`shared/settings.ts`): `clock` (the operator's timezone from
`config/constants.json` `os_time_zone`), `dashboard` (the shared countdown from
`config/tower.json`, whose `countdown` is **optional** — absent, the page renders
no TV section at all), `budget` (the two `config/constants.json` knobs — data
cap and operator rate — as the same `PortfolioKnob` rows the asset page
renders; the monthly inference cap was withdrawn — D6/`ro-uj7x` —
because nothing in the OS calls a model and no meter could be drawn beside it), `alertRules` (the `flag_defaults` knobs as `KnobFact` rows),
`collection` (the DECLARED KNOBS this deployment can read a value for, keyed by
their entry in `CONFIG_KNOBS` and carrying nothing but the value — the label,
the rule and the consequence stay in `scripts/config-registers.mjs`, where one
copy of each lives — plus every `config/pull.json` endpoint with its enabled
flag), `sources` (the `config/integrations.json` catalog VERBATIM, because
`/settings` edits those rows and an edit guards on the value it was rendered
from; lane STATE is deliberately absent, it is `/api/integrations`'s and comes
from collector evidence), `entities` (`config/entities.json`), and `taskHub`
(the saved task projects: asset, prefix, database; the hub connection is null
in a build).

It is a **pure builder over the resolved config** — the store's document per
file when seeded, the compiled copy otherwise (`worker/config-source.ts`, epic
`ro-syok`) — with one total store read (was a time zone ever saved,
`ro-ujb9.134`), so the page an operator opens to fix something cannot go blank
because the database is empty or unreachable. The budget and alert-rule rows
come from the same `buildPortfolio` / `buildRules` (`worker/portfolio-settings.ts`)
the asset detail payload uses; `__BEADS__` carries `config/beads.json`'s spokes only (the hub's host/port
never reaches the browser), and `__SIGNAL_PANELS__` gained the roster's
`/refresh` block, which is where two of the three cadence knobs live.

`GET /api/ga4/realtime` is a deliberately separate, no-store read. The Tower
Worker calls ingest's `ga4Realtime()` method over the private `INGEST` Service
Binding; Google credentials never enter this Worker or the browser. An open
Home/Wall polls every 30 seconds. Each configured asset returns either
distinct active users for the overlapping trailing 30- and 5-minute windows or
an explicit error with null values. The client retains last-good values while
reconnecting, and failure cannot delay or blank `/api/wall`.

`GET /api/calendar/upcoming` is the same arrangement for the Wall strip's
next meeting (bead `ro-c0d2`): the Tower Worker calls ingest's
`calendarUpcoming()` over the private `INGEST` Service Binding, so the operator's
ICS feed URLs never enter this Worker or the browser, and a thrown read becomes
`503 calendar_upcoming_unavailable` carrying nothing from behind the boundary. An
open Wall (or its editor) polls every 60 seconds and keeps the last good snapshot. Two
absences are answered with no panel at all rather than a claim: no feed
configured (the operator has not set the secret up) and no feed answered (a
calendar nobody could read is not an empty calendar).

The strip's clock is deliberately browser-local and ticks inside its own
component subtree. The countdown configuration rides the no-cache Wall payload.
Locally the write lane exports each saved document to a file Vite statically
imports, so the Worker restarts; Settings and an open Wall on the same or another
device receive the saved value through their ordinary payload polls, and
the browser that saved it refetches once the restart has landed. Alert actions
from `/assets/*` invalidate the current browser's Wall cache immediately and
other Walls converge on the same poll. Nothing is staged: a field writes when
it is saved, or it says why it could not.

### Settings write in place (D18, bead `ro-pbzu.5`)

Settings live in the store once seeded (D22, migration 0029): `PUT /api/config`
reaches the Tower Worker (`worker/config-route.ts`), which applies the changeset
over the INGEST binding to the Worker that owns the table, so a Save works in
every deployment; the compiled config files are the fallback under every stored
document, never the target of a write. The routes:

| Route | Who answers | What |
|---|---|---|
| `GET /api/config` | the Worker (the write lane locally) | `{writable, reason, sources, versions, store}` — `writable` is whether the store can take a write, `reason` the sentence a disabled field shows, `sources` per file whether the value came from the store or the compiled copy; the lane answers `{writable, reason, store, unseeded}` |
| `PUT /api/config` | the Worker over the INGEST binding (the write lane locally, `vite/config-write-lane.ts`, `apply: "serve"`) | `{ops, slug?, reason?, expectVersions?}` → `200 {applied, archive, commit, documents}` — the Worker answers `archive: null, commit: null`, the lane fills both in. `400` unreadable body · `422` invalid changeset, a store op (it names the route below), or a task-project op from a deployed view · `409 expect_mismatch` / `version_mismatch` with the current values · `503 store_unavailable` / `not_seeded`; the lane adds `403` cross-origin · `415` non-JSON |
| `PATCH /api/assets/:id` | the Worker, over the INGEST binding | `{column, value, expect}` for `status` / `sense_only` / `display_name` → `200`. `403` · `415` · `422` · `404` unknown asset · `409 expect_mismatch` with the current value |
| `POST /api/assets` | the Worker, over the INGEST binding | `{id, displayName, domain?, status?, senseOnly?}` → `201` with the row the store wrote, plus a `Location`. `403` · `415` · `400` · `422 invalid_asset` naming the field · `409 asset_exists`, its `id` the site that holds the id or the domain |

The lane validates the same changeset `pnpm config:apply` applies — both run
`scripts/config-apply-core.mjs` — sends it to the store first, then exports the
returned documents to the installation folder (`scripts/installation.mts`),
archives it to `installation/changesets/NNNN_<slug>.json` and commits the
changed files plus the archive as `config: <slug> via Tower` — only inside a
git checkout. It never pushes. Same-origin is the
boundary (there is no authentication on the LAN Tower and none is being added),
and the allowlists mean even an accepted request can only SET a value in four
named files at named pointers, or ADD/REMOVE one asset-keyed entry in one named
container per per-asset register. `apply: "serve"` compiles the lane out of
every build by construction, so a deployed Tower has no write lane to guard.
Format and full reasoning:
[`config/changesets/README.md`](../../config/changesets/README.md).

**Which pages a save refreshes is declared once**, in
`src/hooks/config-backed-queries.ts` (bead `ro-ina0`). There are two write paths
— `useConfigSave` for a setting, `useCollectionSave` for a row — onto the same
documents, sharing one list. A key belongs on the list
when its payload is BUILT FROM a config document — `wall`,
`asset-detail`, `settings`, `workflows`, `financials`, `integrations`,
`integration-providers`, `task-source` today.

**How long a save waits before refetching is the same declaration**, and since
D22 it is a question rather than a constant (bead `ro-ssgu`). A **file** save
rewrites a file Vite statically imports, which restarts the local Worker, so
refetching immediately would only re-read the old bundle — that is what
`WORKER_RESTART_MS` (1.5s) is for. A **store** save writes `config_documents`
and restarts nothing, so on a seeded install that wait was a second and a half
of stale figures for no reason. `configSaveDelayMs` decides between them from
`GET /api/config`'s per-file `sources`: **every** document from the store means
no wait, and anything else — a file, a mix, or an answer that has not arrived —
waits. Unknown waits deliberately: the local dev lane answers that route itself
and reports no sources at all, and it is the one deployment that genuinely
restarts, because it exports each stored document back to its file after the
store takes the write. `test/config-backed-queries.test.tsx` asserts all of it —
that each hook really invalidates every key, that a store-backed save refreshes
with no timer and a file-backed one does not, and that neither hook may declare
a list or a wait of its own again.

**Creating an asset** is a store write, not a config write, so it works in
every deployment. `POST /api/assets` creates the row (bead `ro-z349.1`).
Nothing deletes one: the store is history, and a site's one exit, a mistaken
add included, is `status = 'retired'`, which Archive writes through
`PATCH /api/assets/:id`; any other verb on that URL answers `405` (bead
`ro-ujb9.76.4.5`). Neither writes a migration: the schema stays
operator-only (`AGENTS.md`).

**Adding a site uses both lanes, row first** (Add a site, `/assets/new`; bead
`ro-qsoo`, one screen since `ro-ujb9.96.7.5`). `POST /api/assets` creates the row, then `PUT /api/config` carries
the `file-json-insert` ops as ONE changeset — `createAssetConfig` in
`src/lib/api.ts`, deliberately a separate door from `useConfigSave`, which takes
only the invertible setting ops. The order is the point: the row's `409` is the
only authoritative duplicate check, and an orphaned row is the one leftover the
operator can see on `/assets` and archive. Where settings cannot be saved, Add is
disabled with that deployment's reason rather than creating half an asset;
the composition lives in `shared/asset-wizard.ts` so what Add will write is a
value a test can assert. Flow, refusals and failure states:
[doc 15 flow A](../../docs/15-operator-flows.md#one-screen-as-built-2026-09-23-bead-ro-ujb99675).

### Tasks are managed here (D19, bead `ro-l1ed.1`)

The portfolio's task hub is a Dolt (MySQL) server on the local host, and `bd`
is the only client that speaks to it — a Worker has
neither a route to that host nor a process to spawn. So the same arrangement as
config: a second local lane, `vite/task-lane.ts` (`apply: "serve"`,
`enforce: "pre"`), runs `bd` inside the repository this host links for the
request's project — the saved task projects joined to the installation's
`task-host.json` (`scripts/task-project-config.mts`); a stored value never
grants filesystem access.

| Route | `bd` | Answers |
|---|---|---|
| `GET /api/tasks/capabilities` | — | `{live: true}` from the lane · `{live: false, reason}` from a deployed Worker |
| `GET /api/tasks?project=&status=` | `list` + `ready` + `epic status` | `LiveTasksPayload` (`shared/tasks.ts`) — rows marked `ready`, epics `null` when `bd` cannot group |
| `GET /api/tasks/:id` | `show` + `comments` | `LiveTaskDetail`; project derived from the id's prefix |
| `POST /api/tasks` | `create` | `201 {id, project}` |
| `PATCH /api/tasks/:id` | `update` | claim, status, priority, assignee, labels ±, parent, defer, title, description, acceptance |
| `POST /api/tasks/:id/close` | `close -r` | reason required — completion is evidence |
| `POST /api/tasks/:id/comments` | `comments add` | |
| `POST /api/tasks/:id/respond` · `/dismiss` | `human respond` · `human dismiss` | the operator's inbox |
| `POST /api/gates/:id/resolve` | `gate resolve` | releases a bead held out of `bd ready` |

Refusals: `403` cross-origin · `404 unknown_project` (no spoke for that asset or
id prefix) · `400 verb_not_allowed` / `field_not_allowed` · `415` non-JSON ·
`422` invalid body or status filter · `502 bd_failed` with `bd`'s own stderr in
`detail` · `501 read_only_deployment` from a deployed build.

Three guards. **Same origin** (the shared boundary in `vite/lane.ts`, which the
config lane uses too). **An allowlist of twelve verbs**, consulted before
anything is spawned — `bd delete`, `bd sql`, `bd import` and the rest are not
commands this lane can be talked into. **`--actor` on every write**, set to the
checkout's `git user.name`, so the hub's audit says the operator did it. Client:
`src/lib/api.ts` + `src/hooks/useTasks.ts`, whose writes invalidate `["work"]`
and `["wall"]` so the once-a-minute snapshot board catches up immediately.

**`bd` remains the path an agent uses**, in the repo where the work happens
([`config/beads.README.md`](../../config/beads.README.md)). This lane is the
operator's.

`GET /api/financials?period=YYYY-MM` assembles one accounting period's ledger
(`shared/financials.ts`); `period` is optional and defaults to the latest month
holding current rows rather than an empty current one, the payload ships
`periods[]` (every month the ledger holds, ascending) and `periodIsCurrent`
beside it, a well-formed month with no rows is `404 period_not_found` and a
malformed one is `400 period_malformed` — **both carrying `periods`** (bead
`ro-dm67`), so the page can answer a stale bookmark with the months that exist
instead of the generic ledger error. That is why a malformed value is not
turned away before the store is touched: one unrequested read buys the reader a
list of live months, and a mistyped month and a missing one are one situation
to whoever followed the link. `/financials` renders that refusal as a designed
state naming the month it could not find, listing every month as a link (the
newest is the bare `/financials`), and **keeping the period selector** — valued
at the month that is not there, so picking a real one always moves.

The same payload carries the **two cost registers verbatim** — `recurringCosts`
(`config/recurring-costs.json`, bead `ro-x5gu.2`) and `domainOrders`
(`config/domain-costs.json`) — so the page's **Costs** section edits them without
opening a second read of a file it is already showing. **Both are in FILE
ORDER**, unlike every other array on this payload: a `CollectionEditor`
addresses an array row by its index (`/costs/3`) and guards the write with the
row itself, so sorting them for presentation would point a Save at a different
subscription. `domains` beside them is the same domain rows sorted
most-expensive-first with the amortization derived — the pair is deliberate, and
`test/financials-payload.test.ts` asserts they cannot be confused.

`GET /api/alerts/history?asset=&severity=&offset=&limit=` is the portfolio's
SETTLED alerts — dispositioned or resolved, newest close first
(`shared/alert-history.ts`, bead `ro-ju7f`). Read-only: disposition and
resolution stay on `PATCH /api/flags/:id`. Deliberately not a slice of
`/api/wall`, which a television polls every 60 seconds and which carries open
work only. **Paging is offset + limit and it states a `total`**, because the
list is ordered by when each row was CLOSED — a column the operator's own
clicks write, so there is no stable frontier a cursor could name honestly — and
because a page an operator reads to answer "what alerted last week" has to say
how much there is. `limit` defaults to 25 and is capped at 100; an unparseable
FILTER is dropped rather than refused, so a stale bookmark widens instead of
404ing, but an unreadable PAGE param — `offset=nonsense`, a negative, a float —
is `400 page_malformed` **carrying `total` and `limit`** (bead `ro-oefa`), which
is the same answer `/api/financials` gives a malformed `?period=` and for the
same reason: both arrive from a URL the operator can share, edit and bookmark,
and a dropped filter is visible in a widened list where a dropped offset is not
— page one of the archive looks exactly like page one however the reader got
there. A readable number that is out of range still clamps (`limit=0` → 1,
`limit=100000` → 100), the way a well-formed month with no rows is its own
answer. `/alerts/history` renders the refusal as a designed state quoting the
value the link carried, stating the size of the archive, and offering the first
page. Each row carries the exact `FlagRecord` the asset payload's
`flags.history` carries, plus the asset's id, domain and display name.

`GET /api/alerts/rules` is what each RULE has cost — per `rule_id` over the
last 90 days: fired, settled, how many of the settled the operator answered by
tuning (`disposition='tune'`), how many tunes are still open, and the ack /
plain-resolve split (`shared/alert-rules.ts`, bead `ro-ayxy`). It is docs/15
flow E's false-positive rate. **Its own read rather than a field on
`/api/settings`**: that payload is
a pure builder over config so an empty or down store cannot blank the page an
operator opens to fix things, and the Tune panel needs the same figure on
surfaces (`/wall`, an asset page) that never load `/settings`. "Settled" is
composed from `worker/flag-scope.ts` rather than spelled out again, so the
denominator of the rate and the alert queue can never be on different books, and
the window is on `fired_at` — what the rule produced this quarter, not what the
operator happened to close in it. A rule that has not fired is ABSENT rather
than a row of zeros. `/settings#alert-rules` renders it, and the counts are a
FLOOR for two reasons the page states out loud: a decision on a
`RECURRING_CONDITION_RULES` rule is recorded on every open firing at once, and
`flags.disposition` holds one decision, so an ack after a tune erases the tune
(bead `ro-bkcl`).

`GET /api/integrations` assembles the portfolio lane matrix from the file
register plus limited store evidence — the Health page's view of what each
lane is producing, and `GET /api/integrations/health` is the connection
strip's counts. The Integrations page's own surface is a family of routes over
the private INGEST binding (`worker/integrations-route.ts`, epic
`ro-vu8d`): `GET /api/integrations/providers` returns every provider's field
schema, its connection state (`store` / `env` / `none`, last-ok, last error)
and which assets declare its lanes; `PUT` and `DELETE
/api/integrations/:provider/credential` store and forget one (204, no body —
there is nothing safe to echo); `POST /api/integrations/:provider/test`
returns one real probe verdict, where an `ok: false` is a **200** — a wrong
password is an answer, not a transport failure; and `POST
/api/integrations/:provider/connect` is the connect panel's save-and-test
(bead `ro-ujb9.96.7.1`): the ingest asks the provider first and stores the
credential only if it accepts, answering `{ verdict, checkedAt, facts }` — a
refusal or an unreachable provider is a 200 that stored nothing, and only
providers declaring a `key` connect kind in the contract are accepted
(`site-tokens` providers use `/site-token`); `GET …/:provider/sites` and
`POST …/collect` are the panel's site list and Start collecting, `/expiry`
records when a credential stops working, `/import-env` moves legacy file
credentials into the store from the dev lane, and Mediavine has `status`,
`settings` and `sync`. **No credential value ever
crosses into this Worker**: the plaintext lives inside the ingest Worker, and
what comes back here is field NAMES and metadata. The list sits one segment
deeper than the matrix because the matrix already owned the bare path; the two
answer different questions and both keep their address. All of them are **store**
operations, so `/integrations` is the one editable desk surface with no 501
path and no read-only deployment sentence.

**Signing in to Google** adds three more (`worker/integrations-oauth-route.ts`,
bead `ro-vu8d.3`, [doc 11](../../docs/11-integrations.md#connecting-google)):
`GET /api/integrations/google/oauth/start` answers **302** to Google's consent
screen, `GET /api/integrations/google/oauth/callback` answers **302** back to
`/integrations?google=<outcome>`, and `GET
/api/integrations/google/properties` lists the GA4 properties and Search
Console sites the connected account can see — read by the connect panel
and by the property picker on each asset's Sources tab (bead `ro-vu8d.17`)
(`useGoogleProperties`, one query key so both Google cards share one round
trip). This Worker holds an origin and,
for the length of one call, an authorization code — nothing else: the
authorization URL is built inside ingest (it needs the client id), the code is
exchanged there (it needs the secret), and the refresh token is sealed there.
The two navigations are guarded differently and that is the whole security
story — **start** is refused unless `Sec-Fetch-Site` says `same-origin` or
`none` (a cross-site link into it is login CSRF), while the **callback** cannot
be origin-checked at all because it arrives from accounts.google.com, and is
defended instead by a signed, expiring, redirect-bound state that ingest
verifies before any code reaches Google. Every outcome is a redirect carrying a
CODE from a closed vocabulary, never a sentence, so nothing Google or the
network said can be reflected into the page through a query parameter — and the
authorization code never appears in a URL this Worker writes. `GET /api/assets/:id` assembles one
asset's rolling 90-day provider performance (active users, search clicks,
and search impressions; `?view=<tab>` returns one tab's sections, bead
`ro-ujb9.64`), latest compact executive snapshot with separate
Google/Bing query movers, configuration, integration, report, alert, ledger,
and annotation sections. It also carries the site's own entries in the
registers its tabs edit, verbatim, because the browser cannot read a config
file itself: `countersConfig` (`config/counters.json`, the Settings tab's Card
totals, which guards its removal on it), `panelConfig` and `ga4Config`.
The unused `laterPhase` future-feature list was removed from full and tab
responses and MCP `property_report` (bead `ro-ujb9.5.4`); operational fields
and evidence are unchanged.
Findings render as a ranked compact list; marked
items pin, dismissed items remain recoverable, and each can copy its complete
evidence contract as Markdown. Mark/dismiss is reversible browser-local
presentation state, not alert resolution or evidence mutation. The Home/Wall
payload keeps its visible signal series at 28 days (with 90 days of context for
the desk's range) and does not add the impression/query detail. The snapshot is a Postgres read model; raw
GA4/GSC/BWT/DataForSEO archive objects never enter the request path.

The assets table (Home and `/assets`, `routes/assets/AssetsTable.tsx`) is one
row per asset in the payload's seed order — identity, state, today, the range's
shape and move, the month's money, open work, and whether the nightly report
arrived; a cell with no answer says so and never shows a zero. Every source
mark — on a row, on an asset's header, on the Wall's rows — reads the source
through `sourceReadings` (`shared/connection-status`), the same model the
Integrations page and the asset's Data sources use, so no two surfaces
disagree about a source.

The detail route uses the same chart primitives over the page-wide range
(7 · 28 · 90 days, `asset-detail/useRange.ts`); the payload carries 28 days as
`series` and the rest of 90 as `contextSeries`, so a wider range reads what
exists rather than inventing days nobody reported. Product use on Growth
(`shared/product.ts`) is PostHog's read of what people do once they arrive; an
asset without PostHog says so instead.

A site's all-time totals are its Overview's (bead `ro-trai.21`; the Wall
stopped drawing them with D28 and stopped reading them with `ro-trai.44`). The
asset page's `counters` field carries the heading and values that site
declares in `config/counters.json`, resolved in config order
(`worker/counters.ts`) against the freshest lane that carries the metric — a
`counter_readings` row (the 15-minute counters lane) first, else the latest
nightly report's own `metrics[metric].total` (`source: "nightly"`, aged by
that report's `received_at`). Freshness decides, never magnitude. It carries
`cadenceHours`, the counters job's longest wait between runs as it is
scheduled (`countersCadenceHours`, bead `ro-ujb9.222`): each
counters-lane total carries its read age, amber past twice that cadence; a
nightly total carries none, since the page header already states that report's
age. `counters` is null when the site declares none, and the Overview then
draws nothing.

## MCP — the OS read models, spoken to agents

`POST /api/mcp` serves an MCP server over the same read models the Wall and
asset pages use (bead `ro-cda6.4`). Point an agent at it and it can answer
what an asset earned, what its decision lanes say, and whether a piece of
search research has already been paid for — instead of re-deriving all of it
from a paste.

```jsonc
// .mcp.json, or `claude mcp add --transport http noticeos http://127.0.0.1:5173/api/mcp`
{ "mcpServers": { "noticeos": { "type": "http",
                                "url": "http://127.0.0.1:5173/api/mcp" } } }
```

| Tool | Answers |
| --- | --- |
| `list_properties` | the portfolio, each asset's status, open-flag severity, and the period's booked vs forecast |
| `property_report` | one asset's whole read model — P&L, flags, signal freshness, the tracked SERP panel with its AI-Overview readings, and the query/page decision lanes |
| `research_lookup` | has this exact provider question already been bought, and where is the archived answer |

### Four constraints, all load-bearing

- **Read-only, enforced rather than intended.** No tool reaches a write, and a
  test asserts the store is byte-identical after every tool has run. Collection
  stays behind `POST /api/signal-collect` on ingest, where the lane lock and the
  budget gate live: a tool that could spend provider money is a different
  surface with a different risk profile.
- **Honest nulls.** The tri-state discipline (`aio_present` unknown vs false,
  "not inside the tracked depth" vs "not ranking") survives serialization
  because the tools pass the builders' output through rather than tidying it.
  Flattening unknown to `false` would launder exactly the dishonesty the
  collector was built to prevent, at the moment an agent acts on it. `booked`
  and `forecast` are likewise never summed.
- **One vocabulary.** Output uses the decision-lane words the operator already
  reads — act / investigate / protect / wait.
- **No new queries.** Every tool composes an existing builder. A second query
  answering "what did this asset earn" slightly differently would be a second
  truth, and the two would diverge silently.

### Current access boundary and hosted scope

The current standalone Tower relies on the access boundary documented in the
root [`README.md`](../../README.md#deployment-status). D39 supersedes D23's
former ban on accounts: the owner authorized local implementation of hosted
identity and workspace authorization under
[doc 23](../../docs/23-configuration-ownership.md), tracked by `ro-ujb9.289`.
This has not activated or certified hosted access. Authentication must cover
all entry points; protecting only the tool endpoint would leave the same data
available through the other routes.

The Tower already serves `/api/wall`, `/api/integrations` and `/api/work` — the
same read models, the same evidence — unauthenticated on the trusted LAN, and it
deliberately holds **no credentials** (`wrangler.jsonc`: the operator bearer and
the Google key both stay in ingest; the private `INGEST` binding is the
capability). A key on this door alone would be theatre — identical data, one
door locked and one open — plus a new secret in the one Worker whose whole
posture is that it has none. If the Tower's LAN exposure changes, it changes for
every `/api/*` route at once and this one inherits the fix.

`research_lookup` reads through the `INGEST` binding, because the table lives in
ingest. The **recording** half stays behind the operator bearer on
`POST /api/research-log`: a read of what was spent is not the same capability as
a claim about spending.

## Alert language — the store stays factual, the Tower translates

`workers/ingest` writes an alert the way a rule sees it: `message` is
`22 in last24h (avg7d 39.3, P(<=22)~=0.0020)` and `rule_inputs` is the exact
numbers the rule tested. That pair is the **audit trail**, and this app never
rewrites it; translation is read-side only. (The ingest lane's current
pull-failure-summary mutation is a separate known append-only gap in doc 19.)
It is also, as a
headline, useless: it states evidence and leaves the operator to do the
inference. So translation is a **read-side** concern, and it lives in one pure
function, `translateAlert` in `shared/alert-language.ts`:

| | |
|---|---|
| **What happened** | The headline: `Signups well below normal — 22 vs ~39/day`. Plain language, magnitude included, numbers rounded to what an operator says out loud. |
| **How sure** | *Not in the sentence.* The `SeverityDot` beside the line already carries it; saying "warning" in prose would render one fact twice (doc 14). |
| **What now** | A rule-specific hint (a zero on a live metric reads `— flow may be broken`; a stalled `ledgerRows` lane reads `— bookkeeping lane looks stalled`), plus a `ChangeChip` when the asset's timeline has a deploy or config change inside the 48h before the alert fired. A metric drop next to *"deploy a1b2c3d, 14h before"* is the insight. |
| **The statistics** | `evidence[]`, rendered by the existing `EvidencePopover` — one click for the skeptic, invisible to everyone else. |

Both surfaces call the same translator on the same fields, so the Needs-attention
band and the asset page's Alerts section can never word one alert two ways.
That means the payloads ship **data, not prose**: `AttentionItem` and `FlagRecord`
each carry `ruleId`, the parsed `ruleInputs`, `metric`, the raw `message`, and
`correlatedChanges[]` (correlated server-side, where the annotations already are).
An unknown `rule_id` — a rule the ingest lane ships before this app knows it —
falls back to the stored message, so a new rule degrades to the old rendering and
never to a blank row. Metric names humanize from the envelope's camelCase
(`plansSaved` → "plans saved"), which is why the store can keep its own
identifiers.

On the desk, each open event has three explicit lifecycle actions. **Mark read**
sets `disposition=ack`: that event leaves Needs Attention and no longer colors
the asset yellow, but a later daily recurrence is a new event. **Resolve**
sets `resolved_at`: it records that the underlying issue itself cleared.
**Snooze** *(bead `ro-c7qq`)* sets `disposition=snooze` plus
`snooze_until`: the condition leaves every open list until that date and then
comes back as the SAME row — same id, same evidence, no second firing. All three
preserve the rule evidence. The TV Wall remains read-only. Same-origin checks
protect `PATCH /api/flags/:id`; who reaches the Tower at all is the hosting
boundary above.

**Snooze is the only disposition that expires, so "open" is decided in one
place.** `worker/flag-scope.ts` holds the SQL — `resolved_at IS NULL AND
(disposition IS NULL OR the snooze has run out)` — and every reader composes it:
the Wall's attention rail and per-asset counts, the asset page's hero, counts,
wiring flags and history, the integrations lane read, and the write lane's own
eligibility check; the predicate itself is `openFlagsSql` in
`@noticeos/contract`, shared with the ingest's nightly rollup.

The verb ships with three guarantees, all under test:

- **The date is bounded and checked twice.** Presets are 1 day / 3 days / 1
  week, plus a date picker capped at `SNOOZE_MAX_DAYS` (90). `shared/snooze.ts`
  holds the rule; the browser refuses a bad date without a round trip and the
  Worker refuses it again, because a horizon only the picker enforces is a
  horizon anyone with a `fetch` call can ignore.
- **A snooze is never a silent hide.** `/alerts` carries a **Snoozed (N)**
  section — outside the page's filters, since a ledger a dropdown can shorten is
  a ledger that can hide the row it was set to hide — with the return date as
  glyph + countdown (`SnoozeUntil`) and an **Unsnooze** on each row. The asset
  page shows the parked row in its alert history with the same chip.
- **Unsnooze is a real inverse, not a second write with a different name.** It
  moves `snooze_until` to now rather than erasing the disposition, so one
  mechanism covers "the clock ran out" and "I changed my mind", the row still
  records that it was quiet and until when, and the toast's Undo (docs/15
  principle 5) is the same call.

It acts on the **condition**, not the firing: a `RECURRING_CONDITION_RULES` row
reading "16× in 26d" parks all sixteen firings, exactly as Mark read and Resolve
already did (`ro-kukv.1`).

## Local dev

Use the Node and pnpm versions declared in the root `package.json`. Install
from the **repo root** (`pnpm install`).

Start an isolated installation from the repo root with `pnpm start -- --dir
<throwaway-folder> --port <unused-port>`. It creates its own Postgres service
and keeps local R2 state in that folder. The approved fresh-install checks are
in [the start guide](../../scripts/README.md#a-new-installation-in-one-command-pnpm-start).

`pnpm seed:local -- --dir <folder>` fills an explicitly marked, empty
development database with invented records; it refuses an installation's own
store. See [development fixtures](../../scripts/README.md#dev-fixtures-seedlocal).

### A local synthetic viewer

`scripts/demo-viewer.mjs` serves a completed synthetic generation through the
ordinary Tower readers. It requires the clean public source release recorded by
`demo-generation.json`, its exact manifest and task receipts, matching evaluator
inputs, healthy owned loopback Postgres/Dolt resources, and the same task CLI
bytes used to generate the task history. It refuses ordinary installations and
inherited installation selectors. Run it from that verified public checkout:

```sh
node scripts/demo-viewer.mjs --dir /absolute/synthetic-home --port 6360 --release <commit> --bd-bin /absolute/owned-bd
```

The dedicated launcher starts only Vite and its local auxiliary ingest reader;
it starts no collectors, task poller, backup or scheduler. The shared demo policy
allows stored reads and refuses product mutations. Native task detail reads use
`bd --sandbox`. Navigation, filters and stored read-only POST operations remain
available. Each screen identifies synthetic, read-only data; generation age
comes from actual completion, while signal freshness keeps its ordinary rules.

The viewer binds `127.0.0.1` only and refuses a demo build. Its default lifetime
is twelve hours; `--duration-ms` may shorten it. Ctrl-C stops only its own child
process group. Private redacted logs and the stop receipt remain in
`<synthetic-home>/viewers/`. Public hosting is a separate approval boundary;
bounded replay is tracked by `ro-ujb9.256.7`.

For repeatable rendered review, start Firefox with Marionette on port 2828 and
keep the Tower dev server running, then from the repo root:

```text
pnpm tower:viewport-audit -- --label home --path / --wait-ms 3000 --out docs/artifacts/viewport-audit
pnpm tower:viewport-audit -- --label wall --path /wall --wait-ms 3000 --out docs/artifacts/viewport-audit
pnpm tower:viewport-audit -- --label kitchen --path /dev/kitchen-sink --desktop-height 3000 --out docs/artifacts/viewport-audit
```

The committed `viewport-audit.html` frames a true CSS viewport from query
parameters; `scripts/tower-viewport-audit.mjs` drives the user's existing
Firefox session and writes desktop/mobile PNGs to `/private/tmp` by default.
For an active review, `--out docs/artifacts/viewport-audit` keeps captures together
locally, but that generated output is gitignored and intentionally disposable.
Inspect or attach it during the task; never commit it or treat its path as
durable evidence. Run the script with `--help` for origin, port, dimensions, and
output options.
Asset state is verified on the real `/assets/:id` routes. The route tests cover
report absence and staleness, failed scheduled jobs, task requests and unknown
counts, open alerts, changes, and outcome watches. Rendered reviews use synthetic
API fixtures on those same routes; the kitchen sink remains the component gallery.

**With the canonical fixture, what you should see:** the desk at `/` and the
Wall at `/wall` — D28's strip, the month's revenue beside Needs you, one row per
site and the live feed ([doc 25](../../docs/25-the-wall.md)). The synthetic Wall
the journeys and captures draw is `e2e/wall-fixture.ts`, on invented `.example`
sites.

## Scripts / CI bar

`typecheck` (three `tsc` projects — `tsconfig.app.json` for the SPA under DOM,
`tsconfig.worker.json` for the Worker under workers-types, `e2e/tsconfig.json`
for the journeys), `test` (Vitest), `build` (`vite build`), and the browser
journeys plus the UX flow gate behind the root `pnpm test:journeys`
([`e2e/README.md`](e2e/README.md)). CI runs the five gates in
[`AGENTS.md` § The CI bar](../../AGENTS.md#the-ci-bar); all must be green.

Tests run reader SQL against **real Postgres**. `test/postgres-store.ts`
opens each test's isolated, migrated copy of a throwaway cluster as the
application role. Tests add their own sites directly, preserve stored site
order, and close/release their copies after each case. The independent Postgres backup/restore proof lives in the root script suite.

No unit test reads the checkout's own `config/` (bead `ro-ujb9.92`): suites
state synthetic documents or use the frozen copies in `test/fixture-config/`,
which is also what `vitest.config.ts` hands any module that imports a repo
config file (the contract's compiled clock). A test importing one, or reading
one with `node:fs`, is refused; the only exceptions are the seed checks listed
in [`scripts/test-config-isolation.mts`](../../scripts/test-config-isolation.mts)
(`integrations-seed.test.ts`, `integration-monitoring-coverage.test.ts`). The
contract package and the root script suite are held to the same rule (bead
`ro-ujb9.97`). Nor does any test run a Worker on the checkout's `.dev.vars`
(bead `ro-ujb9.182`): `test/runner-door-e2e.test.ts` boots its dev server on
Worker configs copied into a folder with no secrets
([`scripts/worker-config-folder.mts`](../../scripts/worker-config-folder.mts)),
and its last test proves no provider reaches it from the environment.

The **fetch switch itself** has its own harness (bead `ro-ap7n`,
`test/worker-fetch.test.ts`): it drives the default export with real `Request`s
against the same isolated Postgres store and a refusing INGEST double, and pins which
request gets which status and which error code — the half of `/api/financials`'s
400/404 answers the page renders its recovery state from. That is why
`worker/index.ts` names its bindings through the structural `TowerEnv` rather
than the ambient `Env`: the app tsconfig excludes the generated
`worker-configuration.d.ts` on purpose, and `test/worker-globals.d.ts` supplies
the two names the deployment `satisfies` still needs. Keep the test at the
switch's altitude — payload CONTENTS belong in the payload suites.

## Deploy notes

`wrangler.jsonc` binds `POSTGRES` through Hyperdrive. The application uses
`packages/postgres`; migrations are explicit operator work through
`pnpm postgres:migrate`. Neither Worker startup nor deployment applies them.
Remote resource provisioning and deployment require their own approval; see
[hosting and access](../../README.md#deployment-status) and the
[Postgres host profile](../../db/postgres/host/README.md).

## Layout

```
shared/            wall.ts (payload contract + cadences) · freshness.ts (age math)
                   alert-language.ts (rule facts → operator sentence) · annotations.ts
worker/            index.ts (fetch) · db.ts (TowerDb, the store port)
                   *-payload.ts (one builder per page, assembling its response)
                   shared readers the builders compose, never import from each
                   other: signal-trends.ts · panel-review.ts · flag-records.ts ·
                   ledger-history.ts · metered-spend.ts · integration-evidence.ts ·
                   portfolio-settings.ts · asset-config.ts (config file shapes) ·
                   config-source.ts (store first, bundle second) · flag-scope.ts
vite/              the dev-only lanes: config-write-lane.ts · task-lane.ts ·
                   env-import-lane.ts · scheduled-jobs-lane.ts (boundary: lane.ts)
src/components/    wall/* (the D28 Wall's widgets), surface/* (the desk's charts),
                   Kpi (surface/), DeltaChip, SeverityDot, AgeBadge, Meter, EmptyState,
                   IntegrationMatrix, ProviderCard, AlertRow, DashboardWidgets, Drill,
                   AppShell (+ Sidebar), PageHeader, CommandPalette (⌘K),
                   ui/* (shadcn, incl. Command/cmdk) ;
                   REGISTRY.md + registry.ts (the index)
src/routes/        WallRoute · WallEditRoute · HomeRoute · AssetsRoute · AssetNewRoute ·
                   AssetDetailRoute (+ asset-detail/*) · TasksRoute · TaskRoute ·
                   FinancialsRoute · HealthRoute · WorkflowsRoute · IntegrationsRoute ·
                   AlertsRoute · SettingsRoute · PropertyRedirect ·
                   KitchenSinkRoute (dev only)
src/hooks/         useWall (polling) · useNow (badge ticker) · useTheme (dark/light)
                   useCopyFlash (the "Copied" confirmation and ITS timer)
```

**Every copy control shares one confirmation** (`useCopyFlash`, bead `ro-ogc7`).
The hook owns the timer in an effect, so React cancels it on unmount and each
copy restarts the window. It is not a registry component — it is behaviour, not
a part — and it is why a test can assert the confirmation with fake timers
instead of racing the wall clock.

## Deferred (doc 10 phase scoping — intentional)

- **LEARNING band** — Phase 2+ (nothing to calibrate yet).
- **ATTENTION = flags only** — watch-window countdowns, review-queue size, aging
  deferrals wait on the queue/registry/deferral tables (scaffold-later).
- **Drill-down targets** (Queue, Registry, Runbooks, detailed P&L evidence) —
  later phases. Asset detail is implemented.
- **Exact tracked-query AIO / SERP panels** — daily GA4/GSC/BWT archives and
  weekly DataForSEO ranking/backlink/Google+ChatGPT mention snapshots feed the
  bounded executive view, but GSC's separate generative report has no
  documented Search Analytics API type. Exact device-specific citation and
  SERP-neighborhood monitoring still waits on the tracked-query panel or a
  deliberate manual export lane.
- **Phone kill-switch** — later phases. (The ⌘K command palette, bead
  `ro-d298`, navigates to any page or asset. Running commands from it is still
  deferred — doc 16's flow L.)
