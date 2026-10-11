---
title: "Install from source"
description: "Start a new NoticeOS installation on your own machine with one command, and learn what that command creates."
---

# Install from source

This page gets you from a clone of the repository to the Tower open in your browser.

## Before you begin

`pnpm start` creates a **separate, new installation** for a fresh clone. It is not the Docker Compose stack the `pnpm os:*` commands run; that stack is how an installation you have set up runs on its own, described in [Run with Docker](/start/run-with-docker) and [Daily operations](/operate/daily-operations).

Startup checks all five of these before it creates anything:

- Node.js 24.21.0 LTS
- pnpm 12.8.1
- Docker: a running local engine with Docker Compose
- PostgreSQL client: `psql` on your `PATH`
- Task tool: `bd` 1.3.1 on your `PATH`

## Install and start

1. In a terminal, open the repository checkout.
2. Run the install with the pinned dependencies:

   ```sh
   pnpm install --frozen-lockfile
   ```

3. Run the start command:

   ```sh
   pnpm start
   ```

4. In your browser, open **http://127.0.0.1:4747/** if it does not open by itself.

The terminal that runs `pnpm start` is the installation. Press **Ctrl-C** there to stop it. Running `pnpm start` again later reuses the same installation.

::: warning Keep it private
A standalone installation has no login. It listens on `127.0.0.1` only, so nothing outside your machine can reach it. If you put it on a network, put a VPN or an access proxy in front of it first.
:::

### Options

```sh
pnpm start -- --port 6000        # the Tower on 6000, its internal data port on 6001
pnpm start -- --dir ~/noticeos   # keep the installation in another folder
pnpm start -- --no-open          # print the address, open no browser
```

The Tower uses the port you choose. The port after it receives data from your sites. The database runs on the Tower port plus two, and the task database on the Tower port plus three. With the defaults that is 4747, 4748, 4749 and 4750.

Ports 5173, 8791 and 3308 are refused even when free. They belong to the Docker stack described in [Daily operations](/operate/daily-operations).

### What startup creates

`pnpm start` makes one folder, `.local/start/` inside the checkout (or the folder you named with `--dir`), and keeps everything for the installation in it:

- runtime state and a log;
- a generated secrets file with the installation's own bootstrap secrets;
- the saved-settings exports under `installation/`;
- a Postgres database in its own Docker Compose project, with its data in a Docker volume;
- a task database (Dolt) in the same way, with one internal NoticeOS task project so the Tasks page works before you add a site.

On the first run it proves the folder, the Compose project and the data volume are new, applies the committed database schema, and creates one workspace. The installation starts with no sites and no provider accounts.

Deleting the folder does not delete the database: the data lives in Docker volumes that the folder only points at. The full startup contract is in the operations guide on GitHub: https://github.com/notice-cx/NoticeOS/blob/main/scripts/README.md#a-new-installation-in-one-command-pnpm-start.

## Get your first useful view

1. On **Home**, select **Add your first site**.
2. On the new site's **Data sources** tab, select **Connect** on a source.
3. Open the site's **Overview** to see its first readings.

Use **Tasks** for work and **Wall** for the TV view. Provider credentials go in on the **Integrations** page, where they are encrypted in the store. See [Secrets and credentials](/operate/secrets-and-credentials).

## Verify

- The terminal prints the Tower's address and keeps running.
- **Home** opens with three steps: **Add your first site**, **Connect a source** and **See your first number**.
- **Tasks** opens before any site exists, because startup created one internal NoticeOS task project.

## If it didn't work

- The start fails right away after you pulled new code: `pnpm run` refuses to start with outdated dependencies. Run `pnpm install --frozen-lockfile` again.
- The start stops in one sentence, changing nothing: the folder already holds files it did not make (choose an empty folder with `--dir`), a second start targets a folder that is already running, or the folder's database address is missing (the message names the command that sets the database up).
- The start says the database is behind the code you are running: an existing database is **never** migrated automatically. See [Upgrade](/start/upgrade).

Every refusal and its fix is listed in [Troubleshooting](/operate/troubleshooting).

## Next steps

- [Add your first site](/guides/add-your-first-site)
- [Connect data sources](/guides/connect-data-sources)
- [Daily operations](/operate/daily-operations)
