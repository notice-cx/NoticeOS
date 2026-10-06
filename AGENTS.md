---
reviewed: 2026-10-01
staleness_policy: warn at 14 days, block the builder at 30 (doc 04)
---

# AGENTS.md — NoticeOS repo context pack

This repo's own context pack. Per the **bootstrap rule**
([doc 12](docs/12-implementation-readiness.md)) the accountability system is
built accountably from commit #1: the same `reviewed:`-dated, STATE-separated
pack NoticeOS demands of every asset governs NoticeOS itself. If this pack and
living memory disagree, **the pack wins until amended**
([doc 04](docs/04-decision-policy.md)).

## What this repo is

NoticeOS is a **closed loop around a ledger** — Sense → Attribute → Decide →
Act → Learn — for improving the return on a portfolio of websites and
software products, with as little operator oversight as each change class
has earned. It
observes each asset (pulses, search/traffic signals, revenue and cost),
attributes realized outcomes honestly (holdouts and cohort tests where possible,
"unmeasured" where not — never invented lifts), decides what to build next with
a versioned dollar-denominated scoring policy, acts through
build → independent-verify → ship under a graduated autonomy ladder, and grades
its own predictions against outcomes. This repo is the OS **and** its Control
Tower cockpit; it is **asset #0** and emits the same pulse it demands of every
asset.

## Monorepo layout (current)

| Path | Owns |
|---|---|
| `db/postgres/`, `packages/postgres/` | the Postgres operational store (D25) and the one helper used by the running OS (epic `ro-ujb9.76`) |
| `packages/contract/` | shared pulse-envelope types + volume-aware flag rules (zod) |
| `packages/mediavine/` | the Mediavine publisher-portal client the ingest's revenue collector uses |
| `workers/ingest/` | the ingest Worker: pulse endpoint, collectors, scheduled lanes (crons), the store's write routes |
| `apps/tower/` | the Control Tower (Vite + React + TS + Tailwind v4 + shadcn): the desk pages and the TV Wall, and its Worker |
| `config/` | the **product's defaults**: every config document a fresh clone seeds, generic (no sites, no task projects, UTC), each with a sibling README; plus `decisions.md`. Runtime settings live in the store after seeding (D22). The neutral-code gate keeps these free of any installation's names. |
| `installation/` | **this installation's own files**, found through one resolver (`scripts/installation.mts`; `NOTICEOS_INSTALLATION_DIR`, default `./installation`): the documents `pnpm config:export` and a Tower Save write (its sites, settings, and `beads.json` task projects — coordination state, **not signals**, [doc 01](docs/01-architecture.md)), the applied-changeset archive `changesets/`, its own decision log and notes (`decisions.md`, `notes.md` — what the product's `config/` prose no longer names), and the host-only `task-host.json`, `host-backup.json` and `dolt-server.yaml`. Tracked by this private repository; the public release leaves it out (D33). |

Workspaces glob from `apps/*`, `workers/*`, `packages/*`. The recursive
`typecheck` / `test` / `build` scripts must stay green with **zero workspaces
present** — never wire them so an empty set fails.

## Conventions

- **TypeScript strict.** Every workspace extends `tsconfig.base.json` (strict,
  ES2023, ESM, `moduleResolution: bundler`). No new `any`; do not loosen the
  base — add DOM/jsx/worker libs in the workspace tsconfig, not the base.
