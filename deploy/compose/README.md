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

Every installation runs from one definition, [`stack.yaml`](stack.yaml). It
includes each service's own file (Postgres and Dolt beside their scripts, the
app in [`compose.yaml`](compose.yaml)) and the small shared files in
[`stack/`](stack): one network that the project creates, and data volumes that
it names but never creates. [`backup.compose.yaml`](backup.compose.yaml) is added on top when the
installation has a backup worker. The installation folder's `installation.env`
supplies every value ([`scripts/installation-layout.mjs`](../../scripts/installation-layout.mjs)
writes it), so nobody writes a Compose file for an installation:

```sh
pnpm os:setup            # a new installation in ~/noticeos (-- --dir <folder>), started
pnpm os:convert-legacy   # the installation .local/stack.json selects, moved into the layout after you confirm
```

`os:setup` needs only Docker, Node and pnpm: it takes main's
[published image](#update-the-app-from-main), checked against this checkout's
source, or builds `main` into the image when none is published (`-- --build`
always builds). It writes the folder and new secrets, creates the two data
volumes, starts the databases, and runs the steps that need psql and Beads
inside a one-off app container (`entrypoint.mjs setup`: the frozen schema and one workspace on a
database it proves empty, the NoticeOS asset and its task project). It then
starts the app and the backup worker, loads the default settings
(`entrypoint.mjs seed-settings`) and writes `.local/stack.json`. It stops
without making anything when the folder already has content or a project
container, volume or network already exists.

`os:convert-legacy` reads the running stack as Compose resolves it and plans
the same stack from the layout: the same project, image, ports, data volumes,
secrets and folders. It prints every remaining difference, and applies only
after you type `convert`: it stops the stack, copies the installation's own
folders (state, both secrets folders, the backup worker's declaration) with
their modes, checks every copied secret, starts from the new folder, and
rewrites `.local/stack.json` only once that is healthy. If the new stack fails
to start, the command starts the old stack again; `-- --undo` does the same
later. Old files are never changed. An app on live source is planned from the
prepared stack `os:dev` recorded: it returns to that image for the move
(`os:prod`'s step) and runs the checkout's live source again afterwards
(`os:dev`'s).

## Install with Docker alone

An installation needs no checkout, Node or pnpm:

```sh
docker run --rm ghcr.io/notice-cx/noticeos:main launcher | sh -s -- setup
```

The image prints its launcher, [`noticeos`](noticeos) (`entrypoint.mjs launcher`),
and `sh` runs it. `setup` takes `os:setup`'s options (`--dir`, `--offsite`,
`--tower-port`, `--project`, `--without-backup`); `--image` and `--build`
need a checkout. Afterwards the folder's own launcher runs every command:

```sh
~/noticeos/noticeos status    # status, logs, start, stop, restart, apply, backup, capacity, run-job, update, rollback, migrate
```

Each does what the `pnpm os:*` command of the same name does, with the same
options and no `--`, run by
[`scripts/noticeos-cli.mjs`](../../scripts/noticeos-cli.mjs) in a short-lived
container that mounts only the Docker socket and the installation folder at
its own path (setup also the offsite folder), and writes as the host user.
`setup`, `update` and `migrate` run main's newest published image; the other
commands run the image the app runs. `NOTICEOS_IMAGE` names another image for
those three and `NOTICEOS_DOCKER_SOCKET` another socket. The image includes the
Docker CLI and Compose for this; the app itself never connects to Docker.

Setup from the image pins the app to that same image, tests each host port by
having Docker publish it, and adds to the folder the launcher, its
selector `stack.json` and `stack/`, a copy of the stack definition taken from
the image. `migrate` connects to Postgres on the installation's network, and
`status` shows as `main:` the newest published commit, read from the registry.

`noticeos update` ([`scripts/image-update.mjs`](../../scripts/image-update.mjs))
moves the image and the definition copied out of it together, after you type
`update` (`--confirm update` without a terminal). The new definition is staged
in `stack.next/`; `stack/` becomes it, `stack.previous/` keeps the one before,
and `NOTICEOS_APP_IMAGE` names the new image. Every service whose declaration
changed is recreated as `os:apply` recreates it, under the same lock; if a
service does not become healthy, the command returns the definition, the image
line and the services to the version before. It stops without changing
anything when `installation.env` has an unapplied edit, a service is not
healthy, the database lacks migrations (`noticeos migrate --apply` first), the
Postgres roles changed or the image has no commit and schema labels.
`noticeos rollback` returns to the version before; it does not run when the
database schema changed since that version.

To build an image by hand, create the build context with the repository's explicit public source allowlist:

```sh
node scripts/container-context.mjs --destination /absolute/new/context
```

The destination must be new and outside the checkout. The builder rejects
symlinks before copying. It excludes `.git`, `.beads`, installation files,
runtime state, secrets, backups and private artifact roots. Its
`container-source.json` records each copied input's SHA256. Build that context,
never the checkout:

```sh
docker build --platform linux/arm64 --file /absolute/new/context/deploy/compose/Dockerfile --tag noticeos-local:compose-proof-review /absolute/new/context
```

`installation.env` sets these for the app service, among the rest of the layout:

| Variable | Value |
|---|---|
| `NOTICEOS_APP_IMAGE` | The local image ID setup or `os:convert-legacy` recorded; `os:update` pins later ones, and `noticeos update` rewrites this line |
| `NOTICEOS_STATE_DIR` | The installation folder's `state/` |
| `NOTICEOS_SPOKES_DIR` | The folder holding the linked task repositories; `spokes/` unless the installation keeps them elsewhere |
| `NOTICEOS_NETWORK` | The installation network, `<project>_installation`, which the project creates |
| `NOTICEOS_TOWER_BIND` | Where the Tower listens on the host: `127.0.0.1` (this machine only; the default when the line is absent), `0.0.0.0` (every interface) or one IPv4 address |
| `NOTICEOS_TOWER_PORT` | The Tower's host port |
| `NOTICEOS_APP_UID`, `NOTICEOS_APP_GID` | Owner of the private mounted files: the account that ran setup |
| `TOWER_ALLOWED_HOSTS` | Additional hostnames for Tower, separated by commas or spaces |
| `NOTICEOS_COMMANDS` | Only without a checkout: the launcher the commands run through, `${NOTICEOS_INSTALLATION}/noticeos` |

[`compose.yaml`](compose.yaml) also passes the app the installation's
host-side values, `NOTICEOS_HOST_*`: the folder, the Tower's address and port,
the database ports and the launcher. The Tower shows them read-only under
**Settings** > **Installation**; for an app recreated before these values
existed, that page shows the apply command instead.

The state mount appears at `/state`. Settings exports and host task links live
in `/state/installation`; bootstrap secrets use the existing
`/state/workers/ingest/.dev.secrets.json` format described in
[doc 06](../../docs/06-operations.md#bootstrap-secrets-vs-integration-credentials).
Runtime archives, logs and records stay in `/state/.wrangler` and
`/state/.local`. The linked task repositories appear at `/spokes`; host links
must name those stable container paths. The two mounts must already exist; Compose never creates an
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
selectors and credentials cannot select another task server. The Postgres
bootstrap address must name `postgres:5432`. Each existing linked task project
must declare its own database on that prepared task server. Product settings
and provider credentials
continue to be connected through the Tower.

Postgres and Dolt are separately managed durable services, each published on
`127.0.0.1` only. Of the app's ports, only Tower port 5173 is published, on the
host address `NOTICEOS_TOWER_BIND` names (`127.0.0.1` unless the installation
chooses otherwise). The ingest endpoint listens only on loopback inside the
application container and is never published. The app has a read only image.
Tower listens on the container interface so Docker can forward the published
port; the host binding sets which of the host's interfaces can reach it.

To open the Tower to a trusted network, set `NOTICEOS_TOWER_BIND` to `0.0.0.0`
or one IPv4 address of the host and run `pnpm os:apply`
([below](#change-a-setting)); its plan prints a warning that other devices
will be able to reach the Tower. Standalone has no login, so every client that
reaches it can read and change the installation's data. Devices reach it by IP
address; a machine name must be listed in `TOWER_ALLOWED_HOSTS`, because the app
runs in a container and cannot read the host's own name. Keep the hostname allowlist; never set it to
allow every host.

The app has no Docker socket; only the launcher's short-lived containers do. Vite's configuration cache uses an ephemeral
tmpfs; other runtime caches use the state mount. Optional development metadata
and telemetry requests are disabled. The health check requires a fresh,
supervised runner, an armed scheduler, and both internal health endpoints.
The [declared backup worker](backup.README.md) adds portable capture and recovery;
health also reports its availability and fails when a configured worker is unavailable.


## Run the stack

Every `pnpm os:*` command acts on the stack the ignored `.local/stack.json`
selects; `os:setup` and `os:convert-legacy` write it, naming the Compose project,
`stack.yaml` (and the backup layer), the installation's `installation.env` and
the local Docker socket. `-- --config /absolute/stack.json` names another
installation's selector. The stack must already have `noticeos`, `postgres`
and `dolt` containers; `backup` is supported when present. When the stack has
unexpected services or replaced containers, the commands stop with an error.

```sh
pnpm os:status       # each service's state and health, the database's migrations, the app's commit, whether main is ahead
pnpm os:logs         # recent logs; -- --follow, -- --lines N, -- <service>
pnpm os:start        # databases, then backup, then the app, each healthy first
pnpm os:stop         # the app, then backup, then the databases
pnpm os:restart      # the whole stack in dependency order, waiting for health
pnpm os:apply        # edits to installation.env, after you type `apply`
pnpm os:backup       # one backup now, inside the app container
pnpm os:run-job -- "0 6 * * *"   # fire the jobs scheduled on one cron expression now
pnpm os:collect -- --asset example.com --families posthog-events   # one site's report families now; DataForSEO calls are billed
pnpm os:capacity     # the store's size and growth per table; -- --json
pnpm os:mcp          # at a terminal, the line that connects an agent to the Tower's /api/mcp; run by an agent, the same server over stdio; -- --actor <name>
pnpm os:bd -- ready  # the task tool, inside the app; -- --project <prefix> picks a project
```

Without a checkout, run each as `~/noticeos/noticeos <command>`, with the same
options and no `--` ([above](#install-with-docker-alone)).

Start, stop and restart never create containers, build or pull images, apply
migrations or remove volumes. A failed step stops the sequence; read status
before retrying. The full command list is in the
[command reference](../../docs/reference/commands.md).

## Change a setting

Edit the installation's `installation.env`, then run `pnpm os:apply`
([`scripts/stack-apply.mjs`](../../scripts/stack-apply.mjs)). It compares each
container's Compose config hash with the hash of its service as declared now
([`scripts/stack-drift.mjs`](../../scripts/stack-drift.mjs)), prints each
change in the operator's terms (ports, settings such as `TOWER_ALLOWED_HOSTS`,
the user, folders) and which services it recreates, and waits for you to type
`apply` (`-- --confirm apply` without a terminal). A pull that changes the
stack definition is listed the same way.

Only the changed services are recreated: the databases first, with the app and
backup worker stopped while the databases restart, then the backup worker, then
the app, each waiting for health. It shares the update lock. Setup, conversion
and each successful apply record `installation.env` as the last settings the
stack ran healthy with (`stack-apply/applied.env` beside the selector); when a
service does not become healthy, `os:apply` returns the stack to those
settings. `installation.env` itself is never rewritten. When there is nothing
to apply, it prints that and records the current settings.

It rejects a change that would point a database at other data (a data volume
name), a project rename, a new port already in use and a declared service with
no container. It builds or pulls no image and applies no migration.
`pnpm os:status` prints a `settings:` line while a service does not run as
`installation.env` declares; `pnpm os:restart` restarts the same containers and
applies nothing. `pnpm os:migrate` reads the Postgres port the stack publishes
from Compose, so a port moved this way needs no other edit.

## Update the app from main

This section is for a checkout. An installation without one updates with
`noticeos update` ([above](#install-with-docker-alone)).

A production app runs a fixed image. Committing to `main` changes source;
`pnpm os:restart` restarts the existing image. Neither activates new code.
Run `pnpm os:update` after focused independent verification of a clean
checkout at `main`. Full gates remain in CI; this command does not rerun them.

```sh
pnpm os:status
pnpm os:update
```

Preparation reads the selected stack's container/image metadata and Compose
declarations, then takes main's image. CI publishes every `main` commit that
passes CI as `ghcr.io/notice-cx/noticeos:<commit>`, for linux/amd64 and
linux/arm64, with a build provenance attestation
([`release-image.yml`](../../.github/workflows/release-image.yml)). Preparation
pulls it and uses it only when its labels name this checkout's main commit,
its schema and the hash of the public build inputs this checkout prepares for
that commit: the image was built from exactly this source. On a mismatch it
stops and prints `-- --build`. When nothing is published for the commit yet
(it appears a few minutes after CI passes on `main`) or the registry is
unreachable, it builds an allowlisted public source context here and prints
the reason. `-- --build` always builds here; a fork's commits are not
published there, so on a fork the command builds here. It leaves services
running. The image records
the exact main revision, source manifest and Postgres schema/role fingerprint. `pnpm os:status` reports the running
source, local main and whether they differ; for an older image without
revision labels it reports unknown. A first update from such an image requires its
recorded full source hash with `-- --baseline-commit COMMIT`. That argument is
the operator's assertion of the old image's source; never infer it from a tag
or date.

If `main` carries migrations the database has not applied, preparation stops
and prints `pnpm os:migrate`; apply them first, then update. If `main` changes
the Postgres roles, that is operator maintenance
([Postgres host guide](../../db/postgres/host/README.md)).

Preparation prints a private, content-addressed plan and waits for you to type
`update` to apply it. Without a terminal, or with `-- --prepare`, it prints
the command to apply it later:

```sh
pnpm os:update -- --apply /absolute/stack-deploy/PLAN_SHA256.json
```

Review the source, target image, previous image, mounts and stack before applying.
For an existing installation, agents require the owner's explicit approval for
the preparation reads and separately for this exact activation and verification.
Apply stops without changing anything when the source, declarations,
containers or image labels have changed. It
recreates only `noticeos`, with no dependency restart, image pull, build or
migration, and waits up to 90 seconds for health. Postgres, Dolt, backups and
their mounts must keep their identities. The app is briefly unavailable;
startup resumes its existing scheduled jobs.

The selected image is pinned through a private `stack-deploy/current.json`
Compose override beside the selector. The command adds that override to the
selector; it does not edit the installation's original Compose files or env
file. Keep using this selector for later operations. Plans, journals and the
previous image remain available for recovery. When the health check fails,
the command restores the previous app image if identities and mounts still
match. When the drift is unknown or recovery is interrupted, the command
stops, writes an operator recovery journal and keeps the stack lock. Establish that the recorded update and its Docker commands
have stopped before removing that lock under an approved recovery plan.

Go back to the recorded previous image with:

```sh
pnpm os:rollback
```

It prepares the same kind of plan and applies it after you type `rollback`.
It does not run when the database schema changed since the previous image,
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

After an update, `/wall` reloads when its next request detects the new release
(normally within a minute, because it polls once a minute). `/wall/edit` and the
Tower's other pages show an update prompt instead of reloading, so drafts stay
open. Prepared images disable Vite's development reload
channel so a server reconnect does not override that behavior. A browser
running code from before this feature needs one manual refresh to install it.

For automatic startup, use `restart: unless-stopped` on each service and enable
your Docker engine's startup setting. A service you stop by hand stays stopped
until you start it. Startup before anyone signs in needs an engine managed as a
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

Image-scoped Docker volumes keep its Linux dependencies; those volumes hide the
host's `node_modules`. A first switch copies the image's dependencies
once, with 4 GiB headroom while retaining 8 GiB free. Later UI edits copy
nothing. Existing state mounts keep archives and runner records in the
installation; generated Worker configs link to its existing secret file.
The command replaces only the app, preserves the stores,
backups and their volumes, and applies no migration. Its dependency check has
no network or installation mounts. When the checkout's lockfile or package
manifests no longer match the app's image (after a pull, for example), the app
does not start, so it never runs mismatched dependencies, and
`pnpm os:logs -- noticeos` shows the reason. Run `pnpm os:dev` again: it builds the checkout's packages into a new
development image and moves the app onto it, uncommitted edits included.
`pnpm os:dev -- --image sha256:ID` selects an image you built yourself.

The whole checkout is mounted as a directory, so atomic editor saves and Git
checkouts are detected too. Changes to Node runner code need
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
`pnpm os:update` does not run on a development selector until `pnpm os:prod`
returns it to an image. Neither mode removes the checkout or its dependencies.

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
connect to its private ingest endpoint. No token goes on the command line, and no ingest
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
`--remote` is no longer supported, and the scripts reject it. These are
installation-operator commands for the standalone profile, not a hosted
customer's workspace API. What a hosted service may do is set by
[the tenancy contract](../../docs/23-configuration-ownership.md).

The disposable proof creates new database volumes, a synthetic core task
project and prepared settings, runs the application on ports 5750–5799, tests task
detail/create/complete and snapshot recording, and restarts only the app. Its
synthetic roster contains only NoticeOS, with no provider connections. Before the app starts, the
proof recreates only its owned network as internal and verifies that flag;
API and store assertions run inside the exact app container. Cleanup removes only its own
project and volumes. The proof's preparation uses a declared compatible host
Beads binary and PostgreSQL client; the running app uses its bundled tools.
Enable it explicitly with a locally built proof image:

```sh
NOTICEOS_TEST_CONTAINER=1 NOTICEOS_TEST_APP_IMAGE=noticeos-local:compose-proof-review BEADS_BD_BIN=/absolute/test-tools/bd node --import ./scripts/script-tests-setup.mjs --test scripts/container-compose.test.mjs
```

Ordinary root tests run the context, startup, task client and health contracts
without Docker. A passing proof does not qualify the stack for production
hosting.
