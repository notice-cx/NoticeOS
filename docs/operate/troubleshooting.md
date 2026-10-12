---
title: "Troubleshooting"
description: "The states and stop messages you will see while running NoticeOS, what each one means, and what to do about it."
---

# Troubleshooting

This page lists each symptom with the command or setting that fixes it.

Start every investigation by running `pnpm os:status`, not by checking a port. When the cause is unclear, read `pnpm os:logs -- --lines 200` before restarting anything.

An installation without a checkout runs each command on this page through its folder's launcher, with no `--`: `~/noticeos/noticeos status`, `~/noticeos/noticeos logs --lines 200`. Its messages show the launcher command where this page shows `pnpm os:*`.

## Service states

**A service is `exited` or `created`.**
The stack was stopped or a service did not start. Run `pnpm os:start`; it starts the databases, then the backup worker, then the app, and stops at the first one whose health check does not pass.

**`noticeos: running, starting`.**
The app is starting or its scheduler has not yet set its timers. Wait a minute and check again. If it stays there, read the log.

**`noticeos: running, unhealthy`.**
The scheduler's heartbeat (a regular signal that it is still running) is old, the Tower or the data receiver does not respond, or a configured backup worker does not. Read `pnpm os:logs -- noticeos`, then `pnpm os:restart`.

**`postgres` or `dolt` is `unhealthy`.**
A database did not pass its own health check. Read `pnpm os:logs -- postgres` or `-- dolt`, then `pnpm os:restart`.

