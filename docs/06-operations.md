# 06 — Operations & self-observability

*NoticeOS is itself one of the assets it monitors, and it is held to every
standard it applies to the others. This doc describes the routine mechanisms
that automation depends on: NoticeOS's own report, its spend meter, its kill
switch and its plan for vendor failures.*

## The NoticeOS report

NoticeOS sends the same nightly report as every other asset, under the same
contract ([doc 02](02-signal-contract.md)):

- **Ingest freshness** per asset per data source (the asset's report, GSC, GA4,
  revenue): a scheduled push that stops without an error becomes an `error` flag
  **within two nightly cycles**, so it is found in two days rather than three
  weeks later. Two cycles rather than one is deliberate: a single late night (a
  retried collector, a provider that published at noon) would raise an error
  that resolves itself by morning, and an operator who keeps seeing errors that
  clear by themselves starts ignoring the flag. The age is
  `REPORT_MAX_AGE_HOURS` — 48h, `REPORT_CADENCE_HOURS × REPORT_STALE_MULTIPLIER`
  in [`packages/contract/src/reporting.ts`](../packages/contract/src/reporting.ts)
  — and both places read this one number: the hourly `ingest-freshness`
  cron raises its error past that age and the Tower counts the property stale
  past the same age, so one payload never contains an open error and a "fresh"
  count for the same property. To flag a stopped data source sooner, change the
  constant, not this document. An asset whose Settings declare that it sends no
  nightly report (`config/constants.json` `no_nightly_report`) is not expected
  to send one: `owesNightlyReport` in the same file leaves it out of both
  counts, it is never flagged, a flag still open for it is resolved on the next
  hourly run, and its card shows a neutral "No report".
- **Spend**: inference + API dollars per stage (Sense/Attribute/Decide/Act),
  per asset, vs budget; cost-per-landed-change trailing 30d. *Today only the
  API half is metered — see Budget enforcement below.*
- **Throughput & quality**: hypothesis cards ranked, changes shipped by tier,
  accept rate, reliability-ledger movements, open deferrals, audit findings.
- **Cron/system health**: run successes, retries, queue depth, store size.

The Tower shows NoticeOS's own health first. If NoticeOS is unhealthy, none of
the other data it displays can be relied on.

## Running the installation

NoticeOS runs as one Docker Compose stack of four services: `noticeos` (the
app: Tower, ingest and the runner), `postgres`, `dolt` and an optional
`backup` worker ([Docker guide](../deploy/compose/README.md)). A development
stack's app runs a checkout's live source; a production stack's app runs a
prepared image. Running the runner directly on a host is not supported.
`.local/stack.json` selects the stack, and agents and operators use one set of
commands defined in this repository. An installation set up with Docker alone
has no checkout: its folder holds the selector (`stack.json`), a copy of the
stack definition and the `noticeos` launcher, which runs each command below
from the app's image as `<folder>/noticeos <command>`, with no `--`
([Install with Docker](start/install-with-docker.md)).

| Question / action | Command | Contract |
|---|---|---|
| Is the OS healthy? | `pnpm os:status` | Each service's Docker state and health, whether the database has every migration this code carries, the app's commit, whether `main` is ahead, and any service that does not run as `installation.env` declares. An open port alone does not count as healthy. |
| What just happened? | `pnpm os:logs -- --lines 200` | Recent logs from every service, or `-- <service>`; `-- --follow` keeps printing new lines while you reproduce a problem. |
| How big is the store, and how fast is it growing? | `pnpm os:capacity` | Rows, bytes and daily growth per table, insight snapshots, the raw archive and scheduled-job durations, read from the running OS; metadata only ([doc 26](26-storage-capacity.md)). `-- --json` prints the raw result. |
| Recover the app | `pnpm os:restart` | Restarts the stack in dependency order, waiting for each layer's health; a failed step stops the sequence. |
| Apply an edit to `installation.env` | `pnpm os:apply` | Shows each change and the services it recreates, and applies it after you type `apply`: only those services, databases first, each waiting for health. If a service does not become healthy, the command returns the stack to the settings it last ran healthy with. It never points a database at other data, renames the project, builds or pulls an image, or applies a migration. |
| Put merged work live | `pnpm os:update` | Takes the image CI published for `main`'s commit when it was built from exactly this checkout's source, or builds it here when none is published, shows the plan and applies it after you type `update`, replacing only the app container and rolling back automatically if the app does not become healthy again; `pnpm os:rollback` returns to the previous image. Without a checkout, `noticeos update` moves the image and the stack definition copied out of it together to main's newest published version, recreating each service whose declaration changed; `noticeos rollback` returns to the version before. |

