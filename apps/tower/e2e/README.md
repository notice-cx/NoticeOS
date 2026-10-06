# Isolated user journeys

`pnpm test:journeys` is the release journey gate, separate from the four existing
unit/type/build gates. Install the pinned disposable Chromium once with
`pnpm --filter @noticeos/tower run journey:install` (Linux CI adds
`--with-deps`; `--dry-run` only prints where it would go). It goes to this
checkout's `node_modules/.cache/journey-playwright`, which the install prints
and the journeys and the flow gate read, from any checkout or worktree
([`journey-browsers.mjs`](journey-browsers.mjs), bead `ro-ujb9.181`). The
suite runs desktop 1440×1000 and mobile 390×844. A journey that walks its own
screen sizes, or pins what no screen changes, is tagged `desktopOnly(reason)`
in `journeys.spec.ts`; the mobile project never schedules it. The
journey TypeScript (harness, fixtures, specs) is also checked by the Tower's own
`typecheck`, the first CI gate, so a contract change the harness stubs fails
there first (bead `ro-ujb9.78`).

## Parallel workers, each with its own server

The tests run in parallel (bead `ro-ujb9.167`). Each Playwright worker starts
and owns its own isolated fixture server — its own in-memory store, synthetic
config and isolation guard, on its own free loopback port — and every page and
request of that worker's tests reaches only that server (`journey-test.ts`).
There is no shared server and no base URL in `playwright.config.ts`. Every test
still starts from `POST /__journey/reset`, so it depends neither on another
worker's store nor on the test its own worker ran before it. A test fails if
its server printed an isolation violation while it ran.

A handler that throws answers 500 with the error's own words and prints them
on one `JOURNEY_HANDLER_FAILED` line; a failing test carries every such line
its server printed while it ran, so a refused reset says why in the gate's own
log (`handler-failure.mjs`, bead `ro-ujb9.76.56`). Those words never hold an
address, a socket or the run's database password.

No page leaves its server, not even by a redirect (bead `ro-o3hv`). Playwright
routes only the first request of a redirect chain, so a route answering 302 to
another site would take the browser to the real internet unseen.
`offline-guard.mjs`, installed on every journey's context (`journey-test.ts`)
and every flow-gate walk, aborts requests to other origins, refuses a
navigation whose answer redirects to one, records any other redirect hop that
leaves, and fails the test naming the first such URL. `google-consent.mjs`
still answers Continue with Google's start, the one redirect a walk follows.

