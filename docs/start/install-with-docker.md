---
title: "Install with Docker"
description: "Set up NoticeOS with one Docker command, with no checkout, Node or pnpm, and run, update and roll it back through its folder's launcher."
---

# Install with Docker

Follow this page to go from a machine with Docker to the Tower open in your browser, with no checkout of the repository.

Setup makes an **installation**: a folder on your machine, `~/noticeos`, and a set of Docker containers, the **stack**, that keeps running in the background. One container serves the **Tower**, the NoticeOS web app you open in your browser; the others hold your data and your tasks, and one takes backups. A small **launcher** script in the folder checks, restarts and updates them. You never need a copy of NoticeOS's source code, a checkout, on this path.

## Before you begin

You need one thing on the machine:

- Docker: Docker Desktop or Docker Engine, running, on `linux/amd64` or `linux/arm64`, and an account that can run `docker`

Nothing else is needed: Docker Compose, the PostgreSQL client and the task tool are included in the app's image.

## Set up and start

1. In a terminal, run:

   ```sh
   docker run --rm ghcr.io/notice-cx/noticeos:main launcher | sh -s -- setup
   ```

2. In your browser, open **http://127.0.0.1:5173/**.

The image prints its launcher and `sh` runs it. Setup ends with:

```text
NoticeOS is running: http://127.0.0.1:5173/
Its installation is /home/you/noticeos; /home/you/noticeos/noticeos status shows it.
```

From then on the stack keeps running: its services start again when Docker starts, and the folder's `noticeos` launcher controls it. See [Daily commands](#daily-commands).

