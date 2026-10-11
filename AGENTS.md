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
products, with as little operator oversight as each change class has earned.
It observes each asset (reports, search and traffic signals, revenue and cost),
attributes outcomes honestly (holdouts and cohorts where possible, "unmeasured"
where not, never an invented lift), decides what to build next with a
dollar-denominated scoring policy, acts through build → independent verify →
ship under a graduated autonomy ladder, and grades its own predictions against
outcomes. This repo is the OS and its Control Tower; it is asset #0 and emits
the same report it demands of every asset.

## Monorepo layout

| Path | Owns |
|---|---|
| `db/postgres/`, `packages/postgres/` | the Postgres operational store and the one helper the running OS uses to reach it |
| `packages/contract/` | the shared report envelope, the config document schemas and the volume-aware alert rules (zod) |
| `packages/mediavine/` | the Mediavine publisher-portal client the revenue collector uses |
| `workers/ingest/` | the ingest Worker: the report endpoint, the collectors, the scheduled lanes, the store's write routes |
| `apps/tower/` | the Control Tower (Vite + React + TS + Tailwind v4 + shadcn): the desk pages, the TV Wall and its Worker |
| `docs/` | the documentation site (VitePress): the guides, screens and operations pages for the operator, and the numbered design library beside them |
| `config/` | the product's defaults: every config document a fresh clone seeds, generic (no sites, no task projects, UTC), each with a README beside it. Runtime settings live in the store after seeding. |
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
  An independent verifier owns completion checks; a builder's own transcript is
  not evidence. A scenario is a test or it is nothing: it is never argued in a
  comment.
- **Comments say what the code cannot.** A non-obvious why, an invariant, a
  trap, or the one place a fact lives, in a line or two. No decision numbers,
  task ids, dates of past changes, attributions, histories of what the code
  used to do, or alternatives considered. Decisions become code, features and
  tests; there is no decision register.
- **SQL is snake_case.** Migrations are numbered and append-only; the store is
  history, never truncated.
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
- **Every change leaves NoticeOS readier for a stranger's installation.**
  Product code names no installation's own sites, accounts, paths or time
  zone; those come from the store, with generic defaults (fixtures use
  `example.com`). The neutral-code gate (`pnpm check:neutral`) stops a site id,
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
  `db/postgres/model.json`. A test fails when a generated block is stale. Prose beside a block says why, never what.
- **Flags carry severity and kind as separate fields** (doc 02):
  `info|warn|error` × `anomaly|opportunity|milestone`; milestone kind is always
  info severity. Volume-aware rules only: flag when
  `P(observed | Poisson(avg7d)) < α` and the baseline is at least 3/day
  (defaults in `config/constants.json`).
- **Completion is evidence, not prose.** Every claim carries a machine-checkable
  pointer: a commit hash, a gate command, an artifact path, a URL. Anything
  deferred is a task in the hub with an owner and a trigger; the system may
  decide not to do something, never not to mention it.
- **A measurement window freezes the surfaces it measures.** A ship that opens
  one records the surfaces, the change, the dates and the readback task in the
  task hub, and nobody refactors those surfaces until the reading is in
  (doc 03). The hub is the register; there is no register file.

## Hard invariants

Never auto-touched. Operator-only, forever, never promotable on the autonomy
ladder: auth, billing, security headers, DB migrations (except the fresh-install
setup below), consent surfaces, analytics and tracking pipelines, holdout
assignments, guardrail thresholds. The last three are the measurement channel:
an agent that can edit the ruler eventually will.

Also standing: publishing-velocity caps and per-surface churn caps (doc 04);
PRs only through the one fine-grained GitHub App, never a PAT; assets never
query external analytics about themselves, they push to central. Automated
asset execution requires a one-action kill switch and a proven drill before
enablement (doc 06); agent execution is manual in this release and its pause
check is shown as unavailable.

**Fresh-install exception.** `pnpm start` may apply the committed frozen
Postgres schema and bootstrap one workspace, only for a provably new, empty
installation in its own isolated Compose project. Existing installations, the
Docker stack, live data and production stay operator-only.

**Hosted tenancy.** Local implementation and disposable synthetic tests of
hosted authentication, tenant isolation and the public demo are authorised
under [doc 23](docs/23-configuration-ownership.md). Customer workspaces are
invitation-only; demo visitors read shared synthetic data while a separate
simulator supplies activity. Existing-store migrations, live auth activation,
public hosting and remote production changes still need concrete operator
approval. Keep the standalone path and rollback compatibility; no billing
scope is inferred.

## The CI bar

