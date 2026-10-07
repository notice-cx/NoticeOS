# Postgres operational store

*Beads `ro-ujb9.76.2` (the model) and `ro-ujb9.71` (the baseline), under the
storage move decided in D25 and the customer separation decided in D27
([decision register](../../config/decisions.md)). Postgres is the supported
operational store. Applying migrations to an existing installation requires
explicit operator approval. `pnpm postgres:migrate` is operator-only
([Applying it to an installation's own database](#applying-it-to-an-installations-own-database)).
The approved exception for a provably new, empty installation is
[`pnpm start`](host/README.md#a-new-installation), using the same helpers.*

| File | What it is |
|---|---|
| [`migrations/`](migrations/) | The store's schema, in numbered migrations; [`0001_baseline.sql`](migrations/0001_baseline.sql) is the approved model |
| [`frozen-migrations.sha256`](frozen-migrations.sha256) | The migrations that may never change again, with their hashes, and the only ones a real database may apply ([Changing the schema](#changing-the-schema)); the baseline, frozen 2026-09-30 |
| [`roles.sql`](roles.sql) | Owner, application, maintenance, identity, platform and task-directory roles, created once per cluster before the first migration |
| [`host/`](host/README.md) | The installation's Postgres as a Compose service (the operator's choice on `ro-ujb9.76.32`), its secrets made by `pnpm postgres:secrets`; independently proven on throwaway data before the approved cutover |
| [`model.json`](model.json) | Application revision rules, NULL identities, retention windows, maintenance privileges and shared reference catalogs |
| [`REVIEW.md`](REVIEW.md) | The orchestrator's review of the draft (2026-09-24); its six changes are built into the baseline, and each of its recommendations is [done or declined](#the-reviews-recommendations) |
| [`constraints.md`](constraints.md) | The constraint matrix: every table's types, required columns, checks, keys, links and triggers (generated from Postgres) |
| [`tests/`](tests/) | A synthetic fixture for every table, the cross-workspace denial proof and the edge cases with their accepted outcomes |
| [`consumers.md`](consumers.md) | How to read current SQL consumers directly from source |

The frozen baseline retains its original comments, including references to the
retired D1 mapping. That historical source is preserved with the cutover release
in `installation/recovery/d1-cutover`; current operational rules live in `model.json`.

## Hosted identity storage

[`0002_identity.sql`](migrations/0002_identity.sql) adds the maintained identity
schema under D39. Its `noticeos_identity` runtime role owns nothing, has no
other role memberships, cannot create tables and cannot access the operational
schema. Organizations use the exact canonical workspace UUID through a foreign
key; workspace display and lifecycle remain NoticeOS-owned. Identity records
are global control-plane data, outside the operational model's forced row
security. The generated operational matrices and consumer inventory cover
`noticeos` and `noticeos_ref`; the identity schema's generated-DDL, permissions
and runtime contract are checked by `scripts/postgres-identity.test.mjs`.

The `@noticeos/postgres/identity` export returns fresh session and explicitly
selected membership facts. It exposes no HTTP handler or administrator API,
never applies migrations, and grants no workspace capabilities. Standalone
operation does not require it. Applying additive migrations and activating
hosted entry wiring and delivery remain operator steps.

Canonical workspace lifecycle is added by
[`0003_workspace_lifecycle.sql`](migrations/0003_workspace_lifecycle.sql).
Existing workspaces stay `active`; new rows default to `provisioning`, and
fresh standalone bootstrap explicitly creates an `active` workspace. Only
platform setup changes this state. The identity role can read one canonical
UUID, display name and status through a narrowly granted function; it cannot
read operational tables or write lifecycle. Admission membership reads combine
current session, membership and canonical state in one SQL observation. The
older membership method remains compatible with the identity-only schema;
rolling back to old standalone code does not prove hosted suspension safety.

[`0004_email_code.sql`](migrations/0004_email_code.sql) adds the maintained
database rate-limit schema and one non-revoked platform enrollment per canonical
workspace. Login can update only the paired verified-person/time columns;
it cannot create, revoke or redirect an enrollment. The
`@noticeos/postgres/email-code` entry exposes only code request, verification
and logout. It checks the original browser request before identity I/O, uses
an outer server's trusted peer, and releases cookies and captured delivery only
after its transaction commits. A delivery failure leaves committed protocol
state intact. No sender, route or workspace capability is activated by this
module. The facts-only reader retains its earlier schema requirements.
When Origin is absent, the maintained first-login middleware additionally
requires the original same-origin Referer; Fetch Metadata alone is insufficient.
The entry never synthesizes an Origin to satisfy that check.

Login locks rate bucket, mailbox, organization, canonical workspace and then
invitation/enrollment, in that order. Later provisioning, invitation, activation
and suspension operations must preserve the corresponding organization →
workspace → invitation/enrollment order. The identity-only canonical row-lock
function temporarily scopes the owner through the existing forced row policy
and restores the prior setting (an originally absent custom setting may return
as an empty string). It returns only status and grants no operational table
access. `scripts/postgres-email-code.test.mjs` checks maintained schema parity,
grants, native/Worker transactions and concurrency with generated credentials
and captured mail; it does not validate live delivery or proxy peer extraction.

## Hosted task directory

[`0005_task_project_directory.sql`](migrations/0005_task_project_directory.sql)
adds global control-plane ownership mappings outside the operational RLS model.
The platform role may insert immutable workspace/project/executor/credential/
database ownership and revoke a mapping. The separate task-directory role may
execute only the exact workspace/project resolver; it has no table privileges.
Customer application and identity roles cannot read the directory. These grants
create no task executor, provisioning activation or hosted deployment. Existing
clusters must explicitly prepare both new roles before applying the additive
migration; migration tooling refuses partial role bootstrap. The operational
constraint matrix excludes this schema; its native/Worker grants and lookup
contract are checked by `scripts/postgres-task-directory.test.mjs`.

## The decided model

The operator approved all eleven choices the draft asked about on 2026-09-24
(bead `ro-ujb9.76.14`; its comment is the record). As built:

1. **Two roles.** `noticeos_owner` owns every object and runs migrations;
   `noticeos_app` is what Workers and scripts connect as, owns nothing and
   cannot bypass row security. [`roles.sql`](roles.sql) creates both without a
   login; giving each a login on a real host is the operator's step. (A third,
   `noticeos_maint`, came from the review, below.)
2. **Forced row security on every table**, keyed on the per-transaction
   setting `noticeos.workspace_id` (`SET LOCAL`), the OS's own job runs and
   internet checks included. With no workspace named, every table reads empty
   and refuses writes.
3. **Stored secrets are connections with secret versions**
   (`integration_connections`, `connection_secrets`); see
   [credential custody](../../docs/06-operations.md#bootstrap-secrets-vs-integration-credentials).
4. **Existing installations are operator-only.** The development profile
   accepts disposable targets only. The approved
   [new, empty installation path](host/README.md#a-new-installation) uses
   the same frozen-schema and bootstrap helpers.
5. **The application cannot rewrite history.** A same-day report retry is a
   new revision (`current_pulses` shows the newest); a still-open alert that
   fires again appends to `flag_evidence`; a booked ledger entry never
   changes, for the owner too, and a correction is a new entry.
6. **An unknown provider price stays unknown**, never free.
7. **Revenue coverage is data**, held in `coverage_start`, `coverage_end` and
   `coverage_complete`; missing coverage is never guessed.
8. **The text site id (`example.com`-style) stays the key.**
9. **Each site's two newest insight snapshots stay; older ones move** to the
   analytical store and are never simply deleted. Two, because the site page
   reads the newest and the Wall's feed compares it with the one before (the
   operator's answer on `ro-ujb9.76.17`, 2026-09-29). A mover, as
   `noticeos_maint`, must record the move in `asset_insight_snapshot_moves` (where
   the snapshot now lives) before the row may leave, and the store refuses to
   move or remove either of a site's two newest, or to remove one whose move
   is not recorded.
10. **New raw-archive objects carry the workspace in their key**; existing keys
    stay, since they are evidence named by their hashes. A writer's rule, not a
    constraint.
11. **Names distinguish their records:** `item_dispositions`,
    `asset_insight_snapshots`, `ledger_entries`, `archive_runs`,
    `archive_objects`, `task_*`, connections and secret versions.

Decided by the operator since, on 2026-09-29: a shipped change is the ledger's
third kind (D36), every money entry names its currency (D37), and a change
entry freezes the prediction it shipped with (D38); see
[The ledger's three kinds](#the-ledgers-three-kinds).

## What the review changed

[`REVIEW.md`](REVIEW.md) asked for six changes before building. As built:

1. **Providers, metrics and checks are data.** Schema `noticeos_ref` holds
   `integrations` (the value rows store, like `ga4`, and the provider whose
   connection serves it), `metric_kinds` (an integration's metric and its
   unit) and `check_kinds`. `measurement_series`, `signal_runs`,
   `archive_runs`, `research_log`, `watch_windows` and `hygiene_checks`
   reference them by foreign key; the CHECK lists and the repeated
   metric→unit rule are gone, and the series takes its unit from its metric
   kind. The table is `integrations`, not the review's `providers`, because
   the columns that reference it hold `ga4`/`gsc` while *provider* already
   names the connected account (`google`). The vocabulary has no workspace and
   no row security; the application and maintenance only read it, and adding a
   source is a migration that inserts its rows. Closed product sets
   (severity, status, outcome, unit, booking state) stay CHECKs.
2. **Facts reference bigint identities.** `signal_runs` and `archive_runs`
   (`run_seq`), `archive_objects` (`object_seq`) and `mediavine_runs`
   (`run_seq`) key on an identity; observations, archive runs and daily
   revenue facts refer to it, and each parent's text id stays a unique
   column for lookups and imports. `capability_targets` names each monitored
   provider, revision, capability, site, target and family once; state and
   events refer to it by `target_seq`. Connections keep their uuid key (few
   rows, no text key).
3. **`noticeos_maint`** ([`roles.sql`](roles.sql)): `BYPASSRLS`, `NOLOGIN`,
   owns nothing, creates nothing, updates nothing. It reads every table,
   removes rows only where a retention rule lets them go (and the triggers
   still hold there), and records moves and exports. A job that spans
   workspaces runs as it; a job that works one workspace at a time runs as
   `noticeos_app` and names it with `SET LOCAL`. No role is a member of
   another, so the application can never become it
   ([`tests/rls-denial.sql`](tests/rls-denial.sql) proves it). Creating a
   `BYPASSRLS` role needs a superuser: a constraint on the host choice
   (`ro-ujb9.76.12`).
4. **A bounded operational store:** see [What stays in Postgres](#what-stays-in-postgres).
5. **Sites are retired, never deleted.** The application has no `DELETE` on
   `assets`; `retired` is the only exit, matching the immutable history that
   references a site. An archive-then-delete path would be a new maintenance
   operation, not built. The Tower follows it: Archive is its one way out,
   with no Delete card (operator, 2026-09-29, bead `ro-ujb9.76.4.5`).
6. **The table stays `assets`.** [D31](../../config/decisions.md) (operator,
   2026-09-23) made *site* the word a person reads and kept *asset* in code,
   URLs, tables and APIs so that nothing stored or linked changes. The APIs
   (`/api/assets`), task labels (`asset:`), config documents and every Worker
   still say *asset*, so renaming only these tables would give one concept two
   names at the store boundary — and collide `site_id` with Mediavine's own
   `site_id`. Changing it means amending D31 first.

## The review's recommendations

[`REVIEW.md`](REVIEW.md) also listed nine changes that did not block the
baseline (bead `ro-ujb9.76.19`). Each is done, with the test that holds it, or
declined, with the reason.

- **One site per domain — done.** `UNIQUE (workspace_id, domain) WHERE domain
  IS NOT NULL`; the edge case "a second site on a domain another has" is
  refused.
- **The first workspace's bootstrap — done.** An explicit runner step
  ([below](#applying-it-the-development-profile)); the runner test "bootstrap
  creates the one workspace once" holds it.
- **Keep the two unique keys that look redundant — done.** [The model in one
  page](#the-model-in-one-page) says why. The links that need them cannot be
  built without them, and [`constraints.md`](constraints.md) would change.
- **`financial_ledger`: a view, never materialized, one test per branch —
  done.** [`tests/edge-cases.sql`](tests/edge-cases.sql) "financial_ledger: one
  case per branch of its WHERE" has a case for each condition that decides
  what a month shows, and checks it is a plain view and
  that maintenance, reading every workspace at once, keeps each workspace's
  months apart.
- **Query statistics — done for development; a hosted database's is the host
  choice's.** Every throwaway cluster loads `pg_stat_statements` where the
  server build has it (CI's does), so `SELECT * FROM pg_stat_statements` shows
  what ran (the runner test "a throwaway cluster records query statistics").
  The capacity readback scans workspace rows as `noticeos_app`; its catalog
  [`tables.json`](tables.json) names each table's shape and arrival stamp.
  It uses `pg_column_size` for stored values and exposes physical database
  and relation sizes only for a single-workspace store
  ([doc 26](../../docs/26-storage-capacity.md), `ro-ujb9.76.7.4`).
  A hosted database must offer `pg_stat_statements`:
  a requirement on the host (`ro-ujb9.76.12`).
- **Numbers that count other workspaces' activity — done** (bead
  `ro-ujb9.76.21`). Each id (`flag_id`, `annotation_id`, …) is one sequence
  per table, shared by every workspace, so the store never shows it: every
  row people or other systems name also carries its workspace's own number,
  counted from 1. See [Numbers a workspace hands out](#numbers-a-workspace-hands-out);
  the edge cases and the model's live test hold it.
- **Insight and task payloads in object storage — declined.** The store keeps
  each site's two newest insight snapshots, each under 1 MB, and two days of
  task-board photographs. Revisit only if a site ever keeps more snapshots
  than that.
- **Replace `integration_leases` with row locks — declined.** A lease must
  outlive a transaction: a Worker holds it through provider calls that take
  minutes, and renews it (Mediavine every ten minutes). A row lock lasts one
  transaction and an advisory lock one session, and holding either through a
  provider call pins a pooled connection (Hyperdrive's transaction pooling,
  D27). The table also keeps each provider's cooldown, cached site list and
  blocked-sign-in state. The edge case "a lease has one holder at a time"
  proves the Workers' one-statement take works on Postgres.
- **Partitioning — declined at this scale.** About 250 MB a year today, and the
  13-month window keeps `signal_observations` near 660,000 rows at today's
  1,678 a day. Partition by month only past about 10 million rows; nothing
  links to that table, so adding the day to its key then is one migration.

## The model in one page

- **Every table carries `workspace_id`**, and it leads every primary key,
  unique key and foreign key between tables. A row cannot point at another
  workspace's row, because the parent it names does not exist in its own
  workspace. Foreign-key checks skip row security in Postgres, so this is the
  guard that holds even there.
- **Forced row security** on every table: the owner obeys it too, except
  that it may read the list of workspaces (below). Views run with the
  caller's rights (`security_invoker`), so they filter the same way.
- **One self-hosted install is one workspace**, created at bootstrap. The
  private installation imports into one workspace the operator creates first.
  The store names it: `noticeos.only_workspace()` returns its id while
  exactly one workspace exists, and NULL while there are none or several. It
  runs with its owner's rights, the only function that does, and the owner
  reads the list through one read-only policy, `owner_lists_workspaces`: the
  application cannot, since a transaction that names no workspace sees none.
- **Types say what a value is:** instants are `timestamptz`, provider and
  reporting days are `date`, an accounting month is its first day, money is
  `bigint` minor units with a currency, provider prices are exact six-decimal
  dollars with a known/unknown state, metric values are finite doubles whose
  unit their metric kind names. Report envelopes, insight payloads and config
  documents are `json` (kept byte for byte); everything the store queries is
  `jsonb`.
- **New tables** make hidden structure explicit: `workspaces`,
  `measurement_series` (a site's metric from one provider resource under one
  reporting zone, bead `ro-ujb9.70`), `flag_evidence`, `watch_window_readings`
  (one row per evaluated offset, instead of a growing JSON array),
  `archive_objects` (each stored object once, however many runs reuse it),
  `capability_targets`, `connection_secrets`, `asset_insight_snapshot_moves`
  and `analytical_exports`.
- **A child names its parent by a bigint identity**; a parent's text id is a
  unique attribute. Two unique keys look redundant and are not:
  `pulses (workspace_id, asset_id, pulse_id)` and
  `mediavine_runs (workspace_id, run_seq, asset_id, site_id)` are what let a
  flag or a daily fact name its parent *and* that parent's site, so the two
  cannot disagree. Do not drop them as duplicates.
- **A site is never deleted by the application**; it is retired.
- **Each site stores its place in the list** (`assets.list_position`), and
  every list of sites is ordered by it
  ([below](#numbers-a-workspace-hands-out)).
- **Readers show a workspace's own numbers**, never the bigint identities
  ([below](#numbers-a-workspace-hands-out)).

## Numbers a workspace hands out

A hosted customer who saw alert 1000 and then alert 1030 would learn that 29
alerts fired for someone else, if the number came from a sequence every
workspace shares (bead `ro-ujb9.76.21`). So the identities (`flag_id`,
`pulse_id`, …) stay the store's own keys, used by every link between rows,
and **never leave it**. Every row that people or other systems name carries
a second number, its workspace's own: 1, 2, 3 … within one workspace, unique
there, never handed out twice.

**What the readers show** (`ro-ujb9.76.6` builds them on this): wherever a
row's id leaves the store — an API response or route (`PATCH /api/flags/:id`),
the Wall and its feed, task-hub labels (`key:`, `noticeos_key`), MCP answers —
it is this number. So is a pointer another row stores as text:
`watch_windows.ref` naming an annotation, `notifications.subject_ref` naming
an alert. A route that receives one finds its row by `(workspace_id, number)`,
a unique key.

| Table | Number readers show | Internal identity |
|---|---|---|
| `flags` | `flag_number` | `flag_id` |
| `pulses` (and `current_pulses`) | `pulse_number` | `pulse_id` |
| `annotations` | `annotation_number` | `annotation_id` |
| `ledger_entries` | `entry_number` | `entry_id` |
| `financial_ledger` (view) | `entry_number`; a month of Mediavine daily estimates shows minus its first `daily_number` | `entry_id` |
| `mediavine_daily` | `daily_number` | `daily_id` |
| `reclamation_targets` | `target_number` | `target_id` |
| `research_log` | `research_number` | `research_id` |
| `config_changes` | `change_number` | `change_id` |
| `hygiene_checks` | `reading_number` | `reading_id` |
| `job_runs` | `job_run_number` | `job_run_id` |

Other tables' identities (`tune_id`, `series_id`, `observation_id`, the
`run_seq`s, …) name nothing outside the store; runs and snapshots are named
by their text ids. A table whose rows start being named outside gets a number
the same way, in the migration that says so.

**How they are handed out.** One mechanism for all of them: a counter row per
workspace and number column (`workspace_counters`), advanced by the trigger
`number_in_workspace` inside the inserting transaction. The row lock that
takes makes a second writer of the same workspace's same number wait until
the first commits or rolls back, so two transactions never get one number,
and a rolled-back or refused insert gives its number back. Another
workspace's counter is another row, which neither waits nor counts. A counter
never moves back (`workspace_counter_never_moves_back`), so a number whose row
left under retention is still never reused. An insert that `ON CONFLICT` finds
its row already there has used a number, so a workspace's numbers may skip,
only ever for its own writes. A sequence per workspace was not chosen: it would
be a schema object per customer, created at signup, and it skips a number on
every rollback.

**Who picks a number.** The application never does: a row it inserts with
one is refused, and it cannot change one. Only the owner may supply a
number during explicit provisioning or recovery; the counter advances past
the largest by itself, preserving the numbers existing links name.

**A site's place in the list** (`assets.list_position`, bead `ro-ujb9.76.52`)
comes from the same counter. The operator reads the TV by position, so the
order of sites is a stored fact, never an accident of when or under what id a
site was written:

- A new site takes the next place, at the end; two added at once take two
  places, one after the other.
- Retiring or restoring a site keeps its place. A place is unique in its
  workspace and never below 1.
- The application changes a place only by a move: the site takes the place
  of the site it is moved onto, and the sites between move one place toward
  the place it left. The move locks the counter row, as a create does, and
  deals the places it spans out again, never a new one.

## The ledger's three kinds

`ledger_entries` holds revenue, cost and change, as
[docs/00](../../docs/00-objective-and-roi.md#the-ledger) lists them (D36,
bead `ro-ujb9.76.27`).

| Columns | Revenue and cost | Change |
|---|---|---|
| `asset_id`, `period_month`, `family` | Required | Required: the month it shipped, and its change class (`content-data`, `copy`, `template`, `feature`, `infra`) |
| `currency` | Required: its amount's (D37) | Required: its prediction's (D38) |
| `amount_minor`, `booking_state` | Required | Empty: a change books no money |
| `predicted_monthly_value_minor`, `predicted_success_chance`, `predicted_cost_minor`, `predicted_days_to_signal` | Empty: money predicts nothing | Required: the prediction it shipped with (D38) |
| `ref` | Optional; a cost's names the change or run it was spent on | Required: the change's own id |
| `coverage_start`, `coverage_end`, `coverage_complete` | Optional | Empty |

- **A change is booked once, when it ships**: one first entry per change id
  (`ledger_entries_one_per_change`). A cost names the change it was spent on
  by the same id.
- **A change freezes the prediction it shipped with** (D38, bead `ro-qfcg`):
  the value per month and the full cost in integer minor units of its
  currency, the chance of success (0 to 1) and the days until a signal can be
  read (at least 1). Nothing edits it: no entry takes an update, and a
  correction of the change must repeat it. Its kill criterion is its watch
  window's (`watch_windows.thresholds` and `check_offsets`), not a column here.
- **A change has no amount.** When it ships it has no realized value, and a
  closed watch window does not give it one: docs/03 books a realized value
  only through its methods, shrunk and with an interval. That value, its
  interval and its method will arrive as an entry superseding the change's,
  through the correction chain below; the lane is not built, so no column
  holds them yet.
- **A correction is a new entry**, as for money: the same site, month, kind,
  class and change, the same prediction, and one successor per entry. The
  chain's newest entry is the change's current record; its class, month and
  prediction are fixed when it is booked.
- **The financial view never counts a change**: `financial_ledger` reads
  revenue and cost only, since the revenue a change earns is already booked.

## Constraints: what the store itself refuses

The full per-table matrix is [`constraints.md`](constraints.md), generated
from what Postgres builds. Beyond types, required columns and the
per-workspace keys, the baseline guards (`ro-ujb9.71`):

- **JSON shapes.** Malformed JSON never enters (`json`/`jsonb`). A document
  its writer always builds as an object is checked to be one: report
  envelopes, insight payloads, check details, task photographs, watch
  scopes, thresholds and readings; a settings document is an object or, for
  a register that is a list (`config/pull.json`), a list. Lists stay lists
  (capabilities, change operations, secret field names, closed task ids).
- **Ranges and finite numbers.** Counts and costs are never negative; no
  fractional number is ever NaN or infinite (a metric value, a hygiene
  reading, a watch delta, a tune's values, a provider cost, an alert's median
  open age), and `scripts/postgres-model.test.mjs` proves it for every such
  column Postgres builds; a split never exceeds its whole
  (`errors + warnings <= open`).
- **Dates and windows.** A collection window never ends before it starts; its
  first provisional day never follows its end (it may precede the start: GA4
  settles back from the end); a run never finishes before it starts; a
  watch's baseline ends by its registration day; an accounting month is its
  first day.
- **Shared vocabulary.** An integration, metric or check a row names must be
  in `noticeos_ref`, and a series or a watch must name a metric its
  integration reports.
- **Same owner.** Every link carries the workspace. A flag cites only its own
  site's report; a daily revenue fact belongs to its own site's run; an
  observation belongs to the series its own successful run measured (same
  site, provider, property and zone — two parents that exist but disagree are
  refused, by trigger).
- **Non-empty identifiers.** A run, snapshot, window, lease, event or document
  id is never `''`.
- **NULL identity, decided per column.** Every nullable column in a unique key
  or a link says what its NULL means in [`model.json`](model.json)
  `nullIdentity`: one value (`NULLS NOT DISTINCT`: the whole-workspace alert
  count, an account-level capability, a series with no zone), many (a
  hand-booked ledger entry has no external id), excluded (only corrections
  take part in the one-successor rule), or no parent (an alert raised without
  a report, research about no one site). The model's test compares the list
  with what Postgres built.

Left unconstrained on purpose: references into the task hub
(`watch_windows.readback_bead`, `flags.hypothesis_ref`, `flags.incident_ref`),
which is another store (D32); research object keys, which may name a
checkpoint rather than an archive object; a notification's `subject_ref`,
which names a flag or a provider; a settings change, which outlives its
document; and `flags.rule_inputs`, which may hold any JSON because legacy rows
do and readers treat a non-object as absent.

## What stays in Postgres

The operational store keeps what the Tower reads live (D25); history past its
window lives in the analytical store (Parquet read with DuckDB, `ro-ujb9.67`).
[`model.json`](model.json) `retention` states each window and the destination
of older records. Export and snapshot-move jobs are tracked in
`ro-ujb9.67` and `ro-ujb9.76.66`; these schema rules do not run those jobs.

| Table | Postgres keeps | Past that |
|---|---|---|
| `signal_observations`, `signal_runs`, `archive_runs`, `archive_objects`, `hygiene_checks`, `egress_checks` | 13 months | Its analytical dataset |
| `asset_insight_snapshots` | Each site's two newest | The insight dataset, one recorded move per snapshot |
| `job_runs` | 90 days | Dropped; the runner's own log is the record |
| `task_snapshots` | 2 days | Dropped; the task hub is the authority |
| `task_daily_counts`, `connection_daily_counts`, `connection_status_daily_counts`, `alert_daily_counts` | 400 days | Dropped, as today |
| Everything else (reports, alerts, money, settings, sites, notifications, research, watches) | Every row | — |

Moved history is never simply deleted. The export job records, per workspace
and table, the last day its dataset covers (`analytical_exports`), and the
trigger `history_leaves_only_when_exported` refuses to remove a row that is
inside its window or after that day, for maintenance too. Its arguments are
the same column and window `retention` states; the model's test compares them.

History outside Postgres needs its own backup custody; a database dump contains
only rows still in the operational store. The installation can declare its
analytical history source for both native and container backups through
[`host-backup.json`](../../config/host-backup.README.md#analytical-history).
Published manifests and their complete Parquet closure travel together; rotation
preserves held-table files until another verified retained set covers them.
Backup completeness does not replace approved export and restore readback before
operational deletion. The completed D1 cutover's frozen
source and recovery instructions are private installation material at
`installation/recovery/d1-cutover/README.md`, pinned to commit
`a85e82837411729bc15b5cf1c2feacc7de209083`. It is outside active imports and
test discovery. Permanent transition history is retained separately from
ordinary backup rotation.

## Application revision rules

The complete table and view list comes from [`model.json`](model.json).
Its revision rules are compared with the application's actual grants, column
by column; retention and maintenance privileges are checked separately.

<!-- matrix:start (generated by node scripts/postgres-docs.mjs --write) -->
| Postgres table or view | What the application may do | Rule |
|---|---|---|
| `alert_daily_counts` | insert, update, delete | One row per site per day, upserted; swept after 400 days. |
| `analytical_exports` | read-only | Read-only for the application: the export job records, as noticeos_maint, the last day each dataset covers. |
| `annotations` | append-only | Append-only. |
| `archive_objects` | append-only | Append-only; objects are immutable. |
| `archive_runs` | append-only | Append-only. |
| `asset_insight_snapshot_moves` | read-only | Read-only for the application: the mover records moves as noticeos_maint. A move names a stored snapshot by its site and hash, never one of the site's two newest. |
| `asset_insight_snapshots` | append-only | Append-only for the application; republishing identical content is a no-op. Older snapshots move as maintenance. |
| `assets` | insert; update only status, sense_only, display_name, list_position, updated_at | Identity never changes; a site is retired, never deleted, since history references it. A new site takes the next place in the list from the workspace's counter; a move deals the places of the sites it spans out again (ro-ujb9.76.52). |
| `capability_targets` | append-only | A monitored target, once named, is permanent; state and events refer to it by target_seq. |
| `config_changes` | append-only | Append-only. |
| `config_documents` | insert; update only body, version, updated_at, updated_by | Versioned; every change also appends config_changes. |
| `connection_daily_counts` | insert, update, delete | One row per source per day, upserted; swept after 400 days. |
| `connection_secrets` | insert, delete | A rotation writes the next version and removes the old one; ciphertext is never rewritten in place. |
| `connection_status_daily_counts` | insert, update, delete | One row per day, upserted; swept after 400 days. |
| `counter_readings` | insert, update | Current state, replaced in place. |
| `current_flags` (view) | read-only view | Every alert a retry did not replace, with its severity, message and inputs from its newest flag_evidence reading. |
| `current_pulses` (view) | read-only view | The newest revision of each day's report, numbered by the day's first revision (day_number). |
| `egress_checks` | append-only | Append-only. |
| `financial_ledger` (view) | read-only view | What financial readers read: money only, never a change entry. |
| `flag_evidence` | append-only | Append-only. |
| `flag_tunes` | append-only | Append-only. |
| `flags` | insert; update only disposition, disposition_at, disposition_note, snooze_until, ack_expiry, hypothesis_ref, incident_ref, resolved_at, replaced_by_pulse_id | The occurrence is fixed; only its disposition and resolution move, or, untouched, a same-day report retry replaces it. |
| `hosted_job_attempts` | insert; update only state, finished_at | Attempt identity and start are fixed; terminal result is recorded after execution. |
| `hosted_job_occurrences` | insert; update only state, attempt, lease_id, lease_expires_at, effect_step, steps, updated_at | Workspace job identity and input digests are fixed; fenced execution state and bounded checkpoints evolve. |
| `hosted_scheduler_status` | insert; update only service_id, session_id, observed_at, running, payload | Workspace-owned current scheduler observation and timer lease; execution ownership remains in the fenced job journal. |
| `hygiene_checks` | insert; update only observed_at, status, value_num, detail | A same-day re-run replaces that day's reading; earlier days never change. |
| `integration_capability_state` | insert, update | Current state per target, rewritten in place. |
| `integration_connections` | insert; update only scope, updated_at, last_used_at, last_ok_at, last_error, account, scopes, connected_at, expires_at, expiry_source, balance_usd, balance_seen_at; delete | A disconnect removes the connection and its secrets. Its non-secret facts (whose account, when it expires, the last credit seen) change in place, never the secret. |
| `integration_health_events` | append-only | Append-only. |
| `integration_leases` | insert, update, delete | Coordination state. |
| `item_dispositions` | insert; update only status, updated_at, note; delete | Display state; an undo removes it. |
| `job_runs` | insert, delete | Written once; swept after 90 days (retention). |
| `ledger_entries` | append-only | Immutable; a correction is a new entry. Three kinds (D36), each naming its currency (D37): revenue and cost name money and its booking state; a change names a shipped change by its id and class and the prediction it shipped with (value per month, chance of success, full cost, days to signal), is booked once, books no money, and a correction of it repeats that prediction (D38). |
| `measurement_series` | append-only | A series, once named, is permanent. |
| `mediavine_current_daily` (view) | read-only view | The newest daily fact per site and day. |
| `mediavine_daily` | append-only | Append-only; the newest per day is current. |
| `mediavine_runs` | append-only | Append-only. |
| `mediavine_sites` | insert, delete | A fixed mapping, replaced by delete and insert. |
| `mediavine_state` | insert, update, delete | Retry state. |
| `notifications` | append-only | Append-only; the unique key is the dedupe. |
| `pulses` | append-only | A retry is a new revision. |
| `reclamation_targets` | insert; update only status, status_at, outcome_note, last_verified_at, updated_at | What the research found is fixed; the funnel status moves. |
| `research_log` | append-only | Append-only. |
| `signal_observations` | append-only | Append-only; a revised value is a new row under a later run. |
| `signal_runs` | append-only | Append-only. |
| `task_daily_counts` | insert, update, delete | One row per project per day, upserted; swept after 400 days. |
| `task_operation_receipts` | insert; update only state, attempt, result, started_at, finished_at | A task write's idempotency key, bound request and operation identity are fixed; its attempt state and recorded outcome evolve. |
| `task_snapshots` | insert; update only captured_at, payload; delete | An unchanged board re-stamps its photograph; a replaced one keeps only what the Wall feed reads; swept after 2 days. |
| `watch_window_readings` | append-only | Append-only, one per offset. |
| `watch_windows` | insert; update only status, outcome, closed_at, outcome_note, last_checked_at, readback_bead, readback_posted_at | The registration is fixed; the close is one-way. |
| `workspace_counters` | insert; update only last_number | The last number each workspace handed out per numbered table, and the last place in its list of sites, started and advanced by the numbering trigger in the inserting transaction; it never moves back (ro-ujb9.76.21, ro-ujb9.76.52). |
| `workspace_mutation_audit` | append-only | Append-only actor evidence recorded in the same transaction as an asset or finding effect. Historical and standalone authors stay explicitly unknown; no free-form values or notes are copied. |
| `workspaces` | read-only | Provisioned by the owner role; new hosted workspaces start provisioning, and only platform setup activates or suspends them. Fresh standalone bootstrap creates active. The application only reads its own. |
<!-- matrix:end -->

## Edge cases and the outcome each one gets

[`tests/edge-cases.sql`](tests/edge-cases.sql) runs each of these against the
real schema, as the application role unless the case says maintenance:

| Case | Outcome |
|---|---|
| A correction of the same site, month, kind, family and currency | Accepted; exactly one current entry per chain |
| A second correction of one entry, or one that changes month | Refused |
| The same export booked twice | Refused by its external id |
| Amounts past 2^53 cents, negative adjustments | Exact; accepted |
| A lower-case currency, a mid-month period | Refused |
| A provider price below a cent; an unknown price | Exact; unknown is NULL and excluded from the known subtotal |
| An unknown price stored as 0 | Refused |
| A 20-day imported estimate beside 30 days of daily estimates | The daily month is shown instead |
| A month of daily estimates with nothing booked | One estimate with a negative id |
| Daily estimates short of an import's coverage end (or of the month's end, coverage unknown), missing the 1st, or missing a day | The import stays |
| A reconciled Mediavine figure; a payment under another source correcting a Mediavine estimate | Shown; no daily stand-in |
| Other ad revenue beside a Mediavine estimate; a day fetched twice | Kept beside the daily month; counted once, at its newest amount |
| Maintenance reading every workspace's ledger at once | Each workspace's months stay its own |
| A change entry with its class, id and prediction, and no money; a cost naming the change it was spent on | Accepted |
| A change entry without its prediction or any part of it, or with a chance outside 0 to 1 (NaN included), a negative cost or a signal on the day it ships | Refused |
| Revenue or cost carrying any part of a prediction | Refused |
| A change entry naming an amount, a booking state or a coverage, or naming no change or no currency; a change under a money family; a cost under a change class; revenue or cost with no amount, currency or booking state | Refused |
| The same change booked twice; a correction of a change naming another change, class or month, or stating another prediction; a second successor | Refused |
| A correction of a change entry with the same site, month, class, change and prediction | Accepted; one current entry per change |
| The application or the owner editing a booked change's class or prediction | Refused |
| The financial view beside a change entry | Money only: the change is never counted |
| Taking a held lease, renewing or releasing another holder's | Refused; an expired lease is taken over |
| Credential rotation for the same property | Same series |
| A new property or reporting zone, even with equal values | A new series; both values kept |
| A same-day report retry | Revision 2; the newest is current, under the day's one number |
| The earlier revision's alerts nobody touched | Replaced by the retry: in no list, count or action; the ones the operator touched stay |
| Replacing a touched alert; resolving or dispositioning a replaced one; an alert replaced by its own report | Refused |
| A still-open alert read after later readings | Its newest reading's severity, message and inputs; its row keeps the first |
| Malformed report JSON, an impossible date, an envelope that is not an object | Refused |
| A settings document that is not JSON, or neither an object nor a list; a change filed under a file path | Refused |
| A settings document that is a list (`config/pull.json`) | Accepted |
| A lease flag of 7, an insight payload that is a list, an upper-case hash | Refused |
| A window that ends before it starts; a provisional day after the window | Refused |
| A one-day GA4 window whose provisional day precedes its start | Accepted |
| An observation under another property's series, or under a failed run | Refused |
| An alert citing another site's report; revenue under another site's run | Refused |
| "No page" written as NULL in the reclamation list | Refused; `''` means no page |
| A reading that was not taken; a quiet night | NULL, never zero |
| NaN or an infinity (a reading, a provider cost, a median open age), a negative count, more errors than open alerts | Refused |
| A watch offset read twice | Refused |
| Each writer's own change: acknowledging and resolving an alert, a same-day hygiene re-run, closing a watch, saving settings, upserting a day's counts (the whole-workspace row included), upserting an account-level capability, replacing counters, leases and retry state, re-stamping and sweeping task photographs, undoing a mark, retiring a site | Accepted |
| A metric an integration does not report, an unknown integration, a watch on a metric its integration does not report, an unknown check | Refused by the shared vocabulary |
| The application adding to the shared vocabulary | Refused |
| The application deleting a site, even one with no history; a second site on a domain another has | Refused |
| The application moving or removing an insight snapshot, or removing an observation | Refused |
| Maintenance moving or removing either of a site's two newest insight snapshots, a move with the wrong hash, removing an unmoved snapshot | Refused |
| Maintenance removing the next-older snapshot once its move is recorded; the former second-newest, once a newer one arrives and its move is recorded | Accepted |
| Maintenance removing an observation inside its 13-month window, even one already exported | Refused |
| Maintenance removing an old run the export has not covered; the same run once its export is recorded | Refused; then accepted |
| Maintenance changing any row, adding one, removing a site or money | Refused |
| Each workspace's first row of every numbered table; B's first alert, whose shared identity is not 1 | Number 1 |
| Rows written in A; B's next number | A's numbers run on; B's is unchanged, and B sees only its own counters |
| An insert refused after it was numbered | Its number goes to the next insert |
| The application bringing its own number, changing one, moving a counter back or advancing another workspace's | Refused |
| The owner supplying a number during recovery; the same number again; the store's next | Accepted; refused; past it |
| The owner bringing a site's place; the next new site; retiring a site | Accepted; the place after it; the place kept |
| The application choosing a new site's place; two sites at one place; a place below 1 | Refused |
| A move: the sites it spans above the counter, then each at its new place | Accepted; the counter unchanged |

## Applying it: the development profile

`pnpm postgres:dev` ([`scripts/postgres-migrate.mjs`](../../scripts/postgres-migrate.mjs))
applies these migrations to a development database and to nothing else. It is
not the live store's tool (that is the operator-only `pnpm postgres:migrate`,
[below](#applying-it-to-an-installations-own-database)), and nothing runs it
but this command: no runtime, restart
or deploy loads it, so a restart never applies schema.

```sh
pnpm postgres:dev status --dir /tmp/noticeos-dev   # applied, pending or changed; only reads
pnpm postgres:dev apply  --dir /tmp/noticeos-dev   # every pending migration, in one transaction
pnpm postgres:dev bootstrap --dir /tmp/noticeos-dev --slug main --name "My sites"   # the one workspace, once
pnpm postgres:dev new add_example_table            # the next numbered file, from a template
```

| Target | What happens |
|---|---|
| `--dir` naming a missing or empty folder | A throwaway cluster is created there; each command starts it on a private unix socket (no TCP port) and stops it again |
| A test run's cluster (`scripts/postgres-test-cluster.mts`) | Also listens on 127.0.0.1 at one port, for `noticeos_app` alone, by a password made at its start and held only in memory: the way a Worker's Hyperdrive binding reaches it ([the port pattern](../../docs/briefs/2026-09-29-postgres-port-pattern.md)) |
| `--dir` naming a folder this profile made | Reused |
| `--dir` naming any other non-empty folder | Refused untouched |
| `--url` on this machine (localhost, a loopback address or `?host=/socket/folder`), database name ending in `_dev`, marked for development | Used |
| `--url` naming another host, a password, a parameter other than `host=` and `user=`, or a name not ending in `_dev` | Refused before connecting |
| `--url` naming a database not marked for development | Refused before any write. To mark a throwaway database: `ALTER DATABASE noticeos_dev SET noticeos.profile = 'development'` |

**A run.** `status` reads in a read-only transaction. `apply` takes the
runner's advisory lock (a second runner is refused, not queued), checks the
applied set is the one it planned against, creates the three roles if this
development database has none of them, applies each pending file as
`noticeos_owner` and records its SHA-256 in `noticeos_migrations.applied` —
all in one transaction, so a failure anywhere leaves the database exactly as
it was and names the migration that failed. With nothing pending it changes
nothing. A recorded migration whose file changed, a recorded one whose file is
gone, or a pending one older than the newest applied stops the run before it
starts: a correction is the next migration, never an edit.

**Bootstrap.** A new install has one workspace, created once after the first
apply: `bootstrap` counts existing workspaces as `noticeos_owner` (through
its one read policy on the list, `owner_lists_workspaces`) and, if there are
none, inserts the new one inside its own id, under an advisory lock so two
bootstraps cannot both create one. A second bootstrap creates nothing and
names the first. It needs no other role, so the same bootstrap runs on an
installation's own database, where the session is the owner's own login
([below](#applying-it-to-an-installations-own-database)). Nothing is copied from its output: the Workers and scripts
ask the store for the one workspace (`store.onlyWorkspace()` in
[`packages/postgres`](../../packages/postgres/README.md#using-it), through
`noticeos.only_workspace()`), so a new install needs no id in a file or a
binding. Until the bootstrap runs, or once a second workspace exists, the
store names none and no transaction opens.

**Writes on the application's behalf** go through `inWorkspace` in
[`scripts/postgres-dev.mjs`](../../scripts/postgres-dev.mjs): one explicit
transaction that sets `ROLE noticeos_app` (the owner only to provision a
workspace), `noticeos.workspace_id` and `TimeZone = UTC` with `SET LOCAL`,
runs the SQL and an optional read, and commits, or rolls back whole on any
error. Values cross as text and are cast in SQL, and a read comes back as the
server's own text through COPY, so money past 2^53, six-decimal prices,
microsecond times and doubles read back exactly and NULL stays apart from the
empty string; a JavaScript number that is not a safe integer is refused
before anything is sent.

**Credential custody.** The profile holds no secret. A throwaway cluster
trusts only its owner's private socket; a URL carrying a password is refused
(use a local trust or peer login). Every psql child runs with the `PG*`
environment and `DATABASE_URL` removed and with no password or service file,
so only the checked command line decides where it connects. Nothing here reads
`.dev.vars`, `.dev.secrets.json`, the bootstrap secrets or Wrangler, and the
OS's own login and credential handling are unchanged. The runner's
connections are its own, never the application's pool.

## Applying it to an installation's own database

*Bead `ro-ujb9.76.34`. **Operator-only.** Independently proven on throwaway
clusters before the approved cutover. DB migrations for existing installations
remain operator-only forever ([AGENTS.md](../../AGENTS.md)). The approved
[`pnpm start` exception](host/README.md#a-new-installation) uses the same helpers
only for a provably new, empty installation; it does not apply to managed startup.*

`pnpm postgres:migrate` ([`scripts/postgres-apply.mjs`](../../scripts/postgres-apply.mjs))
is the development runner pointed at a real database. It calls the same code,
so every guarantee of [a run](#applying-it-the-development-profile) holds:
the lock, one transaction, a hash per file, the refusal of a changed, missing
or out-of-order migration, and the bootstrap's lock.

```sh
pnpm postgres:migrate status    --database noticeos                        # only reads
pnpm postgres:migrate apply     --database noticeos --confirm noticeos     # prints the plan, then applies
pnpm postgres:migrate bootstrap --database noticeos --confirm noticeos --slug main --name "My sites"
```

| It | How |
|---|---|
| Reads before it writes | `status` reads and prints each migration as applied, pending or changed, the workspaces, and what stops an apply. `apply` and `bootstrap` print the same plan first |
| Needs the database named twice | `--database`, and `--confirm` with the same name. Without it, or with another name, nothing changes |
| Refuses a development database | A name ending in `_dev`, before connecting; a database marked `noticeos.profile = 'development'`, before any write. It names `pnpm postgres:dev` instead |
| Runs as `noticeos_owner` | The session must be the owner's own login. The roles and the database come first, from the Postgres service's first start ([step 2](host/README.md#the-steps)); it never creates a role or a database, and refuses where one is missing or the owner may not create schemas |
| Applies only frozen migrations | A pending migration [`frozen-migrations.sha256`](frozen-migrations.sha256) does not list stops the run, and so does a frozen file that changed ([below](#changing-the-schema)) |

**Connecting.** It needs psql alone on the machine, not a Postgres server
(bead `ro-ujb9.76.39`): the database may run in a container or at a provider.
The installation's Compose service ([`host/`](host/README.md)) needs a
password, so it gets `--url-from <VARIABLE>`: the variable, named on the
command line, holds `postgresql://noticeos_owner:<password>@<host>:<port>/<name>`
(`pnpm postgres:secrets` writes it to `db/postgres/host/secrets/owner.url`),
with at most `sslmode`, `sslrootcert` and `channel_binding` besides. A server
installed on the machine itself can instead admit the owner on its local
socket by a peer login with no password: nothing more for psql's own socket,
or `--socket <folder>` and `--port <n>` for another. The command reads no
other variable (never `DATABASE_URL` by itself), refuses a URL naming another
login or database, passes the password to psql only in its environment, and
prints `***` wherever it would repeat it. Every psql child otherwise runs with
the development profile's clean environment.

**The one workspace.** A new installation needs exactly one workspace
before its first use. `bootstrap` creates it once with the development
bootstrap's own code. The application resolves it from the store, never from
an id copied into a file or binding.

**Exit codes:** 0 done (for `status`: nothing stops an apply), 1 failed and
rolled back (for `status`: something stops an apply), 2 refused, nothing
changed, 3 no Postgres tools on this machine.

The managed runtime, restart and deploy cannot load the schema helper.
Only explicit operator tools, tests and the approved
[new, empty installation setup](host/README.md#a-new-installation) may use it.
The import-graph guard in
[`scripts/postgres-migrate.test.mjs`](../../scripts/postgres-migrate.test.mjs)
checks those boundaries and catches planted runtime entrypoints.
`pnpm os:deploy` holds a commit that opens this store against the database's
record (bead `ro-ujb9.76.7.1`): it refuses a migration the database has not
applied, printing `pnpm os:stop` → this command's `apply` → `pnpm os:start`,
and one it applied with another SHA-256. It reads the record in a READ ONLY
transaction as the application login, through the address the runner starts
with, and loads neither this command nor the runner
([Merging is not deploying](../../scripts/README.md#merging-is-not-deploying--pnpm-osdeploy)).

## Changing the schema

`0001_baseline.sql` is frozen (2026-09-30, bead `ro-ujb9.76.55`): the last
table unit of the port had landed, and
[`frozen-migrations.sha256`](frozen-migrations.sha256) records its hash. It
never changes again. Every later change is the next numbered migration
(`pnpm postgres:dev new <name>`), frozen the same way once a kept database
applies it: whoever applies it first runs, from this folder,
`shasum -a 256 migrations/<file>.sql >> frozen-migrations.sha256` and commits
the line. `scripts/postgres-model.test.mjs`
fails while a listed file's hash differs, and it checks the operational model
against the schema the whole set of migrations builds, however many there
are (bead `ro-ujb9.76.20`).

**Before a real database applies a migration, it is frozen.**
`pnpm postgres:migrate` refuses a pending migration the list does not hold,
and prints the line to run. The order is: freeze the pending migration
(the `shasum` line above), commit and verify it, then explicitly apply. The
command never writes the list itself: the freeze is a commit, reviewed and tested
like any other, and a command that edited the repository would leave every
installation's checkout changed.

**A migration keeps every app version eligible for rollback working**
(operator, 2026-09-30, `ro-ujb9.76.68`). The previous code runs on the new
schema from the apply until the deploy (`pnpm os:stop` → `pnpm postgres:migrate
apply` → `pnpm os:start` → `pnpm os:deploy`), and again after a rollback, which
`pnpm os:deploy` allows while the database has a migration the commit does not
carry (bead `ro-ujb9.76.7.1`). So a change that would break it, such as a
dropped or renamed column, is split: add in one migration, remove in a later
one, once no commit a deploy could go back to still uses it. App rollback retains
the updated database; it never reverses a migration. This compatibility rule
does not authorize applying a migration.

## How it is proved

The [index purposes and plan proofs](indexes.md) explain the explicit indexes
and the nonduplicated observation keys against the current PostgreSQL readers.

`pnpm test:scripts` runs the proofs of the model, the runner and the
operator's command (below), and
[`scripts/postgres-test-cluster.test.mjs`](../../scripts/postgres-test-cluster.test.mjs)
proves a test run's loopback cluster: over TCP only `noticeos_app` gets in, and
its password is in no file. A machine that cannot start a Postgres 15+ server
skips their live parts with the reason; `NOTICEOS_REQUIRE_POSTGRES=1` makes
them required. CI puts PostgreSQL 18's server binaries on PATH before
`pnpm -r test` and sets it for that and for `pnpm test:scripts`, so there they
always run (beads `ro-ujb9.76.15`, `ro-ujb9.76.35`;
`scripts/ci-contract.test.mjs` keeps both in the workflow).

Fresh throwaway clusters on PostgreSQL 17+ use the builtin `C.UTF-8` locale,
matching the pinned fresh-install host. The runner proof reads the database's
locale provider and locale, then checks default ordering of non-ASCII text.
PostgreSQL 15 and 16 remain supported locally without the newer initdb flags
(bead `ro-ujb9.76.33`).

`scripts/postgres-upgrade.test.mjs` restores a synthetic PostgreSQL 17 dump
into PostgreSQL 18 and compares every row, sequence and operational constraint.
It also checks workspace isolation, immutable ledger entries and the next
workspace number after restore. CI supplies its old binaries through
`NOTICEOS_TEST_POSTGRES17_BIN`; no installation is discovered
(bead `ro-ujb9.76.83`).

**Shared memory** (bead `ro-ujb9.76.25`). Each running server holds one
System V shared-memory segment, and a machine has few (macOS: 32). A
throwaway start therefore refuses where this process may not list segments,
as in an agent's sandbox, which lets a server make one and then refuses it
to the server, leaving it behind; the proofs skip there. Before it starts,
it removes the segments dead servers left: this user's, attached by nobody,
made by a process that has exited, of a server's size and mode, logging
each. Every server is stopped by its own `close()`, and on exit, SIGINT,
SIGTERM or SIGHUP. SIGKILL lets a process run nothing, so the process that
starts a server also starts a watchdog beside it
([`scripts/postgres-watchdog.mjs`](../../scripts/postgres-watchdog.mjs), beads
`ro-ujb9.76.26` and `ro-ujb9.76.29`): detached, reading from a pipe only that
process holds one line per server, written before `pg_ctl start` runs, and
another once the start returns. When the pipe closes, however the process
ended, the watchdog gives each of its servers still running an immediate
shutdown (the SIGQUIT `pg_ctl stop -m immediate` sends), on which the server
removes its segment. A server counts as its own only while the folder's
`postmaster.pid` names it as listening in the private socket folder that
process made for it, so a server started again in that folder is left
running. A server whose start had not returned yet may not have written that
file, so the watchdog waits for it, up to 30 seconds, while its socket folder
is still there. The sweep above stays the second line.

[`scripts/postgres-model.test.mjs`](../../scripts/postgres-model.test.mjs), the model:

- **Always:** every table and view the migrations build has a revision rule
  in `model.json`, over real columns. The whole migration set is read in order
  through each later `ALTER`, `RENAME` and `DROP`. Migrations are numbered
  without gaps, hold plain SQL and preserve every frozen hash. Retention and
  NULL identity rules name real columns, the capacity catalog covers every
  operational table, generated schema docs match their sources, and the SQL
  consumer reader distinguishes qualified names. No legacy schema or
  installation folder is required.
- **On a throwaway cluster:** the runner applies the migrations and the
  roles; the tables and views Postgres built are exactly the static reading's
  (and again with a synthetic later migration that alters, renames and drops);
  the fixture fills every table for two workspaces; then
  [`tests/rls-denial.sql`](tests/rls-denial.sql) (no table shows, accepts,
  changes, removes or lets you reference another workspace's rows; nothing is
  visible with no workspace named; the owner is held too, beyond reading the
  list of workspaces; `noticeos.only_workspace()` is the one function that
  runs with its owner's rights, and names none of two) and the edge cases
  run; finally the app role's privileges are compared with `model.json`
  column by column, the maintenance role's with `retention` and
  `maintenance` (and that it reads every table's size and row estimate), the
  shared vocabulary's (read-only for both), the retention
  trigger's arguments with `retention`, `nullIdentity` with the keys and links
  Postgres built, and [`constraints.md`](constraints.md) with the catalog.
- **On a cluster of its own, the numbers** (bead `ro-ujb9.76.21`): two
  workspaces writing in turn through the application's transaction each count
  from 1 while the identity underneath counts both; two transactions numbering
  in one workspace at once — before its counter exists, and again once it
  does — make the second wait, then take the next number, or the first's own
  when the first rolled back; three sessions of ten transactions each, all at
  once, hand out every number once and skip none.

[`scripts/postgres-migrate.test.mjs`](../../scripts/postgres-migrate.test.mjs), the runner:

- **Always:** the connection strings it refuses before connecting, what a psql
  child inherits, that no number passes through floating point, that the
  freeze guard catches an edited frozen migration, and that nothing at runtime
  can load it outside the approved new-installation setup; the operator's
  `pnpm postgres:migrate` remains explicit. The same guard, run on a planted
  checkout, catches each forbidden way in. Every case holds however many
  migrations follow the baseline.
  The segment listing reads alike on macOS and Linux, only a dead server's
  segment is removed, and a refused listing starts no server. The watchdog
  stops only a server its folder names as listening in its owner's socket
  folder, and waits, bounded, for one still starting.
- **On throwaway clusters:** status only reads; apply records each file's
  hash; a second apply is a no-op; a failing migration rolls the whole run
  back; an edited migration stops the next run; a second runner is refused
  while one holds the lock; a workspace transaction commits exactly or not at
  all, as the application role; bootstrap creates the one workspace once; a
  throwaway cluster records query statistics; a URL reaches only a database
  marked for development; a server killed with SIGKILL leaves its segment and
  the next start removes it; a command stopped by SIGTERM or SIGINT, or
  exiting before `close()`, stops its server and leaves no segment; a command
  killed with SIGKILL has its server stopped by its watchdog within 10
  seconds, with no segment left and nothing for the next start in that folder
  to sweep, and so does one killed while its server is still starting; and
  that watchdog leaves running a server someone started again in its folder.

[`scripts/postgres-apply.test.mjs`](../../scripts/postgres-apply.test.mjs), the operator's
command for an installation's own database (bead `ro-ujb9.76.34`):

- **Always:** the target is checked before anything connects (a development
  database, `--dir` or `--url`, a relative socket, an unset variable, a URL
  naming another login, database, host list or parameter), and no refusal
  repeats a password; a password reaches psql only in its environment, never
  its command line, and no output repeats it, even where psql would.
- **On a throwaway cluster that imitates a server on the machine itself:**
  the three roles with logins, databases owned by `noticeos_owner` with
  CONNECT taken from PUBLIC, and a peer-login `pg_hba.conf` with its map
  ([`scripts/fixture-postgres-peer-host/`](../../scripts/fixture-postgres-peer-host/pg_hba.conf)),
  so the owner gets in over the private socket by a peer login and the
  application cannot. There: status only reads; apply prints
  its plan first and changes nothing until the database is named again; it
  refuses a migration that is not frozen, a frozen one that changed, a
  recorded one that changed or is gone, a development database and one the
  owner may not build in; it applies as the owner, records each file's hash
  and leaves the database's own grants as they were; a second apply changes
  nothing; a failing migration leaves the database exactly as it was; a
  second run is refused while one holds the lock; bootstrap creates the one
  workspace once, and two at once in separate processes cannot both create
  one. With psql alone on the machine, no `initdb` or `pg_ctl` (bead
  `ro-ujb9.76.39`), status reaches the server and prints its plan, while a
  throwaway cluster still needs the server binaries. On a second cluster, a
  host that needs a password: the owner's URL comes from the variable named,
  works over TCP, and neither it nor a wrong one is repeated.

[`scripts/postgres-host-profile.test.mjs`](../../scripts/postgres-host-profile.test.mjs)
and [`scripts/postgres-secrets.test.mjs`](../../scripts/postgres-secrets.test.mjs),
the Compose profile ([`host/`](host/README.md), bead `ro-ujb9.76.12`) where
no container app is needed:

- **Always:** `compose.yaml` publishes one port, on 127.0.0.1 alone; runs the
  pinned multi-architecture PostgreSQL 17 with query statistics and the
  builtin `C.UTF-8` order; keeps the data on a named volume whose name follows
  the project; comes back by itself; takes every secret as a file and none as
  a value; names no path of one machine. `pg_hba.conf` admits the superuser
  on the container's own socket only and the three logins over TCP only to
  `noticeos`, by password. `first-start.sh` refuses a secret that is not a
  verifier before it creates anything. `pnpm postgres:secrets` writes each
  file with the right mode, a verifier that checks its own login's password
  and no other, URLs that pass `pnpm postgres:migrate`'s own check, prints no
  password and never replaces a file.
- **On a throwaway cluster:** `first-start.sh` builds the roles, logins,
  database and query statistics; the profile's `pg_hba.conf` then decides who
  gets in and what is refused; `pnpm postgres:migrate` runs with psql alone by
  the owner's URL; `DATABASE_URL` reaches the one workspace through the
  Workers' store helper; and no password is in the query statistics, their
  text file or the server's log.

The dated container rehearsal (first start, published binding, backup and
restore, restart after a killed server, and minor update) is recorded in
`compose-proof-2026-09-29.mjs` and `compose-proof-2026-09-29.json`, private
historical evidence excluded from the public source. Current rerunnable
fixtures are [the application Compose proof](../../scripts/container-compose.test.mjs)
and [the container backup/restore proof](../../scripts/container-backup-compose.test.mjs).
Read their explicit opt-ins and fixture requirements before running them;
they create disposable resources and are not checks against an installation.

Read the current [SQL consumers](consumers.md) with `pnpm postgres:consumers`;
it scans source files and needs no database. There is no saved inventory to update.

Regenerate the matrix above and [`constraints.md`](constraints.md) with
`node scripts/postgres-docs.mjs --write`; the model's test fails while either
disagrees. The matrix needs no Postgres; constraints.md does, so the command
starts its own throwaway one. Where none can start, it writes the matrix and exits 3.
