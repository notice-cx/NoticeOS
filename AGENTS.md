---
reviewed: 2026-10-10
---

# AGENTS.md — NoticeOS repo context pack

The facts, conventions and standing invariants an agent needs before touching
the code. It records what is true and what is decided; it does not decide
design for the person building the next screen. Where this file and the code
disagree, the code is the fact and this file is amended.

## What this repo is

NoticeOS is a closed loop around a ledger — Sense → Attribute → Decide → Act →
Learn — for improving the return on a portfolio of websites and software
products, and reduces operator oversight for each class of change only as far
as that class's record of outcomes allows. It observes each asset (reports,
search and traffic signals, revenue and cost), attributes outcomes without
overstating them (holdouts and cohorts where possible, "unmeasured" where not,
never an invented lift), ranks what to build next with a dollar-denominated
scoring policy, acts through build → independent verify → ship under a
graduated autonomy ladder, and compares its own predictions with outcomes.
This repo is the OS and its Control Tower; it is asset #0 and sends the same
report it requires from every asset.

## Monorepo layout

| Path | Owns |
|---|---|
| `db/postgres/`, `packages/postgres/` | the Postgres operational store and the one helper the running OS uses to reach it |
| `packages/contract/` | the shared report envelope, the config document schemas and the volume-aware alert rules (zod) |
| `packages/mediavine/` | the Mediavine publisher-portal client the revenue collector uses |
| `workers/ingest/` | the ingest Worker: the report endpoint, the collectors, the scheduled lanes, the store's write routes |
| `apps/tower/` | the Control Tower (Vite + React + TS + Tailwind v4 + shadcn): the operator pages, the TV Wall and its Worker |
| `docs/` | the documentation site (VitePress): the guides, screens and operations pages for the operator, and the numbered design library beside them |
| `config/` | the product's defaults: every config document a fresh clone seeds, generic (no assets, no task projects, UTC), each with a README beside it. Runtime settings live in the store after seeding. |
| `installation/` | this installation's own files, found through `scripts/installation.mts` (`NOTICEOS_INSTALLATION_DIR`, default `./installation`): exported config documents, the applied-changeset archive, host-only settings. The public release leaves it out. |

Workspaces glob from `apps/*`, `workers/*`, `packages/*`, plus `docs`. The recursive
`typecheck` / `test` / `build` scripts must stay green with zero workspaces
present.

## Conventions

- **TypeScript strict.** Every workspace extends `tsconfig.base.json` (strict,
  ES2023, ESM, `moduleResolution: bundler`). No new `any`; add DOM/jsx/worker
  libs in the workspace tsconfig, never by loosening the base.
