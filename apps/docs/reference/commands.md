---
title: Commands
description: Every command the repository offers, generated from package.json and each script's own header.
---

# Commands

Every command is a `pnpm` script in the repository's `package.json`. Run one from a checkout as `pnpm <name>`; pass a script's own options after `--`, for example `pnpm os:logs -- --lines 200`. The procedures behind the commands that need one are in [`scripts/README.md`](https://github.com/notice-cx/NoticeOS/blob/main/scripts/README.md).

<!-- scripts-index:start -->

| `pnpm …` | Runs | The script's own first line |
|---|---|---|
| `start` | `scripts/start.mjs` | `pnpm start`: NoticeOS on this machine, in one command |
| `typecheck` | `pnpm -r --if-present run typecheck` | — |
| `test` | `pnpm -r --if-present run test` | — |
| `build` | `pnpm -r --if-present run build` | — |
| `prepare` | `scripts/install-git-hooks.mjs` | INSTALL THE REPOSITORY'S GIT HOOKS ON `pnpm install`. |
| `ux:gate` | `scripts/ux-gate.mjs` | The UX text report: how much reading each Tower screen asks for. |
| `ux:flows` | `apps/tower/e2e/flow-gate.mjs` | THE FLOW WALKER: walk every declared operator flow in a real browser and |
| `neutral:gate` | `scripts/neutral-code-gate.mjs` | PRODUCT CODE NAMES NO INSTALLATION'S OWN SITES OR CLOCK |
| `os:up` | `scripts/os-up.mjs` | the NoticeOS LOCAL RUNNER / supervisor. |
| `os:status` | `scripts/os-control.mjs status` | Stable operator/agent control surface for the local NoticeOS service. |
| `os:logs` | `scripts/os-control.mjs logs` | Stable operator/agent control surface for the local NoticeOS service. |
| `os:restart` | `scripts/os-control.mjs restart` | Stable operator/agent control surface for the local NoticeOS service. |
| `os:deploy` | `scripts/os-control.mjs deploy` | Stable operator/agent control surface for the local NoticeOS service. |
| `os:doctor` | `scripts/os-control.mjs doctor` | Stable operator/agent control surface for the local NoticeOS service. |
| `os:capacity` | `scripts/os-control.mjs capacity` | Stable operator/agent control surface for the local NoticeOS service. |
| `os:stop` | `scripts/os-control.mjs stop` | Stable operator/agent control surface for the local NoticeOS service. |
| `os:start` | `scripts/os-control.mjs start` | Stable operator/agent control surface for the local NoticeOS service. |
| `os:install` | `scripts/os-control.mjs install` | Stable operator/agent control surface for the local NoticeOS service. |
| `os:uninstall` | `scripts/os-control.mjs uninstall` | Stable operator/agent control surface for the local NoticeOS service. |
| `os:backup` | `scripts/os-up.mjs --backup` | the NoticeOS LOCAL RUNNER / supervisor. |
| `os:cron` | `scripts/os-up.mjs --tick` | the NoticeOS LOCAL RUNNER / supervisor. |
| `dev:secrets:migrate` | `scripts/dev-secrets.mjs migrate` | readable local secret source → Wrangler's dotenv input. |
| `dev:secrets:sync` | `scripts/dev-secrets.mjs sync` | readable local secret source → Wrangler's dotenv input. |
| `dev:secrets:import` | `scripts/dev-secrets.mjs import` | readable local secret source → Wrangler's dotenv input. |
| `pulse:relay` | `scripts/pulse-relay.mjs` | relay a pull-mode site's live pulse into the LOCAL ingest worker. |
| `tower:viewport-audit` | `scripts/tower-viewport-audit.mjs` | Capture the running Tower at each viewport through a local Firefox Marionette session, for a visual review. |
| `wall:fit` | `scripts/wall-fit-check.mjs` | Does the Wall still FIT the TV? Measures the LIVE Tower's /wall at the DietPi |
| `surface:audit` | `scripts/surface-audit.mjs` | Does a desk surface still meet doc 14? Measures the LIVE Tower's routes at the |
| `config:apply` | `scripts/config-apply.mjs` | apply a config CHANGESET in the operator's terminal. |
| `config:seed` | `scripts/config-seed.mjs` | load the config documents into the store (epic `ro-syok`, |
| `config:export` | `scripts/config-export.mjs` | write the store's config documents into this |
| `creds:check` | `scripts/creds-check.mjs` | the CREDENTIAL VERIFICATION RAILS for the accounts pass. |
| `mediavine` | `scripts/mediavine.mjs` | The Mediavine publisher-portal client in the terminal: status, sites and a revenue sync for one site. |
| `creds:rotate-key` | `scripts/creds-rotate-key.mjs` | re-seal every stored credential under a new |
| `signals:collect` | `scripts/signal-collect.mjs` | Collect one property's DataForSEO families NOW, instead of waiting for Monday — |
| `signals:download` | `scripts/signal-dumps-download.mjs` | Download the latest immutable raw-signal object for each selected report day. |
| `signals:history` | `scripts/signal-history.mjs` | THE PROVIDER HISTORY AS ANALYTICAL FILES (bead ro-ujb9.67.2, decision D25). |
| `signals:analyze-history` | `scripts/signal-history-analyze.mjs` | THE ANALYSIS, READ FROM THE HISTORY FILES (bead ro-ujb9.67.3, decision D25). |
| `signals:refresh` | `scripts/signal-panels-refresh.mjs` | keep every rostered property's panel dir current. |
| `signals:publish-insights` | `scripts/signal-insights-publish.mjs` | Publish one compact executive snapshot into the store's presentation |
| `signals:event-params` | `scripts/ga4-event-params.mjs` | GA4 event-parameter report for one asset — the manual companion to the daily |
| `bing-ai:import` | `scripts/bing-ai-import.mjs` | drop a Bing AI Performance export anywhere, run one |
| `reclamation:import` | `scripts/reclamation-import.mjs` | Load a campaign's static target CSV into the store's link-outreach targets, |
| `reclamation:open-targets` | `scripts/reclamation-open-targets.mjs` | A site's OPEN link-outreach targets, written to the file the |
| `test:scripts` | `node --import ./scripts/script-tests-setup.mjs --test-global-setup=./scripts/scr…` | — |
| `test:task-store` | `node --import ./scripts/script-tests-setup.mjs --test-global-setup=./scripts/scr…` | — |
| `test:journeys` | `pnpm --filter @noticeos/tower run typecheck:journeys && pnpm --filter @noticeos/…` | — |
| `postgres:dev` | `scripts/postgres-migrate.mjs` | The Postgres migration runner, development profile only (bead ro-ujb9.76.3). |
| `postgres:migrate` | `scripts/postgres-apply.mjs` | THE POSTGRES MIGRATIONS, APPLIED TO AN INSTALLATION'S OWN DATABASE |
| `postgres:consumers` | `scripts/postgres-docs.mjs --consumers` | Generated Postgres model docs (ro-ujb9.76.81): the revision-rule matrix |
| `postgres:secrets` | `scripts/postgres-secrets.mjs` | THE POSTGRES SERVICE'S SECRET FILES (bead ro-ujb9.76.12): `pnpm |
| `seed:local` | `scripts/db-seed.mjs` | `pnpm seed:local`: a new installation's store filled with |
| `config:generate` | `scripts/generate-config-contract.mjs` | Compile every checked TypeScript source that ships as a committed `.mjs` + `.d.mts` pair; `--check` fails when a pair is stale. |
| `config:check` | `scripts/generate-config-contract.mjs --check` | Compile every checked TypeScript source that ships as a committed `.mjs` + `.d.mts` pair; `--check` fails when a pair is stale. |
| `scripts:index` | `scripts/scripts-index.mjs` | THE COMMAND INDEX, GENERATED FROM package.json AND EACH SCRIPT'S OWN HEADER. |
| `config:docs` | `scripts/config-docs.mjs` | THE CONFIG REGISTERS' DOCUMENTATION, GENERATED FROM THEIR DECLARATION. |
| `project:prepare` | `scripts/project-context.mjs` | Prepare repository context only. Task provisioning and provider access have |
| `stack:status` | `scripts/stack-control.mjs status` | Control an existing Docker Compose installation: status, start, stop and restart of its app only. |
| `stack:start` | `scripts/stack-control.mjs start` | Control an existing Docker Compose installation: status, start, stop and restart of its app only. |
| `stack:stop` | `scripts/stack-control.mjs stop` | Control an existing Docker Compose installation: status, start, stop and restart of its app only. |
| `stack:restart` | `scripts/stack-control.mjs restart` | Control an existing Docker Compose installation: status, start, stop and restart of its app only. |
| `stack:deploy` | `scripts/stack-deploy.mjs` | Application-only Docker updates: prepare a sealed image/plan, then apply it. |
| `stack:dev` | `scripts/stack-development.mjs` | Opt-in live source for an existing local stack. Stores and image dependencies stay put. |

Generated by `pnpm scripts:index -- --write` from `package.json` and each script's header; `scripts/scripts-index.test.mjs` fails when this block is stale.

<!-- scripts-index:end -->
