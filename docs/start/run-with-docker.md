---
title: "Run with Docker"
description: "How a NoticeOS installation runs as its Docker Compose stack: the installation folder, moving an existing installation into it, controlling the stack and moving the app to new code from main."
---

# Run with Docker

This page covers how an installation runs once it exists: its folder, the commands that control it, and updates.

## Before you begin

NoticeOS runs as one Docker Compose stack of the app (`noticeos`), `postgres`, `dolt` and an optional `backup` worker. The app packages the Tower, the data receiver, the scheduler and the task client in one read-only image. It **never** creates or migrates a database.

The stack has one definition for every installation, `deploy/compose/stack.yaml` in the checkout. An installation is a folder that definition reads: [`pnpm os:setup`](/start/install-from-source) makes a new one, and `pnpm os:adopt` moves an existing one into it. Nobody writes a Compose file.

## The installation folder

| In the folder | What it holds |
| --- | --- |
| `installation.env` | This installation's choices, then the layout derived from the folder |
| `state/` | The app's state, mounted at `/state`: saved settings, bootstrap secrets, logs, the task client |
| `spokes/` | Task repositories, mounted at `/spokes` |
| `postgres-secrets/`, `dolt-secrets/` | The database logins |
| `backup/` | The backup worker's settings, its working folders, exporter checkouts and the offsite handoff |

The choices in `installation.env` are the project name, the app image, the app's user, the three loopback ports, the hostnames the Tower may be opened on, the two data volumes, and the folders an installation may keep elsewhere: task repositories, exporter checkouts and the offsite folder. Every other path follows from the folder. The checkout's `.local/stack.json` names the stack definition and this file; `os:setup` and `os:adopt` write it.

Only the Tower port reaches beyond the stack's network, on `127.0.0.1`, with Postgres and the task database beside it for the operator's tools. Provider credentials are connected in the Tower, not in files.

::: warning No login
Standalone has no user login. The port binds to loopback for that reason. If you put the Tower on a network, every client on it can read and change your data. Keep the hostname allowlist; never allow every host.
:::

## Move an existing installation

An installation that runs from Compose files of its own moves into the folder layout in one command. Its data volumes, image, ports and secrets stay the same.

1. In the checkout whose `.local/stack.json` selects the installation, read the plan:

   ```sh
   pnpm os:adopt
   ```

   It lists what it copies into the new folder (`~/noticeos` unless you add `-- --dir <folder>`), what stays where it is, and every difference that remains: a file from this checkout that differs from the one mounted now, a mount the layout has no place for, a changed port binding.

2. Type `adopt` to apply it.

The stack stops while its folders are copied, then starts from the new folder; `.local/stack.json` changes only once it is healthy. Task repositories, exporter checkouts and the offsite folder stay where they are unless they live inside the checkout the old Compose files came from. The old files are never changed. If the new stack does not become healthy, the old one starts again by itself. To go back later, run `pnpm os:adopt -- --undo`; what the app wrote to its state folder since then stays in the new folder.

## Control the stack

From the checkout, run the stack with the `os:*` commands:

```sh
pnpm os:status
pnpm os:start
pnpm os:stop
pnpm os:restart
pnpm os:logs
```

Add `-- --config /absolute/stack.json` to act on another installation's selector. The commands expect existing `noticeos`, `postgres` and `dolt` containers, plus `backup` when present. They never create containers, pull images, apply migrations or remove volumes.

Start brings up the databases, then the backup worker, then the app. Stop reverses that order. Restart waits for health at each step and stops at the first failure. [Daily operations](/operate/daily-operations) covers the rest.

## Update the app from main

Committing to `main` changes source; it changes nothing running. `pnpm os:restart` restarts the same image. To run new code:

1. In the checkout, check what runs and whether `main` differs:

   ```sh
   pnpm os:status
   ```

2. From a clean checkout at `main`, build a new image and a plan. Services keep running:

   ```sh
   pnpm os:update
   ```

3. Review the printed plan, then type `update` to apply it.

Apply recreates only the `noticeos` container and waits up to 90 seconds for health. It applies no migration, and it stops before building when `main` carries a migration the database lacks; see [Upgrade](/start/upgrade#apply-database-changes). If health does not return, it restores the previous image by itself. The Wall reloads on its next request; desk pages show an update prompt so drafts stay open.

To go back to the previous image, run `pnpm os:rollback` and type `rollback`. An image built before revision labels existed needs `-- --baseline-commit COMMIT` on the first update.

Every service restarts unless stopped; for startup after a reboot, enable your Docker engine's own startup setting.

## Follow a checkout during development

For a local installation where you want edits to appear at once:

1. In the checkout, run the app from its live source:

   ```sh
   pnpm os:dev
   ```

2. To return to the prepared image, run:

   ```sh
   pnpm os:prod
   ```

The app mounts the checkout read-only and refreshes the Tower live. The Wall caption shows **DEV**. Scheduler changes need `pnpm os:restart`; UI and Worker edits refresh on save. `os:update` refuses while the app runs live source.

## Verify

- `pnpm os:status` prints each service's state and health, the running source, and ends with `update: current` when `main` and the app agree.
- The Tower opens on `127.0.0.1` at the port `NOTICEOS_TOWER_PORT` names in `installation.env`.
- After an update, health returns within 90 seconds and the status names the new commit.

## If it didn't work

- An `os:*` command says the selector is invalid or a service is unexpected: `.local/stack.json` is missing or names files that moved. `pnpm os:setup` or `pnpm os:adopt` writes it; the stack must contain `noticeos`, `postgres` and `dolt`, and at most `backup` besides.
- `pnpm os:adopt` refuses: the sentence names what the layout cannot hold (another service, an app running live source, a network of the same name it did not create). Nothing was changed.
- `os:update` refuses changed source, declarations or image labels: the stack changed between preparing and applying the plan. Run `pnpm os:status`, then update again.
- The development app stops after a pull: the checkout's packages changed since its image was built, and `pnpm os:logs -- noticeos` says so. Run `pnpm os:dev`; it builds a matching image and moves the app onto it.
- `os:restart` or `os:update` names a service that is not healthy: `pnpm os:logs -- <service>` shows why.

More symptoms are in [Troubleshooting](/operate/troubleshooting). The full guide, including the backup worker and running report scripts inside the container, is on GitHub: https://github.com/notice-cx/NoticeOS/blob/main/deploy/compose/README.md.

## Next steps

- [Daily operations](/operate/daily-operations)
- [Backups and restore](/operate/backups-and-restore)
- [Upgrade](/start/upgrade)