- **ESM only.** Root is `"type": "module"`; no CommonJS.
- **Credentials are connected in the product, not written into a file.** A
  provider secret belongs on the Tower's `/integrations` page and lives
  encrypted in the store; an env binding is a legacy fallback for existing
  installs, never what a doc or a first-run path points at first. The few
  bootstrap secrets stay in the environment because they start the OS; their
  list is written once, in
  [doc 06](docs/06-operations.md#bootstrap-secrets-vs-integration-credentials).
  Secrets never appear in a log line, a response body or a test fixture.
- **Tests: vitest in the workspaces, `node --test` for `scripts/*.test.mjs`.**
  Executable tests and the required CI check determine test status. A scenario
  counts only when it is a test; describing it in a comment does not count.
  Generated reports, logs, screenshots, hashes and verification writeups are
  not committed. Passing tests need no documentation update or separate receipt.
- **Comments say what the code cannot.** A non-obvious why, an invariant, a
  trap, or the one place a fact lives, in a line or two. No decision numbers,
  task ids, dates of past changes, attributions, histories of what the code
  used to do, or alternatives considered. Decisions become code, features and
  tests; there is no decision register.
- **Write documentation literally.** In `docs/`, every README and this file,
  state what a thing shows or does: a page, chart, command, job or rule shows,
  lists, records, checks, runs or stops. It does not answer, say, tell, ask,
  know, think, want, see or refuse, and nothing "tells a story"; only people
  and agents speak, decide or know. Use no metaphors, images, slogans or
  riddles: name the colour or size instead of "quiet" or "calm", the Tower's
  pages instead of "the desk", the rule instead of an aphorism, and the plain
  word instead of internal vocabulary (lane, bead, pulse, knob) outside an
  identifier in backticks. Rewrite any sentence a reader has to decode as the
  direct statement. Quote the labels the product shows exactly; changing one
  is a product-copy change. The brand line "Your startup. In clear view." is
  the one exception.
- **Derive statuses from observed facts.** A state is manually assigned only
  when it records a human decision, such as a launch hold, retirement or
  automation permission. Collection, setup progress and health are computed;
  an old stored stage never substitutes for evidence.
- **SQL is snake_case.** Migrations are numbered and append-only; the store
  keeps every row of history and is never truncated.
- **Design is one doc, written as taste** ([doc 14](docs/14-design.md)): the
  stack as it is in the repo, the token families and what each colour means,
  the principles, the surfaces as built, the Wall, the operator flows and the
  lexicon. Colour and size literals live in the CSS and components use tokens;
  `tabular-nums` is baked into the stat components. Check
  `apps/tower/src/components/registry.ts` and the `/dev/kitchen-sink` gallery
  before adding a component, prefer reuse, and replace a component when a
  better one earns it. Short copy and short flows are the goal because the
  operator reads at a glance; whether a sentence or a step earns its place is
  the judgement of whoever builds the screen. Two reports inform it and fail
  nothing: `pnpm audit:copy` lists the Tower's long visible strings and
  `pnpm audit:flows` walks every declared flow in a browser and reports what it
  costs. The jargon ban is enforced: `scripts/ui-lexicon.test.mjs` and
  `scripts/ui-noun.test.mjs` fail on a system word on a screen.
- **Every change works for any installation, not only this one.**
  Product code names no installation's own assets, accounts, paths or time
  zone; those come from the store, with generic defaults (fixtures use
  `example.com`). The neutral-code gate (`pnpm check:neutral`) stops an asset id,
  domain or time zone in product code at commit (`.githooks/pre-commit`,
  installed by `pnpm install`) and in CI. Anything an operator sets is set in
  the Tower, not in a file. Host-only mechanisms (files on the installation's
  machine) sit behind an adapter a cloud installation can replace. One
  derivation per fact, names a newcomer understands, the smallest change that
  leaves the design clearer.
- **Documentation that restates code is generated from it.** The command index
  in `scripts/README.md` and `docs/reference/commands.md` comes from
  `package.json` and each script's header; the "what the Tower may edit here"
  blocks in `config/*.README.md` and `docs/reference/configuration.md` come
  from `scripts/config-registers.mts`. `pnpm generate` rewrites both, with the
  compiled `.mts` pairs, and `pnpm generate -- --check` fails when one is
  stale. The Postgres README's revision matrix comes from
  `db/postgres/model.json`. A test fails when a generated block is stale. Prose beside a block explains why
  the block exists and does not repeat what it contains.
- **Flags carry severity and kind as separate fields** (doc 02):
  `info|warn|error` × `anomaly|opportunity|milestone`; milestone kind is always
  info severity. Central business-count rules require eight complete aligned
  historical periods and a decline outside a variability- and trend-aware
  future-observation interval, with an additional count-noise filter. Test only
  complete windows through `max_window_days`; missing counts stay unknown and
  true zeros stay zero. Persist model-versioned evidence. Technical outage and
  freshness checks retain their separate rules (doc 02).
- **Completion is evidence, not prose.** Every claim carries a machine-checkable
  pointer: a commit hash, a gate command, an artifact path, a URL. Anything
  deferred is a task in the hub with an owner and a trigger. Deciding not to
  do something is allowed; leaving that decision unrecorded is not.
- **Surfaces under an open measurement window stay unchanged.** A ship that
  opens one records the surfaces, the change, the dates and the readback task
  in the task hub, and nobody refactors those surfaces until the reading is in
  (doc 03). The task hub is where these are recorded; there is no separate
  file.

## Hard invariants

Never changed automatically. Operator-only, forever, never promotable on the
autonomy ladder: auth, billing, security headers, DB migrations (except the
fresh-install setup below), consent surfaces, analytics and tracking pipelines,
holdout assignments, guardrail thresholds. The last three decide how outcomes
are measured: an agent allowed to change how its own results are measured
would eventually change them.

Also standing: publishing-velocity caps and per-surface churn caps (doc 04);
automated asset execution uses the one fine-grained GitHub App, never a PAT;
agent PR publication follows the Git policy below. Assets never query external
analytics about themselves, they push to central. Automated
asset execution requires a one-action kill switch and a proven drill before
enablement (doc 06); agent execution is manual in this release and its pause
check is shown as unavailable.

**Fresh-install exception.** `pnpm os:setup` may apply the committed frozen
Postgres schema and bootstrap one workspace, only for a provably new, empty
installation: a new folder, a Compose project with no containers, and data
volumes it creates itself. Existing installations, live data and production
stay operator-only.

**Hosted tenancy.** Local implementation and disposable synthetic tests of
hosted authentication, tenant isolation and the public demo are authorised
under [doc 23](docs/23-configuration-ownership.md). Customer workspaces are
invitation-only; demo visitors read shared synthetic data while a separate
simulator supplies activity. Existing-store migrations, live auth activation,
public hosting and remote production changes still need concrete operator
approval. Keep the standalone path and rollback compatibility; no billing
scope is inferred.

## The CI bar

CI (`.github/workflows/ci.yml`) runs one of two lanes, chosen by
`scripts/ci-scope.mjs`; every job starts with `pnpm install --frozen-lockfile`.
A PR runs the PR lane: the Tower's typecheck and unit tests; the other
workspaces'; `pnpm test:scripts`; and `pnpm -r build`, the journey harness and
the browser journeys tagged `@pull-request`, on desktop and phone; the Tower's
unit tests and the root suite each split across two runners. The merge
queue, a push to `main`, the nightly run and a run started by hand
(`gh workflow run ci.yml --ref <branch>`) run the full lane: the same suites,
every browser journey split test by test across three shards, the journey
harness then the UX flow walker (a report; it fails only when a flow cannot be
walked), and `pnpm test:task-store` against a real Dolt server in Docker; a
push to `main` whose commit already passed the full lane in the merge queue
runs no job again. Each
job installs only what its suites start: PostgreSQL 18, Chromium in the
browser jobs, the pinned task and Dolt tools in the task-store job. In the
PR lane a job runs only when a changed file reaches its code: a folder it
tests, or a `scripts/` module it imports or names; the task store also runs
there when a change reaches its own code. Dependency, CI, `db/` and unknown
paths run every PR-lane job. The `build` job is the required verdict in both
lanes; it fails when a job the scope needed did not pass. Until the merge
queue is on for `main`, a change
that breaks only a full-lane test shows on `main` after it merges; start the
full lane by hand on a PR that changes what those tests cover. A newer push to
a PR cancels that PR's running CI; no other run is cancelled. A PR that
changes only documentation no runtime suite reads (`docs/` and root Markdown)
runs the root suite alone, and the `docs` workflow builds the asset whenever
`docs/` changes; a push to `main` publishes it. Once CI passes on a push to
`main`, the `Release image` workflow publishes that commit as the app image
`os:setup` and `os:update` fetch (`RELEASE_REPOSITORY` in
`scripts/published-image.mjs`).

The full gates run in CI; they are not a mandatory local pre-merge run. Locally,
test the changed logic and the affected critical paths with the smallest
relevant typecheck, build or browser check; reuse passing checks when their
inputs are unchanged. Do not skip the root
suite: recursive pnpm commands visit workspaces, not `scripts/*.test.mjs`,
where the runner, migration, collector, backup and task-hub contracts are
tested. Passing CI does not make a change safe: CI checks that the code builds
and its tests pass, while the failures that cost money are bad outcomes after
shipping, which only the post-ship outcome checks catch.

## Temporary test storage

- Before a large copy, dependency or browser preparation, or a heavy test
  phase, check free space; refuse unless at least 8 GiB stays free.
- Sequential verifiers reuse one source copy bound to an exact commit, one
  lock-matched dependency set and one browser binary per version, each with
  its own `HOME`, XDG directories, `TMPDIR` and fixture ports. Prepare an
  offline install with a lockfile-based `pnpm fetch` into its own virtual store
  before replacing working modules; use `--ignore-scripts --no-runtime`.
- Record owned temporary paths, child processes, servers and fixture ids as
  they are acquired; await their closure in `finally`; remove only what is
  proven inactive and owned. No blanket home, temp or browser cleanup.
- Use the testing browser (the installed Playwright Chromium), never a user's
  Chrome or its profile.
- Postgres will not start as root (`initdb: cannot be run as root`); as root
  every database test fails or skips as "no Postgres in this run", which is
  evidence of nothing. Where the shell is root, run the suites as `nobody`
  (`runuser -u nobody -- env HOME=<own> TMPDIR=<own> …`) from a source copy
  `nobody` owns, since vitest and the Tower write caches into the checkout,
  with a Node 24 it can read and without variables naming root-only files
  (such as `NODE_EXTRA_CA_CERTS`). Call the runners through `node`: `pnpm` as
  another user first fetches its pinned version, and the few tests that start
  a real Tower need that version where `nobody` can run it.

## Local OS health and recovery

Existing credentials, a successful test or this file do not authorise
production access: obtain the owner's explicit approval for the specific
environment, action, impact and verification, reads included. Installation
owners may keep dated, scoped approvals in
`installation/agent-authorizations.md`; read it when present. Automated tests
use isolated fixtures, never an existing installation or provider account. An
owner may designate a local Compose installation as development and let it
follow a mounted checkout, recorded in `.local/stack-development/authorization.json`.

NoticeOS runs as one Docker Compose stack of the app (`noticeos`: Tower,
ingest and the runner), `postgres`, `dolt` and an optional `backup` worker. The
ignored `.local/stack.json` selects it, and every `pnpm os:*` command acts on
that stack ([Docker guide](deploy/compose/README.md)). Every installation runs
from the one definition `deploy/compose/stack.yaml` and its folder's
`installation.env`; `pnpm os:setup` makes one and `pnpm os:convert-legacy` moves a
legacy one in, and nobody writes a Compose file. A development stack's
app runs this checkout's live source; a production stack's app runs a
prepared image. An installation without a checkout runs the same commands
through its folder's `noticeos` launcher (`<folder>/noticeos status`, `logs`,
`restart`, `update`), with no `--`. Do not guess from a port, inspect
containers by hand or read `.local/` by hand:

