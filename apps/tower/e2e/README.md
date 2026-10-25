# Isolated user journeys

`pnpm test:journeys` runs the isolated browser journey gate. Install the pinned disposable Chromium once with
`pnpm --filter @noticeos/tower run journey:install` (Linux CI adds
`--with-deps`; `--dry-run` only prints where it would go). It goes to this
checkout's `node_modules/.cache/journey-playwright`, which the install prints
and the journeys and the flow gate read, from any checkout or worktree
([`journey-browsers.mjs`](journey-browsers.mjs)). The
suite runs desktop 1440×1000 and mobile 390×844. A journey that walks its own
screen sizes, or pins what no screen changes, is tagged `desktopOnly(reason)`
in `journeys.spec.ts`; the mobile project never schedules it. The
journey TypeScript (harness, fixtures, specs) is also checked by the Tower's own
`typecheck`, the first CI gate, so a contract change the harness stubs fails
there first.

## Running some of the journeys

The Tower's own `test:journeys` runs the journeys alone, through
[`run-journeys.mjs`](run-journeys.mjs), and passes everything after `--` to
`playwright test`:

```sh
pnpm --filter @noticeos/tower run test:journeys -- -g "exact task and approval"   # journeys whose title matches, desktop and mobile
pnpm --filter @noticeos/tower run test:journeys -- --project desktop              # desktop only; --project mobile for the phone
pnpm --filter @noticeos/tower run test:journeys -- --project desktop -g "Wall"    # both together
pnpm --filter @noticeos/tower run test:journeys -- --list -g "Wall"               # lists the matches and runs nothing
```

`-g` takes a regular expression, matched ignoring case against the project
name, the file name and the journey's title. The root `pnpm test:journeys`
takes no options: it runs the journey type check, the harness test, every
journey and the flow walker below. `scripts/journey-runner.test.mjs` checks
that `-g` and `--project` narrow the run.

## Parallel workers, each with its own server

The tests run in parallel. Each Playwright worker starts
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
log (`handler-failure.mjs`). Those words never hold an
address, a socket or the run's database password.

No page leaves its server, not even by a redirect. Playwright
routes only the first request of a redirect chain, so a route answering 302 to
another asset would take the browser to the real internet unseen.
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

## Results

List the current executable scenarios with:

```sh
pnpm --filter @noticeos/tower run test:journeys -- --list
```

CI uploads the report and failure traces even when a test fails.
The HTML report and selected screenshot attachments are written under
`apps/tower/e2e/playwright-report/`; failure traces use
`apps/tower/e2e/test-results/`. Both are ignored generated artifacts.
Test exit status determines the journey result, and CI combines it with the
other required jobs. Keep captures and measurements in these generated reports;
do not commit verification writeups, result snapshots or copied artifacts.

## Against the built app

A production installation serves the Tower as a built bundle
(`apps/tower/vite/built-client.ts`); the journeys normally run against the
source modules. To run them against a bundle, build one without its release,
which the journeys' stubbed reads do not carry, and name its folder:

```sh
JOURNEY_BUILD=1 pnpm --filter @noticeos/tower exec vite build --outDir /tmp/journey-build
JOURNEY_BUILT_CLIENT=/tmp/journey-build/client pnpm --filter @noticeos/tower run test:journeys
```

The journeys that name the source modules a page loads, or open the dev
server's `/dev/kitchen-sink`, skip in that run (`BUILT_APP` in
`journey-test.ts`). CI's `browser` job runs the journeys this way, against
the bundle its `pnpm -r build` step makes with `JOURNEY_BUILD=1`.

## The UX flow walker

`pnpm test:journeys` ends with the flow walker (`flow-gate.mjs`, also
`pnpm audit:flows`), which runs even when a journey has failed, so one red run
reports both; the step fails if either does. CI's full lane runs the
journeys and the walker side by side, the walker in two shards
(`--shard 1/2`, `--shard 2/2`). The walker drives every operator flow declared
in `ux-flows.mjs` with the recorder in `ux-walk.mjs`, at 1440×900 and
390×844, on its own fixture servers (this directory's `server.mjs`, started
by `fixture-server.mjs` on a free port, one per lane, each reset before every
flow), and reports what each flow costs: actions, screens, page changes,
explanatory words, empty steps, repeated checks, duplicate statuses and
ungrouped lists. The counts are a design-review input, not a budget; the run
fails only when a flow cannot be walked to its end, a page leaves the fixture,
or the probes stop seeing what they are built to see. A changed flow changes
its walk here in the same commit. The measurements (`results.json`) and the
screenshot an unfinished flow names are under `ux-flows-results/` (ignored;
uploaded by CI).

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
`config/beads.json`), resolves it against the fixture's injected host inventory,
and writes its task-client settings inside the server's temporary installation.
The runner removes that installation after the server exits, including failed
startup. An injected, in-memory `bd` executor accepts only those resolved task
client directories. It never starts `bd`, git or a
database client, and needs no secrets file: the suite runs the same from a fresh
checkout, in CI and on the operator's machine.

