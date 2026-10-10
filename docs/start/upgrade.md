---
title: "Upgrade"
description: "Move an existing installation to newer NoticeOS code safely, apply database changes as a separate step, and go back if you need to."
---

# Upgrade

This page gets you from a running installation to a newer release without losing data.

## Before you begin

The release policy, in plain words:

- A package version number or a green build is **not** a qualified release. A release is identified by its source commit, its toolchain, its schema and the checks that actually ran.
- A new installation from source starts empty. An existing installation keeps its own configuration and its own maintenance steps.
- The application container starts an installation you prepared. It never creates or migrates a database.
- Changing the code and changing the database are **two separate steps**. A restart, a merge or an app deployment never applies a migration.
- Rolling the app back keeps the updated database. It does not reverse a migration.

You need a backup with a restore path you have tested, and the target release's own instructions.

## Check what runs and back up

1. In the checkout, find out what runs now. For the macOS service, run `pnpm os:status`. For a Compose stack, run `pnpm stack:status`. Both print the running commit and whether `main` is ahead.
2. Check for pending database changes. This reads only:

   ```sh
   pnpm postgres:migrate status --database noticeos --url-from NOTICEOS_OWNER_URL
   ```

   `NOTICEOS_OWNER_URL` is an environment variable holding the owner login's connection string for the target database. The command prints `***` wherever it would repeat a password.

3. Take a backup with a restore path you have tested. See [Backups and restore](/operate/backups-and-restore).
4. Read the target release's own instructions.

## Upgrade the app

### macOS service

1. In the checkout, verify without changing anything:

   ```sh
   pnpm os:deploy -- --check
   ```

2. Move the live service to `main` with one restart:

   ```sh
   pnpm os:deploy
   ```

The deploy refuses, changing nothing, when the commit is not on `main`, when it would move backwards, when a runtime copy is dirty, or when the code carries a migration the database has not applied. In that last case it prints the migration sequence from Apply database changes.

### Docker Compose stack

1. In the checkout, check the stack, then prepare an image and a plan:

   ```sh
   pnpm stack:status
   pnpm stack:deploy
   ```

2. Review the plan, then apply it:

   ```sh
   pnpm stack:deploy -- --apply /absolute/stack-deploy/PLAN_SHA256.json
   ```

Apply recreates only the app container. See [Run with Docker](/start/run-with-docker).

### An installation started with `pnpm start`

1. Pull the new code and run `pnpm install --frozen-lockfile`.
2. Run `pnpm start` again.

If the database is behind the new code, the start stops in one sentence naming the migration command. Nothing is migrated automatically.

## Apply database changes

Database migrations are **your step, every time**. Do them with the service stopped.

1. In the checkout, read the pending migrations:

   ```sh
   pnpm postgres:migrate status --database noticeos --url-from NOTICEOS_OWNER_URL
   ```

2. Stop the service: `pnpm os:stop` for the macOS service, `pnpm stack:stop` for a Compose stack, or Ctrl-C in a `pnpm start` terminal.
3. Apply the migrations:

   ```sh
   pnpm postgres:migrate apply --database noticeos --url-from NOTICEOS_OWNER_URL --confirm noticeos
   ```

4. Start the service again: `pnpm os:start`, `pnpm stack:start`, or `pnpm start`.

The apply prints its plan first, needs the database name typed twice, runs in one transaction with a lock, and applies only migrations whose hashes the release froze. A changed or out-of-order migration stops it.

::: warning Never adopt an existing database through fresh setup
Do not point `pnpm start` at an existing database to "migrate" it, and never edit a migration that has been applied. Those paths are refused by design.
:::

## Roll back

- **macOS service:** `pnpm os:deploy -- --rollback` points the service at the other installed runtime copy with one restart.
- **Compose stack:** `pnpm stack:deploy -- --rollback` prepares a plan for the recorded previous image; apply it like any plan.
- **Database:** there is no automatic reversal. A rollback of the app runs the older code against the newer schema, which is only safe when the release notes say that app version is eligible. Restoring a backup is a separate procedure with its own approval.

## Upgrade the demo

The demo has its own updater, `deploy/demo/update.sh`, which builds the target commit and either swaps the image or seeds a fresh generation. See [Try the demo](/start/try-the-demo).

## Verify

- `pnpm os:status` or `pnpm stack:status` names the new commit and no longer says `main` is ahead.
- `pnpm postgres:migrate status` lists nothing pending.
- The migration apply exits with code 0. The Wall reloads on its next request; desk pages show an update prompt.

## If it didn't work

- The deploy refuses a migration the database has not applied: expected. Run the sequence in Apply database changes, then deploy again.
- The apply exits non-zero: 1 is failed and rolled back, 2 is refused with nothing changed, 3 means no Postgres tools on this machine.
- The deploy refuses because the commit is not on `main`, moves backwards, or a runtime copy is dirty: deploy only a commit on `main` that is ahead of what runs, and clean the runtime copy first. See [Troubleshooting](/operate/troubleshooting).

The policy itself is in [the release policy](../reference/release-policy.md). The migration tool's full contract is at https://github.com/notice-cx/NoticeOS/blob/main/db/postgres/README.md#applying-it-to-an-installations-own-database.

## Next steps

- [Daily operations](/operate/daily-operations)
- [Backups and restore](/operate/backups-and-restore)
- [Run with Docker](/start/run-with-docker)
