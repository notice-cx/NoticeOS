# Contributing to NoticeOS

Start with the [domain model](CONTEXT.md), [report contract](docs/02-signal-contract.md)
and [repository instructions](AGENTS.md). Keep a change focused on the behavior
it improves, and include a regression that demonstrates the problem when one
is needed.

## Find the code that owns the change

| Path | Responsibility |
| --- | --- |
| `apps/tower/src/` | Browser UI, queries, forms and navigation |
| `apps/tower/shared/` | Tower payloads and portable UI contracts |
| `apps/tower/worker/` | Tower HTTP reads and request routing |
| `apps/tower/vite/` | Native-only task, configuration and host adapters |
| `workers/ingest/src/` | Stored writes, collectors, scheduled lanes and private RPC |
| `packages/contract/src/` | Shared report types, validation and signal rules |
| `packages/postgres/src/` | Workspace-scoped store and identity helpers |
| `packages/mediavine/src/` | The publisher-portal client |
| `scripts/` | Node commands, runner, installation tools and safety checks |
| `db/postgres/` | Operational schema, permissions and model proofs |
| `config/` | Generic defaults for a new installation |

Check the [component registry](apps/tower/src/components/registry.ts) and the
`/dev/kitchen-sink` gallery before adding UI; prefer reusing an entry. Use the existing store and request boundaries; browser UI does not
receive provider credentials or select host paths. The
[configuration ownership contract](docs/23-configuration-ownership.md) defines
workspace and deployment ownership.

For committed generated modules, edit the authored `.mts` file, then run:

```sh
pnpm config:generate
pnpm config:check
```

