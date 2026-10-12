---
title: "Upgrade"
description: "Move an existing installation to newer NoticeOS code safely, apply database changes as a separate step, and go back if you need to."
---

# Upgrade

Follow this page to move a running installation to a newer release without losing data.

## Before you begin

The release policy, in plain words:

- A package version number or a passing build does **not** make a release qualified. A release is identified by its source commit, its toolchain, its schema and the checks that actually ran.
- A new installation starts empty. An existing installation keeps its own configuration and its own maintenance steps.
- The application container starts an installation you prepared. It never creates or migrates a database.
- Changing the code and changing the database are **two separate steps**. A restart, a merge or an app update never applies a migration.
- Rolling the app back keeps the updated database. It does not reverse a migration.

You need a backup with a restore path you have tested, and the target release's own instructions.

This page shows each command as you run it from a checkout. An installation [set up with Docker alone](/start/install-with-docker) runs the same commands through its folder's launcher, with no `--`: `pnpm os:migrate -- --apply` is `~/noticeos/noticeos migrate --apply`.

## Check what runs and back up

1. In the checkout, find out what runs now:

   ```sh
   pnpm os:status
   ```

   It prints each service's health, whether the database has every migration this code includes, the commit the app runs and whether `main` is ahead. Without a checkout, `main` is the newest published version.
2. Check for pending database changes. This reads only:

   ```sh
   pnpm os:migrate
   ```

   It finds the stack's database from the stack's selector and never prints a password. Without a checkout, it runs from the newest published image, so it lists that version's migrations.

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

The app keeps running while you migrate: migrations are additive unless the release's own instructions say otherwise. The apply prints its plan first, prompts you to type the database's name, runs in one transaction with a lock, and applies only migrations whose hashes are frozen in the release. A changed or out-of-order migration stops it.

::: warning Never adopt an existing database through fresh setup
`pnpm os:setup` stops when the folder, project or volume already exists, so it cannot "migrate" an installation; never edit a migration that has been applied either. Both are blocked on purpose.
:::

## Upgrade the app

### From a checkout

1. In the checkout, on a clean `main`, run:

   ```sh
   pnpm os:update
   ```

2. Review the printed plan, then type `update` to apply it.

The update fetches the image CI published for `main`'s commit, used only when it was built from exactly this checkout's source, or builds it here when none is published yet. `-- --build` always builds here. Everything keeps running meanwhile. It then replaces only the app container and waits up to 90 seconds for health. If the app is not healthy within that time, it puts the previous image back automatically. It stops without changing anything when `main` has a migration the database has not applied; run Apply database changes first. Without a terminal it prints `pnpm os:update -- --apply <plan>` for you to run later.

After a pull that changes the stack definition, `pnpm os:status` prints a `settings:` line until `pnpm os:apply` recreates what changed; the update does so for the app. While the app runs without the current settings, **Settings** > **Installation** shows the apply command in place of the folder.

### Without a checkout

1. Read the plan:

   ```sh
   ~/noticeos/noticeos update
   ```

2. Type `update` to apply it, or run `~/noticeos/noticeos update --confirm update`.

It moves to main's newest published version: the image and the stack definition copied out of it, together. It recreates every service whose declaration changed, databases first, each waiting for health, and returns to the version before when one does not become healthy. It stops without changing anything when that version has a migration the database does not have: run `~/noticeos/noticeos migrate --apply` first. See [Install with Docker](/start/install-with-docker#update-and-roll-back).

## Roll back

- **App:** `pnpm os:rollback` prepares a plan for the previous image and applies it after you type `rollback`. Without a checkout, `~/noticeos/noticeos rollback` returns to the version before the last update. Both stop without changing anything when the database schema changed since then.
- **Database:** there is no automatic reversal. A rollback of the app runs the older code against the newer schema, which is only safe when the release notes say that app version is eligible. Restoring a backup is a separate procedure with its own approval.

## Upgrade the demo

The demo has its own updater, `deploy/demo/update.sh`, which builds the target commit and either swaps the image or seeds a fresh generation. See [Try the demo](/start/try-the-demo).

## Verify

- `pnpm os:status` shows the new commit, `update: current`, and that the database has every migration.
- `pnpm os:migrate` lists nothing pending.
- The Wall reloads on its next request; the other Tower pages show an update prompt.

## If it didn't work

- The update stops at a migration the database has not applied: expected. Run Apply database changes, then update again.
- The apply exits non-zero: 1 means it failed and rolled back, 2 means it stopped with nothing changed, 3 means no Postgres tools on this machine.
- `noticeos update` reports that `installation.env` has an edit that is not applied yet: run `~/noticeos/noticeos apply`, or undo the edit, then update again.
- The update reports that the published image "was not built from this checkout's source": nothing changed. Run `pnpm os:update -- --build` to build it here.
- The update stops on changed source, declarations or image labels: the stack changed between preparing and applying the plan. Run `pnpm os:status`, then update again. See [Troubleshooting](/operate/troubleshooting#when-an-update-stops).

The policy itself is in [the release policy](../reference/release-policy.md). The migration tool's full contract is at https://github.com/notice-cx/NoticeOS/blob/main/db/postgres/README.md#applying-it-to-an-installations-own-database.

## Next steps

- [Daily operations](/operate/daily-operations)
- [Backups and restore](/operate/backups-and-restore)
- [Run with Docker](/start/run-with-docker)
