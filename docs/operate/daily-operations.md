---
title: "Daily operations"
description: "Check, read, restart and update a running NoticeOS installation with the repository's own commands."
---

# Daily operations

This page gets you the handful of commands that keep an installation running, and what each health state means.

## The stack

NoticeOS runs as one Docker Compose stack of the app (`noticeos`, which holds the Tower, the data receiver and the scheduler), `postgres`, `dolt` and an optional `backup` worker. Every `pnpm os:*` command acts on the stack that `.local/stack.json` selects. Run them from the checkout. [Run with Docker](/start/run-with-docker) sets the stack up.

```sh
pnpm os:status                 # each service's state and health, migrations, the app's commit
pnpm os:logs -- --lines 200    # recent logs, secrets redacted
pnpm os:logs -- --follow       # follow the logs while you reproduce something
pnpm os:logs -- noticeos       # one service only
pnpm os:capacity               # store size and growth per table, read-only
pnpm os:restart                # restart in dependency order, waiting for health
pnpm os:update                 # move the app to main after a verified merge
```

`os:logs` shows 200 lines unless you pass `-- --lines N`. `os:restart` stops at the first step whose health does not return.

`pnpm os:stop` and `pnpm os:start` take the whole stack down and bring it back: the app first on the way down, the databases first on the way up. Use them deliberately; the daily commands are the ones in the block. The [command reference](/reference/commands) lists every command.

## What status tells you

`pnpm os:status` prints one line per service, then:

| Line | What it means |
| --- | --- |
| `noticeos: running, healthy` | The scheduler is running with a fresh heartbeat, the Tower and the data receiver answer, and a configured backup worker answers. |
| `noticeos: running, starting` | The app is still starting or the scheduler is still arming. |
| `noticeos: running, unhealthy` | One of those checks failed. Read the logs. |
| `database:` | Whether the database has every migration this checkout carries. If not, it says what to do. |
| `app source:` and `main:` | The commit the app runs and the commit `main` is on. |
| `update:` | `current`, `main differs; pnpm os:update moves the app to it`, or `unknown`. |

An answering port is never good enough. For what to do about anything other than `healthy`, see [Service states](/operate/troubleshooting#service-states).

## Development and production

In production the app runs a prepared image, so merging code never changes what runs. `pnpm os:update` builds `main` into an image, shows the plan and applies it after you type `update`. `pnpm os:rollback` goes back to the previous image.

On a development stack, `pnpm os:dev` runs the app from this checkout's live source, so edits appear at once. `pnpm os:prod` returns it to the image. Status says `mode: development` while it runs live source.

## In the Tower

- **System health** (`/health`) shows the service's own report: data freshness per site, connection states and, under **Background operations**, every scheduled job with its latest run. See [Scheduled jobs](/operate/scheduled-jobs).
- **Workflows** (`/workflows`) lists the operator automations and their history.
- **Integrations** (`/integrations`) shows each provider connection and its last test.

## A daily routine

1. Glance at the Wall or Home for anything flagged.
2. Open **System health** if a card shows a gap. A gap is unknown data, never a zero.
3. Run `pnpm os:status` if the Tower itself is slow or down.
4. After merging verified code, run `pnpm os:update`. Merging is not deploying.

::: tip Restart is not an upgrade
`os:restart` keeps the code that is running. Only `os:update` moves the app to new code, and it never applies a database migration. See [Upgrade](/start/upgrade).
:::

Related: [Troubleshooting](/operate/troubleshooting), [Backups and restore](/operate/backups-and-restore). The implementation details are on GitHub: https://github.com/notice-cx/NoticeOS/blob/main/scripts/README.md#the-runner-os-up.
