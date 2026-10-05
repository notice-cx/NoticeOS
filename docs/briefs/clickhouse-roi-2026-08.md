# Brief: should the fetched-data store move to a self-hosted ClickHouse?

**For:** the operator. **Bead:** `ro-ehp` (P2 spike, opened 2026-08-03). **Scope:** the
analytical side of the central store — `signal_observations`, `signal_runs`,
`signal_dump_runs`, `property_insight_snapshots`, and the R2 raw-archive corpus with its
flattened panels. The system-of-record tables (`ledger`, `decisions`, `annotations`,
`watch_windows`) appear only as "what stays behind". **This is an evaluation, not a
migration**; the store-technology choice is a D-register decision and stays with the
operator. **Constraint honoured:** ClickHouse self-hosted only — cloud pricing appears once,
in a footnote.

**How this was measured.** The operator's `os:up` was running throughout, so nothing here
touched a live file. Every store number comes from the dated snapshots under
`.local/backups/<date>/`, opened read-only (`mode=ro&immutable=1`) — a day-by-day size
series for free, plus `dbstat` for the per-table byte split and the tables' own timestamps
for per-day row rates. Query shapes come from reading `apps/tower/worker/*-payload.ts`,
`workers/ingest/src/**` and `scripts/signal-*.mjs`. Machine numbers come from `ps`,
`system_profiler` and `brew info` on this Mac. Nothing was installed and no server was
started. Web sources are cited at the bottom.

**One-line answer: no-go.** The full reasoning is §7; the tripwires that would reopen it are
§8.

---

## 1. The headline, before the argument

| | measured |
|---|---|
| Evidence growth (the thing ClickHouse would hold) | **~2,900 rows/day ≈ 1.0 MiB/day** |
| Date sqlite/D1 actually hurts | **Not before the 2050s** at today's portfolio (~2.6 years only if the portfolio 10×'s) |
| Self-host footprint | **No supervised install path on macOS as of 2026-09-01** (Homebrew cask deprecated, Gatekeeper-blocked); ClickHouse's own docs recommend **32 GB RAM**, floor ~2–4 GB tuned, against a **241 MiB** Dolt-hub precedent |
| Queries blocked today | **Zero.** The heaviest one runs in **0.11 s** |
| The store's real problem | **93.6% of its bytes are byte-identical duplicates** written by the beads poller — nothing to do with analytics |

---

## 2. Do-nothing baseline

### 2.1 The store is not what its file size says it is

The central store file grew from 0.70 MiB to 131.83 MiB in four days. That reads as
alarming and is almost entirely a mirage. `dbstat`, per dated snapshot:

| date | file | evidence tables + their indexes | `beads_snapshots` | everything else |
|---|---:|---:|---:|---:|
| 2026-07-30 | 0.70 MiB | 0.566 MiB | — | 0.133 MiB |
| 2026-07-31 | 3.84 MiB | 3.148 MiB | — | 0.133 MiB |
| 2026-08-01 | 5.58 MiB | 4.906 MiB | — | 0.203 MiB |
| 2026-08-02 | 67.79 MiB | 5.938 MiB | 61.64 MiB | 0.211 MiB |
| 2026-08-03 | 131.83 MiB | **6.848 MiB** | **124.75 MiB** | 0.238 MiB |

*(`.local/backups/2026-08-0{1,2,3}/9ba2b04b….sqlite`. "Evidence tables" = `signal_runs`,
`signal_observations`, `signal_dump_runs`, `property_insight_snapshots` and every index on
them.)*

**The entire analytical store — every observation, every run, every dump manifest, every
insight snapshot, plus indexes — is 6.85 MiB.** It would fit in the L3 cache of the machine
being asked to host a column store for it.

### 2.2 What `beads_snapshots` is doing, and why it is not an argument for ClickHouse

`db/migrations/0017_beads_snapshots.sql` is a read-through cache of the Dolt task hub,
written once a minute by the poller in `scripts/os-up.mjs`, with a 7-day retention enforced
on every insert (`BEADS_SNAPSHOT_RETENTION_DAYS = 7`,
`workers/ingest/src/beads-snapshots.ts:663`). Only the newest row is ever read. The
migration's own comment already priced it: *"sampled 1,440 times a day"*.

