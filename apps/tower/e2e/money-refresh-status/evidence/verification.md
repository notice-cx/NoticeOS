# Money retained-read status verification

Refs: ro-ujb9.96.18

Independent verifier reviewed the outer Money read-state change and ran the focused checks. No product findings remain. Browser and nested-spec typecheck inputs are commit `47857cab9f82c9f61171be2f9f2fc5e79aed8b4f`, based on current/audited main `537e080c82e8dca66583477e1d7d212fbc336c51`.

## Checks

All checks passed; no tests skipped. Tower rendering/interaction tests: **109/109** across financials-route, read-failed and freshness. Root contracts: **59/59**. Guarded browser journeys: **6/6**, including both desktop/mobile projects and dark/light themes. Normal CI discovery listed all six tests from the nested `money-refresh-status/journeys.spec.ts` without tracked configuration edits.

| Check | Measured wall time | Result |
| --- | ---: | --- |
| unit | 9.793 s | passed |
| typecheck | 49.978 s | passed |
| root-contracts | 5.971 s | passed |
| discovery | 0.939 s | passed |
| nested-types | 5.491 s | passed |
| browser | 37.619 s | passed |

Exact commands (from repository root, after `. /workspace/.noticeos-tools/activate.sh`; tests use `NOTICEOS_REQUIRE_POSTGRES=1`, browser uses `JOURNEY_WORKERS=2`):

```sh
pnpm --filter @noticeos/tower exec vitest run test/financials-route.test.tsx test/read-failed.test.tsx test/freshness.test.ts
pnpm --filter @noticeos/tower run typecheck
node --import ./scripts/script-tests-setup.mjs --test scripts/ui-lexicon.test.mjs scripts/ui-noun.test.mjs scripts/neutral-code-gate.test.mjs scripts/journey-runner.test.mjs scripts/journey-isolation-guard.test.mjs scripts/journey-browsers.test.mjs scripts/journey-port.test.mjs scripts/journey-handler-failure.test.mjs
pnpm --filter @noticeos/tower run test:journeys -- --list -g 'Money refresh status'
pnpm --filter @noticeos/tower exec tsc -p /workspace/NoticeOS/work/money-refresh-status/verifier/tsconfig.journey.json
pnpm --filter @noticeos/tower run test:journeys -- -g 'Money refresh status'
```

The temporary nested-spec TypeScript project extends `apps/tower/e2e/tsconfig.json`, includes the new nested spec and existing worker globals, and selects the same type libraries by absolute paths because its location is outside Tower. It changes no repository configuration. Logs are in `logs/`; machine-readable commands, timings and input hashes are in `verification.json`. `git diff --check` passed.

The earlier unit/typecheck/root checks were retained across a mock-factory indentation-only edit and browser-fixture debugging. The product source remained byte-for-byte unchanged. The final nested-spec typecheck and browser qualification used the committed final spec.

## Acceptance evidence

- The actual query succeeds, starts a pending refresh, exhausts its production retries after 503 responses, and retains the figures, selected August month and URL through failure.
- Exactly one accessible status names the failed refresh, retained month and last successful read. Its `<time datetime>` remains the earlier `dataUpdatedAt`, differs from the payload's old `generatedAt` and the later failed-attempt time, and advances only after a successful recovery.
- Retry is keyboard reachable and activates with Enter. Native disabled state blocks repeated clicks while fetching; the unit case also proves the synchronous guard before the query observer rerenders. Recovery uses no page reload or additional main-frame navigation.
- A pending July selection leaves August figures and selector labelled August with a separate “Loading July 2026” status. Missing-month refusal shows its distinct available-month link; initial 503 failure uses ReadFailed and in-place retry, without a successful-read timestamp.
- A successful HTTP retry leaves the same synthetic estimates and “none confirmed yet” state. The UI makes no claim that provider inputs became fresh.
- Independently viewed all four screenshot attachments: one concise status directly above retained figures, readable in both themes, with no clipped status text or horizontal overflow. Geometry assertions passed in every combination; mobile retry height is 44 px, desktop 32 px. Desktop viewport: 1440×1000; mobile: 390×844.

Screenshots and geometry are the matching `desktop-dark`, `desktop-light`, `mobile-dark` and `mobile-light` PNG/JSON pairs beside this receipt.

## Isolation, resources and limits

Node 24.21.0; pnpm 12.8.1; PostgreSQL 18.6; Playwright 1.63.0; pinned Chromium 153.0.8010.12. Existing lock-matched dependencies and one checkout browser bundle were reused. At least 30 GiB remained free before/after qualification.

All data was synthetic. Browser tests used the shared per-worker fixture servers, reset controls, offline origin guard and isolation assertions. No existing installation, provider account, production service or local task MCP was accessed. No bd/bv/br was used. Verification owned HOME, XDG and TMPDIR below `work/money-refresh-status/verifier/`; all test subprocess runners exited successfully, and the existing Postgres/global-setup and fixture-server harnesses awaited shutdown. Thirteen inactive owned neutral-gate fixture directories were removed. Only reusable Node/Playwright transform caches remain in the verifier's temp directory; the shared pinned browser bundle is retained.

This is focused local qualification, not a full repository suite or remote CI result. No comparable full passing baseline is available in the prepared environment, so no execution-saving percentage is claimed. Provider collection and production behavior are outside these isolated tests.

## Final input SHA-256

| Input | SHA-256 |
| --- | --- |
| `apps/tower/src/routes/FinancialsRoute.tsx` | `9ef284c528b6ce2b83e2504c841ada631c18af907101e1765cc0bec496b4b924` |
| `apps/tower/test/financials-route.test.tsx` | `c5241d79e08e52a10ce4ba3f9c83ca2e2a0260bbb0dcff3f1a50bdff144152f3` |
| `apps/tower/e2e/money-refresh-status/journeys.spec.ts` | `fd38cf251627aedf259bcf132e8e462972e71813ed0e422b26ce8326c5aa52a4` |
| `pnpm-lock.yaml` | `4ba97abdb1f6b93e06be7c54329a360697a00abce1ac90183dd96ac6aa4389d2` |

## Temporary nested-spec project

The untracked project used for the explicit nested-spec check:

```json
{
  "extends": "../../../apps/tower/e2e/tsconfig.json",
  "include": [
    "../../../apps/tower/e2e/money-refresh-status/journeys.spec.ts",
    "../../../apps/tower/test/worker-globals.d.ts"
  ],
  "compilerOptions": {
    "types": [
      "/workspace/NoticeOS/apps/tower/node_modules/vite/client",
      "/workspace/NoticeOS/node_modules/@types/node",
      "/workspace/NoticeOS/apps/tower/node_modules/@testing-library/jest-dom"
    ]
  }
}
```
