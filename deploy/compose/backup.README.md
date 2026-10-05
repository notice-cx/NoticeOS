# Container backup worker

`backup.compose.yaml` adds a backup worker to the explicitly prepared application,
Postgres and Dolt services. The application sends one generated request identity
through a private folder. The worker's protected declarations select the operation,
stores, exporter checkouts and handoff folder.

The worker uses the application's pinned image, including PostgreSQL 18.6's client,
Dolt 2.4.0 and SQLite 3.53.4. SQLite is built from the official release source and
its published SHA3-256 checksum in the Dockerfile. Database service pins remain in
their existing host definitions.

## Preparation and custody

Set the variables required by `backup.compose.yaml` to the prepared installation's
exact folders, task data volume and network. Compose refuses missing declarations
and bind sources. The application mounts the request folder; the worker also mounts
the declared task spokes, task data, credentials, exporter roots and private
Postgres socket. Dolt and the worker share `/backup-staging` at the same path.

The operator-owned worker profile folder is mode `0700`, with private files `0600`.
Its `profile.json` is exactly:

```json
{"format":"noticeos-backup-worker-v1","retentionDays":30}
```

The prepared state folder contains a private `backup-client.json`:

```json
{"format":"noticeos-backup-client-v1","transportDir":"/backup-transport"}
```

The request folder is mode `0700`, owned by the application's declared UID. The
worker profile's owner is the identity that receives the completed private backup
files and directories. Bootstrap credential custody follows
[the operations contract](../../docs/06-operations.md#bootstrap-secrets-vs-integration-credentials).

This profile requires the worker profile and application client files to have the
same UID and GID. It refuses different identities before running an exporter;
private parent directories remain mode `0700`.

An optional private `host-backup.json` beside the worker profile uses the existing
[host backup declaration](../../config/host-backup.README.md). An offsite handoff,
when declared, names `/backup-offsite/backups`. Approved exporter repositories name
their prepared paths under `/backup-assets`. Each pinned `backup:prod` task runs as
the application UID with an isolated client home; implicit npm lifecycle hooks are
suppressed. Its platform dependencies and credential adapter must be prepared for
this Linux runtime.

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
instructions and private recovery custody. Recovery custody includes the bootstrap
bindings, database credentials, task selector, task inventory, spoke configuration
and worker/exporter declarations. Source credential or declaration changes during
capture refuse publication.

`node deploy/compose/health.mjs` reports application health and whether the declared
backup worker is ready. A missing declaration is reported explicitly. A configured
worker that stops or loses its fresh private heartbeat makes container health fail.
Backup completion remains a separate job result.

Only an exact finished response permits automatic retirement of a request. A
timeout or lost worker preserves its request. Backup publication claims also carry
a verified boot and PID namespace identity. Unknown, legacy and foreign claims
remain fenced and produce an actionable failure. Deliberate recovery requires
fencing the relevant writers and establishing that the originating operation has
stopped before removing its protected claim.

Restore uses a new, proven absent destination. The Postgres restore identity must
receive its own private copy or input stream; source custody stays mode `0600`.
Task restore verifies the complete snapshot's file hashes and pinned format before
starting the new server. Restore the archived bootstrap bindings and spoke
configuration, adapting only the explicitly chosen new endpoint and credentials
selector.

The opt-in proof is `scripts/container-backup-compose.test.mjs`, enabled by
`NOTICEOS_TEST_CONTAINER_BACKUP=1` and a qualified local
`NOTICEOS_TEST_APP_IMAGE=noticeos-local:ro-ujb9-9-4-…` tag. It requires the qualified
Beads binary through `BEADS_BD_BIN`, a local Docker endpoint and a nonroot operator.
Preserve explicit `DOCKER_CONFIG` when isolating HOME. Run with
`node --import ./scripts/script-tests-setup.mjs --test scripts/container-backup-compose.test.mjs`.
It creates and removes only its own projects and volumes, reserves loopback ports
5900–5949, and verifies an internal network before starting the app and worker.
The exporter is synthetic; the proof executes no real remote exporter.

Portable backup qualification is tracked by `ro-ujb9.9.4`. The local migration
keeps the native application and its existing asset exporter while moving Dolt
first; this worker profile does not establish compatibility for that native
exporter's credentials or platform dependencies.
