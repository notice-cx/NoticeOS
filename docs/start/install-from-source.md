---
title: "Install from source"
description: "Set up a new NoticeOS installation on any Docker host with one command, and learn what that command creates."
---

# Install from source

Follow this page to go from a clone of the repository to the Tower open in your browser.

Setup makes the same **installation** as [Install with Docker](/start/install-with-docker): a folder, `~/noticeos`, and a set of Docker containers, the **stack**, that keeps running in the background. One container serves the **Tower**, the NoticeOS web app you open in your browser; the others hold your data and your tasks, and one takes backups. The difference is the clone: you control the installation with `pnpm os:*` commands from it, and you can change NoticeOS and build its image yourself.

## Before you begin

You need three things on the machine, and nothing else:

- Node.js 24.21.0 LTS
- pnpm 12.8.1
- Docker: a running local engine with Docker Compose, on `linux/arm64` or `linux/amd64`

The steps that need the PostgreSQL client and the task tool run inside the app's own image. To run NoticeOS without a checkout, [install with Docker](/start/install-with-docker) instead.

## Set up and start

1. In a terminal, in a clone of the repository on `main`, run the install with the pinned dependencies:

   ```sh
   pnpm install --frozen-lockfile
   ```

2. Set up the installation:

   ```sh
   pnpm os:setup
   ```

3. In your browser, open **http://127.0.0.1:5173/**.

Setup fetches the app image CI published for `main`, or builds it here when none is published yet; a build takes a few minutes. When it prints **NoticeOS is running**, the stack keeps running: its services start again when Docker starts, and the `pnpm os:*` commands control it from this checkout. See [Daily operations](/operate/daily-operations).

::: warning Keep it private
A standalone installation has no login. It listens on `127.0.0.1`, so nothing outside your machine can reach it. Before you [open it to a network](/start/run-with-docker#open-the-tower-to-your-network), make sure that network is one you trust, or put a VPN or an access proxy in front of it.
:::

### Options

```sh
pnpm os:setup -- --dir ~/noticeos-test     # keep the installation in another folder (default ~/noticeos)
pnpm os:setup -- --offsite ~/Sync/Backups  # copy each night's backup into a folder that a sync client copies off the machine
pnpm os:setup -- --tower-port 6000         # serve the Tower on another port
pnpm os:setup -- --build                   # build the app image here instead of fetching the published one
pnpm os:setup -- --without-backup          # set up without the backup worker
```

The Tower uses port 5173, Postgres 5432 and the task database 3306, all on `127.0.0.1`; setup uses the next free port when one is taken and prints the Tower's.

### What setup creates

One installation folder, `~/noticeos` unless you name another, holds everything that belongs to the installation:

| In the folder | What it holds |
| --- | --- |
| `installation.env` | This installation's choices (ports, image, folders) and the layout derived from them |
| `state/` | The app's state: saved settings, bootstrap secrets, logs, the task client |
| `spokes/` | Task repositories, starting with NoticeOS's own |
| `postgres-secrets/`, `dolt-secrets/` | The database logins, made new for this installation |
| `backup/` | The backup worker's settings and working folders |

The databases' data is stored in two Docker volumes named after the project (`noticeos_postgres-data`, `noticeos_dolt-data`). The stack itself is `deploy/compose/stack.yaml` in the checkout; you never write a Compose file. The checkout's `.local/stack.json` points the `os:*` commands at the folder.

Before it makes anything, setup checks that the folder, the Compose project and its volumes are all new. It then applies the committed database schema, creates one workspace and one internal NoticeOS task project so the Tasks page works before you add an asset, and loads the default settings. The installation starts with no assets and no provider accounts.

## Get your first useful view

1. On **Home**, select **Add your first asset**.
2. On the new asset's **Data sources** tab, select **Connect** on a source.
3. Open the asset's **Overview** to see its first readings.

Use **Tasks** for work and **Wall** for the TV view. Provider credentials go in on the **Integrations** page, where they are encrypted in the store. See [Secrets and credentials](/operate/secrets-and-credentials).

## Verify

- `pnpm os:status` shows `postgres`, `dolt`, `backup` and `noticeos` running and healthy, and the database with every migration.
- **Home** shows three steps: **Add your first asset**, **Connect a source** and **See your first number**.
- **Tasks** opens before any asset exists.

## If it didn't work

- Setup stops before making anything: the folder is not empty, the project already has containers or volumes, or `.local/stack.json` already selects an installation. The error message names which one; a legacy installation moves into the layout with `pnpm os:convert-legacy` ([Run with Docker](/start/run-with-docker#convert-a-legacy-installation)).
- Setup reports that the published image "was not built from this checkout's source": nothing was made. Run `pnpm os:setup -- --build`.
- Setup stops after it started making things: it lists what it made and leaves it in place for you to inspect. `pnpm os:logs` shows what the services logged.
- `pnpm run` stops with an error after you pulled new code: run `pnpm install --frozen-lockfile` again.

[Troubleshooting](/operate/troubleshooting) lists every case where a command stops, with its fix.

## Next steps

- [Add your first asset](/guides/add-your-first-site)
- [Connect data sources](/guides/connect-data-sources)
- [Daily operations](/operate/daily-operations)
