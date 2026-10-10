---
title: "Daily operations"
description: "Check, read, diagnose, restart and deploy a running NoticeOS installation with the repository's own commands."
---

# Daily operations

This page gets you the handful of commands that keep an installation running, and what each health state means.

## Three ways to run, three sets of commands

| How you run NoticeOS | Commands | Where it runs |
| --- | --- | --- |
| `pnpm start` installation | the terminal it runs in | Tower on 4747 by default |
| macOS login service | `pnpm os:*` | Tower on 5173 |
| Docker Compose stack | `pnpm stack:*` | the port you declared |

`pnpm start` creates a separate new installation for a fresh clone; its terminal is its control surface, and Ctrl-C stops it. The other two sets are for an installation you set up to run on its own.

## The macOS service

The service runs a **runtime copy** of the code under `.local/runtime/`, so merging code never changes what runs. Run every command from the checkout.

```sh
pnpm os:status                 # one line of state; add -- --json for machines
pnpm os:logs -- --lines 200    # recent runner and app output, secrets redacted
pnpm os:logs -- --follow       # follow the log while you reproduce something
pnpm os:doctor                 # status + recent log + job records + store capacity
pnpm os:capacity               # store size and growth per table, read-only
pnpm os:restart                # restart the managed service and wait for health
pnpm os:deploy                 # move the live service to main after a verified merge
```

`os:logs` accepts 1 to 2000 lines. `os:doctor` is bounded: 200 log lines, 100 job records, all redacted. `os:restart` waits up to 45 seconds and prints recent output if health does not return.

`pnpm os:stop` and `pnpm os:start` take the service down for maintenance and bring it back; that is the pair you use around a database migration. `pnpm os:install` and `pnpm os:uninstall` change the login service itself. Use those four deliberately; the daily verbs are the ones in the block.

### Health states

`pnpm os:status` reports one of five states.

| State | What it means |
| --- | --- |
| `healthy` | The service is loaded, the heartbeat is fresh, the Tower and the data receiver answer, and both databases pass a readiness read. |
| `starting` | The service is running and the runtime or scheduler is not ready yet. |
| `stale` | The endpoints answer, but the supervisor's heartbeat is more than 90 seconds old. |
| `unhealthy` | Something answers without supervision, a database readiness read failed, or the service exited. The reason is printed. |
| `stopped` | No service is loaded and nothing answers. |

An answering process without a supervisor is `unhealthy`, never good enough. For what to do about any state other than `healthy`, see [Service states](/operate/troubleshooting#service-states).

The status also prints which commit runs and whether `main` is ahead. If it says the service runs from the checkout folder itself, run `pnpm os:deploy` and then `pnpm os:install` once to move it to a runtime copy.

## The Docker Compose stack

Declare the installation once in `.local/stack.json`, then:

```sh
pnpm stack:status     # each service's state and health, the running source, and whether main differs
pnpm stack:start      # databases, then backup worker, then app
pnpm stack:stop       # the reverse order
pnpm stack:restart    # restart in order, waiting for health at each step
pnpm stack:deploy     # prepare an image and a plan from main; apply with -- --apply <plan>
```

`stack:status` ends with one of `current`, `main differs; prepare stack:deploy` or `unknown`. A failed step stops the sequence; inspect status before retrying. None of these commands creates containers, pulls images, applies migrations or removes volumes.

Logs for a stack are Docker's: `docker compose --project-name your-project logs noticeos`.

## In the Tower

- **System health** (`/health`) shows the service's own report: data freshness per site, connection states and, under **Background operations**, every scheduled job with its latest run. See [Scheduled jobs](/operate/scheduled-jobs).
- **Workflows** (`/workflows`) lists the operator automations and their history.
- **Integrations** (`/integrations`) shows each provider connection and its last test.

## A daily routine

1. Glance at the Wall or Home for anything flagged.
2. Open **System health** if a card shows a gap. A gap is unknown data, never a zero.
3. Run `pnpm os:status` or `pnpm stack:status` if the Tower itself is slow or down.
4. After merging verified code, deploy with `pnpm os:deploy` or `pnpm stack:deploy`. Merging is not deploying.

::: tip Restart is not an upgrade
`os:restart` and `stack:restart` keep the code that is running. Only the deploy commands move an installation to new code, and neither ever applies a database migration. See [Upgrade](/start/upgrade).
:::

Related: [Troubleshooting](/operate/troubleshooting), [Backups and restore](/operate/backups-and-restore). The implementation details are on GitHub: https://github.com/notice-cx/NoticeOS/blob/main/scripts/README.md#the-local-runner-os-up.