The generator's two TypeScript projects declare which sources produce `.mjs`
and `.d.mts` siblings. Do not hand-edit those generated siblings. Database
migrations follow the separate [schema procedure](db/postgres/README.md#changing-the-schema):
frozen migrations are immutable, and corrections use a new migration.

## Prepare an isolated test environment

Use the source prerequisites in the [README](README.md#run-from-source).
Install the locked dependencies with `pnpm install --frozen-lockfile`.
The CI reference is [`.github/workflows/ci.yml`](.github/workflows/ci.yml),
currently using Node 24.21.0, pnpm 12.8.1 and PostgreSQL 18 server binaries.
Put PostgreSQL's `initdb`, `pg_ctl` and `psql` on `PATH` for database tests.

Tests create disposable stores and use synthetic configuration. Never point
them at an existing installation, provider account, task hub or database.
Do not pass installation selectors or real credentials into a test run.
Keep the fixture guards enabled and use the shared test helpers for servers
and browsers. [`scripts/README.md`](scripts/README.md#notes) describes the
configuration and secret isolation; the
[journey guide](apps/tower/e2e/README.md) describes browser isolation.
Operational commands such as deployment, restoration and provider collection
are not test setup. Authorization, migrations, credentials and measurement-rule
changes need explicit review; passing tests do not authorize their activation.

Install the pinned test browser once for this checkout:

```sh
pnpm --filter @noticeos/tower run journey:install
```

Linux CI adds `--with-deps`. This uses the checkout's test-browser cache and
fresh browser profiles, not a personal Chrome profile.

## Local verification

Choose checks from the diff and the critical paths it affects. Full repository
gates run in GitHub CI on pushes to `main` and pull requests; do not duplicate
them locally by default. Target at least 80% less local execution time and CPU
work than a full pass, while retaining the checks needed to assess the change.

- Prose or images: check links, formatting, inclusion in the public source and
  the affected preview. Runtime suites are unnecessary.
- UI: run related rendering/interaction tests and affected flow checks. Use a
  focused browser journey when the changed behavior needs a real browser.
- Worker or script logic: run its tests and affected callers' critical paths.
  Include refusal, timeout and cleanup behavior where those paths change.
- Store, tenancy or backups: keep the relevant isolated database, ownership,
  failure-preservation and restore proofs. Never substitute production reads.
- Shared types/configuration: typecheck the changed package and its affected
  consumers. Build only when bundling or generated output is part of the change.

An independent verifier owns completion evidence. Builders can run small probes
while debugging; avoid running the same complete verification plan in both
roles. Reuse independently passing evidence when its code, tests, shared
dependencies/configuration, runtime and fixture inputs are unchanged. A prose
edit does not invalidate a runtime check. After a relevant edit or failure,
rerun only the affected checks; add checks for a specific unresolved risk.

Record selected commands and why they cover the change, relevant input hashes,
runtime/fixture versions, results, skip reasons, execution time and owned-resource
cleanup in one compact receipt. Reuse one qualified source/dependency/browser
bundle. Compare recorded execution time with the most recent full pass when
available; distinguish measured command time from total elapsed work and CPU
estimates. A change spanning most of the system can justify wider coverage.

From the repository root, these examples run existing suites through their
usual isolated harnesses:

```sh
NOTICEOS_REQUIRE_POSTGRES=1 pnpm --filter @noticeos/tower exec vitest run test/answer-queue.test.ts
NOTICEOS_REQUIRE_POSTGRES=1 pnpm --filter @noticeos/ingest exec vitest run test/calendar.test.ts
NOTICEOS_REQUIRE_POSTGRES=1 node --import ./scripts/script-tests-setup.mjs --test scripts/postgres-model.test.mjs
```

Keep the root suite's `--import` preload when running one script test. A
recursive workspace test does not run `scripts/*.test.mjs`.

CI runs these gates across six parallel jobs (`.github/workflows/ci.yml`: the
Tower's typecheck and unit tests; the other workspaces'; the root script
suite; the build and browser journeys; the journey harness and UX flow report;
and the task store against a real Dolt server), with `build` as the verdict
over all six. A pull request that changes only documentation skips all but the
root script suite (`scripts/ci-scope.mjs`). Release acceptance still requires
passing CI:

```sh
pnpm -r typecheck
NOTICEOS_REQUIRE_POSTGRES=1 pnpm -r test
NOTICEOS_REQUIRE_POSTGRES=1 pnpm test:scripts
pnpm -r build
pnpm test:journeys
```

For the PostgreSQL 17-to-18 restore proof, also set
`NOTICEOS_TEST_POSTGRES17_BIN` to the installed PostgreSQL 17 binary directory,
as CI does. Compose qualifications are explicit opt-ins with their own
generated resources; an ordinary test pass does not prove those skipped paths.
Record test counts and skip reasons. `pnpm test:journeys` includes journey
types, harness checks, browser journeys and the UX flow gate.

UI copy, flow length and installation-neutral code are checked by the normal
commit hooks and CI. Fix the underlying flow or source instead of disabling
the checks or changing their budgets.

## Commit messages and pull request titles

Use [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)
for commits and pull request titles:

```text
type(scope): describe the change
```

- Choose `feat` for a new capability, `fix` for a bug, `perf` for performance,
  `refactor` for restructuring without changing behavior, `docs` for documentation,
  `test` for tests, `build` for dependencies or build tooling, `ci` for automation,
  `chore` for other maintenance, or `revert` for a reversal.
- Use a scope when it helps locate the change, such as `tower`, `wall`, `ingest`,
  `postgres` or `compose`. Omit it for a change spanning the product.
- Keep the subject at most 72 characters, including the prefix. Start the
  description with a lowercase imperative verb: “add”, “fix”, “preserve”.
  Use no trailing period, emoji or task ID in the subject.
- Keep one coherent change per commit. Add a body when the reason, tradeoff or
  validation needs explanation; do not repeat the subject.
- Put issue references in the footer (`Fixes: #123`). Maintainer work tracked
  in Beads uses `Refs: <bead-id>`; public contributors do not need a Beads ID.
- Mark a breaking change with `!` before the colon and a `BREAKING CHANGE:`
  footer explaining its impact and upgrade steps. This does not replace the
  repository's migration and compatibility requirements.

```text
fix(compose): restore dashboard rendering
feat(wall): add configurable pulse metrics
docs: clarify the first-run setup
```

Give the PR title the same format so it can serve as the final commit title
when squash merging. Apply this standard to new commits; do not amend existing
commits or rewrite published history to make them conform.

## Submit a reviewable change

Explain the concrete before/after behavior, the source paths changed and the
checks you ran. Include the tested commit and relevant logs or synthetic
screenshots; state any skipped qualification. Keep installation files, private
archives, backups, credentials and actual task records out of patches and
evidence.

NoticeOS uses Beads and Dolt as its central work model. The maintainers' private
hub is not required to contribute. Use the public repository's issue and pull
request mechanisms when they are available. Report vulnerabilities privately
through the [security policy](SECURITY.md).

See the [release policy](docs/release-policy.md) for installation, upgrade and
publication boundaries.
