# Review of the Postgres target model — 2026-09-24

*Reviewer: the orchestrating agent (Claude Fable 5.1), at the operator's
request, before any switch-over. Scope: `schema.sql`, `roles.sql`,
`mapping.json`, `tests/`, the design notes, and the live store's first
capacity readback
(`docs/artifacts/integration-monitoring/capacity-readback-2026-09-24.json`).*

## Verdict

Sound foundation; not yet the schema to switch to. Keep the shape (workspace
in every key, forced row security, a non-owning app role, append-only
history, honest types). Fix the six items under **Change before building**
in the baseline migration (`ro-ujb9.71`), because each is cheap now and
expensive after the first import. The rest are recommendations the baseline
can carry as follow-up beads.

## Change before building

### 1. Providers, metrics and check kinds are data, not CHECK literals

The draft hard-codes `integration IN (...)`, `metric IN (...)`,
`check_id IN (...)`, `report`/`family` vocabularies and provider names in
CHECK constraints on five tables (`measurement_series`, `signal_runs`,
`archive_runs`, `watch_windows`, `hygiene_checks`), and repeats the
integration→metric→unit rule in two of them.

Evidence that this costs migrations: in the 38 D1 migrations the
`integration IN (...)` list was rewritten four times and `check_id IN (...)`
twice, once per provider or check added. The product's direction is more
sources (Plausible, Fathom, Umami and so on are the obvious next connectors
for a solo-founder product), so this list will keep growing.

Do instead: three small reference tables, shared across workspaces, and
foreign keys to them:

```
noticeos.providers      (provider text PK, kind text, display_name text)
noticeos.metric_kinds   (provider text, metric text, unit text, PK (provider, metric))
noticeos.check_kinds    (check_id text PK)
```

`measurement_series` then carries `(integration, metric)` with a composite FK
to `metric_kinds`, which also carries the unit, so the unit CHECK on the
series and the duplicate rule on `watch_windows` go away. Adding a provider
is an `INSERT`, shipped as data with the code that speaks to it.

Two consequences to handle in the same change:

- Reference tables have no `workspace_id`. The `DO` loop that applies the
  isolation policy to every table would lock them empty. Give reference
  tables a `SELECT`-for-all policy (or keep them in a separate schema,
  `noticeos_ref`, outside the loop) and cover it in `rls-denial.sql`.
- Keep small closed sets as CHECKs (`severity`, `kind`, `status`, `outcome`,
  `booking_state`): those are product semantics, not a vocabulary that grows
  with connectors.

### 2. Fact tables key on text ids from their parents

`signal_observations` (93,510 rows today, +1,678/day) carries `run_id text`
in its primary read index; `archive_runs` and `mediavine_daily` reference
`run_id text` and `object_key text`; `integration_health_events` and
`integration_capability_state` repeat seven text dimension columns per row
and index all of them.

On the live D1 store the largest columns are exactly these:
`signal_runs.id` 1.9 MB, `signal_dump_runs.object_key` 2.2 MB,
`signal_observations.run_id` 3.2 MB (out of 5.9 MB of values). Text keys in
B-trees are the store's main space cost and its main index-scan cost.

Do instead: every parent that has a natural text key also gets a `bigint`
identity (`run_seq`, `object_seq`, `connection_seq`), children reference
`(workspace_id, <seq>)`, and the text key stays a `UNIQUE` attribute on the
parent for lookups and imports. For the two integration-state tables, one
`capability_targets` dimension row per
`(provider, connection_revision, capability, asset_id, target_id, family)`
and a `bigint` reference from events and state.

Expected effect at today's volumes: the observation index shrinks by roughly
half; at hosted volumes it is the difference between a cached index and a
disk-bound one.

### 3. A maintenance role that bypasses row security

`roles.sql` defines only `noticeos_owner` (forced RLS) and `noticeos_app`.
Nothing can act across workspaces. The product already needs to:

- the daily retention sweeps (`task_snapshots`, `job_runs`, dated
  summaries), which must run for every workspace;
- the capacity readback (`pnpm os:capacity`), which reports per table across
  the store;
- the importer's pre-flight and the rehearsal (`ro-ujb9.76.9`), which count
  and compare across everything;
- support and ops on a hosted install.

Do instead: add `noticeos_maint` (`BYPASSRLS`, `NOLOGIN`, no DDL), grant it
only what the sweeps need, and require every maintenance job to name the
role explicitly. Document the rule: a job that iterates workspaces under the
app role must `SET LOCAL` each one; a job that legitimately spans them runs
as `noticeos_maint`. Add a case to `rls-denial.sql` proving the app role can
never reach `noticeos_maint`.

### 4. The operational store keeps a bounded window; the rest is analytical

The mapping imports every historical row of `signal_observations`,
`signal_runs`, `archive_runs`, `job_runs` and `hygiene_checks` into
Postgres. D25 made Parquet/DuckDB the home of history. The operational store
should hold what the Tower reads live.

