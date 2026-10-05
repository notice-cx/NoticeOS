# Prepared application container

This service packages the existing runner, Tower, ingest and Beads task lane.
It starts an **already prepared installation**. It never initializes or
migrates either database. The supported hosting profile is tracked by
`ro-ujb9.9`; this application slice is `ro-ujb9.9.2`.

The image pins Node 24.21.0 to the official multiarchitecture image digest,
pnpm 12.8.1, Beads 1.3.1 to the official release archive checksums, and
PostgreSQL client 18.6 to the official PGDG package. The Dockerfile accepts
Linux arm64 and amd64. A successful build is not platform qualification.
Sources: [Node image](https://github.com/nodejs/docker-node),
[pnpm release](https://github.com/pnpm/pnpm/releases/tag/v12.8.1),
[Beads release](https://github.com/gastownhall/beads/releases/tag/v1.3.1),
[PostgreSQL Debian packages](https://www.postgresql.org/download/linux/debian/).

Create the build context with the repository's explicit public source allowlist:

```sh
node scripts/container-context.mjs --destination /absolute/new/context
```

The destination must be new and outside the checkout. The builder refuses
symlinks before copying. It excludes `.git`, `.beads`, installation files,
runtime state, secrets, backups and private artifact roots. Its
`container-source.json` records each copied input's SHA256. Build that context,
never the checkout:

```sh
docker build --platform linux/arm64 --file /absolute/new/context/deploy/compose/Dockerfile --tag noticeos-local:ro-ujb9-9-2-review /absolute/new/context
```

The Compose service requires these host declarations:

| Variable | Value |
|---|---|
| `NOTICEOS_APP_IMAGE` | Explicit local image tag or immutable image reference |
| `NOTICEOS_STATE_DIR` | Absolute, prepared installation directory |
| `NOTICEOS_SPOKES_DIR` | Absolute directory containing the linked task repositories |
| `NOTICEOS_NETWORK` | Existing network shared by this installation's Postgres and Dolt |
| `NOTICEOS_TOWER_PORT` | Unoccupied host port; binding is always `127.0.0.1` |
| `NOTICEOS_APP_UID`, `NOTICEOS_APP_GID` | Owner of the private mounted files; default `1000:1000` |
| `TOWER_ALLOWED_HOSTS` | Additional hostnames for Tower, separated by commas or spaces |

The state mount appears at `/state`. Settings exports and host task links live
in `/state/installation`; bootstrap secrets use the existing
`/state/workers/ingest/.dev.secrets.json` format described in
[doc 06](../../docs/06-operations.md#bootstrap-secrets-vs-integration-credentials).
Runtime archives, logs and records stay in `/state/.wrangler` and
`/state/.local`. Spokes appear at `/spokes`; host links must name those stable
container paths. The two mounts must already exist; Compose never creates an
empty substitute for them.

The declared task client is a private `/state/task-client.json` file:

```json
{
  "host": "dolt",
  "port": 3306,
  "user": "noticeos",
  "credentialsFile": "/state/dolt/credentials",
  "clientHome": "/state/dolt/client-home"
}
```

The credentials file is mode `0600`, with one `[dolt:3306]` section and one
`password` entry. The client home is a private `0700` directory. The same
isolated client environment is used by the runner and Tower; inherited task
selectors and credentials cannot choose another hub. The Postgres bootstrap
address must name `postgres:5432`. Existing linked spokes must declare their
own database on that prepared hub. Product settings and provider credentials
continue to be connected through the Tower.

Postgres and Dolt are separately managed durable services. Only Tower port
5173 is published, through the declared loopback host binding. The ingest
door stays on loopback inside the application container. The app has a read
only image. Tower listens on the container interface so Docker can forward
the published port; this does not expose the host port beyond loopback.
An operator can override the host binding for an existing trusted private LAN.
Standalone has no login, so that override gives reachable clients read and write
access. Keep the hostname allowlist; never set it to allow every host.
The app has no Docker socket. Vite's configuration cache uses an ephemeral
tmpfs; other runtime caches use the state mount. Optional development metadata
and telemetry requests are disabled. The health check requires a fresh,
supervised runner, an armed scheduler, and both internal health endpoints.
The [declared backup worker](backup.README.md) adds portable capture and recovery;
health also reports its availability and fails when a configured worker is unavailable.

## Download and publish stored signal reports

For this standalone container profile, run the existing scripts **inside the
running application container**. Use the same Compose project, declarations and
file that started it; replace `your-project` below with that project's name.
The commands read the installation's own bootstrap token from `/state` and
reach its private ingest door. No token goes on the command line, and no ingest
port needs to be published.

Download stored reports, then generate the local analysis:

```sh
docker compose --project-name your-project --file deploy/compose/compose.yaml exec -T noticeos node scripts/signal-dumps-download.mjs --asset example.com
docker compose --project-name your-project --file deploy/compose/compose.yaml exec -T noticeos node scripts/signal-history.mjs --asset example.com --in /state/.local/signal-dumps/downloads/example.com --out /state/.local/signal-dumps/history/example.com
docker compose --project-name your-project --file deploy/compose/compose.yaml exec -T noticeos node scripts/signal-history-analyze.mjs --asset example.com --history /state/.local/signal-dumps/history/example.com --out /state/.local/signal-dumps/reports/example.com
```

These commands do not collect new provider data. Downloads and reports persist
on the state mount, under `.local/signal-dumps/downloads/example.com` and
`.local/signal-dumps/reports/example.com`. Review `executive.json` in the complete report
folder before publishing its findings to Tower:

```sh
docker compose --project-name your-project --file deploy/compose/compose.yaml exec -T noticeos node scripts/signal-insights-publish.mjs --asset example.com --file /state/.local/signal-dumps/reports/example.com/executive.json
```

Publishing writes a content-addressed insight snapshot; repeating unchanged
content creates no second snapshot. It does not modify raw reports or contact
providers. Download filters and explicit file paths are described in the
[signal commands](../../scripts/README.md#raw-provider-signal-archive-signals).
`--remote` is retired and refused. These are installation-operator commands for
the standalone profile, not a hosted customer's workspace API. Hosted service
authority follows [the tenancy contract](../../docs/23-configuration-ownership.md).

The disposable proof creates new database volumes, a synthetic core spoke and
prepared settings, runs the application on ports 5750–5799, exercises task
detail/create/complete and snapshot recording, and restarts only the app. Its
synthetic roster contains only NoticeOS, with no provider connections. Before the app starts, the
proof recreates only its owned network as internal and verifies that flag;
API and store assertions run inside the exact app container. Cleanup names only its own
project and volumes. The proof's preparation uses a declared compatible host
Beads binary and PostgreSQL client; the running app uses its bundled tools.
Enable it explicitly with a locally built proof image:

```sh
NOTICEOS_TEST_CONTAINER=1 NOTICEOS_TEST_APP_IMAGE=noticeos-local:ro-ujb9-9-2-review BEADS_BD_BIN=/absolute/test-tools/bd node --import ./scripts/script-tests-setup.mjs --test scripts/container-compose.test.mjs
```

Ordinary root tests run the context, startup, task client and health contracts
without Docker. Independent verification and the actually exercised platform
are recorded on `ro-ujb9.9.2` before completion. The production hosting promise
remains the parent bead's acceptance, including operational qualification.