External credentials/probes and arriving provider rows are explicit fixture
boundaries. Only `journey-only-not-a-real-key` is accepted; its value is never
returned or journaled. The connect panel's save-and-test is the ingest's own
`connectCredential`, run unchanged; only
the providers' side of the network is the fixture's (`journeyProviderNetwork`
in `harness.ts`): Bing's GetUserSites lists the journey asset for the synthetic
key and refuses any other, and DataForSEO's account endpoint answers the
synthetic login `journey-login` with that key. The data-arrival control refuses to run before the actual
asset, fake connection test and saved asset mapping exist. Where a real probe,
collector or Mediavine sync records its outcome for integration health, the
fixture's stand-in records the same outcome through the production recorders
(integration health, and the verdict a test, asset discovery or sync stamps on
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
the fallback. A journey that checks money derives its
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
file or port is touched. The runner does not reuse an
existing server/browser, attach through CDP, read a user profile, or take a target
URL from environment variables. Client and server clocks are fixed to the same
synthetic instant; actual timers still run. A journey that sets its own
`page.clock` keeps it: the client pin stands aside, as the Wall legibility
journey needs to draw its fixture's own day.

Vite itself is started through the shared test-server helper,
[`scripts/test-vite-server.mts`](../../../scripts/test-vite-server.mts): its
cache is a folder of its own in the OS temp dir, and its close, Vite's own on
SIGTERM included, waits for the dependency optimizer. `fixture-server.mjs`
fails the run unless a stopped server exits 0, and kills one that has not
exited 90 s after its SIGTERM.

Backup recovery is not a journey: `scripts/host-backup-postgres.test.mjs`
seeds every operational table on a disposable Postgres, runs the real backup
helper, restores into an empty independent cluster, compares records and
schema, resolves the copied R2 objects, and proves the restored application
reads and writes.

## Interactive reproduction

`pnpm --filter @noticeos/tower run journey:serve` starts a separate instance at
`http://127.0.0.1:4187`. It is independent of the automated suite, whose
servers each take a free loopback port from `journey-port.mjs`, so two runs on
one machine, in two worktrees, never collide. Set `JOURNEY_SUITE_PORT` to pin
the workers' ports instead:
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
- `POST /__journey/every-source`: add the remaining asset data sources
  (Google, Clarity, PostHog, DataForSEO, uptime) to the synthetic catalog. Call
  it before creating the asset, so Add an asset writes a row for each.
- `POST /__journey/finding`: save one analysis finding (`journey-sitemap-drop`)
  on the created asset, so its Overview's What matters has a finding to file a
  task from.
- `POST /__journey/codebase-report`: store thirteen weekly codebase reports on
  the created asset, the newest on the fixture's day, so its Codebase tab has
  a history, a 30-day change and findings.
- `POST /__journey/serp-panel?market=2826-en`: save one analysis with a tracked
  search panel on the created asset, in the market `<location>-<language>`
  names, or none without `?market=`.
- `POST /__journey/task-source`: connect the beads task source — save the
  fixture's task project in `config/beads.json` and
  file the runner's first task snapshot of it. The fixture starts with no task
  project, as a fresh install does, so no task screen shows until this runs;
  `POST /__journey/tasks-snapshot` alone files what the runner would with the
  projects saved at that moment (none, on a fresh fixture).
- `POST /__journey/choice-task`: add `jt-pick`, a question waiting on the
  operator with three options in its metadata (`JOURNEY_CHOICES` in
  `fixtures.ts`), the second recommended, and file the task snapshot.
- `POST /__journey/reset`: discard the in-memory fixture and return to empty.

The fixture's `bd` answers the task lane's reads and its operator writes:
`gate resolve`, `human respond`, `human dismiss`, `create`, `close`, and the
`comments add` and `update` an answer or a pick on a task that is not a
decision runs to hand the task back to ready work (`update --metadata` merges
the keys it is given, as `bd` does, which records a pick); `taskCommands` in
the status journal records each argv.

These controls are not imported into or registered by the production server.
Stopping the fixture process discards its data. `node --test
apps/tower/e2e/harness.test.mjs` independently exercises the same real handlers
over HTTP in a fresh process without launching a browser.