Do instead: state a retention window per history table in `mapping.json`
(suggested: 13 months of observations and runs, 90 days of `job_runs`,
the newest snapshot per site as approved in choice 9), import within the
window, and route the rest to the Parquet datasets (`ro-ujb9.67`) in the
same rehearsal. This keeps the Postgres store around today's 100 MB instead
of growing without bound, and makes the hosted plan's per-tenant cost
predictable.

### 5. Site deletion is a dead end for the app

The app role has `DELETE` on `assets`, but every history table references
`assets` with no `ON DELETE` rule and the app has no `DELETE` on history.
So a site can only ever be deleted before it has data. That is a reasonable
rule, but today it is implicit: the app would get a foreign-key error at
run time.

Do instead: decide it and encode it. Either remove `DELETE ON assets` from
the app and make "retired" the only exit (matching the immutable-history
stance), or add the archival path (a retire step that moves the site's
history to the analytical store, then deletes) as a `noticeos_maint`
operation. Say which in the README.

### 6. Name the tenant's noun the way the product does

D31 made "site" the product's noun; the schema keeps `assets` and
`asset_id`. Choice 11 renamed five tables for clarity and left this one.
This is the only moment a rename is free: nothing reads the new schema yet.
`sites (site_id)` matches what a contributor reads on every screen and in
every doc.

If the operator prefers to keep `assets` to spare the code, that is fine,
but decide it deliberately; do not inherit it by default.

## Recommended, not blocking

- **Sequential ids leak activity across tenants.** `flag_id`, `pulse_id`
  and the other identity columns are one global sequence per table, so a
  hosted tenant can infer other tenants' write rates from gaps. Low risk for
  a single-operator install; for the hosted version, expose UUIDv7 (or
  per-workspace sequences) in URLs and keep the `bigint` internal.
- **`domain` is not unique within a workspace.** Two sites with one domain
  would both match by-domain discovery. Add
  `UNIQUE (workspace_id, domain) WHERE domain IS NOT NULL`.
- **Bootstrap of the first workspace is not written down.** Under forced RLS
  the app cannot insert into `workspaces` (no grant), and a `SET LOCAL`
  must precede the first row. Document the bootstrap as an owner step in the
  migration runner (`ro-ujb9.76.3`), and test it.
- **Redundant unique indexes for composite FKs**
  (`pulses (workspace_id, asset_id, pulse_id)`,
  `mediavine_runs (workspace_id, run_id, asset_id, site_id)`) are the price of
  "a child belongs to its parent's own site". Keep them, but note them in
  the README so nobody drops them as duplicates.
- **`financial_ledger`** is the most intricate object in the schema (a
  recursive CTE over corrections and Mediavine daily months). It is ported
  from D1 migration 0034 and covered by `edge-cases.sql`; keep it a view,
  never materialize it, and add one test per branch of its `WHERE`.
- **Snapshot payloads in the row store.** `asset_insight_snapshots.payload`
  and `task_snapshots.payload` are the two blob columns. With retention from
  item 4 they stay small; if the hosted version keeps more than the newest
  per site, put payloads in object storage and keep the hash and pointer in
  the row.
- **Leases.** `integration_leases` reproduces a lease-with-expiry over a
  table. Postgres offers `SELECT ... FOR UPDATE SKIP LOCKED` and advisory
  locks; when the Workers move off D1's request model, the lease table can go.
- **Observability.** Turn on `pg_stat_statements` from day one on the
  development profile and the hosted profile, and put the capacity readback's
  queries on `pg_stat_user_tables` and `pg_total_relation_size`, which are
  exact and free.
- **Partitioning.** Not needed at this scale (~250 MB/year today). Revisit
  only if `signal_observations` or `job_runs` pass tens of millions of rows;
  then partition by month, which the `workspace_id`-first indexes tolerate.

## What is right and should not change

- `workspace_id` leads every primary key, unique key and foreign key, so a
  row cannot reference another workspace even where row security does not
  apply (FK checks). This is the guard that makes multi-tenancy safe.
- Row security is enabled and forced, views are `security_invoker`, and the
  app role owns nothing and cannot bypass. The denial proof runs on a real
  Postgres and covers reads, writes, updates, deletes, references and the
  owner.
- Column-level grants encode the revision rules: append-only history,
  immutable money with corrections as new entries, sanctioned mutations
  named column by column.
- Types are honest: `timestamptz` for instants, `date` for provider days,
  months as their first day, `bigint` minor units with a currency, exact
  `numeric(14,6)` provider prices with a known/unknown state, finite doubles
  for metric values, `json` where bytes are evidence and `jsonb` where the
  store queries.
- Partial indexes for the open/pending sets, `UNIQUE NULLS NOT DISTINCT`
  where a NULL is a real key value, identity columns, and no ORM-shaped
  surprises.

## How this review feeds the work

The six items above go to the agent building `ro-ujb9.71` as changes to the
baseline. The recommendations become beads under `ro-ujb9.76` where they are
not already covered (`ro-ujb9.67` Parquet datasets, `ro-ujb9.76.3` runner
and bootstrap, `ro-ujb9.76.9` rehearsal).
