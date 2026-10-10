---
title: "Run with Docker"
description: "Run an already prepared NoticeOS installation as a Docker Compose stack, control it, and move it to new code from main."
---

# Run with Docker

This page gets you a running application container for an installation you have already prepared, and the commands that control it.

## Before you begin

The application container packages the Tower, the data receiver and the task client in one read-only image. It starts an **already prepared installation**: a Postgres database and a task database (Dolt) that you run as separate durable services on a shared Docker network. The container **never** creates or migrates either database. If you want a new installation on one machine without that preparation, use [Install from source](/start/install-from-source) instead.

You need:

- A prepared Postgres database, following the guide on GitHub: https://github.com/notice-cx/NoticeOS/blob/main/db/postgres/host/README.md
- A prepared task database (Dolt): https://github.com/notice-cx/NoticeOS/blob/main/db/dolt/host/README.md
- A Docker network shared with both, and a Docker engine that can build for `linux/arm64` or `linux/amd64`
- A repository checkout to build the image from and run the commands in

## Build the image

1. In a terminal, in the checkout, create a build context from the repository's public source allowlist. The destination must be new and outside the checkout:

   ```sh
   node scripts/container-context.mjs --destination /absolute/new/context
   ```

2. Build that context, never the checkout:

   ```sh
   docker build --platform linux/arm64 --file /absolute/new/context/deploy/compose/Dockerfile --tag noticeos-local:review /absolute/new/context
   ```

The Dockerfile accepts `linux/arm64` and `linux/amd64`. It pins Node 24.21.0, pnpm 12.8.1, the task tool 1.3.1 and the PostgreSQL 18 client.

## Declare the installation

1. In your env file, set the values the Compose service in `deploy/compose/compose.yaml` needs:

   | Variable | Value |
   | --- | --- |
   | `NOTICEOS_APP_IMAGE` | The image tag or immutable image reference you built |
   | `NOTICEOS_STATE_DIR` | Absolute path of the prepared installation directory |
   | `NOTICEOS_SPOKES_DIR` | Absolute path of the directory holding the linked task repositories |
   | `NOTICEOS_NETWORK` | The existing network shared with Postgres and Dolt |
   | `NOTICEOS_TOWER_PORT` | A free host port; it always binds to `127.0.0.1` |
   | `NOTICEOS_APP_UID`, `NOTICEOS_APP_GID` | Owner of the mounted private files; default `1000:1000` |
   | `TOWER_ALLOWED_HOSTS` | Extra hostnames the Tower may be opened on, separated by commas or spaces |

2. In the state directory, check that both mounts exist before you start; Compose never creates an empty substitute. Inside the container the state directory is `/state`. Bootstrap secrets live at `/state/workers/ingest/.dev.secrets.json` and the task client declaration at `/state/task-client.json`.

Only the Tower port is published. Postgres and Dolt keep no host ports. Provider credentials are still connected in the Tower, not in files.

::: warning No login
Standalone has no user login. The port binds to loopback for that reason. If you override the binding for a trusted LAN, every client on it can read and change your data. Keep the hostname allowlist; never allow every host.
:::

## Control the stack

1. In the checkout, declare the installation once in `.local/stack.json`, listing every Compose file the installation uses, in order:

   ```json
   {
     "project": "your-project",
     "files": ["/absolute/installation/compose.yaml"],
     "envFile": "/absolute/installation/compose.env",
     "dockerHost": "unix:///absolute/docker.sock"
   }
   ```

2. From the checkout, run the four commands:

   ```sh
   pnpm stack:status
   pnpm stack:start
   pnpm stack:stop
   pnpm stack:restart
   ```

Add `--config /absolute/stack.json` to use another selector file. The commands expect existing `noticeos`, `postgres` and `dolt` containers, plus `backup` when present. They never create containers, pull images, apply migrations or remove volumes.

Start brings up the databases, then the backup worker, then the app. Stop reverses that order. Restart waits for health at each step and stops at the first failure.

## Deploy changes from main

Committing to `main` changes source; it changes nothing running. `stack:restart` restarts the same image. To run new code:

1. In the checkout, check what runs and whether `main` differs:

   ```sh
   pnpm stack:status
   ```

2. Prepare a new image and a plan from a clean checkout at `main`. Services keep running:

   ```sh
   pnpm stack:deploy
   ```

3. Review the printed plan, then apply it:

   ```sh
   pnpm stack:deploy -- --apply /absolute/stack-deploy/PLAN_SHA256.json
   ```

Apply recreates only the `noticeos` container and waits up to 90 seconds for health. It applies no migration. If health does not return, it restores the previous image by itself. The Wall reloads on its next request; desk pages show an update prompt so drafts stay open.

To go back to the recorded previous image, prepare a rollback plan with `pnpm stack:deploy -- --rollback` and apply it the same way. An image built before revision labels existed needs `--baseline-commit COMMIT` on the first update.

For automatic startup after a reboot, set `restart: unless-stopped` on each service and enable your Docker engine's startup setting.

## Follow a checkout during development

For a local installation where you want edits to appear at once:

1. In the checkout, run the development mode:

   ```sh
   pnpm stack:dev
   ```

2. To return to the prepared image, run:

   ```sh
   pnpm stack:dev --disable
   ```

The app mounts the checkout read-only and refreshes the Tower live. The Wall caption shows **DEV**. Node runner changes need one more `pnpm stack:dev`; UI and Worker edits refresh on save. `stack:deploy` refuses while development mode is on.

## Verify

- `pnpm stack:status` prints each service's state and health, the running source, and ends with `current` when `main` and the stack agree.
- The Tower opens on `127.0.0.1` at the port you declared in `NOTICEOS_TOWER_PORT`.
- After an apply, health returns within 90 seconds and the status names the new image.

## If it didn't work

- `stack:*` says the selector is invalid or a service is unexpected: `.local/stack.json` must name exactly `project`, `files`, `envFile` and `dockerHost`, with absolute paths and a `unix://` socket, and the stack must contain `noticeos`, `postgres` and `dolt`, and at most `backup` besides.
- `stack:deploy` refuses changed source, declarations or image labels: the stack changed between preparing and applying the plan. Run `pnpm stack:status`, then prepare a new plan.
- `stack:dev` refuses to start: a changed lockfile refuses startup rather than running mismatched dependencies. Run `pnpm install --frozen-lockfile` and start again.

More symptoms are in [Troubleshooting](/operate/troubleshooting). The full guide, including the backup worker and running report scripts inside the container, is on GitHub: https://github.com/notice-cx/NoticeOS/blob/main/deploy/compose/README.md.

## Next steps

- [Daily operations](/operate/daily-operations)
- [Backups and restore](/operate/backups-and-restore)
- [Upgrade](/start/upgrade)
