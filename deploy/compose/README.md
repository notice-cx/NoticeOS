# Application container

NoticeOS runs as one Docker Compose stack of `noticeos` (this app: the Tower,
the ingest and the runner, `scripts/os-up.mjs` started by
[`entrypoint.mjs`](entrypoint.mjs)), `postgres`, `dolt` and an optional
[`backup`](backup.README.md) worker. In production the app runs a prepared
image; in development it runs a checkout's live source
([below](#follow-a-checkout-during-local-development)). The `pnpm os:*`
commands [run the stack](#run-the-stack).

The app starts an **already prepared installation**. It never initializes or
migrates either database.

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
docker build --platform linux/arm64 --file /absolute/new/context/deploy/compose/Dockerfile --tag noticeos-local:compose-proof-review /absolute/new/context
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


## Run the stack

Every `pnpm os:*` command acts on the stack declared in the ignored
`.local/stack.json`, run from the source checkout:

```json
{
  "project": "your-project",
  "files": ["/absolute/installation/compose.yaml"],
  "envFile": "/absolute/installation/compose.env",
  "dockerHost": "unix:///absolute/docker.sock"
}
```

Include every Compose file the installation uses, in its original order.
`-- --config /absolute/stack.json` names another selector. The stack must
already have `noticeos`, `postgres` and `dolt` containers; `backup` is
supported when present. Unexpected services or replaced containers refuse
further operations.

```sh
pnpm os:status       # each service's state and health, the database's migrations, the app's commit, whether main is ahead
pnpm os:logs         # recent logs; -- --follow, -- --lines N, -- <service>
pnpm os:start        # databases, then backup, then the app, each healthy first
pnpm os:stop         # the app, then backup, then the databases
pnpm os:restart      # the whole stack in dependency order, waiting for health
pnpm os:backup       # one backup now, inside the app container
pnpm os:run-job -- "0 6 * * *"   # fire the jobs scheduled on one cron expression now
pnpm os:capacity     # the store's size and growth per table; -- --json
```

Start, stop and restart never create containers, build or pull images, apply
migrations or remove volumes. A failed step stops the sequence; read status
before retrying. The full command list is in the
[command reference](../../docs/reference/commands.md).

## Update the app from main

A production app runs a fixed image. Committing to `main` changes source;
`pnpm os:restart` restarts the existing image. Neither activates new code.
Run `pnpm os:update` after focused independent verification of a clean
checkout at `main`. Full gates remain in CI; this command does not rerun them.

```sh
pnpm os:status
pnpm os:update
```

Preparation reads the selected stack's container/image metadata and Compose
declarations, then builds an allowlisted public source context. It leaves
services running. The image records the exact main revision, source manifest
and Postgres schema/role fingerprint. `pnpm os:status` reports the running
source, local main and whether they differ; an older image without revision
labels reports unknown. A first update from such an image requires its
recorded full source hash with `-- --baseline-commit COMMIT`. That argument is
the operator's assertion of the old image's source; never infer it from a tag
or date.

If `main` carries migrations the database has not applied, preparation stops
and names `pnpm os:migrate`; apply them first, then update. If `main` changes
the Postgres roles, that is operator maintenance
([Postgres host guide](../../db/postgres/host/README.md)).

Preparation prints a private, content-addressed plan and asks you to type
`update` to apply it. Without a terminal, or with `-- --prepare`, it prints
the command to apply it later:

```sh
pnpm os:update -- --apply /absolute/stack-deploy/PLAN_SHA256.json
```

Review the source, target image, previous image, mounts and stack before applying.
For an existing installation, agents require the owner's explicit approval for
the preparation reads and separately for this exact activation and verification.
Apply refuses changed source, declarations, containers or image labels. It
recreates only `noticeos`, with no dependency restart, image pull, build or
migration, and waits up to 90 seconds for health. Postgres, Dolt, backups and
their mounts must keep their identities. The app is briefly unavailable;
startup resumes its existing scheduled lanes.

The selected image is pinned through a private `stack-deploy/current.json`
Compose override beside the selector. The command adds that override to the
selector; it does not edit the installation's original Compose files or env
file. Keep using this selector for later operations. Plans, journals and the
previous image remain available for recovery. Failed health attempts restore
the previous app image when identities and mounts still match. Unknown drift
or interrupted recovery stops with an operator recovery journal and retains
the stack lock. Establish that the recorded update and its Docker commands
have stopped before removing that lock under an approved recovery plan.

Go back to the recorded previous image with:

```sh
pnpm os:rollback
```

It prepares the same kind of plan and applies it after you type `rollback`.
It is refused when the database schema changed since the previous image,
because the older code would run on the newer schema. App update and rollback
never apply migrations.

To prepare the image before approving any installation inspection, build it
without a selector or container access, then reuse its immutable image ID:

```sh
pnpm os:update -- --build-only --docker-host unix:///absolute/docker.sock --platform linux/arm64
pnpm os:update -- --image sha256:IMAGE_ID
```

This artifact-only build reads committed public source and builds/inspects its
new image on the named local engine. It does not inspect containers or contact
application endpoints. Preparation budgets 4 GiB while retaining 8 GiB free;
owned contexts are removed after completion, or retained if a build times out.

After an update, `/wall` reloads when its next request observes the new release
(normally within its one-minute poll). `/wall/edit` and desk pages keep an update
prompt so drafts stay open. Prepared images disable Vite's development reload
channel so a server reconnect does not override that behavior. A browser
running code from before this feature needs one manual refresh to install it.

For automatic startup, use `restart: unless-stopped` on each service and enable
your Docker engine's startup setting. A manual stop remains stopped until an
explicit start. Startup before anyone signs in needs an engine managed as a
system service, such as on a Linux host.

## Follow a checkout during local development

For a local installation whose owner wants edits to appear immediately, run
from its source checkout:

```sh
pnpm os:dev
pnpm os:status
```

This is an explicit development mode for that installation. The app mounts
the checkout's source directories read-only and enables Vite live refresh on
the existing Tower port. UI, styles, Worker and shared source edits appear
without a build, an update or an app restart. The Wall caption shows **DEV**,
the checkout commit and time, and **live source**. Committing refreshes its
source stamp too. Status reports the live checkout rather than the dependency
image's old source label.

Image-scoped Docker volumes keep its Linux dependencies; host `node_modules`
are shadowed by those volumes. A first switch copies the image's dependencies
once, with 4 GiB headroom while retaining 8 GiB free. Later UI edits copy
nothing. Existing state mounts keep archives and runner records in the
installation; generated Worker configs link to its existing secret file.
The command replaces only the app, preserves the stores,
backups and their volumes, and applies no migration. Its dependency check has
no network or installation mounts. A changed lockfile refuses startup rather
than silently using mismatched dependencies. Prepare a matching dependency
image with the image-only build above, return to the image, then select it
with `pnpm os:dev -- --image sha256:ID`.

The whole checkout is mounted as a directory, so atomic editor saves and Git
checkouts are observed too. Changes to Node runner code need
`pnpm os:restart`; UI and Worker module edits refresh live. Worker
config and dependency changes restart Vite and recheck the dependency image.
The [Docker bind mount contract](https://docs.docker.com/reference/compose-file/services/#volumes)
and [Vite watcher options](https://vite.dev/config/server-options.html#server-watch)
describe the underlying mechanisms. Native file events are used; polling is
not enabled across the checkout.

Return to the prepared image it ran before with:

```sh
pnpm os:prod
```

The private `stack-development/previous.json` and journal beside the selector
record recovery. The switch shares the update lock and restores the old
app if startup fails, provided the stores and declarations still match.
`pnpm os:update` refuses a development selector until `pnpm os:prod` returns
it to an image. Neither mode removes the checkout or its dependencies.

Agents record the owner's named local-development designation and routine
access scope in ignored `.local/stack-development/authorization.json`.
That scope removes repeated update approvals for this local app; other
installations retain their approval rules. Live development uses the existing
installation's data and schedules. Automated tests use isolated fixtures.

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
NOTICEOS_TEST_CONTAINER=1 NOTICEOS_TEST_APP_IMAGE=noticeos-local:compose-proof-review BEADS_BD_BIN=/absolute/test-tools/bd node --import ./scripts/script-tests-setup.mjs --test scripts/container-compose.test.mjs
```

Ordinary root tests run the context, startup, task client and health contracts
without Docker. A passing proof is not production hosting qualification.
