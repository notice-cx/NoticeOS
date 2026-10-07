# Prepare public source

Docker installation commands (`stack:status`, `stack:start`, `stack:stop`,
`stack:restart`, `stack:deploy`, `stack:dev`) use the installation's explicit local selector.
The [Docker guide](../deploy/compose/README.md#deploy-changes-from-main) describes
how independently verified main becomes a running image, with app-only health
checks and rollback. The `os:*` commands below address the macOS service adapter.
For edits that appear immediately, opt into
[mounted-source development](../deploy/compose/README.md#follow-a-checkout-during-local-development)
with `pnpm stack:dev`.

```sh
node scripts/public-source.mjs --commit <full-commit-hash> --destination /absolute/new-public-source
```

The destination's parent must exist; the destination must be new and outside
the source checkout. The exporter reads only the exact committed blobs selected
by its public source policy and
[`public-source.settings.json`](public-source.settings.json). Dirty and untracked
files, private installation records and Git history are omitted. The generated
`public-source.json` records the commit, file hashes and executable modes.

This prepares files only. It does not scan or sanitize their contents, initialize
a public Git repository, publish, deploy, or establish release readiness. Review
the exported documents and public download archive, check for private data, and
run the [release qualification](../docs/release-policy.md#qualify-a-release-candidate)
against that exact source before publication. Operator approval for publication
is separate from preparation.

# A new installation in one command (`pnpm start`)

```
pnpm install --frozen-lockfile
pnpm start                       # → http://127.0.0.1:4747/, Home's first-run steps
pnpm start -- --port 6000        # the Tower on 6000, its ingest door on 6001
pnpm start -- --dir ~/noticeos   # keep the installation somewhere else
pnpm start -- --no-open          # print the address, open no browser
```

Prepare checkout dependencies explicitly with `pnpm install --frozen-lockfile`
after cloning or updating code. The committed `verifyDepsBeforeRun: error`
setting makes `pnpm run` and `pnpm exec` refuse stale dependencies and ask for
an install; invoking an OS command never silently reinstalls the checkout.
This check happens before the script's own safety checks. It also applies to
read-only OS commands, so prepare dependencies before maintenance. A deploy
still performs its separate frozen install in the idle runtime copy after
its deployment checks pass.

`scripts/start.mjs` (bead `ro-ujb9.126`) makes one folder, `.local/start/`,
for its local runtime state (`.wrangler/state`), bootstrap secrets
(`workers/ingest/.dev.secrets.json`, compiled to `.dev.vars`), generated Worker
configs, saved-settings exports (`installation/`) and log
(`.local/logs/start.log`). Operational data lives in the Postgres database
named by the folder's `DATABASE_URL`; deleting the folder does not reset it.
The secret boundary is defined in
[doc 06](../docs/06-operations.md#bootstrap-secrets-vs-integration-credentials).

It is **not the managed service** below. It never opens the checkout's
`.wrangler/state`, `installation/` or secret files, refuses the managed
service's ports (5173, 8791, 3308), refuses a folder it did not make, and
allows one start per folder. `scripts/start.test.mjs` boots it with a tripwire
on every one of those paths and ports.

Source-run prerequisites are Node 24.21.0 LTS, pnpm 12.8.1, local Docker Compose,
`psql`, and Beads CLI (`bd`) **1.3.1**. Startup checks the CLI before
creating installation state; it does not install a global CLI or attach to
another task server.

**A new, empty installation gets its own Postgres automatically** (owner,
2026-09-30, `ro-ujb9.8.1`; [approved exception](../AGENTS.md#hard-invariants-non-negotiable--from-doc-01)).
Docker Compose must already be available through a local container app, and
`psql` must be installed. Before making secrets or starting anything, setup
checks the committed migration hashes and proves the folder, its Compose
project and its data volume are new. It makes the profile's secrets under
`<start-folder>/postgres/secrets`, starts its isolated service, confirms the
database is empty, applies only frozen migrations, and bootstraps one workspace.
Its loopback Postgres port is the Tower port plus two (4749 by default).
The project name is `noticeos-start-` followed by a hash of the folder's
canonical path; a different folder owns a different project and volume.
The nonsecret `postgres/profile.json` records that project and its paths for
the backup job.

**The same fresh installation gets its own Dolt task hub** (`ro-ujb9.246`).
Its Compose project also owns a separate persistent `dolt-data` volume. The
loopback task port is the Tower port plus three (4750 by default), and
`dolt/profile.json` records its explicit resource names. Installation-local
credentials stay in private files under `dolt/`. See the
[pinned service and recovery procedure](../db/dolt/host/README.md).

Setup creates an internal NoticeOS asset and its task project, backed by the
installation's `tasks/noticeos` checkout. This adds no user website. The
project map and host link are saved with the installation, and the initial
task snapshot makes Tasks usable before the first website is added. Later
starts reuse that same server, database, project and credentials. Missing
declared resources or incomplete setup require explicit recovery; startup
does not silently replace lost task history with an empty database.

Existing installations keep their current hub. This setup does not move a
host-managed hub into Compose. Stopping the NoticeOS runner leaves the task
server and its persistent storage available for other agents.

An existing folder, store, secrets or database is never migrated automatically.
An inherited `DATABASE_URL`, explicit `NOTICEOS_POSTGRES_SECRETS` or
`NOTICEOS_POSTGRES_PORT`, or a symlinked folder prevents automatic setup.
Existing installations keep their configured database; when their secrets
file lacks `DATABASE_URL`, they can still take it once from the explicitly
prepared Compose profile as described in
[`db/postgres/host/README.md`](../db/postgres/host/README.md).
Failed setup preserves its files, provenance marker and resources for operator
recovery; after explicit repair, ordinary startup can resume. The next start
does not retry schema writes or remove them.

The start copies its profile's application address into its secrets file
(0600). With the address in the file, every start checks it as the
application login (`scripts/database-address.mts`): the database answers, the
login is `noticeos_app`, every Postgres migration this code has is applied and
the one workspace exists. Anything else stops the start in one sentence that
names the fix (`pnpm postgres:migrate apply` or `bootstrap` for a database
behind the code) and never repeats the address. The address then rides in the
Tower's environment only, as the POSTGRES binding's local address
(`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_POSTGRES`): never an argument,
never `.dev.vars`, and the start's log is scrubbed as the runner's is.
`scripts/start.test.mjs` plants a recognizable password and looks for it in
every file the start wrote, every process it ran and every answer its Tower
gave.

Startup creates no D1 store and has no `--migrate` flag. An existing Postgres
database is checked without applying migrations; maintenance uses the explicit
operator command printed by the check (bead `ro-ujb9.76.40`).

It keeps collecting on its schedule (`scripts/start-schedule.mjs`, bead
`ro-ujb9.156`): once its door answers it fires the ingest's crons
(`workers/ingest/wrangler.jsonc` `triggers.crons`) at its own door, on the
schedules saved in its store, and keeps the job-run record, the Workflows
history and the scheduler status in its folder's `.local/`, where its Tower's
Workflows and System health read them. Each start pays the latest missed
obligation of every lane once, by the managed service's catch-up policy
(`scripts/job-runs.mjs`). Of the runner's host lanes it runs two, each once it
is set up (`scripts/start-host-lanes.mjs`, the host adapter, bead
`ro-ujb9.174`): the task board refresh once a task project is saved, filed at
its own door, and the backup once its folder's `installation/host-backup.json`
names an offsite folder — its own store, and only the task databases its
`installation/task-host.json` links. The rest — task hub health, task filers,
push state, local signal panels — are not part of it. Its status says
`hostLanes: false` and lists only the jobs it runs, and the Tower lists those.

Root scripts named `installation:*` are one installation's own operations;
they leave with `installation/` at the public release (D33). There are none
today: the by-hand pulse relay reads its sites from the saved pull roster, so
it is the product's `pnpm pulse:relay` (bead `ro-ujb9.158`).

# Prepare an asset repository's context

Follow [the complete project setup guide](../docs/project-setup.md), then run
from the NoticeOS source checkout:

```sh
pnpm project:prepare -- --repo /absolute/project-checkout --check
pnpm project:prepare -- --repo /absolute/project-checkout --write
```

This command only prepares local repository files. It appends the canonical
task instructions without replacing existing project rules, creates an
unknown-state freeze register only when absent, excludes local task connections
from Git, and creates a private shared lock for an existing `.beads/` folder.
It never initializes a database, changes credentials, saves settings or calls
an installed service. Review and commit the intended context files in the
asset repository. Existing tracked task state or conflicting instruction blocks
require explicit reconciliation; the command refuses them.

# The local runner (`os-up`)

This is the piece that makes *"the OS runs on the operator's Mac for a while"*
true. One plain-Node supervisor (`scripts/os-up.mjs`, no TypeScript, no build
step) brings up **one** dev server hosting **both** Workers against Postgres
and local R2 state, fires the ingest crons that nothing else fires locally,
health-checks the independently hosted, declared beads task hub,
and takes a nightly backup of all three stores with an offsite copy to the
synced folder this host names (`config/host-backup.README.md`).

`os-up.mjs` is the coordinator: it starts and supervises the Tower child,
hands the scheduler its lanes and shuts down. Each responsibility it wires is a
module under `scripts/runner/` with its own `scripts/runner-<module>.test.mjs`;
the map is [`docs/briefs/2026-09-24-runner-modules.md`](../docs/briefs/2026-09-24-runner-modules.md).
`os-up.mjs` still exports every name it did, so its importers are unchanged.

```
pnpm os:up                    # start everything; Tower binds to loopback
pnpm os:up -- --host          # explicitly expose the unauthenticated Tower to the network
pnpm os:up -- --local         # keep loopback, overriding OS_UP_HOST
pnpm os:status                # one classified answer: stopped / starting / healthy / unhealthy / stale
pnpm os:logs -- --lines 200   # recent combined, redacted runner + child output
pnpm os:logs -- --follow      # follow that same log during a reproduction
pnpm os:restart               # restart the managed service and wait for health
pnpm os:deploy                # move the live OS to main — merging never does (one restart, health wait)
pnpm os:deploy -- --check     # …verify that without changing anything
pnpm os:deploy -- --rollback  # …return to the previous runtime copy
pnpm os:doctor                # bounded status + logs + scheduled-lane evidence + capacity
pnpm os:capacity              # the store's size and growth per table, read-only (-- --json for the raw answer)
pnpm os:stop                  # stop for maintenance, keeping its plist; waits for 8791 to free
pnpm os:start                 # power the installed service back up (os:status is the health check)
pnpm os:backup                # take one full backup right now (Postgres + R2 + hub, then offsite)
pnpm os:cron -- "0 * * * *"   # fire one cron against the running ingest, then exit
pnpm os:cron -- "*/15 * * * *" # …e.g. the counters fast lane, without waiting 15 min
```

`os:up` remains useful for a foreground development session. The office Mac's
normal state is the launchd service installed by `pnpm os:install`, running a
runtime copy of the code that only `pnpm os:deploy` moves (see
[below](#merging-is-not-deploying--pnpm-osdeploy)); agents use `os:status`,
`os:logs`, `os:doctor`, `os:restart` and `os:deploy` above and do not need its
label, plist path, port-owner process tree, or log path. `os:stop` / `os:start`
are the operator's maintenance pair, not part of that agent vocabulary.
`pnpm os:status -- --json` is the stable machine-readable health interface.
Its `liveness` result describes the supervisor, heartbeat and HTTP endpoints;
`dependencies` reports PostgreSQL and task-database readiness separately as
`ready`, `unavailable`, `timeout` or `unknown`. Overall `healthy` also requires
both database reads to succeed. Each read has one two-second budget, including
transport setup and the response body. PostgreSQL uses the existing authenticated
configuration GET without document bodies; Dolt uses an authenticated `SELECT 1`
in the installed service's declared task server. These checks read no providers,
run no snapshots and prove availability, not every project's schema or contents.
Missing declarations or authentication prevent a complete-health claim; status
does not expose credentials, addresses or raw database errors.

## Shared configuration code

`packages/contract/src/configuration.mts` owns the portable configuration types
and asset validation constants. Browser and Worker consumers use
`@noticeos/contract/configuration`; Node scripts import its sibling `.mjs`.
The configuration operation engine is authored in `scripts/config-documents.mts`.
It owns validation, conflict resolution, and document edits; each runtime owns
its storage and permissions. `packages/contract/src/posthog-families.mts` is
the one list of PostHog archive families and their row fields (bead
`ro-ghis.4`): the contract's zod row schemas must name exactly those fields, and
the flattener (`signal-archive.mjs`) and `signals:collect` import its
`.mjs` sibling.

### Shared runtime modules are authored TypeScript

Every module under `scripts/` that browser, Worker or Tower TypeScript imports
is authored as `scripts/<name>.mts` (bead `ro-ujb9.61`): the configuration
engine, `config-registers`, `config-apply-core`, `wall-layout`,
`scheduled-jobs`, `scheduled-job-runner`, `task-project-config`, the four
`workflow-*` modules and the unit suites' config guard `test-config-isolation`
(bead `ro-ujb9.100`). The checked-in `.mjs` and `.d.mts` siblings are
TypeScript output, so a fresh checkout's Node scripts still run without a build.

- **Callers compile against the implementation.** A TypeScript import of
  `scripts/<name>.mjs` resolves to the `.mts` source, so the Tower, its Vite
  lanes and the ingest Worker type-check their calls against the real
  parameter and return types. A runtime that starts returning a different shape
  is a type error, not a green gate and a broken caller.
- **Two generation projects.** `tsconfig.config-contract.json` compiles the
  portable modules with no ambient types, so a module the browser or a Worker
  loads cannot grow a `node:` import. `tsconfig.config-contract.node.json`
  adds Node types — the root's own `@types/node` devDependency, pinned to the
  Tower's version (bead `ro-ujb9.99`) — for the local-runner and terminal adapters
  (`config-apply-core`, `scheduled-job-runner`, `task-project-config`,
  `workflow-history`), the test config guard (`test-config-isolation`), the
  unit tests' secret-free Worker configs (`worker-config-folder`) and the
  tests' Vite server helper (`test-vite-server`). A new source goes in exactly one project's `include`.
- **Edit the `.mts`, then run `pnpm config:generate`.** `pnpm config:check`
  compiles into a temporary directory and rejects stale or missing output; the
  contract workspace runs it as part of `pnpm -r typecheck`, before the build
  can mask drift. Keep runtime code as it was and add types with annotations,
  `as` and `!`, so the generated `.mjs` stays the code that was reviewed.
- **Two pairs stay hand-written on purpose.** `config-store-client` attaches
  the operator bearer and `dev-secrets` moves credential values; converting
  them changes a protected credential path and needs operator scope.
  `scripts/declaration-lockstep.test.mjs` compares their export names and fails
  on any other hand-written `.d.mts`.

## What it does

The frequencies below are the defaults. Local schedules can be changed in
**System health → Background operations → Edit schedule**.

- **One runner at a time** — before anything else, it checks whether the pinned
  ingest port already answers. If it does, it starts **nothing** (no children or
  crons), prints the `lsof` that names the owner, and exits 3.
  See *One runner at a time* below for why that check is the whole guard.
- **No migrations at managed startup** — DB migrations remain operator-only
  for existing installations. The fresh-install exception above belongs only
  to `pnpm start`.
  Supervision, restart, crash recovery and bounded catch-up never invoke the
  explicit `pnpm postgres:migrate` write path.
- **Starts on its Postgres, or not at all** (bead `ro-ujb9.76.7.2`) — before
  anything starts, it reads `DATABASE_URL` from home's secrets file (the fourth
  bootstrap secret, [doc 06](../docs/06-operations.md#bootstrap-secrets-vs-integration-credentials))
  and checks it as the application login, read-only
  (`scripts/runner/database.mjs`). A missing or unusable address, a database
  that does not answer, or one behind this code's Postgres migrations writes
  one `REFUSING to start` line that names the file and the fix, never the
  address, and exits 5 with nothing started; under launchd the service tries
  again until the database answers. Otherwise the address rides in the Tower
  child's environment only (`towerChild` in `os-up.mjs`), never its arguments
  or `.dev.vars`. `scripts/runner-database.test.mjs` rehearses the managed
  service's Tower child on a throwaway home and database with a planted
  password, saves a setting through the Tower, and looks for the password in
  everything the runner wrote.
- **Supervises one child** — the Tower's `vite` dev server, whose single workerd
  runtime hosts both Workers (see *One runtime* below) — and restarts it if it
  dies (exponential backoff capped at 8s). If it dies **5+ times in a row within
  10s each**, the runner gives up loudly.
- **Health-checks the beads task hub** at startup, every 15 min, and before
  every snapshot poll — including diagnosing a **port conflict or crash-loop**,
  which a bare probe reports as healthy. It does **not** host it (see below).
- **Photographs the task hub every minute** into the central store, which is
  what the Tower's `/tasks` board renders (see below).
- **Schedules the ingest crons** (see below) and fires them locally.
- **Nightly backup** at 04:00 UTC with host-configured retention (30 days by default): Postgres, the R2 raw-archive
  store, and every task-hub database, each dated dir carrying its own
  `RESTORE.md` — then the finished dir copied offsite to the synced folder
  this host names in its installation's `host-backup.json`.
- **Clean shutdown** on SIGINT/SIGTERM: stops the schedulers, group-kills the
  child (SIGTERM → SIGKILL), exits 0. The task hub is untouched — it outlives
  the runner on purpose.

Everything it does is echoed to stdout **and** appended to the combined runner
log, each line tagged `[tower]` / `[os-up]`. The persistent path is deliberately
an implementation detail exposed through `pnpm os:logs`: writes scrub common
Bearer, key, token, password, cookie, and private-key shapes, and the password
inside a connection URL, before they reach disk; reads scrub again; a single line is capped at 64 KiB. The live log rotates
at 5 MiB with five historical files, so a permanently running office Mac cannot
grow it without bound. The structured scheduled-lane record retains 30 days.

## Scheduled job configuration

**Workflows** (`/workflows`) lists five built-in operator automations.
**System health → Background operations** (`/health/operations`) owns the
fifteen collection and maintenance operations. Both show purpose, latest
execution state and hourly activity, with a Schedule view for the next 24 hours
and the same stage diagram and run inspector. Existing `/workflows/:id` links
redirect to the correct surface without losing the selected run. Choose
**Edit schedule** to change frequency, local time or weekday, pause a
job, or restore its default. The editor previews the next three runs and saves through
the existing guarded config pipeline with Undo. It does not create arbitrary
commands or change Cloudflare's deployed cron triggers.

A **collection's** schedule is changed with the collection instead (beads
`ro-ujb9.96.7.12`, `ro-ujb9.96.7.28`), one pick saved beside its row with Undo:
on the **Manage** panel of each Integrations connection that feeds it (the
job's declared `connections` in `scripts/scheduled-jobs.mts` — the traffic and
search archives are on both Google's and Bing's), or in **Settings → Data
collection** for a collection no connection feeds (nightly reports, live
counters, local research). Its page here links to that one editor.

Overrides live in the stored `config/constants.json` document at `/schedules`:
each known job id maps to `{ "enabled": true, "cron": "0 21 * * *", "timezone": "UTC" }`.
The optional IANA timezone defaults to UTC. Editing timing saves the viewer’s
timezone and follows daylight saving there; merely pausing preserves the prior
cron and timezone. All displayed execution times use the viewer’s timezone, with
UTC references on hover.
The block is optional; missing entries use the defaults declared in
`scripts/scheduled-jobs.mjs`. The whole block is concurrency-checked and
validated on every write. `scripts/scheduled-jobs.test.mjs` verifies that the
defaults match the existing ingest triggers and local runner configuration.

The runner reads the authoritative config store every 15 seconds and replaces
only timers whose settings changed. The UI distinguishes saved settings from
the acknowledged active timing, including pending changes and unavailable
status. It never reports an old status snapshot as active after 45 seconds.
If the initial stored settings cannot be read, no scheduled jobs are armed;
subsequent read failures retain the last acknowledged schedules and keep retrying.
The existing constants document must be seeded before scheduling can start.

A changed run time still dispatches and records the same job identity. Pausing
stops future scheduled runs and startup recovery, while in-flight work may
finish. Recovery keeps each job's existing time window and one-run limit, using
the saved schedule to find its latest missed obligation. Manual operator
commands remain separate from scheduled execution. Collector logic, provider
windows, freshness thresholds, budgets and backup retention are unchanged;
the editor explains material consequences beside each job.

Execution observations are stored locally as bounded traces with allowlisted operational outputs in
`.local/logs/workflow-runs.jsonl` (up to 6,099 traces between compactions, with a
12 MiB tail-read limit). Whole-run verdicts also live in the existing 30-day
job log, so losing detailed steps cannot turn a failure into success. The UI
lists the latest 30 retained runs per workflow and groups 24 hours of activity.
Step output presents recorded counts, structured per-asset or per-project results,
and a disclosed captured-data view. Raw responses, secrets and task bodies are
excluded. Missing output is unavailable, never an invented zero.
Older runs without step evidence show “Not observed.” Local operations expose
the execution and recording boundaries; worker collections additionally expose
configuration and collection stages, including parallel branches. Worker stage
results arrive with the completed RPC; the runner reports live whole-run state.
Active snapshots have a runner session id and a 15-second heartbeat; after 45
seconds without observation evidence, current health is unknown. Execution
success is separate from asset health and business outcomes. The design and
agentic extension contract are in [doc 22](../docs/22-workflows-research-and-design.md).

## Port map

| Service | Port | Started as | Notes |
|---|---|---|---|
| tower + ingest (`vite`) | **5173** | `pnpm --filter @noticeos/tower exec vite --strictPort --host 127.0.0.1` | ONE workerd runtime hosting both Workers. Loopback by default; `--strictPort` prevents silent drift. `pnpm os:up -- --host` explicitly enables network access. |
| ingest door | **8791** | the same `vite` process, from `apps/tower/vite/runner-door.ts` | A second listener bound to `127.0.0.1`, serving the ingest's routes and its cron fires. Loopback-only because the local scheduled endpoint is unauthenticated by construction. Pinned away from wrangler's default (8787). |
| beads hub (`dolt sql-server`) | declared profile; legacy **3308** | independent Compose service; Homebrew only for a retained native installation | `NOTICEOS_DOLT_HOME` selects the protected Compose profile and loopback endpoint. Never start the retired native hub to recover it. |

The app port constants live in the `CONFIG` block of `scripts/runner/config.mjs`
(re-exported by `os-up.mjs`) and are the single source of truth: `os:cron` reads the same constant, and the runner
passes the door address to the Tower's dev server as `OS_UP_INGEST_DOOR_HOST` /
`OS_UP_INGEST_DOOR_PORT`, so a tick always targets the ingest that `os:up`
started.

## One runtime

The ingest is an **auxiliary Worker** inside the Tower's dev runtime
(`auxiliaryWorkers` in `apps/tower/vite.config.ts`). Both use the same Postgres
store. One runtime owns local R2 persistence and one runner fires schedules.

What that costs, and how it is paid:

- **One runtime, one listener** — the Tower is loopback-only by default. So the
  ingest gets a **second listener bound to loopback**, the "ingest door", which
  the same `vite` process opens on 8791. It serves the same middleware stack, so
  a request that arrives there reaches the ingest Worker through the Tower's
  private `INGEST` Service Binding.
- **The boundary is the kernel, not a header.** Nothing off-machine can connect
  to 127.0.0.1:8791, exactly as before. The door marks the requests it created,
  a guard middleware **strips that mark off every other request** — so it cannot
  be forged by a LAN client hitting `http://<machine>.local:5173/api/runner/…` —
  and the whole lane is compiled out of a production build (`__RUNNER_LANE__`).
  Both the map and the wire copy of that header are rewritten together, because
  the Cloudflare plugin builds the Worker's request from `rawHeaders` alone;
  editing only `req.headers` stamps nothing and strips nothing.
  `apps/tower/test/runner-door.test.ts`
  pins the mechanism and `runner-door-e2e.test.ts` pins it over real TCP against
  a booted dev server — the only place that seam is visible.
- **Debugging it:** `curl http://127.0.0.1:8791/api/runner/scheduled` should
  answer `400 cron_required`. That is the one-line health check for the whole
  chain; `403 runner_lane_loopback_only` there means the mark is not reaching
  the Worker.
- **Nothing else moved.** The door keeps the ingest's documented address, so
  `pnpm os:cron`, `scripts/pulse-relay.mjs` and every curl in
  `workers/ingest/README.md` read the same. Bindings, secrets and
  `triggers.crons` still come from `workers/ingest/wrangler.jsonc`, and
  `wrangler deploy` from that workspace is untouched — the auxiliary Worker is
  `devOnly`, so production is still two separately deployed Workers talking over
  the Service Binding.
- **The scripts go through the door.** A Node script that shells out to
  `wrangler … --local --persist-to` starts a second workerd over the same file,
  and these scripts are run **beside a live `os:up`**. So every script that
  needs the store reaches it via `scripts/ingest-door.mjs` — the shared address,
  bearer and failure sentence — and `scripts/no-second-runtime.test.mjs` fails
  the suite if a new script grows the habit. It scans `scripts/*.mjs` and every
  `pnpm` script body (root manifest plus every workspace package) with the same
  markers. `ingest-dev` probes the door before opening the shared R2 state;
  `host-backup` snapshots R2 SQLite metadata through the online-backup API.
  No package script directly opens shared local persistence.

The checks that prove one runtime, and what to do when one fails, are in
[`docs/runbooks/one-runtime-cutover.md`](../docs/runbooks/one-runtime-cutover.md).

Standalone has no user login: anyone who can reach the Tower can read and
change its data. The default is `127.0.0.1`; `pnpm start` and the prepared
Compose container also publish loopback-only. Keep that binding when using an
authenticated tunnel. `pnpm os:up -- --host` or `OS_UP_HOST=true` / `1` enables
network access and logs this trust boundary. `--local` or `OS_UP_HOST=false` /
`0` keeps loopback; unknown environment values refuse startup. These flags
never expose the ingest door. Existing LAN deployments must opt in explicitly
when upgrading to this default.

Vite's host check remains enabled: it admits `localhost` and IP addresses.
`apps/tower/vite/allowed-hosts.ts` adds the machine's own names at start
(`ro-ujb9.150`). An operator-managed DNS alias or proxy hostname goes in
`TOWER_ALLOWED_HOSTS`, comma- or space-separated. This host check is not user
authentication; never disable it globally.

### Standalone access through an SSH tunnel

Use an operator-managed SSH endpoint with verified host keys and public-key
login. Its access account must permit local forwarding only to
`127.0.0.1:5173`; keep the Tower and ingest door off external interfaces.
For that account, the maintained OpenSSH settings are
`AuthenticationMethods publickey`, `PasswordAuthentication no`,
`KbdInteractiveAuthentication no`, `AllowTcpForwarding local`,
`PermitOpen 127.0.0.1:5173`, `GatewayPorts no` and `MaxSessions 0`
(no shell sessions). The host owner configures that endpoint; NoticeOS does
not enable or configure the machine's SSH service.

On the operator's client, using their SSH account and host:

```sh
ssh -NT -o ExitOnForwardFailure=yes -L 127.0.0.1:5173:127.0.0.1:5173 account@os-host
```

Open `http://127.0.0.1:5173` in that client's browser. Pages and API requests
use the same origin, including Settings Save. Confirm the SSH host key through
the host owner before accepting it. The local forward must also bind only to
loopback; publishing it would expose the unauthenticated application again.
Local processes on either trusted machine can reach its local endpoint.

The disposable proof reuses the real runner Tower and Postgres fixture,
checks loopback listeners, refuses an unapproved SSH key and a forward to a
different destination, then loads the Tower page and reads/saves settings
through the authenticated tunnel. It uses its own keys/config and does not
start a system service:

```sh
NOTICEOS_REQUIRE_POSTGRES=1 NOTICEOS_TEST_ACCESS_TUNNEL=1 NOTICEOS_TEST_SSH_ROOT=/absolute/owned/key-directory node --import ./scripts/script-tests-setup.mjs --test --test-concurrency=1 scripts/runner-database.test.mjs
```

The key directory must have owner-only permissions and safely owned ancestors
(OpenSSH `StrictModes` remains enabled). The opt-in requires maintained
`ssh`, `sshd` and `ssh-keygen`; their locations in the fixture are the macOS
system paths. The normal root suite does not require an SSH daemon. This
qualifies the loopback/SSH recipe, not a VPN, reverse proxy or public hosted
service. See the primary [SSH forwarding manual](https://man.openbsd.org/ssh)
and [server restrictions](https://man.openbsd.org/sshd_config).

## One runner at a time

Two `os:up` processes on this Mac is not a degraded mode, it is a billing event.
Both read the same `triggers.crons`, both arm their own copy, and both fire at
`127.0.0.1:8791` — a constant, not "my child" — so whichever ingest is bound
there runs **every schedule twice**.

The same socket answers a second question, which is
why the port stayed put rather than following the ingest into the Tower's
process: the door identifies the runtime already serving this installation
and owning its local R2 state. The dev server enforces the same rule from its side — if it cannot
bind the door it **exits** rather than becoming a second writer.

So the runner probes the ingest door first and refuses if anything answers:

```
2026-08-02T10:00:00.000Z [os-up] ERROR REFUSING to start: something already
answers on 127.0.0.1:8791 … Find the owner with:  lsof -nP -iTCP:8791 -sTCP:LISTEN
```

Nothing is started or migrated in that case, and the exit code is **3** (distinct
from 2, "bad flags"). Start with `pnpm os:status` and `pnpm os:doctor`. If the
managed service is loaded, `pnpm os:restart` is the only supported restart path;
it reports whether health returned and prints recent redacted output when it did
not. If status says an unmanaged runtime answers, stop its foreground
`pnpm os:up` terminal first. The control command refuses to guess which unknown
process tree is safe to kill.

The guard is the **bound socket**, not a pidfile, because a socket cannot go
stale: a pidfile outlives a `SIGKILL` and then refuses the next honest runner on
behalf of a pid that is free (or reused), and clearing it is a file the operator
has to know about. A port is held by a live process or by nobody. And when a
crashed runner's `vite` does outlive it, refusing is the right answer anyway —
that orphan is precisely the runtime the new crons would have fired at, and the
one holding the store open.

## Cron behavior

- The cron list is **read at runtime** from `workers/ingest/wrangler.jsonc`
  → `triggers.crons` (JSONC comments and trailing commas are stripped before
  parse). Adding a cron there — e.g. a nightly pull — is picked up on the next
  `os:up`; nothing here hardcodes the list.
- …but it is read **once, at startup**, from the code the runner runs. Under the
  managed service a cron added to `wrangler.jsonc` arrives with the next
  `pnpm os:deploy`, which restarts the runner; a foreground `os:up` needs a
  restart. (Worth knowing because the symptom — the new lane simply never runs —
  reads exactly like a code bug. `pnpm os:cron -- "<expr>"` fires it by hand in
  the meantime.)
- Default expressions run in **UTC**; stored overrides can specify an IANA timezone via [`croner`](https://www.npmjs.com/package/croner).
- On each occurrence the runner fires
  `GET http://127.0.0.1:8791/cdn-cgi/handler/scheduled?cron=<url-encoded-expr>`
  — the local runtime does **not** fire crons on a wall-clock schedule itself.
  The ingest door recognises that path and calls the ingest Worker's
  `runScheduled(cron)` over the Tower's private Service Binding, which runs the
  **same dispatch table** as the deployed `scheduled()` handler
  (`workers/ingest/src/dispatch.ts`; `test/runner-rpc.test.ts` pins the two
  equal). The HTTP result is logged; a non-200 or a fetch failure is an ERROR
  line but **never** crashes the runner.
- The Tower then runs **its own steps of the same tick**, the ones that count
  with its models (`apps/tower/worker/tower-cron.ts`): today two, on the hourly
  `0 * * * *` fire, recording System health's four connection counts for the
  day (bead `ro-ujb9.96.7.29`) and each data source's state and freshness for
  its Source history (bead `ro-ujb9.96.7.31`). They are part of the same run in Workflows. A
  deployed Tower runs the same function from its own cron trigger
  (`apps/tower/wrangler.jsonc`).
- While the runtime is **down or restarting**, a due cron is **skipped** and
  recorded. On the next runner start, the bounded recovery pass considers only
  the latest missed obligation for each explicitly allowlisted lane—never every
  missed tick—and runs due work sequentially, cheapest cadence first, once the
  runtime is ready.

### Bounded catch-up after downtime

The job-run record is the cursor. For each lane, the runner compares its latest
recorded firing (any outcome) with that schedule's most recent obligation in its saved timezone.
If the obligation is newer and still useful, it fires exactly once:

| Lane cadence | Recovery window | Behavior |
|---|---:|---|
| 15-minute counters + Google signals | 1 hour | One current refresh, never a tick-by-tick replay. |
| Hourly freshness, operator notifications, panel review, push state | 2 hours | One latest reconciliation. |
| Daily ingest lanes (including the 12:30 PostHog archive), panel refresh, backup | 36 hours | One latest daily obligation. PostHog reads trailing windows, so a late run collects the same windows and an unchanged window is stored as `unchanged`. The 12:15 archive firing also carries the DataForSEO outage re-collection, which re-runs only families an offline run skipped and costs nothing when none are owed. |
| Mediavine (`10,30,50 * * * *`) | 36 hours | Checks the Pacific 06:10 cutoff and stored coverage; requests a report only when due. |
| Weekly DataForSEO collection | 8 days | One missed weekly collection. |

The pass is sequential so a reboot does not turn into a provider/API burst, and
it works **cheapest cadence first** — 15-minute lanes, then 20-minute, hourly,
daily and finally weekly — so a 40-minute weekly collection can no longer leave
the wall's counters stale behind it. It holds **only the lanes in its own plan**,
and releases each one the instant that lane's catch-up firing finishes: a
regular tick of a still-owed lane records a skip, while every other lane ticks
normally right through the pass. A recorded failure counts as a firing and is not immediately
retried forever; normal lane policy owns its next attempt. Beads hub health and the portfolio
snapshot already run immediately at startup, so they are not replayed. Unknown
cron expressions are explicitly excluded, and the ingest refuses one anyway: an
expression no scheduled job runs on runs nothing and fails as `unknown_cron`,
which `pnpm os:cron` prints with the expressions it does run (bead
`ro-ujb9.217`). Manual migrations, seed/config apply, restore, kill-switch,
remote-deploy, auth/billing/consent, analytics-pipeline edits, holdout changes,
and guardrail edits are not catch-up lanes at all. Catch-up executes existing
approved measurements; it never edits their definitions.

> ⚠️ **Caveat:** local cron firing only happens while `os-up` is running. The
> office installation uses launchd precisely so closing a terminal, a process
> crash, or a login does not silently stop the crons.

## The beads task hub

[beads](https://github.com/steveyegge/beads) (`bd`) is a Dolt-backed task
tracker. Its default is an **embedded** engine per repo: one writer at a time,
one database per repo, no way to ask *what is in flight across the portfolio?*
The portfolio instead shares **one Dolt SQL server** — the hub — and every
repo is a **spoke**: a `bd` client in server mode holding connection settings
and no database of its own. Shared server is what makes concurrent writers
(several agents, several repos, at once) safe.

Tasks are **operator/agent coordination state, not signals.** Nothing here
enters the pulse envelope or the signal contract; the hub is a second store
beside the ledger, never inside it.

New installations use the [Compose profile](../db/dolt/host/README.md) and
fresh setup described at the top of this page. A native application can select
an independently prepared Compose hub through `NOTICEOS_DOLT_HOME`, the
absolute home containing `dolt/profile.json`. The profile supplies the endpoint,
credentials and exact service resources. A missing or malformed selected
profile refuses startup and backup; it never falls back to the old hub.

- **Hosting:** the declared Compose service restarts independently of `os:up`.
  Installations still using the [legacy native profile](../config/dolt-server.README.md)
  retain their Homebrew service and `dolt-server.yaml` until an approved cutover.
- **Data:** the declared Compose volume; legacy native installations keep
  database directories under their configured data path. These are runtime state.
- **Map:** saved task projects in the store tie each asset to its bead prefix
  and database. The product default [task map](../config/beads.json) has none;
  see its [contract](../config/beads.README.md).

### The runner observes the declared service

The hub is not an `os:up` child: every repository needs its tracker while the
runner is stopped. At startup, every 15 minutes, and before snapshot polls,
the runner probes the selected task endpoint and logs state changes. It backs
up that same declared service nightly. Stopping `os:up` does not stop the hub.

**Compose recovery:** follow the [declared profile procedure](../db/dolt/host/README.md#backup-and-recovery).
Use only its exact project, Compose file, service and volume. Missing persistent
data requires deliberate recovery; ordinary startup must not initialize or
adopt a replacement. Changes to an existing service or store require approval
for the exact target. Never start a retired native server, remove a gate lock,
or substitute a private server to make a failed command succeed.

**Legacy native diagnosis only:** when no task-service selector is configured,
the runner uses `CONFIG.beadsHubHost` / `beadsHubPort` and counts native
`dolt sql-server` processes. An open port with one process is reachable;
multiple processes indicate contention, and a process with a closed port can
indicate a lock crash loop. If process inspection fails, diagnosis degrades to
the TCP result. Dolt holds an exclusive write lock per database, so a second
server must never open the same data directory. Homebrew start/restart applies
only after confirming that this legacy service is still the declared hub and
obtaining approval for the exact service action.

### Explicit local hosted Tasks entry

`hosted-task-serve.mjs` composes the real Vite/Worker browser entry and the
qualified Node executor in one process. It requires an operator-prepared,
canonical owner-only runtime file and two explicit Worker configurations:

```sh
node scripts/hosted-task-serve.mjs --runtime-file ABSOLUTE_FILE --worker-config-root ABSOLUTE_DIRECTORY
```

The runtime file follows `HostedTaskRuntimeOptions` in
[`hosted-task-runtime.mts`](hosted-task-runtime.mts). It selects hosted or demo
mode, the identity and directory connections, fixed physical registry, pinned
task/grant-inspection binaries and private scratch directory. Worker profile,
origin and identity bindings must agree before pools or a listener open.
Worker state is reserved beneath that scratch directory as `worker-state`;
a conflicting existing state selector refuses startup. Shutdown restores the
captured selectors and awaits native requests, Vite/Workers and connections.
It retains operator-owned state; disposable fixtures retire their own state
only after shutdown.

The currently qualified transport is loopback HTTP with native adjacent task
clients, not a remote proxy or TLS deployment. There is no standalone host
discovery, raw task CLI, caller credential or missing-composition fallback.
The workspace-owned catalog translates logical browser projects into opaque
directory IDs; detail, history and every write carry explicit selection and
fresh session authority. Its Tower-compatible adapter is
[`hosted-tasks-api.mts`](hosted-tasks-api.mts); the earlier
[`hosted-task-http.mts`](hosted-task-http.mts) deliberately returns raw Beads
JSON and is not the browser adapter. Create/update/comment/close, Claim,
assignment, parent, deferral, labels and acceptance edits are declared by current
permission facts. Linked creation preserves canonical handoff metadata; labels
are bounded literal values and deferral is an exact calendar date or a clear.
Answer, Dismiss and human-gate Approve use the shared `tasks.decide` action:
only current person owners/operators (or the explicit standalone operator) may
decide. Services can file human asks but cannot answer, dismiss, remove their
human marker or close them through ordinary commands. Decisions record the
operator's response and release a wait; they execute no protected operation.
Undo cancels an unissued decision; every later dispatch reloads authority.

Every hosted mutation holds a fail-busy, per-workspace/project transaction
advisory lock through awaited task-process and scratch-profile retirement.
Mapping reads use that held direct-Postgres connection. This coordinates the
supported executors across processes, not Hyperdrive, external task writers or
a distributed transaction with Dolt. Known connection loss cancels owned CLI
work; a dispatched effect can already have committed. Standalone controls
retain their existing behavior. Local qualification does not activate a public
hosted service.

### Hosted runtime composition and recovery

Hosted operation uses explicit server composition; `pnpm start` and the office
Mac `os:*` commands remain standalone installation adapters. The local Tasks
entry above uses Vite for local qualification. The
[portable demo preview](../deploy/demo/README.md) serves compiled assets and
composes the real Worker, task and simulator handles behind an HTTPS proxy.
Neither entry starts a general hosted scheduler. The deployment owns these
handles:

| Component | Server-owned composition and lifetime |
| --- | --- |
| Browser and task service | [`startHostedTaskServer`](hosted-task-server.mts) takes a captured `HostedTaskRuntimeOptions` and canonical Worker config root; `close()` stops Vite before draining admitted native work and pools. |
| Compiled demo server | [`startHostedDemoServer`](hosted-demo-server.mts) verifies its built artifact inventory, fixes the public origin and demo profile, and owns Worker, native task and simulator lifetimes. [`hosted-demo-setup`](hosted-demo-setup.mts) prepares only new, empty synthetic stores. |
| Scheduled jobs | [`startHostedScheduler`](hosted-scheduler.mts) takes up to 64 unique workspace bindings: scoped store, fresh service-grant reader and fixed executable definitions. `close()` stops timers, marks its session stopped, cancels admitted adapters and awaits resource retirement. |
| Persistent demo | [`startHostedDemo`](hosted-demo-runtime.mts) takes one already seeded scenario/workspace, its service and explicit store/grant/directory connections, fixed task allocations, tool pins and scratch root. Its timer runs one tick at a time; `close()` cancels journal work and drains owned resources. |

The scheduler and demo APIs have no general HTTP provisioning route or
standalone environment fallback. The compiled preview entry reads its explicit
owner-only runtime file; fresh setup keeps bootstrap administrator credentials
outside that file. Other deployments must supply and own their compositions.
No `wrangler deploy`, DNS, remote cron or journal-reset command is implied here.
The public demo profile and its private simulator are separate handles: visiting
the demo never grants the simulator's authority.

The demo Tower also receives `NOTICEOS_DEMO_ACTIVITY_SERVICE_ID` and
`NOTICEOS_DEMO_SCENARIO_HASH` from that same fixed simulator composition. These
are its canonical service UUID and full lowercase SHA-256 scenario identity,
not browser inputs. Its admitted presentation read reports the latest completed
successful activity attempt for that workspace, service, definition and scenario.
Missing bindings or no completed generation show unknown generation time; a
new failed attempt does not replace the previous successful timestamp.

Before starting a prepared composition, the operator establishes these facts:

- Both Worker configurations and the native runtime select the same explicit
  server profile and canonical origin. Hosted identity uses the same session
  secret and identity database in both realms; demo additionally fixes its one
  canonical workspace. Binding names come from [`PRODUCT_ENV`](product-env.mts),
  not a client `VITE_*` value. Missing or conflicting selections refuse before
  a listener. Hosted login also needs its separately qualified trusted-edge and
  mail-delivery adapters; the loopback task entry does not establish them.
- PostgreSQL schema and narrow role grants are prepared through the separately
  approved maintenance/provisioning path. Operational, identity, task-directory
  and function-only service-grant connections have distinct authority. Hosted
  calls use direct PostgreSQL and fresh lifecycle/membership/grant reads, with
  no `onlyWorkspace()` or environment credential fallback. A catalog row is not
  evidence that its physical task database is initialized or safely granted.
- Task allocations match the authoritative directory and catalog. The executor
  verifies pinned Beads/Dolt tools, physical database metadata and exact task
  grants. Its separate inspection identity has only `USAGE` and `SELECT` on
  `mysql.*`; it can read privilege metadata, including credential hashes, so
  those credentials remain platform-private. Only fixed grant queries use it;
  it is never passed to task children. Task credentials, paths and tools are
  never supplied by a browser request.
- Scratch/profile/Worker state and object archives have explicit deployment
  custody. The local task entry retains its private `worker-state`; shutdown
  does not delete an operator's persistence. Tenant archives require workspace
  namespaces and stored manifests. Physical Postgres/Dolt backups may contain
  multiple tenants and cannot become customer downloads.

The locally qualified task listener and Dolt clients are loopback/native-adjacent.
Remote TLS/proxy transport, public login/delivery and shared-host backup/restore
must be qualified for the exact operator target before activation. The
[existing backup procedure](#backups--restore) describes its declared standalone
adapter; it does not certify a shared hosted restore. Record the source/schema,
role/registry versions, persistence destinations and independently tested restore
and app rollback candidates in the activation package. Existing-store migration,
live auth, hosting, DNS and verification require their own explicit approval.

#### Journal inspection and uncertain effects

Workflows exposes the selected workspace's persisted attempts and scheduler
status. A fresh heartbeat means the publisher is current, not that an external
step succeeded; status older than 45 seconds is stale. The job journal records
workspace, lane, occurrence, service, definition/input digests and bounded output,
not raw secrets or a saved bearer authorization. Retry requires the identical
registered definition and validated input, then fresh service/lifecycle authority.

| Recorded state | Meaning and supported response |
| --- | --- |
| `succeeded` | Recorded checkpoints are complete; the same occurrence does not execute them again. |
| `busy` | Another live occurrence lease owns dispatch; do not invent a different occurrence ID to bypass it. |
| `retryable` | The current failed step has no uncertain outside effect; the same input may resume within the five-attempt bound. Committed checkpoints, including completed outside effects, remain recorded and are not repeated. |
| `blocked` | Current admission refused; restore the specifically approved authority or leave the work blocked. |
| `uncertain` | An outside effect or its acknowledgement may have happened. Automatic replay is refused. |
| `exhausted` | The attempt limit or unrecoverable occurrence state halted work. It is not a successful skip. |

A database step and its checkpoint commit in one transaction. An outside step
records its start before dispatch; interruption, a lost commit acknowledgement
or a failed result write cannot prove that no effect occurred. Restarting the
scheduler or simulator does not resolve that uncertainty. There is no supported
reset/erase/replay command for uncertain or exhausted occurrences. Retain the
journal and independent destination evidence, halt the affected deployment-owned
activity, and obtain a separately reviewed recovery plan for that exact effect.
Never clear an effect marker, reseed the workspace or change an occurrence ID to
force another delivery.

Adapters must honor the supplied cancellation and await their owned child,
connection and scratch cleanup. The runner aborts a step at 30 seconds; cleanup
is awaited and may extend response time. Stop/close must finish before retiring
owned storage or switching composition. Demo catch-up remains bounded to seven
owed dates per tick; it stops at the first incomplete date and never deletes old
history or contacts a real provider to fill a gap.

### The snapshot poller (what feeds the Tower's `/tasks` board)

The Tower cannot read the hub: it is a Worker, the hub speaks MySQL, and the hub
is on this Mac. So the runner — which can reach both — photographs it and files
the photograph in the central store.

- **Cadence:** every minute (`CONFIG.beadsPollCron`), plus once at startup as
  soon as the ingest child is ready, so the board is not a minute stale after
  every restart.
- **Per project**, four `bd` reads against its explicit `installation/task-host.json` link
  (`bd -C <repo> …`, so `bd` resolves its own server-mode settings from that
  repo's `.beads/config.yaml` — the poller never holds hub credentials):

  | Call | Answers |
  |---|---|
  | `bd list --status open,in_progress,blocked --json --limit 0` | the not-started and in-flight counts, and the in-progress list |
  | `bd ready --json --limit 0` | what is claimable **now** (blocker-aware), in `bd`'s own ranking |
  | `bd blocked --json` | open beads still waiting on another bead |
  | `bd list --status closed --closed-after <7d ago> --json --limit 0` | what moved this week |

  Four rather than one because `bd list` reports each bead's **stored** status,
  which says nothing about whether its dependencies are done. `ready` and
  `blocked` are the blocker-aware questions, and re-deriving them here from
  dependency ids would be a second implementation of `bd`'s own semantics — one
  that drifts the first time `bd` learns a new rule. `--limit 0` is unlimited:
  the **counts** must be true even though the lists are truncated (10 ready,
  10 in flight, 5 closed) before they are sent.
- **Then** one `POST /api/beads-snapshot` to the local ingest worker, with the
  operator bearer read fresh from `.dev.secrets.json` each tick (rotating the
  secret needs no restart). The write appends a row and prunes anything older
  than 7 days — see [`db/README.md`](../db/README.md).
- **Failure isolation is per project.** A missing sibling repo, a repo with no
  `.beads/`, a `bd` that will not launch — each fails **that** project only,
  which lands in the snapshot as `{ok: false, error}` with empty lists. The
  other projects still file. On the board that renders as a quiet degraded line,
  never as "nothing to do".
- **A down hub skips the tick entirely**, with **one** WARN that stays silent
  until the situation changes (a hub down for an afternoon would otherwise write
  240 identical lines), and one INFO when it resumes. Same for a down ingest, a
  missing task map, and a missing `OPERATOR_TOKEN`.
- **It never writes a bead.** Work is claimed and closed with `bd` in the repo
  where the work happens; the Tower and this poller only read. (The
  bead-writing lanes below — panel review, push state, task map — are the
  runner's deliberate writes, each on its own schedule precisely so this one
  stays a read.)
- It also reads each spoke's `panel-review` beads — every status, closed
  included — and reports the open one, or the newest closed one, as
  `panelReview` on that project. Absent means *this poller did not look*; `null`
  means *it looked and there is none*. The two are kept apart so "we never
  asked" cannot render as "nothing to triage".

### The panel-review filer (the first bead-writing lane)

A weekly DataForSEO collection that lands in the archive with nothing asking
anybody to read it is a collection read never. This lane files the review.

- **Cadence:** hourly (`CONFIG.panelFilerCron`). The collection arrives once a
  week, so this only has to beat "somebody notices".
- **It asks ingest what landed** — `GET /api/serp-panel-landings`, operator
  bearer, one row per property carrying the newest **complete** collection day
  inside a 21-day window. Complete means exactly the five broad families in the
  collector registry, plus `serp-panel` when `config/serp-panel.json` names the
  property. A newer partial/failed/interrupted day cannot supersede the last
  coherent review identity. The runner uses the ingest door and the Worker cannot
  reach the hub; that route is the seam.
- **Then, per property with a landing:** one `bd list -l panel-review` against
  that property's repo, and — only if no review carries that collection day
  and the published panel holds it (next point) — one `bd create` in the same
  repo: label `panel-review`, due seven days after the collection day, metadata
  `noticeos_panel_asset` / `noticeos_panel_date`.
- **Published before reviewed** (epic `ro-cvl9`). The review points at the
  property's panel dir, which the daily refresh fills on its own schedule, so
  a landing waits until that dir's published `freshness.json` holds it: the
  `dataforseo` source reaches the collection day, and every family the landing
  names (`reports`) reaches it in that source's `reports[]`. A refresh that ran
  while the collection was still landing published only part of it. A waiting
  collection is one WARN line, once; the first pass after the refresh publishes
  it files the review. A property off the refresh roster publishes nothing, so
  its reviews wait and its log line says so.
- **Idempotence comes from the data, not from a cursor.** The identity of a
  review is (property, collection day), and both halves are re-derived every
  pass — the day from the collection manifest, the "already filed?" answer from
  the spoke itself. So a runner that was asleep when the collection landed files
  it on its next pass, and a runner that already filed creates nothing, forever.
  There is no state file to lose or corrupt.
- **Every failure path writes nothing.** A partial provider collection never
  reaches the runner. A `bd list` that failed, exited
  non-zero, or returned unparseable JSON, or a published `freshness.json` that
  cannot be read, is an ERROR line and no `create` — a
  duplicate review is worse than a late one, and the next pass is an hour away.
  A property with a collection and no saved task project is named once,
  not hourly.
- **The collection day is the anchor; the week's whole collection is the scope.**
  The bead asks for the panel *and* the rest of what that property collected
  that week — the ranked-keywords inventory, the link and LLM families, its own
  GSC/GA4/Bing exports — because the panel landing was the only thing that could
  ever produce a review obligation, so everything else was collected weekly and
  read never. Nothing needs pulling: the daily panel refresh already left it all
  in the property's panel dir.
- **A property with no panel owes the same review** (`ro-478`). Anchoring on the
  panel alone leaves the trigger narrower than the scope: a property
  without one still buys report families every Monday and
  is never asked to read any of them. Two title forms, one identity: a panel
  property gets *"Triage the `<YYYY-MM-DD>` serp panel for `<asset>`"* and one
  without gets *"…signal collection for `<asset>`"* — same label, same due date,
  same two metadata keys, and the dedupe read recognizes both wordings so no
  review filed before this goes unseen. A property that buys nothing still owes
  nothing.
- What closing one of those beads requires is
  [serp-opportunity-execution §Panel review](../docs/playbooks/serp-opportunity-execution.md#panel-review)
  and [§Inventory pass](../docs/playbooks/serp-opportunity-execution.md#inventory-pass).

### The push-state filer (the second bead-writing lane, plus `bd gate check`)

A push bead filed by hand rots: its referent moves under it and nothing closes
it. This lane makes push beads self-maintaining.

- **Cadence:** hourly at :40 (`CONFIG.pushStateCron`), staleness threshold
  `CONFIG.pushStaleHours` (24h).
- **Per saved project**, using its matching `installation/task-host.json` checkout: `git fetch origin main`, then
  `git rev-list --left-right --count origin/main...main`.
- **Ahead 0 with an open `push-state` bead** → it closes every one, actor
  `os-up-push-filer`, with the fetch + rev-list evidence in the reason.
- **Ahead >0, oldest unpushed commit ≥ 24h, no open `push-state` bead** → it
  files ONE: labels `push-state,human`, P1, no commit count in the title (a
  pinned count is exactly what rotted on the hand-filed bead), the commit list
  as of filing time in the description, metadata `noticeos_push_asset`.
- **Unknown state files and closes NOTHING.** A failed fetch (launchd without
  the SSH agent), unreadable counts, or an unreadable bead list each skip the
  spoke with a transitions-only WARN — a push bead wrongly closed is a
  production release nobody is reminded to make.
- **…but it is never silent** (bead `ro-ujb9.188`). Every pass, each spoke
  whose fetch or counts failed is in the run record as a failed item with a
  reason code (`pushStateUnreadReason`: `remote-sign-in-refused`,
  `remote-unreachable`, `git-read-failed` — git's own text stays in the log),
  so the run fails and System health's operations area shows
  "Unpublished commit checks · Unknown · <sites> · <reason>", linked to that
  run. A repo that is not on this machine is not unread and is not listed.
- **Same tick, every existing spoke:** `bd gate check` — gate evaluation has no
  git dependency, and nothing else schedules it, so this is also what makes
  `timer` gates actually close across the hub.

Task polling and filers read saved membership through `task-project-config.mjs`.
An unavailable store stops the pass explicitly; stale exports are never used.
A project without an exact host link produces a per-project setup error and
cannot execute commands. Other linked projects continue.

### The task-map lane (which project's database the hub does not have)

The saved task map declares the project's database. Local execution requires a
matching asset/prefix/database host link. This lane checks declared names
against the physical hub and files an operator task when a database is absent.
Physical backups use the separate host inventory, so workspace removal cannot
silently remove backup coverage.

- **Cadence:** hourly at :05 (`CONFIG.beadsMapCheckCron`) — off every other
  lane's tick, and the cheapest pass here: one `SHOW DATABASES` for the whole
  portfolio, then a `bd list` only when something has drifted.
- **Drift** is a declared name the hub does not hold, or a project with no usable database.
- **Drifting, no open bead** → it files ONE into the `ro` tracker:
  labels `task-map-drift,human`, P1, actor `os-up-task-map`, metadata
  `noticeos_task_map_asset`, and a description carrying both fixes — `bd init
  --database` in the spoke, or the value on `/settings#task-hub`.
- **Agreeing, with an open bead** → it closes it with the `SHOW DATABASES`
  evidence and the timestamp. A later drift files a **fresh** bead.
- **A hub that will not answer decides NOTHING** — no filing, no closing, and
  the bead list is not even asked for. An empty answer would mean every project
  had drifted, which only a hub that genuinely answered may license.

**Why a bead and not a WARN line:** the whole defect is that nobody is watching.
An ERROR in the log at 04:07 is the signal that already existed and already
failed. `/api/settings` cannot carry this either — it is a pure builder over
config with no I/O by contract — so the honest surface is the operator's inbox
(`bd human list`, and the Tower's Tasks board).

Project setup uses `bd init` from the checkout, a saved logical mapping, and an
explicit host link. The complete [setup contract](../config/beads.README.md#how-a-new-project-joins)
includes the required spoke configuration and freeze register:

```sh
bd init --server --external --server-host 127.0.0.1 --server-port 3308 \
  --server-user root --prefix <PREFIX> --non-interactive --skip-agents --skip-hooks
```

Each flag earns its place:

- **`--external`** keeps the hub-and-spoke shape honest. Without it `bd`
  silently starts *its own* server on a derived port whenever the configured one
  is unreachable — that project quietly stops sharing the hub while appearing to
  work.
- **`--skip-agents`** stops `bd` writing `AGENTS.md`, `CLAUDE.md`, `.claude/`
  and `.codex/` scaffolding into the repo. In this repo `AGENTS.md` is the
  context pack and is not `bd`'s to edit.
- **`--skip-hooks`** stops it repointing `core.hooksPath` at `.beads/hooks`,
  which silently disables whatever hooks the repo already had.

> ⚠️ `bd init` **commits its own files** (`.beads/`, plus `.gitignore` lines) as
> it goes, and sweeps in whatever else is already modified. Check `git status`
> first, and expect to un-commit if you wanted to stage it yourself.

## Backups & restore

- **Run result:** `scripts/host-backup.mjs` owns the complete operation. A run
  fails if any required store, restore-instruction write, local publication,
  configured offsite handoff, or cleanup fails. Each stage retains its result;
  one store's failure never prevents attempting the other stores. The runner
  records the overall failure, and `pnpm os:backup` exits nonzero on failure.
  [Backup terminology](../CONTEXT.md#backup-evidence) distinguishes a backup
  set, the run, the offsite handoff, and restore verification.
- **Overlap:** a concurrent manual or scheduled attempt fails before copying or
  pruning. The active attempt holds a host claim through the handoff and cleanup;
  a later run removes claims left by exited processes.
- **When:** 04:00 UTC nightly (a separate schedule, not a wrangler cron), plus
  on demand with `pnpm os:backup`.
- **What (Postgres):** a custom-format `pg_dump` of the operational database
  goes to `.local/backups/<YYYY-MM-DD>/postgres/noticeos.dump`, mode 0600.
  It uses the declared `<home>/postgres/profile.json` Compose project, after
  checking that Docker's selected endpoint is local. It never discovers a
  project, starts a service or applies a migration. Inside that container,
  `postgres` authenticates over its own socket without a password. The dump
  preserves database ownership and permissions; it contains no role passwords
  or host bootstrap files. Missing profile, failed command, timeout or invalid
  dump fails the stage. See the [profile and restore contract](../db/postgres/host/README.md#backup-and-restore).
- **How R2's SQLite metadata is opened:** read-write, although the backup only reads
  it (`ro-paxb`). A WAL database cannot be read without its `-shm` index, and a
  read-only connection cannot create one, so an idle WAL file whose last
  connection already closed and removed the sidecars — the R2 metadata between
  requests — refuses a `-readonly` open.
  The command is `sqlite3 -ifexists <source> '.timeout 5000'
  '.filectrl persist_wal 0' '.backup …'`: `-ifexists` never creates a vanished
  source, and `persist_wal 0` overrides macOS sqlite3's default of keeping the
  WAL, so an idle source is left exactly as found. A live store's sidecars are
  untouched because the snapshot is not its last connection. Never
  `?immutable=1`: it skips locking and the WAL, and exits 0 on a snapshot that
  is missing committed data.
- **What (R2):** the raw-archive store `.wrangler/state/v3/r2/` mirrors into
  `<date>/r2/` — content-addressed blobs as plain copies (immutable once
  written), its sqlite metadata through the same online-backup API. Blob and
  metadata failures both count; an existing readable empty store is valid,
  while an unreadable or missing store is a failure.
- **What (task hub):** every valid database in `installation/task-host.json` is backed up to
  `.local/backups/<YYYY-MM-DD>/beads/`. This is **not** a file copy —
  copying a live Dolt server's files captures a torn state. Each database gets
  `CALL DOLT_BACKUP('sync-url', 'file://…')` against the running server, which is
  consistent by construction. It therefore needs the hub service **up**: with it
  stopped the hub stage fails and the other stores are still attempted. A missing,
  malformed or empty host inventory fails the hub stage. Invalid database names
  also fail the stage, while every valid name is still attempted. Valid names remain
  covered if a checkout link is broken, a workspace removes a project, or the
  configuration store is unavailable.
  A declared `dolt/profile.json` selects the Compose transport: snapshots go
  under `beads/databases/<database>/`, alongside stable server permissions,
  branch permissions, repository configuration and private recovery credentials
  in `beads/metadata/`. A checksummed `beads/backup.json` is written only after
  the declared set is complete. The hub stays online; databases are snapshotted
  sequentially, not as one cross-project transaction. A malformed profile or
  incomplete snapshot fails the backup without falling back to another server.
  Without a Compose profile, the existing host transport keeps
  `beads/<database>/` and its existing connection behavior.
- **RESTORE.md:** every dated dir carries a generated `RESTORE.md` — what the
  snapshot is, how each store's half went on that run, and how to restore each
  one — so the backup explains itself to whoever (or whatever) finds it. It
  describes copy results; the final handoff result belongs to the job record.
- **Asset databases:** explicitly approved `assetBackups` entries in the host's
  `host-backup.json` run each checkout's fingerprinted `backup:prod` npm task.
  New SQL files are compressed into `<date>/assets/<asset>/*.sql.gz` and their
  raw temporary files removed. A changed task fails before execution; missing,
  empty or failed exports fail the run while independent stores are attempted.
  Setup, production impact and the task contract are in
  [`config/host-backup.README.md`](../config/host-backup.README.md#asset-production-exports).
  Native Cloudflare D1 targets come from **Integrations**, through the fixed
  standalone machine route authenticated before SQL access. The selected local
  loopback door or protected Compose service supplies exports; the host never
  decrypts provider credentials or follows download redirects. Verified SQL
  streams into `<date>/cloudflare-d1/<account>/<database>/export.sql.gz` with
  receipt and restore custody. All targets must finish and the selection must
  stay the same. Overlap with a legacy asset declaration fails before execution.
  Hosted and demo profiles do not expose this machine route.
- **Same-day reruns:** only a complete required-store set replaces the dated
  set. A failed store publishes nothing, hands off nothing and prunes nothing;
  the previous complete backup remains. Each attempt uses fresh temporary
  directories, so old databases, sidecars and blobs cannot merge into it.
  Publication keeps the previous set at `.backup-previous-<date>` until the
  replacement succeeds. After an interruption, the next claimed run restores
  a missing dated path from that retained set before starting another backup.
- **Offsite:** the finished dated dir is then copied under
  `<offsiteBackupDir>/<date>/` — the folder this host names in its
  installation's `host-backup.json`, which a sync client such as Google Drive
  carries off-machine (D10 as amended; `ro-t34`;
  [`config/host-backup.README.md`](../config/host-backup.README.md)). The file is
  read at every run; the product default names no folder, and the run records
  `Offsite handoff: not_configured`.
  The handoff stages a copy before replacing the dated destination, preserving
  the previous handoff if copying fails. A missing synchronization parent fails
  the run without creating a phantom local tree. A completed handoff proves the
  local folder copy, not remote synchronization or a successful restore.
- **Retention:** after a complete successful run and configured offsite handoff,
  rotation applies to entire dated sets in both trees. Host settings can keep
  daily and weekly complete sets (for example two of each), with the first
  successful set of each UTC Monday week as the weekly anchor. Unrecognized
  folders remain untouched under this policy. Without that setting, the legacy
  30-day cutoff applies. Failed source, publication or handoff stages block
  rotation, preserving earlier recovery points.

The operation tests use scratch stores and controlled filesystem/process adapters:
`node --test scripts/backup-retention.test.mjs scripts/host-backup.test.mjs scripts/host-backup-postgres.test.mjs`.
They include real SQLite WAL snapshots and a full-schema Postgres dump restored
into a second disposable cluster, with row digests, schema, permissions,
encrypted credentials, archive references and application reads/writes checked.
They never access the installation's stores.

**Restore drill** — restore a completed set into isolated stores first. Prepare
the Postgres roles and an empty owner-owned database, then restore its dump;
do not apply the migrations before restoring. Follow the set's `RESTORE.md`
and the [Postgres procedure](../db/postgres/host/README.md#backup-and-restore).
Restore `<date>/r2/` as a complete R2 tree, without stale SQLite sidecars.
Reconcile rows, ledger totals and archive references before enabling the app.
Each store's snapshot is consistent independently; the set is not one shared
transaction. Replacing live stores requires explicit operator approval and a
stopped runner.

**Compose task-hub restore** — follow
[`db/dolt/host/README.md`](../db/dolt/host/README.md) to restore `beads/` into a
new, empty project with the pinned image. Restore the snapshots and permissions
together, then verify task records, history and access. The helper refuses to
overwrite an existing service or data volume.

**Legacy host task-hub restore** — only for an installation still declared
against the native profile, with no `NOTICEOS_DOLT_HOME` or task-client selector.
Do not use this procedure on a retired source after a Compose cutover. With the
exact native hub **service** stopped under operator approval (`brew services stop
dolt`; the runner is irrelevant here), a backed-up database is a Dolt
repository: put it back as the database's directory under the hub's data dir,
then start the service again.

```sh
brew services stop dolt
rm -rf .local/beads-dolt/<database>
cp -R .local/backups/<YYYY-MM-DD>/beads/<database> .local/beads-dolt/<database>
brew services start dolt
```

Restoring one database does not touch the others — each is independent.

## launchd service — the office Mac's normal state

The repo owns a launch-agent template at
`scripts/launchd/local-service.plist`; nobody fills it in or copies it by
hand. Its label is `com.noticeos.local`, or — on a Mac where a service
installed before the NoticeOS rename is present — that service's own
`com.reindexos.local`, which every `pnpm os:*` command keeps using
(`scripts/resource-names.mts`). One idempotent command resolves the absolute Node path, the runtime
copy's `current` link and this checkout (as `NOTICEOS_HOME`), atomically
writes the user-agent plist, loads it with `RunAtLoad` + `KeepAlive`, and waits
for classified health:

```sh
pnpm os:install
```

Re-running it replaces and reloads the same agent: it waits (up to the same
12 s `os:stop` allows) until launchd has let go of the old one before loading
the new plist, and retries a load refused with `Input/output error` once. If the load
still fails it says the OS is STOPPED and prints `Recover: pnpm os:start`; it
blames a disabled label only when `launchctl print-disabled` shows one.

It refuses until a runtime copy exists — `pnpm os:deploy` prepares one (below)
— and when an unmanaged foreground runtime already answers, because killing an
unknown process tree is not an installation step. Stop that terminal, then
repeat the command. To
restore the pre-service state, `pnpm os:uninstall` stops this exact agent and
removes only its installed plist; runtime data, logs and the runtime copies
remain.

### Merging is not deploying — `pnpm os:deploy`

A service that ran the Tower's dev server and the ingest from this very
checkout would hot-reload production on every merge. So the service runs a
**runtime copy** of the code:

```
.local/runtime/runtime-a    ┐ two git worktrees (detached, locked), used in turn
.local/runtime/runtime-b    ┘
.local/runtime/current   →  the live one; the plist runs current/scripts/os-up.mjs
```

A merge changes this checkout and never the runtime copy. `pnpm os:deploy` is
the step after a verified merge:

1. **Verify** — and refuse with nothing changed — that the commit is on `main`
   (its HEAD, or `-- <commit>` that main contains); that it moves forward from
   the commit running now (back is `-- --rollback`); that both runtime copies
   are clean (nobody hand-edited production); and that both Worker configs
   declare Postgres without D1 bindings. Legacy D1 targets are refused, including
   rollback candidates, before any store connection. The check refuses a
   `db/postgres/migrations` file
   the installation's database has not applied, printing `pnpm os:stop` →
   `pnpm postgres:migrate apply …` → `pnpm os:start`, and one the database
   applied with another SHA-256; one the database has and the commit does not
   carry (a rollback past a migration) is named and allowed. It reads
   `noticeos_migrations.applied` read-only, as the application login, through
   the address the runner starts with. CI results are not visible on this
   machine, so "verified" does not claim them.
2. **Prepare the idle copy** while the live one keeps serving: checkout, the
   links below, `pnpm install --frozen-lockfile` (niced). A failure here changes
   nothing live.
3. **Switch once**: point `current` at the prepared copy and restart the service
   one time through the restart-and-health-wait `os:restart` uses (a 90 s budget:
   a fresh copy may pre-bundle dependencies). The restarted runner must report
   the deployed commit. A failed wait prints status and the recent redacted log
   exactly as `os:restart` does, then **goes back by itself** (bead
   `ro-ujb9.114`): `current` returns to the previous copy with one more restart,
   and the deploy says whether that came back healthy. It does this at most once
   and never after `-- --rollback`; if going back fails too, or there is no
   previous copy, it stops with the status, the log and `Next: pnpm os:doctor`.
4. **Record** the move in `.local/logs/deploys.jsonl` — a failed deploy and its
   automatic rollback (`"automatic": true`) are two entries. Once a minute the
   runner forwards each entry to the store as an annotation on the OS asset
   (`scripts/os-deploy-forward.mjs`, bead `ro-trai.8`), so the Wall feed shows
   Deployed, Rolled back or Deploy failed. The log is read through an
   adapter (`OsDeploySource` in `scripts/os-deploy-events.mts`); an install with
   no host log forwards nothing.

`-- --check` runs step 1 and stops. `-- --rollback` points `current` back at the
other, already-installed copy with one restart. With the service stopped, a
deploy moves the link and starts nothing; `pnpm os:start` runs it.

**State stays home; only code moves.** The runner, the Tower's local lanes and
the dev server's store resolve from this checkout (`NOTICEOS_HOME` in the
plist), so local R2 state (`.wrangler/`), `.local/` (logs, heartbeat,
schedules, backups, signal dumps), the secret files and `installation/task-host.json`
with its relative checkout paths are exactly where they were, and a Save in the
Tower still commits here. Code that finds its state relative to its own file
reaches the same files through links: in each runtime copy `.wrangler`,
`.local`, `workers/ingest/.dev.secrets.json` and `workers/ingest/.dev.vars` are
symbolic links to this checkout's paths. Nothing copies, moves or re-creates the
store, and a deploy reads the Postgres address through the runner's own reader (`runner/database.mjs`), to read `DATABASE_URL`,
which it never prints. A runner in a runtime copy
re-checks its shared-state links and Postgres connection before it starts anything
(exit 4 otherwise). [`os-runtime.mjs`](os-runtime.mjs) owns these rules and
[`os-deploy.mjs`](os-deploy.mjs) the deploy.

`pnpm os:status` shows it in one line — the commit the runner reports and how
far `main` is ahead (`main is 3 commits ahead — pnpm os:deploy`); `pnpm
os:doctor` adds the store's migrations against main's.

**Cut-over, once, by the operator.** An older install runs the
checkout itself; `pnpm os:status` says `runs from this folder, so every merge
reloads it`. Two commands, each safe on its own:

```sh
pnpm os:deploy    # prepares .local/runtime/current from main; the running service is untouched
pnpm os:install   # rewrites the plist to run the runtime copy: one restart, waits for health
```

To stop using the runtime copy, `pnpm os:uninstall` and run `pnpm os:up` in a
terminal from this folder, which is the pre-service state.

launchd runs Node directly and sends its duplicate stdout/stderr capture to
`/dev/null`; the runner owns the one redacted, rotated combined log. LAN exposure
remains the service default. Loopback-only mode is still available for a
foreground `pnpm os:up -- --local` session after uninstalling the service.
If the supervisor itself is forcibly killed, its replacement may clean up the
detached Tower group only when a fresh managed heartbeat names that exact group
and the old supervisor no longer exists; every ambiguous or foreign listener is
left untouched for the single-instance guard to refuse.

### Stop for maintenance is not uninstall

`pnpm os:stop` and `pnpm os:start` move the **installed** service between loaded
and not; neither writes or deletes the plist. That is the pair a migration or any
other "the store must be closed for a minute" task uses.

```sh
pnpm os:stop     # bootout, then wait until 127.0.0.1:8791 stops answering
pnpm os:start    # bootstrap the same plist again
```

`os:stop` does not return success until the ingest door is actually free, because
`launchctl bootout` answering 0 only means launchd let go of the label — the
runner's clean shutdown still has to group-kill its `vite` child, and until that
finishes the ingest door can still answer. It polls for up to 12s: the
runner's own 5s-then-2s shutdown budget plus slack. If the port is *still* held
after the bootout, that is a foreground `pnpm os:up` or an orphan rather than the
service: `os:stop` says so, prints the same `lsof` line
`os:restart` prints, and exits nonzero.
Both verbs are idempotent — stopping a stopped service and starting a running one
each report the state and exit 0. `os:start` deliberately does **not** wait for
health (vite needs a few seconds); `pnpm os:status` is the health check.

### Agent recovery contract

1. Run `pnpm os:status`. Do not infer health from a listening port or process
   name. `healthy` requires launchd + fresh runner heartbeat + ingest + Tower
   and successful PostgreSQL/task-database readiness reads;
   `stale` means the endpoints answer but the supervisor stopped proving life.
2. Run `pnpm os:logs -- --lines 200`; add `--follow` only while reproducing.
3. Run `pnpm os:doctor` before a restart when the cause is unclear. Its output is
   bounded to 200 combined-log lines and 100 structured job records and is
   redacted. Readiness uses the existing operator bearer without printing it.
4. `pnpm os:restart` is safe for ordinary runner/Tower code already authorized
   by the task. It only targets the loaded repo-managed service, waits up to 45s,
   and fails with recent output if health does not return. Ask the operator first
   when the work touches a forever-forbidden surface (auth, billing, security
   headers, DB migrations, consent, analytics/tracking, holdouts, or guardrail
   thresholds), when an unapplied migration may exist, or when status reports an
   unmanaged runtime. A restart is not permission to change those surfaces.
   A restart runs the same code again: merged work reaches the live OS only
   through `pnpm os:deploy`, under the same rule — ordinary work already
   authorized by the task, a verified main commit, never a forbidden surface
   without the operator.
5. `pnpm os:install` / `pnpm os:uninstall` alter the login service and are run
   only for an operator-directed installation or removal task. `pnpm os:stop` /
   `pnpm os:start` take the OS down and bring it back without touching the plist;
   they are the operator's maintenance pair (see above) and are not a recovery
   step an agent reaches for — `os:restart` is.

## Notes

- `.local/` (logs, backups, the task hub's Dolt data, the runtime copies) is
  **runtime state** — git-ignored, never committed.
- The runner is plain JS on purpose (no toolchain). Tunable constants — ports,
  backup schedule, retention, restart/backoff limits — are the `CONFIG` block in
  `scripts/runner/config.mjs`.
- **The root suite never reads the checkout's own `config/`** (bead
  `ro-ujb9.97`). `pnpm test:scripts` preloads `scripts/script-tests-setup.mjs`
  into every `scripts/*.test.mjs` process, and there any read or import of
  `config/` — by the test, or by a script reaching for its default path — is
  refused before the file is touched. A test uses the frozen copies in
  `scripts/fixture-config/` or a temp repo; the only exceptions are the
  seed-validation tests listed, each with its files and reason, in
  [`test-config-isolation.mts`](test-config-isolation.mts). So an operator
  saving a setting (which `pnpm config:export` writes into the installation folder)
  cannot change a result. Run one file on its own with the same preload:
  `node --import ./scripts/script-tests-setup.mjs --test scripts/<name>.test.mjs`.
  The full run also loads `scripts/script-tests-global.mjs` once, which keeps
  one folder of Worker bundles for the run, so files that bundle the same
  Tower or ingest Worker build it once (issue #10). A file run on its own
  bundles as before.
- **No unit test runs a Worker on the checkout's `.dev.vars`** (bead
  `ro-ujb9.182`). Wrangler reads a Worker's local secrets from beside the
  config it is given, and no pool or wrangler option turns that off. So the
  ingest suite's Workers pool and the Tower's end-to-end door test get the
  Worker configs copied into a new, empty folder, with the `.env` and process
  reads switched off ([`worker-config-folder.mts`](worker-config-folder.mts),
  the same relocation `pnpm start` uses). `worker-config-folder.test.mjs`
  proves it against the installed wrangler with invented values;
  `workers/ingest/test/test-env.test.ts` proves the Worker's env holds only
  the bindings its vitest config declares.
- **Every Vite dev server a test starts goes through
  [`test-vite-server.mts`](test-vite-server.mts)** (beads `ro-ujb9.186`,
  `ro-ujb9.192`). Vite 8 starts its dependency optimizer on `listen`, and a
  server closed while that is still bundling crashes inside rolldown (SIGSEGV,
  SIGBUS) or never exits. `createTestViteServer` gives each server a close,
  Vite's own on SIGTERM included, that waits for the optimizer; no optimizer
  when no page is loaded (`pages: false`); its own cache folder in the OS temp
  dir; and no file watcher. `test-vite-server.test.mjs` fails on a file that
  imports Vite's `createServer` without it, and
  `apps/tower/test/test-vite-server.test.ts` checks the wait against real Vite.
- **No literal NUL byte in source** (bead `ro-20n`). One inside a string makes
  macOS's BSD grep classify the file as binary, so a plain `grep -n` finds
  *nothing* in it while `grep -an` finds the hits — an agent looking for a
  symbol concludes it was never written. Write the escape `\0` instead;
  `scripts/grep-visible.test.mjs` sweeps every tracked `.mjs`/`.ts`/`.tsx`/`.md`
  for a recurrence. **A search that reports success while finding nothing is
  worse than a missing file.**

---

# Database migrations

Postgres is the only supported operational database. Legacy D1 migration and
import commands have been retired; the completed transition tools are frozen
in the private recovery source at release `a85e8283`.

## The Postgres store's counterpart (`postgres:migrate`)

`pnpm postgres:migrate` (= `node scripts/postgres-apply.mjs`, bead
`ro-ujb9.76.34`) applies `db/postgres/migrations/` to an installation's own
Postgres database. It is operator-only; the private installation's approved
cutover is recorded on `ro-ujb9.76.10`. Neither restart nor deploy applies
migrations. An approved maintenance operation uses this explicit sequence,
with `NOTICEOS_OWNER_URL` supplied in the protected environment for the
explicitly approved target:

```sh
pnpm postgres:migrate status --database noticeos --url-from NOTICEOS_OWNER_URL    # only reads
pnpm os:stop
pnpm postgres:migrate apply --database noticeos --url-from NOTICEOS_OWNER_URL --confirm noticeos
pnpm os:start
```

It runs the development runner's own code (`pnpm postgres:dev`, which takes
development databases only) with the same lock, single transaction and
per-file hashes. It refuses a development database, needs the database's name
typed twice, runs as `noticeos_owner` only, and applies only migrations
`db/postgres/frozen-migrations.sha256` lists. Nothing at runtime, restart or
deploy can load or run it (`scripts/postgres-migrate.test.mjs`). The rest,
with the one-workspace `bootstrap` and a host that needs a password, is in
[db/postgres/README.md](../db/postgres/README.md#applying-it-to-an-installations-own-database).

---

# Dev fixtures (`seed:local`)

`pnpm seed:local` (= `node scripts/db-seed.mjs`, bead `ro-ujb9.76.57`) fills a
new installation's store with invented history, so a developer sees a
populated Tower without real data: two `.example` sites, fourteen nights of
their reports, five alerts, two months of money and the change a build cost was
spent on, with the prediction it shipped with, two counter readings and six
change notes ([`db/fixtures/dev-seed.json`](../db/fixtures/dev-seed.json)).

```sh
# Terminal 1: a foreground-owned, loopback-only development runtime
pnpm start -- --development --dir .local/development --no-open
# Terminal 2: populate that runtime with synthetic rows
pnpm seed:local -- --dir .local/development
```

The development command needs local PostgreSQL server binaries on PATH. It
creates its own marked native development cluster, applies every frozen
migration and bootstraps one workspace. It does not use Docker, initialize a
task hub, read Compose credentials or run scheduled provider lanes. The Tower
and ingest use loopback; Postgres uses the Tower port plus two. An ordinary or
mixed folder is refused before setup. Generated application credentials remain
in the folder's private secret file, never tracked files or command arguments.

Ctrl-C stops the runtime and removes its owned database. Starting the marked
folder again creates a fresh database with a new application password; run the
seed again. Interrupted or still-owned database state is refused rather than
adopted. The ordinary `pnpm start` path is unchanged and cannot reuse a
development folder without the explicit flag.

It reaches the store by the fact `pnpm start` reads, `DATABASE_URL` in the
folder's secrets file, checked the same way, and writes every row in **one
transaction** through the one Postgres helper as the application login: a
failure keeps none of them, and the store hands out every number and every
site's place. It opens no local store file, so it runs beside a started Tower.
It refuses, writing nothing:

1. **A folder `pnpm start` did not make**, or the checkout itself.
2. **A database that does not say it is for development**
   (`noticeos.profile = 'development'`, the development profile's mark). A
   `pnpm start` folder takes the Compose profile's address by default, which is
   an installation's own database, and `pnpm postgres:migrate`
   refuses a marked one: a database is seedable or real,
   never both. Use the explicit development command above; ordinary start
   does not change an installation database into a seedable one.
3. **A store that already holds data**: a row in `pulses`, `flags`,
   `ledger_entries`, `counter_readings` or `annotations`, or a site on one of
   the fixture's ids or domains. A seeded row is indistinguishable from a real
   one: once invented reports are mixed in with reports the OS received,
   nothing in the store can tell them apart and every number the Tower shows is
   quietly wrong. A second run is refused the same way.

The last two are decided inside the writing transaction, behind a transaction
lock, so two seeds at once seed once. `apps/tower`'s `db:seed:local` runs the
same script.

---

# The ingest in isolation (`pnpm --filter @noticeos/ingest dev`)

That command is `node scripts/ingest-dev.mjs` (beads `ro-y1g` / `ro-nyz`). It
starts the ingest Worker **standalone** — the isolation case
[`workers/ingest/README.md`](../workers/ingest/README.md#local-development)
documents — and **only while nothing is holding the store open**.

The guard prevents a second runtime from sharing local R2 persistence or
performing duplicate work. **It probes 8791, not 8787:** the running OS answers
on the ingest door even though standalone Wrangler uses another port.

With the door free it execs the same `wrangler dev --persist-to` as before,
extra flags passed through (`pnpm dev -- --test-scheduled`). With the door held
it spawns nothing and prints what to stop — including the fact that under
`os:up` the ingest is *already running*, inside the Tower's runtime, on 8791.

---

# Local secret source

Cloudflare exposes Worker secrets as string bindings, but nested portfolio maps
are not maintained as minified JSON inside dotenv. Copy the structured example:

```bash
cp workers/ingest/.dev.secrets.example.json workers/ingest/.dev.secrets.json
```

Edit the gitignored `.dev.secrets.json` as normal formatted JSON. Object and
array values are serialized to the string bindings the Worker already parses;
plain strings stay strings. `pnpm os:up` syncs the file to the generated
`workers/ingest/.dev.vars` before it launches Wrangler. One key never goes
there: `DATABASE_URL`, the database's address, which the runner and
`pnpm start` hand to the dev server's environment alone
([doc 06](../docs/06-operations.md#bootstrap-secrets-vs-integration-credentials)).

Existing installations migrate without re-entering a secret:

```bash
pnpm dev:secrets:migrate
```

That command lifts JSON-looking dotenv values into nested JSON, writes both
files mode `0600`, and never prints values. It refuses to overwrite an existing
structured source. `pnpm dev:secrets:sync` rebuilds `.dev.vars` on demand.
Direct `wrangler dev` remains compatible after a sync; deployed Cloudflare
secrets are unchanged.

# Credentials (`creds:check`)

The accounts-pass verification rails. The operator connects a provider on the
Tower's `/integrations` page, or leaves it in the legacy
`workers/ingest/.dev.secrets.json`; this script makes every credential
**provable the moment it lands** — [doc 15](../docs/15-operator-flows.md) flow C:
*"validation probe on save — one cheap real call; success shows a live data
sample — proof, not a checkmark; failure shows the provider's actual error + the
likely fix."*

```
pnpm creds:check                  # probe every configured non-explicit lane
pnpm creds:check --lane bing      # probe just one lane (incl. clarity/discord)
pnpm creds:check --lane google    # every lane one provider powers (ga4 + gsc)
pnpm creds:check --origin <url>   # where the running OS is (default http://127.0.0.1:5173)
```

## Which source it read (beads `ro-vu8d.10` / `ro-vu8d.15`)

**It asks the running OS first, and every row says which source answered.** A
credential connected in the product has no env binding at all, so an env-only
check would report exactly those as *not configured yet* — a false red
on the tool this README tells you to trust.

| The OS says | What the row shows |
|---|---|
| `source: store` (either of Google's ways in) | `POST /api/integrations/:provider/test` — the same probe the card's **Test** button presses, run **inside** ingest with the real credential. `source: store — entered in the product (…); probed by the OS at <origin>` |
| `source: env` | the local probe below, from `.dev.secrets.json`. `source: env — <slots> in <file>` |
| neither | the quiet `not configured yet — connect it on /integrations, or set <slots>` |

It **never learns to decrypt**: `CREDENTIALS_KEY` does not leave the Worker, so
a store-held credential is proved by the OS or not at all. With `os:up` stopped
the header says so in one line and the run falls back to the env-only check —
which is the old behaviour exactly, plus the notice that a credential connected
in the product is invisible from there.

One lane never gets a catalog provider: `ASSET_TOKENS` is one of the four bootstrap
secrets ([doc 06](../docs/06-operations.md#bootstrap-secrets-vs-integration-credentials)).
It stays env-only.

One more consequence, deliberate: a store-proved lane suggests **no**
`config/integrations.json` cell. A provider-level test proves the credential and
nothing about which properties it reaches, and the honesty gate below only
records what a probe actually proved.

Secrets live **only** in the store or in the gitignored structured source (plus
its generated Wrangler input) — never in a property's repo (doc 06).
`creds:check` **never prints secret values** — only slot names, presence, and
the data a probe returned.

## The slots

**Connect a provider on `/integrations` first.** These are the LEGACY bindings —
still read, still supported, and the fallback for installs that have not moved
([doc 06 § Bootstrap secrets vs. integration credentials](../docs/06-operations.md#bootstrap-secrets-vs-integration-credentials)
draws the line between them and the four bootstrap secrets that stay env
forever). Fill them in `.dev.secrets.json`
(`.dev.secrets.example.json` carries the full formatted shape), then move the
whole file across with **Import from this machine** on any Legacy env card.
Grouped by lane:

| Slot (env var) | Lane | Where to get it |
|---|---|---|
| `CREDENTIALS_KEY` | **All provider credentials** | `openssl rand -base64 32`. One of the four bootstrap secrets that stay in the environment forever ([doc 06](../docs/06-operations.md#bootstrap-secrets-vs-integration-credentials); D21, epic `ro-vu8d`): every provider row below is instead entered on the Tower's `/integrations` page, where it lives AES-GCM-encrypted in the store under this key. Store first, env fallback — the rows below keep working, and **Import from this machine** (or `pnpm dev:secrets:import`) moves them across once without retyping. Deployed: `wrangler secret put CREDENTIALS_KEY`. |
| `ASSET_TOKENS` | Self-report (pull) **and** pulse push | JSON map property → that property's single `ASSET_TOKEN` wrangler secret. One entry per property serves both directions: the ingest Worker checks it on an inbound `POST /api/pulse` and presents it on the outbound nightly pull and 15-minute counters scrape. Onboarding and rotation: [doc 11 §Credential naming](../docs/11-integrations.md#credential-naming--the-asset_token-convention). Already present. |
| `BING_WEBMASTER_API_KEY` | Bing Webmaster | Bing Webmaster Tools → Settings → API access → generate key. One central BWT account. |
| `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` | DataForSEO | `app.dataforseo.com` → API Access — the API login/password, **not** your account email. One metered key (doc 12). |
| `GOOGLE_SIGNAL_ACCOUNTS` | GA4 + Search Console | Nested object **service-account label → one encoded key + its supported properties** in `.dev.secrets.json`. Store each key once. Local sync extracts every encoded key to a bounded `GOOGLE_SERVICE_ACCOUNT_*` Worker binding and leaves only routing in `GOOGLE_SIGNAL_ACCOUNTS`. Per property, set `ga4_property_id`, `gsc_site_url`, or both; grant that service-account email GA4 Viewer and GSC Full-user access. The probes mint only read-only scopes. Full shape below. |
| `CLARITY_TOKENS` | Microsoft Clarity | JSON map asset → that project's data-export token (`clarity.microsoft.com` → project → Settings → Data export). **Per asset — no portfolio credential**, which is why it is the one `per-asset` card on `/integrations` (bead `ro-vu8d.9`): one input per asset, one encrypted row. This binding is the legacy fallback like every other row here. |
| `DISCORD_WEBHOOK_URL` | Discord | Discord → Server Settings → Integrations → Webhooks → New Webhook → Copy Webhook URL. The System's operator-notification channel. Connected on `/integrations` since bead `ro-vu8d.18`; this binding is the legacy fallback like every other row here. **The URL is the credential** — anyone holding it can post to that channel. |
| `CALENDAR_FEEDS` | Calendar (Wall meetings) | JSON map feed name → secret ICS URL, or `{url, color?, email?}` (Google Calendar → Settings → the calendar → Integrate calendar → *Secret address in iCal format*). **The URL is the credential** — the probe names feeds by label and never prints it. |

## What each probe actually does

One cheap **real** call per configured lane; the line shows what it saw:

| Lane | Probe (the real call) | Success sample |
|---|---|---|
| Self-report (pull) | `GET` each enabled `config/pull.json` endpoint with its `ASSET_TOKENS` bearer | 2–3 counter names it returned |
| Bing Webmaster | `GET .../GetUserSites?apikey=…` | verified site URLs; **names** the content properties not verified yet |
| DataForSEO | `GET /v3/appendix/user_data` (basic auth) | remaining account balance (it's metered — balance *is* the sample) |
| GA4 | mint one JWT-bearer token per configured service account with `analytics.readonly`, reuse it across that account's tagged properties, then call `properties/{id}:runReport` (1-day sessions) for each | per property: `N sessions yesterday` and the service-account label |
| Search Console | mint one JWT-bearer token per configured service account with `webmasters.readonly`, call `GET webmasters/v3/sites` once, then check each tagged exact property resource | per property: `resource readable` / `not readable by service account <label>` |
| Microsoft Clarity | `GET .../project-live-insights?numOfDays=1` (bearer) | metric blocks returned — **first configured project only** |
| Discord | `POST` the webhook a labeled test message | `test message delivered` |
| Calendar | `GET` each feed under the ingest lane's own request shape; failure classes are ingest's own codes (`http_403` = the link was likely rotated) | per feed: `N events in K KB of ICS` — labels only, never the URL |

These are the **env** probes. A lane whose credential is in the store is proved
by the OS instead (see *Which source it read* above), with the provider's own
sample in the same row.

A lane with **no credentials anywhere** prints a quiet `not configured yet` line
(not an error), naming `/integrations` first and the binding second. A
configured lane that fails prints the provider's real error **plus the likely
fix**, exactly as flow C requires.

### Google signal account map

The map is account-centric because a service account commonly supports several
properties. The encoded JSON key is stored once, then properties are tagged
under it:

```json
{
  "example-signals": {
    "service_account_b64": "<base64 of the service-account JSON key>",
    "properties": {
      "example.com": {
        "ga4_property_id": "123456789",
        "gsc_site_url": "sc-domain:example.com",
        "time_zone": "UTC"
      },
      "example.org": {
        "gsc_site_url": "sc-domain:example.org"
      }
    }
  },
  "other-signals": {
    "service_account_b64": "<base64 of the service-account JSON key>",
    "properties": {
      "example.net": {
        "ga4_property_id": "222222222",
        "gsc_site_url": "sc-domain:example.net"
      }
    }
  }
}
```

Put this nested object under `GOOGLE_SIGNAL_ACCOUNTS` in
`.dev.secrets.json`. A property can omit either provider field, but it must not
appear under two service accounts for the same provider. The probe fails closed
on that ambiguity. `gsc_site_url` is the exact
Search Console resource: either `sc-domain:example.com` or the full URL-prefix
property. `time_zone` is the IANA timezone that defines GA4's reporting day;
omit it and the collector falls back to the configured OS clock
(`config/constants.json` `os_time_zone`) and says so once per pull in a
`ga4_time_zone_assumed` line — so a self-hoster outside Pacific Time is not
silently mis-bucketed. GSC dates are always PT by provider contract. The alias (`example-signals`) is only a stable
operator-readable label; authentication uses the encoded key's `client_email`.
`pnpm dev:secrets:sync` converts aliases to generated bindings such as
`GOOGLE_SERVICE_ACCOUNT_EXAMPLE_SIGNALS`; do not add those generated names
to `.dev.secrets.json` yourself.

### The two probe-on-request lanes (and why)

`clarity` and `discord` never run in a default sweep — a probe **costs**
something:

- **Clarity** has a hard **10 calls/asset/DAY** cap (doc 11). A probe against the
  *environment file* burns 1 of the 10, so it runs only with `--lane clarity`
  (which warns first). A credential in the **store** is proved by the OS
  instead, and the OS's Clarity probe makes no call at all — it reports which
  assets hold a token and says the 04:30 export is the proof (bead `ro-vu8d.9`).
- **Discord** posts a **real message** to the operator channel (an external side
  effect) whichever half it is proved from, so it runs only with
  `--lane discord`.

## Rotating `CREDENTIALS_KEY` (`creds:rotate-key`, bead `ro-vu8d.11`)

```sh
pnpm creds:rotate-key                            # the loopback ingest door
pnpm creds:rotate-key --ingest http://127.0.0.1:8791
```

Re-seals each connection's current `noticeos.connection_secrets` version under
a new bootstrap key. Each guarded transaction inserts the next secret version
and removes its predecessor; `noticeos.integration_connections` keeps the public
connection facts ([Postgres model](../db/postgres/README.md#the-decided-model)).
**The sweep is not in this script**: it runs inside the ingest Worker
(`rotateCredentialKeys()`, behind an operator-authed
`POST /api/credentials/rotate-key`), because a script decrypting these rows in
Node would be a second place the plaintext exists — and the store's one rule is
that there is not one. This file presents the operator token from
`.dev.secrets.json`, then prints **counts and provider ids and nothing else**.

The full runbook — generate, put the old key in `CREDENTIALS_KEY_PREVIOUS`,
restart, run, remove, restart — is
[workers/ingest/README.md § Rotating CREDENTIALS_KEY](../workers/ingest/README.md#rotating-credentials_key-bead-ro-vu8d11).
Steps that touch a secrets file or restart the OS are the operator's; the script
does one POST.

It exits non-zero when a row could not be re-sealed, so a chained invocation
cannot read a partial rotation as a finished one.

## The changeset suggestion (it suggests, it never applies)

After probing, `creds:check` reads `config/integrations.json` and may print an
exact `pnpm config:apply --stdin` heredoc that records enrollment proof. It
**never applies** anything: the operator reviews the diff and answers y/N in
`config:apply` (doc 15 principle 1). This is setup documentation, not runtime
health. GA4, GSC, and Bing health is derived from the latest stored collector
attempt (fresh success/error/staleness/no-run), so the Tower never needs a
manual status change to turn an icon green or red. Only proved properties
appear in a suggested documentation update:

- **Bing** — only properties present in the verified-sites list.
- **Search Console** — each tagged exact resource visible to its service account.
- **GA4** — each property whose `runReport` succeeded (every configured account
  and property is probed).
- **Clarity** — only the one project the probe actually queried.
- **Discord** — the System row (asset #0).
- **DataForSEO** — the balance check proves only the shared credential.
  Per-property working/error state comes from the latest five weekly archive
  attempts, so the probe still suggests no manual status edit.
- **Self-report (pull)** is the pulse pipeline, not a doc-11 catalog lane, so it
  has no `integrations.json` cell and never appears in a suggestion.

# The config store (`config:apply`, `config:seed`, `config:export`)

`noticeos.config_documents` holds each whole JSON document keyed by its file
name without directory or extension (`config/tower.json` → `tower`), while the
API still uses `config/*.json` paths. `noticeos.config_changes` records the audit
beside it ([Postgres model](../db/postgres/model.json)). This lets a
**deployed** Tower save a setting — the half of D18 that needed a filesystem
(epic `ro-syok`).

The files did not stop mattering; their JOB changed. **Two folders** (bead
`ro-ujb9.125`): `config/` holds the product's generic defaults — what a fresh
clone seeds: no sites, no task projects, UTC. `installation/` holds this
installation's own documents, its applied changesets (`changesets/`) and its
host files (`task-host.json`, `dolt-server.yaml`). One resolver,
[`scripts/installation.mts`](installation.mts), finds it:
`NOTICEOS_INSTALLATION_DIR`, default `./installation`. A document keeps its
API name (`config/pull.json`) in both folders.

| Command | Direction | What it will not do |
|---|---|---|
| `pnpm config:seed` | installation's copy, else the default → store | **Never overwrites.** A document already in the store is skipped and reported at the version it is at. `--force <file> --reason <why>` is the deliberate way past it. |
| `pnpm config:export` | store → `installation/` (never `config/`) | Never commits. It writes the same bytes a Save writes, so an unchanged store leaves the checkout byte-identical. `--check` writes nothing and exits non-zero when the files are behind. |

Both reach the store through the loopback ingest door, like every other script
that needs it. A reachable, initialized Postgres store with an unseeded document
reads that document's compiled Worker copy. An unavailable store fails the read;
it is never treated as an unseeded installation.
`os:up` says which state the install is in, once, at startup.

`pnpm config:apply` previews the database's current document and saves through
its guarded write API, then exports the acknowledged result to the checkout.
It requires the named documents to be seeded. A stale export never supplies
an expectation or becomes a fallback after an unavailable/ambiguous save.
`--seed-files` explicitly edits offline seed files without changing the running
OS. A deployed installation is configured through its Tower, sites included:
`--remote` is refused; the site list is saved on Postgres through the ingest (bead
`ro-ujb9.76.4.2`). Document and asset-column changes use separate
changesets because their write paths cannot commit together. See the
[changeset contract](../config/changesets/README.md#applying).

# Raw provider signal archive (`signals:*`)

The daily `15 12 * * *` ingest lane keeps analysis-grade GA4/GSC/BWT provider
responses outside Postgres. The weekly `45 12 * * 1` lane uses the same boundary for
DataForSEO rankings, backlinks, Google/ChatGPT mention metrics, and — for a
property with a configured panel — its tracked head-term result pages. Wrangler's
`RAW_SIGNALS` binding is **local by default**, persisted under the same
`.wrangler/state` tree used by the local runtime. The commands below use the
running installation's ingest door and its bound archive store. `--remote` is
retired and refused by the download and publication commands. For a prepared
application container, use the [container operator commands](../deploy/compose/README.md#download-and-publish-stored-signal-reports).

Collect and flatten one property's local archive:

```bash
pnpm os:cron -- "15 12 * * *"
pnpm signals:download -- --asset example.com
pnpm signals:history -- --asset example.com --in .local/signal-dumps/downloads/example.com --out .local/signal-dumps/history/example.com
pnpm signals:analyze-history -- --asset example.com --history .local/signal-dumps/history/example.com --out .local/signal-dumps/reports/example.com
pnpm signals:publish-insights -- --asset example.com --file .local/signal-dumps/reports/example.com/executive.json
```

Collect DataForSEO once without re-running the daily Google/Bing archive:

```bash
pnpm os:cron -- "45 12 * * 1"
pnpm signals:download -- --asset example.com --integration dataforseo
pnpm signals:history -- --asset example.com --in .local/signal-dumps/downloads/example.com --out .local/signal-dumps/history/example.com
pnpm signals:analyze-history -- --asset example.com --history .local/signal-dumps/history/example.com --out .local/signal-dumps/reports/example.com
pnpm signals:publish-insights -- --asset example.com --file .local/signal-dumps/reports/example.com/executive.json
```

## Collect one property now (`signals:collect`)

`pnpm os:cron -- "45 12 * * 1"` fires the **whole** weekly lane: every property,
every family. Baselining one property that way bills every property. A bet
that launches on a Tuesday should have a baseline on Tuesday, at its own price
(bead `ro-282.1`):

```bash
pnpm signals:collect -- --asset example.com --families serp-panel
# Collecting serp-panel for example.com. Every call is metered; a tracked panel is
# one call per query PER DEVICE and takes a few minutes.
# example.com: 1 attempted, 1 collected, 0 unchanged, 0 failed. Billed $0.184000.
#   serp-panel           success   46 rows                  $0.184000

pnpm signals:collect -- --asset example.com            # every family it is due
pnpm signals:collect -- --asset example.com --families backlinks-summary,ranked-keywords
```

- **It spends money, and says how much.** The summary carries the same six
  decimals `archive_runs.cost_usd` stores, so the script, the
  manifest and the `dataforseo_dumps_complete` line in `os-up.log` agree. A run
  with any failed family exits non-zero.
- **It collects nothing itself.** The request goes to
  [`POST /api/signal-collect`](../workers/ingest/README.md#on-demand-collection-a-baseline-on-the-day-the-bet-launches)
  on the loopback door, and the ingest runs the *same* collector the Monday cron
  runs, scoped to one property: same cap gate, same retries, same manifest row.
  There is no second collector to drift. `pnpm os:up` must be running.
- **The refusals happen before the money.** A property the weekly lane does not
  collect, or a family it is not due — `--families serp-panel` for a property
  `config/serp-panel.json` does not name — comes back as a `422` naming the
  reason, never as a $0.00 "success".
- **Re-firing the same day** costs the provider calls but does not duplicate the
  archive: identical content is stored as `unchanged`.

**PostHog families (bead `ro-ghis.1`).** The same command collects one asset's
PostHog product analytics now, through the collector the daily `30 12 * * *`
lane runs (same key, region, project, funnels, budget stop and archive):

```bash
pnpm signals:collect -- --asset example.com --families 'posthog-*'
pnpm signals:collect -- --asset example.com --families posthog --start 2026-09-08 --end 2026-09-22
pnpm signals:collect -- --asset example.com --families posthog-events,posthog-funnels
```

Quote `posthog-*` in zsh (or write `posthog`), which otherwise reads it as a
file pattern. `--start`/`--end` pin one inclusive window, at most 28 days in the
project's timezone, for every family, so a past manual reading can be
reproduced. Without them each family uses its own trailing window. PostHog
charges nothing per query. A 429 from its hourly budget stops the run, and the
summary lists every family that was skipped and why. One run is one provider:
mixing a PostHog family with a DataForSEO one is refused.

Then read it back the usual way — `signals:download`, `signals:history`, `signals:analyze-history`, and
`signals:refresh` see an on-demand landing exactly as they see a Monday one.

`signals:download` asks the report runs for the newest successful immutable
object per provider/report/date, fetches each one, validates/decompresses it,
and writes:

```text
.local/signal-dumps/downloads/<asset>/<integration>/<report>/<date>.json
.local/signal-dumps/downloads/<asset>/manifest.json
```

`manifest.json` keeps every report day an earlier download or `signals:refresh`
recorded; a day this pass fetched replaces its earlier row. So a filtered run
never forgets the later collection that settled a GA4 day (bead `ro-m8lm`).

Filters are optional:

```bash
pnpm signals:download -- --asset example.com --from 2026-07-01 --to 2026-07-31
pnpm signals:download -- --asset example.com --integration gsc --report page-query
```

**It reads through the running OS.** Both halves
go to the ingest's operator-authed routes on the loopback door —
`GET /api/signal-archives` for the manifest (with those filters, and no window
imposed: no `--from` means every report day the store has) and
`GET /api/panel-object` for each archive, decompressed by the runtime that owns
the bucket binding. The installation must be running; the script opens no
database connection or second Worker. The archives land byte-identical to
the ones `signals:refresh` writes. `--door` selects that installation's local
ingest address; it does not select credentials for another installation.
Inside the [prepared container](../deploy/compose/README.md#download-and-publish-stored-signal-reports),
the same command uses the container's private door and mounted credentials.

`signals:analyze-history` reads value-event declarations from the running local
service's configuration database. It requires a seeded, valid document and
stops before replacing analysis outputs if that read fails. It records the
document version in `summary.json` as `configuration.valueEventsVersion`.
Panel refresh forwards its selected service address and token to this reader,
keeping report data and declarations tied to the same installation. A failed
declaration read prevents publication and preserves previous analysis outputs.
Historical provider labels, counts and query labels remain based on the archived
evidence.

The history writer normalizes archived provider dimensions and metrics; the
bounded analyzer reads one published generation into
one CSV per report family, `executive.json`, and `summary.json`:

```text
.local/signal-dumps/reports/<asset>/ga4-pages-screens.csv
.local/signal-dumps/reports/<asset>/ga4-js-errors.csv
.local/signal-dumps/reports/<asset>/gsc-page-query.csv
.local/signal-dumps/reports/<asset>/bing-webmaster-queries.csv
.local/signal-dumps/reports/<asset>/dataforseo-ranked-keywords.csv
.local/signal-dumps/reports/<asset>/dataforseo-backlinks-new-lost.csv
.local/signal-dumps/reports/<asset>/dataforseo-backlinks-referring-domains.csv
.local/signal-dumps/reports/<asset>/dataforseo-backlinks-anchors.csv
.local/signal-dumps/reports/<asset>/dataforseo-keyword-ideas.csv
.local/signal-dumps/reports/<asset>/dataforseo-serp-competitors.csv
.local/signal-dumps/reports/<asset>/dataforseo-llm-mentions-chatgpt.csv
.local/signal-dumps/reports/<asset>/dataforseo-serp-panel.csv
.local/signal-dumps/reports/<asset>/clarity-url-3d.csv
.local/signal-dumps/reports/<asset>/executive.json
.local/signal-dumps/reports/<asset>/summary.json
```

These outputs are disposable local working data and remain gitignored. Missing
provider rows stay missing; the script never fills gaps with zero. The CSVs are
plain inputs for TypeScript, DuckDB, or notebook analysis without introducing a
database dependency into the collector. GSC CSVs include `row_grain`; use it to
keep property/query/search-appearance totals separate from page-level rows.
In particular, `gsc-search-appearance-pages.csv` contains both the appearance
discovery totals and the required second-step page breakdown, which are not
additive.

What an archive means as rows, and which row is kept when several describe
one day, lives in `scripts/signal-archive.mjs` (bead `ro-ujb9.67.1`), not in
the analyzer: the analytical-file writer reads the archive through the same
functions, so its files and these CSVs cannot disagree. Rows must reach
`resolveFamily` in reading order (archives by path, rows as stored), because
a tie between two reports of the same date goes to the one read last.
`scripts/fixture-archive-analysis/` retains the historical raw-analyzer output.
`fixture-history-analysis.json` records its canonical report hashes captured
before retirement. `signal-history-analyze.test.mjs` compares all 47 report
files with that frozen reference and tests the existing duplicate-day rule.
Differences need review, not regenerated reference data.

`dataforseo-backlinks-referring-domains.csv` and `dataforseo-backlinks-anchors.csv`
are the NAMES behind the counts (`ro-cda6.1`). `-summary` reports how many
referring domains a property has and `-new-lost` reports the weekly delta;
neither names one, so "we lost 12 referring domains this week" had nothing
actionable behind it. Both files are `row_grain=referring-domain` / `anchor`, one
row per item, capped at the head 100 — referring domains ordered by `rank`
(descending) so a truncated read keeps the links worth having rather than
whichever scraper farm links most times, and anchors by `referring_domains`
(descending) because an anchor profile is read as a DISTRIBUTION and the head
carries its shape. The cap is a cost decision before a coverage one: the
Backlinks API bills $0.024/request + $0.000036/row, so 100 rows is ~$0.0276 a
call, inside the $0.25 per-family reserve.

`dataforseo-keyword-ideas.csv` and `dataforseo-serp-competitors.csv` are the
only **non-reflexive** search families the OS collects (`ro-cda6.2`), and the
only two on a **28-day** cadence rather than weekly. Everything else reads what
a property already has — `ranked-keywords` what it ranks for, `serp-panel` terms
somebody already chose, GSC queries that already earned an impression — so
nothing could propose a term the portfolio has never touched. These two can.

`keyword-ideas` (`row_grain=keyword-idea`) seeds from the property's own
`config/serp-panel.json` head terms, so a property with no tracked panel gets no
ideas rather than ideas grown from a guess; head 100 by search volume.
`serp-competitors` (`row_grain=serp-competitor`) is head 20 ordered by
`intersections` — how many of OUR keywords a domain also ranks for — because a
bigger domain that intersects us on nothing is not a competitor.

Both are absent from three `report_date`s in four by design, and that is not a
torn week: they are deliberately **not** part of the weekly collection identity
the review filer, integration light and Wall marker grade against. See
`DATAFORSEO_PERIODIC_REPORTS` in `packages/contract/src/dataforseo.ts`.

`ga4-js-errors.csv` is the triage half of the `javascript-errors` card — read by
it since `ro-14d.3`, see the rule notes below — one row per `js_error`
message × source × page, from GA4 **event parameters**. Two things about it are
load-bearing.

- **Its absence is not a zero.** The Data API answers for an event parameter
  only after an operator registers it as a custom dimension in GA4 admin, and
  GA4 backfills nothing before that. Until registration the collector writes a
  `ga4_custom_dimension_unregistered` manifest row and archives nothing, so this
  CSV simply does not exist — which reads as *unknown*, never as "the property
  throws no JavaScript errors". Check the report runs before concluding
  anything from a missing file.
- **Count `message_bucket`, not `message`.** Raw error text carries the URL,
  build hash, and line number of each occurrence, so every row looks unique.
  `message_bucket` masks those (`<url>`, `<id>`, `<n>`) to leave the part that
  identifies the fault. `(not set)` — GA4's token for an error whose `message`
  parameter was absent — is preserved rather than bucketed with real messages.

`clarity-url-3d.csv` is written **long** — one row per (metric, URL) — because
Clarity's metric blocks do not share a schema: `Traffic` counts sessions and
bots, `EngagementTime` reports seconds, `ScrollDepth` a single average. A field
a block does not carry stays **empty**, never padded to 0, and `Traffic`'s
unattributed aggregate keeps its null URL as empty rather than `""`. Read these
as behavior **rankings**: sessions are sampled, the window is a trailing 72
hours, each block is capped at 1,000 rows with no pagination, and `clarity.ms`
is adblock-DNS-listed (undercounts ~15–25%). One collection costs one of the
project's ten daily calls, so analysis always re-reads the archive.

Its `ScriptErrorCount` block is the **second observer** of the question
`javascript-errors` answers, and the two disagree often enough to need a rule
(`error-observer-disagreement`, `ro-d5c`). Three of its numbers are easy to
conflate and the rules never do: `sub_total` is the metric's own total (script
**errors**), `pages_views` counts the page **views** carrying one, and
`sessions_with_metric_percentage` is the share of **sessions** that saw one —
three different denominators. On one site's 2026-08-01 snapshot `/recipes`
reads 203 script errors over 43 page views in 2.9% of 238 sampled sessions,
which is not "203 error sessions". Consecutive collections overlap (each is a
trailing 72 hours), so rules read the **latest snapshot only** and never add
them together. Non-page hosts appear in the URL dimension (`https://Electron`
is in the archive) and normalize to a path of `/`; a host without a dot is
filtered out before ranking, or it would masquerade as the home page.

BWT CSVs normalize Microsoft field names and legacy dates. Crawl-issue bitmasks
are decoded into `issue_names`. The analyzer uses only the latest downloaded
BWT snapshot for executive findings: weekly query/page snapshots can be revised
and must not be summed across collection runs.

DataForSEO CSVs keep exact report cost and provider-modelled values. Current
facts use only the latest weekly snapshot, rank change compares retained
snapshot dates, and the 90-day backlink series is analyzed from the stored
object. Re-running analysis never calls DataForSEO. Search volume, difficulty,
estimated traffic/cost, mentions, and AI search volume prioritize review; they
are not causal ROI, sessions, or unique users.

`dataforseo-serp-panel.csv` is the tracked-query panel
([doc 08 §S1b](../docs/08-seo-geo-signals.md), config
[`config/serp-panel.json`](../config/serp-panel.json)): one row per tracked head
term **per `device`**, from one live result page in the site's saved market
(United States · English by default) read to
`tracked_depth` results. It is the only DataForSEO family whose rows each carry
their **own** metered cost, because each row is its own provider call. Read these
columns carefully:

- **`device` is `mobile` or `desktop`, and the two are different observations.**
  Every term is read on both (`ro-o1n`), because a phone result
  page is not a narrower desktop one: an AI Overview can consume the click on one
  surface and not the other. **Filter to one device before counting, summing or
  averaging anything** — a naive count of `aio_present = true` now double-counts
  the panel. Rows collected before that change read `desktop`, which the collector
  had actually sent; nothing was inferred.

- **`aio_present` / `aio_cites_us` are three-state.** `true` and `false` are
  observations; **empty is unknown, and must never be read as `false`.** Empty
  means the asynchronous AI Overview did not load, or the provider could not
  answer the query at all — Google may well have served an overview nobody can
  see. A tracked query recorded as unknown is treated exactly like an untracked
  one everywhere downstream, because the decision it feeds ("do not spend copy
  budget on a query whose click is consumed inline") is only safe on evidence.
  `search-striking-distance` withholds a term observed as `aio_present = true`
  with `aio_cites_us = false`, states the withholding on the card, and offers an
  unknown term exactly as it did before the panel existed — marked unknown.
- **`best_rank` empty means "no result inside `tracked_depth`"**, never "does
  not rank". `provider_status` carries the provider's message for a term it was
  billed for and could not answer; those rows are retained rather than dropped.
- **`second_rank` / `second_url` are the property's SECOND slot** on the same
  result page, bounded exactly like the first: empty means no second result of
  ours inside `tracked_depth`. Two of a property's URLs sharing one result page
  is either a double listing worth defending or the cannibalization
  [impression-harvest](../docs/playbooks/impression-harvest.md) consolidates —
  and the GSC families can only show impressions split across pages, never which
  page Google placed where.
- **`sitelinks_us` is three-state for a reason of its own.** `true`/`false` are
  observations about *our* result — the sitelink block rides inside the organic
  item, so an item that parsed is an item whose sitelinks parsed — but **empty
  means we held no result inside `tracked_depth`, so there was nothing of ours
  for sitelinks to hang off**. Read as `false`, every week the property ranked
  past depth 20 would fire the "sitelinks disappeared" alert (`ro-770`) as a
  ranking problem wearing a sitelink's clothes.
- **`serp_features` is what ELSE was on the page**, in the provider's own
  item-type vocabulary, pipe-joined and sorted, unioned from the response's
  declared `item_types` and the blocks it actually returned — a feature the
  provider named without returning is still a feature that was on the page.
  `organic` is dropped (a token present in every row is a constant, and this
  family measures the organic list in `organic_results` / `top3_domains` /
  `best_rank`). It shares its NAME with the ranked-keyword family's
  `serp_features` because it shares that vocabulary, not because the two join:
  different grain, different moment. Empty on a row with no `provider_status` is
  an observation — nothing but organic results on that page.

**What stays in the archive** (`ro-463`). Every panel response is
stored verbatim, so flattening is a choice about what a *rule* can act on, never
about what exists. Deliberately not columns: the AI Overview's full text and
complete citation list (the decision needs "does it cite us"; the rest is a
research pass), each result's title and snippet (copy work reads the LIVE page —
a stale snippet in a CSV is a rewrite of last week's SERP), the question text
inside `people_also_ask` / `related_searches` (a rule acts on the block's
presence, which `serp_features` carries), and paid blocks (this family pays for
organic depth and says nothing about auctions). Each is one `jq` away in the
immutable archive, which is the right cost for something no rule reads.

`executive.json` is a bounded deterministic interpretation layer, not an LLM
summary. Each finding carries its source, evidence window, exact facts,
confidence, why-it-matters copy, and limitation; missing rows cannot generate a
deprecation recommendation. It also carries a compact DataForSEO
`searchIntelligence` summary and one unified `searchQueries` read model. Its
`ai` mention and search-volume figures are `null` — never `0` — when
DataForSEO's platform row stated no figure or the family was never collected
(bead `ro-8s5`); an explicit provider `0` stays `0`, and the Tower's Search tab
shows the null as "not reported".
Google and Bing compare seven reported dates with the preceding seven, limited
to queries present in both windows and ranked by absolute impression change.
**Both** lanes read the grounding-decontaminated series the CTR rules read and
carry the same `Grounding queries excluded` evidence row — present at zero, so
each lane proves the check ran. A lane that is usually clean still runs the
check, because a
number in a comment is true the day it is taken, a row is recomputed every run.
The Bing exclusion counts only the **latest snapshot**, the rows the lane
actually ranks; an evidence row describing superseded snapshots would be a true
number about the wrong population.
The latest DataForSEO ranked-keyword snapshot adds a bounded current baseline
of modelled monthly demand in the site's saved market (United States · English
by default), organic position, difficulty, and AI
Overview-reference evidence immediately; locally observed rank movement appears
only after the same query/page pair exists in a second retained snapshot. Where
a tracked panel covers one of those queries, the row also carries
`aioDevices[{ device, aioPresent, aioCitesUs }]` — **one reading per device**
(`ro-14d.1`), because a phone result page is not a narrower desktop one and an
overview can consume the click on one surface and not the other. The join is on
the normalized query and is strictly **additive**: a panel term the ranking
inventory does not carry adds no row, and an uncovered query gets an **empty
list** — unknown, never `false`, and never a device row full of nulls, which
would claim a surface was checked. Provider impressions and DataForSEO search
volume remain different fields so the Tower cannot present estimated market
demand as property exposure.

The same comparison runs at **page grain** as `searchPages` (`ro-427`), the
evidence the Tower's page decision table is built on:
`{ provider: 'google', currentStart, currentEnd, previousStart, previousEnd,
daysPerWindow, pages[], evidence[], source, caveat }`, one row per page present
in **both** seven-date windows with its clicks, impressions, CTR, average
position, and each side's previous value. Google only — no other archived family
carries a page dimension. Three things about it are load-bearing:

- **A page reported in only one week is unknown, not zero.** `gsc-page` is a
  top-row export, so a page below the cut-off did not necessarily fall to
  nothing; it is left out, and the block understates movement at the export
  boundary rather than inventing a collapse.
- **The totals are NOT grounding-decontaminated, and the lane says so.** A page
  row carries no query to classify, so the quoted-literal exclusion the CTR
  rules apply cannot touch it. It is applied to the **leading-query join**
  instead, and the evidence row is labelled
  `Grounding queries excluded from the leading-query join` — a distinct label
  from the movers lanes' row, because that one means "the numbers beside me were
  computed on the clean series" and this one does not. Present at zero, like
  every other exclusion row.
- **`leadingQuery` is the page's largest query by IMPRESSIONS**, off the
  decontaminated `gsc-page-query` series, carrying the same
  `aioDevices[{ device, aioPresent, aioCitesUs }]` readings the query rows do.
  Impressions rather than clicks because the question is what Google shows this
  page for, and a page worth reviewing is precisely one whose biggest query takes
  few clicks. `null` where the page/query export does not cover the page in this
  window — unknown, never "this page ranks for nothing".

A property with panel rows also carries a `serpPanel` block —
`{ reportDate, trackedDepth, market, queries[{ query, device, bestRank, bestUrl,
aioPresent, aioCitesUs }] }`, one entry per **(tracked term, device)** of the
latest panel snapshot. `market` is the site's saved search market
(`{ locationCode, languageCode }`), or `null` when it saved none, and the
Tower's caption names it (bead `ro-ujb9.230`). Unlike the two joins above it is the whole panel, not an
intersection: a term the property paid a call for but the ranking inventory does
not carry was otherwise invisible on every rendered surface. `bestRank: null` is
"no result inside `trackedDepth`", never "does not rank"; `aioPresent` /
`aioCitesUs` keep their three states. A row archived before the collector sent a
device carries none, and the Tower's parser reads that absence as `desktop` —
which it was by construction. The Tower groups the rows back into terms
(`serpPanelTerms` in `apps/tower/shared/asset-detail.ts`) before counting
anything, so reading each term on two devices multiplies no denominator. A
property with no panel gets **no key at all**, because absence of a panel and an
empty panel are different facts. The standing refresh below publishes its
completed analysis automatically. For an explicitly generated file, the manual
publication command remains available:

```bash
pnpm signals:publish-insights -- --asset example.com
```

Publishing is content-addressed and inserts nothing twice, so an identical rerun
does not duplicate a snapshot — it answers "already published, nothing changed".
The id is `insight:<asset>:<first 24 hex of the SHA-256 of the exact bytes
published>`, which is what makes a re-run provably the same row rather than
hopefully one. The raw archive and CSVs stay local/private.

**Publishing is a WRITE through the running OS.** It POSTs the generated
snapshot to `POST /api/insight-snapshot` (operator-authed, loopback door) and
the running ingest writes it to Postgres. The script opens no database
connection or second Worker. Use the [container operator commands](../deploy/compose/README.md#download-and-publish-stored-signal-reports)
for a prepared application container. `--remote` is refused before any write.

## The standing panel refresh (`signals:refresh`)

The commands above are the **hand** path.
`signal-panels-refresh.mjs` refreshes the files on a schedule and automatically
publishes its completed recommendations to Tower (operator decision
`ro-ujb9.52`, implementation `ro-ujb9.57`). Publication is advisory only: it never
creates tasks, dismisses findings, or executes changes on an asset.

```bash
pnpm signals:refresh                       # every property in the roster
pnpm signals:refresh -- --asset example.com # one property, roster flag ignored
pnpm signals:refresh -- --all              # including the deliberately disabled
pnpm signals:refresh -- --no-publish       # local preview; Tower advice unchanged
```

Each pass reads its enabled assets, history window and freshness setting from
the acknowledged `config/signal-panels.json` document in the database through
the running ingest. A missing, unavailable or malformed stored roster fails
before fetching archives; it never falls back to a stale checkout export.
An explicitly empty or disabled roster refreshes nothing. The log records the
configuration version. Explicit `--asset`, `--all` and `--window-days` overrides
remain available for manual runs.

Each enabled property downloads only missing archives through the ingest,
publishes its Parquet history, then analyzes that exact generation in a bounded
DuckDB child. The reports and these companion files publish together:

```text
.local/signal-dumps/reports/<asset>/signal-trend-daily.csv
.local/signal-dumps/reports/<asset>/freshness.json
```

The completed report directory is a symlink to an immutable generation under
`<asset>.reports/`; the current and previous reports remain available. Existing
plain `analysis/<asset>/` folders are left intact. The shared path resolver in
`signal-panel-paths.mjs` also directs manual publication and review tasks to
the completed reports. An explicit `--out` naming an existing plain directory
is refused. `--history` changes the history root; `--memory-mb`,
`--duckdb-memory-mb`, `--temp-disk-mb` and `--time-limit-seconds` set the existing
analysis limits. The refresh lock covers downloads through publication;
interruption or an exhausted limit leaves the previous complete report visible.

Once the entire asset pass succeeds, it sends the exact returned analysis through
the existing local publisher. It does not reopen a shared `executive.json`, so a
leftover or concurrently replaced file cannot be mistaken for this run's output.
The generation time and archive count must match the completed run; the store's
acknowledgement must match the submitted asset, generation and content hash.
Download, analysis, local-output or publication failures fail that asset's pass;
other enabled assets continue. Failures before the POST leave displayed advice
unchanged. A lost or invalid acknowledgement means publication is unconfirmed,
not necessarily absent: the row may already be stored, and retrying its identical
bytes is safe. Prior versions are never removed. An analysis with
no input archives is not published. Zero findings with real archives is valid.

Earlier snapshots remain stored. Republishing identical bytes is a no-op; a new
analysis is a new version, even when its inputs have not changed. Tower chooses
by analysis generation time, so a delayed older publication does not replace a
newer analysis. A new analysis is **not** proof of fresh sources or current
applicability: per-source evidence dates and uncertainty stay intact. The refresh
log reports source freshness and publication separately; its nonzero exit reaches
the existing runner job-failure evidence. `--no-publish` retains the file-only
workflow for explicit previews.

`signal-trend-daily.csv` is the normalized daily site-level series from
`signal_observations` — one row per `date,integration,metric,value,provisional`.
It is the **only** file in the panel dir that can be summed and differenced: the
per-report CSVs are top-row provider exports whose tail is silently absent.
`freshness.json` grades each integration's newest report day against
`refresh.freshnessMaxAgeDays`, so "is this panel current?" is read from the
directory rather than assumed. No source at all grades as **not** fresh — an
empty panel dir and a collapsed property look identical on disk. The families no
cron produces (`UNCOLLECTED_FAMILIES` — the hand-dropped `bing-webmaster-ai-*`
exports) are graded **separately**, in `uncollected[]`, against their own newest
export: they share an integration id with six API-collected families, so a
per-integration reading let the nightly collection vouch for a file that could be
six months old. They stay out of the top-level `fresh` because there is no
cadence for them to miss — see [doc 20](../docs/20-signal-panels.md).

Three properties of the lane are load-bearing:

- **It costs nothing.** Zero provider calls. Every byte was already bought by the
  `15 12 * * *`, `30 12 * * *` (PostHog), `45 12 * * 1` and `30 4 * * *` collectors; this reads them back.
  So the cadence is chosen for freshness, not budget — daily across the whole
  portfolio moves monthly data spend by $0.00.
- **It does not open the store twice.** It deliberately does *not* shell out to
  `wrangler d1 execute --local --persist-to`: that starts a second miniflare over
  the sqlite file the live runtime owns (ro-mad). Reads go through the ingest's
  own operator-authed routes on the loopback door — `GET /api/panel-source`
  (manifest + trend) and `GET /api/panel-object` (one archive, decompressed).
  Since `ro-2zk.3` the hand commands above go through the same seam, so **no
  script under `scripts/` opens the local store** except the ones allowlisted in
  `scripts/no-second-runtime.test.mjs` — the test that keeps that sentence true
  as scripts are added.
- **A skipped archive is the point.** An object key carries its content hash, so
  an archive the collector revised gets a new key and comes down again, while one
  it re-confirmed unchanged is not re-fetched. That keeps a nightly pass O(the
  new day) instead of O(the window).

Cadence: the `panel-refresh` job in `scripts/scheduled-jobs.mts` (`10 13 * * *`
UTC by default, after both archive crons land), changed like any other job in
**System health → Background operations** and picked up within 15 seconds. It
is a runner lane, not a wrangler cron — a Worker cannot write this machine's
disk.

What a property repo may conclude from the panel dir, and the honesty rules that
bind it, is the consumer contract: [doc 20](../docs/20-signal-panels.md).

## The provider history as analytical files (`signals:history`)

*Bead `ro-ujb9.67.2`, decision D25. **Proven on synthetic archives only: it has
not been run on this installation's archive.** Nothing runs it on a schedule yet
(`ro-ujb9.76.7`). The report that reads its files is
[`signals:analyze-history`](#the-analysis-read-from-the-history-files-signalsanalyze-history).*

Every panel refresh re-reads a site's whole archive of provider answers, so its
cost grows with every day of history. This command publishes one site's
downloaded archive as Parquet files that DuckDB reads, and after the first run
writes only what changed.

```sh
pnpm signals:history -- --asset example.com --in <downloads folder> --out <history folder>
```

- `--in` is the folder `signals:download` or `signals:refresh` wrote for the
  site (`<integration>/<report>/<date>.json` and `manifest.json`). It is only
  read.
- `--out` is that site's history folder. Everything the command writes is under
  it. The two folders may not contain each other.

What it writes:

```text
<out>/generations/00000007.json                      one complete generation
<out>/data/<family>/<month>/<fingerprint>.parquet    one family's rows for one month of report dates
<out>/data/sources/<month>/<fingerprint>.parquet     the register of every archive read
<out>/.lock                                          held while a run writes or removes
```

- **One dataset per report family, holding the analyzer's rows.** The rows come
  from `scripts/signal-archive.mjs` exactly as the analyzer's CSVs do, with the
  same revision rules. Numbers stay numbers and true/false stays true/false; an
  empty value is NULL, which means unknown, never zero. Read as text, every cell
  is the CSV's cell. The one difference: when a folder holds a report day twice
  (only a hand-assembled folder can), the copy read last is kept and the other
  is listed as superseded. The analyzer counts both.
- **Every row says where it came from:** `source_path`, `source_sha256`,
  `source_object_key` (the raw-archive object the downloads manifest names for
  that day), `source_family`, `report_date`, `schema_id` and `derivation_id`.
- **The register lists every archive** it found: read, superseded, unreadable
  (with the reason; it adds no rows, so that day reads as unknown), and every day
  the downloads manifest names that has no archive (missing). A readable
  archive's row keeps its own `reportDate`, `providerRows` and
  `providerTruncated` (`envelope`), and the manifest names the downloads folder
  it read (`downloadsFolder`), so a report from these files names its sources
  as the analyzer's summary does. The same archive in a moved folder publishes a
  generation naming the new folder, writing no data file.
- **Readers see only complete generations.** Data files are written first and
  the manifest that names them last. An interrupted run leaves the previous
  generation as the current one, and the next run reuses the files the
  interrupted one finished. One run at a time holds the history's lock: a
  second is refused and changes nothing, and a lock whose run died is taken
  over. A published generation is never changed; how long it is kept is
  [below](#how-long-a-generation-is-kept).
- **It writes only what changed.** A new or corrected report day rewrites that
  family's file for its month. A later confirmation that settles a provisional
  GA4 day does the same, with no new archive bytes. A run over an unchanged
  archive writes nothing. An incremental run and a rebuild of the same archive
  publish the same files; the manifest's `content` hash is equal.
- **Schema changes are explicit.** A new column or a changed type is a new
  `schema_id`, and every file of that family in that generation carries it.
  `derivation_id` is a hash of the code that decides what a row is; changing
  that code rebuilds every dataset on the next run.
- **Previously imported history remains readable.** A generation can contain
  operational history under `tables`, alongside provider-report datasets. The
  completed private transition populated these datasets with its frozen import
  tool; `signals:history` preserves them when publishing new generations.

To read a generation, take the highest-numbered manifest under `generations/`
and give DuckDB the files it lists, never a glob of `data/` (a glob would also
see superseded and unfinished files). A family whose revisions reach across
report days and `index-coverage` are one file in the analyzer's order; every
other family is in the analyzer's order by `report_date`, then row within its
file. The manifest's `rowOrder` says which:

```sql
SELECT * EXCLUDE (file_row_number)
FROM read_parquet(['<out>/data/gsc-query/2026-09/<fingerprint>.parquet'], file_row_number = true)
ORDER BY report_date, file_row_number;
```

What it costs, measured on synthetic archives
(`docs/artifacts/signal-history-2026-09-29/`; historical reference excluded from public source,
one GSC page-query family):

| | Monthly files (the choice) | One file per day | One file per year |
|---|---|---|---|
| Archives a daily run parses, 100 → 800 days of history | 23 → 23 | 2 → 2 | 102 → 266 |
| Files and size, 800 days × 500 rows | 27, 1.3 MB | 800, 8.1 MB | 3, 0.3 MB |
| Written by 30 daily runs, 200 days × 5,000 rows | 2.8 MB | 0.9 MB | 30.6 MB |
| Manifests after those 30 runs | 0.34 MB | 6.6 MB | 0.14 MB |

A run over an unchanged archive parses nothing. Today's analyzer parses every
archive on every refresh, and its peak memory grew from 573 MB to 1,044 MB
between 100 and 200 days of the larger archive; a full monthly build stayed
near 540 MB. The files are written by DuckDB's own Node client
(`@duckdb/node-api`, MIT): the engine that reads them writes them, its files
were 2–7× smaller than a pure JavaScript writer's, and it ships prebuilt
binaries for macOS and Linux with no install script (`writer-library.json`).

### How long a generation is kept

*Bead `ro-ujb9.67.4`; the operator's decision of 2026-09-29.*

The history keeps **every generation published in the last 30 days, and the
newest** whatever its age. Readers only ever need the newest; 30 days lets a
report be re-run on the generation it was built from (`--generation`). The
number is one constant, `KEEP_GENERATIONS_DAYS` in `scripts/history-files.mjs`,
the publication pieces every writer of a history folder shares.

Every `signals:history` run applies it, after it publishes or finds nothing
changed, and says what it removed:

```text
Removed 1 generation published 30 or more days ago and 2 files no kept generation names; 30 generations kept.
```

- **What goes, in this order:** the manifests of the generations no longer
  kept, oldest first, so no report can pin one; then each data file no kept
  generation names (a month's file a later generation replaced, or one a run
  that died wrote), the half-written files of a run that died, and the folders
  that leaves empty.
- **What retention never removes:** a file a kept generation names; anything under `<out>`
  that is not the writer's own manifest or data file; anything outside
  `<out>`. The downloads folder and the raw archive are only ever read.
- **Interrupted at any point,** every generation still listed reads; the run
  fails, saying the generation was published, and the next run finishes the
  removal. Proven at every removal point in `scripts/signal-history.test.mjs`.
- **A manifest that cannot be read stops it** before anything is removed: which
  files it names is unknown.
- **A report on a generation no longer kept is refused,** naming the generation,
  the rule and the oldest generation kept, whether it was asked for or removed
  while the report read it.

Before publication, while holding the same lock, the writer also removes a
previous run's `.spill-<pid>` directory only when that process no longer exists.
Live or reused process IDs, uncertain process state, symlinks and other names
are retained. Normal shutdown removes only the current run's own spill directory.

Why it runs inside `signals:history` and is not a command of its own: the rule
is the operator's standing decision, so every run that writes a history keeps
it bounded, and no second job has to be scheduled or remembered. It runs under
the same lock as the publication, so it can never remove a file a run is about
to publish. A manifest's `previous` may name a generation no longer kept;
readers never follow it. The object-store copy (`ro-ujb9.76.7`, not built) is to
keep the same generations: the rule is exported as `keptGenerations` for it.

## The analysis, read from the history files (`signals:analyze-history`)

The scheduled panel refresh publishes one history generation and runs this
bounded DuckDB report reader. The duplicate raw analyzer and `signals:analyze`
command were retired under `ro-ujb9.67.6`; raw archives remain available for
rebuilds. Local qualification does not establish a deployed installation's
current runtime or history contents.

```sh
pnpm signals:analyze-history -- --asset example.com --history <history folder> --out <report link>
```

- `--history` is the site's history folder. It is only read.
- `--out` is a link the command keeps pointing at the newest complete report;
  the reports themselves are kept in `<out>.reports/`. It refuses a path that
  already holds something it did not make, so it cannot overwrite a legacy
  plain analysis folder.
- `--generation <n>` reads generation n instead of the newest.
- It reads the stored configuration database and accepts the open-target row
  array exported by `reclamation:open-targets` through `--reclamation-targets`.

What the folder `--out` points at holds:

```text
<family>.csv, index-coverage.csv, executive.json, summary.json    the analyzer's files
report.json                                                        the generation it read, its rules, when
```

- **Frozen report parity.** Over the canonical synthetic archive, every
  file equals the retired analyzer's captured output
  (`scripts/signal-history-analyze.test.mjs`). The rules in
  `signal-insights.mjs` are untouched: no finding, number, order or rounding
  changes.
- **One difference, the history's own rule:** a report day delivered twice is
  read once, from the copy read last; the retired raw analyzer counted both copies. A
  downloads folder holds two only when an archive's own date disagrees with its
  file name, or when it was assembled by hand. The synthetic archive holds six
  such copies on purpose. There, three families lose the doubled rows
  (gsc-query 96 → 90, gsc-country 36 → 28, bing-webmaster-crawl-stats 14 → 10);
  the same 19 findings come out in the same order; the figures that read those
  rows change (the Korea locale card reads a 0.9% click rate instead of 0.8%,
  and the Google query movers are computed without the doubled day); and 99
  source archives are counted instead of 105.
- **How the files store values cannot change a finding.** An empty cell comes
  back empty, and a column that mixes numbers and text comes back as text. The
  rules read every value through helpers that treat these alike: over the
  synthetic archive and all 170 calls the rules' own tests make, turning any one
  column to text, or every empty cell into a missing one, changed nothing
  (`rules-blindness.json`; private historical evidence).
- **Pinned to a generation.** A run reads one generation, checks every file it
  reads against the sha256 the manifest records, and names it in `report.json`.
  The same generation, code and clock write the same bytes, whatever was
  published since, for as long as the history keeps that generation.
- **It refuses, and publishes nothing,** when the generation lists an archive it
  could not read (the analyzer refuses that archive too: its day is unknown);
  when other archive rules than this checkout's wrote the generation (run
  `signals:history` first; it rewrites it); when a file changed or went
  missing since it was published; or when the history no longer keeps the
  generation ([how long a generation is kept](#how-long-a-generation-is-kept)).
  A day the downloads manifest names with no archive is left out, as the
  analyzer leaves it out.
- **Bounded.** The work runs in a child process with four limits. Hitting one
  stops it with a plain message, and nothing is published:

  | Limit | Flag | Default |
  |---|---|---|
  | JavaScript memory: the rows and the rules | `--memory-mb` | 4096 |
  | DuckDB memory | `--duckdb-memory-mb` | 512 |
  | Temporary disk: DuckDB's spill, then the staged report | `--temp-disk-mb` | 4096 |
  | Wall time | `--time-limit-seconds` | 600 |

  DuckDB runs in memory with one thread, may read only the history folder and
  its own spill folder, loads no extension and cannot change its settings.
  There is no database file for a second process to open.
- **Published whole.** The report is staged beside the others, flushed to disk,
  and published by swapping the link in one rename. A reader sees the previous
  report or the new one, never a mix, and a job stopped at any point leaves the
  previous report in place. The report before the current one is kept; older
  ones are removed. A second job is refused while one runs.

What one daily refresh costs as history grows, measured on synthetic archives
(`docs/artifacts/signal-history-analyze-2026-09-29/`; historical reference excluded from public source,
one GSC page-query family, one new report day each time; bytes read, wall time
including Node's start-up, peak memory):

| History kept | Retired raw analyzer (measured 2026-09-29) | This report | `signals:history` for the new day |
|---|---|---|---|
| 100 days × 500 rows | 6.4 MB, 0.36 s, 140 MB | 0.3 MB, 0.85 s, 188 MB | 8.0 MB, 0.37 s, 134 MB |
| 400 days × 500 rows | 25.4 MB, 0.60 s, 321 MB | 0.9 MB, 1.09 s, 306 MB | 27.2 MB, 0.32 s, 149 MB |
| 800 days × 500 rows | 50.7 MB, 1.11 s, 565 MB | 1.7 MB, 2.54 s, 683 MB | 52.7 MB, 0.38 s, 174 MB |
| 100 days × 5,000 rows | 64.7 MB, 1.25 s, 577 MB | 0.8 MB, 2.39 s, 652 MB | 79.1 MB, 0.82 s, 312 MB |
| 200 days × 5,000 rows | 128.8 MB, 2.44 s, 1,043 MB | 1.5 MB, 4.11 s, 1,071 MB | 143.2 MB, 0.73 s, 316 MB |

- **Reading:** the report reads 20–90× fewer bytes than the analyzer, because it
  reads compressed columns instead of every raw provider answer.
- **Time and memory:** about the analyzer's memory, and 1.7–2.4× its time. The
  rules still need every row in memory, so the report still builds every row;
  on top of that it starts a second process (about 0.1 s), and it flushes the
  report to disk before publishing it, which the analyzer never does.
- **The whole refresh still reads the whole archive,** because `signals:history`
  hashes every archive on each run to find the ones that changed (last column).
  Tracked in `ro-ujb9.67.5`.

The report's supervising process adds about 80 MB beside the job's own peak.

The private benchmark programs and their measured JSON remain dated evidence,
not commands for current main. Their reproduction contexts are
`e4218af777129cbb9ccc58a3e68f3341534a9ddd` (history analysis),
`52591735d9c8abb04139ca4cbfe8baf5aba9ee0c` (partition comparison), and
`1323940ff49ac770594f527b3a0cbbada12b75f5` (raw-archive comparison).
Use those historical source contexts to interpret or reproduce the original
measurements; current installations use `signals:analyze-history`.

## The executive rules

The rules live in `signal-insights.mjs`, each reading named report families and
emitting at most one card — except `distant-demand-cluster`, which emits one per
URL cluster. The page sorts `warning → recommendation → discovery
→ insight` and keeps the first **eight**, so the list order below *is* the
tie-break the cap uses — it is a priority list, not a call order. Every card
names its rule in an evidence row (`rule: <id>`), and that id is the join to the
method library at [`docs/playbooks/`](../docs/playbooks/README.md)
([doc 13](../docs/13-opportunity-scouting.md)): the rule detects the condition,
the playbook says what to do about it. A rule whose family is absent emits
nothing: a missing CSV is never a finding.

**The cut is not silent.** Cards past the eighth are listed in
`executive.json`'s `suppressedItems` (key, kind, title) instead of being
discarded: the cap is a display decision, not a judgment that the dropped cards
are false, and the system may decide not to *show* something but never not to
*mention* it (AGENTS.md, [doc 05](../docs/05-execution-and-accountability.md) §6).
The Tower renders that list as a quiet "N more findings below the cut"
reveal in `ExecutiveFindingsList` — titles and kind only, because a suppressed
card is a mention and not a row to act on. The cap itself stays at **8**: raising
it is an operator decision about attention.

**Unsettled GA4 days are read by no rule** (`ro-5e8.10`). The four
rules over GA4's attribution files (`measurement-integrity`'s Unassigned half,
`concentration-risk`, `ai-referral-floor`, `reclamation-match`) read only rows
marked `provisional=0`: a day GA4 was still attributing when it was collected
reads high on Unassigned and low on the real channels
([doc 20](../docs/20-signal-panels.md#the-honesty-rules-they-are-the-contract)),
so it is set aside rather than published with a label that the next collection
would reverse. A card built beside such days names them in a `Provisional days
set aside` evidence row; a family holding only unsettled days raises no card
until they settle. An empty `provisional` cell (collection date unreadable) is
read as before.

| Rule id | Kind | Reads | Fires when | Playbook |
|---|---|---|---|---|
| `measurement-integrity` † | warning | `ga4-traffic-acquisition`, `ga4-traffic-sources`, `ga4-events` | ≥10% of settled-day sessions are Unassigned/`(not set)`/`(data not available)` (`ro-5e8.11`), **or** an event that ran ≥100/day drops ≥90% week over week | [triangulate-before-acting](../docs/playbooks/triangulate-before-acting.md) · [utm-taxonomy](../docs/playbooks/utm-taxonomy.md) |
| `value-event-not-key-event` ◊ | warning | `ga4-events` (+ [`config/value-events.json`](../config/value-events.json)) | a declared value event carrying ≥10 events/day is counted as **0** GA4 key events across the window | — |
| `concentration-risk` † | warning | `ga4-traffic-acquisition` | organic search ≥85% of sessions (≥100 sessions) | [kill-thresholds](../docs/playbooks/kill-thresholds.md) |
| `error-observer-disagreement` | warning | `clarity-url-3d` + `ga4-page-events` | Clarity's `ScriptErrorCount` leader and GA4's `js_error` leader are different pages, Clarity's leader clears 5 script errors on ≥10 sampled sessions, and it carries **≥2×** Clarity's own count for GA4's page | — |
| `javascript-errors` | warning | `ga4-page-events` (+`ga4-js-errors`, `clarity-url-3d`) | `js_error` volume clears a per-day floor; carries a `Clarity cross-check` row naming whether the second observer picked the same page, omitted entirely where Clarity never read the property, and — where the triage family exists — the leading masked message bucket, its bundle position, the property's busiest position, and the events GA4 can never attribute a message to | — |
| `bing-crawl-issues` | warning | `bing-webmaster-crawl-issues` (+`crawl-stats`) | the latest snapshot reports affected URLs | — |
| `bing-feed-issues` | warning | `bing-webmaster-feeds` | a sitemap/feed status is not `Success` | — |
| `dataforseo-ranking-gain` / `-loss` | discovery / warning | `dataforseo-ranked-keywords` | ≥3 positions moved between two retained snapshots | — |
| `dataforseo-backlink-growth` / `-loss` | discovery / warning | `dataforseo-backlinks-new-lost` (+`-summary`) | net referring-domain direction over the stored series | — |
| `dataforseo-ranking-opportunity` | recommendation | `dataforseo-ranked-keywords` | non-navigational inner page ranked 4–20 with modelled demand | — |
| `search-striking-distance` ◊ | recommendation | `gsc-page-query` (+`dataforseo-serp-panel`) | page/query at position 4–12 above the impression floor, on the grounding-decontaminated series, **excluding** terms whose tracked panel row reports an AI Overview that does not cite this property | — |
| `query-cannibalization` †◊ | recommendation | `gsc-page-query` | ≥2 of the property's pages each hold ≥20% of one query's impressions **and** they do not look like one SERP block (near-identical counts at near-identical positions, or no clicks anywhere) | [impression-harvest](../docs/playbooks/impression-harvest.md) |
| `bing-search-opportunity` ◊ | recommendation | `bing-webmaster-queries` (+`gsc-page-query`) | Bing position 4–20, CTR <15%, ≥50 impressions; a declining series or a long zero-click window caps confidence at medium, and the GSC join never crosses a locale subtree nor names a page carrying <10 captured impressions for the query | — |
| `query-language-drift` † | recommendation | `gsc-country` (+`gsc-page-country`) | a country holding ≥5% of impressions (≥1,000) clicks at ≤half the CTR the property earns *excluding that country* | [impression-harvest](../docs/playbooks/impression-harvest.md) |
| `device-ctr-gap` †◊ | recommendation | `gsc-device` (+`gsc-page-query`) | **either** device's CTR ≤ half the other's, both ≥1,000 impressions, and the gap survives charging the whole grounding exclusion to the weaker surface | [impression-harvest](../docs/playbooks/impression-harvest.md) |
| `image-search-demand` | recommendation / discovery | `gsc-image-page-query` | captured image rows exist (recommendation when they produced no clicks) | — |
| `llm-grounding-traffic` ◊ | discovery | `gsc-page-query` (+`dataforseo-llm-mentions-google`) | quoted-literal grounding queries hold ≥5% of captured impressions (≥500) | — |
| `dataforseo-llm-visibility` ◊ | discovery | `dataforseo-llm-mentions-*` | reported AI mentions > 0; names the property's rank among the cited domains the snapshot returned | — |
| `distant-demand-cluster` ◊ | discovery | `dataforseo-ranked-keywords` | ≥10k/mo at KD ≤25, position 21–100, on an existing non-home page — **one card per URL cluster**, capped at 3 | — |
| `ai-referral-floor` | discovery | `ga4-landing-page-acquisition` | GA4 AI Assistant sessions > 0 | — |
| `search-appearance-leader` | discovery | `gsc-search-appearance-pages` | an appearance treatment carries impressions | — |
| `prune-candidates` † | discovery | `gsc-page` | ≥100 reported pages over ≥14 reported dates, some under 5 impressions | [impression-harvest](../docs/playbooks/impression-harvest.md) |
| `feature-usage-<event>` | insight | `ga4-page-events` | a non-generic custom event fired | — |
| `page-movers` † | insight | `gsc-page` | a page's clicks moved ≥10 across two complete seven-date windows | [release-cohort-attribution](../docs/playbooks/release-cohort-attribution.md) |
| `reclamation-match` ‡ | discovery | `ga4-traffic-sources` (+`dataforseo-backlinks-new-lost`) | an **open** reclamation target's domain appears as a GA4 referral host — only when `--reclamation-targets` is supplied | [reclamation-pipeline](../docs/playbooks/reclamation-pipeline.md) |

**Two observers, one question** (`ro-d5c`). Clarity and GA4 both
rank error-y pages and do not always agree — a
divergence that comes and goes is exactly the kind nobody catches by eye.
`error-observer-disagreement` states it as its own finding and is ordered
**above** `javascript-errors`, because when the two disagree the single-observer
card is the one that would send the fix to the wrong page. Three properties of
the rule are the point of it:

- **It never merges.** No average, no ratio between the observers, no winner.
  Each side's page, count, unit, and window are stated in their own evidence
  rows, plus what each observer says about the *other's* page — the cross rows
  are where the disagreement becomes actionable. The card's headline is `2`
  ("pages named worst"), because the two numbers share no unit and any single
  figure would be invented.
- **Neither silence is consent.** No GA4 answer, or no Clarity read, means no
  card — and the `Clarity cross-check` row on `javascript-errors` is *omitted*
  rather than rendered as agreement for a property Clarity never read.
  Similarly, a page one observer never reported is "unseen" or "not reported",
  never zero.
- **Its window is an envelope, not a claim.** GA4's completed reported dates and
  Clarity's trailing 72 hours are different windows; the card spans both and
  each evidence row states its own.

**The triage half of the same card** (`ro-14d.3`). `ga4-js-errors`
is what lets the card say not only which page throws but what it
throws, which is the only part an engineer can act on. It now adds up to four
rows and one sentence, and it is not a second card: the page ranking and the
message ranking live on one card so they cannot drift apart, and none of it
touches which observer is right — that stays `error-observer-disagreement`'s
finding.

- **`(not set)` never ranks.** GA4 answers for an event parameter only after an
  operator registers it as a custom dimension and backfills **nothing**, so
  every event before registration carries no message and never
  will (`ro-rkx`, [doc 11](../docs/11-integrations.md)).
  Letting GA4's absence token rank would put `(not set)` at the top of a triage
  list as if it were a fault to go and fix. The boundary is a property of the
  **row**, not a date constant: an unattributable row is one whose bucket is
  that token, which holds on any property and any vintage. The events are not
  discarded either — an `Errors without a message` row counts them and names the
  first date carrying a message, so a reader can see how much of the family
  cannot be triaged.
- **Positions outlive the message boundary.** `source` and `message` are two
  separately registered dimensions and `source` was registered first, so dates
  carrying no message still carry a bundle position. The position ranking
  therefore reads **every** row, and its own evidence row is omitted when it
  would only repeat the leading message's position.
- **Buckets, never raw text.** Raw `message` carries each occurrence's URL,
  build hash, and line number, so ranking it returns a list of ones and names a
  URL. `message_bucket` masks those and is what recurs.
- **A leader under 5 events is not a leading error**, and an absent family
  changes **nothing**: no rows, no sentence, no `ga4/js-errors` source, no extra
  caveat clause. A property without the family gets a card byte-identical to
  what it was
  before this rule existed — a test asserts exactly that, for both an absent
  family and an honest empty one.

† **seven rules mined from one property's manual analysis
history and generalized to every property** (cross-asset transfer,
[doc 13](../docs/13-opportunity-scouting.md) lane 6). Their thresholds are named
constants carrying the finding each came from: the 85% single-channel line is
[doc 00](../docs/00-objective-and-roi.md)'s #1 devaluation factor; the locale rule's
comparator excludes the country being judged so a large country cannot drag its
own baseline down to meet it; `<5 impressions` is the impressions half of
a noindex rule — the internal-link half is not in this archive and the
card says so.

The **Playbook** column maps only the seven, because only their methods have
been captured so far. The mapping
and its reasoning are repeated as a provenance comment block above the rules in
`signal-insights.mjs`. An em dash means no method is captured yet — not that the
rule stands alone.

Two of the seven need history:
`page-movers` and the event half of `measurement-integrity` both need **14
reported dates** and stay silent below that, as does `prune-candidates`.

‡ **The only rule with an input outside the archives.**
`--reclamation-targets <path>` takes the property's OPEN outreach targets —
every target not won, skipped or dead — exported from the store; without it the
rule is silent, because an absent input is "not asked", never "nothing matched".
Export them with one command:

```bash
pnpm reclamation:open-targets -- --asset example.com

pnpm signals:history -- --asset example.com --in .local/signal-dumps/downloads/example.com --out .local/signal-dumps/history/example.com
pnpm signals:analyze-history -- --asset example.com --history .local/signal-dumps/history/example.com --out .local/signal-dumps/reports/example.com \
  --reclamation-targets .local/reclamation/example.com-open.json
```

The export reads the store through the ingest's door
(`GET /api/reclamation-targets?asset=example.com&open=1`, with the operator
bearer, like every script that reaches the store: `scripts/ingest-door.mjs`) and
writes the targets in the order they were stored, as the rule reads them, to
`.local/reclamation/<asset>-open.json` (`--out <file>` names another). A site
with no open target gets an empty list. An unknown site, or more open targets
than one list may carry (5,000), is refused and nothing is written.
The analysis accepts only a bare array of target rows, with snake_case or
camelCase columns. An unsupported shape stops analysis and names the export
command; it is never treated as an empty list.

◊ **shaped by the
signal audit (private historical evidence)**,
which cross-checked every card on one property against the raw archive CSVs:

- **Quoted-literal queries are machine grounding, and they contaminate every
  CTR rule.** They look like
  `"1 medium banana" "3/4 cup" <site>`, with zero clicks between
  them. They are excluded from the CTR and position rules **and from both query
  movers lanes** (Google `ro-frx`, Bing `ro-pvl`) — **never silently**: each affected card and each movers lane carry a
  `Grounding queries excluded` evidence row,
  present even at zero so the surface proves the check ran, and the traffic gets its own
  `llm-grounding-traffic` card because programmatic grounding is a GEO signal.
  The classifier covers the **quoted signature only**; unquoted homework-shaped
  queries stay in the series, and the card says so rather than implying a
  complete measure.
- **One SERP block is not several competing pages.** `query-cannibalization`
  sets aside URLs that report byte-identical impressions
  at near-identical positions with no clicks — an AI Overview or sitelink group crediting
  several of the property's URLs at the block's position. Consolidating them
  would remove reach without recovering a click. Set-aside queries are
  counted in the surviving card's evidence.
- **The device rule is bidirectional**, and
  because no archived family carries query × device the grounding exclusion is
  charged entirely to the weaker surface — a worst case that can only make the
  rule quieter.
- **`bing-search-opportunity` does not call a decline an opportunity.** It
  reads the query's own reported periods, states the decline, names intent
  mismatch on a long zero-click window, caps confidence at medium for either,
  and never joins across a locale subtree — saying "no reliable landing page
  identified" instead. The join also carries an
  evidence floor (`ro-otv`): a page must carry the
  query at least `BING_JOIN_MIN_GSC_IMPRESSIONS` (10) times before it is named,
  and a candidate declined for thinness is stated on the card rather than
  dropped.
- **`dataforseo-backlink-growth` states the provider's observed inventory**
  (backlinks / referring domains) so the operator can judge coverage before direction. A
  second link observer (Ahrefs, GSC links) is **not** wired.
- **`distant-demand-cluster`** exists because the near-win band (4–20) is right
  for near-wins and wrong as a whole aperture: it hides modelled
  demand sitting far down the page on a page the property already has.
- **`value-event-not-key-event`** compares an operator declaration against GA4's
  own key-event setting. Both sides are operator-owned — the measurement channel
  is `forbidden`-class (AGENTS.md) — so the rule reports the disagreement and
  edits neither.

**What the rule can and cannot see.** No archived report family names a referring
domain — DataForSEO's new/lost series reports *counts* and never says which
domains — so a "new referring domain" match is not available from the backlink
lane at all. The one archived family carrying an external host name is GA4's
session source/medium, where a referral reads `host / referral`. That is the
stronger signal anyway (a real person followed the link, not just an index
entry), and the card says exactly that: the provider's new-domain count rides
along as timing corroboration, explicitly labelled as a count. The rule never
sets `status = 'won'` — that is a human confirming the change on the page.

---

# `signals:event-params` — ad-hoc GA4 event-parameter report

The manual companion to the daily GA4 archive lane, for event params the archive does not export. One read-only Data API call; same service-account path as `creds:check`; nothing written anywhere.

```bash
pnpm signals:event-params -- --asset example.com                  # js_error message/source, last 3 days
pnpm signals:event-params -- --asset example.com --days 7 --page  # add the page dimension
pnpm signals:event-params -- --asset example.org --event cta_click --dims label,location
```

Each requested param must be registered as an **event-scoped custom dimension** in that property's GA4 admin first; values are `(not set)` for events collected before registration (forward-only), and a fresh dimension can take up to 48h to start populating. The script prints the provider's real error plus the fix when a dimension isn't registered (doc 15 flow C).

---

# `bing-ai:import` — a downloaded Bing AI Performance export becomes evidence

Bing Webmaster Tools' AI Performance report says
which questions Microsoft's assistants answered with a property's pages and
which pages they cited. It exists in the dashboard and behind an Export button
and **nowhere on the documented API** (doc 11 §"Bing AI Performance boundary"),
and scraping the dashboard is ruled out on principle — so this lane starts with
a human downloading a file. Their whole job is naming the path:

```bash
pnpm bing-ai:import ~/Downloads/example.com_AISearchQueriesReport_8_4_2026.csv
# several at once is fine — they can be different reports
pnpm bing-ai:import ~/Downloads/example.com_AI*_8_4_2026.csv
```

| Option | Meaning |
|---|---|
| `--asset <id>` | Override the property read from Bing's filename. |
| `--export-date <YYYY-MM-DD>` | Override the export date read from it (one file at a time — it is a fact about that file). |
| `--door <url>` | Ingest base url (default `http://127.0.0.1:8791`). |
| `--no-refresh` | Archive only; leave the panel dir alone. |

**What it refuses.** The FORMAT is decided by the header row, on the far side of
the door, against three pinned shapes; an unrecognized header is a loud refusal
naming all three (`workers/ingest/src/bing-ai-exports.ts`). The property and the
export date are read off Bing's own filename — the only place two of the three
exports carry a date at all — and a file renamed past recognition is refused
with the two flags that fix it. A count with a thousands separator is a refusal
too: `Number.parseInt('294,996')` is 294, and nothing anywhere would say so.

**Where the bytes go.** Through `POST /api/bing-ai-export` on the loopback
ingest door, so the one runtime that owns the local store does the write — the
same rule the rest of `signals:*` follows (`scripts/ingest-door.mjs`, bead
ro-mad). The archive is the house one: gzip JSON in private R2 plus an
append-only report-run row, integration `bing-webmaster`, report
`ai-overview` / `ai-queries` / `ai-pages`, `report_date` = the export date. It
carries the ORIGINAL file byte-identical (base64) beside the parse, so a later
reader can redo the read without asking for a download that no longer exists.

**Running it twice is safe.** The archive is content-addressed over the file:
re-importing the same export answers `unchanged` and writes no second copy, so
"did that land?" is answered by doing it again. A later export lands on its own
export date; where two daily-series exports overlap a day, the panel resolves
that day to the newest export rather than counting it twice
(`scripts/signal-history-analyze.mjs`). The run finishes by refreshing that
property's panel dir, which is where a property agent actually reads
([doc 20](../docs/20-signal-panels.md)).

---

# `reclamation-import.mjs` — load an outreach campaign into the store

Loads a campaign's static target CSV into the store's link-outreach targets,
which is step 7 of the [reclamation playbook](../docs/playbooks/reclamation-pipeline.md)
("log every touch — contact, page, date, status — and reconcile before the next
wave"). Without that log the playbook's no-double-pitch rule, its 10–20%
conversion band, and the abandonment rule that band feeds are all unenforceable.

```bash
pnpm reclamation:import -- --asset example.com \
  --csv ../example.com/outreach/gov-reclamation-targets.csv --dry-run
pnpm reclamation:import -- --asset example.com \
  --csv ../example.com/outreach/gov-reclamation-targets.csv
```

| Option | Meaning |
|---|---|
| `--asset <id>` | required; every row is scoped to this property |
| `--csv <path>` | required; header must be exactly `tier,segment,domain,referring_page,links_to_dead,replace_with,contact,notes` |
| `--dry-run` | show what would be stored, and store nothing |
| `--no-overlay` | import the list alone, without the encoded wave-1 send state |
| `--door <url>` | where the ingest answers (default: the local OS's door) |

**It writes through the ingest.** The list goes to
`POST /api/reclamation-targets` with the operator bearer, like every script
that writes the store (`scripts/ingest-door.mjs`), and the ingest stores it in
one transaction: the whole list or none of it. `--dry-run` first shows the
counts and the send state it carries.

**Idempotent by construction.** A page is stored once, keyed on its site,
domain and page; a status only moves forward from a status strictly *earlier*
in the funnel, so importing again can never pull a row backwards and never
touches the terminal `won` / `skip` / `dead` a person set; verification stamps
only move forward. Importing the same list twice changes nothing, and the
command says how many pages were new, moved forward and re-verified.

**The skip pseudo-row.** A list may end with a `SKIP` line whose `domain`
cell holds several slash-separated hosts that must never be
pitched (they repoint to another official destination, not to an independent
site). It imports as **one `skip` row per domain**, because "is this host on the
do-not-pitch list?" is a domain-grain question. Every `n/a` in that row becomes
NULL; its referring page is `''` ("no specific page"), never NULL, because the
page is part of the key a target is stored once by.

**The send-state overlay.** Campaign state that predates the table lives in
the installation's own `reclamation-overlay.json` (bead `ro-ujb9.157`): a
hand-encoded array read once out of the campaign's own prose tables, with the
mapping rules in the comment above `readOverlay` in the script. Without the file
there is no overlay. The prose is deliberately **not** parsed at runtime — it is
a human working document with three status vocabularies in it, and a parser over
prose would silently mis-file a send the day someone reformats a table. An
overlay entry that matches no row in the CSV, or more than one, **throws**:
either way a recorded touch would otherwise vanish, and the next wave would cold-
pitch someone who has already been emailed.

There is no `bounced` status. A hard bounce is still a touch, so the row stays
`sent` with the bounce recorded in `outcome_note` — the no-double-pitch rule
cares that the organization was contacted, not that the mail landed.

---

# `wall:fit` — does the Wall still fit the TV?

The Wall's contract is that it FITS a 1920×1080
CSS viewport, because the DietPi kiosk has no one standing at it to scroll and a
scrollbar there is a broken poster. That contract breaks on **data
growth alone** — one more site reporting, one label painting past the edge. This
measures the fit instead of waiting for the television to report it.

```bash
pnpm wall:fit                              # 1920×1080 against the local Tower
pnpm wall:fit -- --samples 6               # late data lands; take more frames
pnpm wall:fit -- --url http://127.0.0.1:5173/wall --screenshot /private/tmp/wall.png
pnpm wall:fit -- --strict --viewports laptops  # 1280×720 … 1920×1080, one after another
pnpm wall:fit -- --help
```

**Laptops draw the TV's layout, scaled** (bead `ro-trai.31`, docs/25 § Laptop,
tablet and phone): a landscape screen at least 1024 px wide zooms the TV's
1920 × 1080 box to fit, so the same budget holds there. `--viewports` takes a
comma-separated list of `WxH`; `laptops` in it stands for 1280×720, 1366×768,
1440×900, 1470×830, 1512×860, 1728×1000 and 1920×1080. The worst screen's exit
wins, and each report names the scale ("the TV's, scaled to 76.6 %"). The
painting-outside-its-box check counts a zoomed Wall's overflow in screen
pixels and allows no rounding, as on the TV (bead `ro-trai.37`).

Exit `0` fits, `1` content spills past the viewport, `2` it could not be measured
(no Chrome, no Tower, wrong geometry). The command is an operator/agent tool: it
needs a Tower and a local Chrome. **The measurement itself is guarded in CI**
(bead `ro-trai.12`): it is one function, `measureWallFit` in
[`wall-fit-measure.mts`](wall-fit-measure.mts) (with `wallFitVerdict`, the one
reading of it), which this command runs over the DevTools protocol and the journey
`the Wall fits the TV with one, two, three, six, seven or eight sites and on fire…`
in `apps/tower/e2e/journeys.spec.ts` runs in `pnpm test:journeys` against the
isolated fixture Wall (`apps/tower/e2e/wall-fixture.ts`, `WallFixtureVariant`) at
1920×1080. So a change that stops the D28 Wall fitting at any site count the
contract budgets for fails CI, not the television.

**Why it ignores the document's scroll size.** At TV geometry `.wall-root` clips
to `height:100vh/overflow:hidden` (`apps/tower/src/index.css`, the accepted
backstop so the kiosk never grows a scrollbar). That makes `document.scrollWidth`
and `scrollHeight` report a perfect fit no matter how far content spills — the
original acceptance for this bead became vacuous the moment the clip landed. So
the check measures CONTENT, four ways:

| Signal | What only it can see |
|---|---|
| every element box under `.wall-root`, in page coordinates | a region or row stacked past the fold |
| every text run, via `Range.getClientRects()` | **glyph** overflow, which moves no element box and is invisible to a rect scan |
| `.wall-root`'s own `scrollWidth`/`scrollHeight` | content the clip hides — a clipping box still reports it |
| `scrollWidth − clientWidth` on descendants whose own overflow is still visible | content painting outside its box while it is still inside the viewport |

Overflow that an ancestor **inside** the wall genuinely clips is not a leak — that
is the fix — so every candidate rect is intersected with the padding box of each
clipping ancestor below `.wall-root`. The wall-root clip itself is deliberately not
applied: making it unnecessary is the point.

**Read the spread and the site rows, not just the verdict.** The first sample is
routinely shorter than the rest — GA4 realtime and the feed land after first
paint — so one frame is not the wall, and `--samples` takes the worst. The
footer reports the current geometry (`docs/25-the-wall.md` § Budget): each
region’s box, actual row heights, spare height under the last row, and whether
the feed’s lowest row is whole. Since 2026-09-30 rows grow their type and charts
to use the available space, with selected pulse totals adding real content.
The diagnostic no longer predicts capacity from fixed 70 px rows. Near-zero
spare is expected; negative spare means the site region needs scrolling.

The synthetic browser journey proves all rows visible for one, two, three,
six and seven sites at 1920×1080, plus the smaller-screen matrix. Its eight-site
case proves bounded internal scrolling and a fully reachable final row.
Use the isolated fixture for automated checks; the command’s default URL must
not be treated as authorization to inspect a live installation.

`--strict` also fails on unclipped overflow that stays inside the viewport — the
same bug, one site away from the edge. Overflow that an inner box does clip is
not listed, because that is what a fix looks like. The CI journey holds every
variant to `--strict`.

Clipping is the other failure a Wall region can hide (beads `ro-n5ya`,
`ro-yo4h`): a box that clips its own overflow never spills, so rules
1–4 read "AUG ↑$12…" — the rest of the figure under the box's edge — as fixed.
`--strict` also fails on any text run an inner clip cuts off sideways; designed
truncation (`text-overflow: ellipsis`) is not counted. The journey `the Wall cuts
off no text in any region…` also checks it at 1440×900 and holds the site
table's headings to one line.

**Running it as an agent.** Chrome cannot start inside the Claude Code Bash
sandbox — crashpad and its process-singleton socket both come back `Operation not
permitted`, and the script exits 2 with Chrome's own message. Run it with the
sandbox disabled.

---

# `surface:audit` — does a desk surface still meet doc 21?

[Doc 21](../docs/21-surface-design.md)'s
acceptance list is a list of **measurements** — the first screen answers the
surface's one question without scrolling, no paragraph past one sentence outside
`About`, no owner chip or config path on a view surface, every number that can
have a series shows one, the 44px floor holds at 390. Eyeballed from a
screenshot, every one of them drifts. A screenshot shows a surface; only a
measurement adds it up.

```bash
pnpm surface:audit                                   # the eleven desk routes; the site pages on the first site /assets lists
pnpm surface:audit -- --asset example.com            # the site pages on this site instead
pnpm surface:audit -- --routes /financials,/health   # comma-separated, repeatable
pnpm surface:audit -- --strict                       # also flag long one-sentence subtitles
pnpm surface:audit -- --json > /private/tmp/surface.json
pnpm surface:audit -- --help
```

Exit `0` every route meets doc 21, `1` offenders (named per route), `2` it could
not be measured (no Chrome, no Tower, a route that never rendered). Like
`wall:fit` it is an **operator/agent tool, not part of `pnpm test`**: it needs a
live Tower on 5173 and a local Chrome. It is **read-only** — it navigates and
measures, and writes nothing to the operator's store.

Each route is measured twice, at doc 21's own two viewports: **1440×900** (the
desk, where the first-screen, prose, chip and series rules are written) and
**390×844** (the phone, where the 44px floor is). The table reports the page
height at both.

## The attributes a surface must carry to be measurable

The audit reads the page, so a rule it cannot see is a rule that passes by
accident. These are the contract — the vocabulary components of doc 21 carry
them, and any surface hand-built outside that vocabulary must carry them too:

| Attribute | On | What the audit does with it |
|---|---|---|
| `data-surface-hero` | the block that IS the surface's answer | the first-screen rule measures its bottom edge against 900px |
| `data-kpi-strip` | the `KpiStrip` | with `data-hero-chart`, the fallback hero when no `data-surface-hero` is declared |
| `data-hero-chart` | the `HeroChart` | as above; also counts as a KPI's series |
| `data-kpi` | each `Kpi` (value = its metric name) | the number that must show a series |
| `data-spark` / `data-sparkline` | the `Sparkline` inside a `Kpi` | the series that satisfies it |
| `data-composition` | a number whose shape is how a total DIVIDES, not how it moves — `SegmentBar` carries it, and `PriorityBar` through it | also satisfies the series rule, for a KPI the store keeps no history of |
| `data-series="unavailable"` + `data-series-reason` | a `Kpi` whose series does not exist YET, with the reason in words (`Kpi`'s `seriesUnavailable`) | not an offender; listed under the route as "N number(s) declare no series yet" so the gap stays visible on a green run |
| `data-about` | the one `About` disclosure per screen | prose inside it is where doc 21 puts prose, and is never an offender |
| `data-owner-chip` | `OwnerChip` (value = the path) | an offence on any route that is not Settings or Sources |
| `data-config-surface` | a register deliberately shown on a view route | exempts that subtree from the chip rule |
| `data-audit-ignore` | a subtree the audit must not judge | exempts it from every rule |

Two are read but not required: `details.about` is accepted alongside
`[data-about]`, and an `OwnerChip`'s `title` (`"Owned by …"`) is recognised, so a
surface that has **not** been rebuilt to the vocabulary still measures rather
than reporting a false green. A surface that declares no hero at all fails the
first-screen rule by definition — the audit will not certify a first screen
nobody named.

## What each rule actually measures

**Prose** is judged on what a reader sees, not on which tag it was written in.
The page walks text nodes and attributes each to its nearest non-inline
ancestor, so a `<div>` of copy is a paragraph, a `<p>` with a `<strong>` in the
middle is *one* paragraph, and a container whose children are all blocks is
counted zero times. Headings, buttons, labels, code and nav are not prose.
Sentence counting is a counter, not a parser, tuned for the two false positives
that occur in this product's copy — decimals (`1.5 days`, `$12.40`) and
abbreviations (`e.g.`, `28d avg.`). `--strict` adds principle 3's other half: a
single sentence past 120 characters is prose wearing a subtitle's punctuation.

**Owner chips** are counted once. `OwnerChip` is a button whose title says
"Owned by …" wrapping a span that draws the path, and both signatures match —
the operator has one chip to remove, so the chip is counted and its contents are
not.

**The series rule reads the "can" in doc 21's sentence** — "every number that
*can* have a series shows one" (bead `ro-78qo.6`, which is where Home first ran
into it). Some numbers cannot. The operator's inbox posture and the count of
conditions open tonight are point-in-time totals the store keeps no by-day record
of, and what doc 21's Home template draws for each of them is a bar: how the
total DIVIDES, since there is no way it moved. `[data-composition]` inside a
`[data-kpi]` is that answer, and it is a declaration rather than an amnesty — a
number with a real series that draws a bar instead is still an offender, because
its own `Sparkline` is what the mark would have to displace.

**And the third answer is "not yet."** A payload that keeps no history has
neither a series nor a composition — the Tasks board's six counts are the
standing case — and six KPIs each printing a grey "no series" placard is six
identical pills saying nothing. Such a number draws NOTHING where the line would
be and declares the gap on itself: `data-series="unavailable"` for this script,
`data-series-reason` (and the same string as the `title`) for the reader. It is
listed rather than counted — `N number(s) declare no series yet: <labels>`, above
the offenders and printed even on a route that passes — so a green run still says
what the surface is waiting on. The bead that will supply the series belongs on
the surface's own bead.

**The 44px floor** has two deliberate exemptions. A link laid out `display:
inline` is a word inside a sentence, not a control — growing it would break the
line box it sits in. A checkbox or radio is measured through its `<label>`,
because that is the box a thumb actually hits.

**Page height** is not `document.scrollHeight`. The desk shell scrolls inside
`main`, so the document's scroll size is the viewport height on every route and
says nothing; the audit takes the tallest scroll region on the page, floored by
the furthest edge anything actually paints. That is also why the readiness loop
fingerprints the **element count** rather than the document height: a loop
watching `scrollHeight` declares every desk route settled ~600ms after mount and
measures the skeleton. Four equal samples are required, because a route pauses
between its skeleton and its data for as long as the store takes to answer, and
a reading with **no controls and no text at all** is discarded and retaken —
that is the shape of a route measured mid-fetch, and a 844px row in a baseline
is worse than no row.

**Readiness waits for the surface, not for the shell** (bead
`ro-78qo.44`). Mounted is not rendered: the desk shell paints its sidebar, its
nav links and its search box on the first frame, so a route still waiting on
`/api/wall` has plenty of controls and text and the fingerprint above settles on
it happily. The loop therefore waits, up to `--ready-ms`, for the route to
declare its own content — `[data-surface-hero]`, `[data-kpi-strip]` or
`[data-hero-chart]`, one of which every desk route carries. A route that never
grows one is **still measured and still reported `no-hero`**: that finding is
what the mark exists for, and a wait that turned a real missing hero into a hang
would be worse than the bug it fixes.

The second half is the discard. A reading whose page height **equals the
viewport height exactly** is the shell with nothing painted past the fold, so it
is thrown away and retaken like the no-text case. Exact, not a threshold: a
surface that genuinely ends a pixel short of the fold is a surface, and
discarding it would trade a false failure for an unmeasurable route. A skeleton
reading looks convincing in a report — the shell's own nav counts as controls
under the floor. `--settle-ms` defaults to **2500** for the same reason.

## Where the measurement lives, and why the tests can drive it

The page does **no judging**. `collectSurface` walks the DOM and returns plain
descriptors — tag, attributes, ancestry, text, box — and every rule then runs in
node over those. That is what makes the rules testable: `surface-audit.test.mjs`
builds the nested fixture DOM a page would have, flattens it exactly the way the
page does, and drives the same exported functions. The rule that passes the test
is the rule that ran against the Tower, not a second implementation of it.

`collectSurface` reaches Chrome through `Function.prototype.toString`, so it must
stay **self-contained** — a reference to anything at module scope is a
`ReferenceError` in the page and the audit exits 2 with a stack instead of a
table. A test asserts that it holds.

**A closed `<details>` is not on the page** (bead `ro-78qo.20`).
Chrome no longer hides a closed disclosure's content with `display: none`; it
uses `content-visibility` on the implicit slot, so the subtree keeps a layout box
and `getBoundingClientRect()` returns a real rect for text nobody can see. The
descriptor's `visible` therefore says yes, and every rule that trusted it counted
prose, controls and pixels that are folded away — which is most of what doc 21
asks a surface to fold away. `isInsideClosedDisclosure` is the rule, in node with
the others; the SUMMARY is exempt, because it is the visible line and a control
whose own 44px floor still has to hold. The page keeps one copy of the same walk
for the page HEIGHT, which is a measurement node cannot redo.

## The baseline it was written to measure against

There is no stored baseline: the pre-rebuild readings of 2026-09-05 live in
this file's git history, and `pnpm surface:audit` against a live Tower is the
current answer.

**Running it as an agent.** Same as `wall:fit`: Chrome cannot start inside the
Claude Code Bash sandbox — crashpad and its process-singleton socket come back
`Operation not permitted` — so run it with the sandbox disabled.

An agent measuring its OWN branch cannot use the operator's Tower on 5173, which
serves `main`. Start one on a port in 5400–5449 against a COPY of the store:

```sh
cp -R .wrangler/state "$TMPDIR/audit-state"
cd apps/tower
OS_UP_PERSIST_STATE="$TMPDIR/audit-state" \
OS_UP_INGEST_DOOR_PORT=8813 \
MINIFLARE_REGISTRY_PATH="$TMPDIR/audit-registry" \
WRANGLER_LOG_PATH="$TMPDIR/audit-logs" \
pnpm dev --port 54NN --strictPort
```

It listens on `::1`, so pass `--url http://localhost:54NN`. Each variable earns
its place:

- **`OS_UP_PERSIST_STATE`** — the copy. This is what keeps the single-runtime
  rule (`ro-mad`) true: exactly one workerd may hold the operator's sqlite.
- **`OS_UP_INGEST_DOOR_PORT`** — that rule's interlock, and it must be a port
  **nothing is holding**. 8791 is the operator's own; a second Tower on it dies
  at boot with `EADDRINUSE` and the door's own explanation. Check with
  `lsof -nP -iTCP:<port> -sTCP:LISTEN` first, and never stop a process you did
  not start.
- **`MINIFLARE_REGISTRY_PATH`** — the second runtime's own dev registry.
  **This is the variable, not `WRANGLER_HOME`**, which
  the installed miniflare does not read for
  this: `@cloudflare/vite-plugin` passes `unsafeDevRegistryPath:
  getDefaultDevRegistryPath()`, and that is
  `process.env.MINIFLARE_REGISTRY_PATH ?? join(getGlobalWranglerConfigPath(), 'registry')`.
  Without it the second Tower writes to the SHARED registry — inside
  the agent sandbox it dies on `EPERM` opening
  `~/Library/Preferences/.wrangler/registry/__router-worker__`, and outside one
  it would overwrite the operator's own live Tower registration, which is
  the exact hazard the variable prevents.
- **`WRANGLER_LOG_PATH`** — not load-bearing, but without it wrangler prints a
  page of `EPERM` about its log file on every start, in the middle of the output
  you are trying to read.

# UX gate — no paragraph of explanation in the Tower

Bead `ro-ujb9.94`. The operator's rule: "If interactions need
footnotes or a 'paragraph' of explanation, that's a huge UX red flag … rethink a
simple, intuitive flow instead of piling on instructions." And: "codify/gatify
this so any agent who does work on UX in the future encounters a hard stop …
instead of counting on agents to read docs." `scripts/ux-gate.mjs` is that stop.

**What fails.** Any single visible string the Tower renders over its word
budget: labels **12**, failure messages **18** (what happened + what to do),
accessible names (`aria-label`, `alt`, `sr-only`, an `InfoTooltip` label)
**24**. Text is read with the TypeScript compiler: JSX paragraphs are measured
whole (inline `<strong>`/`<code>`/`<a>` included), and so is a sentence joined
with `+` (`ro-ujb9.96.11`: two 10-word pieces are one 20-word string, a
non-string piece counts as one word). Every string and template
literal is presumed visible unless its position provably is not (class lists,
`data-*`/`id`/`href`-style attributes, types, property names, comparisons,
terminal output — `console.*`, `process.stdout/stderr.write`, a dev server's
`logger.*` — SQL, SVG geometry). A message thrown while a component or hook
renders reaches only the console while no error boundary in the Tower shows a
caught error's message, so it is developer text and not counted
(`ro-ujb9.96.4`); once such a boundary exists it counts, and a throw anywhere
else (a handler, a query function) always counts, because the screen that
catches it may show it. Content inside `About` and `InfoTooltip` counts:
hiding a paragraph still ships it. The excluded files are `notDeskCopy` in
`scripts/ux-gate.settings.json`, each with its reason.

**A retired internal term fails too** (`ro-ujb9.135`). A short label can pass
the budget and still name the system's own nouns ("no ledger rows", "On the
roster"). `RETIRED_TERMS` in `scripts/ux-gate.mjs` lists the ones
[docs/17](../docs/17-ui-lexicon.md#retired-on-screen-terms) replaced; any
visible string that says one fails with the word to say instead. It has no
baseline: a retired term stays at zero.

**What it reads** (`ro-ujb9.96.6.13`). `apps/tower/{src,shared,worker}`, plus
every file those reach by a value import, and everything
`apps/tower/vite.config.ts` compiles in: the config registers
(`scripts/config-registers.mts`), the job and workflow descriptions
(`scripts/scheduled-jobs.mts`, `scripts/workflow-definitions.mts`), the
contract's provider catalog (`packages/contract/src`), the dev lanes
(`apps/tower/vite/`) and every config document (`config/*.json`, a string value
judged by its key). Relative imports and `@noticeos/*` packages (through
their `exports`) are followed; `import type` is not; a generated `.mjs` is
measured as its authored `.mts`. Nothing is listed by hand, so moving a
paragraph one import away from `apps/tower` fails exactly as it did there, and
`pnpm ux:gate -- --list` shows these files beside the Tower's own.

**The ingest the Tower calls** (`ro-ujb9.96.6.24`). The Tower reaches the
ingest Worker through the `INGEST` service binding, not an import, and draws
its probe verdicts, refusals, stored `last_error`s and flag messages word for
word. So the gate follows the binding too: from the `services` in the Tower's
`wrangler.jsonc` to the bound Worker's `main` (measured), and from each method
of its default-export entrypoint class — the RPCs, `runScheduled` included,
since it writes what the Tower reads — into the modules that method calls,
followed like any import. The Workers handlers (`fetch`, `scheduled`, `queue`…)
are not followed: sites and crons call those. The ingest text the Tower
already rendered entered the record once, under the widening for
`ro-ujb9.96.6.24`; each screen's redesign is its own bead under `ro-ujb9.96.6`.
GraphQL documents and SQL column-list lines are code, not text.

**Where it stops you.**

| When | How | Scope |
|---|---|---|
| Agent edit | Claude Code hook `scripts/ux-gate-hook.mjs` (exit 2, reason fed to the agent) | the edited file, when the Tower renders it; also blocks edits to the baseline |
| Commit | `.githooks/pre-commit` → `node scripts/ux-gate.mjs --staged` | staged files the Tower renders, plus every file it imports from outside `apps/tower` (no source file staged: one `git diff`, done) |
| CI | `scripts/ux-gate.test.mjs` in `pnpm test:scripts` | everything the Tower renders, the baseline's schema and its git history |

Every failure names the violation (file:line, word count, the text) and ends
with the same fixed instructions: do not shorten or hide the text; redesign
the interaction; if unsure how, research how best-in-class modern products
handle the same interaction until you find the best current comparable, record
it in `docs/briefs/<flow>.md#prior-art`, and build that pattern.

The strings the change added come first, marked `← this change`, and the
file's older offenders follow under "already in <file> before this change"
(`ro-ujb9.96.5`), so the redesign starts with the new sentence, not the legacy
debt. "Added" means absent from the base version of the file: what the edit
wrote (edit hook), the committed `HEAD` (pre-commit, and `pnpm ux:gate` for an
uncommitted file), or where the branch left `main` (CI; the parent commit on
`main` itself or in a merge checkout). A checkout with no history to compare
lists every offender unmarked.

**The ratchet.** `apps/tower/ux-budget.json` holds the legacy offenders per file
(count and words) measured when the gate landed. A file may not gain either.

```sh
pnpm ux:gate                 # the whole Tower (what CI runs)
pnpm ux:gate -- --list       # every offender, longest first
pnpm ux:gate -- --files apps/tower/src/routes/HealthRoute.tsx
pnpm ux:baseline             # after removing prose: lower the record (never raises)
```

Removing prose makes the record stale, and a stale record fails CI and the
commit (a looser record is room to add prose back): run `pnpm ux:baseline` and
commit `apps/tower/ux-budget.json` with the change. `ux:baseline` never adds a
file or raises a number, and refuses to recreate a missing record.

**Widening the gate.** When the gate itself learns to read files it never read
(as `ro-ujb9.96.6.13` did), the text the desk was already rendering from them
is legacy debt, recorded once:

```sh
pnpm ux:gate -- --widen <bead> --reason "<what the gate now reads>"
```

It adds those files' offenders to the record under one `widenings` entry in the
file's header naming the bead, never as per-file exceptions. It refuses any
file whose text is new or changed since `HEAD`, or that the Tower did not
import at `HEAD`: that is added prose, and it is redesigned. The commit, CI and
the history audit hold every widening to the same rules, plus: the same change
edits `scripts/ux-gate.mjs`, records are append-only, and a file and a bead
widen once. The widened files' offenders are assigned to the screen beads under
`ro-ujb9.96.6` and removed like the rest.

**Exceptions** are an operator decision and exist only for three kinds of fact:
`trust-safety` (a secret shown once), `legal` (a required disclosure) and
`destructive-confirmation` (what an irreversible action destroys). Everything
else is redesigned. The operator raises an entry by hand with all four keys:

```json
"apps/tower/src/routes/IntegrationsRoute.tsx": {
  "count": 5, "words": 110,
  "kind": "trust-safety",
  "approvedBy": "ro-abcd.1",
  "reason": "The key is shown once and cannot be recovered",
  "priorArt": "docs/briefs/credential-reveal.md#prior-art"
}
```

`priorArt` must resolve to a heading in a `docs/briefs/` file whose section
cites at least three source URLs. The check runs on the working tree, on the
staged index in the pre-commit hook, and on every historical commit that
touched the record, so a raise committed with `--no-verify` is still found.

**The gate's own rules** (`ro-ujb9.96.3`) live in
`scripts/ux-gate.settings.json`, not in the script: the three budgets, the
directories always read (`scanDirs`), the files imports are followed from
(`traceRoots`) and the files never read (`notDeskCopy`, each with its reason).
The edit hook protects the file like the record. Tightening is free (lower a
budget, add a directory, drop a skipped file). Loosening is the same operator
exception as a raise: a raised budget or a new `notDeskCopy` entry carries
`kind`, `approvedBy`, `reason` and `priorArt`, fresh for each change. A scan
directory or trace root leaves only once it no longer exists; stopping to read
a file that still renders is an approved `notDeskCopy` entry. The file is
never deleted, and every commit that touched it is audited, the first against
the constants it replaced (`LEGACY_SETTINGS` in the script).

**The pre-commit hook installs itself.** The root `prepare` script
(`scripts/install-git-hooks.mjs`) runs on every `pnpm install` and sets
`git config core.hooksPath .githooks` — repository config, so the main checkout
and every `.claude/worktrees/*` worktree get it. It does nothing in CI, outside
a git work tree, or when `core.hooksPath` already points elsewhere (it says so).
A pre-existing `.git/hooks/pre-commit` is chained, not lost. **Bypassing it with
`git commit --no-verify` is not allowed** (AGENTS.md).

**The Claude Code hook** is wired by adding this to the project's `.claude/settings.json`
(merge into an existing `hooks` object if there is one):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash",
        "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR\"/scripts/ux-gate-hook.mjs pre" }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR\"/scripts/ux-gate-hook.mjs post" }]
      }
    ]
  }
}
```

`post` measures the edited file if the Tower renders it and exits 2 when it holds
more prose than the record allows, marking the strings the edit wrote
(`← this change`). When an edit removes prose it exits 0 and tells the agent to
run `pnpm ux:baseline`. `pre` exits 2 on any Edit/Write to the record or to
`scripts/ux-gate.settings.json`, and on shell commands that would write either
(redirects, `tee`, `sed -i`, `cp`/`mv`, interpreters); reading them and
`pnpm ux:baseline` stay allowed. The hook finds
the checkout from the edited file, so one registration covers every worktree,
and it fails open (exit 1, a visible warning) if it cannot run, because the
commit hook and CI still hold the line.

# UX flow gate — a flow only gets shorter

Bead `ro-ujb9.95`. The operator's rule: "way too many steps
where it's more natural just to add one more button or component to the
current step than blowing the entire flow up with extra steps, duplicated
checks"; "No duplicate statuses on the same screen"; a list repeating one
subject is grouped under it. The text gate above reads source files and cannot
see a flow that takes nine clicks across two pages. The flow gate walks them,
in a browser.

**What fails.** Every flow declared in `apps/tower/e2e/ux-flows.mjs` is walked
at desktop (1440×900) and phone (390×844) by clicking only the controls the
product offers, and held per viewport to `apps/tower/ux-flows.json`:

| Rule | Counted as |
|---|---|
| Steps only go down | actions (clicks, fields, selects), screens (a URL or a guided step; a panel opened over the page is not a screen, its presses are actions), page changes, words of explanation on screen |
| No empty step | a screen left having entered or decided nothing |
| Check once | the same verify step, check request (`…/test`, `…/sites`, Google properties) or dialog twice in a flow |
| One status per subject per screen | the same status for the same subject shown twice on one screen |
| Group lists by subject | a list whose items repeat one subject (`data-order="chronological"` exempts a timeline or log) |

**Subjects come from the markup, never a guess** (bead `ro-ujb9.96.10`). Every
status renderer — `StateChip`, `IntegrationStateChip`, `ConnectionFacts`,
`StatusBanner`, `InlineSaveState` — takes a required `subject`, a
`StatusSubject` (`kind:id`: `integration:bing-webmaster`, `asset:example.com`,
`source:example.com:uptime`, `task:ro-1`), and draws it as `data-status-for`;
a hand-drawn `role="status"` carries `data-status-for` itself; a row in a list
of subjects carries `data-subject`. `scripts/status-subject.test.mjs` fails a
call site that names none. The walker reads only those: a status that declares
nothing is the screen's and counts as the same fact as any status with its
words there, and a row that declares nothing is read by the line it leads
with — so an undeclared repeat fails the gate instead of passing as two
subjects.

The screen survey (the `survey` entry) opens every main screen by URL, so the
last two rules cover every screen, not only the ones a flow passes through.

**Where it stops you.** `pnpm test:journeys` ends with it (CI's fifth gate),
and runs it even when a journey has failed, so every agent that runs the
journeys meets it. The pre-commit hook refuses an
unapproved raise of the staged record (`node scripts/ux-flow-gate.mjs
--staged`), and the Claude Code `pre` hook above refuses any edit to it.
`pnpm test:scripts` proves the judge and audits the record's git history.

**Every failure** names the flow, viewport, rule, the step and screen, the
measured and budgeted numbers and the screenshot
(`apps/tower/e2e/ux-flows-results/shots/…`, uploaded by CI), then ends with the
same fixed instructions as the text gate: do not add a step, screen, check or
status; add the control to the current step; check once; show one status where
the operator acts; group by subject; if unsure, research the best modern
comparable and record it in `docs/briefs/<flow>.md#prior-art`.

```sh
pnpm ux:flows                                  # walk every flow (what the journeys run)
pnpm ux:flows -- --flows connect-bing,inbox    # just these
node scripts/ux-flow-gate.mjs                  # the record, its history and prior art, no browser
pnpm ux:flows:baseline                         # after a flow got cheaper: lower the record (never raises)
```

**The ratchet** is the text gate's. The record holds each flow's actions,
screens, page changes and words plus its four rule counts. **The rule counts
are legacy debt** that epic `ro-ujb9.96.7` removes to zero, never an allowance.
A cheaper flow makes the record stale, and a stale record fails: run
`pnpm ux:flows:baseline` and commit `apps/tower/ux-flows.json` with the change.
A walk that cannot finish fails too: a changed flow changes its walk in the
same commit, and a flow is never deleted to get past the gate (only the
operator retires one, under `"retired"` with `"approvedBy"` and `"reason"`).

**A new flow** must cite its research (`priorArt`: a `docs/briefs/` section
with at least three source URLs) and walk with zero empty steps, duplicated
checks, duplicate statuses and ungrouped lists. Its first measured step counts
then become its budget (`pnpm ux:flows:baseline` records it).

**Exceptions** have the text gate's terms: the operator raises one viewport's
entry by hand with `"kind"` (`trust-safety`, `legal`,
`destructive-confirmation`), `"approvedBy"`, `"reason"` and `"priorArt"`; the
record's git history is audited so a raise committed past the hook is found.

**Isolation** is the journey suite's: one fixture server per lane (as many
lanes as the journeys have workers by default — `JOURNEY_WORKERS`, or half the
machine's cores up to 4 — or `--parallel`), each started by
`apps/tower/e2e/fixture-server.mjs` on a free loopback port (so two runs on one
machine never collide, beads `ro-ujb9.107`, `ro-ujb9.167`), started once per
run, reset before every flow, the isolation guard armed, every request to
another origin aborted. Before any
flow, the runner checks its own probes against a page holding one of each
violation, so a probe that went blind fails instead of reading as progress.

# Neutral-code gate — product code names no installation's own sites

Bead `ro-ujb9.118`, decision D30. A stranger's installation
must not carry somebody else's sites or behave differently because of them.
`scripts/neutral-code-gate.mjs` fails when product source — or a product
default in `config/` (`ro-ujb9.125`), or a document that ships with the product
(`ro-ujb9.157`) — names one of this installation's own asset ids, domains,
site display names or Google accounts, or any time zone.

**The list comes from the installation, never from the gate.** It is read
from the documents `pnpm config:export` writes into the installation folder —
every register in `scripts/config-registers.mjs` whose rows are keyed by an
asset id or a domain (`integrations.json` `/assets`, `beads.json`
`/spokes`, `domain-costs.json` `/domains`, …) —
from the tracked `neutral-names.json` inventory in that installation folder,
which retains the OS id, historical domains and display names — and from the Google account
each source's `ref` in `integrations.json` routes through
(`GOOGLE_SIGNAL_ACCOUNTS <alias> -> …`), with the
`GOOGLE_SERVICE_ACCOUNT_<ALIAS>` secret name derived from it.
`pnpm neutral:gate -- --names` prints the list and where each name was read.

**What it reads.** `apps/tower/{src,shared,worker,vite}`, `workers/ingest/src`,
`packages/contract/src`, `apps/tower/vite.config.ts` and `apps/tower/index.html`:
code, comments, styles, JSON and the component registry. And the product
defaults, `config/*.json` and `config/*.yaml`, which every fresh clone seeds, and
the prose that ships beside them — each register's README, the decision log and
`config/changesets/README.md` — which explains the product with example names;
an installation's own history and decisions live in its installation folder
(`decisions.md`, `notes.md`; `ro-ujb9.149`). And
`scripts/` — the local runner and the host and CLI scripts ship with the
product, so a stranger's runner must not file against, back up to or describe
somebody else's sites (`ro-ujb9.120`); a generated `.mjs` is judged as its
authored `.mts`. And every operator document that ships (`ro-ujb9.157`):
`docs/**/*.md`, this README, the Workers' and the other workspaces' READMEs,
`CONTEXT.md` and the two example secrets files in `workers/ingest/`. They explain
the product with example names; what they carried about this installation moved
to its installation folder's `notes.md`, word for word. Dated records —
`docs/reports/`, `docs/briefs/`, `docs/artifacts/` — keep the words they were
written in and are not read. And the test code (`ro-ujb9.151`): the Tower,
ingest, contract and script suites, the e2e walks, every frozen config fixture,
the dev seed and each suite's `vitest.config.ts`. They name invented `.example`
sites; a suite that migrates a store renames the historical seed's rows to them
(`db/fixtures/invented-sites.json`). Test code is judged for names only — a
time-zone test's data is a zone — and the old-name rule's own test
(`scripts/product-name.test.mjs`) may spell the product's old slug, which the
historical seed also gives the OS asset. `-- --files <paths>` judges each named
file by the rule it falls under.

**How a name matches.** A domain, an asset id or an account matches wherever it
is not part of a longer word, including in a URL, a subdomain, a file name or a
path segment (`<site>-open.json`, `<site>/panel`). A site's display name matches
as written, as a whole word. The OS asset's dot-less id (usually the product's
own slug) matches only where it stands alone — `'home-os'`, `home-os's` — and
never as the product's namespace: a package scope (`@home-os/…`), a storage key
(`home-os:…`), a repository path or a longer name (`home-os-central`).

**Time zones.** In product code, any IANA zone the runtime knows fails, except UTC. The
installation's clock is the saved `os_time_zone`. The one place a zone may be
named is a provider's documented reporting zone, `reportingTimeZones` in
`packages/contract/src/integrations.ts` (Search Console's day is Pacific for
every installation).

**Where it stops you.**

| When | How |
|---|---|
| Commit | `.githooks/pre-commit` → `node scripts/neutral-code-gate.mjs --staged` (a staged config document or migration rechecks every product and test file) |
| CI | `scripts/neutral-code-gate.test.mjs` in `pnpm test:scripts`: zero offenders on the checkout, and planted names fail |
| By hand | `pnpm neutral:gate`, or `-- --files <paths>` |

There is no baseline and no allowance file: a name that must appear is read
from the store with a generic default (the OS asset by `assets.is_os`, the
clock by `os_time_zone`, a site's favicon from the site itself).

## One bounded local demo replay

`scripts/demo-replay.mjs` serves one completed synthetic installation while it
makes one explicit new-generation attempt. Both installations must use the same
verified public release. It never retries, adopts an interrupted attempt, or
resets an existing database. Name an absent next folder and control folder, an
exact release and task executable, seed/cutoff, and distinct loopback ports:

```sh
node scripts/demo-replay.mjs --current-dir /absolute/completed-demo \
  --next-dir /absolute/new-demo --control-dir /absolute/new-replay-custody \
  --release <exact-commit> --bd-bin /absolute/qualified-bd \
  --port 6400 --current-port 6402 --next-port 6404 --seed-port 6410 \
  --seed local-example --cutoff 2026-09-30T00:00:00.000Z
```

The seed port reserves its next three ports; the database ports are seed+2 and
seed+3. Each reader reserves its next port. Existing database ports must also
remain distinct. The gateway binds only `127.0.0.1`. A visit lasts at most fifteen
minutes and never extends on navigation, refresh or API polling. Old visits keep
the old generation after publication. Expired APIs return 410; an expired page
offers **Open current demo** to start a new visit. These selectors choose a
generation; they do not authenticate or grant write access. Existing demo
read-only rules remain unchanged.

The launcher lasts at most twelve hours (`--duration-ms` may shorten it), with
one generation attempt limited to ten minutes, at most two readers, 1024 issued
visits and eight simultaneous document/API requests per visit. Generation asset
and Vite channels are bound to their exact reader. The previous reader retires
after fifteen minutes plus a thirty-second request drain. Exact owned database
cleanup then has a two-minute bound; completion archives remain. A failed
candidate keeps the current generation; uncertain retirement stops the launcher
and retains custody. Launcher shutdown retains the current completed database
project and all completion archives for a later explicit run; it stops only its
known readers and gateway. Failed or uncertain candidate resources remain in
custody for explicit recovery. Preserve the named folders for explicit recovery after any
refusal. No cloud publication, live installation, provider or scheduler is used.
