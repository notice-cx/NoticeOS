---
title: "Run with Docker"
description: "How a NoticeOS installation runs as its Docker Compose stack: the installation folder, moving an existing installation into it, controlling the stack and moving the app to new code from main."
---

# Run with Docker

This page covers how an installation runs once it exists: its folder, the commands that control it, and updates.

## Before you begin

An installation is a handful of Docker containers that work together. Docker Compose starts, stops and updates them as one unit, the **stack**:

| Container | What it does |
|---|---|
| `noticeos`, the app | Serves the Tower, receives the reports sites send (the data receiver), runs the scheduled jobs (the scheduler) and reads and writes tasks (the task client) |
| `postgres` | The store: every report, reading, ledger row and setting |
| `dolt` | The task database: every project's tasks |
| `backup` | Optional: takes the nightly backup. See [Backups and restore](/operate/backups-and-restore) |

The app runs from one read-only image and **never** creates or migrates a database.

The stack has one definition for every installation, `deploy/compose/stack.yaml`. An installation is a folder that definition reads: [one Docker command](/start/install-with-docker) or [`pnpm os:setup`](/start/install-from-source) makes a new one, and `pnpm os:convert-legacy` moves a legacy one into it. Nobody writes a Compose file.

An installation set up with Docker alone has no checkout. Its folder keeps a copy of the definition, and its `noticeos` launcher runs each command: where this page shows `pnpm os:apply -- --confirm apply`, run `~/noticeos/noticeos apply --confirm apply`.

## The installation folder

| In the folder | What it holds |
| --- | --- |
| `installation.env` | This installation's choices, then the layout derived from the folder |
| `state/` | The app's state, mounted at `/state`: saved settings, bootstrap secrets, logs, the task client |
| `spokes/` | Task repositories, mounted at `/spokes` |
| `postgres-secrets/`, `dolt-secrets/` | The database logins |
| `backup/` | The backup worker's settings, its working folders, exporter checkouts and the offsite handoff |
| `noticeos` | Without a checkout: the launcher every command runs through |
| `stack.json` | Without a checkout: the selector that points the commands at this folder |
| `stack/` | Without a checkout: the stack definition, copied from the image the app runs |

The choices in `installation.env` are the project name, the app image, the app's user, the Tower's address, the three ports, the hostnames the Tower may be opened on, the two data volumes, and the folders an installation may keep elsewhere: task repositories, exporter checkouts and the offsite folder. Every other path is derived from the folder. The checkout's `.local/stack.json` names the stack definition and this file; `os:setup` and `os:convert-legacy` write it. Without a checkout, the folder's `stack.json` does. `pnpm os:status` prints the folder on its first line.