::: warning Keep it private
A standalone installation has no login. It listens on `127.0.0.1`, so nothing outside your machine can reach it. Before you [open it to a network](/start/run-with-docker#open-the-tower-to-your-network), make sure that network is one you trust, or put a VPN or an access proxy in front of it.
:::

### Options

Put setup's options after `setup`:

```sh
docker run --rm ghcr.io/notice-cx/noticeos:main launcher | sh -s -- setup --dir ~/noticeos-test --project noticeos-test
```

| Option | What it does |
| --- | --- |
| `--dir <folder>` | Keep the installation in another folder (default `~/noticeos`) |
| `--offsite <folder>` | Copy each night's backup into a folder that a sync client copies off the machine; the folder must exist |
| `--tower-port <n>` | Serve the Tower on another port |
| `--project <name>` | Another Compose project name (default `noticeos`), for a second installation on one machine |
| `--without-backup` | Set up without the backup worker |

`--build` and `--image` need a checkout; see [Install from source](/start/install-from-source).

The Tower uses port 5173, Postgres 5432 and the task database 3306, all on `127.0.0.1`. Setup checks with Docker whether each is free, uses the next free port when one is taken and prints the Tower's.

### What setup creates

One installation folder, `~/noticeos` unless you name another, holds everything that belongs to the installation. When the folder does not exist yet, setup creates it so that only you can read it.

| In the folder | What it holds |
| --- | --- |
| `noticeos` | The launcher every command runs through |
| `installation.env` | This installation's choices (ports, image, folders) and the layout derived from them |
| `stack.json` | Points the commands at this folder |
| `stack/` | The stack definition, copied from the image the app runs |
| `state/` | The app's state: saved settings, bootstrap secrets, logs, the task client |
| `spokes/` | Task repositories, starting with NoticeOS's own |
| `postgres-secrets/`, `dolt-secrets/` | The database logins, made new for this installation |
| `backup/` | The backup worker's settings and working folders |
| `stack-apply/` | The settings the stack last ran healthy with, and the version before the last update |

The app runs the same image setup ran from, pinned by its ID in `installation.env` (`NOTICEOS_APP_IMAGE`). The databases' data is stored in two Docker volumes named after the project (`noticeos_postgres-data`, `noticeos_dolt-data`).

Before it makes anything, setup checks that the folder, the Compose project and its volumes are all new. It then applies the database schema, creates one workspace and one internal NoticeOS task project, and loads the default settings. The installation starts with no assets and no provider accounts.

### How the launcher runs

Each command runs in a short-lived container from the NoticeOS image. That container mounts the Docker socket and the installation folder, at the same path as on this machine, and nothing else; setup also mounts the offsite folder. It writes files as your user.

| Variable | What it changes |
| --- | --- |
| `NOTICEOS_IMAGE` | The image setup, update and migrate run from, a local one included |
| `NOTICEOS_DOCKER_SOCKET` | The Docker socket, when it is not `/var/run/docker.sock` |

## Get your first useful view

1. On **Home**, select **Add your first asset**.
2. On the new asset's **Data sources** tab, select **Connect** on a source.
3. Open the asset's **Overview** to see its first readings.

Provider credentials go in on the **Integrations** page, where they are encrypted in the store. See [Secrets and credentials](/operate/secrets-and-credentials).

## Daily commands

Run every command through the launcher in the installation folder:

```sh
~/noticeos/noticeos status
~/noticeos/noticeos logs --lines 200
```

Each matches a `pnpm os:*` command in a checkout, with the same options and no `--`:

| Launcher | Checkout command | What it does |
| --- | --- | --- |
| `noticeos status` | `pnpm os:status` | Each service's health, the database's migrations, the app's commit, whether a newer version is published |
| `noticeos logs` | `pnpm os:logs` | Recent logs; `--follow`, `--lines N` or a service name |
| `noticeos start`, `stop`, `restart` | `pnpm os:start`, `os:stop`, `os:restart` | The whole stack, in dependency order |
| `noticeos apply` | `pnpm os:apply` | Apply an edit to `installation.env`, after you type `apply` |
| `noticeos backup` | `pnpm os:backup` | One backup now |
| `noticeos capacity` | `pnpm os:capacity` | The store's size and growth per table |
| `noticeos run-job "<cron>"` | `pnpm os:run-job -- "<cron>"` | Run the jobs scheduled on one cron expression now |
| `noticeos collect --asset <id> --families <a,b>` | `pnpm os:collect -- --asset <id> --families <a,b>` | Collect one asset's report families now; DataForSEO calls are billed |
| `noticeos update`, `rollback` | `pnpm os:update`, `os:rollback` | Move to the newest published version, or back |
| `noticeos migrate` | `pnpm os:migrate` | List pending database changes; `--apply` applies them |
| `noticeos mcp` | `pnpm os:mcp` | Start the MCP server for an agent on this machine; see [Connect an agent](/guides/connect-an-agent) |
| `noticeos bd` | `pnpm os:bd` | Run the task tool inside the app |

`setup`, `update` and `migrate` run main's newest published image, which the launcher fetches first. `mcp` and `bd` run inside the app itself. Every other command runs the image the app runs. Where a message would show a `pnpm os:*` command, it shows the launcher command instead. `os:dev`, `os:prod` and `os:convert-legacy` need a checkout.

[Daily operations](/operate/daily-operations) covers what each command prints. **Settings** > **Installation** in the Tower shows the folder, ports and version, read-only.

## Update and roll back

In `noticeos status`, the `main:` line shows the newest published commit, read from the image registry. The last line is `update: current`, or `update: main differs` when a newer version is published. `main: unavailable` and `update: unknown` mean the registry could not be read.

1. Check what runs:

   ```sh
   ~/noticeos/noticeos status
   ```

2. Read the plan:

   ```sh
   ~/noticeos/noticeos update
   ```

3. Type `update` to apply it. Without a terminal, run `~/noticeos/noticeos update --confirm update`.

A version is the image plus the stack definition copied out of it; update changes both together. The new definition is staged in `stack.next/`. Then `stack/` becomes the new copy, `stack.previous/` keeps the one before, and `NOTICEOS_APP_IMAGE` names the new image. Every service whose declaration changed is recreated as `apply` recreates it: the databases first, with the app and backup worker stopped meanwhile, then the backup worker, then the app, each waiting for health. A database image the new version names is fetched before anything stops.

If a service does not become healthy, the definition, the image line and the services all return to the version before. On success, update replaces the folder's `noticeos` with the new version's, prints the commit `rollback` returns to, and removes the image from two versions ago.

Update stops without changing anything while a service is not healthy or an edit to `installation.env` has not been applied yet. Run `noticeos apply` first, or undo the edit.

### Apply database changes first

Update applies no migration. When the new version includes database changes the database does not have yet, it stops before changing anything and prints the reason. Take a backup, then migrate, then update again:

```sh
~/noticeos/noticeos backup
~/noticeos/noticeos migrate             # what is pending, read-only
~/noticeos/noticeos migrate --apply     # prompts you to type the database's name
~/noticeos/noticeos update
```

Migrate runs from the newest published image, so it includes the new version's migrations. It connects to Postgres over the installation's own Docker network. See [Upgrade](/start/upgrade) for the release policy.

### Roll back

```sh
~/noticeos/noticeos rollback
```

It returns to the version before the last update the same way, after you type `rollback` (`--confirm rollback` without a terminal). It stops without changing anything when the database schema changed since that version, because the older code would run on the newer schema.

## Verify

- `~/noticeos/noticeos status` prints the folder first, then `postgres`, `dolt`, `backup` and `noticeos` running and healthy, `database: has every migration this code carries` and `update: current`.
- **Settings** > **Installation** shows the folder, the Tower's port and **Current** under **Updates**.
- **Home** shows three steps: **Add your first asset**, **Connect a source** and **See your first number**.

## If it didn't work

- The first command cannot fetch the image, or the launcher prints `could not fetch ghcr.io/notice-cx/noticeos:main`: check the connection, that Docker is running and that your account can run `docker`.
- Setup stops before making anything: the folder is not empty, or the project already has containers or volumes. The error message names which one; choose another `--dir` or `--project`.
- Setup stops after it started making things: it lists what it made and leaves it in place for you to inspect. A new attempt needs another `--dir` and `--project`.
- `noticeos update` stops at database changes: expected. Follow [Apply database changes first](#apply-database-changes-first).

[Troubleshooting](/operate/troubleshooting#the-noticeos-launcher) lists every case where a command stops, with its fix.

## Next steps

- [Add your first asset](/guides/add-your-first-site)
- [Daily operations](/operate/daily-operations)
- [Run with Docker](/start/run-with-docker)
