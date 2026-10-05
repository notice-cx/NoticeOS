# 06 — Operations & self-observability

*New in v2. v1 built a control plane with write access into every asset and
gave it no pulse, no spend meter, no kill switch, and no vendor-failure plan.
This doc makes NoticeOS **asset #0** — held to every standard it holds assets
to — and writes down the boring machinery autonomy actually rests on.*

## Asset #0: the OS's own pulse

Nightly, same contract as everyone else ([doc 02](02-signal-contract.md)):

- **Ingest freshness** per asset per lane (pulse, GSC, GA4, revenue) — a
  push-cron that died silently is an `error` flag **within two nightly cycles**,
  not a three-weeks-later discovery. Two rather than one on purpose: a single
  late night (a retried collector, a provider that published at noon) would fire
  an error that resolves itself by morning, and a flag that cries wolf is a flag
  the operator learns to scroll past. The age is
  `REPORT_MAX_AGE_HOURS` — 48h, `REPORT_CADENCE_HOURS × REPORT_STALE_MULTIPLIER`
  in [`packages/contract/src/reporting.ts`](../packages/contract/src/reporting.ts)
  — and it is the ONE number both surfaces read: the hourly `ingest-freshness`
  cron fires its error past that age and the Tower counts the property stale past
  that same age, so an open error and a "fresh" tally can never describe one
  property in one payload (ro-uwo.1). Want a dead lane named sooner? Move the
  constant, not this sentence. An asset whose Settings declare that it sends
  no nightly report (`config/constants.json` `no_nightly_report`, bead
  `ro-ujb9.96.8`) owes none: `owesNightlyReport` in the same file leaves it
  out of both surfaces' counts, it never earns the flag, a flag still open for
  it is resolved on the next hourly run, and its card reads a neutral
  "No report".
- **Spend**: inference + API dollars per stage (Sense/Attribute/Decide/Act),
  per asset, vs budget; cost-per-landed-change trailing 30d. *Today only the
  API half is metered — see Budget enforcement below.*
- **Throughput & quality**: hypothesis cards ranked, changes shipped by tier,
  accept rate, reliability-ledger movements, open deferrals, audit findings.
- **Cron/system health**: run successes, retries, queue depth, store size.

The Tower renders asset #0 first. If the OS is unhealthy, nothing else it
displays is trustworthy.

## Local runner operability contract

The Phase 0 OS is intentionally hosted by the always-on office Mac. Its normal
runtime is the repo-generated launchd user agent (`RunAtLoad` + `KeepAlive`), not
a terminal somebody must remember to keep open. `pnpm os:install` installs or
refreshes that service idempotently; `pnpm os:uninstall` is its bounded restore
path. The beads Dolt hub remains a separate Homebrew service and is never
started or stopped by this agent.

Agents and operators use one repo-owned interface:

| Question / action | Command | Contract |
|---|---|---|
| Is the OS trustworthy? | `pnpm os:status` | Classifies `stopped`, `starting`, `healthy`, `unhealthy`, or `stale`; `-- --json` is machine-readable. A port alone never earns healthy. |
| What just happened? | `pnpm os:logs -- --lines 200` | Reads recent combined runner/child output; `--follow` follows it during a repro. |
| What evidence should I hand off? | `pnpm os:doctor` | Prints a bounded report: status, 200 log lines, 100 scheduled-lane records, and the store's capacity. |
| How big is the store, and how fast is it growing? | `pnpm os:capacity` | Rows, bytes and daily growth per table, insight snapshots, the raw archive and lane durations, asked of the running OS; metadata only ([doc 26](26-storage-capacity.md)). `-- --json` is the raw answer. |
| Recover the managed runner | `pnpm os:restart` | Restarts only the loaded repo-owned service, waits 45 seconds for health, and includes recent output on failure. |
| Put merged work live | `pnpm os:deploy` | Moves the runtime copy to a verified `main` commit with one restart and a health wait, going back by itself if that fails; `-- --check` changes nothing, `-- --rollback` returns. |

