<!-- scripts-index:start -->

### Run the installation

| `pnpm …` | What it does | Runs |
|---|---|---|
| `os:status` | What runs, its health, the database's migrations, and whether main is ahead. | `scripts/stack-control.mjs status` |
| `os:logs` | Recent logs; `-- --follow`, `-- --lines N` or `-- <service>` narrow them. | `scripts/stack-control.mjs logs` |
| `os:start` | Start the stack: databases, then backup, then the app, each healthy first. | `scripts/stack-control.mjs start` |
| `os:stop` | Stop the app, then backup, then the databases. | `scripts/stack-control.mjs stop` |
| `os:restart` | Restart the stack in the same order, waiting for each layer's health. | `scripts/stack-control.mjs restart` |
| `os:update` | Build main into an image, show the plan, and apply it after you confirm. | `scripts/stack-deploy.mjs` |
| `os:rollback` | Move the app back to the previous image, after you confirm. | `scripts/stack-deploy.mjs --rollback` |
| `os:migrate` | What is applied and pending; `-- --apply` applies it after you type the database's name. | `scripts/os-migrate.mjs` |
| `os:dev` | Run the app from this checkout's live source; edits refresh it. | `scripts/stack-development.mjs` |
| `os:prod` | Run the app from the prepared image it ran before. | `scripts/stack-development.mjs --disable` |
| `os:backup` | Run one backup now, inside the app container. | `scripts/stack-control.mjs backup` |
| `os:run-job` | Fire the jobs scheduled on one cron expression now. | `scripts/stack-control.mjs run-job` |
| `os:capacity` | The store's size and growth per table; `-- --json` for the raw inventory. | `scripts/stack-control.mjs capacity` |

### Change the database

| `pnpm …` | What it does | Runs |
|---|---|---|
| `db:new-migration` | Write the next numbered migration file. | `scripts/postgres-migrate.mjs new` |
| `db:try-migrations` | Run the migrations on a throwaway development database. | `scripts/postgres-migrate.mjs` |
| `db:create-secrets` | Write the Postgres service's secret files, once, before the service's first start. | `scripts/postgres-secrets.mjs` |
| `db:seed-demo` | A new installation's store filled with invented history. | `scripts/db-seed.mjs` |
| `db:consumers` | Which source reads and writes each table. | `scripts/postgres-docs.mjs --consumers` |

### Settings and credentials

| `pnpm …` | What it does | Runs |
|---|---|---|
| `config:apply` | Apply a config changeset in the operator's terminal. | `scripts/config-apply.mjs` |
| `config:seed` | Load the config documents into the store. | `scripts/config-seed.mjs` |
| `config:export` | Write the store's config documents into this installation's folder. | `scripts/config-export.mjs` |
| `creds:check` | Prove each credential the OS is using with one cheap real probe per lane. | `scripts/creds-check.mjs` |
| `creds:rotate-key` | Re-seal every stored credential under a new CREDENTIALS_KEY. | `scripts/creds-rotate-key.mjs` |

### Signals and imports

| `pnpm …` | What it does | Runs |
|---|---|---|
| `signals:collect` | Collect one property's DataForSEO families now, instead of waiting for Monday — or its PostHog families, `--families 'posthog-*'`, with an optional fixed `--start/--end` window. | `scripts/signal-collect.mjs` |
| `signals:download` | Download the latest immutable raw-signal object for each selected report day. | `scripts/signal-dumps-download.mjs` |
| `signals:history` | The provider history as analytical files. | `scripts/signal-history.mjs` |
| `signals:analyze-history` | The analysis, read from the history files. | `scripts/signal-history-analyze.mjs` |
| `signals:refresh` | Keep every rostered property's panel dir current. | `scripts/signal-panels-refresh.mjs` |
| `signals:publish-insights` | Publish one compact executive snapshot into the store's presentation boundary. | `scripts/signal-insights-publish.mjs` |
| `signals:event-params` | GA4 event-parameter report for one asset: the manual companion to the daily GA4 archive lane, for event params the archive does not export. | `scripts/ga4-event-params.mjs` |
| `bing-ai:import` | Drop a Bing AI Performance export anywhere, run one command, and it becomes evidence. | `scripts/bing-ai-import.mjs` |
| `reclamation:import` | Load a campaign's static target CSV into the store's link-outreach targets, carrying whatever send state the campaign recorded elsewhere. | `scripts/reclamation-import.mjs` |
| `reclamation:open-targets` | A site's OPEN link-outreach targets, written to the file the reclamation-match rule reads (`pnpm signals:analyze-history -- --reclamation-targets <file>`, scripts/signal-insights.mjs). | `scripts/reclamation-open-targets.mjs` |
| `mediavine` | The Mediavine publisher-portal client in the terminal: status, sites and a revenue sync for one site. | `scripts/mediavine.mjs` |
| `pulse:relay` | Relay a pull-mode site's live pulse into the LOCAL ingest worker. | `scripts/pulse-relay.mjs` |

### Check the code and the screens

| `pnpm …` | What it does | Runs |
|---|---|---|
| `check:neutral` | Product code names no installation's own sites, accounts or clock. | `scripts/neutral-code-gate.mjs` |
| `audit:copy` | The UX text report: how much reading each Tower screen asks for. | `scripts/ux-gate.mjs` |
| `audit:flows` | The flow walker: walk every declared operator flow in a real browser and report what each one costs (actions, screens, page changes, explanatory words, empty steps, repeated checks, duplicate statuses, ungrouped lists). | `apps/tower/e2e/flow-gate.mjs` |
| `audit:viewport` | Capture the running Tower at each viewport through a local Firefox Marionette session, for a visual review. | `scripts/tower-viewport-audit.mjs` |
| `audit:wall-fit` | Does the Wall still fit the TV? | `scripts/wall-fit-check.mjs` |
| `audit:surfaces` | Does a desk surface still meet the design doc? | `scripts/surface-audit.mjs` |

### Tests

