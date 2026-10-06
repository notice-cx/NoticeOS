# The Postgres port pattern (2026-09-29, epic `ro-ujb9.76`)

This guide records the port design and its historical proofs. At the start on
2026-09-29, about 80 runtime files and 150 test files used D1; the first
settings slice (`ro-ujb9.76.4.1`) proved the transport and harness before the
remaining table units moved. Section 6 records those slices, and section 8
records their migration sequence; transitional dual-store descriptions there
are history, not the current Worker interface. The generated
[`db/postgres/consumers.md`](../../db/postgres/consumers.md) is the consumer
inventory; beads holds task status.

**Current Postgres build (2026-09-30, `ro-ujb9.76.40`).** Both Workers use
`POSTGRES` and a call's `STORE`, without a `DB` binding or site mirror. Their
test harnesses seed synthetic fixtures directly into disposable Postgres
copies, without D1 migrations or SQLite adapters. The current setup and its
proofs are described in sections 2, 7 and 8. Section 3 preserves the original
measurements; it does not establish a final speedup for this removal.

**Original rehearsal sequencing (2026-09-29).** The running OS then stayed on
D1. Additive helper and harness commits landed on main; replacement code stayed
on the Postgres branch pending the approved switch (D25, `ro-ujb9.76.10`).
These branch and cutover descriptions below are historical. New installations
use the [current Postgres setup](../../db/postgres/README.md); they do not
replay this port or use its retired import tools.

## 1. How a Worker reaches Postgres

**Decided and proven.** A Worker reaches Postgres only through its Hyperdrive
binding, named `POSTGRES`, and the one helper
([`packages/postgres`](../../packages/postgres/README.md)). Locally a
Hyperdrive binding is a plain TCP pipe from workerd to the connection string it
is given, so:

- **workerd needs loopback TCP.** It opens no unix socket, and Miniflare
  refuses a local connection string without a password (its Hyperdrive schema:
  "You must provide a password").
- **The throwaway cluster has a loopback mode**
  ([`scripts/postgres-dev.mjs`](../../scripts/postgres-dev.mjs),
  `openThrowaway(dir, tools, { loopbackPort })`): it listens on 127.0.0.1 at
  one port; over TCP only `noticeos_app` gets in, only by the password
  `applicationLogin()` makes at that start; everything else over TCP is
  refused. The owner still reaches it only through the private socket folder,
  and every refusal the socket-only profile had stays.
- **The password never reaches the server or a file.** `applicationLogin()`
  sends a SCRAM-SHA-256 verifier computed in Node, as `psql`'s `\password`
  does. A plain `ALTER ROLE … PASSWORD '…'` is kept, word for word, by
  `pg_stat_statements` (it records utility statements), which the proof found
  in `pg_stat_tmp/pgss_query_texts.stat`. The same holds on any real host that
  loads `pg_stat_statements`: its setup must set the password the same way
  (comment on `ro-ujb9.76.12`).
- **The local connection string reaches the Workers through the environment**,
  `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_POSTGRES`, the variable
  wrangler reads for a binding named `POSTGRES` (the Cloudflare Vite plugin
  loads every `CLOUDFLARE_*` variable). Never `localConnectionString` in a
  checked-in config: it would put a password in a file.
- **`?sslmode=disable` on the local string.** With it, workerd connects
  straight to the port; without it, Miniflare puts a Node proxy in between to
  try TLS first.
- **What a Worker's config gains** when its first module is ported (the
  Postgres branch only, where both configs carry it since the settings slice;
  main keeps the live OS on D1):
  `"compatibility_flags": ["nodejs_compat"]` (node-postgres needs Node's
  `events`, `net`-like streams and `crypto`) and
  `"hyperdrive": [{ "binding": "POSTGRES", "id": "<id>" }]`. The id is the
  host's (`ro-ujb9.76.12`); locally any id works because the environment
  variable names the database.

Proven by [`apps/tower/test/runner-door-e2e.test.ts`](../../apps/tower/test/runner-door-e2e.test.ts):
it boots the dev server the local OS runs (the Tower Worker, the ingest as its
auxiliary Worker, one workerd, the checked-in configs written into a folder of
their own as `pnpm start` writes them). On main, with the two additions above
and a small probe as each Worker's entry, both Workers open a transaction on
their own binding as `noticeos_app` in the one workspace. On the Postgres
branch it runs the real Workers: a clock saved into the store's settings
reaches `/api/settings` through the ingest's config store over the `INGEST`
binding, and the Tower's own read of the change history on its binding.

**A defect this found in the helper.** `openStore` passed node-postgres
`allowExitOnIdle: true`, which makes the pool call `unref()` on its timers and
connections. A Worker's have none, so every connection release threw inside
workerd. Removed ([`store.mts`](../../packages/postgres/src/store.mts)); a Node
script that forgets `close()` now exits once its idle connections time out
(10 s) instead of at once.

## 2. How the tests reach it

**Decided and proven.** One throwaway cluster per test run, one template in
it, and a copy of the template for each test file
([`scripts/postgres-test-cluster.mts`](../../scripts/postgres-test-cluster.mts)).
Only the process that starts the cluster holds the owner's way in; a test
process asks it for a copy through its copy service, a unix socket in a folder
only this user can reach
([`scripts/postgres-test-copies.mts`](../../scripts/postgres-test-copies.mts)),
so no test process runs `psql` or holds more than the application role's
login. The starting process makes copies on a few owner connections it holds
open on the cluster's private socket, several at once, and never blocks on
one: it is Vitest's or Playwright's own process and drives the test workers
too. A copy a test is done with is given back (`releaseDatabase`): its
sessions are ended, its name taken away and its tables emptied back to the
template's, and the next test that asks gets it under a new name (section 3
says why). The starter compiles against the Postgres runner's own JavaScript:
the Node-only generation project reads it (`allowJs` in
`tsconfig.config-contract.node.json`), and no Tower TypeScript imports the
starter.

- **The template** is a new installation's store: the roles, every migration
  and the one workspace, made by the same runner and bootstrap a new install
  uses (`scripts/postgres-migrate.mjs`). Then it is closed to connections, so
  nothing can hold it open while it is copied.
- **The ingest suite** (inside workerd): each Workers runtime — one per Vitest
  worker, reused from file to file — gets its own copy as its `POSTGRES`
  binding. A binding names one database for the runtime's life, so
  [`test/clean-start.ts`](../../workers/ingest/test/clean-start.ts) has that
  copy made again under the same name before every file (`TEST_POSTGRES`, a
  function the config runs in Node). Complete synthetic sites from
  [`db/fixtures/invented-sites.json`](../../db/fixtures/invented-sites.json)
  are then inserted directly in fixture order: no D1 migration, rename or
  copy step. R2 and the Cache API are reset too. The store fence
  ([`test/store-fence.ts`](../../workers/ingest/test/store-fence.ts)) refuses
  the binding to a test that has ended, and the copy made again ends any
  connection an ended test still held. The isolation probes
  ([`test/isolation-probe.ts`](../../workers/ingest/test/isolation-probe.ts))
  prove both, and fail when the per-file copy is switched off.
- **The Tower suite** (Node): [`test/postgres-global-setup.mjs`](../../apps/tower/test/postgres-global-setup.mjs)
  starts the cluster before any file and hands the test processes its handle
  in memory; [`test/postgres-store.ts`](../../apps/tower/test/postgres-store.ts)
  `createTestStore()` gives one test its own copy, and its `close()` gives the
  copy back. Sites and other rows are seeded directly into that copy. Every
  test that reads the site list gets a copy of its own too
  ([`test/sites.ts`](../../apps/tower/test/sites.ts)), given back after it.
- **Loading node-postgres in the Workers pool** needs two module aliases
  (`workersPoolDriverAliases()`): the pool resolves every `require()` with the
  `import` condition, which hands `pg-protocol`'s ES module to a CommonJS
  loader and misses `pg-cloudflare`'s workerd build. The Workers' real bundler
  (the Cloudflare Vite plugin, wrangler) needs nothing; the runtime proof above
  shows it.
- **The Tower's other harnesses** (the Postgres branch): the journeys start
  one cluster per run in Playwright's global setup
  ([`e2e/postgres-global-setup.mjs`](../../apps/tower/e2e/postgres-global-setup.mjs));
  each fixture server gets the handle in its environment
  (`NOTICEOS_JOURNEY_POSTGRES`, [`e2e/fixture-server.mjs`](../../apps/tower/e2e/fixture-server.mjs)),
  takes a copy of its own, gives it back on `/__journey/reset` and takes
  another (the reset never waits on the copy the last test used), and drops
  it at its stop; the flow gate and the harness test start one cluster in
  their own process. The test that boots the dev server
  (`runner-door-e2e.test.ts`) hands its Workers a copy through the
  local-address variable; the real start (`scripts/start.test.mjs`) and the
  runner's rehearsal (`scripts/runner-database.test.mjs`) put a copy's address
  in the installation's secrets file as `DATABASE_URL`, as an operator does
  (section 4).
- **Where no Postgres can start** (no server binaries, or a sandbox without
  shared memory) the Postgres tests skip and say why.
  `NOTICEOS_REQUIRE_POSTGRES=1` turns that into a failure. CI now puts
  PostgreSQL 16 on PATH before `pnpm -r test` and sets it there as well as for
  `pnpm test:scripts` ([`ci.yml`](../../.github/workflows/ci.yml),
  [`ci-contract.test.mjs`](../../scripts/ci-contract.test.mjs)).
- **Ports.** A run takes a free loopback port from the kernel;
  `NOTICEOS_TEST_POSTGRES_PORTS=5400-5449` confines it to a range, for a
  machine where agents are given port blocks.

## 3. What it costs (measured 2026-09-29, this Mac, other agents' runs beside it)