What it did not price is that the payload grew from **1.1 KB to 59.8 KB in 43 hours** as
epics, deferred lists, waiting lists and panel-review state were added to the poller's
photograph. Measured in the 2026-08-03 snapshot:

```
rows 2,814   distinct payloads 199   stored 127,448,585 B   distinct 8,123,078 B
```

**2,814 rows carry 199 distinct board states. 93.6% of the bytes are literal duplicates of
the previous minute.** For twelve straight hours on 2026-08-02 the poller wrote 60
byte-identical 45,954-byte rows per hour because nothing on the board changed.

Retention means this plateaus rather than runs away: 1,440/day × 7 days × ~59.8 KB ≈
**575 MiB**, reached around 2026-08-08 and drifting upward with the size of the board, not
with time. Deduplicated (skip the insert when the payload is unchanged, keep a heartbeat so
a dead poller still reads as a gap) the same seven days would be **under 50 MiB**.

That 575 MiB is not a D1 problem — it is 5.6% of the 10 GB ceiling. It *is* a D10 problem:
`runBackup()` copies the whole store nightly through the sqlite online-backup API, keeps 30
dated copies, and replicates each one into the Drive-synced offsite folder. At plateau that
is ~575 MiB/night of a rebuildable cache pushed through Google Drive, ~17 GiB resident
offsite. Filed as its own bead (§9) — and it is worth saying plainly that **this is the
single largest storage inefficiency in the system, and no store technology fixes it.**

### 2.3 The actual evidence growth rate

Counted off the tables' own `finished_at`, so backup timing cannot distort it (the
2026-07-29/30 backfill and the partial 2026-08-03 are excluded):

| table | rows/day | 2026-08-03 total |
|---|---:|---:|
| `signal_runs` | 955 – 965 | 4,103 |
| `signal_observations` | 1,433 – 1,600 | 11,138 |
| `signal_dump_runs` | 366 – 403 | 4,147 |
| `property_insight_snapshots` | ~0.3 | 26 |
| **total** | **~2,900 rows/day** | **19,414** |

Six assets, GA4 / GSC / Bing / DataForSEO / Clarity lanes. Observed dates span
2026-04-25 → 2026-08-03. Byte cost including indexes: ~370 B/row → **~1.0 MiB/day**, which
matches the measured file deltas (+1.03 MiB, +0.91 MiB across the last two backup
intervals).

The R2 raw-archive corpus, from the same two backup dirs: **1,335 → 1,562 objects, 9.59 →
10.98 MiB gzipped** — +227 objects, **+1.39 MiB/day**, mean object 7.4 KB. Decompressed on
disk it is 981 JSON files / 76.1 MiB, and the flattened panels are 149 CSVs / 72 MiB.

Two design decisions are doing real work here and deserve credit before anything is
proposed to replace them. `signal_observations` is a **change log, not a series** — later
runs append only new or revised `(date, metric)` values (`db/README.md:227`,
`workers/ingest/src/signal-store.ts:57`), which is why 58% of runs write zero rows.
And bulky provider responses were kept **out** of the store from the start: *"Bulky provider
responses do not belong in D1"* (`db/README.md:250`). The store is already the compact
index over an object corpus — which is the shape a columnar migration is usually proposed to
achieve.

### 2.4 When, if ever, does this hurt?

D1's published limits: **10 GB per database** (Workers Paid), unlimited rows, 2 MB max row,
100 bound parameters per query, 1,000 queries per Worker invocation, 30 s max query.

- Evidence at 1.0 MiB/day against 10,240 MiB, less the ~575 MiB `beads_snapshots` plateau:
  **≈ 9,665 days ≈ 26 years. Roughly 2053.**
- At **10× the portfolio** (60 properties, same lanes): ~10 MiB/day → **~2.6 years**, so
  early 2029. Scale, not time, is the only lever that moves this.
