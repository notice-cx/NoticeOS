# Blocker impact verification

Refs: ro-ujb9.96.19

Source commit: `0addf158bc57b68062675a2fbf6e72fe2ac86cae`.
Base: current main `537e080c82e8dca66583477e1d7d212fbc336c51`, fetched and rechecked before implementation.
The evidence-only follow-up preserves these source inputs; SHA-256 values are in [input-hashes.json](input-hashes.json).

The Projects tab lists blockers across its existing project reads, ordered by distinct unfinished downstream work. Parked tasks count as unfinished; closed tasks stop a chain. Gates can hold work but do not count as downstream work. The second count includes only immediate dependents whose other blockers are known closed, excluding in-progress, parked, already-ready and unanswered human/choice work. Saved samples show unknown readiness because they omit human labels. Missing dependencies, unresolved targets, saved samples and failed reads qualify the results as known lower bounds.

## Checks

Run from the repository root with Node 24.21.0, pnpm 12.8.1 and PostgreSQL 18.6. The existing dependency installation matches the unchanged lockfile (`4ba97abdb1f6b93e06be7c54329a360697a00abce1ac90183dd96ac6aa4389d2`). Playwright 1.63.0 uses Chromium 1243 (153.0.8010.12) from the checkout's test cache.

| Command | Result | Wall time |
| --- | --- | --- |
| `NOTICEOS_REQUIRE_POSTGRES=1 pnpm --filter @noticeos/tower exec vitest run test/blocker-impact.test.ts test/blocker-impact-component.test.tsx test/tasks-projects-tab.test.tsx test/task-board-read.test.ts test/task-board-viz.test.ts` | 75 passed, 0 skipped | 7.30 s |
| `pnpm --filter @noticeos/tower run typecheck` | App, worker and existing journey types passed | 53.77 s |
| `pnpm --filter @noticeos/tower exec tsc -p e2e/blocker-impact/tsconfig.json` | New nested journey types passed | 6.03 s |
| `NOTICEOS_REQUIRE_POSTGRES=1 node --import ./scripts/script-tests-setup.mjs --test scripts/ui-lexicon.test.mjs scripts/ui-noun.test.mjs scripts/neutral-code-gate.test.mjs scripts/journey-runner.test.mjs scripts/task-client.test.mjs scripts/task-tool-guards.test.mjs` | 82 passed, 0 skipped | 6.24 s |
| `NOTICEOS_REQUIRE_POSTGRES=1 JOURNEY_WORKERS=2 pnpm --filter @noticeos/tower run test:journeys -- -g 'blocker impact'` | 4 passed: two journeys on desktop and mobile | 25.66 s |
| `pnpm --filter @noticeos/tower run test:journeys -- --list -g 'blocker impact'` | Normal CI runner discovers all 4 cases without shared configuration changes | 1.04 s |

Logs are in [logs/](logs/). Selected checks took 100.04 seconds in total, excluding browser preparation (139.89 seconds). No comparable full-repository baseline is available; the full CI gates were not duplicated locally. The initial sandboxed unit launch failed before tests while spawning `psql`; the successful run allowed the disposable loopback fixture. No gate was disabled.

## Acceptance evidence

| Requirement | Executable evidence |
| --- | --- |
| Chains and fan-out | Separate total downstream and immediate-ready assertions in `test/blocker-impact.test.ts` |
| Diamonds and multiple blockers | Distinct-node and repeated-edge deduplication; both parents retain zero immediate-ready work for a shared child |
| Cycles and 1,000 nodes | A 1,000-node cycle counts exactly 999 other tasks per root, completes under the asserted 2-second bound, and never recurses |
| Closed and deferred work | Closed nodes cut traversal; deferred roots and downstream work remain visible without claiming readiness |
| Gates and human holds | A remaining human gate, unanswered human label, unanswered choice or defer time prevents immediate readiness; gate nodes are excluded from work counts |
| Real blocking dependencies | Uses `TASK_BLOCKING_DEPENDENCIES`; parent, unrelated and discovery links do not contribute |
| Missing targets | Unknown targets remain blockers, embedded closed status is accepted only without a current row, and partial results are qualified |
| Identical IDs across projects | Unit and browser fixtures keep project attribution and links distinct |
| Partial, unavailable, empty reads | Component and browser checks retain lower-bound labels and distinguish unavailable results from a complete empty graph |
| No new task fetches or actions | Browser checks assert exactly one existing `/api/tasks?project=…` request for each of two projects, even after disclosure and changing view; no task writes occur |
| Compact desktop/mobile UI | Three rows before disclosure, five after; no page overflow; actor, state, project, counts and exact navigation verified on both viewports |

Screenshots: [desktop](live-desktop.png), [mobile](live-mobile.png), [partial desktop](partial-desktop.png), [partial mobile](partial-mobile.png). The synthetic fixtures have no epic containers, so the existing project count is zero while unfinished task dependencies remain visible.

Only `ProjectsTab.tsx` and new helper/component/test/evidence files changed. TasksBoard, TaskRoute, task-board-viz, shared task contracts, server operations, shared journey configuration and the Tasks guide are unchanged.

## Isolation and qualification

The unit suites retain the config-read guard. Browser tests import `journey-test.ts`, retaining its fixture-server, origin/offline and isolation guards. Fixtures are invented and use fresh disposable PostgreSQL stores; no existing installation, provider or production access occurred. The pinned testing browser uses fresh profiles. HOME, XDG directories, temporary files and logs are task-owned under `/workspace/work/blocker-impact`; database servers, journey servers and browser contexts close through the shared harness teardown. The checkout retains one reusable browser cache and dependency set.

These are local builder checks. Independent completion remains subject to the repository's required CI verdict and review; full repository gates and opt-in Docker/Dolt qualifications were not run locally for this UI-only change.