| What | Time |
|---|---|
| Start a run's cluster and build its template (initdb, start, the migration, the bootstrap) | 0.78–0.81 s, once per run |
| Copy the template (`CREATE DATABASE … TEMPLATE … STRATEGY FILE_COPY`), median / p90 of 20 | 61 / 100 ms (the default `WAL_LOG`: 112 / 123 ms) |
| Copy again under the same name (a file's clean start), median / p90 | 94 / 97 ms (`WAL_LOG`: 140 / 149 ms) |
| Drop a copy, median | 33 ms |
| One warm transaction over loopback TCP from Node | 0.28–0.33 ms |
| Size of a copy | 10 MB |

| Suite | D1 alone | With the Postgres cluster and a copy per file |
|---|---|---|
| Ingest, 69 files, 1,312 tests (`vitest run`) | 18.4 s; 31.6 s on a busier minute | 20.4 s; 19.5 s |
| Tower, 177 files, 3,802 tests | 27.0 s | 28.3 s |

The ingest suite's summed setup time rises from about 24 s to 36.5 s across its
workers: about 180 ms a file on a loaded host, against 94 ms measured alone. On
the wall clock that is 1–2 s, well under the 30 % bound.

The original forecast was that removing per-file D1 migration replay would
offset the Postgres setup cost. `ro-ujb9.76.40` removes that replay and retains
the Postgres reset. The historical numbers above remain the baseline; a final
speed comparison requires complete passing runs of the assembled build.

**A copy for every Tower test (`ro-ujb9.76.48`, measured 2026-09-29 on this
Mac beside the other agents' work, each suite alone under the machine's lock).**
Each copy and each drop was one blocking `psql` in Vitest's own process, one
after another: with a copy for each of about 400 Tower tests, 24–28 tests timed
out at 5 s, so the site registry shared a copy nothing wrote to between tests.
Three ways out were measured:

| Way | Measured | Taken |
|---|---|---|
| Make copies at once, off Vitest's process: statements on four owner connections held open on the private socket, never a blocking call | one lane made 8.8 copy-and-drop cycles a second against 4.2 for a blocking `psql` each (whose slowest drop took 6.4 s); four lanes 8.7–13.7 a second (1.7 in one run at load 11). With it, a copy for every Tower test that asks (463) took the suite to 49.2 s against 33.1 s for D1 alone, **+49 %**: seven lanes at once, a copy took 180–213 ms and a drop 104–147 ms, 18–23 tests a second at most, because each copy writes the template's 11 MB again and waits for two checkpoints, each drop for a third | Yes: it also ended the Workers suite's "Network connection lost" and the Tower's "socket hang up" (below). Not enough alone |
| Empty a copy between tests | a copy given back is closed, has its sessions ended and is renamed (3 ms median at seven lanes, p90 326 ms), then emptied of the rows it gained and its sequences put back while the tests run on; spares wait ready. With a copy per test (462), D1 and Postgres runs taken in turn: D1 29.4, 30.1 and 32.0 s, Postgres 35.4 and 36.0 s (a third stopped when the load passed 25), **+18 %** on the medians; single runs of this design's earlier forms read +8 % to +27 % at loads of 11–17 | Yes: `releaseDatabase` |
| Drop copies at the end of the run | saves only the drop, and keeps 463 × 11 MB ≈ 5 GB a run on a disk with 48 GB free | No |

Tried and left: `WAL_LOG` instead of `FILE_COPY` (80 copies in a row fell to
0.7 a second as the WAL filled); emptying every one of a copy's 43 tables with
one `TRUNCATE` (46 ms median, 137 ms p90 alone, 970 ms p90 at four lanes): the
emptying truncates only the tables that hold a row.

**Why a copy given back is as good as a new one.** The template's tables and
sequences are read once at the start. A copy given back is closed to
connections, every session on it is ended and it is renamed, before the
release answers: nothing the test left running can reach it by its old name.
Then every table the template leaves empty that now holds a row is truncated,
and every sequence is set where the template leaves it. The only table the
template holds rows in is `workspaces`, which the application role cannot
write; the start refuses a template holding rows that role could change.
Proven in [`postgres-test-cluster.test.mjs`](../../scripts/postgres-test-cluster.test.mjs):
after a test wrote a site and moved a sequence, the copy given back is handed
out again (its database identity survives the rename), its old name no longer
exists, a connection the test held is ended, and its tables and sequences read
exactly as a new copy's.

**The suites under load** (a second suite beside them, under the machine's
lock, which stops a run once the 1-minute load passes 25 because the
operator's live OS answers from this Mac). A full Tower suite beside anything
passed 25 within 20–70 s: beside a second Tower suite, beside `test:scripts`
on four processes, and the CI form on four workers a suite beside it, for the
old harness and the new alike. So the load tests ran lighter:

| Run (7e6cf28b–4a022a4f) | Beside it | Result | Peak 1-minute load |
|---|---|---|---|
| The Tower suite on four workers, 484 copies | `test:scripts` on four processes | 3,816 of 3,816, no test past its limit, 66.0 s; the scripts 1,742 of 1,743 (one skipped) | 20.1 |
| `apps/tower/test/postgres-store.test.ts`, ten runs (`ro-ujb9.76.47`) | the Tower suite on four workers, 466 copies | 10 of 10 (1.5–2.4 s each); the suite 3,817 of 3,817 | 8.1 |

**The CI form** (`NOTICEOS_REQUIRE_POSTGRES=1 pnpm -r test`, the Tower and the
ingest suites at once): on d07fb1dd it failed twice at load 7–9 (Tower tests
past 5 s, a copy request's "socket hang up", Workers files dropped with
"Network connection lost" before their first test) and passed one workspace at
a time. With this harness it passed alone in 49 s (Tower 45.8 s, ingest
33.3 s) and 56 s (47.0 s, 35.9 s) at loads up to 18 and 22; one run with the
emptying still inside the release timed out two Tower tests that each ask for
five copies, which is why spares wait ready. The orchestrator's runs: 42 s
from load 2.3 (bb9a727f), 43 s from 5.1 (1d1ff2a2), 44 s from 4.2 (d28c2fd6),
50 s from 5.1 (dbdc8807), 59 s from 4.2 (d903fafd); main without Postgres
consumers 36–37 s. Four table
units are porting now and each adds Postgres writes, so today's margin is the
largest it will be.

**Other limits the harness no longer hits.** No time limit was raised for any
of them.

- *The Tower's own store test* (`ro-ujb9.76.47`): its two copies are made
  before each test and given back after it, so a test's own 5 s holds only its
  transactions; ten runs in a row passed beside the Tower suite (table above).
- *A journey's reset* (`ro-ujb9.76.56`): the reset made the fixture server's
  copy again under the same name, a `DROP … WITH (FORCE)` and a new copy, each
  one blocking `psql` in Playwright's own process behind every other server's,
  each `psql` given 5 s to connect. Reproduced without a browser (four
  servers resetting in a loop): a `DROP DATABASE … WITH (FORCE)` waited over
  50 s on `ProcSignalBarrier`, because a drop waits for every backend of the
  cluster to take its barrier and four connections were still in their
  password exchange with a client that could not answer (there, the blocked
  process itself; in a journey run, a fixture server busy building its SQLite
  store can be one); every copy request queued behind it. A copy service
  blocked that long closes, as it resumes, the kept-alive connections requests
  are waiting on, so they all fail at once ("socket hang up", which the
  Tower's own gate run showed): how two resets can be refused in the same
  second. Now a reset gives the used copy back without waiting and takes
  another under a new name, and answers only once the new copy answers a
  query; a fixture call that fails answers with the
  error's own words, with no address or password, and a failing journey
  carries them (`e2e/handler-failure.mjs`).
- *A `psql` child's connect wait* (`ro-4qrz`): the operator's own commands keep
  5 s, so a wrong address is told within seconds; a throwaway cluster's
  sessions wait 30 s (`THROWAWAY_CONNECT_SECONDS`, `scripts/postgres-dev.mjs`).
- *A TCP cluster's port* (`ro-ujb9.76.42`): the import test picked the first
  free port of the range without the retry the run's cluster had, and
  another test file's server took it first ("pg_ctl: could not start
  server", once in three `test:scripts` runs beside the journeys). Every TCP
  cluster now starts through `openOnLoopbackPort`
  ([`postgres-test-cluster.mts`](../../scripts/postgres-test-cluster.mts)),
  inside the range, trying the next free port.
- *The cluster's close test* (`ro-ujb9.76.54`) proves the server stopped by
  its own process, not by binding its freed port, which another test file in
  the same port range could take first.

## 4. How a script reaches it

**No application script needs a database credential.** Every local script
already writes the store through the ingest's operator-authed door (for
example `scripts/config-apply.mjs`, "never a second runtime over the live
sqlite file", bead `ro-bko`); only a *remote* D1 is reached by `wrangler d1
execute --remote`, which has no Postgres counterpart. So:

- **Application writes from scripts go through the ingest**, locally through
  its door and, for a deployed installation, through the deployed ingest with
  the operator token (a bootstrap secret it already holds). The database
  password then lives only in the Hyperdrive configuration and on the host.
- **Operator tools that are not the application** — the migration runner, the
  importer (`ro-ujb9.76.8`), backup and restore — connect as the owner or the
  maintenance role through the host's administrative path. What that path is
  (the private socket of a local server, where no password exists, or a
  connection string the operator supplies when running the tool) is the
  hosting choice, `ro-ujb9.76.12`, and needs the operator.
- **The local OS itself** is the one exception. Its dev server hands both
  Workers the application role's address (section 1), so the runner and
  `pnpm start` need it: the fourth bootstrap secret, `DATABASE_URL`, in the
  installation's secrets file (the operator's choice on `ro-ujb9.76.32`;
  [doc 06](../06-operations.md#bootstrap-secrets-vs-integration-credentials)).
  Both read it at every start, check it as the application login and hand it
  to the dev server's environment only
  ([`scripts/database-address.mts`](../../scripts/database-address.mts),
  `ro-ujb9.76.7.2`); a missing or unusable address, or a database behind the
  code, stops the start in one sentence. `pnpm os:deploy` reads it through
  the runner's same reader, only to read the migration record a commit is
  held against (`ro-ujb9.76.7.1`).
- **A development tool that invents history** is neither. `pnpm seed:local`
  (`ro-ujb9.76.57`) writes rows no door would write as written: reports that
  arrived in July, alerts already acknowledged. The pulse door stamps a
  report's arrival with the server's clock, derives its own alerts (four weeks
  of matching weekdays, so none from fourteen nights) and needs a per-site
  token a `pnpm start` folder does not hold; Add a site writes one site per
  transaction and needs a running Tower. So it writes through the one helper
  as the application login, with the address of the throwaway installation it
  seeds (`DATABASE_URL` in that `pnpm start` folder's secrets file, checked as
  `pnpm start` checks it), in one transaction, and only into a database marked
  for development. Not as the owner: the owner is what brings numbers (the
  importer keeps legacy ids), and invented rows take the store's, so every
  seeded row passes the grants and row security a Worker's write passes.

## 5. One store per call

**Decided and proven.** Every way into a Worker — a request, a scheduled run,
each ingest RPC method — runs with a store opened for that call alone and
closed when it ends: `withWorkspaceStore(env.POSTGRES, ctx, work)`
([`packages/postgres`](../../packages/postgres/README.md)), which closes it
through `ctx.waitUntil`, even when the work throws. Nothing connects until a
module does a unit of work, so a call that never reads the store costs nothing;
the workspace is asked once per call; `store.read` is a READ ONLY transaction,
`store.write` one whole transaction. A connection never outlives its call;
Hyperdrive pools behind the binding.

- **The ingest** ([`src/call-store.ts`](../../workers/ingest/src/call-store.ts)):
  `withCallStore(env, ctx, work)` gives the work `{ ...env, STORE }`. A ported
  module keeps its `(env, …)` signature and reads `env.STORE` where it read
  `env.DB`, so no caller in another unit changes. The entry wraps `fetch`,
  `scheduled` and each RPC method with a module function, never a class
  method: a public method of the entrypoint is callable over RPC.
- **The Tower** ([`worker/index.ts`](../../apps/tower/worker/index.ts)): the
  switch moved unchanged into `route(request, env: CallEnv)`; `fetch` and
  `scheduled` run it inside `withWorkspaceStore`. A ported reader takes the
  store as a parameter (`timeZoneEverSaved(store)`, `buildWallFeed(store, deps)`),
  and the route passes `env.STORE`.
- **No binding** (a test driving a route that never reads the store): every
  unit of work refuses, naming the missing binding, and the call still runs.
- **A module that caches a read** keys the cache by `store.where` (host, port
  and database, never the credential) and the workspace.

## 6. Historical port slices: the settings store (`ro-ujb9.76.4.1`)

What moved, on the Postgres branch (commits `4aebf4df`, `b15cdc66`; the
helpers it needed are on main, `34e204ea`):

- [`workers/ingest/src/config-store.ts`](../../workers/ingest/src/config-store.ts)
  reads and writes `noticeos.config_documents` and `noticeos.config_changes`;
  its HTTP door ([`routes/config-documents.ts`](../../workers/ingest/src/routes/config-documents.ts))
  is unchanged but for the ready state.
- [`apps/tower/worker/config-source.ts`](../../apps/tower/worker/config-source.ts)
  `timeZoneEverSaved` and the Wall feed's settings-saved lines
  ([`wall-feed.ts`](../../apps/tower/worker/wall-feed.ts)) read the same store.
- No asset read was needed: the writer reads no asset table and still sends
  store-column operations to `PATCH /api/assets/:id`.
- [`db/postgres/consumers.md`](../../db/postgres/consumers.md) lists no D1
  consumer of either table but the importer's test, which reads D1 on purpose.

**Proven.** The ingest suite (69 files, 1,311 tests) and the Tower suite (177
files, 3,810 tests) with `NOTICEOS_REQUIRE_POSTGRES=1`; the journeys (56
passed, 14 skipped by design on one viewport, 1.2 min) and the UX flow gate (25 flows × 2
viewports, 71 s) on a Postgres copy per fixture server; the real Workers in
the dev server (section 1); and by hand, a throwaway installation: a cluster
on 127.0.0.1:5400, then `node scripts/start.mjs --dir <tmp> --port 5420
--no-open` with the local-address variable naming a copy. It came up in 12–26 s,
its first start seeded all 13 settings documents into Postgres through the
ingest (`pull` as a list), and a `PUT /api/config` through the Tower saved
`os_time_zone`: document `constants` at version 2 by `operator`, change number
14 in the workspace, and `/api/settings` answered the new zone, chosen. The
installation's own folder took the export; no commit (a plain folder).

**What behaves differently, and the rule behind each:**

| Difference | Rule |
|---|---|
| A document's key is its file's name alone (`config/tower.json` is `tower`); the API still speaks files, translated at the edge (`configDocumentKey`, `configDocumentFile`). | `mapping.json` `config_documents.document_key` |
| The store is always ready: the "no table yet" answer is gone. `storeReady` and `storeReason` stay `true` and `null` in the contract until `ro-ujb9.76.40` removes them. | A migrated store has every table (the baseline) |
| Applying changes is one transaction: the upsert guarded by version, then the audit rows. A stale version rolls both back and answers `version_mismatch`, as before. Seeding is one transaction per file. | One unit of work is one transaction (`store.write`) |
| A scalar document is refused by the table. D1 took any JSON text. | Baseline `config_documents.body` CHECK: an object, or a list (`config/pull.json`) |
| A change is known by its workspace's number (`change_number`), the Wall feed's line id included, never the table's identity. | Readers show per-workspace numbers |
| `ops` is `jsonb`: an operation's keys come back in `jsonb`'s order, not the writer's. The document body is `json`, byte for byte. | `mapping.json` `config_changes.ops`, `config_documents.body` |
| Instants are `timestamptz`; they leave through `javascriptInstant`, in the form `new Date().toISOString()` writes, as D1's text did. | `mapping.json` conversions |
| The one-second read cache is keyed by the store's address and workspace, not by a D1 object. | Section 5 |
| The Tower's clock check with no store (no binding, or a failed read) counts as chosen, as a failed D1 read did. | Its read is total |

`0001_baseline.sql` was edited for this slice (not frozen yet): the document
body CHECK now takes a list as well as an object. `worker-configuration.d.ts`
gained `POSTGRES` by hand in both apps: regenerating it reads the operator's
`.dev.vars`, and a later `cf-typegen` writes the same line from the
`wrangler.jsonc` binding.

### The site registry (`ro-ujb9.76.4.2`)

What moved, on the Postgres branch (the harness commits `d01b4213`,
`3cf564f8`, `23334a90` only add; `4a8ce130` ports the ingest and `2873341b`
the Tower):

- `noticeos.assets` is the site list. Every statement that reads the sites
  alone runs on it. In the ingest: the OS row
  ([`os-asset.ts`](../../workers/ingest/src/os-asset.ts)), the Bing, Clarity,
  DataForSEO and PostHog candidates, the hygiene sweep, and every "is this one
  of our sites" check ([`asset-registry.ts`](../../workers/ingest/src/asset-registry.ts)).
  In the Tower, [`worker/asset-registry.ts`](../../apps/tower/worker/asset-registry.ts)
  (`readSites`, `readSite`, `readSitesById`) feeds the Wall's cards, the asset
  page, the integrations matrix and its hourly record, the Wall feed's names,
  the task board, the alert history, the connect panel and the decisions
  route; the MCP tools and the Tower's cron pass the store on.
- During this slice, the writers
  ([`asset-state.ts`](../../workers/ingest/src/asset-state.ts)) wrote Postgres
  and mirrored each whole site row into D1 inside the Postgres transaction.
  Joins with tables not yet ported read that mirror. `ro-ujb9.76.40` removes
  the mirror after those joins moved; current create, edit and reorder writes
  are Postgres transactions alone.
  [`test/asset-lifecycle.test.ts`](../../workers/ingest/test/asset-lifecycle.test.ts)
  proves statement failure and transaction abort leave sites unchanged;
  [`test/site-order.test.ts`](../../workers/ingest/test/site-order.test.ts)
  proves ordering and timestamps without a second store.

**What behaves differently, and the rule behind each:**

| Difference | Rule |
|---|---|
| Nothing removes a site. The Delete card, `DELETE /api/assets/:id` and the ingest's removal are gone (operator, 2026-09-29, `ro-ujb9.76.4.5`); Archive is the one way out, and the row and its domain stay. | [`README.md`](../../db/postgres/README.md) choice 5; `mapping.json` `targets.assets` (no delete) |
| None in order: sites are listed by each site's stored place, where D1 said `rowid`, and the switch moves no site. The importer turns D1's insertion order into the places; a new site takes the next place, at the end; retiring or restoring a site keeps its place; a move (`moveAsset`, the operator's reorder control) is the one write that changes places. During the port, D1 kept no place and its remaining joins looked sites up by id or ordered by time, name or period. So a moved site stands at its new place in every list ([`asset-registry.test.ts`](../../apps/tower/test/asset-registry.test.ts)). | Baseline `assets.list_position`: unique per workspace, handed out by the workspace's counter; `SITE_ORDER`, `@noticeos/contract` `site-order.ts` (bead `ro-ujb9.76.52`) |
| Text ordered in SQL says `COLLATE "C"`: D1 compares text byte by byte, a Postgres database by the locale `initdb` found. | Keeps D1's order on every host |
| A new site on a domain another site holds is refused as `asset_exists`, naming the site that holds it; D1 took two sites on one domain. Add a site offers to open that site, at its Restore card when it is archived (`ro-ujb9.76.4.6`). | Baseline `assets_one_per_domain` |
| `sense_only` and `is_os` are booleans; every reader turns them back into the 0/1 the contract carries, and instants leave through `javascriptInstant`. | `mapping.json` `assets` columns and conversions |
| At most one OS row per workspace, so "the lowest id wins" has nothing left to decide. | Baseline `assets_one_os` |
| `config:apply --remote` changes nothing: a deployed installation saves its sites, like its settings, in its own Tower, which writes through its ingest. | Section 4: scripts write through the ingest |

The neutral-code gate reads no store: its names come from the installation's
registers and historical D1 seed migrations as text. During this slice,
`scripts/db-migrate.mjs` also made an empty D1 store for `pnpm start`.
`ro-ujb9.76.40` removes that fresh-start D1 setup; legacy migration/import
sources remain separate from the Postgres Worker runtime.

### The stored credentials (`ro-ujb9.76.4.4`)

Under the operator's approval on `ro-ujb9.76.31`,
[`workers/ingest/src/credentials.ts`](../../workers/ingest/src/credentials.ts)
keeps a provider's connection in `noticeos.integration_connections` and its
sealed secret in `noticeos.connection_secrets`. The key, the cipher, the sealed
form, the two-key rotation window and every redaction rule are unchanged; the
contract the Tower reads (`CredentialSummary`) is too. `0001_baseline.sql` was
edited for it: the connection gained the non-secret facts as columns, the
secret version the site ids its key map covers. What behaves differently:

| Difference | Rule |
|---|---|
| A new secret (a Save, a key rotation, a renewed Mediavine session) is the next `secret_version`, written in the transaction that removes the one before; D1 rewrote the row. A write that read the secret first is guarded on that version still being the newest, where D1 compared the ciphertext itself. | `mapping.json` `targets.connection_secrets`: ciphertext is never rewritten in place (the application role has no UPDATE on it) |
| Whose account, the scopes, when connected, the expiry and who set it, and the last balance with its instant are columns of the connection; the site ids a key map covers are a column of the secret version. D1 kept all of them in `fields_json` beside the field names. The expiry source ('flow' or 'operator') and "a balance only with its instant", which the reader enforced by hand, are CHECKs. | `mapping.json` `credentials.fields_json` and its `(derived)` columns |
| Dating a credential and stamping a balance update those columns alone: no key, and the ciphertext, the IV and the verdict stay. D1 rewrote the whole JSON document it had read. | `mapping.json` `targets.integration_connections` revision |
| A prepaid balance is exact from the provider to the card: the digits the provider's JSON carried (read from its source text, never a float), stored as `numeric(14,6)` and read back as text (`ExactUsd` in the contract). D1 kept a float. Past six decimals the store rounds half away from zero (`0.1234565` is kept as `0.123457`), and the card shows dollars and cents rounded from those digits (`$0.12`); a half cent rounds up (`1.005` shows `$1.01`, where the float printed `$1.00`). A figure of $100,000,000 or more does not fit the type: it is not recorded, and the card keeps the sighting it had. | `mapping.json` `credentials` `(derived) balance_usd`: US dollars, six decimals, as provider prices (`research_log`, `archive_runs`); `ro-ujb9.75` |
| A disconnect deletes the connection; its secrets go with it. | Baseline `connection_secrets` foreign key, `ON DELETE CASCADE` |
| The store is always ready: `storeReady` true, no `store-missing` blocker, and a Save never answers `store_unavailable`. A read that cannot reach the store throws instead of reading as "nothing stored"; the env fallback is for a provider with no connection, never for a failed store. `storeReady` and `storeReason` stay in the contract until `ro-ujb9.76.40`. | A migrated store has every table (the baseline) |
| Instants are `timestamptz` and leave through `javascriptInstant`; one that is not an instant (a malformed `connectedAt` handed to a Save) is refused, where D1 kept any text. | `mapping.json` conversions |
| No number: a connection is known by its provider, as before, and its uuid never leaves the module. | Readers show per-workspace numbers (there is no id to show) |

**Redaction on Postgres, proven** in [`credentials.test.ts`](../../workers/ingest/test/credentials.test.ts):
every value a credential statement sends is a parameter, so the statement texts
Postgres keeps (`pg_stat_statements`) hold no secret, key or sealed byte; and a
refused write of a secret carries no row values in its error, because Postgres
withholds "Failing row contains …" on a table with row security, which every
`noticeos` table has. A unit whose table ever loses row security loses that
too.

**Historical credential cutover** (`ro-ujb9.76.36`, approved by the operator
on that bead). This describes the retired import path, not a command for a
new installation. Connect credentials in the
[product's Integrations flow](../11-integrations.md).
At the cutover, `pnpm postgres:import-credentials`
(`scripts/postgres-import-credentials.mjs`; retired source; retained in private history)
reads the D1 backup's `credentials` rows as the sealed bytes they are and
posts them through the ingest's door (`POST /api/credentials/from-backup`,
`routes/credentials-from-backup.ts`; retired source; retained in private history);
`storeCredentialsFromBackup` in `credentials.ts` opens each with
`CREDENTIALS_KEY`, seals it again and stores it, one provider per transaction.
Proven on fake secrets in
`credentials-from-backup.test.ts` (retired source; retained in private history)
and, end to end on the running Postgres build, in
`credentials-from-backup-e2e.test.ts` (retired source; retained in private history).

| Difference | Rule |
|---|---|
| Every column is kept (provider, scope, `key_version`, the names, the site ids, the facts, the instants, the verdict); the IV and ciphertext are new, and the secret version's `created_at` is the instant it was sealed again, as a rotation stamps it. D1 had no secret version. | One secret per connection at rest; a fresh IV for every seal |
| The integration health read keys a connection by its created and updated instants, so the health history the importer carried stays with it. An instant D1 kept in another spelling than `toISOString()`'s would start that history afresh; every D1 writer stamped `toISOString()`, and a value that is not an ISO-8601 instant is refused by row and column. | `integration-health-context.ts` `healthConnection`; `mapping.json` conversions |
| Only `CREDENTIALS_KEY` opens a row here, never `CREDENTIALS_KEY_PREVIOUS`, so what is stored is sealed at the generation its `key_version` names; a row it does not open is named `unreadable` and nothing is stored for it. D1 read a row with either key. | `key_version` names the key that sealed the secret |
| A provider already connected here is left as it is and counted as already stored: a second run, or a provider the operator connected again after the switch, changes nothing. | `integration_connections` UNIQUE (workspace, provider) |
| A prepaid balance is the digits its JSON number was written with, read from the source text, as the importer's rule reads it. | `mapping.json` `credentials` `(derived) balance_usd` |

### Counters and outbound checks (`ro-ujb9.76.5.1`)

What moved, on the Postgres branch (`b74319e9`): the counters lane
([`workers/ingest/src/counters.ts`](../../workers/ingest/src/counters.ts))
writes `noticeos.counter_readings`, one transaction per property, one statement
per card in config order as the D1 batch ran them; the site's Overview reads it
([`apps/tower/worker/counters.ts`](../../apps/tower/worker/counters.ts)
`readCounterReadings(store, …)`). The egress gate
([`egress.ts`](../../workers/ingest/src/egress.ts) `record`) writes
`noticeos.egress_checks`; the freshness check's dark spans
([`db.ts`](../../workers/ingest/src/db.ts) `evidencedDarkSpans`) and the L0
lane ([`integrations-payload.ts`](../../apps/tower/worker/integrations-payload.ts)
`LATEST_EGRESS_CHECK_SQL`) read it. The gate's statements on `flags` stay on
D1 for the alerts unit. Nightly reports left this unit (section 8).

| Difference | Rule |
|---|---|
| A round's `detail` is `jsonb`: its beacons' keys come back in `jsonb`'s order, not the gate's. Every reader parses it, so nothing shown changes. | `mapping.json` `egress_checks.detail_json` |
| `up` is a boolean; the readers take it as the up/down they read from D1's 0/1. | `mapping.json` conversions (INTEGER 0/1 → boolean) |
| Instants are `timestamptz` and leave through `javascriptInstant`; an `observed_at` that is not an instant is refused, where D1 kept any text. Every writer stamps its own `toISOString()`. | `mapping.json` conversions |
| Rounds taken at one instant (one lane run re-asks after five minutes under the run's own stamp) are ordered by their identity, the order they were written, as D1's index returned them by rowid. The dark-span read now says so. | Postgres keeps no insertion order |
| A reading's value is `int8`; it leaves as a number, exact far past any site's total. | Section 7 step 5 |
| No number: no reader shows either table's rows by id. | Readers show per-workspace numbers (there is no id to show) |

### Source health and connection counts (`ro-ujb9.76.5.6`)

What moved, on the Postgres branch (`4f55ba22`): the health store
([`integration-health-store.ts`](../../workers/ingest/src/integration-health-store.ts))
writes `noticeos.capability_targets`, `noticeos.integration_capability_state`
and `noticeos.integration_health_events`, one transaction per observation: the
target found or made, then the D1 batch's three statements in its order. The
health read ([`integration-health-read.ts`](../../workers/ingest/src/integration-health-read.ts))
reads them; its statements on collected metrics, provider reports and Mediavine
stay on D1 for their units. An observation reaches the call's store without a
collector's own persistence changing: `observeIntegration(env, …)` uses
`env.STORE`, and a collection's monitoring carries the store it records into
([`collection-attempt.ts`](../../workers/ingest/src/collection-attempt.ts)
`beginCollection(env.STORE, connection)`; `persistCollectionAttempt` and
`recordCollectedHealth` take no D1 handle). The Tower's source history
([`connection-daily.ts`](../../apps/tower/worker/connection-daily.ts)) and
System health's four counts
([`connection-status-daily.ts`](../../apps/tower/worker/connection-status-daily.ts))
record and read `noticeos.connection_daily_counts` and
`noticeos.connection_status_daily_counts` in the call's store, and the Wall
feed's transitions ([`wall-feed.ts`](../../apps/tower/worker/wall-feed.ts)
`FEED_HEALTH_SQL`) read the events with their targets. `0001_baseline.sql`
gained `integration_health_events_recorded (workspace_id, recorded_at)`
(`bfa98d20`), which the feed and the recent-events read seek.

| Difference | Rule |
|---|---|
| The six columns that say what is monitored are one `capability_targets` row, found or made at a target's first observation; state and events refer to it by `target_seq`, which never leaves the module. An account's target names no site (NULL), read back as `''`. | `mapping.json` `integration_capability_state` and `integration_health_events` notes; baseline `capability_targets` |
| A site not in the site list is refused, and the collection says monitoring was unavailable, as any failed health write does. D1 took any site text. | Baseline `capability_targets` foreign key to `assets` |
| A scope names the call's workspace (`local`) and no other: another is refused as an invalid identity. Workspaces are kept apart by the store, not by a column a scope sets. | Row security; `mapping.json` exception "a workspace_id other than 'local'" |
| Evidence names its Postgres table: a provider report's run is `archive_runs`, where D1 said `signal_dump_runs` (the importer renames old rows alike). The Wall feed maps it back to the line id the report's own line still uses, so a transition and its failed run stay one line. | `mapping.json` `evidence_source` |
| Observations of one target are taken one at a time, as D1's one writer took them: a transaction lock on the target's number, and at its first observation the wait on the target another call is making. Two recoveries at once are one recovery; without the lock each read the failure and both recorded one. | One unit of work is one transaction (section 7 step 3) |
| The Wall feed reads the window's newest 500 transitions down `integration_health_events_recorded`; D1 read the newest 500 rows by rowid and kept those in the window. They differ only past 500 transitions since 6 PM yesterday. | Postgres keeps no rowid |
| Ties: recent transitions by recorded time, then start, then id; states failures first, newest start, then in the order their targets were named; a day's sources byte by byte (`COLLATE "C"`). D1 left ties to its plan. | Section 7 step 4; Postgres keeps no insertion order |
| The store has both count tables, so the hourly step records and the reads answer: their "not migrated" skip and `days: null` are gone. A failed read of System health's record still serves the health read without it. | A migrated store has every table (the baseline) |
| A day's rows and the retention sweep are one transaction; a failure keeps none of them, where D1 kept the rows written before it. | One unit of work is one transaction |
| Instants are `timestamptz` and leave through `javascriptInstant`; a count's `day` is a `date`. | `mapping.json` conversions |
| No number: no reader shows these tables' rows by id; an event's id is its content hash, as before. | Readers show per-workspace numbers (there is no id to show) |

### The money ledger, Mediavine revenue and collector leases (`ro-ujb9.76.6.1`, `ro-ujb9.76.5.5`)

One change, because the financial view reads Mediavine's daily revenue
(`financial_ledger` stands a month of daily estimates in for the estimate it
covers). What moved, on the Postgres branch: `03ecf0b3` and `57693d84` only
add (the FK-safe emptying in the ingest's `reset()`, the evidence loader taking
the store); `6bf27d04` only adds (the coverage rule, below); `26354b82` ports
the ingest and `be385c26` the Tower.

- Ingest: `POST /api/revenue`
  ([`routes/revenue.ts`](../../workers/ingest/src/routes/revenue.ts)) books
  into `noticeos.ledger_entries`, one transaction per pass as each D1 batch
  was; the Mediavine collector, its status, sync and retry state
  ([`mediavine.ts`](../../workers/ingest/src/mediavine.ts)), its account lease
  ([`mediavine-connection.ts`](../../workers/ingest/src/mediavine-connection.ts)),
  the PostHog and GA4 read leases
  ([`posthog-dumps.ts`](../../workers/ingest/src/posthog-dumps.ts),
  [`ga4-read-cache.ts`](../../workers/ingest/src/ga4-read-cache.ts)), the
  health page's Mediavine history
  ([`integration-health-read.ts`](../../workers/ingest/src/integration-health-read.ts))
  and the OS's own report counts ([`db.ts`](../../workers/ingest/src/db.ts)).
- Tower: every money read is of `noticeos.financial_ledger` or
  `noticeos.mediavine_current_daily`:
  [`ledger-history.ts`](../../apps/tower/worker/ledger-history.ts)
  (`loadAssetMonths`, `cents`), `financials-payload.ts`, `daily-revenue.ts`,
  `wall-payload.ts`, `wall-feed.ts`, `asset-detail-payload.ts` and
  `integration-evidence.ts`.
- Tests seed money through
  [`apps/tower/test/money.ts`](../../apps/tower/test/money.ts) (`bookLedger`,
  `writeMediavine`) and the ingest's `bookEntry`
  ([`test/helpers.ts`](../../workers/ingest/test/helpers.ts)).

**Proven.** Two takers of each lease at one instant, round after round:
exactly one gets it; an expired lease can be taken and a live one cannot
([`integration-leases.test.ts`](../../workers/ingest/test/integration-leases.test.ts);
it fails with the expiry check removed). Two uploads correcting one entry at
once book one correction ([`revenue-race.test.ts`](../../workers/ingest/test/revenue-race.test.ts)).
The ledger's own rules refuse what D1's triggers refused
([`ledger-guards.test.ts`](../../workers/ingest/test/ledger-guards.test.ts)).
Every total, month, currency, correction and rounding the Financials page, the
Wall, the asset page and the Mediavine status assert reads as before, to the
cent; [`ledger-current-guard.test.ts`](../../apps/tower/test/ledger-current-guard.test.ts)
keeps D1's current-row guard as the specification and proves every builder
returns exactly its rows from the view.

| Difference | Rule |
|---|---|
| Money is exact from store to screen: sums are cast back to `int8` and leave through `cents()`, which refuses a figure past 2^53 cents rather than rounding it. | Section 7 step 5 |
| A ledger line, a revenue day and a correction's link are shown by the workspace's number (`entry_number`, `daily_number`; a month of daily estimates shows minus its first daily number, as D1 showed minus its first daily id). The route answers with numbers too. A Mediavine run keeps its text id. | Readers show per-workspace numbers |
| A correction that loses the race to another upload's uses up the number its insert was handed: the numbering trigger runs before the one-successor index finds the conflict (`ON CONFLICT DO NOTHING`), so entry numbers skip one there. No number is handed out twice. | Baseline `ledger_entries_one_successor`; "Numbers a workspace hands out" |
| A correction in another month (or of another site, kind, family or currency) is refused in every workspace; on D1 only a store migrated past 0036 refused it. Two Tower tests that held one on a pre-0036 store now prove the refusal, and the month keeps its own row. The importer refuses such a D1 pair by name (`correction-mismatch`). | Baseline `ledger_correction_matches_target` |
| No current-row guard: `financial_ledger` holds only current money entries by construction (no replaced entry, no change entry). D1's `CURRENT` could keep no row the view drops. | Baseline `financial_ledger` |
| An estimate's coverage is data: the route writes `coverage_end` by the one rule the importer applies (`@noticeos/contract/ledger-coverage`), where D1's view parsed the note. | `mapping.json` `ledger` `(derived) coverage_end` (`ro-ujb9.72`) |
| Change entries (D36) share the table and are never money: every reader reads the view or names `kind IN ('revenue','cost')`, the OS's own report counts included. | D36 |
| The Wall feed's ledger tail is the newest 500 entries by number (a change entry counts toward the 500 and is not shown); D1 took the entries whose id lay within 500 of the newest. Ties at one instant are broken by number. | Numbers are handed out in booking order |
| A write the ledger's rules refuse fails with the store's wording ("entries are immutable", "must name an earlier entry"); the route checks each rule first, so its answers are unchanged. | Baseline ledger triggers |
| One Mediavine site per site of ours, and a reported day belongs to a run of its own site. D1 fixtures that broke either are gone. | Baseline `mediavine_sites` UNIQUE, `mediavine_daily` foreign keys (`ro-ujb9.71`) |
| A lease is taken by one `INSERT … ON CONFLICT DO UPDATE … WHERE` expired: the row lock decides between two takers. A given-back lease ends at the epoch (D1 stored 0) and keeps its last owner; no cooldown is NULL (D1 0); a retry time never moves back (`GREATEST`). The PostHog lease's D1 busy retry is gone. | Baseline `integration_leases` |
| The Mediavine site list the account lease caches is `jsonb`: keys come back in `jsonb`'s order. Its reader parses it, so nothing shown changes. | `mapping.json` conversions |
| `auth_blocked` is a boolean; instants are `timestamptz` and leave through `javascriptInstant`. | `mapping.json` conversions |
| Text is ordered `COLLATE "C"`; rows at one instant are ordered by identity (`run_seq`, `daily_id`, `entry_number`), the order D1's rowid gave. | Keeps D1's order on every host |
| The ingest's race test runs on one store; the pre-0036 D1 database it also used is gone from the test config. | A migrated store has every rule |

`0001_baseline.sql` was not edited for this unit.

### Site checks, outreach targets and item dispositions (`ro-ujb9.76.5.8`)

What moved, on the Postgres branch (`6e043a3b` the model, `431deb60` site
checks, `c85365e1` dispositions, `c3a6c420` outreach targets). The ingest's
site checks ([`hygiene.ts`](../../workers/ingest/src/hygiene.ts)) write and
read `noticeos.hygiene_checks`; the alerts they file stay on D1 for the alerts
unit, and no statement or batch wrote both. The Tower reads the readings for
the Sources tab's site health, each site's uptime mark
([`integration-evidence.ts`](../../apps/tower/worker/integration-evidence.ts)
`loadHomeChecks(store, …)`, one `LATERAL` seek per site) and the Wall feed's
"Site checks" line. An operator's dismissal or acceptance of an item
([`decision-actions.ts`](../../apps/tower/worker/decision-actions.ts)) is
`noticeos.item_dispositions`; its key is a text pointer, never joined. The
Link outreach funnel reads `noticeos.reclamation_targets`, and
`pnpm reclamation:import` loads a list through a new operator-authed route,
`POST /api/reclamation-targets`
([`routes/reclamation-targets.ts`](../../workers/ingest/src/routes/reclamation-targets.ts)),
instead of writing a SQL file for `wrangler d1 execute`. No delete on these
tables was left for a site removal to move. `0001_baseline.sql` was edited for
this unit: `hygiene_checks.detail` is `json`. On Postgres the site-health read
applies the window's first day inside the index scan and filters by the check
list; SQLite needed every check named before it could seek the date. The rows
read are the same.

| Difference | Rule |
|---|---|
| A reading's detail is kept byte for byte, so the Sources tab lists the crawler map in the order the check wrote it; `jsonb` would have sorted its keys by length. A detail that is not a JSON object is refused, where D1 kept any text. | Baseline `hygiene_checks.detail json` with `json_typeof(detail) = 'object'`; `mapping.json` conversions (evidence kept as received is `json`) |
| A site-check reading is known by its workspace's number in the Wall feed's line id; readings of one instant (one sweep writes all its checks at one) come newest written first, where D1 left the order to its plan. | Readers show per-workspace numbers; Postgres keeps no insertion order |
| An outreach target's id on the page is its workspace number (`target_number`), where D1 gave its rowid; the page uses it only as a list key. | `mapping.json` `reclamation_targets` `(derived) target_number` |
| A target's status time is an instant: a day ('2026-07-14') is stored as 00:00 UTC and leaves as '2026-07-14T00:00:00.000Z'. The page shows the day, as before. A time that is neither a day nor an instant is refused, where D1 kept any text. | `mapping.json` `reclamation_targets.status_at`: date-only → 00:00 UTC |
| The import writes through the ingest's door, as one transaction: the whole list or none of it, answering how many pages were new, moved forward and re-verified. D1's was a SQL file the operator applied with `wrangler`; `--dry-run` replaces reviewing the file, and `--out` is gone. | Section 4: scripts write through the ingest |
| The open targets the `reclamation-match` rule reads are exported by `pnpm reclamation:open-targets` through the ingest's door (`GET /api/reclamation-targets?asset=…&open=1`, `ro-ujb9.76.5.9`), in the order they were stored; D1's was a `wrangler d1 execute --json` the operator ran. The file holds the rule's own reading (`reclamationTargetList` in `scripts/signal-insights.mjs`: a lowercase domain without `www.`, `''` for no replacement), where wrangler printed the rows. A site holding more open targets than one list may carry (5,000) is refused, never exported in part. | Section 4 |
| The disposition table and its key column carry the model's names (`item_dispositions.item_key`); the contract still says `decisions` and `key`. Ties in a site's list keep D1's order: the key byte by byte, then the order they were written. | `mapping.json` `decisions` → `item_dispositions`; section 7 step 4 |
| Instants are `timestamptz` and leave through `javascriptInstant`; a reading's day is a `date`. | `mapping.json` conversions |

### Nightly reports and alerts (`ro-ujb9.76.5.2`)

What moved, on the Postgres branch (the model, `c4f84c7e`; the port,
`83458e34`): `pulses`, `flags`, `flag_evidence`, `flag_tunes`,
`notifications` and `alert_daily_counts`, in both Workers. In the ingest, the
report door and the alerts it derives ([`db.ts`](../../workers/ingest/src/db.ts)
`writePulse`, one transaction), the freshness check and asset #0's report
counts, and every lane that raises or settles an alert: the nightly pull
([`pull.ts`](../../workers/ingest/src/pull.ts)), the internet check
([`egress.ts`](../../workers/ingest/src/egress.ts)), GA4 quota, the site
checks, the readback windows' verdicts
([`watch-windows.ts`](../../workers/ingest/src/watch-windows.ts)), the
notifier, the nightly alert rollup and the rule backtest. The statements they
share are [`alert-store.ts`](../../workers/ingest/src/alert-store.ts). In the
Tower, every reader of alerts and reports: the Wall, its feed, the site page,
`/alerts` and its history, the rule counts, the alert actions
(`PATCH /api/flags/:number`), the tunes and the MCP answers. Readers read two
views, `noticeos.current_pulses` and `noticeos.current_flags`; writers write the
tables.

| Difference | Rule |
|---|---|
| A report re-sent the same day is that day's next revision, not a rewrite: the day's report is its newest revision (`current_pulses`) and keeps the day's number (`day_number`, its first revision's), as D1's row kept its id. The earlier revision's untouched open alerts stay in the store, marked replaced (`replaced_by_pulse_id`), where D1 deleted them; no reader, count or action sees them. A replaced alert is not a resolved one: it can take no resolution and no disposition. Settled history, the rule counts, the nightly open count and the notifier count what they did (`pulse.test.ts`, `alert-rules.test.ts`, `notifier.test.ts`). | Baseline `pulses.revision`, `flags.replaced_by_pulse_id` and its CHECK; `current_pulses`, `current_flags` (`db/postgres/tests/edge-cases.sql`) |
| A lane that finds its condition still open appends a reading (`flag_evidence`) where D1 rewrote the alert's severity, message and inputs; `current_flags` shows every alert as its newest reading states it, so what the operator reads is the same. The nightly pull's reading carries its night; the internet check, GA4 quota and the site checks stamp the store's clock (`clock_timestamp()`). | `mapping.json` `targets.flags` (no UPDATE of a firing's evidence); a still-open alert that fires again appends to `flag_evidence` |
| The Tower carries the readings of the nightly fetch failure alone (`asset-pull-failed`, `readFlagReadings`); every other alert reaches the page without them, as before. | The Evidence list draws that rule's nights (`ro-ujb9.220`) |
| One open alert per condition is held by a transaction lock on its site and rule (`holdCondition`, `pg_advisory_xact_lock`); a report holds its site's day. D1 had it from running one statement at a time. The internet check's compare-and-set retries are gone: the lock serializes its settle. | Section 7 step 3 |
| Alerts are known by their workspace's number on every surface and in every action (`flag_number`); a report by its day's number; an alert's `pulseId` is its report's day number; a notice names the alert's number (`notifications.subject_ref`). | Readers show per-workspace numbers |
| The notifier's store, the tunes and the readings are always there: `notificationStoreState` is always ready, `tunesRecorded` always true, the site's fetch failures never null, the pull's reading always `recorded`, the rollup always runs. The D1 "no table yet" branches and their tests are gone; the contract keeps `store-missing`, `null` and `false` until `ro-ujb9.76.40`. The journey "before migration 0040 the failing fetch alerts as before" went with them: no Postgres store lacks the readings table. | A migrated store has every table (the baseline) |
| A readback window's verdict was two writes while windows were on D1: the alert first, filed once per window, then the window's close. That state existed on this branch only, between this unit and `ro-ujb9.76.5.7`, which made it one transaction again (below). | Never lose the alert; no bridge table |
| The settled time is a CASE (`settledAtSql`, `@noticeos/contract`), where D1 wrote `COALESCE(resolved_at, disposition_at, fired_at)`, and `flags_asset_settled` is on it: under row security Postgres holds a COALESCE condition back until after the workspace policy, and a condition held back cannot bound an index. Same value. | `wall-feed.test.ts` plan proof; section 7 step 9 |
| The feed's alert and report reads take each site in turn, one bounded seek per site (`CROSS JOIN LATERAL … LIMIT`), as D1's `CROSS JOIN` ordered them; the same rows. The site page's latest-report evidence reads every site in one statement with one array parameter, where D1 went 80 sites at a time for its bind limit. | Section 7 step 9 |
| A report's arrival (the freshness check, coverage, the nightly source) is its day's newest revision's, as D1's re-sent row carried its latest arrival. | `current_pulses` |
| A report is a JSON object or it is refused; D1 kept any text. The door validates the envelope first, as before, so only a test could store one that was not; the page tests that need unreadable evidence store an object with a broken part. | Baseline `pulses.envelope` CHECK |
| `rule_inputs` and a report's capabilities are `jsonb`: keys come back in `jsonb`'s order; every reader parses them. A readback verdict's dedupe reads `rule_inputs->>'watchWindowId'`, where D1 searched the text. The envelope is `json`, byte for byte. | `mapping.json` `flags.rule_inputs`, `pulses.envelope` |
| The nightly rollup's portfolio row names no site (NULL), where D1 wrote `*`; no reader draws the rollup. | `mapping.json` `alert_daily_counts.asset` |
| Ties: alerts by firing time, then identity; the history by settled time, then number, newest first; D1 used its rowid. | Postgres keeps no insertion order |
| Instants are `timestamptz` and leave through `javascriptInstant`. | `mapping.json` conversions |

**What a later unit should know.** `current_flags` and `current_pulses` are
the only way in for a reader; a statement on `noticeos.flags` directly sees
replaced alerts. The settled-time trap is general: under row security a
condition on a COALESCE (and anything Postgres cannot prove leakproof) waits
behind the workspace policy and seeks nothing; write the CASE, or index a
plain column. A plan proof on an empty table is decided by cost ties, so seek
through the site (`LATERAL`) and prove the Index Cond, not only the index's
name.

### Task board, daily task counts and job runs (`ro-ujb9.76.4.3`)

What moved, on the Postgres branch (`c7e328ad` job runs, `80d6501b` the task
photographs and daily counts). The runner's job-run record still reaches the
store through the ingest's door (`POST /api/job-runs`,
[`job-runs.ts`](../../workers/ingest/src/job-runs.ts)), into
`noticeos.job_runs`; the runner and `pnpm start`'s schedule hold no database
credential. The latest-run read (`LATEST_JOB_RUNS_SQL`, `@noticeos/contract`)
feeds asset #0's cron verdict, the Wall's and the OS page's scheduled lanes
([`apps/tower/worker/job-runs.ts`](../../apps/tower/worker/job-runs.ts)); the
manual-run history, the capacity inventory's lane timings
([`capacity.ts`](../../workers/ingest/src/capacity.ts) `measureLanes`) and the
Wall feed's failed jobs (`FEED_JOBS_SQL`) read the same table. The poller's
photograph (`POST /api/beads-snapshot`,
[`beads-snapshots.ts`](../../workers/ingest/src/beads-snapshots.ts)) is
`noticeos.task_snapshots`, its day `noticeos.task_daily_counts`
([`beads-daily.ts`](../../workers/ingest/src/beads-daily.ts)); the Tower's
readers ([`beads-snapshot.ts`](../../apps/tower/worker/beads-snapshot.ts),
[`beads-daily.ts`](../../apps/tower/worker/beads-daily.ts)) feed the Tasks
page, the task source, the Wall's and the site pages' task reads and the Wall
feed's tasks done and filed (`FEED_TASKS_SQL`). The task board and the
task-source seam take the call's store alone. `scripts/start.test.mjs` reads a
start's firings from its own Postgres copy with the application login it
already holds. No table here references a site or another unit's table, and no
delete was left for a site removal. `0001_baseline.sql` was not edited.

The ingest isolation probe first used a D1 task photograph, then a mirrored
site while the port was incomplete. Under `ro-ujb9.76.40` it leaves a saved
Postgres settings document and site, an R2 object, a cached response, warm
modules and a dead fake clock. The next file must start clean, and delayed
Postgres, R2 and cache writes from ended tests must be refused
([`isolation-probe.ts`](../../workers/ingest/test/isolation-probe.ts)).

**Proven.** Two captures of one day at once union their closings and leave one
whole photograph; without the snapshot lock the same test loses a closing
([`beads-daily.test.ts`](../../workers/ingest/test/beads-daily.test.ts)). A
capture whose day the store refuses leaves no photograph. A re-sent firing takes
no number ([`job-runs.test.ts`](../../workers/ingest/test/job-runs.test.ts)).
The feed's failed jobs seek `job_runs_started` and its photographs
`task_snapshots_captured` ([`wall-feed.test.ts`](../../apps/tower/test/wall-feed.test.ts)).

| Difference | Rule |
|---|---|
| A capture is one transaction behind the workspace's snapshot lock (`pg_advisory_xact_lock`): the newest row read, the day unioned, the photograph touched or written, the row it replaces compacted, the sweep. A failure keeps none of it, where D1 kept the statements before the failure. | One unit of work is one transaction; section 7 step 3 |
| A photograph is `jsonb`: its keys come back in `jsonb`'s order, and an unchanged board is found by comparing JSON values, which the normalized payload makes the same test as D1's byte comparison. Every reader parses it, so nothing shown changes. A photograph that is not a JSON object is refused, where D1 kept any text; the board's "unreadable payload" is now one of the wrong shape. | `mapping.json` `beads_snapshots.payload` (JSON → jsonb); baseline `task_snapshots.payload` CHECK |
| The snapshot route answers no `id`: a photograph has no number of its workspace's, and nothing read the rowid D1 answered. | Readers show per-workspace numbers (there is no id to show) |
| The store always has the daily counts: the rollup's "not migrated" answer and the board's `historyDays: null` are gone. The contract keeps `number \| null` until `ro-ujb9.76.40`. | A migrated store has every table (the baseline) |
| A day's project is the column `project` (D1 `asset`), translated at each reader's edge. Projects are listed byte by byte (`COLLATE "C"`); the backfill reads each UTC day's last photograph, of two at one instant the later written. | `mapping.json` `beads_daily_counts.asset` → `project`; Postgres keeps no insertion order |
| The feed reads the photograph in force at each quarter hour, of two at one instant the later written; a bead in several photographs keeps the oldest photograph's line (D1 left the order to its plan). An item's time is the text the writer stored, compared byte by byte as D1 compared it. | Section 7 step 4 |
| A batch of firings and its sweep are one transaction. A firing the store already holds, or one a batch names twice, is left out before the insert, so a re-sent record takes no number (the numbering trigger runs before a conflict is found); the answer's counts are unchanged. | One unit of work is one transaction; "Numbers a workspace hands out" |
| A failed job's feed line is known by its workspace's number (`job_run_number`), where D1 gave its rowid. Two manual runs at one instant, or two failed jobs finished at one, come the later recorded first. | Readers show per-workspace numbers; Postgres keeps no insertion order |
| The latest-run read is `DISTINCT ON (job)` where SQLite used its bare-column `MAX` rule: the same rows, `(job, started_at)` being unique. | Plain Postgres (section 7 step 4) |
| A lane's durations are exact (`timestamptz` subtraction, where D1 went through `julianday` floats); the nearest rank is truncated as D1's integer cast was; lanes are listed byte by byte; the inventory's lanes are never null. | `mapping.json` conversions; a migrated store has every table |
| Instants are `timestamptz` and leave through `javascriptInstant`. | `mapping.json` conversions |

### Collected metrics (`ro-ujb9.76.5.3`)

What moved, on the Postgres branch: the GA4, Search Console and Bing
collectors write `noticeos.signal_runs`, and a run's changed values go to
`noticeos.signal_observations` under the `measurement_series` they measure, in
one transaction with the read of the prior values
([`signal-store.ts`](../../workers/ingest/src/signal-store.ts)
`recordSignalSuccess(env, …)`, `recordSignalFailure(env, …)`). The ingest's
readers: the previous reporting zone
([`time-zone-change.ts`](../../workers/ingest/src/time-zone-change.ts)
`previousTimeZone(store, …)`), the watch evaluator
([`watch-windows.ts`](../../workers/ingest/src/watch-windows.ts)
`aggregateMetric(store, …)`), the panel trend
([`panel-source.ts`](../../workers/ingest/src/panel-source.ts)
`readPanelTrend`) and the daily lanes' health
([`integration-health-read.ts`](../../workers/ingest/src/integration-health-read.ts)).
The Tower's: the charts
([`signal-trends.ts`](../../apps/tower/worker/signal-trends.ts)
`loadSignalTrends(db, store, …)`; the dated zone changes stay on D1 with the
annotations), the lanes' latest attempt
([`integration-evidence.ts`](../../apps/tower/worker/integration-evidence.ts)
`loadLatestSignalRuns(store, …)`), the watch calibration
([`asset-detail-payload.ts`](../../apps/tower/worker/asset-detail-payload.ts)
`readWatchSeriesHistory`) and the feed's collections
([`wall-feed.ts`](../../apps/tower/worker/wall-feed.ts)
`FEED_SIGNAL_FAILURES_SQL`, `FEED_SIGNAL_LATEST_SQL`). Tests write the rows
through [`workers/ingest/test/helpers.ts`](../../workers/ingest/test/helpers.ts)
`storeSignalRuns` and [`apps/tower/test/collected-metrics.ts`](../../apps/tower/test/collected-metrics.ts)
`writeSignalRun`.

| Difference | Rule |
|---|---|
| A value is stored under its series: `measurement_series` names a site's metric from one provider property under one reporting zone once, on first use; a value keeps its series and its run's identity. D1 kept the metric on every value and the property and zone on the run. Every reader answers as before. | `mapping.json` `signal_observations` → `measurement_series` (`ro-ujb9.70`) |
| The store refuses a value under a run that did not succeed, and a metric its provider does not report. D1 took both; no reader ever showed them. Test fixtures that wrote them (a failed run carrying a value, a Bing `sessions` series) write none, or Bing's clicks. | Baseline trigger `signal_observation_matches_run`; `noticeos_ref.metric_kinds` |
| `started_at` and `finished_at` are instants, so two spellings of one instant are one instant, and a time with no zone is UTC, as the importer reads it. D1 compared their text: among odd spellings (`…T09:00:00Z`, `…T09:00:00.000Z`, `…T09:00:00`, `… 23:00:00`) the newest write could differ; three answers of `signal-trends-newest-write.test.ts` changed. For every instant the collector writes (`toISOString()`), the newest write is the one D1 chose, same millisecond included (the same file proves it). | `mapping.json` conversions; `scripts/postgres-import-rules.mjs` `parseInstant` |
| Runs that finished (or started) in the same instant: where D1 said `rowid DESC`, the identity descending; where D1 left the order to its index, the order they were written, stated in `ORDER BY`. The panel trend still breaks a tie by the run's own id, as it did. | Postgres keeps no insertion order |
| A run is never rewritten: the application role may only insert. A test that changed a run's zone or status after writing it writes it that way. | `mapping.json` `targets.signal_runs` (append-only) |
| A run's window ends on or after its start and its provisional day, and it finishes on or after it starts; a zone is never empty. D1 checked none of these; the collectors always met them, and a fixture window that ended before its own provisional day was corrected. | Baseline `signal_runs` CHECKs |
| The Bing properties a site was saved under were read from its daily runs on Postgres and its archive runs on D1, merged as D1's one UNION answered, until the archive half moved with provider reports (`ro-ujb9.76.5.4`): one statement again, below. | Section 8: a statement across two units' tables moves with the later |
| The feed's collection lines name a run by its own id, as before; no number is shown. | Readers show per-workspace numbers (there is no id to show) |
| The feed's newest success per site and lane is one `LIMIT 1` seek, and its failures the newest per lane, where D1 grouped every run of the window. Same rows. | Section 7 step 9 |

### Change notes and readback windows (`ro-ujb9.76.5.7`)

What moved, on the Postgres branch (the ingest, `875f2508`; the Tower, `6529fff4`
and the commit after it): `annotations` and `watch_windows`, whose readings
are rows of `noticeos.watch_window_readings`. In the ingest, the change writer
([`annotations.ts`](../../workers/ingest/src/annotations.ts), the operator door
and the Tower's binding), the time-zone lane's lookup
([`time-zone-change.ts`](../../workers/ingest/src/time-zone-change.ts)), the
registration route ([`routes/watch-windows.ts`](../../workers/ingest/src/routes/watch-windows.ts)),
the daily sweep ([`watch-windows.ts`](../../workers/ingest/src/watch-windows.ts))
and the readback queue ([`watch-readbacks.ts`](../../workers/ingest/src/watch-readbacks.ts));
[`watch-window-store.ts`](../../workers/ingest/src/watch-window-store.ts) turns
the Postgres rows into the D1 row the route answers with and the sweep
evaluates. In the Tower, the site page's timeline, alert changes, recorded
change days and watch strip, the Wall's attention changes, the feed's change
lines, `/alerts` history, the alert evidence's window verdicts and the trend
charts' time-zone marks. The alert review and the history builder and route
take no D1 handle any more, nor does the trends loader, whose series moved
with `ro-ujb9.76.5.3`. Tests seed through `apps/tower/test/change-rows.ts` and
the ingest's `insertAnnotation`; the journeys' OS deploy through
`seedWallFeedChanges`. `0001_baseline.sql` was not edited for this unit.

| Difference | Rule |
|---|---|
| A window's close, the readings the close took, and its alert are one transaction again, the close first: it holds the window's row, so a sweep that finds the window closed files nothing. The two-write order the alerts unit left on this branch is gone. A refused alert undoes the close and the readings (`watch-windows.test.ts` "undoes the close when its flag is refused"), and the next sweep closes once. | One unit of work is one transaction |
| A reading is a row, appended; D1 rewrote a growing JSON array on the window. The readings' key (window, offset) stops a second read of one offset, and an interim reading is appended in the transaction that stamps the check, which holds the window's row. | Baseline `watch_window_readings`; `mapping.json` `targets.watch_window_readings` (append-only, one per offset) |
| Registering a bet and filing a change each read and write under a transaction lock on their identity (the bet's asset, ref, series and scope; the change's asset, instant, kind and ref), so posts of one at once store one row. D1 had that from running one statement at a time. Both tests fail with the lock removed. | Section 7 step 3 |
| A change is known by its workspace's number everywhere: the writer's answer, every reader, the feed's line id. A window anchors a change when its ref is exactly that number written out (canonical digits), D1's `CAST(anchor.id AS TEXT) = w.ref`; the importer keeps each change's id as its number, so the refs an installation holds still anchor. | Readers show per-workspace numbers; `mapping.json` `annotations` `(derived) annotation_number` |
| A change's day is the UTC day of its instant, and a day bound is an instant (the next UTC midnight), which the (site, time) index seeks; D1 cut ten characters from its text. Every writer stamped `toISOString()`, so the days are the same. | `mapping.json` conversions |
| A window's instants are `timestamptz` and leave through `javascriptInstant`; its offsets are an integer array; its scope and thresholds are `jsonb`, given back as compact JSON, keys in `jsonb`'s order. Two scopes are one bet when they are the same JSON value, where D1 compared text. | `mapping.json` `watch_windows` columns |
| A window the route could never have written cannot be stored: a `registered_at` that is not an instant, a metric outside the vocabulary. The two sweep-report tests that stored such a row now make the store refuse one window's close, and that window is reported overdue as well as failed. | Baseline `watch_windows` columns and the `metric_kinds` foreign key |
| A per-site read with no `LIMIT` (the Wall's attention changes, the trend charts' time-zone marks, the timeline's anchor) is fenced with `OFFSET 0`: without it Postgres flattens the join into one pass over every site's changes, which an index leading with the site cannot seek. The timeline's anchors are picked out first (a materialized list of the canonical refs) and each is a seek on the workspace's numbers. | Section 7 step 9 |
| The readback queue stamps the posted verdicts in one statement over the ids, and answers in the caller's order, as the D1 batch did. | One unit of work is one transaction |
| Ties: open windows by registration, then id byte by byte; changes at one instant by number, newest filed first where D1's index gave newest rowid first. | Postgres keeps no insertion order |

**What a later unit should know.** A `LATERAL` without a `LIMIT` is not a
per-site read on Postgres unless something stops the planner flattening it
(`OFFSET 0`); prove the Index Cond names the site.

### The developer seed (`ro-ujb9.76.57`)

`pnpm seed:local` ([`scripts/db-seed.mjs`](../../scripts/db-seed.mjs)) writes
[`db/fixtures/dev-seed.json`](../../db/fixtures/dev-seed.json) into the
Postgres tables the Tower reads, for the installation `pnpm start` keeps in a
folder (section 4 says as whom and why no door). Proven in
[`scripts/db-seed.test.mjs`](../../scripts/db-seed.test.mjs), the last test
through a real `pnpm start`: its Wall lists both sites with their alerts, the
site page shows the last night's report and the seeded alert, and the money
reads $683.85 for May and $783.70 against $22.10 for June.

| Difference | Rule |
|---|---|
| The target is a `pnpm start` folder's store, named by that folder's `DATABASE_URL`; D1's was the checkout's own local store. No local store file is opened and nothing reaches D1, so the door interlock went: it runs beside a started Tower. | Section 4; one runtime owns a local store file (`scripts/no-second-runtime.test.mjs`) |
| A database not marked `noticeos.profile = 'development'` is refused: a `pnpm start` folder's address defaults to the Compose profile's, an installation's own database. D1 had only the empty-store guard. A development database a folder can reach is set up by hand today (`ro-ujb9.76.69`). | The development profile's mark (`scripts/postgres-profile.mjs`, which the seed reads without loading the runner); `pnpm postgres:migrate` and `pnpm postgres:import` refuse a marked database |
| The empty-store refusal counts `pulses`, `flags`, `ledger_entries`, `counter_readings` and `annotations`, and a site on one of the fixture's ids or domains, inside the writing transaction behind a transaction lock, so two seeds at once seed once. | One unit of work is one transaction; section 7 step 3 |
| Every row is one transaction: a row the store refuses keeps none. D1 applied a SQL file statement by statement. | One unit of work is one transaction |
| Every number and place is the store's, handed out in the fixture's order, so reports, alerts, ledger entries and change notes number as D1's ids did. An alert names its report by site and day, a correction its entry by `external_id`. | Readers show per-workspace numbers; baseline "Numbers a workspace hands out" |
| The OS's own rows are left out (seven OS cost lines and its model-change note): a new installation has no OS site and the product makes none. On D1 they found the checkout's own OS row; on a `pnpm start` store, whose sites are removed, the D1 seed failed on them. | Baseline `assets_one_os`; `createAsset` never sets `is_os` (`workers/ingest/src/asset-state.ts`) |
| The change the build cost names, `chg-0421`, is a change entry with the prediction it shipped with; D1 could hold no change entry. | D36, D38; baseline `ledger_entries` change CHECK |
| Instants are `timestamptz`, a report's envelope `json` byte for byte, capabilities and inputs `jsonb`; the fixture is the store's own tables and columns as data, sent as parameters. D1's was a SQL file. | `mapping.json` conversions; values cross as parameters (`packages/postgres`) |

### Provider reports, paid lookups and insight snapshots (`ro-ujb9.76.5.4`)

What moved, on the Postgres branch: every report collector (GA4, Search
Console, Bing, DataForSEO, Clarity, PostHog) writes its attempts to
`noticeos.archive_runs` and each stored object once to
`noticeos.archive_objects`
([`signal-dumps.ts`](../../workers/ingest/src/signal-dumps.ts)
`recordDumpSuccess(store, …)`, `recordDumpFailure(store, …)`,
`archiveDumpFailure(store, …)`); a paid lookup goes to `noticeos.research_log`
([`research-log.ts`](../../workers/ingest/src/research-log.ts)
`recordResearch(store, …)`, `findPriorResearch(store, …)`); a published
analysis to `noticeos.asset_insight_snapshots`
([`insight-snapshots.ts`](../../workers/ingest/src/insight-snapshots.ts)). The
metered spend both Workers sum is one read of both tables
([`metered-spend.ts`](../../packages/contract/src/metered-spend.ts)
`loadMeteredDataSpend(store, …)`). The Tower's readers take the store only:
`loadIntegrationEvidence(store, …)`, `buildIntegrationsMatrix(store, …)`,
`recordTodaysSourceHistory(store, …)`, `loadProviderMeter(store, …)`,
`loadSpendPreview(store, …)`, `loadLatestPanelLandings(store, …)`,
`readRecommendationSources(store, …)` and the feed's `FEED_DUMPS_SQL`,
`FEED_RESEARCH_SQL`, `FEED_INSIGHTS_SQL`. Tests write the rows through
[`workers/ingest/test/helpers.ts`](../../workers/ingest/test/helpers.ts)
`storeArchiveRuns`, `storeInsightSnapshots` and
[`apps/tower/test/provider-reports.ts`](../../apps/tower/test/provider-reports.ts)
`writeArchiveRuns`, `writeResearch`, `writeInsightSnapshots`. The raw reports in
R2 are untouched.

| Difference | Rule |
|---|---|
| A price is `cost_usd` beside `cost_state`. A positive figure is reported; a zero from DataForSEO is a price the collector could not read, so it is unknown and stores no figure; a zero elsewhere is a reported zero. The importer reads D1's rows by the same rule (`storedProviderCost`, in the contract). An unknown price adds nothing to a sum, as D1's zero added nothing, so every spend figure is as before. | `mapping.json` `signal_dump_runs.provider_cost_usd`, `research_log.cost_usd`; baseline `CHECK ((cost_state = 'unknown') = (cost_usd IS NULL))` |
| Spend is summed exactly (`numeric`) and becomes a number at the edge; D1 summed floats. The month a provider-spend row belongs to is `to_char(report_date, 'YYYY-MM')`. | `mapping.json` conversions |
| A stored object is recorded once per key, dated by the first run that stored it; an unchanged run names the same object. A run naming a key stored with other content is refused. D1 kept key, hash and size on every run. | `archive_objects` `UNIQUE (workspace_id, object_key)`; `mapping.json` `signal_dump_runs` → `archive_objects` |
| The store refuses an empty report name, a hash that is not 64 hex characters, and a stored run with no object. D1 took them; fixtures that wrote them write valid ones. | Baseline `archive_runs`, `archive_objects`, `research_log`, `asset_insight_snapshots` CHECKs |
| Runs, lookups and snapshots are only ever inserted by the application. A test that changed a snapshot's `created_at` after writing it writes it that way. | `mapping.json` targets (append-only) |
| Attempts that finished in one instant: where D1 broke the tie by the run's id, the id's byte order; where by `rowid` or its index, the one written last. Lists of reports and families are byte order, as D1's. | Postgres keeps no insertion order |
| A paid lookup is numbered in its workspace; the feed's cost line names that number, as it named D1's row id. | Readers show per-workspace numbers |
| A site's two newest analyses are the two the store keeps by (`generated_at`, `created_at`, `snapshot_id`), newest first; `created_at` is the store's clock. | Baseline `noticeos.insight_snapshot_is_kept` |
| Instants are `timestamptz` and leave through `javascriptInstant`: one written without milliseconds reads back with `.000Z`. | `mapping.json` conversions |
| D1's case-insensitive `LIKE` is `ILIKE`; its `GLOB` a regular expression; a list bound as JSON is `= ANY($n::text[])`. Same rows. | Section 7 |
| PostHog's lane no longer asks whether the store accepts PostHog runs (D1 before migration 0037 did not): a migrated store does, so the `store-not-ready` skip and the pre-0037 test database are gone. The later capacity port reports missing tables and unknown summaries. | A migrated store has every table; capacity diagnoses an incomplete schema |
| The Bing properties a site was saved under are one statement again: its daily runs and report runs, distinct, byte order, the first 50. | Section 8 |
| The feed was the last Tower read to take D1 beside the store; none of its reads is on D1 now, so `buildWallFeed(store, …)` and `handleWallFeedRequest(…, store, …)` take the store only, and the ingest tests' reset empties no D1 table. | Section 8: a file more than one unit changes |
| The feed reads each lane's report runs by one seek down its (lane, asked) index, and a site's insights when its newest analysis is inside the window, where D1 searched one `IN` list and asked `EXISTS`. The latest attempt per report family is one seek per family (`latestDumpRunsSql`). Same rows; each read's plan is pinned in its test. | Section 7 step 9 |
| `signals:download --remote` and `signals:publish-insights --remote` are refused and read or write nothing: they reached D1 with wrangler. The local lanes go through the ingest door as before. The cost import's booked note says "from its report runs"; a note is no part of a booking's identity, so a replay is still a replay. | Scripts reach the store through the ingest door (section 4) |
| The contract's evidence source `signal_dump_runs` and the feed's line ids (`signal_dump_runs:<run>`, `cost:research_log:<number>`) keep their names: they are identifiers the client and the health records share, not tables. | — |

### Capacity inventory (`ro-ujb9.76.7.4`)

The capacity route reads `env.STORE` alone, in sequential application-role
read-only transactions. The operational catalog is
[`db/postgres/tables.json`](../../db/postgres/tables.json), proved against the
migrated schema by `capacity.test.ts` and `postgres-model.test.mjs`. The
historical D1 catalog remains tied to its own migrations.

| Difference | Rule |
|---|---|
| Tables and columns come from the `noticeos` schema's Postgres catalogs; each table's stored value bytes come from `pg_column_size`, which includes compression. `relationBytes` includes heap, indexes and TOAST. D1 measured uncompressed value lengths. | Doc 26; Postgres size functions |
| All row counts, sizes, arrivals and summaries are workspace scoped. Physical database, relation and bucket totals are withheld while multiple workspaces share the store; manifests remain readable in that workspace. | D27; baseline forced row security and `noticeos.only_workspace()` |
| An observation joins its run by `(workspace_id, run_seq)` and takes that run's `finished_at`. | Baseline `signal_observations` foreign key |
| Retained insight snapshots are a cache under the approved two-newest rule; snapshot moves remain history. Numbering counters, measurement-series keys, capability targets, export acknowledgements and item dispositions are state. | Baseline revision rules; doc 26 |
| Missing tables remain visible in the catalog readback; a summary whose tables are absent is unknown (`null`). Scan duration includes each table's read transaction and connection time. | Doc 26's inventory contract |

## 7. How to port one consumer

This records the completed D1-to-Postgres port recipe. The retired
`mapping.json` supplied its conversion rules; it is not a public dependency or
a current setup step. For current schema work, read the
[table catalog](../../db/postgres/tables.json),
[frozen baseline](../../db/postgres/migrations/0001_baseline.sql) and
[consumer inventory](../../db/postgres/consumers.md). Applied migrations remain
append-only and changes to an existing installation require operator approval.

In the historical port, a unit was a set of tables (section 8). For each:

1. **Claim the unit's bead.** Read its tables in
   `db/postgres/mapping.json` (retired source; retained in private history) (targets,
   columns, conversions, per-workspace numbers) and in `0001_baseline.sql`
   (keys, CHECKs, foreign keys, indexes).
2. **Find every statement on those tables**, in every file
   `db/postgres/consumers.md` lists for them, runtime and tests. A statement
   that also names another unit's table moves with the later of the two. A
   foreign key to or from another unit's table (other than `assets`) means
   the two units are one change (section 8): stop and say so before porting.
3. **An ingest module** keeps its `(env, …)` signature and reads `env.STORE`:
   `env.STORE.read(tx => …)` for reads, `env.STORE.write(tx => …)` for work that
   writes, with the whole read-modify-write inside one call; a D1 `batch`
   becomes one `write`. One transaction is not one writer: D1 ran one batch at
   a time, Postgres runs them side by side, so a batch whose statements read a
   row they then change takes a lock on that row's key first
   (`integration-health-store.ts`, `pg_advisory_xact_lock`), with a test that
   fails without it. **A Tower reader** takes `store: WorkspaceStore`; the
   route in `worker/index.ts` passes `env.STORE`. During the port, readers of
   tables not yet moved temporarily took both handles; that interface is gone.
4. **The SQL.** Plain Postgres: `noticeos.`-qualified names from the mapping,
   `$1…$n`, `JOIN … ON` (SQLite's `CROSS JOIN … ON` is not Postgres), `ON
   CONFLICT` for upserts, `unnest($1::text[], …)` for a batch, explicit casts
   (`$1::timestamptz`). An insert writes `workspace_id` as `tx.workspaceId`;
   row security scopes every read, so a `WHERE` never filters by workspace for
   safety, but a join on a composite key names `workspace_id` so it uses the
   index. An `ORDER BY` on text says `COLLATE "C"`, D1's byte order; where D1
   ordered sites by `rowid`, order by `SITE_ORDER` (`@noticeos/contract`).
5. **What leaves.** Instants through `javascriptInstant`; `int8` cast in SQL
   (`::int` for a count, `::text` for an id) or converted, never a `bigint` in
   JSON; an id a page shows or acts on becomes the per-workspace `…_number`;
   keys the mapping renamed are translated at the module's edge so callers
   keep their shape.
6. **No D1 fallback.** The D1 statement goes; nothing tries D1 when Postgres
   fails. The temporary site mirror was removed by `ro-ujb9.76.40`.
7. **Site removal: nothing to move.** A site is never deleted (operator,
   2026-09-29, `ro-ujb9.76.4.5`), so there is no has-data check any more:
   `REFERENCING_TABLES`, `REFERENCE_SQL` and
   `scripts/asset-referencing-tables.test.mjs` are gone, and
   `workers/ingest/src/asset-state.ts` holds no statement on your tables. A
   branch that rewrote a `REFERENCE_SQL` line drops that change when it
   rebases.
8. **The tests.** Ingest: rows through `env.STORE`; clear rows the
   application role may not with `emptyTables` / `asOwner`
   ([`test/helpers.ts`](../../workers/ingest/test/helpers.ts)); every file
   starts on a copy made again, holding the seeded sites. Inside a file,
   `reset()` clears mutable tables through `EMPTIED_BEFORE_EACH_TEST`; the
   owner empties only tables holding rows. Owner statements run asynchronously
   through the copy service, without blocking Vitest's process. Tower:
   `createTestStore()` (`store` to seed as `noticeos_app`, `call` for the
   reader, `url` for a Worker's binding), closed after the test; fake only
   `Date` when a test freezes the clock. Sites, in either suite, through its
   `test/sites.ts` (section 8). A Tower test that needs your rows writes them
   into `await sitesStore(ctx)`: that copy then serves this test alone. So
   take your rows out of a seed every test in a file runs (a `beforeEach`)
   and write them in the tests that read them; a shared seed that writes
   Postgres gives every test its own copy, and the suite queues on them
   (section 3). A test that proves a view "reads nothing" records the store's
   statements (`recordingStore`, `test/postgres-store.ts`).
   A test that fakes `setTimeout` fakes the store's connection pool too, which
   keeps timers of its own: count the timer you mean by its delay (a spy on
   `setTimeout`), never `vi.getTimerCount()`
   (`workers/ingest/test/hygiene.test.ts`, the uptime tests).
   Journeys: the harness's copy (`journeyPostgres` in
   [`e2e/harness.ts`](../../apps/tower/e2e/harness.ts)); seed through it and
   forget the ingest's read cache after.
9. **Check the plans that matter.** A read the old test proved seeks an index
   is proved again on Postgres (`set_config('enable_seqscan', 'off', true)`,
   then `EXPLAIN`; `wall-feed.test.ts` shows how). A test copy is never
   analyzed, so Postgres guesses every `workspace_id = …` to keep one row in
   two hundred and may seek on a key's first columns alone. Where a read joins
   several tables, state its order (a `LATERAL` per step, fenced with
   `OFFSET 0` or a `LIMIT`, as `signal-trends.ts` does), and give the proof a
   history of the size a year collects (`writeSignalHistory` in
   `apps/tower/test/collected-metrics.ts`), not a fixture's handful of rows.
10. **Regenerate** `node scripts/postgres-docs.mjs --write`: the unit's tables
    show no consumer but the importer. The list is found by text (`FROM`,
    `JOIN`, `INTO`, `UPDATE`, `TABLE` before a D1 table's name, `noticeos.`
    names excepted), so a comment such as "the key into counter_readings"
    keeps a file listed: reword it. Add each behaviour difference to the
    table in section 6's form, with its rule.
11. **Gates.** During scoped work: `pnpm ux:gate`, `pnpm neutral:gate`,
    the affected workspace's typecheck and touched tests with
    `NOTICEOS_REQUIRE_POSTGRES=1` and `NOTICEOS_TEST_POSTGRES_PORTS` set to
    its port block. Coordinate a single full-suite timing slot. The independent
    verifier re-executes all five gates on the assembled build before merge:
    `pnpm -r typecheck`, `pnpm -r test`, `pnpm test:scripts`, `pnpm -r build`,
    `pnpm test:journeys`. Repeated full runs are not a substitute for the
    deterministic async-operation, setup-failure and isolation proofs
    ([`postgres-test-cluster.test.mjs`](../../scripts/postgres-test-cluster.test.mjs),
    [`ingest-test-setup.test.mjs`](../../scripts/ingest-test-setup.test.mjs),
    [`isolation-probe.ts`](../../workers/ingest/test/isolation-probe.ts)).
12. **Commit.** Anything that only adds (a helper, a harness change a port
    needs) first and separately, so main can take it; the replacing commit on
    the Postgres branch, with the unit's bead id.

## 8. Historical migration sequence and current Postgres-only setup

The original migration sequence below explains why units moved together;
it is not a task-status register.

**Units were cut by tables, not by Worker.** A table's writers and readers
moved in one unit, in both Workers, so no flow wrote a row one store held and
read it from the other. Tables sharing a statement moved together. Every
site-owned table's Postgres row references `noticeos.assets`, so the site
registry moved first.

**A foreign key coupled two units in both stores, so they moved together.**
The ingest's D1 store and Tower's SQLite adapter enforced foreign keys, so a
child row whose parent moved to Postgres was refused on D1; Postgres likewise
refused a child row whose parent had not arrived yet. The example: D1 `flags.pulse_id REFERENCES
pulses(id)`, and `writePulse` (`workers/ingest/src/db.ts`) stores a nightly
report and derives its alerts in one unit of work keyed on that report's id.
With reports on Postgres and alerts on D1, every report that raises an alert
would fail its D1 insert; the reverse order is refused by `noticeos.flags`'
reference to `noticeos.pulses`. So nightly reports moved into the alerts unit
(`ro-ujb9.76.5.2`). The site list was the one parent kept in both stores
through its temporary mirror; no other bridge row was built. The mirror is removed in
`ro-ujb9.76.40`.

| Port unit | Original D1 tables | Bead | Port order |
|---|---|---|---|
| Settings | `config_documents`, `config_changes` | `ro-ujb9.76.4.1` | — |
| Site registry (temporary mirror) | `assets` | `ro-ujb9.76.4.2` | settings |
| Counters, outbound checks | `counter_readings`, `egress_checks` | `ro-ujb9.76.5.1` | sites |
| Nightly reports and alerts | `pulses`, `flags`, `flag_tunes`, `flag_evidence`, `notifications`, `alert_daily_counts` | `ro-ujb9.76.5.2` | sites (`flags` references `pulses`, so they move in one change) |
| Collected metrics | `signal_runs`, `signal_observations` | `ro-ujb9.76.5.3` | sites |
| Provider reports, paid lookups, insight snapshots | `signal_dump_runs`, `research_log`, `property_insight_snapshots` | `ro-ujb9.76.5.4` | sites, collected metrics (a shared statement) |
| Mediavine revenue and collector leases | `mediavine_*`, the `mediavine_current_daily` view, `integration_leases` | `ro-ujb9.76.5.5` | sites |
| Source health and connection counts | `integration_capability_state`, `integration_health_events`, `connection_daily_counts`, `connection_status_daily_counts` | `ro-ujb9.76.5.6` | sites |
| Money ledger | `ledger`, the `financial_ledger` view | `ro-ujb9.76.6.1` | sites |
| Change notes and readback windows | `annotations`, `watch_windows` | `ro-ujb9.76.5.7` | sites |
| Site checks, reclamation, item decisions | `hygiene_checks`, `reclamation_targets`, `decisions` | `ro-ujb9.76.5.8` | sites |
| Task board and job runs | `beads_snapshots`, `beads_daily_counts`, `job_runs` | `ro-ujb9.76.4.3` | settings |
| Stored credentials | `credentials` | `ro-ujb9.76.4.4` | the operator's approval, `ro-ujb9.76.31` |
| D1 removed from Workers and harnesses | — | `ro-ujb9.76.40` | every unit above; the switch `ro-ujb9.76.10` waits for it |

Each bead names the files only it changes. The scripts that read D1 as the
importer's source (`scripts/postgres-import*.mjs`) belong to no unit.

**Files more than one unit changes.** The site registry changed each first
(`2873341b`: every Tower reader it touched takes `(db, store, …)` and its
route passes `env.STORE`; `tower-cron.ts`, `mcp-route.ts` and
`task-source.ts` carry the store too); after it, one unit at a time per file,
the later rebasing on the earlier (order among the others is free):

- Tower: `worker/index.ts` (each route passes `env.STORE`),
  `asset-detail-payload.ts`, `wall-feed.ts`, `wall-payload.ts`,
  `integration-evidence.ts`, `integrations-payload.ts`, `alert-history.ts`,
  `alert-evidence.ts`, `signal-trends.ts`, `ledger-history.ts`,
  `daily-revenue.ts`, `panel-review.ts`, `pulse-history.ts`.
- Ingest: `db.ts`,
  `integration-health-read.ts`, `capacity.ts`, `posthog-dumps.ts`,
  `dataforseo-dumps.ts`, `notifier.ts`, `hygiene.ts`, `insight-snapshots.ts`,
  `annotations.ts`, `egress.ts`, `pull.ts`, `rule-backtest.ts`,
  `watch-windows.ts`, `time-zone-change.ts`, `panel-source.ts`,
  `mediavine.ts`, `routes/revenue.ts`, `routes/watch-windows.ts`.
- Scripts: `config-apply.mjs`.
- Test infrastructure: `workers/ingest/test/helpers.ts`, `test/sites.ts`,
  `apps/tower/test/db-adapter.ts`, `test/sites.ts`, `panel-fixtures.ts`,
  `revenue-fixture.ts`, `apps/tower/e2e/harness.ts`, `wall-feed-fixture.ts`,
  and the shared test files `db/postgres/consumers.md` lists under several
  units' tables.

**Historical dual-store harnesses.** During the port, ingest bound `env.DB`
and a Postgres copy beside one another; Tower tests and journey fixtures kept
SQLite and Postgres stores. Sites were seeded into both, and `siteInBoth`
checked the mirror. Those interfaces were removed by `ro-ujb9.76.40`.

**Current setup (`ro-ujb9.76.40`).** Both Worker configs and environment types
have `POSTGRES` without `DB`; site writes commit only to Postgres. Ingest's
[`clean-start.ts`](../../workers/ingest/test/clean-start.ts) settles previous
work, restores modules/timers/globals, resets R2/cache, resets the Postgres copy
and inserts the complete synthetic sites directly. Each test and each file's
hooks retain a fenced store of their own. The setup still names a failing
step and preserves its cause without retries
([`ingest-test-setup.test.mjs`](../../scripts/ingest-test-setup.test.mjs)).
[`postgres-store.test.ts`](../../workers/ingest/test/postgres-store.test.ts)
checks every seeded field and the absence of `DB`; the shared-runtime
[`isolation-probe.ts`](../../workers/ingest/test/isolation-probe.ts) checks
clean state and refused late writes.

Tower tests seed their disposable copies directly through
[`test/sites.ts`](../../apps/tower/test/sites.ts) and `createTestStore()`.
Journeys seed/reset Postgres copies through their fixture server and harness,
without SQLite; fixture site subsets and order are preserved. Shared contracts
no longer advertise D1 migration-readiness states, and fresh-start config
folders no longer add a D1 store. The importer and legacy D1 migration sources
remain for their explicit migration role; they are not Worker fallbacks.