Workers: `JOURNEY_WORKERS` when set (CI's override), otherwise half the
machine's cores, at most 4; the flow gate below takes as many lanes. Every
runner — each worker, each flow-gate lane and the harness test — starts
`server.mjs` the one way `fixture-server.mjs` does: PATH and its port only, ready
only once the guard is armed, and gone when its runner dies.

Measured on the office Mac (14 cores, shared with other agents' runs),
2026-09-23: the Playwright journeys went from 171 s on one worker to 51–56 s on
4, and the flow gate from 76 s on 3 lanes to 59–73 s on 4. The whole
`pnpm test:journeys` went from 253 s to 120–138 s (three runs in a row).

The journey covers an empty install, asset creation, a refused and then an
accepted Bing key in the one-panel connect (nothing stored until Bing says
yes), site mapping, receipt of deterministic data, completed-period
metric totals, range retention across tabs, exact task/approval links, gate
resolution, and a failed setup save followed by retry without duplicate creation.
Integration health on the provider pages and catalog tiles is the ingest's own
read (bead `ro-ujb9.86`): Bing's daily reports go from Awaiting first result to
Working once data arrives while its report archive still awaits a first run, and
Mediavine's revenue reads Working after its sync and Not connected after
Disconnect.
A Wall journey (beads `ro-n5ya`, `ro-yo4h`) answers `/api/wall` and
`/api/ga4/realtime` from the synthetic six-site `wall-fixture.ts` (invented
`.example` sites) with the first site's live reading out of date, and fails at
1920×1080 or 1440×900 if any region cuts text off sideways. A second (bead
`ro-trai.12`) draws the same fixture's `WallFixtureVariant`s — one, two, three,
six, seven and eight sites, and on fire — at 1920×1080 and fails if any reaches
past the TV, paints outside its own box, cuts text off or draws half a feed row
(the measurement `pnpm wall:fit` runs, `scripts/wall-fit-measure.mts`), if a
seventh site's row is not a full 70 px, or if the strip, Needs you and the site
marks do not say what is on fire.
The Wall journeys set this up through `wall-scene.ts`. `wallScene` pins the
clock and answers the Wall's five reads once, with each load starting from an
empty sessionStorage. A journey that walks screen sizes loads the Wall once
(`wallAt`), then resizes the window and waits until the redrawn Wall stops
moving. The TV-fit journey still loads every variant cold, at the TV, a laptop
and a phone (`openWall`). The live-feed journey skips the browser's clock one
30-second poll ahead (`page.clock.runFor`) instead of waiting for it.
A Sources-tab journey opens every data-source row, disclosure and a new PostHog
funnel one at a time, and fails naming the row if the page grows wider than the
viewport or a doc reference is clipped; a synthetic Google property list with
long names stands in for the connected account.
Four route-split journeys (beads `ro-82x`, `ro-ujb9.82`) open `/`, `/wall`,
`/work`, `/integrations` and `/assets/plate.example` and require each to fetch only
its own screen module plus the desk shell (the TV fetches no shell); list every
module `/wall` fetches and fail if rule tuning (`RuleTune`, `KnobEditor`), the
config registers, `TaskComposer`, `useTasks`, or the desk `Timeline` and its
`HandoffBeadBadge` (bead `ro-ujb9.85`) is among them; refuse one
screen's module and require exactly one automatic reload, then the plain retry
message and a working Reload button; and require a sidebar hover to fetch that
screen's module before any click. Two more (bead `ro-ujb9.84`) hold the asset
page's tabs and the command palette to the same rule: a cold asset page fetches
only the tab it shows (and a missing asset no tab but, at most, Overview),
opening a tab fetches that tab, the very first ⌘K fetches the palette and cmdk
and opens it with its field focused, and a `#timeline` deep link lands on its
section once Activity's code arrives; refusing one tab's module reloads once and
then says so inside the tab panel, under the header and tab bar that did load.
Important controls are reached by Tab/Shift+Tab and activated with Enter. With
the connection's toast up, Tab from the page's last control passes through the
toast once and on out of the page, and when the toast closes while focused,
focus returns to that control (bead `ro-ujb9.87`). Layout
regressions check overflow, containment and control/tooltip bounds; screenshots
are attached for review, **not compared to pixel goldens**. CI uploads the report
and failure traces even when a test fails. A local pass is not a remote CI run.
The HTML report and selected screenshot attachments are written under
`apps/tower/e2e/playwright-report/`; failure traces use
`apps/tower/e2e/test-results/`. Both are ignored generated artifacts.

## The UX flow gate

`pnpm test:journeys` ends with the UX flow gate (bead `ro-ujb9.95`,
`flow-gate.mjs`), which runs even when a journey has failed, so one red run
reports both; the step fails if either does. CI runs the journeys and the
gate as two parallel jobs. The gate walks every operator flow declared in `ux-flows.mjs` with
the recorder in `ux-walk.mjs`, at 1440×900 and 390×844, on its own fixture
servers (this directory's `server.mjs`, started by `fixture-server.mjs` on a
free port, one per lane, each reset before every flow), and fails when a flow
costs more than
`apps/tower/ux-flows.json` records: an added action, screen, page change or
word, an empty step, a repeated check, a duplicate status or an ungrouped list.
A changed flow changes its walk here in the same commit. Output and the
screenshot each failure names are under `ux-flows-results/` (ignored; uploaded
by CI). Rules, ratchet and exceptions: `scripts/README.md`, "UX flow gate".

## Boundary

The UI and Tower fetch switch are production code. Read models and the ingest
functions the Tower's Service Binding reaches run their real SQL against a
new, migrated Postgres copy of the run's throwaway cluster. Each fixture
server owns its copy; reset takes a clean copy and releases the previous one,
and shutdown closes it. Asset creation, integration health, credential storage
and credential summaries run unchanged under the application role. Accepted
connections use a synthetic journey-only encryption key. Cards and health
rows read the same stored credentials. Config
saves use the production changeset schema, safety, compare-and-set and apply
functions; only their persistence is replaced by disposable document storage.
The real task-lane handler reads saved project membership through the real
project reader, pointed at an in-process stand-in for the ingest door (a
non-routable origin and a synthetic bearer, serving the fixture's own
`config/beads.json`), resolves it against `fixture-repo/installation/task-host.json`,
and runs an injected, in-memory `bd` executor. It never starts `bd`, git or a
database client, and needs no secrets file: the suite runs the same from a fresh
checkout, in CI and on the operator's machine.

External credentials/probes and arriving provider rows are explicit fixture
boundaries. Only `journey-only-not-a-real-key` is accepted; its value is never
returned or journaled. The connect panel's save-and-test (bead
`ro-ujb9.96.7.1`) is the ingest's own `connectCredential`, run unchanged; only
the providers' side of the network is the fixture's (`journeyProviderNetwork`
in `harness.ts`): Bing's GetUserSites lists the journey site for the synthetic
key and refuses any other, and DataForSEO's account endpoint answers the
synthetic login `journey-login` with that key. The data-arrival control refuses to run before the actual
asset, fake connection test and saved site mapping exist. Where a real probe,
collector or Mediavine sync records its outcome for integration health, the
fixture's stand-in records the same outcome through the production recorders
(integration health, and the verdict a test, site discovery or sync stamps on
the stored credential), so health states and a card's "This credential worked"
come from saved evidence, never from the browser or a fixture flag. It does not exercise
provider OAuth, collector scheduling, or real task-hub reconciliation. Those are
different contracts, covered by their own suites.

The server uses a separate Vite configuration, `envDir: false`, no Cloudflare
plugin, no normal local middleware and no owner configuration; every module's
import of this repo's `config/*.json` (the ingest's compiled fallback copies,
and `packages/contract`'s compiled clock) is answered with the fixture's
synthetic documents. The fixture runs on its OWN operator clock,
`JOURNEY_TIME_ZONE` (UTC) in `fixtures.ts`, through the same saved-setting
path the Tower reads: the store's `os_time_zone` first, the compiled copy as
the fallback (bead `ro-ujb9.89`). A journey that checks money derives its
expectation from the fixture's seeded days on that clock
(`POST /__journey/revenue-history` answers with them), never from a figure that
only held on one operator's zone. It binds loopback only and refuses owner ports
5173/8791/3308. Server-side outbound fetches throw; browser requests are
restricted to its own origin. `isolation-guard.mjs`, installed before Vite
loads, refuses any read of `.dev.vars` / `.dev.secrets.json`, any read of a
file in the checkout's own `config/` directory and any socket to an owner
port, and prints a `JOURNEY_ISOLATION_VIOLATION` line for each; the harness
test requires a full journey to print none, and
`scripts/journey-isolation-guard.test.mjs` proves the guard refuses before the
file or port is touched (beads `ro-ujb9.81`, `ro-ujb9.89`). The runner does not reuse an
existing server/browser, attach through CDP, read a user profile, or take a target
URL from environment variables. Client and server clocks are fixed to the same
synthetic instant; actual timers still run. A journey that sets its own
`page.clock` keeps it: the client pin stands aside, as the Wall legibility
journey needs to draw its fixture's own day (bead `ro-r49j`).

Vite itself is started through the shared test-server helper,
[`scripts/test-vite-server.mts`](../../../scripts/test-vite-server.mts) (bead
`ro-ujb9.192`): its cache is a folder of its own in the OS temp dir, and its
close, Vite's own on SIGTERM included, waits for the dependency optimizer.
Stopped while that was still bundling, a server used to crash inside rolldown
or never exit. `fixture-server.mjs` now fails the run unless a stopped server
exits 0, and kills one that has not exited 90 s after its SIGTERM.

## Interactive reproduction

`pnpm --filter @noticeos/tower run journey:serve` starts a separate instance at
`http://127.0.0.1:4187`. It is independent of the automated suite, whose
servers each take a free loopback port from `journey-port.mjs`, so two runs on
one machine, in two worktrees, never collide (beads `ro-ujb9.107`,
`ro-ujb9.167`). Set `JOURNEY_SUITE_PORT` to pin the workers' ports instead:
worker 0 takes it, worker 1 the next, and so on.
Use domain `journey.example`, any display name, the synthetic key above, and
Bing site mapping `https://journey.example/`.

Fixture-only HTTP controls are available on **that isolated port**:

- `GET /__journey/status`: inspect synthetic state and method/path/status journal.
- `POST /__journey/receive`: supply the deterministic external collection result.
- `POST /__journey/fail-next-save`: refuse the next setup/config save once.
- `POST /__journey/revenue-history`: seed 84 days of synthetic traffic and ad
  revenue for the created asset, complete through the last day a report is due
  on the fixture's clock, and answer with that clock, the day, and each day's
  amount for last month and this one.
- `POST /__journey/every-source`: add the remaining property data sources
  (Google, Clarity, PostHog, DataForSEO, uptime) to the synthetic catalog. Call
  it before creating the asset, so Add a site writes a row for each.
- `POST /__journey/finding`: save one analysis finding (`journey-sitemap-drop`)
  on the created asset, so its Overview's What matters has a finding to file a
  task from (bead `ro-ujb9.96.7.11`).
- `POST /__journey/serp-panel?market=2826-en`: save one analysis with a tracked
  search panel on the created asset, in the market `<location>-<language>`
  names, or none without `?market=` (bead `ro-ujb9.230`).
- `POST /__journey/task-source`: connect the beads task source (D32, bead
  `ro-ujb9.143`) — save the fixture's task project in `config/beads.json` and
  file the runner's first task snapshot of it. The fixture starts with no task
  project, as a fresh install does, so no task screen shows until this runs;
  `POST /__journey/tasks-snapshot` alone files what the runner would with the
  projects saved at that moment (none, on a fresh fixture).
- `POST /__journey/reset`: discard the in-memory fixture and return to empty.

The fixture's `bd` answers the task lane's reads and its four operator writes:
`gate resolve`, `human respond`, `human dismiss` and `create`; `taskCommands`
in the status journal records each argv.

These controls are not imported into or registered by the production server.
Stopping the fixture process discards its data. `node --test
apps/tower/e2e/harness.test.mjs` independently exercises the same real handlers
over HTTP in a fresh process without launching a browser.
