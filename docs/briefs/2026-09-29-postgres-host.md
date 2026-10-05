# Where your own Postgres runs (2026-09-29, bead `ro-ujb9.76.12`)

## The operator's choice: A1 (2026-09-29, on `ro-ujb9.76.32`)

**Postgres runs in Docker Compose on the office Mac (A), and its application password is a fourth bootstrap secret, `DATABASE_URL` (1), from the switch on.** Decision D21 and doc 06 say so when the switch reaches main (`ro-ujb9.76.45`); until then the running OS on D1 has three.
The brief below recommended Homebrew (B); the operator chose Compose. What changed from the recommendation:

- **The profile is [`db/postgres/host/`](../../db/postgres/host/README.md), now a Compose service**, in place of the Homebrew steps. Proven on throwaway data on the office Mac's own container app; not run on this installation.
- **Postgres moves first.** The runner, the Tower and the task hub stay native for now, so the service publishes one port, on 127.0.0.1 only, for them. They join the same Compose project later (`ro-ujb9.9`).
- **Three passwords to keep, not one** (the brief's "2–3" for A). The owner and maintenance logins cannot be peer logins from a container, so each has a password, in a folder only the operator's account reads. The superuser has none the operator keeps.
- **No container app is named or required.** The file uses the common Compose specification and the official multi-architecture image (operator, 2026-09-25, `ro-ujb9.9`).
- **The operator's commands need psql alone on the Mac** (`ro-ujb9.76.39`), not a Postgres server.
- **Measured on the service** at the pilot's size: import 23 s, backup 0.6 s, restore 1 s, a killed server back in 2 s, a minor update about 1 s unavailable (the proof; private historical evidence; one run on a busy Mac).

What follows is the comparison as the operator read it.

## The recommendation, as written before the choice

**Recommendation: PostgreSQL 17 from Homebrew on the office Mac (B), started at login like the task hub.** $0 a month, the fastest, one new password.
**Choosing Docker Compose later does not change this.** The store moves into the Compose service with one copy: 0.6 seconds to restore at today's size, measured on a synthetic copy.
**Keep that one password as a fourth bootstrap secret**, beside the other three.
**Your answer goes on bead `ro-ujb9.76.32`** ("B1" if you agree). Nothing is installed, signed up for or paid before you answer.

| | A. Compose on the Mac | **B. Homebrew on the Mac** (recommended) | C1. Neon | C2. PlanetScale |
|---|---|---|---|---|
| Cost a month (read 2026-09-29) | $0 | $0 | about $19–20 | $5 one server; $15 with two standbys |
| The four host needs | All four | All four | All four, by its docs; not tried | All four, by its docs; not tried |
| Speed for the Tower and ingest (both run on the Mac) | Local, through the container app | Local | Over the internet, a new encrypted connection each request: about 0.2–0.5 s (estimate) | Same as C1 |
| Passwords to keep | 2–3 | 1 | 2 | 2 |
| Backups | Nightly dump, with a password | Nightly dump over the local socket, no password | Theirs (1–7 days) plus our nightly dump | Theirs (2 days) plus our nightly dump |
| Upgrades | Change the image tag | `brew upgrade`, held by a pin | Theirs, at a compute restart | Theirs |
| When the Mac restarts | The container app must start at login too | Starts at login, like the task hub | Database unaffected | Same as C1 |
| When the office internet is down | Keeps working | Keeps working | The whole OS stops | Same as C1 |
| A stranger's installation (D30) | Same file on macOS and Linux | macOS only | Needs an account and a card | Same as C1 |
| Waiting on | Your Compose go-ahead (gate `ro-u0uq`) and a container app | Nothing | A signup and a monthly charge | Same as C1 |

The setup for B was written (commit `7de9cb66`) and then replaced by the
Compose profile the operator chose. Every option runs **PostgreSQL 17**: it is the newest major
Hyperdrive documents (9.0 to 17.x) and is supported until 2029-11-08.

## What is true today

- **Both Workers run on the office Mac, not on Cloudflare.** One Workers
  runtime (workerd), started by the runner, hosts the Tower and the ingest
  ([`scripts/os-up.mjs`](../../scripts/os-up.mjs), header). Both Wrangler
  configs still carry a placeholder database id, so the repository shows no
  deployed Worker.
- **Hyperdrive plays no part until a Worker is deployed.** Hyperdrive is
  Cloudflare's connection pool and cache for Workers that run on Cloudflare.
  On the Mac its binding "connects directly to the database without going
  through Hyperdrive", and caching "does not take effect" (Cloudflare, local
  development).
