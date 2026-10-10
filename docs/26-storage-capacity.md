# 26 — Storage capacity and transition sizing

*This doc is the method: what the store's capacity inventory measures, how
its numbers size the Postgres and Parquet/DuckDB design, and which numbers the
live readback supplies. The numbers themselves are dated evidence and are
recorded in the installation's own task hub, not here.
The target data model the sizing applies to is
[`db/postgres/`](../db/postgres/README.md).*

## Why measure first

The OS never recorded how big its store is or how fast it grows, and the
code alone gives wrong answers in both directions:

- **Raw provider pages are not store growth.** They are gzip objects in the raw
  archive (R2); the store keeps one manifest row per attempt
  (`archive_runs`), with each stored object named once in `archive_objects`.
- **Normalized metrics are stored as changes, not copies.**
  `signal_observations` appends a value only when a `(date, metric)` is new or
  revised (`workers/ingest/src/signal-store.ts`), so its growth is far below
  "sites × metrics × days × runs".
- **Insight snapshots are the opposite.** Their content hash covers
  `generatedAt`, so every newly generated report is a new row of up to 1 MB
  (`workers/ingest/src/insight-snapshots.ts`), and only the two newest rows per
  site are ever read: the site page reads the newest, and the Wall's feed
  compares it with the one before (`apps/tower/worker/wall-feed.ts`).

The inventory measures the Postgres operational store. The inventory changes
no retention and migrates nothing.

## What the inventory measures

`pnpm os:capacity` (and the Capacity section of `pnpm os:doctor`) asks the
running OS for `GET /api/capacity` over the loopback ingest door, with the
operator bearer the other script reads use. The runtime that owns the store
answers; the script opens no database connection (`scripts/ingest-door.mjs`).
`pnpm os:capacity -- --json`
prints the raw answer.

The answer is **metadata only** — table and column names, counts, byte totals
and first/last arrival timestamps. No stored value leaves the store. Every
statement is a `SELECT`, inside an application-role read-only transaction,
run one table at a time. Row security scopes every count and column-byte sum
to the request's workspace. Physical database, relation and bucket sizes
are reported only when that workspace is the store's sole workspace; they
are unavailable on a shared store, where physical sizes would reveal other
workspaces' activity. Raw bucket objects are never downloaded.

| Figure | How it is measured |
|---|---|
| Database size | `pg_database_size(current_database())`; unavailable on a shared store |
| Physical bytes per table | `pg_total_relation_size`, including heap, indexes and TOAST; unavailable on a shared store |
| Stored bytes per table | Sum of `pg_column_size()` over every column in the workspace's rows, including stored compression. Excludes indexes and page overhead, which are reported together as *unattributed*; on a shared store the difference is unavailable |
| Largest column | The column holding most of a table's bytes — where compression and TOAST matter |
| Rows added per day | Rows whose arrival stamp falls in the last 30 days, divided by the days actually covered (a table born ten days ago grew for ten days) |
| Bytes added per day | The same window, summed row bytes |
| Arrival stamp | The column named in [`db/postgres/tables.json`](../db/postgres/tables.json); `signal_observations` joins its run by `(workspace_id, run_seq)` and uses that run's `finished_at` |
| Table kind | `history` keeps every row; `state` holds one row per thing; `cache` deletes old rows as it adds new ones. Store growth adds `history` tables only |
| Missing tables | Catalogued tables the store does not have: migrations not applied |
| Insight snapshots | Per site: rows, uncompressed payload bytes, largest payload, rows and publish days in 30 days; the two newest rows per site (read) against every older row still present (kept, unread) |
| Raw archive | From the manifests: runs by outcome, and distinct objects and bytes per integration (an unchanged run reuses an object, which is counted once). From listing the bucket: objects and bytes per producer prefix, stopping after 100,000 objects |
| Lane durations | p50, p95 and max of each scheduled lane's firings over 30 days (`job_runs`) — one scheduled operation end to end |
| Full-scan time | Elapsed time of each table's read transaction, including its connection and query, and their sum |
| Newest backup | File count and bytes of the newest dated backup folder, from `stat` alone |

A table added by a migration without a `db/postgres/tables.json` row is still
measured as *undeclared*, with no growth rate; `scripts/postgres-model.test.mjs`
fails until the row is added.

The catalog treats retained insight snapshots as `cache`: each site's two
newest stay and exported older rows may leave under the approved retention
rule. Export acknowledgements, numbering counters, measurement-series keys,
capability targets and item dispositions are `state`.
History growth therefore excludes those bounded registers and caches.

## From the inventory to a sizing

For each table, with `r` = rows, `b` = stored bytes, `Δr`/`Δb` = rows and
bytes added per day:

1. **Projected size at a horizon of `h` days** (1 and 3 years):
   - `history`: `b + Δb × h`.
   - `cache`: steady state, `Δb × retention days` (the oldest row's age shows
     the retention actually applied).
   - `state`: `b`, scaled by the number of sites if it is per site.
2. **Postgres physical storage**: compare each table's measured
   `relationBytes` with its scoped `valueBytes`. Physical bytes already
   include indexes, page overhead and TOAST; column bytes already reflect
   stored compression. For projection, scale the measured physical-to-value
   ratio, measured on a representative populated copy, rather than adding a
   second workspace-id or compression allowance.
3. **Shared-store sizing**: collect physical sizes from an isolated copy or
   an explicitly authorized host administration read, then combine them with
   the scoped per-workspace growth figures. Request-scoped capacity never
   exposes another workspace's physical totals.
4. **Parquet**: rows of daily metrics and manifests compress to a small
   fraction of their stored bytes; the ratio is measured, not assumed, by
   writing one month of each dataset from an isolated backup copy with DuckDB
   and dividing.
5. **Per site and per workspace**: divide each table's `Δr` by the number of
   sites that produce it. A self-hosted install is one workspace; a hosted
   database is the sum over workspaces, each sized by its sites.
6. **Change detection**: `signal_observations` rows per day over
   `signal_runs` rows per day is the observations a run adds. Kept beside the
   full-series figure, it is the saving change detection buys and must keep
   buying after the move.
7. **Snapshot retention**: *kept but unread* bytes are what a snapshot
   retention rule would reclaim. Measured only — changing retention is an
   operator decision. The Postgres rule is that each site's two newest stay
   and older ones move to the analytical store
   ([`db/postgres/`](../db/postgres/README.md#what-stays-in-postgres)).

The **capacity envelope** is then, per store: the projected 3-year size, the
largest payload, the slowest lane's p95, and the newest
backup's size and restore time — each with the headroom the chosen hosting
leaves.

## The live readback

The inventory has been proved against a synthetic store
(`workers/ingest/test/capacity.test.ts`, `scripts/os-capacity.test.mjs`). The
live numbers come from one run on the installation after the change is
deployed:

```sh
pnpm os:capacity -- --json
```

The readback records, dated, in the installation's own task hub:

- database size, stored bytes and unattributed bytes; tables and missing tables;
- per table: kind, rows, bytes, rows and bytes per day, largest column;
- insight snapshots: rows, bytes, per day, read against kept-but-unread;
- raw archive: objects and bytes per integration and per day, and whether the
  bucket listing agrees with the manifests;
- p50/p95/max per lane, and the full-scan time;
- the newest backup's size.

Two figures need a step the inventory cannot take and are recorded with the
same readback: the **restore time** (time restoring the newest backup into an
isolated scratch folder, the drill in
[`scripts/README.md`](../scripts/README.md)), and the **Parquet compression ratios**
behind step 4 (measured on that same isolated copy).
