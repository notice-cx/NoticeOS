# The installation's Postgres, as a Compose service

*The manual steps below are operator-directed; a new, empty installation
uses the approved automatic path.*

What it builds: PostgreSQL 18.6 in a container, its data on a named volume,
reachable from this machine only (a port on 127.0.0.1); the three NoticeOS
roles ([`../roles.sql`](../roles.sql)) with their logins; an empty `noticeos`
database that sorts text by code point (the builtin `C.UTF-8` locale); query
statistics on. It stops
before the schema: the migrations go in with the operator-only
`pnpm os:migrate` ([The schema](#the-schema-the-operators-step-not-this-profiles)),
or the approved first-run path for a new, empty installation.

## A new installation

With Docker Compose available through a running local container app and
`psql` installed, run `pnpm start`. It creates an isolated Compose project
and named data volume for its empty start folder, writes secrets under that
folder's `postgres/secrets/`, and publishes Postgres on loopback at the Tower
port plus two. It then checks that the database is empty, applies the committed
frozen schema and bootstraps one workspace before opening the Tower. These are
the secret-generation, Compose-start, migration and bootstrap steps below,
performed through the same helpers; no manual command sequence is needed.

This is the narrow fresh-install exception. Existing folders, data, secrets, explicit database/profile settings
and the managed service keep the operator-directed path. A failed setup leaves
its own resources in place for explicit recovery; it never deletes or
automatically migrates them on retry. The exact checks are documented in
[scripts/README.md](../../../scripts/README.md#a-new-installation-in-one-command-pnpm-start).

| File | What it is |
|---|---|
| [`compose.yaml`](compose.yaml) | The service: image, volume, port, health check, restart |
| [`pg_hba.conf`](pg_hba.conf) | Who may connect, and how |
| [`first-start.sh`](first-start.sh) | What the first start builds: roles, logins, database, statistics |
| `secrets/` | Made by `pnpm postgres:secrets`; never committed |

## The passwords you keep: three, one of them a bootstrap secret

| Login | Used by | Its password lives |
|---|---|---|
| `noticeos_app` | the Workers and the runner | `secrets/database.url`; from the switch on, **the bootstrap secret `DATABASE_URL`** ([doc 06](../../../docs/06-operations.md#bootstrap-secrets-vs-integration-credentials)) |
| `noticeos_owner` | your `pnpm os:migrate` and the import's load | `secrets/owner.url`, readable by your account only |
| `noticeos_maint` | the import's reading back, maintenance | `secrets/maint.url`, readable by your account only |
| `postgres` (the superuser) | the image itself, backup, restore | **none**: it logs in only on the container's own socket |

The server holds only a verifier of each password (SCRAM-SHA-256), never the
password. No password is in a tracked file, the image, a command line, a log
or the query statistics; the proof looked in each.

## Before you start

- **Your container app starts at sign-in.** It is the app's own setting, and
  some apps leave it off. The service then comes back by itself after a
  restart.
- **Its Compose command.** The steps use Docker's spelling, `docker compose`;
  a container app with another spelling takes the same arguments.
- **Nothing listens on port 5432:** `lsof -nP -iTCP:5432 -sTCP:LISTEN` prints
  nothing. If something does, put `NOTICEOS_POSTGRES_PORT=5433` in
  `db/postgres/host/.env` and add `--port 5433` to step 1.
- **psql 15 or later on this machine:** `psql --version`. The client alone
  is enough (`brew install libpq` on macOS); no server is installed here.
- You are in the repository's root folder.

## The steps

**1. The secrets, once.** New passwords, written into
`db/postgres/host/secrets/` (your account only); nothing is printed.

```sh
pnpm postgres:secrets
```

**2. The first start.** Makes the data volume, then the roles, their logins,
the empty `noticeos` database and query statistics; returns once the server
answers.

```sh
docker compose -f db/postgres/host/compose.yaml up --detach --wait
```

**3. Check it.** Each prints what its comment says.

```sh
# Healthy, published on this machine only                     → … Up … (healthy)   127.0.0.1:5432->5432/tcp
docker compose -f db/postgres/host/compose.yaml ps
# Version, sort order, statistics, time zone, data checksums   → 18.6 …|b|C.UTF-8|pg_stat_statements|UTC|on
docker compose -f db/postgres/host/compose.yaml exec postgres psql -U postgres -d noticeos -Atc "SELECT current_setting('server_version'), datlocprovider, datlocale, current_setting('shared_preload_libraries'), current_setting('TimeZone'), current_setting('data_checksums') FROM pg_database WHERE datname = current_database()"
# The owner logs in from this machine, with psql alone         → … PostgreSQL 18.6 …, as noticeos_owner; 1 pending
pnpm os:migrate -- --secrets db/postgres/host/secrets
```

`os:migrate` reads the owner's address from the secrets folder itself: the
password is never on the command line, in the shell's history or on the screen.

## The schema (the operator's step, not this profile's)

What each command does and refuses is in
[Applying it to an installation's own database](../README.md#applying-it-to-an-installations-own-database).
These operations log in over TCP through the owner or maintenance role's URL,
never as the superuser.

```sh
# a. The baseline is already frozen; status checks the committed hashes below.
# b. Read what would happen                                             → 1 pending
pnpm os:migrate -- --secrets db/postgres/host/secrets
# c. Apply, in one transaction; it shows the plan and asks for the database's name
pnpm os:migrate -- --apply --secrets db/postgres/host/secrets
# d. The one workspace, once
pnpm os:migrate -- --bootstrap --secrets db/postgres/host/secrets --slug main --name "My sites"
```

**e. The application's address.** The one line of
`db/postgres/host/secrets/database.url` is the application login's address,
kept as the bootstrap secret `DATABASE_URL`
([doc 06](../../../docs/06-operations.md#bootstrap-secrets-vs-integration-credentials)). Copy it into this installation's secrets file,
`workers/ingest/.dev.secrets.json`, as the value of `DATABASE_URL`: by hand,
in an editor, never in a shell line or a chat.

**A new installation copies nothing by hand.** Its `pnpm start` makes its own
profile as described above and takes `database.url` once. An existing start
folder whose secrets file has no `DATABASE_URL` still takes it from the
operator-prepared profile (a folder named with `NOTICEOS_POSTGRES_SECRETS`
is read the same way compose.yaml reads it). It says which file it took it
from and never prints the address. The managed service never copies it:
this installation's address is the operator's copy above.

## Backup and restore

**A backup, while the service runs.** The nightly job and `pnpm os:backup`
write a consistent custom-format dump to `<date>/postgres/noticeos.dump`,
mode 0600, alongside the R2 archive and task-hub snapshots. A failed required
store leaves the previous complete set in place and prevents offsite handoff
and pruning. The stores have independent snapshot times; raw archives are
immutable, and restore verification reconciles their references.

The backup reads only the installation's declared `<home>/postgres/profile.json`:

```json
{
  "project": "noticeos-example",
  "composeFile": "/absolute/checkout/db/postgres/host/compose.yaml",
  "secretsDir": "/absolute/installation/postgres/secrets",
  "port": 4749
}
```

A fresh `pnpm start` writes this declaration with its own project and paths.
An existing installation needs an explicit declaration during its approved
cutover. Backups check Docker's selected endpoint is local, then use exactly
that project and Compose file. They never start a service or infer a project.
The dump command runs as `postgres` on the container's own socket, with
`--no-password`. It preserves object ownership and permissions, but contains
neither role passwords nor host bootstrap files.

**A restore, into an empty service.** First restore into an isolated project.
Prepare the roles from `roles.sql` and an empty database owned by
`noticeos_owner`; the Compose initialization does this for a new volume.
Do not apply migrations before restoring the dump: the dump carries its
schema and migration history. Using that explicitly selected project and
Compose file, run inside its container:

```sh
pg_restore --host=/var/run/postgresql --username=postgres --dbname=noticeos --no-password --exit-on-error --single-transaction < noticeos.dump
```

Run it as the container's `postgres` user. Follow the backup set's `RESTORE.md`
for the other stores. Verify table counts and
digests, ledger totals, schema, archive references and application-role reads
and writes before using the restored installation. On a replacement machine,
new role passwords require a new application address; encrypted integration
credentials also require the separately retained credentials key. The dump
holds neither. Replacing any live store requires explicit operator approval.

## Afterwards

- **After the Mac restarts**, the container app starts at sign-in and brings
  the service back (`restart: unless-stopped`). A server that crashes is
  brought back the same way, in about 2 seconds.
- **A minor update within PostgreSQL 18** (about every three months) is a commit that changes the
  `image:` line of `compose.yaml` (tag and digest). Then:
  `docker compose -f db/postgres/host/compose.yaml up --detach --wait`. The
  data stays; the database is unavailable for a few seconds.
- **A major update requires an approved backup and restore into a new volume.**
  This profile uses PostgreSQL 18's `/var/lib/postgresql` volume, with data
  under `18/docker`. An existing PostgreSQL 17 volume cannot start on 18:
  restore its dump into a separately named project and verify it before an
  approved cutover. PostgreSQL 18 receives support through 2030-11-14
  ([version policy](https://www.postgresql.org/support/versioning/)).
  The [official image](https://hub.docker.com/_/postgres) defines this new
  versioned data layout; changing the image never upgrades an old cluster.
- **Stopping it** for maintenance: `docker compose -f db/postgres/host/compose.yaml stop`.
  It stays stopped, even across a restart, until `up --detach --wait`.

### Starting over

Only before anything is stored: `docker compose -f db/postgres/host/compose.yaml down --volumes`,
then delete `db/postgres/host/secrets/` and begin again at step 1.
`pnpm postgres:secrets` never replaces a secret file, because the service's
logins were made from it.

### When the runner, the Tower and the task hub join

They become services of this same Compose project (`noticeos`), beside
`postgres`, and reach it as `postgres:5432` on the project's own network.
Nothing here is renamed: the project, the service, the volume
(`noticeos_postgres-data`) and the secrets stay. The loopback port can close
once nothing outside the project uses it.

## How it is proved

- **PostgreSQL 18.6 on a new Docker volume:**
  `NOTICEOS_TEST_POSTGRES_HOST_COMPOSE=1 node --import ./scripts/script-tests-setup.mjs --test --test-name-pattern 'current pinned Compose image' scripts/postgres-host-profile.test.mjs`.
  The test creates only its own random project on loopback port 5801, runs
  the approved fresh setup, measures the version, locale and versioned data
  directory, checks Unicode ordering, and restarts its own container to prove
  the workspace persists. It removes that project's container and volume.
- **A synthetic 17-to-18 restore:** [`scripts/postgres-upgrade.test.mjs`](../../../scripts/postgres-upgrade.test.mjs)
  runs in the required CI root suite with explicit PostgreSQL 17 binaries.
  It compares every operational row and sequence, the constraints, workspace
  isolation, ledger immutability and subsequent workspace numbering.
- **Without Docker, in `pnpm test:scripts`:** [`scripts/postgres-host-profile.test.mjs`](../../../scripts/postgres-host-profile.test.mjs)
  holds the files' guarantees and runs `first-start.sh` and `pg_hba.conf` on
  a throwaway cluster; [`scripts/postgres-secrets.test.mjs`](../../../scripts/postgres-secrets.test.mjs)
  holds the secret files; [`scripts/postgres-apply.test.mjs`](../../../scripts/postgres-apply.test.mjs)
  runs `pnpm os:migrate` with psql alone.
