---
title: Commands
description: Every command the repository offers, generated from package.json and each script's own header.
---

# Commands

Every command is a `pnpm` script in the repository's `package.json`. Run one from a checkout as `pnpm <name>`; pass a script's own options after `--`, for example `pnpm os:migrate -- --apply`. The procedures behind the commands that need one are in [`scripts/README.md`](https://github.com/notice-cx/NoticeOS/blob/main/scripts/README.md).

<!-- scripts-index:start -->

### Run the installation

| `pnpm …` | What it does | Runs |
|---|---|---|
| `os:status` | What runs, its health, the database's migrations, and whether main is ahead. | `scripts/stack-control.mjs status` |
| `os:logs` | Recent logs; `-- --follow`, `-- --lines N` or `-- <service>` narrow them. | `scripts/stack-control.mjs logs` |
| `os:start` | Start the stack: databases, then backup, then the app, each healthy first. | `scripts/stack-control.mjs start` |
| `os:stop` | Stop the app, then backup, then the databases. | `scripts/stack-control.mjs stop` |
| `os:restart` | Restart the stack in the same order, waiting for each layer's health. | `scripts/stack-control.mjs restart` |
| `os:update` | Build main into an image, show the plan, and apply it after you confirm. | `scripts/stack-deploy.mjs` |
| `os:rollback` | Move the app back to the previous image, after you confirm. | `scripts/stack-deploy.mjs --rollback` |
| `os:migrate` | What is applied and pending; `-- --apply` applies it after you type the database's name. | `scripts/os-migrate.mjs` |
| `os:dev` | Run the app from this checkout's live source; edits refresh it. | `scripts/stack-development.mjs` |
| `os:prod` | Run the app from the prepared image it ran before. | `scripts/stack-development.mjs --disable` |
| `os:backup` | Run one backup now, inside the app container. | `scripts/stack-control.mjs backup` |
| `os:run-job` | Fire the jobs scheduled on one cron expression now. | `scripts/stack-control.mjs run-job` |
| `os:capacity` | The store's size and growth per table; `-- --json` for the raw inventory. | `scripts/stack-control.mjs capacity` |

### Change the database

| `pnpm …` | What it does | Runs |
|---|---|---|
| `db:new-migration` | Write the next numbered migration file. | `scripts/postgres-migrate.mjs new` |
| `db:try-migrations` | Run the migrations on a throwaway development database. | `scripts/postgres-migrate.mjs` |
| `db:create-secrets` | Write the Postgres service's secret files, once, before the service's first start. | `scripts/postgres-secrets.mjs` |
| `db:seed-demo` | A new installation's store filled with invented history. | `scripts/db-seed.mjs` |
| `db:consumers` | Which source reads and writes each table. | `scripts/postgres-docs.mjs --consumers` |

### Settings and credentials

| `pnpm …` | What it does | Runs |
|---|---|---|
| `config:apply` | Apply a config changeset in the operator's terminal. | `scripts/config-apply.mjs` |
| `config:seed` | Load the config documents into the store. | `scripts/config-seed.mjs` |
| `config:export` | Write the store's config documents into this installation's folder. | `scripts/config-export.mjs` |
| `creds:check` | Prove each credential the OS is using with one cheap real probe per lane. | `scripts/creds-check.mjs` |
| `creds:rotate-key` | Re-seal every stored credential under a new CREDENTIALS_KEY. | `scripts/creds-rotate-key.mjs` |

### Signals and imports

| `pnpm …` | What it does | Runs |
|---|---|---|
| `signals:collect` | Collect one property's DataForSEO families now, instead of waiting for Monday — or its PostHog families, `--families 'posthog-*'`, with an optional fixed `--start/--end` window. | `scripts/signal-collect.mjs` |
| `signals:download` | Download the latest immutable raw-signal object for each selected report day. | `scripts/signal-dumps-download.mjs` |
| `signals:history` | The provider history as analytical files. | `scripts/signal-history.mjs` |
| `signals:analyze-history` | The analysis, read from the history files. | `scripts/signal-history-analyze.mjs` |
| `signals:refresh` | Keep every rostered property's panel dir current. | `scripts/signal-panels-refresh.mjs` |
| `signals:publish-insights` | Publish one compact executive snapshot into the store's presentation boundary. | `scripts/signal-insights-publish.mjs` |
| `signals:event-params` | GA4 event-parameter report for one asset: the manual companion to the daily GA4 archive lane, for event params the archive does not export. | `scripts/ga4-event-params.mjs` |
| `bing-ai:import` | Drop a Bing AI Performance export anywhere, run one command, and it becomes evidence. | `scripts/bing-ai-import.mjs` |
| `reclamation:import` | Load a campaign's static target CSV into the store's link-outreach targets, carrying whatever send state the campaign recorded elsewhere. | `scripts/reclamation-import.mjs` |
| `reclamation:open-targets` | A site's OPEN link-outreach targets, written to the file the reclamation-match rule reads (`pnpm signals:analyze-history -- --reclamation-targets <file>`, scripts/signal-insights.mjs). | `scripts/reclamation-open-targets.mjs` |
| `mediavine` | The Mediavine publisher-portal client in the terminal: status, sites and a revenue sync for one site. | `scripts/mediavine.mjs` |
| `pulse:relay` | Relay a pull-mode site's live pulse into the LOCAL ingest worker. | `scripts/pulse-relay.mjs` |

### Check the code and the screens

| `pnpm …` | What it does | Runs |
|---|---|---|
| `check:neutral` | Product code names no installation's own sites, accounts or clock. | `scripts/neutral-code-gate.mjs` |
| `audit:copy` | The UX text report: how much reading each Tower screen asks for. | `scripts/ux-gate.mjs` |
| `audit:flows` | The flow walker: walk every declared operator flow in a real browser and report what each one costs (actions, screens, page changes, explanatory words, empty steps, repeated checks, duplicate statuses, ungrouped lists). | `apps/tower/e2e/flow-gate.mjs` |
| `audit:viewport` | Capture the running Tower at each viewport through a local Firefox Marionette session, for a visual review. | `scripts/tower-viewport-audit.mjs` |
| `audit:wall-fit` | Does the Wall still fit the TV? | `scripts/wall-fit-check.mjs` |
| `audit:surfaces` | Does a desk surface still meet the design doc? | `scripts/surface-audit.mjs` |

### Tests

| `pnpm …` | What it does | Runs |
|---|---|---|
| `test` | Every workspace's unit tests. | `pnpm -r --if-present run test` |
| `test:scripts` | The root suite: every scripts/*.test.mjs. | `node --import ./scripts/script-tests-setup.mjs --test-global-setup=./scripts/scr…` |
| `test:task-store` | The task-store suite against a real Dolt server in Docker. | `node --import ./scripts/script-tests-setup.mjs --test-global-setup=./scripts/scr…` |
| `test:journeys` | The Tower's browser journeys, then the flow walker. | `pnpm --filter @noticeos/tower run typecheck:journeys && pnpm --filter @noticeos/…` |

### The repository

| `pnpm …` | What it does | Runs |
|---|---|---|
| `start` | NoticeOS on this machine, in one command. | `scripts/start.mjs` |
| `typecheck` | Typecheck every workspace. | `pnpm -r --if-present run typecheck` |
| `build` | Build every workspace. | `pnpm -r --if-present run build` |
| `prepare` | Install the repository's git hooks on `pnpm install`. | `scripts/install-git-hooks.mjs` |
| `generate` | Regenerate every committed file the code writes: compiled `.mts` pairs, the config docs and the command index. | `scripts/generate.mjs` |
| `project:prepare` | Prepare repository context only. | `scripts/project-context.mjs` |

Generated by `pnpm generate` from `package.json` and each script's header; `scripts/scripts-index.test.mjs` fails when this block is stale.

<!-- scripts-index:end -->
