# Runbook — diagnose the shared local runtime

**Lifecycle:** native-installation operator; update when the shared runtime or
supported diagnosis/recovery interfaces change; retire when the native profile
is removed.

This runbook covers the native managed NoticeOS service. A fresh `pnpm start`
installation and browser-test servers have their own folders and services;
their existence does not make the managed installation unhealthy.

## Why the runtime is shared

The runner starts the Tower's Vite runtime with the ingest as an auxiliary
Worker (`auxiliaryWorkers` in
[`apps/tower/vite.config.ts`](../../apps/tower/vite.config.ts)). Both Workers use
the same configured Postgres operational store. One runtime owns local R2
persistence, and one runner fires schedules. Postgres and the Dolt task hub have
independent lifecycles; stopping the application does not stop either database.

The Tower listener is LAN-visible by default. The same Vite process opens a
second, loopback-only listener: the ingest door. Door requests reach the ingest
through the Tower's private `INGEST` Service Binding. The guard removes the
runner mark from requests arriving through the public listener, so a supplied
header cannot grant access to the scheduled lane. The ports and boundary are
explained in [the current runtime contract](../../scripts/README.md#one-runtime).

Postgres holds the operational store, so a live D1 file or a machine-wide
process count is not a health requirement. Shared local R2 persistence and
duplicate scheduled work are the reasons to keep one runtime.

## Read the supported diagnosis

For an incident, start with one bounded report from the installation's checkout:

```sh
pnpm os:doctor
```

The report combines status, recent redacted runner and child logs,
scheduled-lane evidence and store capacity. Use it to distinguish a Worker
failure, a store problem and a failed scheduled lane. Read its migration report
before attributing an empty screen to schema. Diagnosis does not require
manually firing a cron.

For a quick health check, `pnpm os:status -- --json` reports the supervised
runtime, deployed commit and classified health. `healthy` requires the managed
service, a fresh runner heartbeat and
both Worker endpoints; an answering port alone is insufficient. `stopped`,
`starting`, `unhealthy` and `stale` are distinct states.

For recent output alone, use `pnpm os:logs -- --lines 200`; add `--follow` while
collecting a reproduction. These diagnostic commands read only.

File a task with the relevant redacted lines and deployed commit. The
[agent recovery contract](../../scripts/README.md#agent-recovery-contract)
owns the recovery rules; do not hunt process trees, inspect retired store files
or kill an unknown process.

## What to check if something is odd

| Symptom | What it indicates | Next step |
|---|---|---|
| `[ingest-door] cannot listen` or a duplicate-owner refusal | another runtime holds the configured door | read the doctor report; resolve the named unmanaged runtime under operator direction. `pnpm os:restart` targets only the managed service. |
| `cron … fired → HTTP 403 runner_lane_loopback_only`, and **every** door request 403s | the door mark is not reaching the Worker; the guard must stamp and strip `req.rawHeaders`, which the Cloudflare plugin reads | file a task with the log lines; `apps/tower/test/runner-door-e2e.test.ts` pins this path. Deploy a verified fix through [`pnpm os:deploy`](../../scripts/README.md#merging-is-not-deploying--pnpm-osdeploy); restarting keeps the same code. |
| one door path 403s but others work | the failure is specific to that request path | retain the redacted request failure and logs; `apps/tower/test/runner-door.test.ts` pins the guard's behavior. |
| `cron … fired → HTTP 500 {"error":"scheduled_failed"}` | the scheduled lane failed in its provider, credential or store work | read the recorded failure message and `os:doctor` lane evidence; do not repeat the lane as a health check. |
| `/api/pulse` returns 401 that used to work | the ingest's bootstrap secret selection needs checking | follow [bootstrap-secret guidance](../06-operations.md#bootstrap-secrets-vs-integration-credentials); keep values out of the diagnostic handoff. |
| the Tower loads but every card is empty | an empty screen does not establish a pending migration | inspect the store and migration evidence in `os:doctor`; follow [Postgres maintenance](../../scripts/README.md#the-postgres-stores-counterpart-postgresmigrate) only for the explicitly approved target. Deployment never applies schema; maintenance preserves the installed login service. |
| status is `stale` or reports an unmanaged runtime | endpoint responses lack valid managed-supervisor evidence | follow the [agent recovery contract](../../scripts/README.md#agent-recovery-contract); a port response is not a healthy verdict. |

A restart runs the current deployed code. Merged fixes reach the managed service
through the [verified deployment path](../../scripts/README.md#merging-is-not-deploying--pnpm-osdeploy).
Migration approval, stop/start and target selection belong to the linked
Postgres maintenance instructions; reinstalling the login service is not the
migration procedure.

To restore from a backup, use its dated `RESTORE.md` and the current
[backup and restore contract](../../scripts/README.md#backups--restore), including
[Postgres recovery](../../db/postgres/host/README.md#backup-and-restore).
A code rollback does not restore a database.

## Development and deployment boundaries

Scripts reach operational data through the supported Worker APIs or declared
Postgres adapters. They do not start another runtime over shared local R2
persistence. [`scripts/no-second-runtime.test.mjs`](../../scripts/no-second-runtime.test.mjs)
guards the script and package-command paths. The native backup helper uses the
SQLite online-backup API for R2 metadata without starting Wrangler.

The [standalone ingest development path](../../scripts/README.md#the-ingest-in-isolation-pnpm---filter-noticeosingest-dev)
refuses to start while the ingest door answers. It protects shared R2 state and
prevents duplicate work; it is not a second server to launch beside the managed
application during an incident.

The auxiliary Worker is `devOnly`. The Tower's Worker configuration declares
the `INGEST` Service Binding for the remote Worker topology. The native runner
and its scheduled door belong to this local profile; remote deployment uses
its own operator-approved procedure.
