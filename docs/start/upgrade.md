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
- Changing the code and changing the database are **two separate steps**. A restart, a merge or an app update never applies a migration.
- Rolling the app back keeps the updated database. It does not reverse a migration.

You need a backup with a restore path you have tested, and the target release's own instructions.

## Check what runs and back up

1. In the checkout, find out what runs now:

   ```sh
   pnpm os:status
   ```

   It prints each service's health, whether the database has every migration this checkout carries, the commit the app runs and whether `main` is ahead.
2. Check for pending database changes. This reads only:

   ```sh
   pnpm os:migrate
   ```

   It finds the stack's database from `.local/stack.json` and never prints a password.

3. Take a backup with a restore path you have tested:

   ```sh
   pnpm os:backup
   ```

   See [Backups and restore](/operate/backups-and-restore).
4. Read the target release's own instructions.

## Apply database changes

Database migrations are **your step, every time**, and they come before the app update. Skip this section when `pnpm os:migrate` lists nothing pending.

1. In the checkout, read the pending migrations:

   ```sh
   pnpm os:migrate
   ```

2. Apply them:

   ```sh
   pnpm os:migrate -- --apply
   ```

The app keeps running while you migrate: migrations are additive unless the release's own instructions say otherwise. The apply prints its plan first, asks you to type the database's name, runs in one transaction with a lock, and applies only migrations whose hashes the release froze. A changed or out-of-order migration stops it.

::: warning Never adopt an existing database through fresh setup
Do not point `pnpm start` at an existing database to "migrate" it, and never edit a migration that has been applied. Those paths are refused by design.
:::

## Upgrade the app

1. In the checkout, on a clean `main`, run:

   ```sh
   pnpm os:update
   ```

2. Review the printed plan, then type `update` to apply it.

The update builds `main` into an image while everything keeps running, then replaces only the app container and waits up to 90 seconds for health. If health does not return, it puts the previous image back by itself. It stops, changing nothing, when `main` carries a migration the database has not applied; run Apply database changes first. Without a terminal it prints `pnpm os:update -- --apply <plan>` for you to run later.

### An installation started with `pnpm start`

1. Pull the new code and run `pnpm install --frozen-lockfile`.
2. Run `pnpm start` again.

If the database is behind the new code, the start stops in one sentence naming the migration command. Nothing is migrated automatically.

## Roll back

- **App:** `pnpm os:rollback` prepares a plan for the previous image and applies it after you type `rollback`. It is refused when the database schema changed since that image.
- **Database:** there is no automatic reversal. A rollback of the app runs the older code against the newer schema, which is only safe when the release notes say that app version is eligible. Restoring a backup is a separate procedure with its own approval.

## Upgrade the demo

The demo has its own updater, `deploy/demo/update.sh`, which builds the target commit and either swaps the image or seeds a fresh generation. See [Try the demo](/start/try-the-demo).

## Verify

- `pnpm os:status` names the new commit, says `update: current`, and says the database has every migration.
- `pnpm os:migrate` lists nothing pending.
- The Wall reloads on its next request; desk pages show an update prompt.

## If it didn't work

- The update stops at a migration the database has not applied: expected. Run Apply database changes, then update again.
- The apply exits non-zero: 1 is failed and rolled back, 2 is refused with nothing changed, 3 means no Postgres tools on this machine.
- The update refuses changed source, declarations or image labels: the stack changed between preparing and applying the plan. Run `pnpm os:status`, then update again. See [Troubleshooting](/operate/troubleshooting#update-refusals).

The policy itself is in [the release policy](../reference/release-policy.md). The migration tool's full contract is at https://github.com/notice-cx/NoticeOS/blob/main/db/postgres/README.md#applying-it-to-an-installations-own-database.

## Next steps

- [Daily operations](/operate/daily-operations)
- [Backups and restore](/operate/backups-and-restore)
- [Run with Docker](/start/run-with-docker)