| `pnpm …` | What it does | Runs |
|---|---|---|
| `test` | Every workspace's unit tests. | `pnpm -r --if-present run test` |
| `test:scripts` | The root suite: every scripts/*.test.mjs. | `node --import ./scripts/script-tests-setup.mjs --test-global-setup=./scripts/scr…` |
| `test:task-store` | The task-store suite against a real Dolt server in Docker. | `node --import ./scripts/script-tests-setup.mjs --test-global-setup=./scripts/scr…` |
| `test:journeys` | The Tower's browser journeys, then the flow walker. | `pnpm --filter @noticeos/tower run typecheck:journeys && pnpm --filter @noticeos/…` |

### The repository

| `pnpm …` | What it does | Runs |
|---|---|---|
| `start` | NoticeOS on this machine, in one command. | `scripts/start.mjs` |
| `typecheck` | Typecheck every workspace. | `pnpm -r --if-present run typecheck` |
| `build` | Build every workspace. | `pnpm -r --if-present run build` |
| `prepare` | Install the repository's git hooks on `pnpm install`. | `scripts/install-git-hooks.mjs` |
| `generate` | Regenerate every committed file the code writes: compiled `.mts` pairs, the config docs and the command index. | `scripts/generate.mjs` |
| `project:prepare` | Prepare repository context only. | `scripts/project-context.mjs` |

Generated by `pnpm generate` from `package.json` and each script's header; `scripts/scripts-index.test.mjs` fails when this block is stale.

<!-- scripts-index:end -->

# scripts/ — the commands

Every command this repo offers is a `package.json` script; the index above is
generated from that file and each script's own header, so it cannot drift from
the code. A script's `--help` or header comment says what its flags do. The
sections below hold only what a command cannot explain about itself: how the
installation runs, what a cron may catch up, how the store is migrated and
backed up, what the gates refuse.

# Prepare public source

```sh
node scripts/public-source.mjs --commit <full-commit-hash> --destination /absolute/new-public-source
```

The destination's parent must exist; the destination must be new and outside
the source checkout. The exporter reads only the exact committed blobs its
public source policy and [`public-source.settings.json`](public-source.settings.json)
select; dirty and untracked files, private installation records and Git history
are omitted, and `public-source.json` records the commit, file hashes and
executable modes. This prepares files only: it does not sanitize contents,
initialize a public repository, publish or deploy. Review the export for
private data and run the
[release qualification](../docs/reference/release-policy.md#qualify-a-release-candidate)
against that exact source before publication, which needs its own operator
approval.

# A new installation in one command (`pnpm start`)

```
pnpm install --frozen-lockfile
pnpm start                       # → http://127.0.0.1:4747/, Home's first-run steps
pnpm start -- --port 6000        # the Tower on 6000, its ingest door on 6001
pnpm start -- --dir ~/noticeos   # keep the installation somewhere else
pnpm start -- --no-open          # print the address, open no browser
```

The committed `verifyDepsBeforeRun: error` setting makes `pnpm run` refuse
stale dependencies, so install first.



`scripts/start.mjs` makes one folder, `.local/start/`, for its runtime state
(`.wrangler/state`), bootstrap secrets (`workers/ingest/.dev.secrets.json`,
compiled to `.dev.vars`), generated Worker configs, saved-settings exports
(`installation/`) and log. Operational data lives in the Postgres database
named by the folder's `DATABASE_URL`; deleting the folder does not reset it
([secret boundary](../docs/06-operations.md#bootstrap-secrets-vs-integration-credentials)).
It is **not the Docker stack** the `os:*` commands run: it never opens the
checkout's `.wrangler/state`, `installation/` or secret files, refuses the
stack's ports (5173, 8791, 3308), refuses a folder it did not make, and
allows one start per folder (`scripts/start.test.mjs` trips each of those).
Prerequisites are Node 24.21.0 LTS, pnpm 12.8.1, local Docker Compose, `psql`
and Beads CLI (`bd`) **1.3.1**, checked before any state is created.

**A new, empty installation gets its own Postgres automatically**
([approved exception](../AGENTS.md#hard-invariants)).
Setup checks the committed migration hashes, proves the folder, its Compose
project and its data volume are new, makes the profile's secrets under
`<start-folder>/postgres/secrets`, starts its isolated service, confirms the
database is empty, applies only frozen migrations, and bootstraps one
workspace. Postgres listens on the Tower port plus two (4749 by default); the
project is `noticeos-start-` plus a hash of the folder's path, recorded in the
nonsecret `postgres/profile.json`. **The same installation gets its own Dolt
task hub** on the Tower port plus three (4750), with its own `dolt-data` volume and `dolt/profile.json`
([recovery procedure](../db/dolt/host/README.md)), plus an internal NoticeOS
asset and task project, so Tasks is usable before the first website. Later
starts reuse the same resources; missing ones require explicit recovery.

An existing folder, store, secrets or database is never migrated
automatically: an inherited `DATABASE_URL`, an explicit
`NOTICEOS_POSTGRES_SECRETS` or `NOTICEOS_POSTGRES_PORT`, or a symlinked folder
prevents automatic setup ([taking an address from a prepared Compose profile](../db/postgres/host/README.md)).
With the address in the secrets file, every start checks it as the application login
(`scripts/database-address.mts`): the database answers, the login is
`noticeos_app`, every migration this code has is applied, the one workspace
exists; anything else stops the start in one sentence naming the fix
(`pnpm os:migrate -- --apply` or `bootstrap`) and never repeats the address,
which rides only in the Tower's environment
(`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_POSTGRES`). Startup has no
`--migrate` flag.

It keeps collecting on its schedule (`scripts/start-schedule.mjs`): it fires
the ingest's crons at its own door on the schedules saved in its store, with
the runner's catch-up policy (`scripts/job-runs.mjs`), and of the
runner's host lanes runs only the task board refresh and the backup
(`scripts/start-host-lanes.mjs`); its status says `hostLanes: false`.

# Prepare an asset repository's context

Follow [the task project guide](../docs/guides/connect-a-task-project.md), then from the
NoticeOS checkout:

```sh
pnpm project:prepare -- --repo /absolute/project-checkout --check
pnpm project:prepare -- --repo /absolute/project-checkout --write
```

It prepares local repository files only (task instructions, a freeze
register, Git exclusions, a shared lock for an existing `.beads/`); it never
initializes a database, changes credentials, saves settings or calls a
service, and refuses tracked task state or conflicting instruction blocks.

# The runner (`os-up`)

The app container runs one plain-Node supervisor, `scripts/os-up.mjs` (no
build step), started by `deploy/compose/entrypoint.mjs`. It brings up **one**
dev server hosting **both** Workers against Postgres and local R2 state, fires
the ingest crons, health-checks the stack's task hub, and takes a nightly
backup with an offsite copy (`config/host-backup.README.md`). Each
responsibility is a module under `scripts/runner/` with its own
`scripts/runner-<module>.test.mjs`. Running it directly on a host is not
supported; the `os:*` commands reach it through the stack
`.local/stack.json` selects ([Docker guide](../deploy/compose/README.md)):

```
pnpm os:status                # each service's state and health, the database's migrations, the app's commit
pnpm os:logs -- --lines 200   # recent redacted output (-- --follow to tail, -- <service> for one)
pnpm os:restart               # the whole stack, in dependency order, waiting for health
pnpm os:capacity              # store size and growth per table, read-only
pnpm os:backup                # one full backup now (Postgres + R2 + hub, then offsite)
pnpm os:run-job -- "0 * * * *"   # fire the jobs scheduled on one cron expression now
```

`os:backup`, `os:run-job` and `os:capacity` run inside the app container with
the runner's own environment. The container is `healthy` when the runner
reports itself healthy with a heartbeat at most 60 s old, its Tower ready and
its scheduler armed; a configured backup worker answers; and the Tower and
the ingest door both answer inside the container
(`deploy/compose/health.mjs`). Status never exposes credentials, addresses or
raw database errors.

## Shared configuration code

Every module under `scripts/` that browser, Worker or Tower TypeScript imports
is authored as `scripts/<name>.mts`; the checked-in `.mjs` and `.d.mts`
siblings are TypeScript output, so Node scripts run without a build and a
TypeScript import of the `.mjs` resolves to the `.mts` source.
`tsconfig.config-contract.json` compiles the portable modules with no ambient
types; `tsconfig.config-contract.node.json` adds Node types for the runner and
terminal adapters. **Edit the `.mts`, then run `pnpm generate`**;
`pnpm generate -- --check` rejects stale output, and the contract package's
typecheck runs the same check.
`config-store-client` and `dev-secrets` stay hand-written because they move
credentials (`scripts/declaration-lockstep.test.mjs`).

## What it does

Frequencies are defaults; local schedules are changed in **System health →
Background operations → Edit schedule**.

- **One runner at a time** — it first checks whether the ingest door already
  answers; if so it starts nothing, prints the `lsof` naming the owner, and
  exits 3.
- **No migrations at startup** — supervision, restart, crash recovery,
  catch-up and `pnpm os:update` never invoke `pnpm os:migrate`; the
  fresh-install exception belongs only to `pnpm start`.
- **Starts on its Postgres, or not at all** — it reads `DATABASE_URL` from
  the installation's secrets file and checks it as the application login,
  read-only (`scripts/runner/database.mjs`); an unusable address or a database behind
  this code's migrations writes one `REFUSING to start` line naming the fix,
  never the address, and exits 5.
- **Supervises one child** — the Tower's `vite` dev server, whose single
  workerd runtime hosts both Workers — restarting it if it dies and giving up
  loudly after 5 rapid restarts within 10 s of each other.
- **Health-checks the task hub** at startup, every 15 min and before every
  snapshot poll; it does not host it.
- **Photographs the task hub every minute** into the central store, which is
  what the Tower's `/tasks` board renders.
- **Schedules the ingest crons** and fires them at its own ingest door.
- **Nightly backup** at 04:00 UTC with host-configured retention, then an
  offsite copy.
- **Clean shutdown** on SIGINT/SIGTERM: stops the schedulers, group-kills the
  child (SIGTERM → SIGKILL), exits 0. The task hub outlives the runner.

Everything is echoed to stdout and appended to the combined runner log, read
through `pnpm os:logs`: secret shapes and the password in a connection URL
are scrubbed before they reach disk and again on read, a line is capped at
64 KiB, the log rotates at 5 MiB, and the scheduled-lane record retains 30
days. Tunable constants are the `CONFIG` block in `scripts/runner/config.mjs`.

## Scheduled job configuration

**Workflows** (`/workflows`) lists the built-in operator automations and
**System health → Background operations** (`/health/operations`) the
collection and maintenance operations, each with purpose, latest execution
state, hourly activity and a Schedule view. **Edit schedule** changes
frequency, local time or weekday, pauses a job, or restores its default,
previewing the next three runs and saving through the guarded config pipeline
with Undo; it creates no arbitrary commands and does not change Cloudflare's
deployed cron triggers. A **collection's** schedule is changed with the
collection: on the **Manage** panel of each Integrations connection that feeds
it (the job's `connections` in `scripts/scheduled-jobs.mts`), or in
**Settings → Data collection** for one no connection feeds.

Overrides live in the stored `config/constants.json` document at `/schedules`:
each known job id maps to `{ "enabled": true, "cron": "0 21 * * *", "timezone": "UTC" }`.
The IANA timezone defaults to UTC; editing timing saves the viewer's timezone;
pausing preserves the prior cron and timezone. Missing entries use the
defaults declared in `scripts/scheduled-jobs.mjs`, which
`scripts/scheduled-jobs.test.mjs` holds equal to the ingest triggers and
runner configuration. The constants document must be seeded before scheduling
starts.

The runner reads the config store every 15 seconds and replaces only timers
whose settings changed; if the initial read fails no jobs are armed. Execution
traces are stored locally in `.local/logs/workflow-runs.jsonl`, bounded, with
allowlisted outputs only; whole-run verdicts also live in the 30-day job log,
and missing output is unavailable, never an invented zero
([doc 22](../docs/22-workflows-research-and-design.md)).

## Port map

| Service | Port | Notes |
|---|---|---|
| tower + ingest (`vite`) | **5173** in the app container | one workerd runtime hosting both Workers; published only on the host's `127.0.0.1:${NOTICEOS_TOWER_PORT}` |
| ingest door | **8791** in the app container | a second loopback listener from `apps/tower/vite/runner-door.ts` serving the ingest's routes and cron fires; never published, because the scheduled endpoint is unauthenticated |
| task hub (`dolt sql-server`) | **3306** on the installation network | the stack's `dolt` service, declared in `/state/task-client.json` |

The port constants are the `CONFIG` block of `scripts/runner/config.mjs`;
`os:run-job` reads the same constant, and the runner passes the door address
to the dev server as `OS_UP_INGEST_DOOR_HOST` / `OS_UP_INGEST_DOOR_PORT`.

## One runtime

The ingest is an **auxiliary Worker** inside the Tower's dev runtime
(`auxiliaryWorkers` in `apps/tower/vite.config.ts`); one runtime owns local R2
persistence and one runner fires schedules.

- **One runtime, one listener.** The ingest gets a second listener bound to
  loopback, the "ingest door", which the same `vite` process opens on 8791; a
  request there reaches the ingest Worker through the Tower's private `INGEST`
  Service Binding.
- **The boundary is the kernel, not a header.** The door marks the requests it
  created, a guard strips that mark off every other request, and the lane is
  compiled out of a production build (`__RUNNER_LANE__`;
  `apps/tower/test/runner-door.test.ts`, `runner-door-e2e.test.ts`).
- **Debugging it:** `curl http://127.0.0.1:8791/api/runner/scheduled` should
  answer `400 cron_required`; `403 runner_lane_loopback_only` means the mark
  is not reaching the Worker.

- **The scripts go through the door.** A `wrangler … --local --persist-to`
  shell-out starts a second workerd over the same file, so every script that
  needs the store reaches it via `scripts/ingest-door.mjs`;
  `scripts/no-second-runtime.test.mjs` fails on a script that grows the habit.

What to do when one of these checks fails:
[Runtime log lines](../docs/operate/troubleshooting.md#runtime-log-lines).

Standalone has no user login: anyone who can reach the Tower can read and
change its data. Inside the container the Tower listens on the container
interface so Docker can forward the published port; the Compose port binding
keeps the host side on `127.0.0.1`, and the ingest door is never published.
Vite's host check stays enabled (`apps/tower/vite/allowed-hosts.ts`; an
operator-managed alias goes in `TOWER_ALLOWED_HOSTS`) and is not user
authentication.

### Standalone access through an SSH tunnel

Use an operator-managed SSH endpoint with verified host keys and public-key
login whose account permits local forwarding only to the Tower's loopback
port (`NOTICEOS_TOWER_PORT`; 5173 below), as `127.0.0.1:5173`
(`AuthenticationMethods publickey`, `PasswordAuthentication no`,
`KbdInteractiveAuthentication no`, `AllowTcpForwarding local`,
`PermitOpen 127.0.0.1:5173`, `GatewayPorts no`, `MaxSessions 0`); NoticeOS
does not configure the machine's SSH service.

```sh
ssh -NT -o ExitOnForwardFailure=yes -L 127.0.0.1:5173:127.0.0.1:5173 account@os-host
```

Open `http://127.0.0.1:5173` in that client's browser; the local forward must
also bind only to loopback. The disposable proof is an opt-in of
`scripts/runner-database.test.mjs` (`NOTICEOS_TEST_ACCESS_TUNNEL=1` with
`NOTICEOS_TEST_SSH_ROOT`), and it qualifies this recipe only.

## One runner at a time

Two runners is a billing event: both arm the same `triggers.crons` and fire
at `127.0.0.1:8791`, so whichever ingest is bound there runs every schedule
twice. The runner therefore probes the door first and refuses with exit code
**3** (2 is "bad flags") if anything answers, printing
`lsof -nP -iTCP:8791 -sTCP:LISTEN`; the dev server likewise exits if it cannot
bind the door. `os:backup` and `os:run-job` run beside the runner in the same
container and arm nothing. The guard is the bound socket, not a pidfile,
because a socket cannot go stale.

## Cron behavior

- The cron list is read from `workers/ingest/wrangler.jsonc` `triggers.crons`
  once, at startup, from the code the runner runs: a new cron arrives with the
  next `pnpm os:update` (or `pnpm os:restart` when the app runs live source),
  and `pnpm os:run-job -- "<expr>"` fires one by hand meanwhile.
- Default expressions run in UTC; stored overrides can name an IANA timezone
  via [`croner`](https://www.npmjs.com/package/croner).
- On each occurrence the runner fires
  `GET http://127.0.0.1:8791/cdn-cgi/handler/scheduled?cron=<url-encoded-expr>`;
  the door calls the ingest Worker's `runScheduled(cron)` over the Service
  Binding, the same dispatch table as the deployed `scheduled()` handler
  (`workers/ingest/src/dispatch.ts`). A non-200 or fetch failure is an ERROR
  line and never crashes the runner.
- The Tower runs its own steps of the same tick on the hourly fire
  (`apps/tower/worker/tower-cron.ts`); a deployed Tower runs the same function
  from its own cron trigger.
- While the runtime is down a due cron is skipped and recorded; the next
  runner start runs the bounded recovery pass below.

### Bounded catch-up after downtime

The job-run record is the cursor. For each lane the runner compares its latest
recorded firing (any outcome) with the schedule's most recent obligation in
its saved timezone; if the obligation is newer and inside the lane's window,
it fires exactly once (`CRON_CATCHUP_POLICIES` in `scripts/job-runs.mjs`):

| Lane cadence | Recovery window | Behavior |
|---|---:|---|
| 15-minute counters + Google signals | 1 hour | one current refresh, never a tick-by-tick replay |
| Hourly freshness, operator notifications, panel review, push state | 2 hours | one latest reconciliation |
| Daily ingest lanes (including the PostHog archive), panel refresh, backup | 36 hours | one latest daily obligation; trailing-window collectors store an unchanged window as `unchanged` |
| Mediavine (`10,30,50 * * * *`) | 36 hours | checks the cutoff and stored coverage; requests a report only when due |
| Weekly DataForSEO collection | 8 days | one missed weekly collection |

The pass is sequential, cheapest cadence first, so a reboot is not a provider
burst; it holds only the lanes in its own plan and every other lane ticks
normally. A recorded failure counts as a firing. Hub health and the portfolio
snapshot already run at startup and are not replayed. Unknown cron
expressions are excluded (the ingest refuses one as `unknown_cron`, which
`pnpm os:run-job` prints with the expressions it does run). Manual migrations,
seed/config apply, restore, kill-switch, app update, auth/billing/consent,
analytics-pipeline edits, holdout changes and guardrail edits are not
catch-up lanes at all.

> ⚠️ Cron firing only happens while the app container runs. Its
> `restart: unless-stopped` policy brings the runner back after a crash or a
> reboot; a stack stopped with `pnpm os:stop` fires nothing until
> `pnpm os:start`.

## The beads task hub

[beads](https://github.com/steveyegge/beads) (`bd`) is a Dolt-backed task
tracker. The portfolio shares **one Dolt SQL server** — the hub — and every
repo is a **spoke**: a `bd` client in server mode with no database of its own,
which is what makes concurrent writers safe. Tasks are coordination state, not
signals: a second store beside the ledger. The contract — how a project joins,
the spoke config standard, filing conventions — is
[`config/beads.README.md`](../config/beads.README.md); hosting and recovery of
the Compose service are [`db/dolt/host/README.md`](../db/dolt/host/README.md).
In the stack the hub is the `dolt` service, declared to the app in
`/state/task-client.json`; a missing or malformed declaration refuses startup
and backup.

The hub is not the runner's child: it is its own service, so every repository
keeps its tracker while the app is stopped. The runner probes it, backs it up
nightly, and runs these
lanes against it, each a module under `scripts/runner/` with its cadence in
`CONFIG`:

- **The snapshot poller** (every minute, `beadsPollCron`) reads each saved
  project through `bd -C <repo>` and files one `POST /api/beads-snapshot`
  through the ingest door; failure is isolated per project, and it never
  writes a bead.
- **The push-state filer** (`pushStateCron`) files one `push-state,human` bead
  when a project's commits have sat unpushed for `pushStaleHours`, closes it
  when the count returns to zero, and decides nothing on an unreadable state.
  The same tick runs `bd gate check` on every spoke, which is what closes
  `timer` gates.
- **The task-map lane** (`beadsMapCheckCron`) files one `task-map-drift,human`
  bead for a declared database the hub's `SHOW DATABASES` does not hold; a hub
  that will not answer decides nothing.

### The panel-review filer

Hourly (`panelFilerCron`), the runner asks the ingest what landed
(`GET /api/serp-panel-landings`) and, once the property's published panel
`freshness.json` holds that collection day, files one `panel-review` bead in
the property's repo, due seven days later, with `noticeos_panel_asset` /
`noticeos_panel_date` metadata. Identity is (property, collection day),
re-derived every pass from the spoke itself, so there is no state file and no
duplicate; every failure path writes nothing. Closing the bead means the panel
review and an inventory pass over that week's collection
(`config/serp-panel.README.md`).

# Hosted runtime

## Explicit local hosted Tasks entry

`hosted-task-serve.mjs` composes the real Vite/Worker browser entry and the
qualified Node executor in one process, from an operator-prepared, owner-only
runtime file and two explicit Worker configurations:

```sh
node scripts/hosted-task-serve.mjs --runtime-file ABSOLUTE_FILE --worker-config-root ABSOLUTE_DIRECTORY
```

The runtime file follows `HostedTaskRuntimeOptions` in
[`hosted-task-runtime.mts`](hosted-task-runtime.mts): hosted or demo mode, the
identity and directory connections, pinned task and grant-inspection binaries
and a private scratch directory. The qualified transport is loopback HTTP with
native adjacent task clients, not a remote proxy or TLS deployment, with no
host discovery or missing-composition fallback. The Tower-compatible adapter
is [`hosted-tasks-api.mts`](hosted-tasks-api.mts). Answer, Dismiss and
human-gate Approve use the shared `tasks.decide` action, which only current
person owners/operators may use. Every hosted mutation holds a fail-busy
per-workspace advisory lock through task-process retirement.

**Retry-safe writes.** The Tasks API and the MCP task tools
([`hosted-task-mcp.mts`](hosted-task-mcp.mts)) call the same operations
([`hosted-task-operations.mts`](hosted-task-operations.mts)). A create,
update, comment or close may carry an idempotency key (`Idempotency-Key`
header on HTTP, `idempotency_key` argument on MCP): a retry returns the
recorded outcome, other content under the same key answers 409
`idempotency_conflict`, a still-running attempt 409 `operation_pending`.
Receipts live in `noticeos.task_operation_receipts` through the runtime
file's `receiptsConnectionString`, without which a keyed write answers 503
`idempotency_unavailable`.

**One MCP connection.** A hosted or demo deployment answers `POST /api/mcp`
([`hosted-mcp.mts`](hosted-mcp.mts)) with every NoticeOS tool:
`list_workspaces`, the task tools, and the Tower's read-model tools
([`read-model-tools.mts`](read-model-tools.mts)). Every tool but
`list_workspaces` takes a `workspace` argument, checked against the person's
membership and role on each call ([`mcp-protocol.mts`](mcp-protocol.mts) is
the transport).

**Agent sign-in** ([`agent-access.mts`](agent-access.mts)). The MCP endpoint
is an OAuth 2.1 protected resource whose authorization server is
`<origin>/api/auth`: the agent registers dynamically, the person allows it on
the Tower's `/agent-access` page, and a PKCE exchange yields a one-hour access
token and a 30-day refresh token. Scopes `tasks:read`, `tasks:write` and
`evidence:read` map to `tasks.read`, `tasks.write` and `evidence.read`; none
reaches `tasks.decide`, membership or a protected operation, and the person's
role in each workspace bounds the token. Applying `0014_agent_sign_in.sql`
and serving agent sign-in on a public origin are operator steps.

## Hosted runtime composition and recovery

Hosted operation uses explicit server composition; `pnpm start` and the `os:*`
commands remain standalone adapters. The
[portable demo preview](../deploy/demo/README.md) serves compiled assets and
composes the real Worker, task and simulator handles behind an HTTPS proxy.
Neither entry starts a general hosted scheduler. The deployment owns:

| Component | Server-owned composition and lifetime |
| --- | --- |
| Browser and task service | [`startHostedTaskServer`](hosted-task-server.mts); `close()` stops Vite before draining admitted native work and pools. |
| Compiled demo server | [`startHostedDemoServer`](hosted-demo-server.mts) verifies its built artifact inventory and owns Worker, task and simulator lifetimes; [`hosted-demo-setup`](hosted-demo-setup.mts) prepares only new, empty synthetic stores. |
| Scheduled jobs | [`startHostedScheduler`](hosted-scheduler.mts): up to 64 workspace bindings; `close()` stops timers and awaits resource retirement. |
| Persistent demo | [`startHostedDemo`](hosted-demo-runtime.mts): one seeded scenario/workspace, one tick at a time. |

There is no general HTTP provisioning route or environment fallback, and no
`wrangler deploy`, DNS, remote cron or journal-reset command is implied. The
public demo profile and its private simulator are separate handles; the demo
Tower receives `NOTICEOS_DEMO_ACTIVITY_SERVICE_ID` and
`NOTICEOS_DEMO_SCENARIO_HASH` from that composition, never a browser input.
Before starting a prepared composition the operator establishes that
both Worker configurations and the native runtime select the same server
profile and origin (binding names from [`PRODUCT_ENV`](product-env.mts));
that schema and narrow role grants were prepared through the separately
approved maintenance path, with distinct operational, identity,
task-directory and service-grant connections; that task allocations match the
directory and catalog; and that scratch, Worker state and object archives
have explicit deployment custody (physical backups may hold multiple tenants
and cannot become customer downloads). Remote transport, public login and
shared-host backup/restore must be qualified for the exact target before
activation; the [standalone backup procedure](#backups--restore) does not
certify a shared hosted restore.

### Journal inspection and uncertain effects

Workflows exposes the selected workspace's persisted attempts and scheduler
status; a fresh heartbeat means the publisher is current, not that an external
step succeeded, and status older than 45 seconds is stale. The journal records
workspace, lane, occurrence, service, definition/input digests and bounded
output, never raw secrets.

| Recorded state | Meaning and supported response |
| --- | --- |
| `succeeded` | recorded checkpoints are complete; the occurrence does not execute them again |
| `busy` | another live occurrence lease owns dispatch; never invent a different occurrence id |
| `retryable` | the failed step has no uncertain outside effect; the same input may resume within the five-attempt bound; committed checkpoints are not repeated |
| `blocked` | admission refused; restore the approved authority or leave the work blocked |
| `uncertain` | an outside effect or its acknowledgement may have happened; automatic replay is refused |
| `exhausted` | the attempt limit or an unrecoverable state halted work; not a successful skip |

An outside step records its start before dispatch, so an interruption cannot
prove that no effect occurred, and there is no reset, erase or replay command
for uncertain or exhausted occurrences: retain the journal, halt the affected
activity, and obtain a separately reviewed recovery plan. The runner aborts a
step at 30 seconds; demo catch-up is bounded to seven owed dates per tick and
never contacts a real provider.

## Backups & restore

`scripts/host-backup.mjs` owns the operation; `pnpm os:backup` runs it now and
the runner nightly at 04:00 UTC. A run fails if any required store, restore
instruction, local publication, configured offsite handoff or cleanup fails;
one store's failure never prevents attempting the others; a concurrent attempt
fails before copying. [Backup terminology](../CONTEXT.md#backup-evidence)
distinguishes a set, the run, the handoff and restore verification.

- **Postgres:** a custom-format `pg_dump` to
  `.local/backups/<YYYY-MM-DD>/postgres/noticeos.dump`, mode 0600, through
  the declared `<home>/postgres/profile.json` Compose project; it never
  discovers a project, starts a service or applies a migration
  ([profile and restore contract](../db/postgres/host/README.md#backup-and-restore)).
- **R2:** `.wrangler/state/v3/r2/` mirrors into `<date>/r2/`: blobs as plain
  copies, SQLite metadata through `sqlite3`'s online-backup API (opened
  read-write because a WAL database cannot be read without its `-shm` index;
  never `?immutable=1`, which exits 0 on a snapshot missing committed data).
- **Task hub:** every valid database in `installation/task-host.json` goes to
  `<date>/beads/` with `CALL DOLT_BACKUP('sync-url', 'file://…')` against the
  running server, never a file copy of a live server, so it needs the hub up.
  With a Compose `dolt/profile.json`, snapshots go under
  `beads/databases/<database>/` with permissions and recovery credentials in
  `beads/metadata/` and a checksummed `beads/backup.json`.
- **RESTORE.md:** every dated dir carries a generated `RESTORE.md`: what the
  snapshot is, how each store's half went, how to restore each one.
- **Asset databases:** approved `assetBackups` entries run each checkout's
  fingerprinted `backup:prod` task into `<date>/assets/<asset>/*.sql.gz`, and
  Cloudflare D1 targets from **Integrations** export into
  `<date>/cloudflare-d1/<account>/<database>/export.sql.gz`
  ([setup and task contract](../config/host-backup.README.md#asset-production-exports)).
- **Same-day reruns:** only a complete required-store set replaces the dated
  set; the previous set is kept at `.backup-previous-<date>` until the
  replacement succeeds.
- **Offsite:** the finished dir is copied under `<offsiteBackupDir>/<date>/`,
  the folder named in the installation's `host-backup.json`
  ([`config/host-backup.README.md`](../config/host-backup.README.md)); the
  product default names none. A completed handoff proves the local copy, not
  remote synchronization or a restore.
- **Retention:** after a complete run and handoff, rotation applies to whole
  dated sets in both trees; host settings can keep daily and weekly complete
  sets, else the 30-day cutoff applies. Failed stages block rotation.


**Restore drill** — restore a completed set into isolated stores first:
prepare the Postgres roles and an empty owner-owned database, then restore its
dump without applying the migrations first
([Postgres procedure](../db/postgres/host/README.md#backup-and-restore));
restore `<date>/r2/` as a complete tree without stale SQLite sidecars; and
reconcile rows, ledger totals and archive references before enabling the app.
Each store's snapshot is consistent on its own, not as one transaction.
Replacing live stores requires explicit operator approval and a stopped
runner. **Compose task-hub restore** follows
[`db/dolt/host/README.md`](../db/dolt/host/README.md) into a new, empty
project; the helper refuses to overwrite an existing service or volume. A
legacy native hub is restored by putting the backed-up database directory back
under its data dir with the native service stopped under operator approval.

## Merging is not deploying (`os:update`)

A production app runs a prepared image, so a merge to `main` changes nothing
that runs. `pnpm os:update` (`scripts/stack-deploy.mjs`) is the step after a
verified merge:

1. **Prepare**, with services still running: build `main` from the
   allowlisted public source into an image labelled with its revision, source
   manifest and Postgres schema fingerprint, and write a private,
   content-addressed plan beside the selector. If `main` carries a migration
   the database has not applied, it stops here and names `pnpm os:migrate`;
   if `main` changes the Postgres roles, that is operator maintenance.
2. **Confirm**: it prints the plan and applies it after you type `update`.
   Without a terminal it prints `pnpm os:update -- --apply <plan>` instead.
3. **Apply**: recreate only `noticeos`, with no dependency restart, pull or
   migration, and wait up to 90 s for health. A failed wait restores the
   previous image by itself while the stores and mounts still match.

`pnpm os:rollback` is the same flow back to the recorded previous image, and
is refused across a schema change. `pnpm os:status` shows the commit the app
runs and whether `main` is ahead. The full contract, including the image-only
build and recovery journals, is the
[Docker guide](../deploy/compose/README.md#update-the-app-from-main).

`pnpm os:dev` instead runs the app from this checkout's live source, so UI and
Worker edits refresh without an update; `pnpm os:prod` returns to the image it
ran before, and `pnpm os:update` refuses while development is on
([mounted-source development](../deploy/compose/README.md#follow-a-checkout-during-local-development)).

### Agent recovery contract

1. Run `pnpm os:status`. Do not infer health from a listening port. The app
   is `healthy` only when its runner, scheduler, Tower and ingest door all
   pass the container's health check.
2. Run `pnpm os:logs -- --lines 200`; add `-- --follow` only while
   reproducing, and name one service to narrow it.
3. `pnpm os:restart` is safe for ordinary runner/Tower code already authorized
   by the task: it restarts the stack in dependency order, waits for each
   layer's health, and stops at the first failure. Ask the operator first for
   a forever-forbidden surface or a possibly unapplied migration. Merged work
   reaches a production app only through `pnpm os:update`, under the same
   rule.
4. `pnpm os:migrate -- --apply` is never an agent's step. `pnpm os:start`,
   `pnpm os:stop`, `pnpm os:dev`, `pnpm os:prod` and `pnpm os:rollback` are
   operator-directed.

## Notes

- `.local/` (the stack selector, logs, backups, update plans) is runtime state: git-ignored,
  never committed.
- **The root suite never reads the checkout's own `config/`.**
  `pnpm test:scripts` preloads `scripts/script-tests-setup.mjs` into every
    `scripts/*.test.mjs` process, where any read of `config/` is refused; a
  test uses the frozen copies in `scripts/fixture-config/` or a temp repo,
  with the exceptions listed in
  [`test-config-isolation.mts`](test-config-isolation.mts). Run one file with
  the same preload:
  `node --import ./scripts/script-tests-setup.mjs --test scripts/<name>.test.mjs`.
- **No unit test runs a Worker on the checkout's `.dev.vars`.** Wrangler
  reads local secrets from beside the config it is given, so test Workers get
  their configs copied into a new, empty folder
  ([`worker-config-folder.mts`](worker-config-folder.mts)).
- **Every Vite dev server a test starts goes through
  [`test-vite-server.mts`](test-vite-server.mts)**, whose close waits for the
  dependency optimizer; `test-vite-server.test.mjs` fails on a file that
  imports Vite's `createServer` without it.
- **No literal NUL byte in source.** One inside a string makes BSD grep
  classify the file as binary, so a plain `grep -n` finds nothing in it; write
  the escape `\0` (`scripts/grep-visible.test.mjs`).

---

# Database migrations

Postgres is the only operational database.

## Bringing the database up to date (`os:migrate`)

`pnpm os:migrate` (`scripts/os-migrate.mjs`, over the engine in
`scripts/postgres-apply.mjs`) applies `db/postgres/migrations/` to the
installation's own Postgres database. It finds the database itself: the stack
selector `.local/stack.json` (or `--config`) names the Compose files, and the
owner's address is `owner.url` beside the owner's secret file in the stack's
resolved declaration (or in `--secrets <folder>`). It is operator-only;
nothing else ever applies a migration, and neither restart nor update does.
`pnpm os:status` and `pnpm os:update` only read which migrations the database
has, over the Postgres container's own socket, so they need no address.

```sh
pnpm os:status                # what runs, whether main is ahead, whether the database is behind
pnpm os:backup                # a backup you can restore
pnpm os:migrate               # only reads: what is applied, what is pending
pnpm os:migrate -- --apply    # shows the plan, asks for the database's name
pnpm os:update                # then move the app to main
```

The app keeps running while you migrate: migrations are additive unless the
release's own instructions say otherwise
([release policy](../docs/reference/release-policy.md#upgrade-an-existing-installation)).
It runs the development command's own code (`pnpm db:try-migrations`,
development databases only) with the same lock, single transaction and
per-file hashes, refuses a development database, asks for the database's
name, runs as `noticeos_owner` only, and applies only migrations
`db/postgres/frozen-migrations.sha256` lists; nothing at runtime, restart or
update can load it (`scripts/postgres-migrate.test.mjs`).
`pnpm os:migrate -- --bootstrap --slug main --name "My sites"` creates the
installation's one workspace, once. The rest is in
[db/postgres/README.md](../db/postgres/README.md#applying-it-to-an-installations-own-database).

---

# Dev fixtures (`db:seed-demo`)

`pnpm db:seed-demo` (`scripts/db-seed.mjs`) fills a new installation's store
with invented history so a developer sees a populated Tower
([`db/fixtures/dev-seed.json`](../db/fixtures/dev-seed.json)).

```sh
# Terminal 1: a foreground-owned, loopback-only development runtime
pnpm start -- --development --dir .local/development --no-open
# Terminal 2: populate that runtime with synthetic rows
pnpm db:seed-demo -- --dir .local/development
```

The development command needs local PostgreSQL server binaries on PATH: it
creates its own marked native development cluster, applies every frozen
migration and bootstraps one workspace, with no Docker, task hub or provider
lanes. Ctrl-C removes its owned database; the next start creates a fresh one,
so run the seed again.

The seed writes every row in one transaction as the application login and
opens no local store file, so it runs beside a started Tower. It refuses,
writing nothing: a folder `pnpm start` did not make; a database not marked
`noticeos.profile = 'development'` (`pnpm os:migrate` refuses a marked
one: a database is seedable or real, never both); and a store that already
holds data in `pulses`, `flags`, `ledger_entries`, `counter_readings` or
`annotations`, or a site on one of the fixture's ids or domains, because a
seeded row is indistinguishable from a real one.

---

# The ingest in isolation (`pnpm --filter @noticeos/ingest dev`)

That command is `node scripts/ingest-dev.mjs`: the ingest Worker standalone
([`workers/ingest/README.md`](../workers/ingest/README.md#local-development)),
only while nothing holds the store open. **It probes the ingest door (8791),
not the standalone Wrangler port**, because the running OS answers there; with
the door free it execs `wrangler dev --persist-to`, extra flags passed
through, and with the door held it spawns nothing and prints what to stop.

---

# Local secret source

The structured secret source is the installation's private
`workers/ingest/.dev.secrets.json` (`/state/workers/ingest/.dev.secrets.json`
in the app container), edited as formatted JSON; object and array values are
serialized to the string bindings the Worker parses. The runner compiles it
to the generated `.dev.vars` beside it at every start, so after an edit run
`pnpm os:restart`. One key never goes there: `DATABASE_URL`, which the runner
and `pnpm start` hand to the dev server's environment alone
([doc 06](../docs/06-operations.md#bootstrap-secrets-vs-integration-credentials)).
The Import button on a Legacy env card in **Integrations** moves the legacy
bindings into the store once; there is no import command.

# Credentials (`creds:check`)

`pnpm creds:check` proves every credential with one cheap real call and shows
a live data sample, or the provider's actual error plus the likely fix
([doc 14](../docs/14-design.md) flow C); `--help` lists the lanes and the two
probe-on-request lanes.

**It asks the running OS first, and every row says which source answered.** A
store-held credential is proved by `POST /api/integrations/:provider/test`
inside the ingest (`source: store`), an env-held one by the local probe
(`source: env`), and neither prints `not configured yet`. The script never
learns to decrypt (`CREDENTIALS_KEY` does not leave the Worker); with the OS
stopped the run is the env-only check and says so. It never prints secret
values, only slot names, presence and probe samples.

## The slots

**Connect a provider on `/integrations` first.** These are the legacy
bindings, still read and the fallback for installs that have not moved
([doc 06](../docs/06-operations.md#bootstrap-secrets-vs-integration-credentials)
separates them from the bootstrap secrets); **Import from this machine** on
any Legacy env card moves the file across.

| Slot (env var) | Lane | Where to get it |
|---|---|---|
| `CREDENTIALS_KEY` | all provider credentials | `openssl rand -base64 32`; the bootstrap secret every store-held credential is encrypted under |
| `ASSET_TOKENS` | self-report pull and pulse push | JSON map property → that property's `ASSET_TOKEN` ([doc 11](../docs/11-integrations.md#credential-naming--the-asset_token-convention)) |
| `BING_WEBMASTER_API_KEY` | Bing Webmaster | Bing Webmaster Tools → Settings → API access |
| `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` | DataForSEO | `app.dataforseo.com` → API Access: the API login/password, not the account email |
| `GOOGLE_SIGNAL_ACCOUNTS` | GA4 + Search Console | nested object service-account label → `service_account_b64` + `properties` (each with `ga4_property_id`, `gsc_site_url`, optional `time_zone`); grant the service-account email GA4 Viewer and GSC Full-user access. The runner extracts each key to a generated `GOOGLE_SERVICE_ACCOUNT_<ALIAS>` binding at start; do not add those names yourself. |
| `CLARITY_TOKENS` | Microsoft Clarity | JSON map asset → project data-export token (per asset, no portfolio credential) |
| `POSTHOG_KEYS` | PostHog | JSON map asset → personal API key with read access to Query and Project |
| `DISCORD_WEBHOOK_URL` | Discord | Server Settings → Integrations → Webhooks; the URL is the credential |
| `CALENDAR_FEEDS` | Calendar (Wall meetings) | JSON map feed name → secret ICS URL, or `{url, color?, email?}`; the URL is the credential and the probe never prints it |

`time_zone` under a Google property is the IANA zone that defines GA4's
reporting day; omitted, the collector uses the saved `os_time_zone` and says
so once per pull. GSC dates are always Pacific by provider contract.

After probing, `creds:check` may print an exact `pnpm config:apply --stdin`
heredoc recording enrollment proof for `config/integrations.json`; it never
applies anything, only proved properties appear, and a store-proved lane
suggests no cell because a provider-level test proves nothing about which
properties it reaches.

## Rotating `CREDENTIALS_KEY` (`creds:rotate-key`)

```sh
pnpm creds:rotate-key                            # the loopback ingest door
pnpm creds:rotate-key --ingest http://127.0.0.1:8791
```

The sweep runs inside the ingest Worker (`POST /api/credentials/rotate-key`),
re-sealing each connection's current `noticeos.connection_secrets` version
under the new key, because a script decrypting those rows in Node would be a
second place the plaintext exists; this script prints counts and provider ids
and nothing else, and exits non-zero when a row could not be re-sealed. The
full runbook (old key in `CREDENTIALS_KEY_PREVIOUS`, restart, run, remove,
restart) is
[workers/ingest/README.md](../workers/ingest/README.md#rotating-credentials_key).

# The config store (`config:apply`, `config:seed`, `config:export`)

`noticeos.config_documents` holds each whole JSON document keyed by its file
name (`config/tower.json` → `tower`), and `noticeos.config_changes` records
the audit ([Postgres model](../db/postgres/model.json)). **Two folders:**
`config/` holds the product's generic defaults a fresh clone seeds;
`installation/` holds this installation's own documents, applied changesets
and host files, found by [`scripts/installation.mts`](installation.mts)
(`NOTICEOS_INSTALLATION_DIR`, default `./installation`).

| Command | Direction | What it will not do |
|---|---|---|
| `pnpm config:seed` | installation's copy, else the default → store | **Never overwrites.** A document already in the store is skipped and reported at its version; `--force <file> --reason <why>` is the deliberate way past it. |
| `pnpm config:export` | store → `installation/` (never `config/`) | Never commits. It writes the bytes a Save writes, so an unchanged store leaves the checkout byte-identical; `--check` writes nothing and exits non-zero when the files are behind. |
| `pnpm config:apply` | changeset → store → `installation/` | Previews the database's current document, saves through the guarded write API, then exports the acknowledged result. Requires the named documents to be seeded; a stale export never supplies an expectation. `--seed-files` edits offline seed files without the running OS; `--remote` is refused. |

All three reach the store through the loopback ingest door; an unavailable
store fails the read and is never treated as unseeded. Document and
asset-column changes use separate changesets because their write paths cannot
commit together ([changeset contract](../config/changesets/README.md#applying)).

# Raw provider signal archive (`signals:*`)

The daily `15 12 * * *` ingest lane keeps analysis-grade GA4/GSC/BWT provider
responses outside Postgres, `30 12 * * *` does the same for PostHog, and the
weekly `45 12 * * 1` lane for DataForSEO. Wrangler's `RAW_SIGNALS` binding is
local by default. Every command here reads and writes through the running
installation's ingest door (`scripts/ingest-door.mjs`); none opens a database
connection or a second Worker, and `--remote` is refused. For a prepared
container, use the
[container operator commands](../deploy/compose/README.md#download-and-publish-stored-signal-reports).

Collect and read back one property's local archive:

```bash
pnpm os:run-job -- "15 12 * * *"                               # or "45 12 * * 1" for the weekly lane
pnpm signals:download -- --asset example.com                   # --integration / --report / --from / --to filter
pnpm signals:history -- --asset example.com --in .local/signal-dumps/downloads/example.com --out .local/signal-dumps/history/example.com
pnpm signals:analyze-history -- --asset example.com --history .local/signal-dumps/history/example.com --out .local/signal-dumps/reports/example.com
pnpm signals:publish-insights -- --asset example.com --file .local/signal-dumps/reports/example.com/executive.json
```

`signals:download` asks the report runs for the newest successful immutable
object per provider/report/date and writes
`.local/signal-dumps/downloads/<asset>/<integration>/<report>/<date>.json`
plus a `manifest.json` that keeps every report day an earlier download or
`signals:refresh` recorded, so a filtered run never forgets a later
collection.

`signals:history` publishes that downloads folder as Parquet files DuckDB
reads, one dataset per report family (`scripts/signal-archive.mjs` decides
what an archive means as rows and which row is kept when several describe one
day), each row naming its source archive. Readers see only complete
generations; a run over an unchanged archive writes nothing; the history keeps
every generation published in the last 30 days and the newest
(`KEEP_GENERATIONS_DAYS` in `scripts/history-files.mjs`). To read a
generation, take the highest-numbered manifest under `generations/` and give
DuckDB the files it lists, never a glob of `data/`.

`signals:analyze-history` reads one generation into one CSV per report
family, `executive.json`, `summary.json` and `report.json`, bounded in a
child process (`--memory-mb`, `--duckdb-memory-mb`, `--temp-disk-mb`,
`--time-limit-seconds`) and published by swapping the `--out` link in one
rename. It reads value-event declarations from the running service's
configuration store and refuses a generation whose files changed, that other
archive rules wrote, or that the history no longer keeps. Missing provider
rows stay missing and an empty cell is unknown, never `0` or `false`; serp
panel rows are one per tracked term **per `device`**, so filter to one device
before counting. Column semantics are in the comments of
`scripts/signal-archive.mjs`.

`signals:publish-insights` POSTs the snapshot to `POST /api/insight-snapshot`;
publishing is content-addressed (`insight:<asset>:<first 24 hex of the
SHA-256>`), so an identical rerun inserts nothing twice. The raw archive and
CSVs stay local.

## Collect one property now (`signals:collect`)

`pnpm os:run-job -- "45 12 * * 1"` fires the whole weekly lane for every
property; a baseline for one property on its launch day is collected at its
own price:

```bash
pnpm signals:collect -- --asset example.com --families serp-panel
pnpm signals:collect -- --asset example.com                               # every family it is due
pnpm signals:collect -- --asset example.com --families 'posthog-*'        # PostHog, through the daily collector
pnpm signals:collect -- --asset example.com --families posthog --start 2026-09-08 --end 2026-09-22
```

It spends money and says how much; a run with any failed family exits
non-zero. It collects nothing itself: the request goes to
`POST /api/signal-collect` and the ingest runs the same collector the cron
runs, scoped to one property, so there is no second collector to drift. A
property the lane does not collect, or a family it is not due, comes back as
a `422`, never as a $0.00 success; re-firing the same day stores identical
content as `unchanged`. `--start`/`--end` pin one window of at most 28 days
for PostHog families; one run is one provider.

## The standing panel refresh (`signals:refresh`)

The commands above are the hand path. `signal-panels-refresh.mjs` refreshes
the files on a schedule (the `panel-refresh` job in
`scripts/scheduled-jobs.mts`, `10 13 * * *` UTC by default, a runner lane
because a Worker cannot write this machine's disk) and publishes each
completed analysis to the Tower. Publication is advisory: it never creates
tasks, dismisses findings or executes changes.

```bash
pnpm signals:refresh                        # every property in the roster
pnpm signals:refresh -- --asset example.com # one property, roster flag ignored
pnpm signals:refresh -- --all               # including the deliberately disabled
pnpm signals:refresh -- --no-publish        # local preview; Tower advice unchanged
```

Each pass reads its roster, history window and freshness setting from the
stored `config/signal-panels.json` document through the running ingest, never
a checkout export. Each enabled property downloads only missing archives,
publishes its Parquet history, then analyzes that generation in the bounded
child. The reports publish together with `signal-trend-daily.csv` — the
normalized daily site-level series, the only file in the panel dir that can be
summed — and `freshness.json`, which grades each integration's newest report
day against `refresh.freshnessMaxAgeDays` (no source grades as not fresh;
families no cron produces, `UNCOLLECTED_FAMILIES`, are graded separately in
`uncollected[]`). The completed report directory is a symlink to an immutable
generation under `<asset>.reports/`, so interruption leaves the previous
report visible; one asset's failure does not stop the others. It costs
nothing: zero provider calls. What a property repo may conclude from the panel
dir is [doc 20](../docs/20-signal-panels.md).

## The executive rules

The rules live in `scripts/signal-insights.mjs`: each reads named report
families and emits at most one card, the page sorts `warning →
recommendation → discovery → insight` and keeps the first eight, and cards
past the cut are listed in `executive.json`'s `suppressedItems` rather than
discarded. Every card names its rule in a `rule: <id>` evidence row; a rule
whose family is absent emits nothing. Each rule's condition, thresholds and
what to do about it are stated beside its definition in that file
([doc 13](../docs/13-opportunity-scouting.md)). One rule,
`reclamation-match`, has an input outside the archives: the property's open
outreach targets, exported with
`pnpm reclamation:open-targets -- --asset example.com` to
`.local/reclamation/<asset>-open.json` and passed to
`signals:analyze-history` as `--reclamation-targets`; without it the rule is
silent.

---

# `signals:event-params` — ad-hoc GA4 event-parameter report

The manual companion to the daily GA4 lane, for event parameters the archive
does not export: one read-only Data API call on the same service-account path
as `creds:check`, nothing written.

```bash
pnpm signals:event-params -- --asset example.com                  # js_error message/source, last 3 days
pnpm signals:event-params -- --asset example.com --days 7 --page  # add the page dimension
pnpm signals:event-params -- --asset example.org --event cta_click --dims label,location
```

Each parameter must be registered as an event-scoped custom dimension in GA4
admin first; values are `(not set)` for events collected before registration.

# `bing-ai:import` — a downloaded Bing AI Performance export becomes evidence

Bing's AI Performance report exists only behind the dashboard's Export
button, so this lane starts with a human downloading a file:

```bash
pnpm bing-ai:import ~/Downloads/example.com_AISearchQueriesReport_8_4_2026.csv
```

The format is decided by the header row against three pinned shapes
(`workers/ingest/src/bing-ai-exports.ts`); the property and export date are
read off Bing's own filename, and a renamed file is refused with the two flags
that fix it. The bytes go through `POST /api/bing-ai-export` into the house
archive (integration `bing-webmaster`, report `ai-overview` / `ai-queries` /
`ai-pages`), carrying the original file byte-identical beside the parse;
re-importing the same export answers `unchanged`.

# `reclamation-import.mjs` — load an outreach campaign into the store

Loads a campaign's static target CSV into the store's link-outreach targets:
the touch log that makes the no-double-pitch rule enforceable.

```bash
pnpm reclamation:import -- --asset example.com --csv <targets.csv> --dry-run
pnpm reclamation:import -- --asset example.com --csv <targets.csv>
```

The header must be exactly
`tier,segment,domain,referring_page,links_to_dead,replace_with,contact,notes`.
The list goes to `POST /api/reclamation-targets` in one transaction. It is
idempotent: a page is stored once, keyed on site, domain and page, and a
status only moves forward in the funnel, never touching a terminal `won` /
`skip` / `dead` a person set. A trailing `SKIP` line imports as one `skip` row
per slash-separated domain. Campaign state that predates the table lives in
the installation's `reclamation-overlay.json` (`--no-overlay` imports the list
alone); an overlay entry matching no row, or more than one, throws. There is
no `bounced` status: a hard bounce stays `sent` with the bounce in
`outcome_note`.

---

# `audit:wall-fit` — does the Wall still fit the TV?

The Wall's contract is that it fits a 1920×1080 CSS viewport: the kiosk has
nobody at it to scroll. That contract breaks on data growth alone, so this
measures the fit instead of waiting for the television to report it.

```bash
pnpm audit:wall-fit                                  # 1920×1080 against the local Tower
pnpm audit:wall-fit -- --samples 6                   # late data lands; take more frames, the worst wins
pnpm audit:wall-fit -- --strict --viewports laptops  # the screens that draw the TV's layout scaled
pnpm audit:wall-fit -- --help
```

Exit `0` fits, `1` content spills past the viewport, `2` it could not be
measured. It needs a running Tower and a launchable testing browser, so it is
an operator/agent tool, not part of `pnpm test`; the measurement itself,
`measureWallFit` in [`wall-fit-measure.mts`](wall-fit-measure.mts), is what
the Wall journeys in `apps/tower/e2e/journeys.spec.ts` run against the
isolated fixture Wall in `pnpm test:journeys`, so a Wall that stops fitting
fails CI.

It ignores the document's scroll size, because `.wall-root` clips to
`100vh/overflow:hidden` and would report a perfect fit however far content
spills; it measures content instead (element boxes, text runs via
`Range.getClientRects()`, `.wall-root`'s own scroll size, and overflow on
descendants), and overflow an inner box genuinely clips is not a leak.
`--strict` also fails on unclipped overflow inside the viewport and on text an
inner clip cuts off sideways. The first sample is routinely shorter than the
rest, so read the spread, not one frame. Chrome cannot start inside the Claude
Code Bash sandbox; run it with the sandbox disabled.

# `audit:surfaces` — does a desk surface still meet doc 14?

[doc 14](../docs/14-design.md)'s acceptance list is a list of measurements —
the first screen answers the surface's question without scrolling, no
paragraph past one sentence outside `About`, no owner chip or config path on
a view surface, every number that can have a series shows one, the 44px floor
holds at 390 — and `pnpm audit:surfaces` measures them against the live Tower
at 1440×900 and 390×844 (`--help` for routes, `--asset`, `--strict`,
`--json`). Exit `0` every route meets doc 14, `1` offenders named per route,
`2` it could not be measured; like `audit:wall-fit` it needs a running Tower and a
browser, is not part of `pnpm test`, and is read-only. The page does no
judging: `collectSurface` returns plain descriptors and every rule runs in
node over them, which is what lets `surface-audit.test.mjs` drive the same
functions. The rules, the `data-*` attributes a surface must carry to be
measurable (`data-surface-hero`, `data-kpi`, `data-composition`,
`data-audit-ignore`, …) and the readiness logic are documented in
`scripts/surface-audit.mjs`. An agent measuring its own branch cannot use the
operator's Tower on 5173: start a second Tower against a copy of the store
with `OS_UP_PERSIST_STATE` (the copy), `OS_UP_INGEST_DOOR_PORT` (a free port,
never 8791) and `MINIFLARE_REGISTRY_PATH` (its own dev registry, so it never
overwrites the live Tower's registration), and pass its `--url`.

# UX text report — how much reading each screen asks for

`pnpm audit:copy` (`scripts/ux-gate.mjs`) extracts every string the Tower can
show a person — `apps/tower/{src,shared,worker}` plus every module and config
document those import, and the ingest Worker behind the service binding —
counts the words in each, and lists the long ones, longest first. "Long" is
above the thresholds in `scripts/ux-gate.settings.json` (labels 12 words,
failures 18, accessible names 24), which also names the few files that are
not desk copy. The thresholds are a reading aid, not a rule: the report always
exits 0. The reader (`extractVisibleStrings`) is shared with
`scripts/ui-lexicon.test.mjs`, which does fail on system jargon.

```sh
pnpm audit:copy                 # every long string the Tower renders
pnpm audit:copy -- --summary    # per-file counts only
pnpm audit:copy -- --files apps/tower/src/routes/HealthRoute.tsx
pnpm audit:copy -- --json       # machine-readable
```

# UX flow walker — what each operator flow costs

`pnpm audit:flows` (`apps/tower/e2e/flow-gate.mjs`, the end of
`pnpm test:journeys` and CI's `flow-gate` job) drives every operator flow
declared in `apps/tower/e2e/ux-flows.mjs` in a real browser, at desktop and
phone, on isolated fixture servers, and reports what each flow costs
(actions, screens, page changes, explanatory words, empty steps, repeated
checks) to `apps/tower/e2e/ux-flows-results/results.json`. The counts are a
design-review input, not a budget: the run fails only when a flow cannot be
walked to its end, when a page leaves the isolated fixture, or when the probes
in `ux-walk.mjs` stop seeing what they are built to see. A changed flow
changes its script in the same commit.

```sh
pnpm audit:flows                                  # walk every flow
pnpm audit:flows -- --flows connect-bing,inbox    # just these
pnpm audit:flows -- --viewports phone             # one viewport
pnpm audit:flows -- --json                        # machine-readable
```

# The pre-commit hook

The root `prepare` script (`scripts/install-git-hooks.mjs`) runs on every
`pnpm install` and points `core.hooksPath` at `.githooks/`, whose `pre-commit`
runs the neutral-code gate below on staged files. It does nothing in CI, in a
checkout that is not a git work tree, or when `core.hooksPath` already points
somewhere else (it says so and leaves that alone). A pre-existing
`.git/hooks/pre-commit` is chained, not lost.

# Neutral-code gate — product code names no installation's own sites

A stranger's installation must not carry somebody else's sites or behave
differently because of them. `scripts/neutral-code-gate.mjs` fails when
product source, a product default in `config/`, or a document that ships with
the product names one of this installation's own asset ids, domains, site
display names or Google accounts, or any time zone.

**The list comes from the installation, never from the gate.** It is read
from the documents `pnpm config:export` writes into the installation folder
(every register in `scripts/config-registers.mjs` keyed by an asset id or a
domain), from the `neutral-names.json` inventory there, and from the Google
account each source's `ref` in `integrations.json` routes through.
`pnpm check:neutral -- --names` prints the list and where each name was read.

**What it reads.** Product source (`apps/tower/{src,shared,worker,vite}`,
`workers/ingest/src`, `packages/contract/src`), the product defaults in
`config/` and the prose beside them, `scripts/` (a generated `.mjs` is judged
as its authored `.mts`), every operator document that ships (`docs/**/*.md`,
the READMEs, `CONTEXT.md`) except the dated records in `docs/reports/` and
`docs/artifacts/`, and the test code, judged for names
only. `-- --files <paths>` judges each named file by the rule it falls under.

**How a name matches.** A domain, an asset id or an account matches wherever
it is not part of a longer word, including inside a URL or a path segment; a
display name matches as a whole word; the OS asset's dot-less id matches only
where it stands alone, never as the product's namespace. **Time zones:** any
IANA zone except UTC fails in product code; the installation's clock is the
saved `os_time_zone`, and the one place a zone may be named is a provider's
documented reporting zone, `reportingTimeZones` in
`packages/contract/src/integrations.ts`.

| When | How |
|---|---|
| Commit | `.githooks/pre-commit` → `node scripts/neutral-code-gate.mjs --staged` (a staged config document or migration rechecks every product and test file) |
| CI | `scripts/neutral-code-gate.test.mjs` in `pnpm test:scripts`: zero offenders on the checkout, and planted names fail |
| By hand | `pnpm check:neutral`, or `-- --files <paths>` |

There is no baseline and no allowance file: a name that must appear is read
from the store with a generic default.

## One bounded local demo replay

`scripts/demo-replay.mjs` serves one completed synthetic installation while it
makes one explicit new-generation attempt. Both installations must use the
same verified public release; it never retries, adopts an interrupted
attempt, or resets an existing database. Name an absent next folder and
control folder, an exact release and task executable, seed/cutoff, and
distinct loopback ports:

```sh
node scripts/demo-replay.mjs --current-dir /absolute/completed-demo \
  --next-dir /absolute/new-demo --control-dir /absolute/new-replay-custody \
  --release <exact-commit> --bd-bin /absolute/qualified-bd \
  --port 6400 --current-port 6402 --next-port 6404 --seed-port 6410 \
  --seed local-example --cutoff 2026-09-30T00:00:00.000Z
```

Each reader reserves its next port; the seed port reserves its next three.
The gateway binds only `127.0.0.1`. A visit lasts at most fifteen minutes;
expired APIs return 410 and an expired page offers **Open current demo**. The
launcher lasts at most twelve hours (`--duration-ms` may shorten it), with one
generation attempt limited to ten minutes. A failed candidate keeps the
current generation; uncertain retirement stops the launcher and retains
custody. No cloud publication, live installation, provider or scheduler is
used.
