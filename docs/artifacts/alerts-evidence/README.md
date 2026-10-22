# Alerts acceptance evidence

Source: `65fc629de9684eecd26274732afdd610ceb655b0`. Base: `ae864db37cc8026a018043e688b62c3b15951870`, fetched from latest `origin/main` before implementation. Branch: `codex/alerts-readable-evidence`.

## Acceptance references

| Task | Change and machine-checkable evidence |
|---|---|
| ro-riu8.16 | Shared `ListRow` renders complete wrapping titles/captions closed and expanded; `AlertRow` has no `wrapCaption` opt-in. `surface-components.test.tsx` tests long text, a long URL, accessible names and repeated disclosure. Five affected asset-tab snapshots updated. Browser journeys check full text containment and Enter/Space disclosure at all three widths. |
| ro-ln5l | `NormalBand` accepts a lower or upper bound alone and draws one limit marker. `alerts-board.test.ts` verifies stored-input mappings, missing inputs and fractional limits; `viz-kit.test.tsx` covers lower/upper limits and existing two-sided behavior. The browser checks readings 19 vs limit 70 and 80 words vs limit 400. |
| ro-vsah | `GET /api/alerts/daily` reads portfolio rows (`asset_id IS NULL`) through `WorkspaceStore.read`. Real PostgreSQL tests cover two populated workspaces in one database, a misleading workspace query parameter, independent site rows, complete totals, 150 days, rising/falling counts, gaps, zero, empty history, GET-only handling and errors. UI tests cover the dated data table, missing vs zero, loading, empty/error/retry, and retained data after a failed refresh. |

`apps/tower/e2e/alerts-evidence/journeys.spec.ts` uses the standard isolated fixture server and offline guard. Standard `test:journeys -- --list alerts-evidence` discovers three tests with no Playwright config change. A top-level type-only import includes the nested spec in the existing journey typecheck.

## Measured local commands

Node 24.21.0; pnpm 12.8.1; PostgreSQL 18.6; Playwright 1.63.0, Chromium revision 1243. Locked dependencies; synthetic fixtures only. Command wall time includes each command's own startup and cleanup; it is not CPU time or total elapsed work. A comparable complete-suite baseline was unavailable.

| Check | Result | Seconds |
|---|---|---:|
| Affected components, Alerts, history, asset tabs, language, navigation | 11 files, 304 tests passed | 16.00 |
| Follow-up after preserving fractional limit labels | 3 files, 84 tests passed | 12.30 |
| Relevant root contracts with `script-tests-setup` | 67 passed, 0 skipped | 8.40 |
| Standard journey discovery | 3 viewport tests discovered | 1.72 |
| Guarded browser captures | 390, 900, 1440px; 3 passed | 36.02 |
| Tower app, Worker and journey typechecks | Passed, including nested spec | 54.32 |

Exact argv and timings are in [commands.json](commands.json). The root run covers the Postgres model and workspace security, generated consumer inventory, neutrality, UI lexicon/nouns, and journey discovery/isolation. The consumer block in `db/postgres/consumers.md` was generated with `findConsumers`/`consumersMarkdown` and checked against current source. `git diff --check` and the neutral-code gate passed.

## Synthetic captures

| Width | Open board, one-sided limits and snapshot gaps | Expanded settled row |
|---|---|---|
| 390px | [Open](alerts-open-390.png) | [History](alerts-history-390.png) |
| 900px | [Open](alerts-open-900.png) | [History](alerts-history-900.png) |
| 1440px | [Open](alerts-open-1440.png) | [History](alerts-history-1440.png) |

The journeys also test the collapsed settled row before expanding it. Images are review artifacts; geometry/text assertions determine the test result.

## Limits and resource ownership

These are local builder checks. CI and the coordinator's independent verification remain separate. The full repository suite, bundled-app journeys and live provider/production behavior were not exercised. Browser JSON reads are synthetic; SQL and workspace isolation run against disposable PostgreSQL databases. Snapshot history covers its first through last stored UTC day, with unknown intervening days. It does not infer counts before or after that range, or derive history from current alerts.

No collection, retention, disposition, detection, threshold, severity or historical-evidence writes changed. No schema migration, production/provider request, task-store command, merge, deployment, main push, amended commit or weakened check was used.

Owned tooling/cache/temp paths are under `work/` and `node_modules/.cache/journey-playwright`; fixture clusters and servers use the existing harness cleanup. Test children completed and fixtures closed through their harnesses. Disk checks showed over 28 GiB free throughout heavy preparation. The temporary PostgreSQL binaries were extracted locally; no system service was installed. Pinned pnpm rejected `--no-runtime` and the offline metadata lookup failed; preparation completed with `fetch --ignore-scripts` and a normal frozen-lockfile install through the configured proxy. Earlier local fixture/type/assertion failures were corrected; passing follow-ups are listed above.