**`database:` shows the database is behind.**
The code the app runs carries migrations the database has not applied. Applying them is your own step; see [Upgrade](/start/upgrade#apply-database-changes).

**The app keeps restarting.**
The scheduler exits at start. The log shows why; see [When the scheduler stops at start](#when-the-scheduler-stops-at-start).

## When the scheduler stops at start

**The log shows `REFUSING to start` and a fix; exit code 5.**
The database address in the secrets file is unusable, or the database is behind the code. The line includes the command: usually the migration sequence in [Upgrade](/start/upgrade). The address itself is never printed.

**Exit code 3, with an `lsof` line.**
Another scheduler already holds the data port (8791), and two would fire every schedule twice. Restart the app with `pnpm os:restart`.

**`REFUSING to start Tower: prepared dependencies are unavailable or stale`, or `NoticeOS container refused: The checkout's packages changed since this image was built`.**
On a development stack, run `pnpm os:dev`: it builds a matching image and moves the app onto it. On a production stack, run `pnpm os:update` to move the app to a matching image.

**`pnpm os:restart` or `pnpm os:update` names a service that is not healthy.**
`pnpm os:logs -- <service>` shows why. When it is the app and the database lacks this code's migrations, the message shows that: run `pnpm os:migrate -- --apply`, then `pnpm os:restart`.

## Runtime log lines

In the app container, one process runs the Tower and the data receiver together, and one scheduler fires every schedule. A second copy would run every schedule twice, so a second runtime does not start on ports that are in use. A `pnpm db:try-tower` Tower or a browser-test server has its own folder and ports; it does not make the stack unhealthy.

**`[ingest-door] cannot listen on <host>:<port>`.**
Another runtime already holds the data port inside the app container. Run `pnpm os:restart`.

**`cron … fired → HTTP 403 runner_lane_loopback_only`, and every request on the data port returns 403.**
The header that marks a request as the scheduler's is not reaching the app, so every scheduled request is rejected. A restart runs the same code. File an issue with the log lines; the fix is installed with `pnpm os:update`.

**One request path returns 403 while the others work.**
The failure is specific to that path. Keep the redacted request and log lines, and file them.

**`cron … fired → HTTP 500 {"error":"scheduled_failed"}`.**
The job failed in its provider, credential or database work. Read its recorded failure under **System health** > **Background operations**, or in `pnpm os:logs`. Do not rerun the job to test health.

**`/api/pulse` returns 401 where it used to work.**
The data receiver's bootstrap secret is missing or changed. See [bootstrap secrets](../06-operations.md#bootstrap-secrets-vs-integration-credentials). Keep the value out of anything you share.

**The Tower loads, but every card is empty.**
An empty screen does not prove the database is behind. Read the `database:` line of `pnpm os:status` first. A migration is always your own step; see [Upgrade](/start/upgrade).

**`pnpm --filter @noticeos/ingest dev` exits without starting.**
Expected while another runtime holds the data port: a standalone data receiver would be a second runtime over the same files.

## When `pnpm os:setup` or `pnpm os:convert-legacy` stops

Each line starts with `pnpm os:setup:` or `pnpm os:convert-legacy:`; from the Docker install, with the new folder's `noticeos setup:`. Setup's checks run before it makes anything.

**"… already selects an installation; pnpm os:status shows it, and pnpm os:convert-legacy moves a legacy one into the layout".**
This checkout already has an installation. Use it, or move it with `pnpm os:convert-legacy`.

**"… is not empty; setup makes a new installation in a new or empty folder".**
Choose a new or empty folder with `--dir`. A folder inside the checkout is rejected too.

**"Docker already has containers for the project …", or "the volume … already exists; setup never takes over existing data".**
Another installation uses that project name. Choose another with `--project`, or move that installation with `pnpm os:convert-legacy`.

**"setup needs a local Docker engine on a Unix socket".**
Start Docker, or select its local context, and run setup again.

**"Docker runs on …; NoticeOS images are built for amd64 and arm64".**
Use a machine whose Docker runs `linux/amd64` or `linux/arm64`.

**"an installation without a checkout runs the image its launcher fetched; --image and --build need a checkout".**
Leave those out, or [install from source](/start/install-from-source).

**"port N is in use; choose another".**
The port you named with `--tower-port` is taken. Name another, or leave it out and setup picks the next free one.

**"the offsite folder … does not exist; a missing sync folder is never made locally".**
Mount or create the sync folder first, then run setup again.

**"Made so far, left for inspection: …".**
A step failed after setup started making things. The line before it shows which step; `pnpm os:logs` shows the services' side. Setup never deletes or reuses what it made, so a new attempt needs another `--dir` and `--project`.

**"… are not healthy; a conversion moves a healthy stack".**
Fix the stack first: `pnpm os:status`, then `pnpm os:logs`. A development app may be broken; the databases and the backup worker may not.

**"the app runs from live source and the record of its prepared image is missing", or "the stack changed since pnpm os:dev recorded it".**
The conversion has no record of which prepared stack to move. Run `pnpm os:prod`, then `pnpm os:convert-legacy` again.

**"the stack already runs from the layout; nothing to convert".**
Nothing to do.

**"… exists from an earlier conversion; pnpm os:convert-legacy -- --undo returns to it, or remove it".**
An earlier conversion is still recorded. Undo it, or remove that file once you keep the new folder.

**"… The old stack runs again; … was left for inspection".**
The new stack did not become healthy, so the old one was started again. Nothing in the old installation changed.

**"The conversion stands, with the app on its prepared image: …".**
The stack moved, but the development app did not come back on live source. `pnpm os:dev` tries again; the message shows why it failed.

## When `pnpm os:apply` stops

Each line starts with `pnpm os:apply:`. Apply never rewrites `installation.env`. The first six lines mean apply stopped before changing anything; the last three follow a service that did not start.

**"…'s data would come from … instead of …; apply never points a database at other data".**
A data volume name changed in `installation.env`. Put the old name back.

**"installation.env names the project …, but the stack is …; a project's name does not change".**
Put the old project name back.

**"port N is in use; choose another in installation.env".**
Another program holds the port you chose. Choose a free one and apply again.

**"… has no container; apply changes running services only".**
A declared service has no container to recreate. `pnpm os:status` shows the stack as it is.

**"Compose cannot read the stack: …", or "Compose cannot read the stack; is Docker running?".**
Compose's own error follows the colon: usually a line in `installation.env` it cannot read, or a value it needs. Fix the line and apply again. When no error follows, start Docker.

**"Another app operation holds the stack lock."**
An update, rollback or development switch is running. Let it finish, then apply again.

**"Starting … failed; Docker's output above says why. The stack runs with its earlier settings again; installation.env stays as you edited it."**
A service did not become healthy with your edit, so the stack went back to the settings it last ran healthy with. Read Docker's output and `pnpm os:logs -- <service>`, fix the edit, then apply again.

**"… installation.env stays as you edited it; undo the edit and run pnpm os:apply again."**
No earlier settings were recorded, so nothing was put back. Undo the edit and apply again. Running `pnpm os:apply` with nothing to apply records the current settings for next time.

**"… The earlier settings did not come back either; pnpm os:status and pnpm os:logs show where it stands."**
Neither your settings nor the earlier ones started. Read `pnpm os:status` and `pnpm os:logs -- <service>`.

## When an update stops

**"The published image for main … was not built from this checkout's source; nothing was changed. Add -- --build to build it here."**
The image CI published for this commit does not match the source this checkout prepares. Run `pnpm os:update -- --build`, or `pnpm os:setup -- --build`, to build it here.

**"No published image for this commit yet (it appears a few minutes after CI passes on main), or the registry is unreachable; building it here instead."**
The command does not stop: `os:update` or `os:setup` builds the image here, which takes a few minutes. A fork always builds here.

**"Deploy from a clean checkout at main. Commit verified changes first."**
`os:update` and `os:setup` use the committed source of `main`. Check out `main` and commit or set aside your edits.

**`os:update` stops at a migration the database has not applied.**
Expected. Take a backup, run `pnpm os:migrate -- --apply`, then `pnpm os:update` again. See [Upgrade](/start/upgrade#apply-database-changes).

**`os:update` prints that main changes the Postgres roles.**
That is operator maintenance on the database, outside an app update. Follow the Postgres host guide on GitHub: https://github.com/notice-cx/NoticeOS/blob/main/db/postgres/host/README.md.

**`os:update` stops because the source, declarations or image labels changed.**
The stack changed between preparing and applying the plan. Run `pnpm os:status`, then prepare a new plan.

**`os:rollback` prints that the database schema changed.**
The previous image would run older code on the newer schema. Restoring a backup is a separate procedure with its own approval.

**`os:update` stops while the app runs live source.**
Run `pnpm os:prod` first.

**An `os:*` command prints that the selector is invalid or a service is unexpected.**
`.local/stack.json` is missing, or names files that moved. `pnpm os:setup` or `pnpm os:convert-legacy` writes it; nobody edits it by hand. Without a checkout, the selector is the folder's `stack.json`, which setup wrote. The stack must contain `noticeos`, `postgres` and `dolt`, and at most `backup` besides.

## The `noticeos` launcher

Each line starts with `noticeos:`. When the launcher stops with one of these lines, it has run nothing.

**"could not fetch ghcr.io/notice-cx/noticeos:main; check the connection and that Docker is running".**
The launcher fetches main's newest image before `setup`, `update` and `migrate`. Check the connection, that Docker is running and that your account can run `docker`. When those are fine, the image is not public yet, and only its owner can change that. The one-line install stops at its first step for the same reasons, with Docker's own message.

**"Docker is not installed; install Docker Desktop or Docker Engine first".**
Install Docker, start it, and run the command again.

**"… holds no installation.env; run the noticeos in your installation's folder".**
The launcher was copied out of its folder. Run the `noticeos` inside the installation folder, such as `~/noticeos/noticeos status`.

**"the offsite folder … does not exist; a missing sync folder is never made here".**
Mount or create the sync folder first, then run setup again.

**"a folder with a comma in its path cannot be shared with Docker; choose another".**
Choose an installation or offsite folder without a comma.

**"the installation's network is missing; … start brings the stack up".**
`migrate` connects to Postgres on the installation's network. Run `~/noticeos/noticeos start`, then migrate again.

**"neither the app nor installation.env names the installation's image".**
The app container is gone and `installation.env` has lost its `NOTICEOS_APP_IMAGE` line. Copy that line back from `stack-apply/applied.env` in the folder, the settings the stack last ran with.

## When `noticeos update` or `rollback` stops

Each line starts with `noticeos update:` or `noticeos rollback:`. When one of them stops, nothing was changed.

**"Nothing to update: the app runs …, the newest published version."**
Nothing went wrong: the installation is current.

**"installation.env has an edit that is not applied yet: … apply applies it, or undo it; then try again."**
Run `~/noticeos/noticeos apply`, or undo the edit, then update again.

**"… is …; update needs every service running and healthy."**
A service is stopped, starting or unhealthy. Read `~/noticeos/noticeos logs <service>`, fix the service, then update again.

**"the new version carries database changes the database does not have yet: …"**
Expected. Take a backup, run `~/noticeos/noticeos migrate --apply`, then update again. See [Install with Docker](/start/install-with-docker#apply-database-changes-first).

**"the new version changes the Postgres roles; that is operator maintenance".**
Follow the Postgres host guide on GitHub: https://github.com/notice-cx/NoticeOS/blob/main/db/postgres/host/README.md.

**"… carries no commit or schema; it is not a published NoticeOS image."**
`NOTICEOS_IMAGE` names an image that was not published from `main`. Unset it to update from the published one.

**"no version before this one is recorded; there is nothing to roll back to."**
No update has run since setup.

**"the database schema changed since the version before; a rollback would run older code on it."**
The previous version would run older code on the newer schema. Restoring a backup is a separate procedure with its own approval.

**"Another app operation holds the stack lock."**
An apply, update or rollback is running. Let it finish, then try again.

**"Starting … failed; Docker's output above says why. The stack runs … again, as it did before."**
A service did not become healthy on the new version, so the definition, the image line and the services returned to the version before. Read Docker's output and `~/noticeos/noticeos logs <service>`.

**"… The earlier settings did not come back either; … status and … logs show where it stands."**
Neither version started. Read `~/noticeos/noticeos status` and `~/noticeos/noticeos logs <service>`.

## Data and credentials

**A card shows a gap or "No report" instead of a number.**
That is unknown data, not zero. Open **System health** > **Background operations**; the job that supplies the card's data shows what went wrong in its latest run. A site set to send no nightly report shows "No report" on purpose.

**A connection shows "Legacy env" or System health counts legacy credentials.**
The credential is still stored in the environment file. On the card, choose **Import from this machine**. See [Secrets and credentials](/operate/secrets-and-credentials).

**`creds:check` prints that it is running the env-only check.**
The installation is stopped, so store-held credentials cannot be tested. Start it with `pnpm os:start`, or pass `--origin` with the right port.

**A provider job records "paused before the monthly data cap".**
The metered spend would cross the Monthly data cap. Raise it under **Settings** > **General** > **Budget**, or wait for next month.

## Browser and Wall

**The Tower rejects a hostname.**
Standalone keeps a hostname allowlist. Add your alias to `TOWER_ALLOWED_HOSTS` in `installation.env`, then run `pnpm os:apply`. Never allow every host.

**Another device cannot reach the Tower.**
The Tower listens on `127.0.0.1` unless `NOTICEOS_TOWER_BIND` sets another address. See [Open the Tower to your network](/start/run-with-docker#open-the-tower-to-your-network).

**After an update, the Wall still shows the old release.**
A browser running code from before the update prompt existed needs one manual refresh. After that the Wall reloads itself.

## Backups

**The backup failed on "Offsite handoff".**
The folder in `host-backup.json` has no existing parent; usually the sync mount is missing. Fix the mount. The local set is kept.

**The backup failed on "Task hub".**
The task database service was not running; task databases are backed up online. Start it and run `pnpm os:backup`.

::: tip When nothing here matches
`pnpm os:status` and `pnpm os:logs -- --lines 200` print redacted output that is safe to paste into an issue.
:::

Related: [Daily operations](/operate/daily-operations), [Backups and restore](/operate/backups-and-restore), [Scheduled jobs](/operate/scheduled-jobs). The runner's recovery contract is on GitHub: https://github.com/notice-cx/NoticeOS/blob/main/scripts/README.md#agent-recovery-contract.