- **ESM only.** Root is `"type": "module"`; no CommonJS.
- **Credentials are connected in the product, not written into a file** (D21,
  epic `ro-vu8d`): a third-party provider secret belongs on the Tower's
  `/integrations` page and lives encrypted in the store; the env binding is the
  **legacy fallback for existing installs**, and never the thing a doc or a
  first-run path tells a reader to reach for first. The four bootstrap secrets
  stay in the environment because they start the OS rather than integrate
  anything. Their list is written ONCE, in
  [doc 06](docs/06-operations.md#bootstrap-secrets-vs-integration-credentials);
  link it, never restate it. Secrets never appear in a log line, a response body,
  or a test fixture.
- **Tests: vitest.** An independent verifier owns the change-scoped completion
  checks ([doc 05](docs/05-execution-and-accountability.md)); a builder's own
  transcript is inadmissible. Reuse verified checks whose inputs are unchanged.
- **SQL is snake_case.** Table and column names snake_case; migrations are
  numbered and **append-only** ([doc 02](docs/02-signal-contract.md)) — the store
  is history, never truncated.
- **UI tokens, never literals** ([doc 14](docs/14-ui-standards.md)): severity is
  the attention color system — `error` / `warn` / `info`, plus the reserved
  emerald accent for milestone-**kind** items. Scoped non-attention systems
  are defined in doc 14, including integration connectivity, like-for-like
  performance comparisons and observed workflow execution. Workflows use
  `healthy` green for recorded success, `error` red for failure and neutral
  gray for inactive or unknown states, always with text and glyphs; execution
  success does not imply a successful business outcome. **A hex literal in a component is a
  review-blocking smell.** `tabular-nums` is baked into the stat components —
  every metric, no exceptions. Check the component registry before creating
  anything; a near-duplicate is a rejected completion, not a style note.
- **No explanatory prose in the Tower — the UX gate stops it** (bead
  `ro-ujb9.94`, [scripts/README.md](scripts/README.md#ux-gate--no-paragraph-of-explanation-in-the-tower)):
  a visible string over 12 words (18 for a failure) fails at edit time, at
  commit (`.githooks/pre-commit`, installed by `pnpm install`) and in CI.
  Redesign the flow; never bypass it with `git commit --no-verify` and never
  edit `apps/tower/ux-budget.json` or the gate's rules in
  `scripts/ux-gate.settings.json`.
- **A flow only gets shorter — the UX flow gate stops it** (bead
  `ro-ujb9.95`, [scripts/README.md](scripts/README.md#ux-flow-gate--a-flow-only-gets-shorter),
  doc 21 principle 3b): `pnpm test:journeys` walks every flow in
  `apps/tower/e2e/ux-flows.mjs` and fails on an added step, screen or page
  change, an empty step, a repeated check, a duplicate status or an ungrouped
  list. Add the control to the current step instead; a changed flow changes
  its walk in the same commit; never edit `apps/tower/ux-flows.json`.
- **Every change leaves NoticeOS readier for a stranger's installation**
  (operator, 2026-09-23; D30). Product code names no installation's own
  sites, accounts, paths or time zone — those come from the store, with
  generic defaults (fixtures use `example.com`). The neutral-code gate
  (`pnpm neutral:gate`, bead `ro-ujb9.118`,
  [scripts/README.md](scripts/README.md#neutral-code-gate--product-code-names-no-installations-own-sites))
  stops a site id, domain or time zone in product code at commit and in CI. Anything an operator sets is
  set in the Tower, not in a file. A new concept is found on the screen that
  needs it — an empty state leads to the next action — never in a paragraph.
  Host-only mechanisms (launchd, files on the office Mac) sit behind an
  adapter a cloud installation can replace. Maintainability counts as much as
  the feature: one derivation per fact, names a newcomer understands, and the
  smallest change that leaves the design clearer.
- **Flags carry severity AND kind as separate fields**
  ([doc 02](docs/02-signal-contract.md)): `info|warn|error` × `anomaly|
  opportunity|milestone`; milestone-kind is always info-severity. Volume-aware
  rules only: flag when `P(observed | Poisson(avg7d)) < α` **and** baseline
  ≥ 3/day (defaults in `config/constants.json`).
- **Completion is evidence, not prose.** Every claim carries a machine-checkable
  pointer (commit hash, gate command, artifact path, URL). Prose-only "done" is
  rejected at intake. Anything deferred is parked in the WIP registry with owner
  + trigger — **the WIP registry is the beads hub since 2026-08-01**, see
  [Open work lives in beads](#open-work-lives-in-beads) — the system may decide
  not to do something; it may not decide not to *mention* it.
- **Every configured spoke carries `docs/freeze-register.md`.** Missing is
  unknown, never "clear": no search-facing or measured surface gets a verdict
  until its property-local register is read. A ship that opens a measurement
  window creates the readback bead first and adds the exact surfaces, change,
  dates, and bead id to the register in the same change. A spoke with no active
  windows says so explicitly; it does not omit the register.

## HARD INVARIANTS (non-negotiable — from [doc 01](docs/01-architecture.md))

**Never auto-touch. Operator-only, forever, never promotable on the autonomy
ladder** (the `forbidden` designation, not a change class — no tier, no path up):

- auth
- billing
- security headers
- DB migrations, except the approved fresh-install setup below
- consent surfaces
- analytics / tracking pipelines
- holdout assignments
- guardrail thresholds

**Fresh-install exception (owner, 2026-09-30; `ro-ujb9.8.1`, gate `ro-nzy7`).**
`pnpm start` may apply the committed frozen Postgres schema and bootstrap one
workspace only for a provably new, empty installation in its own isolated
Compose project. Implementing and testing that path on disposable installations
is approved. Existing installations, the managed service, live data and
production remain operator-only; this exception authorizes no production access.

**Hosted tenancy authorization (owner, 2026-10-01; D39, `ro-ujb9.289`).**
The owner explicitly authorized local implementation and disposable synthetic
tests of hosted authentication, tenant isolation and a real public demo under
[doc 23](docs/23-configuration-ownership.md). Customer workspaces are initially
invitation-only; demo visitors explore shared data read-only while a separate
simulator supplies activity. This supersedes D23's prohibition on building
account support. It is scoped task authorization, not an autonomy promotion:
existing-store migrations, live auth activation, public hosting and remote
production changes still require concrete operator approval. Preserve the
standalone path and rollback compatibility; no billing scope is inferred.

The last three are the **measurement channel**: it lives outside the optimizer's
write scope because an agent that can edit the ruler eventually will. Also
standing and non-negotiable: publishing-velocity caps and per-surface churn caps
([doc 04](docs/04-decision-policy.md)); PRs only via the one fine-grained
**GitHub App**, never PATs; assets **never** query external analytics about
themselves — push-to-central only. Automated asset execution requires a
one-action kill switch and a proven drill before enablement
([doc 06](docs/06-operations.md)). First-release agent execution remains manual
and its pause check unavailable (D43).

## The CI bar

Four parallel jobs (`.github/workflows/ci.yml`) on push to `main` and every
PR, each after `pnpm install --frozen-lockfile`: the Tower's typecheck and unit
tests; the other workspaces' (`pnpm -r --filter '!@noticeos/tower'`);
`pnpm test:scripts`; and `pnpm -r build` → `pnpm test:journeys` (the isolated
browser journeys, then the UX flow gate, bead `ro-ujb9.95`). The `build` job is the required verdict over all four. A PR that
changes only documentation no runtime suite reads (`scripts/ci-scope.mjs`:
`docs/` outside `briefs/` and `templates/`, and root Markdown) skips the unit
and browser jobs; the root suite always runs, and a push to `main` runs
everything. **The full gates run
in CI; they are not a mandatory local pre-merge run** (owner, 2026-10-05).
Locally test directly changed logic and affected critical paths, with the
smallest relevant typecheck, build or browser check. Do not run every workspace,
the full root suite or all journeys by default. Documentation and image changes
need their own checks, not runtime suites. The separate root suite is load-bearing: recursive pnpm commands
visit workspaces, not `scripts/*.test.mjs`, where runner, migration, collector,
backup, and task-hub safety contracts live. But **CI-green ≠ safe**
([doc 01](docs/01-architecture.md)): CI gates "does it build"; the failures that
threaten ROI are *outcome* failures, caught downstream by post-ship
outcome-watch and auto-rollback — never by CI alone.

**Local verification budget** (owner, 2026-10-05; `ro-ujb9.341`): target at least
80% less execution time and CPU work than a full local pass. One independent
focused run supplies completion evidence; builders use smaller probes when
debugging instead of automatically duplicating that run. Carry passing evidence
forward when its tested code, tests, shared dependencies/configuration and runtime
inputs are unchanged. Rerun only affected checks after relevant edits or failures;
broaden only to resolve a concrete risk. Batch independent checks, reuse the
qualified bundle, and keep one compact receipt per completed piece. Record actual
command time; do not invent CPU measurements or omit a critical check to meet a
budget. Selection examples and evidence requirements live in
[CONTRIBUTING.md](CONTRIBUTING.md#local-verification).

## Temporary test storage and cleanup

- **Budget before preparing or running.** Before large copies, dependency or
  browser preparation, and each heavy test phase, record free bytes on the
  destination filesystem and the expected peak additional allocation. Refuse
  unless that allocation leaves **at least 8 GiB free**. An APFS clone's logical
  size is not its reclaimable space; measure free space again after cleanup.
- **Reuse one qualified bundle.** Sequential verifiers reuse one owned public
  source copy bound to an exact commit/hash manifest, lock-matched dependencies,
  and one qualified browser binary/cache per version. Do not make another full
  copy for each gate. Give each verifier separate `HOME`, XDG directories,
  `TMPDIR` and fixture ports; hand off the bundle explicitly. Do not change its
  source or run installers against its dependencies while it is in use.
- **Prepare the dependency cache before replacing working modules.** A pnpm
  `install --dry-run` proves resolution, not cached tarball availability. Read
  the installed `node_modules/.modules.yaml` store location, pass its base with
  an explicit `--store-dir`, and verify `pnpm store path` selects that store;
  do not rely on `npm_config_store_dir`. Before an offline install, run
  [lockfile-based `pnpm fetch`](https://pnpm.io/cli/fetch) in a new owned
  metadata-only directory, using the same store/cache and the intended lockfile,
  workspace configuration and any patches. Keep its virtual store separate from
  the working checkout. A failed fetch leaves working modules intact: resolve
  it there before installing. Disable lifecycle scripts and runtime acquisition
  during this preparation; use `--ignore-scripts --no-runtime` for the frozen
  install. Retire the temporary virtual store afterwards; retain the shared
  package cache. This adds no source or browser clone (`ro-ujb9.291`).
- **Track ownership through the run.** Record planned temporary paths and
  profiles before launch, then exact child processes/groups, servers, connections
  and fixture resource IDs as they are acquired. Reuse the existing test helpers'
  close/cleanup paths. In `finally`,
  **await** closure on success and failure; handle interruption with a bounded
  stop and escalation for those recorded children only. Verify resource absence
  before removing their owned temporary files.
- **Keep evidence, retire owned waste.** Save compact source manifests, logs and
  receipts in durable private storage before retiring a completed work directory.
  Remove only proven inactive source copies, redundant dependencies, test profiles,
  caches and disposable fixtures; never remove shared dependencies or binaries
  still leased by another verifier. If ownership or shutdown is uncertain, retain the resource and file
  a bead instead of guessing. No blanket home, system-temp or browser cleanup.
- **Use the testing browser.** Prefer the qualified Playwright Chromium or
  Chrome for Testing binary over the user's installed Chrome. Normal Chrome on
  macOS can create code-signing clones outside its temporary profile. Account
  for those separately: automatic test cleanup needs exact launch/binary/clone
  ownership and proof that no process holds the clone open. A separate reviewed,
  explicitly owner-approved cleanup may establish custody of older clones.
  Never delete an unknown or in-use clone, or the user's Chrome/profile data.

## Local OS health and recovery

**Establish the target and authorization before connecting.** Existing credentials,
a successful test, or this repository's instructions do not authorize production
access. Obtain the owner's explicit approval for the specific environment,
action, impact and verification, including production reads. Record blocking
approvals as human gates when the checkout has a Beads hub. Continue independent
local work while an approval is pending.

Installation owners may keep dated, scoped approvals and recovery facts in
`installation/agent-authorizations.md`. Read that file if present before working
on an existing installation; its absence grants no exception. Honor approvals
already given for the same target and action. Automated tests always use isolated
fixtures, never an existing installation or provider account.

An owner can explicitly designate a named local Compose installation as
**development** and authorize it to follow a mounted checkout. Record that
designation and its exact stack, source path and routine access scope in ignored
`.local/stack-development/authorization.json`. Within that recorded scope,
ordinary app reads, live source edits, refreshes and app-only restarts need no
production approval or deployment gate. This applies to that installation only;
production targets and operator-only database, credential and measurement
changes keep their existing rules. Development mode retains the installation's
data; automated tests still use disposable fixtures.

`pnpm start` is **not** the live OS: it runs a separate, new installation out
of `.local/start/` on :4747 for a fresh clone (bead `ro-ujb9.126`,
[scripts/README.md](scripts/README.md#a-new-installation-in-one-command-pnpm-start)).
An agent runs it only with a throwaway `--dir` and its own `--port`.

For an existing Docker installation, use the declared `.local/stack.json`
selector and `pnpm stack:status`. `stack:restart` keeps the current image;
`pnpm stack:deploy` prepares a pinned image and reviewable plan from clean,
independently verified `main`. Apply that exact plan only within the owner's
approved activation, readback and recovery scope. The command replaces only
the app; schema/role changes require separate maintenance. Commits alone do not
deploy. The [Docker guide](deploy/compose/README.md#deploy-changes-from-main)
owns the preparation, approval, rollback and browser refresh procedure. Do not
enable source mounts or automatic production deployment from a dirty checkout.

For the supported macOS service adapter, do not inspect raw launchctl state,
guess from a port, hunt process trees, or read `.local/` directly as the normal
workflow; the repo owns the stable interface:

```sh
pnpm os:status                 # add: -- --json for machine-readable state
pnpm os:logs -- --lines 200    # recent redacted runner + child output
pnpm os:logs -- --follow       # follow during a reproduction
pnpm os:doctor                 # bounded status + logs + scheduled-lane evidence + capacity
pnpm os:capacity               # store size and growth per table, read-only (doc 26)
pnpm os:restart                # managed service only; waits for health
pnpm os:deploy                 # move the live OS to main: one restart, health wait
```

**Merging is not deploying.** The managed service runs a runtime copy of the
code under `.local/runtime/` that a merge never touches; `pnpm os:deploy` is the
step after a verified merge (it refuses a dirty copy, a commit not on main, a
non-fast-forward move and an unapplied migration; `-- --check` changes nothing,
`-- --rollback` goes back). `pnpm os:status` says which commit runs and whether
main is ahead. An owner may authorize local `os:restart` and `os:deploy` for verified work
on a named installation. That approval does not extend to another installation
or a cloud production environment.

`healthy` means launchd is running, the runner heartbeat is fresh, ingest and
Tower answer, and PostgreSQL and Dolt readiness reads succeed. `stopped`,
`starting`, `unhealthy`, and `stale` are
distinct states; an answering but unsupervised process is `unhealthy`, never
good enough. Use `pnpm os:doctor` before restarting when the cause is unclear.
`os:restart` refuses to kill a manual/unknown process and prints recent redacted
output when health does not return. Logs are redacted before persistence,
rotated, and survive exits.

After downtime, startup runs no more than one latest missed obligation per
explicitly allowlisted lane, inside the windows documented in
[`scripts/README.md`](scripts/README.md#bounded-catch-up-after-downtime). Unknown
crons and every manual/forbidden operation are excluded; never "catch up" a
migration, restore, config apply, deployment, kill switch, or measurement-rule
edit by hand. `pnpm os:doctor` shows the resulting scheduled-lane evidence.

An authorized restart or local deploy after ordinary runner/Tower work
**never applies migrations**. DB migrations stay an explicit
operator-only sequence: `pnpm os:stop` → `pnpm postgres:migrate apply …` →
`pnpm os:start`, with the explicitly approved target and owner environment
([Postgres maintenance](scripts/README.md#the-postgres-stores-counterpart-postgresmigrate));
never infer authorization for it from a restart or a pending migration file. The
same approval rule applies to every forever-forbidden surface above.
`pnpm os:stop` / `pnpm os:start` take the OS down for maintenance and bring it
back without touching the plist, and `pnpm os:install` / `pnpm os:uninstall`
change the login service itself; all four are operator-directed only — an agent's
verbs are `os:restart` and, after a verified merge, `os:deploy`. The implementation and restore details live in
[`scripts/README.md`](scripts/README.md#launchd-service--the-office-macs-normal-state).

## Open work lives in beads

**In a checkout connected to a Beads hub, the hub is the only register of open work** — the WIP registry
([doc 05](docs/05-execution-and-accountability.md) §6) made real, as of
2026-08-01. One hub, one database per asset, configured through the
[task-project contract](config/beads.README.md). Each project files in its own
database. Historical `ro-` references identify this product's development work.
Public contributors do not need access to a maintainer's private hub; follow
[CONTRIBUTING.md](CONTRIBUTING.md) when no hub is configured.

**A relocated maintainer checkout keeps its existing task authority.** If
`.beads/` is missing after a source cutover, establish the existing hub and
reconnect the checkout before building or filing duplicate work. Follow
[Moving a maintainer checkout](config/beads.README.md#moving-a-maintainer-checkout);
missing local connection files do not establish that the project has no hub.

- **Found new work? File a bead.** `bd create` in the repo that owns it — never
  a TODO comment, a follow-up list, a parked-items section, a brief's loose
  ends, or a memory note. A register nobody can query is a register nobody
  reads.
- **Check open work with `bd ready` / `bd list`, never a doc.** A doc that
  doubles as a task list is stale the moment it is written; the hub is current
  by construction.
- **Use a live execution loop.** At the start of work, after each completed
  piece, after resuming from a handoff, and before ending a work session, check
  `bd ready` and `bd list` again. Read the candidate's `bd show` before choosing
  it; the transcript, memory, and docs are not the remaining-work queue.
- **Claim, verify, commit, close, then recheck.** Claim an unblocked leaf with
  `bd update <id> --claim --actor <actual-agent>` before building. Verify against
  its acceptance criteria, commit the completed piece under the Git policy
  below, and close it in the same session with the actual commit hash and test
  or live evidence. Do not leave completed beads open merely because related
  work continues. Close a parent epic only after all required children and its
  own acceptance are complete; partial progress stays open with precise evidence.
- **Continue within the authorized scope.** When asked to keep fixing, select
  the next relevant, unblocked leaf from the refreshed hub instead of stopping
  after one batch. Ready is not permission: human-labelled work, protected
  operations, and unrelated projects still require the appropriate authority.
- **Persist the workflow, not the backlog.** Project instructions and memory
  may retain these rules and point to beads, but must not copy open/closed work
  lists. New findings and remaining acceptance belong in the hub.
- **"Noticed, not fixed" is a bead before it is a sentence.** A finding an agent
  reports but does not fix is filed first, and the report cites the id —
  otherwise it dies with the transcript.
- **The bead quality bar** (`bd lint` enforces the shape; this pack enforces the
  content): an **outcome-stated title** an operator who never saw the work
  understands, and a **self-contained description** — WHAT, WHY with the
  numbers, WHERE as pointers that resolve in a repo (file paths, commit hashes,
  doc sections, table and rule names), plus acceptance criteria naming the proof
  a completing agent produces. **Never cite a session, a transcript, or another
  agent's report** — replace it with the underlying repo evidence, or the
  pointer is dead on arrival.
- **Mark real blocking edges when you file; never invent one for tidiness.**
  the Tower and agent triage treat dependencies as load-bearing ranking signal, so a
  fabricated edge corrupts prioritization for everyone after you. A leaf with no
  edges should be a leaf you checked.
- **Docs state facts and designs; beads carry open loops.** A dated "not built"
  claim is honest state and stays — it names its tracking bead. A doc that
  accumulates open items is a defect, not a backlog.
- **Work only the operator can do carries the `human` label.** `bd human list`
  is the operator's inbox (`respond` closes with the answer, `dismiss` declines
  permanently); an agent that hits a decision, credential, or admin-console step
  labels the bead `human` instead of burying the ask in a report. For a step
  that must **block** until approval, `bd gate create --type human` holds the
  blocked bead out of `bd ready` until `bd gate resolve` — approval is a gate,
  never an assumption.

Epics, dependency direction, defer, and the full filing grammar:
[`config/beads.README.md` §Conventions](config/beads.README.md#conventions).
Tooling — why `bd` is the only task CLI — is
[below](#beads-tooling-bd-only).

---

## STATE (volatile — dated facts; an expired entry is *unknown*, not *true*)

These are repository facts, not a statement about any running installation.
Re-verify before relying on them; deployed versions and recovery custody belong
to the installation's private records.

- **Toolchain** (source checked 2026-10-01): Node v24.21.0 LTS and pnpm 12.8.1,
  declared in `package.json` and CI.
- **CI** (source checked 2026-10-01): the five gates above; PostgreSQL 18 server
  binaries and `NOTICEOS_REQUIRE_POSTGRES=1` make database proofs mandatory.
  PostgreSQL 17 binaries support the isolated cross-major restore fixture.
- **Installation paths** (source checked 2026-10-04): standalone source setup
  provisions isolated Postgres and Dolt stores. The prepared application
  container consumes an existing installation. The separate
  [demo preview profile](deploy/demo/README.md) packages compiled code and new
  synthetic stores behind an HTTPS proxy. Customer hosting is outside this
  preview; local code or tests do not establish an activated public service.
  See the [release policy](docs/release-policy.md).
- **Outcome evidence**: test and build success do not establish the phase-exit
  business outcomes. Use the [architecture audit](docs/19-architecture-implementation-ux-audit.md)
  and the relevant installation's observations for those verdicts.

---

## Beads tooling: `bd` only

Filing conventions — epics, dependencies, defer, and the quality bar — live in
[`config/beads.README.md`](config/beads.README.md); the rule that beads is the
only register is [above](#open-work-lives-in-beads).

**Spoke config standard (ro-wkb):** every spoke's `.beads/config.yaml` has no
`sync.remote`, plus `no-git-ops: true` and `import.auto: false` — together, not
separately. `sync.remote` gives `bd dolt push/pull` a live target that would
fork a private issue store; `no-git-ops` silences the hook advice that suggests
exactly that push; `import.auto: false` stops git pull/merge/checkout from
upsert-importing a stale JSONL export back into the hub. If
`bd` ever prints "no Dolt remote configured … repair: `bd dolt push`", the
config has drifted — fix the config, never run the printed repair. Full
rationale: the contract's "How a new project joins" section.

### Never `br` or `bv`

**Never run `br` (beads_rust) inside a Beads/Dolt spoke.** It is a different implementation —
SQLite + JSONL, no Dolt backend, no server mode — so it cannot reach the hub at
all. `br create` in a spoke would scaffold a *private* SQLite store inside
`.beads/`: a second, divergent register, which is exactly the failure the
register rule exists to prevent.

`bv` is retired by D12. Its per-repo JSONL cache could lag the hub, it could not
see the portfolio, it ranked human gates, epics, and deferred work as agent
recommendations, and its claim commands invoked the incompatible `br`. Do not
run it or restore its auto-export/instruction bridge.

### Live views

Use `bd ready`, `bd list`, and `bd show` inside the owning repo for live hub
truth. Claim a leaf work item—not an epic or a human gate—with `bd update <id>
--claim`. Use `bd human list` for the operator inbox. Beads is NoticeOS's required work model and Dolt its central task authority for internal and external work (D32); future task integrations map into that model. The Tower's Tasks page (`/tasks`) is
the live cross-project view, fed by the snapshot poller that walks the saved
task projects (the installation's `beads.json` is their export). The hub is
always the truth.

### Git policy

`bd` never commits or pushes. This repo's own git rules win over any
generic workflow advice. The operator authorizes separate commits for completed,
verified pieces of requested work without another prompt. Include the bead id;
stage only the intended changes. Follow the [commit and PR title standard](CONTRIBUTING.md#commit-messages-and-pull-request-titles); put the bead ID in a `Refs:` footer. **Never push and never amend commits.**