Six parallel jobs (`.github/workflows/ci.yml`) on push to `main` and every
PR, each after `pnpm install --frozen-lockfile`: the Tower's typecheck and unit
tests; the other workspaces'; `pnpm test:scripts`; `pnpm -r build` then the
isolated browser journeys; the journey harness then the UX flow walker (a
report; it fails only when a flow cannot be walked); and `pnpm test:task-store`
against a real Dolt server in Docker. The `build` job is the required verdict.
A PR that changes only documentation no runtime suite reads (`docs/` and root
Markdown, per `scripts/ci-scope.mjs`) runs the root suite alone, and the
`docs` workflow builds the site whenever `docs/` changes; a push to `main` runs
everything and publishes the site.

The full gates run in CI; they are not a mandatory local pre-merge run. Locally,
test the changed logic and the affected critical paths with the smallest
relevant typecheck, build or browser check; carry passing evidence forward when
its inputs are unchanged; record the actual command time. The root suite is
load-bearing: recursive pnpm commands visit workspaces, not `scripts/*.test.mjs`,
where the runner, migration, collector, backup and task-hub contracts live.
CI-green is not safe: CI checks that it builds; the failures that threaten ROI
are outcome failures, caught by post-ship outcome watch, never by CI alone.

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
that stack ([Docker guide](deploy/compose/README.md)). A development stack's
app runs this checkout's live source; a production stack's app runs a
prepared image. Do not guess from a port, inspect containers by hand or read
`.local/` by hand:

```sh
pnpm os:status                 # each service's health, the database's migrations, the app's commit, whether main is ahead
pnpm os:logs -- --lines 200    # recent logs; -- --follow, -- <service>
pnpm os:capacity               # store size and growth per table, read-only
pnpm os:restart                # the whole stack, in dependency order, waiting for health
pnpm os:update                 # build main into an image, show the plan, apply it after you type `update`
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
`os:start`, `os:stop`, `os:dev`, `os:prod`, `os:migrate` and `os:rollback` are
operator-directed. An agent's verbs are `os:status`, `os:logs` and
`os:restart` and, after a verified merge, `os:update`; never `os:migrate`.

`pnpm start` is not the live OS: it runs a separate new installation out of
`.local/start/` on :4747 for a fresh clone; an agent runs it only with a
throwaway `--dir` and its own `--port`.

## Open work lives in the task hub

In a checkout connected to a Beads hub, the hub is the only register of open
work: one hub, one database per asset, configured through the
[task-project contract](config/beads.README.md). Public contributors need no
access to a maintainer's private hub; follow [CONTRIBUTING.md](CONTRIBUTING.md).

- Found new work? File a task with `bd create` in the repo that owns it, never
  a TODO comment, a follow-up list or a memory note.
- Check open work with `bd ready` / `bd list`, never a doc; read `bd show`
  before choosing. Claim an unblocked leaf with `bd update <id> --claim --actor
  <agent>`, verify against its acceptance criteria, commit the completed piece,
  close it with the commit hash and the evidence, then recheck the hub.
- A finding you report but do not fix is filed first; the report cites the id.
- A task has an outcome-stated title and a self-contained description: what,
  why with the numbers, where as pointers that resolve in a repo, and the proof
  that completes it. Never cite a session, a transcript or another agent's
  report. Mark real blocking edges only.
- Work only the operator can do carries the `human` label (`bd human list` is
  the inbox); a step that must block until approval is a `bd gate create
  --type human` gate.

`bd` is the only task CLI: never `br` (a different SQLite implementation that
would fork a private store) and never `bv` (retired). A spoke's
`.beads/config.yaml` has no `sync.remote`, plus `no-git-ops: true` and
`import.auto: false`; if `bd` ever prints "no Dolt remote configured … repair:
`bd dolt push`", fix the config and never run the printed repair. The Tower's
Tasks page is the live cross-project view; the hub is the truth.

## Git policy

`bd` never commits or pushes. The operator authorises separate commits for
completed, verified pieces of requested work without another prompt; stage only
the intended changes; follow the
[commit and PR title standard](CONTRIBUTING.md#commit-messages-and-pull-request-titles)
with the task id in a `Refs:` footer. Never amend and never force-push a
branch someone else has.

## State (dated facts; an expired entry is unknown, not true)

- Toolchain: Node 24.21.0 LTS and pnpm 12.8.1, declared in `package.json` and CI.
- CI: the six jobs above; PostgreSQL 18 server binaries and
  `NOTICEOS_REQUIRE_POSTGRES=1` make database proofs mandatory; PostgreSQL 17
  binaries back the cross-major restore fixture.
- Installation paths: standalone source setup provisions isolated Postgres and
  Dolt stores; the application container consumes an existing installation; the
  [demo profile](deploy/demo/README.md) packages compiled code and synthetic
  stores behind an HTTPS proxy. Customer hosting is outside that preview; see
  the [release policy](docs/reference/release-policy.md).
- Outcome evidence: test and build success do not establish the business
  outcomes of doc 07; those come from an installation's own observations.