- **Each Worker request opens its own database connection**
  ([`packages/postgres/src/store.mts`](../../packages/postgres/src/store.mts),
  "CONNECTING").
- **The store is small.** Readback of 2026-09-24 (`ro-ujb9.66`,
  capacity-readback-2026-09-24.json; private historical evidence):
  127.7 MB on disk, 232,313 rows, 0.72 MB a day into kept tables. Postgres keeps
  13 months of the large history tables
  ([db/postgres, What stays in Postgres](../../db/postgres/README.md#what-stays-in-postgres)).
- **The Mac already has Homebrew** `postgresql@15`, `postgresql@16` (for the
  proofs) and `dolt` (the task hub). Nothing listens on port 5432.

## The four host needs

From the comments on `ro-ujb9.76.12`.

| Need | A. Compose | B. Homebrew | C1. Neon | C2. PlanetScale |
|---|---|---|---|---|
| 1. `noticeos_maint` with `BYPASSRLS` | You hold a real superuser | You hold a real superuser | `neon_superuser` has `CREATEROLE` and `BYPASSRLS` | Its `postgres` role has `CREATEROLE` and `BYPASSRLS` |
| 2. The app logs in as `noticeos_app` | `ALTER ROLE … LOGIN PASSWORD` | Same | Same | Same |
| 3. `pg_stat_statements` | `-c shared_preload_libraries=…` on the image | In its `noticeos.conf` (removed with the B profile) | Available; its counts reset when the compute restarts | Turned on in its dashboard, then a restart |
| 4. Hyperdrive, caching off, for a deployed Worker | Needs Cloudflare Tunnel, Access and TLS on the Mac | Same as A | Listed provider: `--caching-disabled` at create | Same as C1 |

Need 1 rests on one Postgres rule: "Only superuser roles or roles with
`BYPASSRLS` can specify `BYPASSRLS`" (PostgreSQL 17, `CREATE ROLE`). For
the two providers it follows from their role docs; it has not been tried.

## How the Workers and the runner reach it

- **A and B:** over the Mac's own network address (127.0.0.1), with nothing
  in between. A new connection is a local process start. Not timed.
- **C1 and C2:** each Worker request crosses the internet about 8 times
  before its answer. That is 1 for TCP, 2 for TLS, 2 for the login, 1 to begin
  and name the workspace, 1 for the statement and 1 to commit. At 20 ms a
  round trip that is 0.16 s; at 60 ms, 0.48 s. The runner reuses its
  connections, about 3 round trips a transaction. This is arithmetic: the
  office's round-trip time to a provider was not measured, because that needs
  an account.
- **Hyperdrive would remove most of that cost**, but only for a Worker that
  runs on Cloudflare.
- **Connections, not sessions.** Every transaction names its workspace with
  `SET LOCAL`, which works the same with a direct connection or Hyperdrive's
  transaction pool. No option needs session state.

## The password (your second answer)

Under B, one login has a password. The powerful ones have none, because the
kernel vouches for your Mac account on the local socket (peer login):

| Who | Connects as | How | Password |
|---|---|---|---|
| Tower and ingest Workers | `noticeos_app` | TCP on 127.0.0.1 | **Yes**. Miniflare requires one in the local connection string ([packages/postgres](../../packages/postgres/README.md#what-a-worker-needs)) |
| Runner and scripts, one workspace at a time | `noticeos_app` | The same string | The same one |
| Maintenance, nightly backup, restore | `noticeos_maint`, or the superuser | Local socket, as your account | None |
| Migrations (you only) | `noticeos_owner` | Local socket, as your account | None |

Where that one password lives:

1. **Recommended: a fourth bootstrap secret, `DATABASE_URL`**, kept where
   `CREDENTIALS_KEY`, `OPERATOR_TOKEN` and `ASSET_TOKENS` are kept
   ([doc 06](../06-operations.md#bootstrap-secrets-vs-integration-credentials)).
   It passes D21's own test: the OS cannot read its store without it. On
   Cloudflare it lives in the Hyperdrive configuration, not as a Worker
   secret. D21 and doc 06 then say four, not three.
2. **No password.** The server trusts loopback for `noticeos_app`, and the
   Workers carry a placeholder. It keeps three secrets, but any program or
   user account on this Mac could open the store as the application.
3. **Derived from `CREDENTIALS_KEY`.** It keeps three secrets, but one leaked
   value then opens the store *and* decrypts every credential in it. Rotating
   either value rotates both.
4. *Considered, not offered:* the macOS Keychain. It keeps the password out
   of files, but it adds a Mac-only secret store, and Linux and Compose would
   need a second path.

Under A, there is no shared account between the Mac and the container, so
the owner, maintenance and admin logins need passwords too: 2–3 in all. Under
C, the app and the provider's admin login each have one: 2.

## Backup and restore

- **Consistent while running.** `pg_dump` "makes consistent exports even if
  the database is being used concurrently" and "does not block other users".
- **It must run as a role that bypasses row security**, because `pg_dump`
  turns `row_security` off and "if the user does not have sufficient
  privileges to bypass row security, then an error is thrown."
  `noticeos_maint` bypasses it, but it has no `SELECT` on sequences
  ([`0001_baseline.sql`](../../db/postgres/migrations/0001_baseline.sql), its
  grants). So under B the nightly dump runs as the superuser over the socket,
  with no password.
- **Roles are not in a dump.** A restore replays [`roles.sql`](../../db/postgres/roles.sql)
  and the logins, then runs `pg_restore`. `pg_dumpall --roles-only
  --no-role-passwords` keeps the role list with no password hash in the backup
  set.
- **How it joins [`scripts/host-backup.mjs`](../../scripts/host-backup.mjs):**
  one more stage beside D1, R2 and the task hub, writing
  `postgres/noticeos.dump` into the same dated set. The set then goes to the
  same offsite folder under the same 30-day retention. Building and proving
  that stage is `ro-ujb9.76.7`.
- **Measured on this Mac**, on a throwaway PostgreSQL 16.15 with synthetic rows
  shaped like the readback. Script and output:
  `docs/artifacts/postgres-host/` (historical reference excluded from public source). The
  throwaway server runs with fsync off, so these are lower bounds:

| | Pilot size | 10 × the pilot |
|---|---|---|
| Rows | 226,440 | 2,264,400 |
| Database | 73.4 MB | 658.3 MB |
| Dump file | 14.3 MB | 143.5 MB |
| Dump | 0.73 s | 7.17 s |
| Restore | 0.60 s | 5.49 s |
| Restore, 4 jobs | 0.34 s | 2.89 s |

- **On a provider**, their restore makes a new database (Neon: a branch in
  the restore window; PlanetScale: a new branch from a 12-hourly backup). The
  connection string changes, so the password secret changes with it. Our
  nightly dump over the internet stays the copy that is independent of the
  provider.

## Running it: one person's effort, upgrades, restarts

- **B:** about ten commands once. A minor update about every three months,
  held by `brew pin` so a routine `brew upgrade` never moves it. One major
  update before 2029-11-08, by dump and restore (seconds) or `pg_upgrade`.
  `brew services start` registers it "to launch at login", the same trigger as
  the runner and the task hub. After a power cut Postgres replays its log. On
  macOS, `wal_sync_method = fsync_writethrough` is what stops the drive's
  write cache from losing a committed transaction ("WAL Reliability"). The
  runner may start before Postgres answers; waiting for it is `ro-ujb9.76.7`.
- **A:** the same Postgres chores, plus the container app's own updates. The
  app must be set to start at sign-in (Docker Desktop's setting is off by
  default), and its VM gets 50% of the Mac's memory by default. The container
  comes back with `restart: unless-stopped` once the app is up.
- **C:** no server to run. Instead there is an account, billing and the
  provider's maintenance restarts. Neon applies a new minor version "the next
  time your compute restarts".

## Cost (official pages, read 2026-09-29)

- **A, B:** $0. Docker Desktop, if chosen for A, is free for "Small
  businesses (fewer than 250 employees AND less than $10 million in annual
  revenue)". The container app itself is not chosen yet (`ro-ujb9.9`).
- **C1 Neon, Launch plan:** $0.106 per CU-hour, $0.35 per GB-month of
  storage, $0.20 per GB-month of restore history, and no monthly minimum. The
  compute never sleeps, because the runner writes the task board to the store
  every minute ([`scripts/os-up.mjs`](../../scripts/os-up.mjs), header). At
  the smallest size (0.25 CU) that is 180 CU-hours, or $19.08 a month; storage
  under 1 GB adds cents. The free plan's 100 CU-hours run out after about 17
  days, and the compute "is suspended until the next billing period".
- **C2 PlanetScale:** PS-5, 1/16 vCPU and 512 MiB: $5 a month for one server,
  $15 for three (one primary, two replicas). The first 10 GB of storage is
  included. Backups every 12 hours, kept 2 days, are included, with
  point-in-time restore inside that window.
- **Hyperdrive,** for a deployed Worker later: the free plan has 100,000
  queries a day; paid is unlimited; no charge for data transfer.

## A stranger's installation (D30)

Whatever you choose, NoticeOS needs the same things from its host, and this
list is the portable part:

- PostgreSQL 17;
- the three roles from `roles.sql`, with `noticeos_maint` able to bypass row
  security;
- a login as `noticeos_app`;
- `pg_stat_statements`;
- a UTF-8 database with the builtin `C.UTF-8` locale;
- for a deployed Worker only, a Hyperdrive configuration with caching off.

A stranger then needs a connection string, not this Mac. A (Compose) is the
friendliest recipe for strangers. B is the recipe for a Mac. C stays a
supported alternative, not the default, because a first run should not need a
signup and a card.

**Sort order.** SQLite, and so D1, compares text with `memcmp()` by default.
The builtin `C.UTF-8` locale compares "the code point values only", so
Postgres sorts the way D1 does today. Postgres calls this "stable within a
Postgres major version".

## Postgres in the Compose profile (`ro-ujb9.9`)

- **Postgres becomes one more service**, beside the Dolt task hub and the
  NoticeOS runner, with its own named volume. It restarts independently of the
  runner, for the reason the design keeps the hub separate.
- **The design's "persist the NoticeOS D1/R2 state" becomes three things:**
  the Postgres volume, the raw archive, and the Parquet datasets. The raw
  archive's self-host storage is still to decide (2026-09-25 comment on
  `ro-ujb9.9`).
- **Only the NoticeOS container reaches it**, with no host port. The one
  exception is a loopback-only port while the runner still runs outside
  Compose.
- **Backups:** the NoticeOS container's backup lane dumps over the Compose
  network as a login with a password from a secret file. A container has no
  peer login from another container's account.

The service, as a design (not a file, not run):

```yaml
services:
  postgres:
    image: postgres:17.11          # pin the digest when adopted
    restart: unless-stopped
    stop_grace_period: 60s         # Compose's default of 10 s can cut a clean shutdown short
    command: ["postgres", "-c", "shared_preload_libraries=pg_stat_statements", "-c", "timezone=UTC"]
    environment:
      POSTGRES_USER: noticeos_admin
      POSTGRES_PASSWORD_FILE: /run/secrets/postgres_admin_password
      POSTGRES_INITDB_ARGS: "--locale-provider=builtin --builtin-locale=C.UTF-8 --encoding=UTF8"
    secrets: [postgres_admin_password]
    volumes:
      - postgres-data:/var/lib/postgresql/data   # an 18+ image mounts /var/lib/postgresql instead
      - ./db/postgres/roles.sql:/docker-entrypoint-initdb.d/10-roles.sql:ro
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "noticeos_admin", "-d", "postgres"]
      interval: 10s
      timeout: 5s
      retries: 6
  noticeos:
    depends_on:
      postgres: { condition: service_healthy }
volumes:
  postgres-data: {}
secrets:
  postgres_admin_password:
    file: ./secrets/postgres_admin_password
```

The `noticeos` database, its logins and `pg_stat_statements` come from the
same statements as steps 4–6 of the B profile, run once as init scripts
(the image runs `/docker-entrypoint-initdb.d` only on an empty data folder).

**Does choosing Compose change today's answer? No.**

1. The Compose plan is paused by your gate `ro-u0uq`, and its container app
   is deliberately unchosen. Postgres under A would wait on both.
2. Moving later is cheap. At today's size the copy restored in 0.6 seconds
   (above), inside the maintenance window the plan already needs for the task
   hub.
3. Native Postgres needs one password instead of two or three. The
   rehearsal's `*_dev` copies also work with today's development runner over
   the socket, which refuses any URL that carries a password
   ([`scripts/postgres-dev.mjs`](../../scripts/postgres-dev.mjs),
   `checkDevelopmentUrl`).

If you resume Compose now, answer A, and the service above becomes the profile.

## Providers: why these two

- **Neon (C1):** meets the four needs by its docs, is a listed Hyperdrive
  provider, and supports Postgres 14–18. Its restore window is 1 day by
  default, up to 7, on Launch.
- **PlanetScale (C2):** meets the four needs by its docs, is a listed
  Hyperdrive provider, offers Postgres 17.11 and 18.6, and is the cheapest.
  PS-5 is small (1/16 vCPU), and one server has no standby.
- **Dropped: Supabase.** It meets the needs (it documents roles with
  `bypassrls`). But Pro is $25 a month, point-in-time restore costs another
  $100 a month, and its API and sign-in layers would go unused.
- **Dropped: Crunchy Bridge.** Its cheapest tier ($9) "is not intended for
  production usage", and "No SLA applies to Hobby instances".
- **Dropped: AWS RDS, Google Cloud SQL, Azure.** They take more setup for one
  person (network rules, identity and access), and at this size they offer
  nothing the two above lack. This is a judgment; they were not priced.
- **Dropped: NoticeOS starting its own Postgres**, the way the proofs do.
  Every restart or deploy of the runner would restart the store with it, and
  the runner was deployed eight times on 2026-09-24 (AGENTS.md, STATE).

## What is verified, and what is claimed

| Claim | Status |
|---|---|
| Dump and restore times above | **Measured** on this Mac, 2026-09-29 (lower bound: fsync off) |
| Homebrew's Postgres build ships `pg_stat_statements` | **Seen** here: `pg_stat_statements.dylib` in `postgresql@16` |
| Nothing listens on 5432; Homebrew `postgresql@15`, `@16`, `dolt` installed | **Seen** here, 2026-09-29 |
| The B profile's commands and checks | **Not run**: 17 is not installed here; written from the Postgres 17 and Homebrew docs |
| Neon and PlanetScale can create `noticeos_maint` | **Follows from their docs** and the Postgres rule; not tried |
| Hyperdrive supports Postgres up to 17.x | **Cloudflare's docs** (page dated 2026-04-21) |
| 0.2–0.5 s per Worker request on a provider | **Estimate** from round trips; not measured |
| Prices | **Vendors' pages**, read 2026-09-29 |

## Found along the way

- `ro-ujb9.76.33`: the Postgres proofs run on 16 with the machine's locale;
  the host will run 17 with `C.UTF-8`.
- `ro-ujb9.76.34`: no command can apply the migrations to a non-development
  database, so the switch-over (`ro-ujb9.76.10`) waits on it.

## Sources (each read 2026-09-29)

- PostgreSQL: [CREATE ROLE](https://www.postgresql.org/docs/17/sql-createrole.html),
  [pg_stat_statements](https://www.postgresql.org/docs/current/pgstatstatements.html),
  [versioning policy](https://www.postgresql.org/support/versioning/),
  [initdb](https://www.postgresql.org/docs/current/app-initdb.html),
  [pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html),
  [peer authentication](https://www.postgresql.org/docs/17/auth-peer.html),
  [user name maps](https://www.postgresql.org/docs/17/auth-username-maps.html),
  [CREATE DATABASE](https://www.postgresql.org/docs/17/sql-createdatabase.html),
  [locale providers](https://www.postgresql.org/docs/17/locale.html),
  [collations](https://www.postgresql.org/docs/17/collation.html),
  [pg_database](https://www.postgresql.org/docs/17/catalog-pg-database.html),
  [WAL reliability](https://www.postgresql.org/docs/17/wal-reliability.html)
- SQLite: [datatypes, collating sequences](https://www.sqlite.org/datatype3.html)
- Homebrew: [postgresql@17](https://formulae.brew.sh/formula/postgresql@17),
  [postgresql@18](https://formulae.brew.sh/formula/postgresql@18),
  [its formula](https://raw.githubusercontent.com/Homebrew/homebrew-core/main/Formula/p/postgresql@18.rb),
  [brew services and pin](https://docs.brew.sh/Manpage)
- Docker: [postgres image](https://github.com/docker-library/docs/blob/master/postgres/content.md),
  [its 17 tags](https://hub.docker.com/_/postgres/tags?name=17),
  [Compose services](https://docs.docker.com/reference/compose-file/services/),
  [Compose secrets](https://docs.docker.com/reference/compose-file/secrets/),
  [Desktop licence](https://docs.docker.com/subscription/desktop-license/),
  [Desktop settings](https://docs.docker.com/desktop/settings-and-maintenance/settings/)
- Cloudflare Hyperdrive: [local development](https://developers.cloudflare.com/hyperdrive/configuration/local-development/),
  [supported databases](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/),
  [private databases](https://developers.cloudflare.com/hyperdrive/configuration/connect-to-private-database/),
  [pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/)
- node-postgres: [connecting](https://node-postgres.com/features/connecting)
- Neon: [pricing](https://neon.com/pricing), [plans](https://neon.com/docs/introduction/plans),
  [roles](https://neon.com/docs/manage/roles),
  [pg_stat_statements](https://neon.com/docs/extensions/pg_stat_statements),
  [versions](https://neon.com/docs/postgresql/postgres-version-policy)
- PlanetScale: [pricing](https://planetscale.com/pricing),
  [Postgres pricing](https://planetscale.com/docs/postgres/pricing),
  [roles](https://planetscale.com/docs/postgres/connecting/roles),
  [backups](https://planetscale.com/docs/postgres/backups),
  [extensions](https://planetscale.com/docs/postgres/extensions)
- Supabase: [pricing](https://supabase.com/pricing),
  [row level security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- Crunchy Bridge: [plans](https://docs.crunchybridge.com/concepts/plans-pricing),
  [backups](https://docs.crunchybridge.com/concepts/backups)