```sh
pnpm os:status                 # each service's health, the database's migrations, the app's commit, whether main is ahead
pnpm os:logs -- --lines 200    # recent logs; -- --follow, -- <service>
pnpm os:capacity               # store size and growth per table, read-only
pnpm os:restart                # the whole stack, in dependency order, waiting for health
pnpm os:restart:noticeos       # only the app; :backup, :postgres and :dolt name the other services
pnpm os:update                 # move the app to main's image (published, or built here), show the plan, apply it after you type `update`
```

Merging is not deploying: a production app runs a fixed image that a merge
never touches; `pnpm os:update` is the step after a verified merge and
replaces only the app container (`pnpm os:rollback` goes back). The app is
`healthy` when its runner is supervised with a fresh heartbeat, the scheduler
is armed, the Tower and ingest answer and a configured backup worker is
available. After downtime, startup runs at most one latest missed obligation
per allowlisted lane
([bounded catch-up](scripts/README.md#bounded-catch-up-after-downtime)); a
migration, restore, config apply, update, kill switch or measurement-rule
edit is never caught up by hand.

A restart or an update never applies migrations; `pnpm os:update` stops and
names `pnpm os:migrate` when main carries one the database lacks. Applying a
migration is operator-only: `pnpm os:status` → a backup you can restore
(`pnpm os:backup`) → `pnpm os:migrate` → `pnpm os:migrate -- --apply` →
`pnpm os:update` ([database migrations](scripts/README.md#database-migrations)).
`os:start`, `os:stop`, `os:dev`, `os:prod`, `os:migrate`, `os:rollback`,
`os:convert-legacy`, `os:apply`, `os:refresh-anomalies` (preview reads stored
reports; apply changes count alerts), `os:collect` (it asks providers and can
spend) and `os:refresh-comparison` (it asks Google) are operator-directed. An
agent's verbs are `os:status`, `os:logs`, `os:restart` and its one-service
forms, the task verbs `os:mcp` and `os:bd` and, after a verified merge,
`os:update`; never `os:migrate`.

`pnpm os:setup` on a machine that already runs an installation stops when it
finds that installation's selector; an agent runs it only with a throwaway `--dir`, `--project` and
`--config`, and removes what it made. `pnpm db:try-tower` is not an
installation: the Tower on a throwaway development database, for screens with
invented data.

## Open work lives in the task hub

In a checkout connected to a Beads hub, the hub is the only register of open
work: one hub, one database per asset, configured through the
[task-project contract](config/beads.README.md). Public contributors need no
access to a maintainer's private hub; follow [CONTRIBUTING.md](CONTRIBUTING.md).

Reach it through the NoticeOS MCP server's task tools: `list_workspaces`,
`get_task_guide`, then `list_projects`. The task guide is the canonical workflow
and task-quality policy. Never run `bd`, `bv` or `br` directly. If the tools are
missing, ask the owner to reconnect the server with `/mcp`.

Use `reconcile_task` for an existing owner answer, evidence-backed retirement,
a routine human-label correction or a checked abandoned assignment. The guide
and tool schema define its source checks and evidence. A recorded answer
resolves its matching decision; it does not prove implementation complete.
Retiring an approval grants no permission to perform its action. Production
access, spending, external messages, destructive changes and material business
or policy commitments retain their explicit action-specific approval.

## Git policy

Changes go through a branch and a GitHub pull request. Do not commit to or push
`main` directly. The task hub never commits or pushes. For requested work,
agents may create commits, push commits to PR branches, create and update PRs,
and read their review and CI metadata without further owner approval. Prefer
the GitHub App; an existing authenticated GitHub login is also permitted for
these operations without a per-PR exception. This authorisation excludes
merges, deployments, pushes that deploy, and other production access, which
retain their specific approval requirements.

Commit completed, verified pieces separately; stage only the intended changes;
follow the
[commit and PR title standard](CONTRIBUTING.md#commit-messages-and-pull-request-titles)
with the task id in a `Refs:` footer. Never amend and never force-push a
branch someone else has.

## State (dated facts; an expired entry is unknown, not true)

- Toolchain: Node 24.21.0 LTS and pnpm 12.8.1, declared in `package.json` and CI.
- CI: the two lanes above; PostgreSQL 18 server binaries and
  `NOTICEOS_REQUIRE_POSTGRES=1` make database proofs mandatory. PostgreSQL 18
  is the only supported major; no other major is installed or qualified.
- Installation paths: `pnpm os:setup` provisions a new installation as the
  Compose stack in its own folder, and the image's launcher
  (`docker run --rm ghcr.io/notice-cx/noticeos:main launcher | sh -s -- setup`)
  does so with no checkout; `pnpm os:convert-legacy` moves a legacy Compose
  installation into that layout; the application container consumes either; the
  [demo profile](deploy/demo/README.md) packages compiled code and synthetic
  stores behind an HTTPS proxy. Customer hosting is outside that preview; see
  the [release policy](docs/reference/release-policy.md).
- Outcome evidence: test and build success do not establish the business
  outcomes of doc 07; those come from an installation's own observations.
