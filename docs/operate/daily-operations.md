---
title: "Daily operations"
description: "Check, read, restart and update a running NoticeOS installation with its own commands, from a checkout or through its folder's launcher."
---

# Daily operations

This page gets you the handful of commands that keep an installation running, and what each health state means.

## The stack

An installation runs as a **stack**: a few Docker containers that start and stop together. The app, `noticeos`, serves the Tower, receives reports and runs the scheduled jobs; `postgres` holds the store, your data; `dolt` holds the task database; and an optional `backup` worker takes the nightly backup. [Run with Docker](/start/run-with-docker) describes each one.

Every `pnpm os:*` command acts on the stack that `.local/stack.json` selects; `pnpm os:setup` writes it. Run them from the checkout.

```sh
pnpm os:status                 # each service's state and health, migrations, the app's commit
pnpm os:logs -- --lines 200    # recent logs, secrets redacted
pnpm os:logs -- --follow       # follow the logs while you reproduce something
pnpm os:logs -- noticeos       # one service only
pnpm os:capacity               # store size and growth per table, read-only
pnpm os:restart                # restart in dependency order, waiting for health
pnpm os:apply                  # apply your edits to installation.env, after you confirm
pnpm os:update                 # move the app to main after a verified merge
```

An installation [set up with Docker alone](/start/install-with-docker) has no checkout. Run the same commands through its folder's launcher, with the same options and no `--`:

```sh
~/noticeos/noticeos status
~/noticeos/noticeos logs --lines 200
~/noticeos/noticeos restart
~/noticeos/noticeos apply
~/noticeos/noticeos update
```

`os:logs` shows 200 lines unless you pass `-- --lines N`. `os:restart` stops at the first step whose health does not return. `os:apply` recreates only the services your edit changes; see [Change a setting](/start/run-with-docker#change-a-setting).

`pnpm os:stop` and `pnpm os:start` take the whole stack down and bring it back: the app first on the way down, the databases first on the way up. Use them deliberately; the daily commands are the ones above. The [command reference](/reference/commands) lists every command.

## What status tells you

`pnpm os:status` prints the installation folder, one line per service, then:

| Line | What it means |
| --- | --- |
| `noticeos: running, healthy` | The scheduler is running with a fresh heartbeat, the Tower and the data receiver answer, and a configured backup worker answers. |
| `noticeos: running, starting` | The app is still starting or the scheduler is still arming. |
| `noticeos: running, unhealthy` | One of those checks failed. Read the logs. |
| `database:` | `has every migration this code carries`, or how many migrations it is behind and what to do. |
| `settings:` | Shown only when a service does not run as `installation.env` declares. `pnpm os:apply` shows the change. |
| `app source:` and `main:` | The commit the app runs and the commit `main` is on. Without a checkout, `main:` is the newest published commit, read from the image registry. |
| `update:` | `current`, `main differs; pnpm os:update moves the app to it`, or `unknown`. Without a checkout, the launcher's `update` is named. |

An answering port is never good enough. For what to do about anything other than `healthy`, see [Service states](/operate/troubleshooting#service-states).

## Development and production

In production the app runs a prepared image, so merging code never changes what runs. `pnpm os:update` fetches the image CI published for `main`, or builds it here when none is published yet, shows the plan and applies it after you type `update`. `pnpm os:rollback` goes back to the previous image.

Without a checkout, `~/noticeos/noticeos update` moves the installation to main's newest published version, and `rollback` returns to the one before. See [Install with Docker](/start/install-with-docker#update-and-roll-back).

On a development stack, `pnpm os:dev` runs the app from this checkout's live source, so edits appear at once. `pnpm os:prod` returns it to the image. Status says `mode: development` while it runs live source.

## In the Tower

- **System health** (`/health`) shows the service's own report: data freshness per site, connection states and, under **Background operations**, every scheduled job with its latest run. See [Scheduled jobs](/operate/scheduled-jobs).
- **Workflows** (`/workflows`) lists the operator automations and their history.
- **Integrations** (`/integrations`) shows each provider connection and its last test.
- **Settings** > **Installation** (`/settings/installation`) shows the folder, the ports, the version, whether a newer one is published, the last backup and the status command to copy. It is read-only; the commands change the installation.

## A daily routine

1. Glance at the Wall or Home for anything flagged.
2. Open **System health** if a card shows a gap. A gap is unknown data, never a zero.
3. Run `pnpm os:status` if the Tower itself is slow or down.
4. After merging verified code, run `pnpm os:update`. Merging is not deploying. Without a checkout, run `~/noticeos/noticeos update` when a newer version is published.

::: tip Restart is not an upgrade
`os:restart` keeps the code and settings that are running. Only `os:update` moves the app to new code, and it never applies a database migration. Only `os:apply` applies an edit to `installation.env`. See [Upgrade](/start/upgrade).
:::

Related: [Troubleshooting](/operate/troubleshooting), [Backups and restore](/operate/backups-and-restore). The implementation details are on GitHub: https://github.com/notice-cx/NoticeOS/blob/main/scripts/README.md#the-runner-os-up.
