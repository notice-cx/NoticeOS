---
title: "Troubleshooting"
description: "The states and refusals you will meet while running NoticeOS, what each one means, and what to do about it."
---

# Troubleshooting

This page gets you from a symptom to the one command or setting that fixes it.

Start every investigation with the state, not the port: `pnpm os:status` for the macOS service, `pnpm stack:status` for a Compose stack, the terminal for a `pnpm start` installation. When the cause is unclear, run `pnpm os:doctor` before restarting anything.

## Service states

**`stopped` — "no launchd service is loaded and the runtime does not answer".**
The service was stopped or never installed. Run `pnpm os:start` if you stopped it for maintenance; run `pnpm os:install` if it was never installed.

**`starting` — the runtime is not ready or the scheduler is still arming.**
Wait a minute and check again. If it stays there, read the log.

**`stale` — the endpoints answer but the heartbeat is old.**
The app is up, but its supervisor stopped proving life. Run `pnpm os:doctor`, then `pnpm os:restart`.

**`unhealthy` — "runtime answers, but the launchd supervisor is not installed or loaded".**
A foreground `pnpm os:up` is running in some terminal. Stop that terminal with Ctrl-C. The control command will not kill a process it does not manage.

**`unhealthy` — "PostgreSQL readiness is not confirmed" or "task database readiness is not confirmed".**
The app is up, but a database did not answer a readiness read. Check that the database's Docker container is running, then `pnpm os:restart`.

**`unhealthy` — "launchd service exited with code N".**
The runner refused to start. The exit code says why; see Runner refusals.

## Runner refusals

**The log says `REFUSING to start` and names a fix; exit code 5.**
The database address in the secrets file is unusable, or the database is behind the code. The line names the command: usually the migration sequence in [Upgrade](/start/upgrade). The address itself is never printed.

**Exit code 3, with an `lsof` line.**
Another runner already holds the data port (8791), and two runners would fire every schedule twice. Stop the process the line names, then start again.

**Exit code 4.**
A runtime copy lost its links to the checkout's state, or its database check failed. Run `pnpm os:deploy -- --check`, then `pnpm os:deploy`.

**`REFUSING to start Tower: prepared dependencies are unavailable or stale`.**
Run `pnpm install --frozen-lockfile` and start again.

## `pnpm start` refusals

**"port N belongs to the managed service".**
Ports 5173, 8791 and 3308 are reserved for the macOS service. Choose another with `--port`.

**"port N is in use".**
Something else holds it. Stop it or pick another port.

**"… holds files pnpm start did not make".**
The folder is not one `pnpm start` created. Choose an empty folder with `--dir`.

**"DATABASE_URL is not set … run pnpm postgres:secrets first".**
The folder has no database address and no prepared profile to copy one from. Run `pnpm postgres:secrets` first, following the database setup guide the message names.

**The start stops saying the database is behind this code.**
Apply the migration as your own step, then start again. See [Upgrade](/start/upgrade).

## Deploy refusals

**`os:deploy` refuses a migration the database has not applied.**
Expected. Run the printed sequence: `pnpm os:stop`, `pnpm postgres:migrate apply …`, `pnpm os:start`, then deploy again.

**`os:deploy` refuses: not on main, moves backwards, or a runtime copy is dirty.**
Deploy only a commit on `main` that is ahead of what runs. To go back, use `-- --rollback`. Clean the runtime copy before deploying.

**`stack:deploy` refuses changed source, declarations or image labels.**
The stack changed between preparing and applying the plan. Run `pnpm stack:status`, then prepare a new plan.

**`stack:*` says the selector is invalid or a service is unexpected.**
`.local/stack.json` must name exactly `project`, `files`, `envFile` and `dockerHost`, with absolute paths and a `unix://` socket. The stack must contain `noticeos`, `postgres` and `dolt`, and at most `backup` besides.

## Data and credentials

**A card shows a gap or "No report" instead of a number.**
That is unknown data, not zero. Open **System health** > **Background operations**; the job that feeds the card says what went wrong in its latest run. A site set to send no nightly report shows "No report" on purpose.

**A connection shows "Legacy env" or System health counts legacy credentials.**
The credential still lives in the environment file. On the card, choose **Import from this machine**. See [Secrets and credentials](/operate/secrets-and-credentials).

**`creds:check` says it is running the env-only check.**
The installation is stopped, so store-held credentials cannot be proved. Start it, or pass `--origin` with the right port.

**A provider job records "paused before the monthly data cap".**
The metered spend would cross the Monthly data cap. Raise it under **Settings** > **General** > **Budget**, or wait for next month.

## Browser and Wall

**The Tower refuses a hostname.**
Standalone keeps a hostname allowlist. Add your alias to `TOWER_ALLOWED_HOSTS`. Never allow every host.

**After a deploy, the Wall still shows the old release.**
A browser running code from before the update prompt existed needs one manual refresh. After that the Wall reloads itself.

## Backups

**The backup failed on "Offsite handoff".**
The folder in `host-backup.json` has no existing parent; usually the sync mount is missing. Fix the mount. The local set is kept.

**The backup failed on "Task hub".**
The task database service was not running; task databases are backed up online. Start it and run `pnpm os:backup`.

**A `pnpm start` installation never runs its backup.**
It runs the backup job only once its `installation/host-backup.json` names an offsite folder.

::: tip When nothing here matches
`pnpm os:doctor` prints a bounded, redacted report that is safe to paste into an issue.
:::

Related: [Daily operations](/operate/daily-operations), [Backups and restore](/operate/backups-and-restore), [Scheduled jobs](/operate/scheduled-jobs). The runner's recovery contract is on GitHub: https://github.com/notice-cx/NoticeOS/blob/main/scripts/README.md#agent-recovery-contract.
