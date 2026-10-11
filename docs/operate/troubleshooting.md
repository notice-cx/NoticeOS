---
title: "Troubleshooting"
description: "The states and refusals you will meet while running NoticeOS, what each one means, and what to do about it."
---

# Troubleshooting

This page gets you from a symptom to the one command or setting that fixes it.

Start every investigation with the state, not the port: `pnpm os:status` for the stack, the terminal for a `pnpm start` installation. When the cause is unclear, read `pnpm os:logs -- --lines 200` before restarting anything.

## Service states

**A service is `exited` or `created`.**
The stack was stopped or a service did not start. Run `pnpm os:start`; it starts the databases, then the backup worker, then the app, and stops at the first one whose health does not return.

**`noticeos: running, starting`.**
The app is starting or its scheduler is still arming. Wait a minute and check again. If it stays there, read the log.

**`noticeos: running, unhealthy`.**
The scheduler's heartbeat is old, the Tower or the data receiver does not answer, or a configured backup worker does not. Read `pnpm os:logs -- noticeos`, then `pnpm os:restart`.

**`postgres` or `dolt` is `unhealthy`.**
A database did not pass its own health check. Read `pnpm os:logs -- postgres` or `-- dolt`, then `pnpm os:restart`.

**`database:` says the database is behind.**
The checkout carries migrations the database has not applied. Applying them is your own step; see [Upgrade](/start/upgrade#apply-database-changes).

**The app keeps restarting.**
The scheduler refused to start. The log says why; see Scheduler refusals.

## Scheduler refusals

**The log says `REFUSING to start` and names a fix; exit code 5.**
The database address in the secrets file is unusable, or the database is behind the code. The line names the command: usually the migration sequence in [Upgrade](/start/upgrade). The address itself is never printed.

**Exit code 3, with an `lsof` line.**
Another scheduler already holds the data port (8791), and two would fire every schedule twice. Restart the app with `pnpm os:restart`.

**`REFUSING to start Tower: prepared dependencies are unavailable or stale`.**
On a development stack, run `pnpm install --frozen-lockfile`, then `pnpm os:dev`. On a production stack, run `pnpm os:update` to build a matching image.

## Runtime log lines

In the app container, one process runs the Tower and the data receiver together, and one scheduler fires every schedule. A second copy would run every schedule twice, so the runtime refuses to share its ports. A `pnpm start` installation or a browser-test server has its own folder and ports; it does not make the stack unhealthy.

**`[ingest-door] cannot listen on <host>:<port>`.**
Another runtime already holds the data port inside the app container. Run `pnpm os:restart`.

**`cron … fired → HTTP 403 runner_lane_loopback_only`, and every request on the data port answers 403.**
The scheduler's mark is not reaching the app, so every schedule is refused. A restart runs the same code. File an issue with the log lines; the fix arrives through `pnpm os:update`.

**One request path answers 403 while the others work.**
The failure belongs to that path. Keep the redacted request and log lines, and file them.

**`cron … fired → HTTP 500 {"error":"scheduled_failed"}`.**
The job failed in its provider, credential or database work. Read its recorded failure under **System health** > **Background operations**, or in `pnpm os:logs`. Do not rerun the job to test health.

**`/api/pulse` answers 401 where it used to work.**
The data receiver's bootstrap secret is missing or changed. See [bootstrap secrets](../06-operations.md#bootstrap-secrets-vs-integration-credentials). Keep the value out of anything you share.

**The Tower loads, but every card is empty.**
An empty screen does not prove the database is behind. Read the `database:` line of `pnpm os:status` first. A migration is always your own step; see [Upgrade](/start/upgrade).

**`pnpm --filter @noticeos/ingest dev` refuses to start.**
Expected while another runtime holds the data port: a standalone data receiver would be a second runtime over the same files.

## `pnpm start` refusals

**"port N belongs to the NoticeOS stack".**
Ports 5173, 8791 and 3308 are reserved for the stack. Choose another with `--port`.

**"port N is in use".**
Something else holds it. Stop it or pick another port.

**"… holds files pnpm start did not make".**
The folder is not one `pnpm start` created. Choose an empty folder with `--dir`.

**"DATABASE_URL is not set … run pnpm db:create-secrets first".**
The folder has no database address and no prepared profile to copy one from. Run `pnpm db:create-secrets` first, following the database setup guide the message names.

**The start stops saying the database is behind this code.**
Apply the migration as your own step, then start again. See [Upgrade](/start/upgrade).

## Update refusals

**`os:update` stops at a migration the database has not applied.**
Expected. Take a backup, run `pnpm os:migrate -- --apply`, then `pnpm os:update` again. See [Upgrade](/start/upgrade#apply-database-changes).

**`os:update` says main changes the Postgres roles.**
That is operator maintenance on the database, outside an app update. Follow the Postgres host guide on GitHub: https://github.com/notice-cx/NoticeOS/blob/main/db/postgres/host/README.md.

**`os:update` refuses changed source, declarations or image labels.**
The stack changed between preparing and applying the plan. Run `pnpm os:status`, then prepare a new plan.

**`os:rollback` says the database schema changed.**
The previous image would run older code on the newer schema. Restoring a backup is a separate procedure with its own approval.

**`os:update` refuses while the app runs live source.**
Run `pnpm os:prod` first.

**An `os:*` command says the selector is invalid or a service is unexpected.**
`.local/stack.json` must name exactly `project`, `files`, `envFile` and `dockerHost`, with absolute paths and a `unix://` socket. The stack must contain `noticeos`, `postgres` and `dolt`, and at most `backup` besides.

## Data and credentials

**A card shows a gap or "No report" instead of a number.**
That is unknown data, not zero. Open **System health** > **Background operations**; the job that feeds the card says what went wrong in its latest run. A site set to send no nightly report shows "No report" on purpose.

**A connection shows "Legacy env" or System health counts legacy credentials.**
The credential still lives in the environment file. On the card, choose **Import from this machine**. See [Secrets and credentials](/operate/secrets-and-credentials).

**`creds:check` says it is running the env-only check.**
The installation is stopped, so store-held credentials cannot be proved. Start it with `pnpm os:start`, or pass `--origin` with the right port.

**A provider job records "paused before the monthly data cap".**
The metered spend would cross the Monthly data cap. Raise it under **Settings** > **General** > **Budget**, or wait for next month.

## Browser and Wall

**The Tower refuses a hostname.**
Standalone keeps a hostname allowlist. Add your alias to `TOWER_ALLOWED_HOSTS`. Never allow every host.

**After an update, the Wall still shows the old release.**
A browser running code from before the update prompt existed needs one manual refresh. After that the Wall reloads itself.

## Backups

**The backup failed on "Offsite handoff".**
The folder in `host-backup.json` has no existing parent; usually the sync mount is missing. Fix the mount. The local set is kept.

**The backup failed on "Task hub".**
The task database service was not running; task databases are backed up online. Start it and run `pnpm os:backup`.

**A `pnpm start` installation never runs its backup.**
It runs the backup job only once its `installation/host-backup.json` names an offsite folder.

::: tip When nothing here matches
`pnpm os:status` and `pnpm os:logs -- --lines 200` print redacted output that is safe to paste into an issue.
:::

Related: [Daily operations](/operate/daily-operations), [Backups and restore](/operate/backups-and-restore), [Scheduled jobs](/operate/scheduled-jobs). The runner's recovery contract is on GitHub: https://github.com/notice-cx/NoticeOS/blob/main/scripts/README.md#agent-recovery-contract.