Three ports are published outside the stack's network: the Tower's, and Postgres and the task database for the operator's tools. All three listen on `127.0.0.1`; only the Tower's can be [opened to your network](#open-the-tower-to-your-network). Provider credentials are connected in the Tower, not in files.

### Change a setting

1. Edit `installation.env` in the installation folder.
2. In the checkout, read the plan:

   ```sh
   pnpm os:apply
   ```

   Without a checkout, run `~/noticeos/noticeos apply`. It lists each change (a port, a setting such as `TOWER_ALLOWED_HOSTS`, the app's user, a folder) and the services it recreates.

3. Type `apply` to apply it. Without a terminal, run `pnpm os:apply -- --confirm apply` (`~/noticeos/noticeos apply --confirm apply`).

Only the services whose settings changed are recreated: the databases first, with the app and backup worker stopped meanwhile, then the backup worker, then the app. Each waits for health. If one does not become healthy, the stack returns to the settings it last ran healthy with. `installation.env` keeps your edit, so you can fix it and apply again.

Apply stops without changing anything when applying the edit would point a database at other data, rename the project, bind a port that is already in use, or create a missing container. After a pull that changes the stack definition, `os:apply` applies that too. With nothing to apply, it prints `Nothing to apply` and records the current settings as the ones to return to.

`pnpm os:status` prints a `settings:` line while an edit waits to be applied. `pnpm os:restart` applies nothing.

### Open the Tower to your network

::: warning No login
Standalone has no user login: anyone who reaches the Tower can read and change your data. By default it listens on `127.0.0.1`, this machine only.

To reach it from other devices, set `NOTICEOS_TOWER_BIND` in `installation.env` to `0.0.0.0` (every device on the network) or to one IPv4 address of this machine, then run `pnpm os:apply`. Do it only on a network you trust, or behind a VPN or an access proxy. Every device that reaches an open Tower can change your tasks, through its pages or its MCP address ([Connect an agent](/guides/connect-an-agent)).
:::

The plan prints a warning before it opens the Tower. Devices open it by IP address, at the port `NOTICEOS_TOWER_PORT` names. To use a machine name instead, add it to `TOWER_ALLOWED_HOSTS`: the app runs in a container, so it cannot read this machine's name. Keep that allowlist; never allow every host. Without a `NOTICEOS_TOWER_BIND` line in `installation.env`, the Tower listens on `127.0.0.1`.

## Convert a legacy installation

An installation that runs from Compose files of its own converts into the folder layout in one command. Its data volumes, image, ports, the Tower's address and secrets stay the same.

1. In the checkout whose `.local/stack.json` selects the installation, read the plan:

   ```sh
   pnpm os:convert-legacy
   ```

   It lists what it copies into the new folder (`~/noticeos` unless you add `-- --dir <folder>`), what stays where it is, and every difference that remains: a file from this checkout that differs from the one mounted now, a mount the layout has no place for, a changed port binding.

2. Type `convert` to apply it.

The stack stops while its folders are copied, then starts from the new folder; `.local/stack.json` changes only once it is healthy. Task repositories, exporter checkouts and the offsite folder stay where they are unless they are inside the checkout the old Compose files came from. The old files are never changed. If the new stack does not become healthy, the old one starts again automatically. To go back later, run `pnpm os:convert-legacy -- --undo`; what the app wrote to its state folder since then stays in the new folder.

An app that runs the checkout's live source (`pnpm os:dev`) converts too, even while it is broken: the plan starts from the prepared stack `os:dev` recorded, the app returns to that image for the move, and it runs the checkout's live source again from the new folder afterwards.

## Control the stack

From the checkout, run the stack with the `os:*` commands:

```sh
pnpm os:status
pnpm os:start
pnpm os:stop
pnpm os:restart
pnpm os:logs
```

Without a checkout, run the same commands through the folder's launcher:

```sh
~/noticeos/noticeos status
~/noticeos/noticeos restart
~/noticeos/noticeos logs --lines 200
```

Add `-- --config /absolute/stack.json` to act on another installation's selector. The commands require existing `noticeos`, `postgres` and `dolt` containers, plus `backup` when present. They never create containers, pull images, apply migrations or remove volumes. An edit to `installation.env` takes effect with [`pnpm os:apply`](#change-a-setting).

Start brings up the databases, then the backup worker, then the app. Stop reverses that order. Restart waits for health at each step and stops at the first failure. [Daily operations](/operate/daily-operations) covers the rest.

## Update the app from main

An installation without a checkout updates with `~/noticeos/noticeos update`, which moves the image and the stack definition together; see [Install with Docker](/start/install-with-docker#update-and-roll-back). The rest of this section is for a checkout.

Committing to `main` changes the source only; it does not change what is running. `pnpm os:restart` restarts the same image. To run new code:

1. In the checkout, check what runs and whether `main` differs:

   ```sh
   pnpm os:status
   ```

2. From a clean checkout at `main`, prepare the image and a plan. Services keep running:

   ```sh
   pnpm os:update
   ```

3. Review the printed plan, then type `update` to apply it.

The image is the one CI published for `main`'s commit, used only when it was built from exactly this checkout's source. When none is published yet (it appears a few minutes after CI passes on `main`) or the registry is unreachable, the update builds it here and prints the reason. `pnpm os:update -- --build` always builds here. A fork's commits are not published, so a fork builds here.

Apply recreates only the `noticeos` container and waits up to 90 seconds for health. It applies no migration, and it stops before fetching or building when `main` has a migration the database does not have; see [Upgrade](/start/upgrade#apply-database-changes). If the app is not healthy within that time, it restores the previous image automatically. The Wall reloads on its next request; the other Tower pages show an update prompt so that drafts stay open.

To go back to the previous image, run `pnpm os:rollback` and type `rollback`. An image built before revision labels existed needs `-- --baseline-commit COMMIT` on the first update.

Every service restarts unless stopped; for startup after a reboot, enable your Docker engine's own startup setting.

## Run live source during development

For a local installation where you want edits to appear at once:

1. In the checkout, run the app from its live source:

   ```sh
   pnpm os:dev
   ```

2. To return to the prepared image, run:

   ```sh
   pnpm os:prod
   ```

The app mounts the checkout read-only and refreshes the Tower live. The Wall caption shows **DEV**. Scheduler changes need `pnpm os:restart`; UI and Worker edits refresh on save. `os:update` stops without changing anything while the app runs live source.

## Verify

- `pnpm os:status` prints each service's state and health, the running source, and ends with `update: current` when the app runs `main`'s commit.
- The Tower opens on `127.0.0.1` at the port `NOTICEOS_TOWER_PORT` names in `installation.env`, or on the address `NOTICEOS_TOWER_BIND` names.
- After `pnpm os:apply`, it prints `Applied:` and `pnpm os:status` prints no `settings:` line.
- After an update, the app is healthy within 90 seconds and the status shows the new commit.

## If it didn't work

- An `os:*` command reports that the selector is invalid or a service is unexpected: `.local/stack.json` is missing or names files that moved. `pnpm os:setup` or `pnpm os:convert-legacy` writes it; the stack must contain `noticeos`, `postgres` and `dolt`, and at most `backup` besides.
- `pnpm os:convert-legacy` stops: the error message names what the layout cannot hold (another service, a stack that is not healthy, a network of the same name it did not create). Nothing was changed.
- `pnpm os:apply` stops: the error message gives the reason, and nothing was changed. See [When `pnpm os:apply` stops](/operate/troubleshooting#when-pnpm-os-apply-stops).
- `pnpm os:apply` reports that starting a service failed: the message shows whether the stack returned to its earlier settings. Fix `installation.env` with Docker's output and `pnpm os:logs -- <service>`, then apply again.
- `os:update` or `os:setup` reports that the published image "was not built from this checkout's source": nothing was changed. Add `-- --build` to build it here.
- `os:update` stops on changed source, declarations or image labels: the stack changed between preparing and applying the plan. Run `pnpm os:status`, then update again.
- The development app stops after a pull: the checkout's packages changed since its image was built, and `pnpm os:logs -- noticeos` shows this. Run `pnpm os:dev`; it builds a matching image and moves the app onto it.
- `os:restart` or `os:update` names a service that is not healthy: `pnpm os:logs -- <service>` shows why.

More symptoms are in [Troubleshooting](/operate/troubleshooting). The full guide, including the backup worker and running report scripts inside the container, is on GitHub: https://github.com/notice-cx/NoticeOS/blob/main/deploy/compose/README.md.

## Next steps

- [Daily operations](/operate/daily-operations)
- [Backups and restore](/operate/backups-and-restore)
- [Upgrade](/start/upgrade)