- SQLite performance is not the binding constraint either. A year of collection is ~1.06M
  evidence rows; indexed reads over single-digit-million-row tables are unremarkable for
  SQLite, and §3 shows the current heaviest query at 20 ms of CPU.
- Two limits will bite long before size does, and neither is a size problem: **100 bound
  parameters per query** already forced a string-interpolated `IN` list
  (`apps/tower/worker/integrations-payload.ts:939`, with a comment saying so), and **1,000
  queries per invocation** bounds fan-out patterns.

**Honest caveat:** the pilot is not on real D1. `apps/tower/wrangler.jsonc` and
`workers/ingest/wrangler.jsonc` both carry `database_id:
00000000-0000-0000-0000-000000000000` and the store is a local miniflare sqlite file
(D1 in `config/decisions.md` records the pilot posture). **The 10 GB ceiling is not in force
today at all.** It is the ceiling that would apply *if* the pilot went to managed D1 — which
is the one scenario where a Mac-local ClickHouse is strictly incompatible (see §5.1).

---

## 3. What the store is actually asked — and what would get better

This is the dimension that decides the question, so it is the one worth reading carefully.
Every SQL statement against the four evidence tables was inventoried.

### 3.1 The heaviest query in the system

`loadSignalTrends` (`apps/tower/worker/wall-payload.ts:365`) — two stacked CTEs, two
`ROW_NUMBER()` window functions, a self-join of `signal_runs` to every prior successful run
of the same `(asset, integration)` pair, then a join to observations. Cross-portfolio, no
asset predicate. Window 28+7 days from the Wall, 90+7 days from the property page. It backs
three surfaces on a 60-second poll.

Measured against the real store: **4,500 rows returned, join fan-out bounded at 9,813,
0.11 s wall / 0.02 s user.** The `EXPLAIN QUERY PLAN` uses `idx_signal_runs_latest` and
`idx_signal_observations_run_date` for both seeks; the inner CTE is an unbounded index scan
plus two temp b-trees.

Twenty milliseconds of CPU. There is no version of this that ClickHouse makes meaningfully
better for a human looking at a dashboard.

### 3.2 Queries computed in JS rather than SQL — the honest case for a better engine

These are real, and they are the strongest thing in the repo pointing at a columnar store:

- `aggregateArchiveRuns` / `aggregateDataForSeoRuns` (`integrations-payload.ts:964`,
  `:1014`) do `MAX()` / `COUNT()` / `GROUP BY` work in TypeScript over rows pulled from D1.
- `aggregateMetric` (`workers/ingest/src/watch-windows.ts:156`) dedups by date into a `Map`
  and computes sum/mean/coverage in JS.
- `scripts/signal-insights.mjs` (3,292 lines, 24 executive rules) is the actual analytics
  engine and **has no database access at all, deliberately**: *"The rule has no D1 access by
  design — this script runs over immutable archive CSVs"* (`:2493`). Week-over-week
  comparison, top-N ranking, cross-competitor position, regex search over every GSC query
  row — all JS array work over an in-memory corpus.

And the corroborating structural tell: **`property_insight_snapshots` exists because that
pipeline cannot run at request time.** 26 rows of precomputed JSON, described in its own
migration as *"the deliberately small presentation boundary consumed by the Control
Tower"*. That is a hand-rolled materialized view, which is exactly the artifact a columnar
store is supposed to make unnecessary.

**So why is this still not a case for ClickHouse?** Because the thing that pipeline reads is
not in any database — it is 981 gzipped provider JSON blobs in R2, pulled one object at a
time (`scripts/signal-panels-refresh.mjs:362`) and re-parsed in full every night
(`scripts/signal-dumps-analyze.mjs:704`). The bottleneck is blob opacity, not query
execution. Moving `signal_observations` into ClickHouse leaves every one of those 24 rules
exactly where it is.

And the blob scan itself was measured. **A full read + JSON parse of the entire corpus —
981 files, 76.1 MiB — takes 0.70 seconds.** The whole raw archive the OS has ever collected
fits in memory and parses in under a second. A columnar engine's proposition is scanning
billions of rows quickly; here there is nothing for it to bite on. (The nightly refresh's
15-minute timeout budget is for *serial HTTP round-trips and subprocess spawns per object*,
not for scanning — a loop problem, fixable in the loop.)