**Merging is not deploying.** The service runs a runtime copy of the code under
`.local/runtime/` that a merge never touches, so work landing on `main` no longer
reloads the live OS. `pnpm os:deploy` is the step after a verified merge: it
refuses a commit not on `main`, a move backwards, a hand-edited runtime copy, a
commit that would open a different or empty store, and a commit carrying a
migration its store has not applied (on Postgres, or applied with another
hash). If the new commit does not come back
healthy, the deploy returns to the previous runtime copy by itself — once, with
one more restart — and prints what failed and whether the previous commit is
healthy again. Only code moves — the store, `.local/`,
the secret files and the task inventory stay in the operator's checkout. How it
works, and the one-time cut-over, are in
[`scripts/README.md`](../scripts/README.md#merging-is-not-deploying--pnpm-osdeploy).
`pnpm os:status` shows which commit runs and how far `main` is ahead.

The runner writes a heartbeat every 30 seconds. Healthy requires the launchd
service running, a heartbeat no older than 90 seconds, and HTTP success from
both the loopback ingest and Tower. Persistent output scrubs common credential
shapes before writing and the commands scrub again when reading. Log lines are
capped at 64 KiB; the combined log rotates at 5 MiB with five historical files;
scheduled-lane JSONL retains 30 days. launchd does not create a duplicate log.

Status, logs, and diagnostics are read-only. A routine restart or deploy after
authorized ordinary runner/Tower work is within that work's scope. Operator approval is
required before restarting when a pending change affects auth, billing,
security headers, DB migrations, consent, analytics/tracking, holdouts, or
guardrail thresholds, or when the command reports an unmanaged runtime. The
restart command deliberately refuses to kill an unknown process tree.
After a forced supervisor exit, a replacement may terminate only the child
process group positively named by a fresh managed heartbeat; a stale, manual,
live-parent, foreign, or unreadable owner remains untouched.

Managed startup, restart and deploy never apply a migration. Postgres is the
only supported operational store; its maintenance sequence is operator-only.
On Postgres it is `pnpm os:stop` → `pnpm postgres:migrate apply …` →
`pnpm os:start`
([`db/postgres/README.md`](../db/postgres/README.md#applying-it-to-an-installations-own-database)),
and `pnpm os:deploy` refuses a commit whose Postgres migrations the database
has not applied, or applied with another hash.

For a provably new, empty installation only, `pnpm start` may create its own
isolated Compose Postgres, apply the committed frozen schema and bootstrap
one workspace ([approved exception](../AGENTS.md#hard-invariants-non-negotiable--from-doc-01),
owner 2026-09-30, `ro-ujb9.8.1`). Existing installations, the managed service
and production remain operator-only. The checks and first-run steps are in
[scripts/README.md](../scripts/README.md#a-new-installation-in-one-command-pnpm-start).

Downtime recovery is bounded and read from the 30-day job-run record. Startup
runs at most the latest missed obligation per allowlisted lane, sequentially:
15-minute lanes within one hour, hourly lanes within two hours, daily lanes
within 36 hours, and the weekly DataForSEO lane within eight days. It never
replays every missed tick, and it pays the cheapest cadence first so the
15-minute wall lanes never queue behind the weekly collection. Only the lanes in
the pass's own plan hold their regular tick, each released as soon as its
catch-up firing finishes; every other lane keeps ticking normally, and the log
explicitly marks when the pass is done. A recorded failure counts as an attempt rather than
causing a restart loop. Hub health and the beads snapshot already execute at
startup and need no replay. Unknown cron expressions are excluded, and the
Worker refuses one anyway (`unknown_cron`, running nothing). Migrations, restore,
seed/config apply, deployment, kill-switch work, and every forever-forbidden
surface are not catch-up jobs. The policy executes already-approved collection
definitions; it cannot edit the measurement channel.

## Budget enforcement (hard caps; alerts are not enforcement)

**What is in force today (2026-09-05).** One cap, and it is real:
`config/constants.json` `monthly_caps.data_usd` — $25/mo of metered data spend,
reserved before every paid DataForSEO read and failing closed. There is **no
model gateway and no inference cap**, because no process in this repo calls a
model: the analyzer is rule-based, and every model call happens in a Claude Code
session billed outside the OS. The $100/mo inference ceiling this section
implied was withdrawn on 2026-09-05 (D6, bead `ro-uj7x`) rather than left on a
settings page that had to admit nothing measured it. Everything below is the
design that takes effect **when the OS makes its first model call of its own** —
it is a specification, not a description of the running system.

All model/API traffic flows through a gateway with **dollar-denominated,
fail-closed limits** (Cloudflare AI Gateway-class, fitting the existing stack;
LiteLLM-class proxy equivalent):

- Per-run cap (default modest; sized per change-class), per-day cap per stage,
  portfolio monthly cap. Breach = block or fall back to a cheaper model —
  degrade, don't die.
- **Spend-velocity circuit breaker** independent of totals ($/min beyond N×
  the planned rate trips before the daily cap ever would — the $47k loop ran
  11 days on alerts alone).
- Loop detectors: identical-call dedup, A↔B round-trip counters,
  recursion-depth caps, error-streak halts (one documented burn ignored 253
  consecutive usage-limit errors).
- **Kill must reach the provider**: cancellation of provider-side runs is part
  of the switch — documented incidents kept billing after the local process
  died.
- Caps exist per credential, so a leaked key is bounded (documented leaks run
  $1k–$60k before humans notice).

## The kill switch

**Required before automated asset execution, not a built first-release
control (D43).** Asset agent execution remains manual; operators stop their
external agents directly. NoticeOS's collection schedule controls do not
establish an agent pause. The execution service and its enforceable pause
boundary are tracked in `ro-lwo6`.

The future operating contract requires one documented, rehearsed action to
stop the system: disable all NoticeOS crons
+ revoke the GitHub App installation token + freeze the gateway keys. Target:
executable in under two minutes from a phone; **drilled quarterly** (the drill
is a scheduled task on the OS's own backlog, and the drill result is a pulse
metric). Partial switches per stage (pause Act, keep Sense) for softer
interventions.

## Secrets & access

- The GitHub App private key: rotation cadence (quarterly), storage (CF
  secrets, never in repos), break-glass procedure written next to the key's
  location, scope audit at each rotation.
- Portfolio API credentials (Google signal service-account keys for GSC/GA4,
  DataForSEO, ad networks, affiliate networks): per-vendor rotation notes and
  expiry/revocation alarms (a disabled Google key is a silent Sense outage —
  caught by ingest freshness).
- Least privilege reaffirmed: the OS org's compromise radius is the App key +
  read credentials; asset prod secrets never live in NoticeOS.

### Bootstrap secrets vs. integration credentials

*The line, written here and linked from everywhere else (D21, epic `ro-vu8d`;
the fourth secret, the operator's choice on `ro-ujb9.76.32`). Four bootstrap
secrets, and everything else in the product.*

**Four secrets stay in the environment, forever.** They are how the OS starts
at all, so nothing in the product could hold them — a credential you have to be
running to read cannot be the thing that lets you run:

| Secret | What it bootstraps |
|---|---|
| `CREDENTIALS_KEY` | the key every stored provider credential is encrypted under (`openssl rand -base64 32`). The store cannot hold the key to the store. |
| `OPERATOR_TOKEN` | the bearer the runner and the operator's own scripts present to the ingest's write routes. It authorizes the process that would otherwise read the store. |
| `ASSET_TOKENS` | one token per asset, checked on an inbound pulse and presented on the outbound pull ([doc 11](11-integrations.md#credential-naming--the-asset_token-convention)). It is the OS's own shared secret with each asset, not a third-party account. |
| `DATABASE_URL` | the address of the installation's own Postgres: the application login's connection string, `postgresql://noticeos_app:<password>@127.0.0.1:5432/noticeos?sslmode=disable` ([db/postgres/host](../db/postgres/host/README.md) sets one up). The store cannot hold its own address. |

**Where they are kept.** Locally, all four are in the installation's secrets
file, `workers/ingest/.dev.secrets.json`: the home checkout's for the managed
service, the start folder's own for `pnpm start`. The first three reach the
Workers as bindings (compiled into `.dev.vars`). `DATABASE_URL` never does: the
runner and `pnpm start` read it at every start, check it as the application
login, and hand it to the dev server's environment and nowhere else, as the
POSTGRES binding's local address
(`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_POSTGRES`,
[`scripts/database-address.mts`](../scripts/database-address.mts)).
`pnpm os:deploy` reads it through the runner's same reader, only to read the
database's migration record, and prints no part of it. A new
`pnpm start` folder creates its isolated Compose profile under its own
`postgres/secrets/` and takes the application address from `database.url`.
An existing installation can take its address once from an operator-prepared
profile ([db/postgres/host](../db/postgres/host/README.md), step g). A missing
or unusable address, or a database behind the code, stops the start in one
sentence that names the file and never repeats the address; only the approved
new, empty first run applies schema. Deployed on Cloudflare, the address lives in the Hyperdrive
configuration, not as a Worker secret.

**Every third-party provider credential is connected in the product.** Google
Analytics / Search Console, Bing Webmaster, DataForSEO, calendar feeds, and
whatever [doc 11](11-integrations.md#the-catalog) adds: connected, tested and
disconnected on the Tower's **`/integrations`** page, stored AES-GCM-encrypted
in `noticeos.connection_secrets`, with the connection's public facts in
`noticeos.integration_connections`. A Save inserts the next secret version and
removes the previous version in one transaction, without rewriting ciphertext
([Postgres model](../db/postgres/README.md#the-decided-model)). Every collector
resolves the store first.

**Env bindings remain the legacy fallback for existing installs.** A provider
with no stored row falls back entirely to its binding and keeps working — the
card wears a neutral *Legacy env* chip and offers **Import from this machine**,
which moves the whole secrets file across in one press (bead `ro-vu8d.7`;
`pnpm dev:secrets:import` is the same code where there is no dev server). `os:up`
names any provider still on env in one line at startup, and `/health` says so in
one line too. The fallback is not deprecated and nothing forces the move; what
it costs is portability, because a fresh install would need those secrets copied
by hand.

#### The legacy local source

Locally, an operator who has not moved edits the formatted, gitignored
`workers/ingest/.dev.secrets.json`. Nested maps such as
`GOOGLE_SIGNAL_ACCOUNTS` remain real JSON instead of minified dotenv strings.
`os:up` compiles that source to `.dev.vars` immediately before Wrangler starts.
Google's property routing remains in `GOOGLE_SIGNAL_ACCOUNTS`, while each
encoded service-account key is extracted to its own bounded
`GOOGLE_SERVICE_ACCOUNT_*` binding. This keeps the readable account-centric
source without exceeding a Worker text-binding limit. The generated file is
not an additional source of truth. `pnpm
dev:secrets:migrate` converts an existing flat file once, and `pnpm
dev:secrets:sync` rebuilds it on demand. Deployed Workers receive the routing
map and per-account credentials as separate encrypted string secrets.

## Vendor failure & degradation policy

Per signal lane, written posture — **skip, don't guess**:

| Lane | On failure | Never |
|---|---|---|
| DataForSEO | skip cycle, mark panel gap, retry next cadence | interpolate positions |
| GSC/GA4 | mark unfinalized/missing; suppress dependent flags | alert on partial windows |
| Bing Webmaster | retain the last-good series, mark the lane degraded, retry next daily cadence | convert an unreported lagging date into zero traffic |
| Ad/affiliate reporting | retain provider-reported estimates with an explicit estimated status; book payments on reconciliation ([Mediavine](11-integrations.md#mediavine-revenue)) | invent revenue or label an estimate reconciled |
| Model provider | gateway fallback chain; if none, pause Act | silently swap models without an annotation |

Vendor pricing/policy changes (model prices, API terms, network thresholds,
crawler policies) are `external` annotations — they move ledgers and baselines
and must be visible on every affected timeline.

The implemented Google and Bing lanes record every attempt in `signal_runs`,
isolate provider/property failures, retain the last successful observations,
and show the effective source state on each property card. GA4/GSC run every
15 minutes and degrade after two missed cadences (30 minutes). Bing Webmaster's
rank-and-traffic dataset updates daily, so it runs at 02:30 UTC and degrades
after two missed daily cadences (48 hours); polling it every 15 minutes would
not make the provider data fresher. The broader asset-#0 flag/notification job
is still outstanding. GA4 marks only today provisional in the chart. GSC also
treats today as provisional when response metadata is absent and moves the
boundary earlier when the provider supplies `first_incomplete_date`. Bing is
final through the last date it returns and has no manufactured zero tail.
Dependent anomaly rules must ignore incomplete or absent dates.

GA4's current display data is demand-driven, not another cron or
measurement-history lane. An open Home/Wall polls the Tower every 30 seconds;
Tower calls ingest over a private Service Binding, and ingest concurrently
makes two `runRealtimeReport` requests/property — both trailing 30- and
5-minute ranges, and the per-minute rows of the Wall's minute pulse (bead
`ro-trai.27`) — shared by every display for one minute, plus one bounded Core
hourly report for today and seven days ago. It reuses a short-lived read-only Google access token but persists nothing.
The current-day line stops after GA4's newest reported hour; unreported future
hours are null rather than zero, while the same-weekday reference spans its
complete day. These reads are isolated from `/api/wall`: a timeout, quota
failure, or invalid response leaves the rest of the card available, renders no
false zero, and lets the client retain its last-good values as “Reconnecting.”
The response requests property-quota telemetry so a future cadence change can
be based on observed token consumption.

The analysis-grade provider lanes are isolated from those live chart
collectors. They write bounded daily GA4/GSC/BWT and weekly DataForSEO gzip
JSON to the private/local `RAW_SIGNALS` R2 binding and append-only attempt
manifests to `signal_dump_runs`. Google re-fetches the previous four completed
dates; BWT retains one current provider snapshot for each of six report
families; DataForSEO retains ranked-keyword, backlink, and Google/ChatGPT
mention snapshots and exact metered cost.
Identical content references the existing immutable object. A report failure
never deletes a prior dump and never turns an absent provider row into zero. Locally, Wrangler
persists local R2 under `.wrangler/state`; remote access and provisioning
are explicit operator actions.

Offline analysis may publish one compact, content-addressed
`noticeos.asset_insight_snapshots` row after operator review. That snapshot is the
Tower's only read boundary into the deep archive: it keeps rule, evidence,
confidence, source, window, and caveat attached, while the raw provider rows
remain in R2. Publishing identical content is idempotent.

Property health and Needs Attention count only flags with both
`resolved_at IS NULL` and `disposition IS NULL`. *Mark read* dispositions this
event; *Resolve* closes its underlying condition. A later recurrence is a new
event, while a recovered metric auto-resolves its prior open flow event. This
keeps the health light about current operator attention, not whether the
property has ever produced a warning.

## Reproducibility

- **Models are pinned per stage**; a version change is a deploy of the OS
  (annotation on every asset timeline), because it silently shifts build
  quality, judge behavior, and therefore both attribution and the reliability
  ledger.
- Scoring-policy versions, prompt/context-pack versions, and gateway configs
  are all in version control; any ranked backlog or shipped change can be
  traced to the exact policy + pack + model that produced it.
- **Where config lives, reconciled:** ALL config — including doc 02's
  per-asset anomaly thresholds and the Tower's layout/threshold edits — is a
  store document seeded from the installation folder (or the `config/`
  defaults) and exported back to the installation folder (D22 below); the
  store's other tables hold *data*, never tunables. "Tunable per asset" means
  per-asset values inside the versioned config.
- **Narrowed 2026-09-05 (D21): "never tunables" means never MEASUREMENT RULES.**
  The rule exists so that anything which can change a verdict is visible in a
  diff — thresholds, the scoring policy, the tracked-query list that decides
  spend. It was never an argument about *credentials*, and treating it as one
  cost a self-hoster the ability to connect Google Analytics without editing two
  gitignored files and restarting the OS. A provider secret is per-install
  operator state that must never enter version control, changes on the
  operator's schedule rather than the repo's, and has to work in a deployed
  Worker with no filesystem — so it lives encrypted in the store's
  `noticeos.connection_secrets` versions, alongside the public facts in
  `noticeos.integration_connections`, under the bootstrap secret `CREDENTIALS_KEY`.
  It is entered and tested on the Tower's Integrations page (epic `ro-vu8d`,
  [Postgres model](../db/postgres/README.md#the-decided-model)). Operator
  *settings* move the same way for the same reason (epic `ro-syok`). The measurement channel does not
  move, and never will: it is a HARD INVARIANT above.
  `config/tower.json` owns the shared Home/Wall countdown; applied values ride
  `/api/wall`, while the live clock always uses the display's local civil time.
  `config/serp-panel.json` owns the per-property tracked head terms the weekly
  DataForSEO lane pays to watch — the one place a tracked-query list is written
  down, and the document that decides that spend, so it is a config document
  like every other tunable.
  `config/entities.json` owns the portfolio's legal entities and the asset ids
  each one owns — the one place *which entity owns this asset* is written down
  (D5; bead `ro-aodz`, 2026-09-05). It is config rather than a column on
  `assets` because it changes on a lawyer's schedule rather than the store's,
  and because a column would have been a migration for a fact the product can
  own; it is edited on `/settings` → **Ownership** and on each asset's
  **Settings → Identity** card.
- **Narrowed again 2026-09-05 (D22, operator-decided): the files are the SEED
  and the EXPORT; the store is the source of truth once seeded.** Both reasons
  the rule was chosen survive, and neither is the file being the thing a Worker
  reads. `pnpm config:seed` loads each document from the installation folder, or
  from the generic default in `config/` where the installation has none, into
  `noticeos.config_documents` as a whole JSON document keyed by its file name
  without directory or extension (`config/tower.json` → `tower`); APIs still
  name the `config/` path.
  `pnpm config:export` writes them back to the installation folder with stable
  formatting, so a diff is still where a threshold change is visible and a
  commit is still the config version. `noticeos.config_changes` is the machine-readable
  half beside it — who changed
  what, why, and the version either side
  ([Postgres model](../db/postgres/model.json)).
  What this buys is the thing D18 could not: **a deployed Tower saves a
  setting.** Until now the only deployment that could was the local `os:up` dev
  server, because a Node process had the repo beside it; anywhere else every
  file-owned field was read-only, which is a footnote a self-hoster hits on day
  one (epic `ro-syok`).
  **Seeding selects the stored document.** Both Workers read a
  document from the store when it is there and fall back to the copy compiled
  into them when it is not. A reachable, initialized Postgres store with an
  unseeded document uses that compiled copy; an unavailable store fails the read
  rather than pretending it is unseeded. `os:up` says which state it is in,
  once, at startup. The measurement channel still does not move: a guardrail
  threshold is operator-only whichever table it sits in, and this changes where
  a value is read, never who may change one.
  **The ingest's own collectors read it per run** *(bead `ro-syok.7`)*. One read
  per cron fire — `readCollectorConfigs` in `workers/ingest/src/config-store.ts`,
  resolved at `dispatch.ts` and handed to each collector as the parameter it
  already took — covers the six documents those jobs need: `pull.json`,
  `counters.json`, `integrations.json`, `ga4-custom-dimensions.json`,
  `serp-panel.json`, and `constants.json`'s flag defaults (which
  `writePulse` resolves at its own two entry points, since one of them is an
  asset's `POST /api/pulse` rather than a cron). Each run's structured completion
  line carries `configSource` per file — the word only, never a document — so
  "which configuration did last night run on" is something a run SAID rather than
  something a reader infers. That is what makes a data-source mapping saved on an
  asset's Sources tab reach the next collection run with no restart (`ro-7xv2`);
  an unseeded install answers `file` for every one of them and runs the run it
  ran yesterday.

## Legacy names

<!-- legacy-names:begin -->
The product was called ReindexOS until 2026-09-23 and is NoticeOS now
(decision D26; epic `ro-ujb9.77`). Everything a person or a contributor reads,
every package (`@noticeos/*`) and every code and wire name says NoticeOS, and
`scripts/product-name.test.mjs` keeps it that way. Two kinds of old name remain
on purpose, and nothing else may carry one.

**Read for compatibility, never written.** A running installation and the
beads it filed still carry these; the product reads the old name when the new
one is absent, and each old spelling lives in exactly one module:

| Old name | New name | Where it still turns up | Read by |
|---|---|---|---|
| `REINDEX_OS_HOME`, `REINDEX_OS_MANAGED` | `NOTICEOS_HOME`, `NOTICEOS_MANAGED` | a launchd plist installed before the rename (reinstalling it is operator-only) | `scripts/product-env.mts` |
| `REINDEX_OS_INSTALLATION_DIR`, `REINDEX_OS_WORKER_CONFIG_ROOT`, `REINDEX_OPERATOR_TOKEN` | `NOTICEOS_INSTALLATION_DIR`, `NOTICEOS_WORKER_CONFIG_ROOT`, `NOTICEOS_OPERATOR_TOKEN` | an operator's shell or script | `scripts/product-env.mts` |
| `reindex-os:*` browser keys (theme, Sites list, palette recents, …) | `noticeos:*` | every browser that used the desk before | `apps/tower/src/lib/browser-storage.ts` (moves the value on first read) |
| `reindex_key`, `reindex_kind`, `reindex_asset`, `reindex_rule`, `reindex_source`, the `reindex-handoff` label | `noticeos_*`, `noticeos-handoff` | handoff beads in every project's tracker | `packages/contract/src/task-metadata.mts` |
| `reindex_panel_asset`, `reindex_panel_date`, `reindex_push_asset`, `reindex_task_map_asset` | `noticeos_*` | panel-review, unpushed-work and task-map beads | `packages/contract/src/task-metadata.mts` |

**Born with NoticeOS names.** A resource that does not exist yet costs
nothing to name right, so everything a new installation creates is named in
one place, [`scripts/resource-names.mts`](../scripts/resource-names.mts), and
`scripts/new-install-names.test.mjs` proves none of it carries the old name:

| New resource | Name | Created by |
|---|---|---|
| the Tower and ingest Workers | `noticeos-tower`, `noticeos-ingest` | the checkout's Worker configs, for every installation |
| the Postgres database and R2 bucket | `noticeos`, `noticeos-raw-signals` | the checkout's Worker configs — what a stranger deploys and what `pnpm start` sets up |
| the managed service on a Mac with none installed | `com.noticeos.local` | `pnpm os:install` |
| the Postgres database and role | `noticeos`, `noticeos_app` | the Postgres profile (`ro-ujb9.76.12`) |

Wrangler reaches the database by its binding, `DB`, so the same migrate,
seed and config commands work on a store of either vintage. A store made under
other names keeps them in its installation folder's `resource-names.json`
([`config/resource-names.README.md`](../config/resource-names.README.md)); the
Tower's dev server applies them over both Worker configs, and `pnpm os:deploy`
refuses a commit that would open a raw-signal bucket other than the one the
local store holds its archives under.

**Kept as they are.** Renaming these would move or orphan live data, change a
service only the operator may change, or break a link another system holds,
for no benefit to anyone using the product:

| Name | What it is | Why it stays |
|---|---|---|
| the product's old slug, as an id | asset #0's id (the OS's own historical row, retained through the Postgres cutover) | an id every stored row, pulse and token keys on. The row is always shown as NoticeOS, known by `is_os`, never by this id; the `ReindexOS` its `display_name` still stores is legacy data nothing displays (`ro-ujb9.77.10`) |
| `reindex-os-central`, `reindex-os-raw-signals` | the retired D1 database and current R2 bucket the owner's store was made under, named in that installation's own `resource-names.json` (bead `ro-ujb9.77.8`), never in the checked-in Worker configs | the local R2 store is kept under the bucket's name; resource names are operator-only (D25 retires D1 for Postgres) |
| `com.reindexos.local` | the launchd label of a service installed before the rename | installing, renaming or removing the service is operator-only; `pnpm os:*` finds it by its installed plist and keeps using it |
| `~/dev/reindex-os` | the owner's checkout | the task hub keeps its Dolt data inside it and the service runs from it (D33) |
| the Dolt hub databases and the `ro-` bead prefix | the task hub | every bead id and every project's link to the hub |
| `git@github.com:reindex-os/reindex-os.git` | the private repository | agents never rename or move a repository or a remote (D33) |
| the old name in `docs/reports`, `docs/artifacts`, `docs/briefs`, the rows of `config/decisions.md` and the frozen migration source in `installation/recovery/d1-cutover` | dated records | they keep the words they were written in |
<!-- legacy-names:end -->

## The beads task hub (landed 2026-08-01)

Operator and agent work is tracked in [Beads](https://github.com/gastownhall/beads)
(`bd`), a Dolt-backed task tracker. One shared Dolt SQL server is the hub;
each configured repository is a server-mode spoke with no task database of
its own. The saved asset ↔ prefix ↔ database map lives in the store; the
[product task-map default](../config/beads.json) is empty. The
[task contract](../config/beads.README.md) defines those identities.

**The declared task service hosts the hub independently of the runner.**
New installations use the [Compose profile](../db/dolt/host/README.md).
A native application selects a prepared Compose hub through
`NOTICEOS_DOLT_HOME`, which names the home containing its protected
`dolt/profile.json`. Health checks and backups use that profile. A missing or
invalid selected profile fails explicitly and never selects the old native
hub. The runner observes the endpoint at startup, on its 15-minute health tick
and before snapshot polls; it logs state changes and backs up the declared
service nightly. It does not start, stop or supervise the task service.

Recover the exact declared project, service and volume through the
[Compose recovery procedure](../db/dolt/host/README.md#backup-and-recovery),
with approval for changes to existing services or stores. Never start the
retired source as recovery for a Compose hub. Homebrew recovery applies only
to an installation still using the [legacy native profile](../config/dolt-server.README.md).
Dolt holds an exclusive write lock per database; a second server must never
open the same data directory.

**Tasks are coordination state, not signals.** A bead records what someone
intends to do; a pulse records what an asset observed. The hub is a second store
beside the ledger and never inside it — nothing in it enters the pulse envelope
or the signal contract ([doc 02](02-signal-contract.md)), and no bead is
evidence of an outcome. Intent must never be able to masquerade as measurement.

**Durability (extends D10).** The runner's nightly 04:00 UTC job backs up all
three stores into the same dated directory under `.local/backups/`, on the same
30-day retention: the declared Compose Postgres through a custom-format
`pg_dump`, the R2 raw-archive store's sqlite via sqlite's **online-backup API**
(a raw file copy of a live WAL database can tear mid-checkpoint), R2's
content-addressed blobs as plain copies (immutable once written), and one
consistent `DOLT_BACKUP` per hub database into `<date>/beads/<database>/`. The
hub half is a live-server call requiring the hub **service** up (not the
runner). Every required store is attempted, but a failed store blocks publication,
offsite handoff and pruning. The previous complete backup remains available.
Each published dated dir carries a generated `RESTORE.md` stating what it holds
and how to restore. Stores are independently consistent, not one shared instant;
the restore proof also checks their archive references. Postgres requires the
installation's explicit `postgres/profile.json`; no project is inferred or
started by a backup. See [backup and restore](../scripts/README.md#backups--restore).

**Off-machine durability is wired (2026-08-02).** The finished dated dir is
copied to `<offsiteBackupDir>/<date>/`, the folder this host names in its
installation's `host-backup.json` ([`config/host-backup.README.md`](../config/host-backup.README.md)),
which a sync client carries offsite with no extra tool or credential — chosen
over a Dolt remote / per-store export in `ro-t34`. Only the *completed* copy
travels, never live stores, so the sync client cannot see a torn file; pruning
sweeps the offsite tree on the same 30-day window. The `DOLT_BACKUP` dirs in
that copy restore via `dolt backup restore file://…`, which satisfies the hub's
off-machine need too — `ro-2nd`'s Dolt-remote wiring stays unbuilt unless a
drill proves the copied backups insufficient. D10's standing warning applies
unchanged — *untested backups are hopes* — so the quarterly restore drill
restores from the **offsite copy alone**, all three stores, into an isolated
scratch location (procedure in [`scripts/README.md`](../scripts/README.md)).

## Data retention

Pulses, normalized signals, raw provider archives and their manifests, ledger,
annotations: append-only, kept indefinitely (they are the calibration corpus).
Content hashes prevent unchanged rolling re-fetches from duplicating R2 bytes.
Run transcripts: 90 days hot, then sampled archives (audit trail for the
reliability ledger). Costs of storage are asset #0 ledger entries like
everything else.