**Merging is not deploying.** A production app runs a fixed image that a merge
never changes. `pnpm os:update` is the step after a verified merge: it stops
and prints `pnpm os:migrate` when `main` contains a migration the database has
not applied, and leaves a change to the Postgres roles to the operator as
maintenance. Only the app container changes; the databases, the backup worker
and the installation's state mount stay in place. How it works is in
[`scripts/README.md`](../scripts/README.md#merging-is-not-deploying-osupdate).

The app container is healthy when the runner reports itself healthy, with its
heartbeat (a regular signal that the runner is still running) at most 60
seconds old, its Tower ready and its scheduler armed; a configured backup
worker responds; and the Tower and the ingest endpoint both respond inside the
container. Output written to disk has common credential formats removed before
it is written, and the commands remove them again when reading. Log lines are
capped at 64 KiB; the runner log rotates at 5 MiB with five historical files;
scheduled-job JSONL logs keep 30 days.

Status, logs and capacity are read-only. A routine restart or update after
authorized ordinary runner/Tower work is within that work's scope. Operator
approval is required before restarting or updating when a pending change
affects auth, billing, security headers, DB migrations, consent,
analytics/tracking, holdouts, or guardrail thresholds.

Startup, restart, apply and update never apply a migration. Postgres is the only
operational store; applying a migration is operator-only:

1. `pnpm os:status`: what runs, whether `main` is ahead, whether the database
   is behind.
2. `pnpm os:backup`: a backup you can restore.
3. `pnpm os:migrate`, then `pnpm os:migrate -- --apply`
   ([`db/postgres/README.md`](../db/postgres/README.md#applying-it-to-an-installations-own-database)).
4. `pnpm os:update`.

The app keeps running during step 3: migrations are additive unless the
release's own instructions say otherwise
([release policy](reference/release-policy.md#upgrade-an-existing-installation)).

For a provably new, empty installation only, `pnpm os:setup` may create its
data volumes, apply the committed frozen schema and bootstrap one workspace
([approved exception](../AGENTS.md#hard-invariants)). Existing installations
and production remain operator-only. The checks and steps are in the
[Docker guide](../deploy/compose/README.md).

Downtime recovery is bounded and based on the 30-day job-run record. Startup
runs at most the latest missed run of each allowlisted scheduled job, one at a
time: 15-minute jobs within one hour, hourly jobs within two hours, daily jobs
within 36 hours, and the weekly DataForSEO collection within eight days. It
never re-runs every missed run, and it runs the shortest-interval jobs first so
the 15-minute Wall jobs never wait behind the weekly collection. Only the jobs
in the catch-up plan have their regular runs paused, each until its catch-up
run finishes; every other job keeps running on its normal schedule, and the
log records when the catch-up pass is done. A recorded failure counts as an
attempt rather than causing a restart loop. The task database health check and
the task snapshot already run at startup and are not re-run. Unknown cron
expressions are excluded, and the Worker rejects one anyway (`unknown_cron`,
running nothing). Migrations, restore, seed/config apply, app updates,
kill-switch work, and every surface that is permanently operator-only are not
catch-up jobs. The catch-up pass runs only already-approved collection
definitions; it cannot edit the measurement channel.

## Budget enforcement (hard caps; alerts are not enforcement)

**What is in force today.** One cap, and it is enforced:
`config/constants.json` `monthly_caps.data_usd` — $25/mo of metered data spend,
reserved before every paid DataForSEO read and failing closed. There is **no
model gateway and no inference cap**, because no process in this repo calls a
model: the analyzer is rule-based, and every model call happens in an agent
session billed outside the OS, so no settings page shows an inference cap for
spending that nothing measures. Everything below is the design that takes
effect **when the OS makes its first model call of its own** — it is a
specification, not a description of the running system.

All model/API traffic flows through a gateway with **dollar-denominated,
fail-closed limits** (Cloudflare AI Gateway-class, fitting the existing stack;
LiteLLM-class proxy equivalent):

- Per-run cap (default modest; sized per change-class), per-day cap per stage,
  portfolio monthly cap. When a cap is exceeded, the gateway blocks the call or
  falls back to a cheaper model, so the system keeps running at reduced
  capability instead of stopping.
- **Spend-velocity circuit breaker** independent of totals ($/min beyond N×
  the planned rate trips it before the daily cap would; with alerts alone, a
  loop that keeps calling can run for days).
- Loop detectors: identical-call dedup, A↔B round-trip counters,
  recursion-depth caps, error-streak halts.
- **The kill switch must also stop work at the provider**: cancelling
  provider-side runs is part of the switch, because a provider keeps billing
  after the local process exits.
- Caps exist per credential, so spending on a leaked key is limited before
  anyone notices the leak.

## The kill switch

**Required before automated asset execution; not built in the first
release.** Asset agent execution remains manual; operators stop their
external agents directly. Pausing NoticeOS's collection schedules does not
pause an agent.

The future operating contract requires one documented, rehearsed action to
stop the system: disable all NoticeOS crons
+ revoke the GitHub App installation token + disable the gateway keys. Target:
executable in under two minutes from a phone; **drilled quarterly** (the drill
is a scheduled task in NoticeOS's own task list, and the drill result is a
metric in NoticeOS's own report). Partial switches per stage (pause Act, keep
Sense) allow smaller interventions.

## Secrets & access

- The GitHub App private key: rotation cadence (quarterly), storage (CF
  secrets, never in repos), break-glass procedure written next to the key's
  location, scope audit at each rotation.
- Portfolio API credentials (Google signal service-account keys for GSC/GA4,
  DataForSEO, ad networks, affiliate networks): per-vendor rotation notes and
  expiry/revocation alarms (a disabled Google key stops Sense collection
  without raising an error; the ingest freshness check catches it).
- Least privilege: if the OS org is compromised, the exposure is limited to
  the App key and read credentials; asset production secrets are never stored
  in NoticeOS.

### Bootstrap secrets vs. integration credentials

*This section is the one place that defines the split, and other docs link
here: four bootstrap secrets stay in the environment, and every other
credential is stored in the product.*

**Four secrets stay in the environment permanently.** The OS needs them to
start, so the product cannot store them: a credential that can only be read
once the OS is running cannot be the credential that starts it:

| Secret | What it bootstraps |
|---|---|
| `CREDENTIALS_KEY` | the key every stored provider credential is encrypted under (`openssl rand -base64 32`). The store cannot hold its own encryption key. |
| `OPERATOR_TOKEN` | the bearer token the runner and the operator's own scripts present to the ingest's write routes. It authorizes the same process that would have to read it from the store. |
| `ASSET_TOKENS` | one token per asset, checked on an inbound report and presented on the outbound pull ([doc 11](11-integrations.md#credential-naming--the-asset_token-convention)). It is the OS's own shared secret with each asset, not a third-party account. |
| `DATABASE_URL` | the address of the installation's own Postgres: the application login's connection string, `postgresql://noticeos_app:<password>@127.0.0.1:5432/noticeos?sslmode=disable` ([db/postgres/host](../db/postgres/host/README.md) sets one up). The store cannot hold its own address. |

**Where they are kept.** Locally, all four are in the installation's secrets
file, `workers/ingest/.dev.secrets.json`: under the stack's state mount
(`/state/workers/ingest/.dev.secrets.json` in the app container), which
`pnpm os:setup` writes. The first three reach the
Workers as bindings (compiled into `.dev.vars`). `DATABASE_URL` never does: the
runner reads it at every start, checks it as the application
login, and passes it to the dev server's environment and nowhere else, as the
POSTGRES binding's local address
(`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_POSTGRES`,
[`scripts/database-address.mts`](../scripts/database-address.mts)).
`pnpm os:status` reads the stack's application address from its Postgres secrets
folder, only to read the database's migration record, and prints no part of
it. `pnpm os:setup` takes the application address from the new
installation's `postgres-secrets/`. A missing
or unusable address, or a database behind the code, stops the start with a
one-sentence message that names the file and does not print the address; only
`pnpm os:setup`, on a new, empty installation, applies schema. Deployed on
Cloudflare, the address is stored in the Hyperdrive configuration, not as a
Worker secret.

**Every third-party provider credential is connected in the product.** Google
Analytics / Search Console, Bing Webmaster, DataForSEO, calendar feeds, and
whatever [doc 11](11-integrations.md#the-catalog) adds: connected, tested and
disconnected on the Tower's **`/integrations`** page, stored AES-GCM-encrypted
in `noticeos.connection_secrets`, with the connection's public facts in
`noticeos.integration_connections`. A Save inserts the next secret version and
removes the previous version in one transaction, without rewriting ciphertext
([Postgres model](../db/postgres/README.md#the-decided-model)). Every collector
reads the store first.

**Env bindings remain the legacy fallback for existing installs.** A provider
with no stored row falls back entirely to its binding and keeps working — the
card shows a neutral *Legacy env* chip and an **Import from this machine**
button, which moves the whole secrets file into the store in one click; there
is no import command. At startup, the runner logs one line naming each
provider still on env, and `/health` reports the same in one line. The
fallback is not deprecated and nothing requires the move; its cost is
portability, because a fresh install would need those secrets copied by hand.

#### The legacy local source

Locally, an operator who has not moved to stored credentials edits the
formatted, private `workers/ingest/.dev.secrets.json`. Nested maps such as
`GOOGLE_SIGNAL_ACCOUNTS` remain real JSON instead of minified dotenv strings.
The runner compiles that source to `.dev.vars` at every start, so an edit
takes effect with `pnpm os:restart`.
Google's property routing remains in `GOOGLE_SIGNAL_ACCOUNTS`, while each
encoded service-account key is extracted to its own bounded
`GOOGLE_SERVICE_ACCOUNT_*` binding. This keeps the readable account-centric
source without exceeding a Worker text-binding limit. The generated file is
derived output, not a second place to edit. Deployed Workers receive the
routing map and per-account credentials as separate encrypted string secrets.

## Vendor failure & degradation policy

For each signal source, the written policy is to **skip the missing data and
never estimate it**:

| Source | On failure | Never |
|---|---|---|
| DataForSEO | skip cycle, mark panel gap, retry next cadence | interpolate positions |
| GSC/GA4 | mark unfinalized/missing; suppress dependent flags | alert on partial windows |
| Bing Webmaster | retain the last-good series, mark the source degraded, retry next daily cadence | convert an unreported lagging date into zero traffic |
| Ad/affiliate reporting | retain provider-reported estimates with an explicit estimated status; book payments on reconciliation ([Mediavine](11-integrations.md#mediavine-revenue)) | invent revenue or label an estimate reconciled |
| Model provider | gateway fallback chain; if none, pause Act | swap models without recording an annotation |

Vendor pricing/policy changes (model prices, API terms, network thresholds,
crawler policies) are `external` annotations — they change ledgers and
baselines and must be visible on every affected timeline.

The implemented Google and Bing collectors record every attempt in
`signal_runs`, isolate provider/property failures, retain the last successful
observations, and show the effective source state on each property card.
GA4/GSC run every 15 minutes and degrade after two missed cadences (30
minutes). Bing Webmaster's rank-and-traffic dataset updates daily, so it runs
at 02:30 UTC and degrades after two missed daily cadences (48 hours); polling
it every 15 minutes would not make the provider data fresher. The broader flag
and notification job for NoticeOS's own report is still outstanding. GA4 marks
only today provisional in the chart. GSC also treats today as provisional when
response metadata is absent and moves the boundary earlier when the provider
supplies `first_incomplete_date`. Bing is final through the last date it
returns, and the chart adds no zero values after that date. Dependent anomaly
rules must ignore incomplete or absent dates.

GA4's current display data is fetched on demand, not by another cron or
measurement-history collection. An open Home/Wall requests data from the Tower
every 30 seconds; Tower calls ingest over a private Service Binding, and
ingest concurrently makes two `runRealtimeReport` requests/property — both
trailing 30- and 5-minute ranges, and the per-minute rows for the Wall's
per-minute bar chart (`MinutePulse`) — shared by every display for one minute,
plus one bounded Core hourly report for today and seven days ago. It reuses a
short-lived read-only Google access token but stores nothing.
The current-day line stops after GA4's newest reported hour; unreported future
hours are null rather than zero, while the same-weekday reference line covers
its complete day. These reads are isolated from `/api/wall`: a timeout, quota
failure, or invalid response leaves the rest of the card available, shows no
zero in place of missing data, and lets the client keep showing its last good
values, labelled “Reconnecting.”
The response requests property-quota telemetry so a future cadence change can
be based on observed token consumption.

The analysis-grade provider collections run separately from those live chart
collectors. They write bounded daily GA4/GSC/BWT and weekly DataForSEO gzip
JSON to the private/local `RAW_SIGNALS` R2 binding and append-only attempt
manifests to `archive_runs`. Google re-fetches the previous four completed
dates; BWT retains one current provider snapshot for each of six report
families; DataForSEO retains ranked-keyword, backlink, and Google/ChatGPT
mention snapshots and exact metered cost.
Identical content references the existing immutable object. A report failure
never deletes a prior dump and never turns an absent provider row into zero. Locally, Wrangler
persists local R2 under `.wrangler/state`; remote access and provisioning
are explicit operator actions.

Offline analysis may publish one compact, content-addressed
`noticeos.asset_insight_snapshots` row after operator review. That snapshot is
the only way the Tower reads from the archive: it keeps rule, evidence,
confidence, source, window, and caveat together, while the raw provider rows
stay in R2. Publishing identical content is idempotent.

Property health and Needs Attention count only flags with both
`resolved_at IS NULL` and `disposition IS NULL`. *Mark read* sets a
disposition on this event; *Resolve* closes its underlying condition. A later
recurrence is a new event, while a recovered metric auto-resolves its prior
open flow event. This way the health indicator shows what needs the
operator's attention now, not whether the property has ever produced a
warning.

## Reproducibility

- **Models are pinned per stage**; a version change is a deploy of the OS
  (annotation on every asset timeline), because it changes build quality and
  judge behavior with no other visible change, and therefore changes both
  attribution and the reliability ledger.
- Scoring-policy versions, prompt/context-pack versions, and gateway configs
  are all in version control; any ranked backlog or shipped change can be
  traced to the exact policy + pack + model that produced it.
- **Where config lives:** ALL config — including doc 02's
  per-asset anomaly thresholds and the Tower's layout/threshold edits — is a
  store document seeded from the installation folder (or the `config/`
  defaults) and exported back to the installation folder (below); the
  store's other tables hold *data*, never tunables. "Tunable per asset" means
  per-asset values inside the versioned config.
- **"Never tunables" means never measurement rules.** The rule exists so that
  anything which can change a verdict is visible in a diff — thresholds, the
  scoring policy, the tracked-query list that determines spend. It does not
  apply to *credentials*. A provider secret is per-install
  operator state that must never enter version control, changes when the
  operator changes it rather than when the repo changes, and has to work in a
  deployed Worker with no filesystem — so it is stored encrypted in the store's
  `noticeos.connection_secrets` versions, alongside the public facts in
  `noticeos.integration_connections`, under the bootstrap secret `CREDENTIALS_KEY`.
  It is entered and tested on the Tower's Integrations page
  ([Postgres model](../db/postgres/README.md#the-decided-model)). Operator
  *settings* are kept in the store for the same reason. The measurement
  channel stays operator-only permanently: it is a hard invariant above.
  `config/tower.json` holds the shared Home/Wall countdown; applied values are
  sent in `/api/wall`, while the live clock always uses the display's local
  civil time.
  `config/serp-panel.json` defines the per-property tracked head terms the
  weekly DataForSEO collection pays to check — the one place a tracked-query
  list is written down, and the document that determines that spend, so it is
  a config document like every other tunable.
  `config/entities.json` defines the portfolio's legal entities and the asset
  ids each one owns — the one place *which entity owns this asset* is written
  down. It is config rather than a column on
  `assets` because it changes when legal ownership changes, not when the
  schema changes, and because a column would have needed a migration for a
  fact the product can store as a setting; it is edited on `/settings` →
  **Ownership** and on each asset's **Settings → Identity** card.
- **The files are the seed and the export; once seeded, the store holds the
  authoritative copy.** Both reasons for the rule still apply, and neither
  requires a Worker to read the file. `pnpm config:seed` loads each document from the installation folder, or
  from the generic default in `config/` where the installation has none, into
  `noticeos.config_documents` as a whole JSON document keyed by its file name
  without directory or extension (`config/tower.json` → `tower`); APIs still
  name the `config/` path.
  `pnpm config:export` writes them back to the installation folder with stable
  formatting, so a diff is still where a threshold change is visible and a
  commit is still the config version. `noticeos.config_changes` is the
  machine-readable record beside it — who changed
  what, why, and the version before and after
  ([Postgres model](../db/postgres/model.json)).
  The result: **a deployed Tower can save a setting.** A field stored in a file
  is writable only where a Node process has the repo on the same machine; a
  store document is writable from any deployment.
  **Seeding selects the stored document.** Both Workers read a
  document from the store when it is there and fall back to the copy compiled
  into them when it is not. A reachable, initialized Postgres store with an
  unseeded document uses that compiled copy; an unavailable store fails the
  read instead of being treated as unseeded. The runner logs which state it is
  in, once, at startup. The measurement channel is unaffected: a guardrail
  threshold is operator-only whichever table stores it, and seeding changes
  where a value is read, never who may change it.
  **The ingest's own collectors read it per run.** One read
  per cron fire — `readCollectorConfigs` in `workers/ingest/src/config-store.ts`,
  resolved at `dispatch.ts` and passed to each collector as the parameter it
  already took — covers the six documents those jobs need: `pull.json`,
  `counters.json`, `integrations.json`, `ga4-custom-dimensions.json`,
  `serp-panel.json`, and `constants.json`'s flag defaults (which
  `writePulse` resolves at its own two entry points, since one of them is an
  asset's `POST /api/pulse` rather than a cron). Each run's structured completion
  line includes `configSource` per file — the word only, never a document — so
  the configuration last night's run used is recorded in the run's own log
  line rather than inferred by a reader. This is how a data-source mapping
  saved on an asset's Data sources tab reaches the next collection run with no
  restart; an unseeded install records `file` for every one of them and runs
  exactly as it did the day before.

## Legacy names

<!-- legacy-names:begin -->
The product was once called ReindexOS and is NoticeOS now. Everything a
person or a contributor reads, every package (`@noticeos/*`) and every code
and wire name uses NoticeOS, and `scripts/product-name.test.mjs` fails if one
does not. Two kinds of old name remain on purpose, and no other old name may
remain.

**Read for compatibility, never written.** A running installation and the
tasks it filed still contain these; the product reads the old name when the
new one is absent, and each old spelling appears in exactly one module:

| Old name | New name | Where it still appears | Read by |
|---|---|---|---|
| `REINDEX_OS_INSTALLATION_DIR`, `REINDEX_OS_WORKER_CONFIG_ROOT`, `REINDEX_OPERATOR_TOKEN` | `NOTICEOS_INSTALLATION_DIR`, `NOTICEOS_WORKER_CONFIG_ROOT`, `NOTICEOS_OPERATOR_TOKEN` | an operator's shell or script | `scripts/product-env.mts` |
| `reindex_key`, `reindex_kind`, `reindex_asset`, `reindex_rule`, `reindex_source`, the `reindex-handoff` label | `noticeos_*`, `noticeos-handoff` | handoff tasks in every project's tracker | `packages/contract/src/task-metadata.mts` |
| `reindex_panel_asset`, `reindex_panel_date`, `reindex_push_asset`, `reindex_task_map_asset` | `noticeos_*` | panel-review, unpushed-work and task-map tasks | `packages/contract/src/task-metadata.mts` |

**Created with NoticeOS names.** Naming a resource that does not exist yet
costs nothing, so everything a new installation creates is named in
one place, [`scripts/resource-names.mts`](../scripts/resource-names.mts), and
`scripts/new-install-names.test.mjs` checks that none of it uses the old name:

| New resource | Name | Created by |
|---|---|---|
| the Tower and ingest Workers | `noticeos-tower`, `noticeos-ingest` | the checkout's Worker configs, for every installation |
| the Postgres database and R2 bucket | `noticeos`, `noticeos-raw-signals` | the checkout's Worker configs — what a stranger deploys and what `pnpm os:setup` sets up |
| the Postgres database and role | `noticeos`, `noticeos_app` | the Postgres profile |

A store made under other names keeps them in its installation folder's
`resource-names.json`
([`config/resource-names.README.md`](../config/resource-names.README.md)); the
Tower's dev server applies them over both Worker configs.

**Kept as they are.** Renaming these would move or orphan live data, change a
service only the operator may change, or break a reference stored in another
system, for no benefit to anyone using the product:

| Name | What it is | Why it stays |
|---|---|---|
| the product's old slug, as an id | the id of NoticeOS's own asset row (a historical row) | an id that every stored row, report and token is keyed on. The row is always shown as NoticeOS and identified by `is_os`, never by this id; the `ReindexOS` its `display_name` still stores is legacy data that no screen displays |
| `reindex-os-raw-signals` | the R2 bucket an older store was made under, named in that installation's own `resource-names.json`, never in the checked-in Worker configs | the local R2 store is kept under the bucket's name; resource names are operator-only |
| an older checkout's path | the maintainer's checkout | the task database server keeps its Dolt data inside it |
| the Dolt task databases and the `ro-` task prefix | the task database server | every task id and every project's link to the task database server |
| the private repository's remote | the maintainers' repository | agents never rename or move a repository or a remote |
| the old name in `docs/reports` and `docs/artifacts` | dated records | they keep their original wording |
<!-- legacy-names:end -->

## The task database

Operator and agent work is tracked in [Beads](https://github.com/gastownhall/beads)
(`bd`), a Dolt-backed task tracker. One shared Dolt SQL server holds the task
databases; each configured repository is a task project that connects to that
server in server mode and has no task database of its own. The saved asset ↔
prefix ↔ database map is kept in the store; the
[product task-map default](../config/beads.json) is empty. The
[task contract](../config/beads.README.md) defines those identities.

**The declared task service runs the task database server independently of
the runner.** It is the stack's `dolt` service ([Compose profile](../db/dolt/host/README.md)),
declared to the app in its protected `/state/task-client.json`. Health checks
and backups use that declaration. A missing or invalid declaration fails with
an explicit error. The runner checks the endpoint at startup, on its 15-minute
health check and before each snapshot read; it logs state changes and backs up
the declared service nightly. It does not start, stop or supervise the task
service.

Recover the exact declared project, service and volume through the
[Compose recovery procedure](../db/dolt/host/README.md#backup-and-recovery),
with approval for changes to existing services or stores. Never start the
retired source to recover a Compose task database server. Homebrew recovery
applies only to an installation still using the
[legacy native profile](../config/dolt-server.README.md).
Dolt holds an exclusive write lock per database; a second server must never
open the same data directory.

**Tasks are coordination state, not signals.** A task records what someone
intends to do; a report records what an asset observed. The task database is a
second store, separate from the ledger — nothing in it enters the report
envelope or the signal contract ([doc 02](02-signal-contract.md)), and no task
is evidence of an outcome. A record of intent must never be counted as a
measurement.

**Durability.** The runner's nightly 04:00 UTC job backs up all
three stores into the same dated directory under `.local/backups/`, on the same
30-day retention: the declared Compose Postgres through a custom-format
`pg_dump`, the R2 raw-archive store's sqlite via sqlite's **online-backup API**
(a raw file copy of a live WAL database can be left inconsistent if it is taken
mid-checkpoint), R2's content-addressed blobs as plain copies (immutable once
written), and one consistent `DOLT_BACKUP` per task database into
`<date>/beads/<database>/`. The task database backup is a call to the live
server and requires the task **service** to be running (not the runner). Every
required store is attempted, but a failed store blocks publication, offsite
handoff and pruning. The previous complete backup remains available.
Each published dated dir contains a generated `RESTORE.md` that lists what it
holds and how to restore it. Each store is consistent on its own; the stores
are not captured at one shared instant, and the restore proof also checks their
archive references. Postgres requires the installation's explicit
`postgres/profile.json`; a backup never infers or starts a project. See
[backup and restore](../scripts/README.md#backups--restore).

**Off-machine durability.** The finished dated dir is
copied to `<offsiteBackupDir>/<date>/`, the folder this host names in its
installation's `host-backup.json` ([`config/host-backup.README.md`](../config/host-backup.README.md)),
which a sync client copies offsite with no extra tool or credential. Only
the *completed* copy
is synced, never live stores, so the sync client never reads a partly written
file; pruning removes offsite copies on the same 30-day window. The
`DOLT_BACKUP` dirs in that copy restore via `dolt backup restore file://…`,
which also provides the task databases' off-machine copy; a Dolt remote is
not built unless a drill shows the copied backups are insufficient. A backup
that has never been restored is not known to work, so the quarterly restore
drill restores from the **offsite copy alone**, all three stores, into an
isolated scratch location (procedure in [`scripts/README.md`](../scripts/README.md)).

## Data retention

Reports, normalized signals, raw provider archives and their manifests, ledger,
annotations: append-only, kept indefinitely (they are the calibration corpus).
Content hashes prevent unchanged rolling re-fetches from duplicating R2 bytes.
Run transcripts: 90 days in hot storage, then sampled archives (audit trail
for the reliability ledger). Storage costs are ledger entries for NoticeOS's
own asset, like every other cost.
