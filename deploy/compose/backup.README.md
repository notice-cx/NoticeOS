# Container backup worker

`backup.compose.yaml` adds a backup worker to the application, Postgres and Dolt
services of [`stack.yaml`](stack.yaml); `pnpm os:setup` includes it unless given
`--without-backup`. The application sends one generated request identity
through a private folder. The worker's protected declarations select the operation,
stores, exporter checkouts and handoff folder.

The worker uses the application's pinned image, including PostgreSQL 18.6's client,
Dolt 2.4.0 and SQLite 3.53.4. SQLite is built from the official release source and
its published SHA3-256 checksum in the Dockerfile. Database service pins remain in
their existing host definitions.

## Preparation and custody

The installation folder's `installation.env` sets the variables
`backup.compose.yaml` requires: its folders under `backup/`, the task data
volume and the network. Compose stops with an error when a declaration or bind source is missing. The application mounts the request folder; the worker also mounts
the declared task project repositories, task data, credentials, exporter roots
and private Postgres socket. Dolt and the worker share `/backup-staging` at the same path.

`pnpm os:setup` writes the worker profile folder, `backup/profile/`, mode `0700`
with private files `0600`. Its `profile.json` is exactly:

```json
{"format":"noticeos-backup-worker-v1","retentionDays":30}
```

It writes a private `backup-client.json` into the state folder:

```json
{"format":"noticeos-backup-client-v1","transportDir":"/backup-transport"}
```

The request folder is mode `0700`, owned by the application's declared UID. The
worker profile's owner is the identity that receives the completed private backup
files and directories. How bootstrap credentials are kept is set out in
[the operations contract](../../docs/06-operations.md#bootstrap-secrets-vs-integration-credentials).

This profile requires the worker profile and application client files to have the
same UID and GID. When the identities differ, it stops with an error before
running an exporter; private parent directories remain mode `0700`.

An optional private `host-backup.json` beside the worker profile uses the
[host backup declaration](../../config/host-backup.README.md); `pnpm os:setup --
--offsite <folder>` writes one. An offsite handoff, when declared, names
`/backup-offsite/backups`. Approved exporter repositories name
their prepared paths under `/backup-assets`. Each pinned `backup:prod` task runs as
the application UID with an isolated client home; implicit npm lifecycle hooks are
suppressed. Its platform dependencies and credential adapter must be prepared for
this Linux runtime.

Native D1 targets saved in **Integrations → Cloudflare** need no exporter
checkout. The protected worker connects only to `http://noticeos:5173` on its
declared installation network, using the existing private bootstrap bearer.
The app's standalone receiver authenticates before opening SQL and keeps the
provider token private. Each selected database is written to the dated set as
a verified gzip file with a private record of its export receipt and restore
steps; if the selection changes or any target fails, the set is not published. A native target and legacy exporter cannot cover
the same asset. Account activation and recurring export impact still require
the owner's specific production approval.

The worker runs with UID 0 to read existing private server metadata and credentials.
Its capabilities are limited to `DAC_OVERRIDE`, `CHOWN`, `SETUID` and `SETGID`, with a
read-only image and explicit mounts. Postgres capture uses the existing socket
superuser authority. Task capture uses the existing declared `noticeos` identity.
The profile introduces no SQL grant changes. The app and worker mount no Docker
socket.

## Completion, health and recovery

The existing backup pipeline attempts every store, publishes completion last,
preserves earlier complete sets after a failure, and retains its existing dated,
daily and weekly retention behavior. A complete container set includes Postgres,
R2, task databases and server metadata, approved exporter output, restore
instructions and private recovery material. The recovery material includes the bootstrap
bindings, database credentials, task selector, task inventory, task project
configuration and worker/exporter declarations. If a source credential or
declaration changes during capture, the set is not published.

`node deploy/compose/health.mjs` reports application health and whether the declared
backup worker is ready. A missing declaration is reported explicitly. Container
health fails when a configured worker stops or its private heartbeat (a regular
signal that the worker is still running) is no longer fresh.
Backup completion remains a separate job result.

A request is removed automatically only after the worker writes its exact
finished response. After a timeout or a lost worker, the request is kept.
Backup publication claims also carry a verified boot and PID namespace
identity. Unknown, legacy and foreign claims are never removed automatically:
they block the backup, which fails with a message that names the next step. To
recover by hand, first stop the relevant writers from writing and confirm that
the operation that made the claim has stopped, then remove its protected claim.

Restore uses a new, proven absent destination. The Postgres restore identity must
receive its own private copy or input stream; the backup's own copy stays mode `0600`.
Task restore verifies the complete snapshot's file hashes and pinned format before
starting the new server. Restore the archived bootstrap bindings and task
project configuration, adapting only the explicitly chosen new endpoint and credentials
selector.

The opt-in proof is `scripts/container-backup-compose.test.mjs`, enabled by
`NOTICEOS_TEST_CONTAINER_BACKUP=1` and a qualified local
`NOTICEOS_TEST_APP_IMAGE=noticeos-local:backup-proof-…` tag. It requires the qualified
Beads binary through `BEADS_BD_BIN`, a local Docker endpoint and a nonroot operator.
Preserve explicit `DOCKER_CONFIG` when isolating HOME. Run with
`node --import ./scripts/script-tests-setup.mjs --test scripts/container-backup-compose.test.mjs`.
It creates and removes only its own projects and volumes, reserves loopback ports
5900–5949, and verifies an internal network before starting the app and worker.
The exporter is synthetic; the proof executes no real remote exporter.

This worker profile does not establish compatibility for a native exporter's
credentials or platform dependencies.
