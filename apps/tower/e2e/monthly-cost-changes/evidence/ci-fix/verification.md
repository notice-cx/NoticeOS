# CI follow-up verification

Refs: ro-ujb9.96.20

The Tower job exposed an existing route assertion that the cost panel contains no buttons. Commit `d14759c94294188fc3caadf9d5418ddf6dd7aedc` uses native `details`/`summary` for the expandable comparison, retaining lazy query mounting and cache reuse. The standalone cases and guarded journeys exercise native disclosure toggling. The existing financials route test was not edited.

The scripts job exposed the status-subject contract: each hand-rendered `role="status"` needs `data-status-for`. The follow-up supplies `cost-comparison:<previous period>` for all four loading/error/missing-record states. Standalone cases assert the subject marker, and the existing root contract remains unchanged.

Independent verification of the [recorded source inputs](input-sha256.txt), using the pinned tools and isolated synthetic fixtures described in the [initial receipt](../verification.md):

| Command | Result | Measured wall time |
| --- | --- | ---: |
| `NOTICEOS_REQUIRE_POSTGRES=1 pnpm --filter @noticeos/tower exec vitest run test/cost-comparison.test.ts test/cost-comparison-panel.test.tsx` | 20 passed, 0 skipped | 5.969 s |
| Root contract command below | 49 passed, 0 skipped | 4.724 s |

```sh
node --import ./scripts/script-tests-setup.mjs --test \
  scripts/ui-lexicon.test.mjs scripts/ui-noun.test.mjs \
  scripts/component-registry.test.mjs scripts/status-subject.test.mjs \
  scripts/journey-runner.test.mjs scripts/journey-isolation-guard.test.mjs \
  scripts/journey-browsers.test.mjs scripts/ci-contract.test.mjs \
  scripts/docs-index.test.mjs
```

The native disclosure also passed `pnpm --filter @noticeos/tower run typecheck` and all eight guarded comparison journeys (390px/1440px, both themes; Playwright-reported duration 44.9 s). That browser evidence was carried forward across the subsequent status-subject attribute additions; no amounts, query behavior or layout changed. [Focused test log](focused-tests.log), [root contract log](root-contracts.log), [native disclosure journey log](native-disclosure-journeys.log).

A diagnostic full root run identified the missing status subjects alongside cloud-only failures involving file permissions, extracted PostgreSQL libraries and process cleanup. It is not reported as a passing full qualification. The PR's remote CI remains the full repository qualification. The flow job's earlier failure occurred during browser installation before its tests; the browser job installed the same browser successfully. No CI configuration, test requirement or gate was relaxed.