### 3.3 Rules blocked today, and by what

One designed rule is unwired: **S1b** (`docs/08-seo-geo-signals.md:307–313`), "bestPos
worsens ≥3 vs 4-week median", tracked as `ro-770` (deferred to 2026-08-29). Its own note
gives the reason: *"every rule here compares against retained history the archive does not
have"* yet. That is a **history-depth**
blocker — the panels are weekly and only a few weeks deep — not a percentile-computation
blocker. `median()` already exists and runs in JS (`workers/ingest/src/hygiene.ts:226`).
ClickHouse would not make 4 weeks of history into 12.

Every other "cannot" in the codebase is a **provider** cap, not a store cap: Clarity is a
sampled 72-hour read capped at 1,000 rows with no pagination; GSC exports are top-row only;
DataForSEO has a 200-row ranked-keyword cap and 20-result panel depth. A different database
does not raise any of them.

### 3.4 Verdict on §3

**No query is slow. No query is impossible. Not one.** What exists instead are four latent
inefficiencies that are all fixable *on the store already in place*, in roughly one line
each — all four are filed as beads in §9:

1. Four ranking queries have **no lower time bound**, so they scan all history to return
   ≤18 rows.
2. The property page runs the **whole portfolio's 97-day trend** and keeps one asset
   (`asset-detail-payload.ts:1178`); `loadSignalTrends` does not even accept an asset id.
3. `idx_signal_dump_runs_latest` leads with `asset`, so the two
   `integration='dataforseo' AND report='serp-panel'` reads cannot seek.
4. (Observed, not filed — it fights `docs/10` principle 2, which requires every sourced tile
   to print its own age): no payload caching anywhere, three surfaces polling at 30–60 s.

Using ClickHouse to fix (1)–(3) would be buying a column store to avoid writing
`AND finished_at >= ?`.

---

## 4. Self-host footprint on this Mac

**The machine is not the problem.** Mac mini M4 Pro, 14 cores (10P/4E), **64 GB RAM**, 31%
free at time of measurement. The precedent service, the Dolt task hub, sits at **241 MiB RSS
and 0.0% CPU idle** (`dolt sql-server --config /opt/homebrew/etc/dolt/config.yaml`, PID
sampled 2026-08-03; a second sample minutes earlier read 453 MiB). ClickHouse's published
guidance — *"the recommended amount of RAM is 32 GB or more"*, with a documented floor of
2 GB *"but these setups require additional tuning and can only ingest at a low rate"* — is
affordable here in the narrow sense that 64 GB can absorb it. Altinity's low-memory recipe
(mark cache 256 MB, index mark cache 64 MB, uncompressed cache 16 MB, `background_pool_size`
2, `max_threads` 2, `max_concurrent_queries` 8) exists and works. RAM is not the objection.

**The install and supervision path is the problem, and it is worse than it looks.** Measured
on this machine today:

```
$ brew info clickhouse
==> clickhouse (Clickhouse): 26.7.1.1315-stable
Deprecated because it does not pass the macOS Gatekeeper check!
It will be disabled on 2026-09-01.
$ brew info --formula clickhouse
Error: No available formula with the name "clickhouse".
```

Three consequences, all load-bearing:

1. **ClickHouse is a Homebrew *cask*, not a formula — so there is no `brew services`
   integration to inherit.** The entire Dolt-hub precedent
   (`config/dolt-server.README.md`: a login-scoped launchd service with `keep_alive true`,
   deliberately *not* an `os:up` child, so that six repos' trackers are not tied to one
   process's lifecycle) **cannot be copied.** Supervising ClickHouse means hand-writing a
   launchd plist, or running it under Docker/OrbStack, or accepting an unsupervised
   foreground process.
2. **That cask is deprecated for failing Gatekeeper and disappears in under a month**
   (2026-09-01). The remaining install paths are `curl https://clickhouse.com/cli | sh` +
   `clickhousectl local server start` (a self-managed binary with no documented launchd
   story) or the official multi-arch Docker image. ClickHouse maintains a dedicated KB
   article for the macOS *"developer cannot be verified"* error, which is the honest
   signal about how routine this friction is.
3. **macOS is ClickHouse's lowest support tier.** Their platform page: macOS x86_64 and
   Aarch64 are *"provided only for a reasonable effort and limited to Severity Level 3
   only"*. Linux x86_64 is the only fully supported platform. Self-hosting the OS's
   analytical store on an explicitly best-effort platform is a different risk posture from
   the Dolt hub, which is a first-class macOS target.

Two smaller costs worth naming: `clickhouse-server` on macOS wants
`/Library/LaunchDaemons/limit.maxfiles.plist` raising `maxfiles` to 524288 — a **sudo,
system-wide** change, not a repo-local one. And the Docker route means the server lives
inside OrbStack, already resident at **2.65 GiB RSS** on this machine, adding a second
supervision boundary (container lifecycle *and* service lifecycle) rather than removing one.

**Who supervises it?** `os:up` explicitly refuses this job — the Dolt README states the
runner *"is downgraded to an observer — it health-checks the hub and backs it up, and never
starts, stops, or supervises it."* Any new store inherits that same rule, which means a
hand-written launchd plist plus a fifth health-check state machine in `scripts/os-up.mjs`
beside the four the hub already has.

---

## 5. Integration and the dual-store tax

### 5.1 How workerd would reach it — a new egress direction

Today the workers reach the store through the `DB` D1 binding and each other through the
`INGEST` service binding. Everything that speaks to `127.0.0.1` is a **Node process calling
in** (`scripts/os-up.mjs`, `scripts/signal-panels-refresh.mjs`, through the runner door at
`apps/tower/vite/runner-door.ts`). Grepping `http://` across `apps/tower/worker/**` and
`workers/ingest/src/**` returns **zero hits**: workerd never dials loopback. Outbound
`fetch` exists only to provider HTTPS endpoints, and even that is dependency-injected.

A loopback ClickHouse would be the first workerd → `127.0.0.1` egress in the codebase. It
would have to be compiled out of production builds through the existing `__RUNNER_LANE__`
guard (`apps/tower/vite.config.ts:135`), because **a deployed Cloudflare Worker has no
loopback to reach.** That is the structural point: the pilot's stated direction is two
separately deployed Workers over a service binding, and a Mac-local store makes the
analytical half permanently machine-bound. It forecloses the very D1 future whose 10 GB
ceiling is the only reason size is on the table.

### 5.2 Single-owner topology (`ro-mad`)

The runner enforces one runtime over one store with a bound-socket guard on 127.0.0.1:8791
(`runnerArmDecision`, `scripts/os-up.mjs:2426`) — chosen over a pidfile *because it cannot
go stale*. Two runtimes over one D1 file produced 26 `internal error` lines and is the
leading suspect for the 2026-08-02 central-store corruption (`ro-icq`); the cutover runbook
`docs/runbooks/one-runtime-cutover.md` demands `pgrep -fl workerd | wc -l` → 1.

ClickHouse is a server, so concurrent readers are its job — that part is genuinely
*easier* than sqlite. But the topology gains a second exclusive-lock service on the same
machine, with the Dolt failure mode to match (*"A second `dolt sql-server` on the same
`data_dir` starts, binds, and then dies"*). Net: one class of hazard traded for a familiar
one, plus a second lifecycle.

### 5.3 D10 — backup, offsite, restore drill

`runBackup()` (`scripts/os-up.mjs:544`) backs up three stores into one dated dir: every D1
sqlite through the **online-backup API** (`sqlite3 … '.backup'`, never a file copy — *"the
2026-08-02 restore drill caught exactly that"*), the R2 store the same way plus
content-addressed blobs, and each hub database via `CALL DOLT_BACKUP('sync-url', …)`. It
writes `RESTORE.md` *before* the offsite copy so the explanation travels with the data,
prunes to 30 days locally and offsite, and replicates into the Drive-synced folder. The
quarterly drill (D10, amended 2026-08-02) restores all three **from the offsite copy alone**.

A fourth store costs: a new snapshot function and `statuses.push(...)`; a Contents bullet
and a Restore paragraph in `backupReadme()` (`scripts/os-up.mjs:591`) **plus its assertion
in `scripts/os-up.test.mjs`**; a D10 amendment; a paragraph in `docs/06-operations.md`; a
bullet in `scripts/README.md`; and a fourth store in the quarterly drill. Retention, pruning
and the offsite copy come free.

ClickHouse brings its own machinery rather than fitting this one: `BACKUP … TO
Disk(…)`/`S3(…)`, or Altinity's `clickhouse-backup`. Incremental backups require the base
backup to stay available for the life of every increment — a retention rule that is
**incompatible with a flat 30-day prune** and would need its own logic. Realistically it is
a full backup nightly, and the restore drill grows a fourth procedure that shares nothing
with the other three.

### 5.4 Two freshness stories — actually a fourth

The repo already runs three freshness surfaces plus a panel one, and it runs them
deliberately: `packages/contract/src/reporting.ts` owns `REPORT_MAX_AGE_HOURS` **because two
surfaces once disagreed about one property** (`ro-uwo.1`); the `ingest-freshness` flag lane
is hourly; `apps/tower/shared/freshness.ts` drives per-tile age badges; and
`freshnessReport()` writes `freshness.json` on every panel pass with *"zero sources =
`fresh: false`, never vacuously true"*. `docs/10-control-tower.md` principle 2 obliges every
sourced tile to print its age: *"a stale tile that looks current is how silent failures
survive."*

A second store means a fourth constant and a fourth staleness answer for the same facts —
against a repo whose scar tissue is specifically about one number per fact.

### 5.5 The consumer contract

`docs/20-signal-panels.md` gives property repos a directory of flat CSVs plus
`freshness.json` / `executive.json` / `summary.json` at
`../reindex-os/.local/signal-dumps/analysis/<asset>/`, and that path is **copy-pasted as a
stanza into every property repo's `AGENTS.md`**. It is deliberately not a database: the
scripts README says the CSVs are *"plain inputs for TypeScript, DuckDB, or notebook analysis
without introducing a database dependency into the collector."*

A store swap does not by itself repoint any of this — the panels sit downstream — but the
producer chain (`scripts/signal-panels-refresh.mjs`'s `ANALYSIS_ROOT`/`DEFAULT_DOOR`,
`signal-dumps-analyze.mjs`, `signal-insights.mjs`, the `config/signal-panels.json` roster and
its validation snippet) all move together, and any panel whose *shape* changed would ripple
into six repos' `AGENTS.md`. **The contract is best served by the store change nobody
notices**, which is an argument for changing nothing.

### 5.6 The insert shape is wrong for MergeTree

Every `INSERT` here is small: ~7 observations per run, ~2,900 rows/day total, arriving in
tiny batches from cron ticks. ClickHouse's own guidance is **1,000 rows minimum per insert,
ideally 10,000–1,000,000**; every insert creates a MergeTree part, and too-frequent small
inserts outrun background merges into the "too many parts" failure. The mitigation
(`async_insert = 1`, tuned `async_insert_busy_timeout_ms`) is well-trodden — but it is
another tuning surface, and it means the store acknowledges writes it has not durably
merged, on a system whose write path currently returns a row id from `RETURNING`.

---

## 6. The lighter alternatives, costed

### 6.1 chDB / clickhouse-local — the engine without the server

`npm i chdb` → `chdb` 611 KiB + `@chdb/lib-darwin-arm64` **327.7 MiB unpacked** (v26.5.3,
prebuilt, no node-gyp). Full ClickHouse SQL — joins, CTEs, window functions, aggregates —
in-process, no server, no port, no launchd, no backup story (it queries files; the files are
already backed up).

**Where it can and cannot live:** it is a native Node addon, so it **cannot run inside
workerd**. It would live in the Node analyzer (`scripts/signal-*.mjs`), which is precisely
where the 24-rule engine already runs — and that engine's input is CSV/JSON on disk, which
chDB reads natively.

**What it would buy:** the ability to write SQL instead of JS array code in
`signal-insights.mjs`. **What that is worth:** the corpus it would query parses in 0.70 s
today, so the gain is expressiveness, not speed — a real but modest maintainability win,
against 328 MiB in `node_modules` and a second SQL dialect in the repo. Not now; a
reasonable thing to reach for if the rules engine keeps growing.

### 6.2 DuckDB over the R2 archives

`@duckdb/node-api` 552 KiB + `@duckdb/node-bindings-darwin-arm64` **112 MiB unpacked**
(v1.5.5). Same in-process, no-server shape; same workerd exclusion. `httpfs` reads R2
directly through its S3-compatible API (`read_parquet('r2://…')`), and DuckDB reads the
flattened CSVs with zero setup.

This is the best-value option on the table, and the reason is that **it costs nothing until
it is needed.** `scripts/README.md` already names DuckDB as an intended consumer of the
panels. An operator or agent wanting an ad-hoc cross-property question answered can
`duckdb -c "SELECT … FROM read_csv('.local/signal-dumps/analysis/*/signal-trend-daily.csv')"`
today, with no repo change, no dependency, no service, no backup story, no D10 amendment.
**Recommended posture: keep DuckDB as the ad-hoc analysis tool of record, install nothing.**

### 6.3 Staying put

Free. Plus the three one-line fixes in §3.4, which recover more headroom than a migration
would, and are filed as beads.

---

## 7. Recommendation

**No-go on migrating the fetched-data store to a self-hosted ClickHouse, and the numbers are
not close.** The entire analytical store — every observation, run, dump manifest and insight
snapshot, with indexes — is **6.85 MiB growing at ~1.0 MiB/day**, which reaches D1's 10 GB
ceiling around **2053** and would need a tenfold portfolio to arrive before 2029; the
heaviest query in the system returns 4,500 rows in **0.11 s**, and a full parse of the entire
raw archive corpus takes **0.70 s**, so there is no query that is slow, no query that is
impossible, and nothing for a columnar engine to bite on. Against that, self-hosting costs
real and immediate things: the Homebrew cask is **deprecated for failing Gatekeeper and
disabled on 2026-09-01**, there is no formula and therefore **no `brew services` path to
inherit from the Dolt hub**, macOS is ClickHouse's **lowest support tier**, workerd would
need its first-ever loopback egress — permanently binding the analytical store to this Mac
and foreclosing the managed-D1 future whose ceiling is the only reason size was raised — and
D10 would gain a fourth store with **backup machinery that shares nothing with the other
three** and an incremental-retention rule incompatible with the flat 30-day prune, plus a
fourth freshness surface in a repo whose scar tissue is specifically about two surfaces
disagreeing. The one honest pull toward a better engine — 24 insight rules written as JS
array code over blobs, with `property_insight_snapshots` standing in as a hand-rolled
materialized view — is a **blob-opacity** problem that moving `signal_observations` would not
touch, and if it ever needs solving, **DuckDB or chDB solve it in-process for zero services
and zero backup story**. The store's actual pathology is elsewhere and this evaluation found
it: **93.6% of the central store's bytes are byte-identical duplicates** written once a
minute by the beads poller, which no store technology fixes and one `if` statement does.
Fix that, add three missing `WHERE` clauses, keep DuckDB as the ad-hoc analysis tool, and
revisit ClickHouse only against the tripwires below.

---

## 8. What would reopen this

Not time — none of these arrive on a calendar. Any one of them is a genuine re-evaluation
trigger:

1. **Portfolio scale.** 30+ properties, or evidence growth sustained above **10 MiB/day**.
   That is the only path to the 10 GB ceiling inside five years.
2. **A named query the store cannot answer.** Not "analytics would be nicer" — an actual
   rule or Tower surface that is specified, wanted, and blocked on query capability rather
   than on provider caps or history depth. §3 found none; the day one exists, this brief is
   stale.
3. **Row-grain retention of provider detail.** If the OS ever decides to shred the raw
   archives into queryable rows (per-query × per-date × per-device across the portfolio,
   ~10⁵–10⁶ rows/day rather than 10³), the shape genuinely changes and the calculus flips.
   Note that DuckDB over Parquet in R2 answers that first, and without a service.
4. **The pilot leaves this Mac.** If D1 goes managed, a loopback ClickHouse is not an
   option at all; if the OS moves to a Linux host, ClickHouse's support tier and install
   story stop being objections. Either way the ground beneath §4 and §5.1 has moved.

---

## 9. Beads filed from this evaluation

Adjacent findings, each measured here, none of them ClickHouse work:

- **`ro-3xa`** (P1) — the beads poller writes fourteen identical copies of the board for
  every one that changed: 93.6% of the store's bytes, and the nightly offsite copy carries
  all of it.
- **`ro-48p`** (epic, P2) — cheap store wins this evaluation surfaced, with three children:
  - **`ro-48p.1`** — four latest-row queries scan the whole history to return ≤18 rows.
  - **`ro-48p.2`** — the property page computes the whole portfolio's 97-day trend to draw
    one property.
  - **`ro-48p.3`** — the dump-run index leads with `asset`, so the two SERP-panel reads
    cannot seek.

Pre-existing and related, not re-filed: **`ro-ntu`** (the property page reads every
property's panel landings to answer for one — same family as `ro-48p.2`, different
function), **`ro-770`** (S1b unwired for want of retained history), **`ro-mad`** / **`ro-icq`**
(single-runtime topology and the 2026-08-02 corruption).

`ro-ehp` stays **open** — the decision is the operator's, and a store-technology change would
be a D-register entry.

---

## Sources

Repo evidence is cited inline by path. External claims relied on:

- ClickHouse supported platforms (macOS = Severity Level 3, "reasonable effort") —
  https://clickhouse.com/support/platforms
- ClickHouse OSS usage recommendations (32 GB recommended; 2 GB floor with tuning) —
  https://clickhouse.com/docs/operations/tips
- Altinity KB, configuring ClickHouse for low-memory environments (cache and pool sizes) —
  https://kb.altinity.com/altinity-kb-setup-and-maintenance/configure_clickhouse_for_low_mem_envs/
- ClickHouse macOS install (`clickhousectl`) — https://clickhouse.com/docs/install/macOS
- ClickHouse KB, fixing the macOS developer-verification error —
  https://clickhouse.com/docs/knowledgebase/fix-developer-verification-error-in-macos
- ClickHouse build-on-macOS note on raising `maxfiles` via
  `/Library/LaunchDaemons/limit.maxfiles.plist` — https://clickhouse.com/docs/development/build-osx
- ClickHouse insert-strategy guidance (≥1,000 rows per insert; `async_insert`) —
  https://clickhouse.com/docs/best-practices/selecting-an-insert-strategy
- ClickHouse BACKUP/RESTORE to S3, incremental requires the base backup —
  https://clickhouse.com/docs/operations/backup/s3_endpoint
- chDB for Node.js — https://clickhouse.com/docs/chdb/install/nodejs;
  package sizes from the npm registry (`chdb@3.2.0`, `@chdb/lib-darwin-arm64@26.5.3`)
- DuckDB Cloudflare R2 import via `httpfs` —
  https://duckdb.org/docs/current/guides/network_cloud_storage/cloudflare_r2_import;
  package sizes from the npm registry (`@duckdb/node-api@1.5.5-r.3`,
  `@duckdb/node-bindings-darwin-arm64`)
- Cloudflare D1 limits (10 GB/database, 100 bound params, 1,000 queries per invocation) —
  https://developers.cloudflare.com/d1/platform/limits/
- Homebrew cask status measured locally: `brew info clickhouse` →
  `26.7.1.1315-stable`, *"Deprecated because it does not pass the macOS Gatekeeper check! It
  will be disabled on 2026-09-01"*; `brew info --formula clickhouse` → no such formula.

> **Footnote, for contrast only (the operator's direction is self-hosted).** ClickHouse
> Cloud's Basic tier starts around **$66/month** at their own worked example (1 replica,
> 8 GiB RAM, 6 h/day active) — more than twice the entire **$25/month data-plane cap** in
> D6, for a 6.85 MiB store.
