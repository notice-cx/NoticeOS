# Independent verification

Implementation commit: `5407f9f6ac77561848bfd4bdd7dec75e616c1cdb`.
Base: current `origin/main`, `537e080c82e8dca66583477e1d7d212fbc336c51`.
Refs: ro-ujb9.96.20

The independent verifier reviewed the source and ran the checks below against the implementation's exact input hashes. No blocking runtime defect remained. The change mounts the existing owner-bound `useFinancials` consumer only while the comparison is open, uses the preceding calendar month's normal cache key, matches source/family/currency identities exactly, and calculates money in integer minor units. Missing records remain unknown. Currency totals compare recorded amounts separately; source differences reconcile when both months contain the matched records. Added or absent records have no invented source difference. Open-month copy describes month-to-date costs against the complete previous calendar month, without a savings or performance claim.

## Qualified environment

Node `24.21.0`, pnpm `12.8.1`, Vitest `4.1.9`, PostgreSQL `18.6`, and the repository's Playwright `1.63.0` Chromium `153.0.8010.12` were used. Dependencies match `pnpm-lock.yaml`. All fixtures are isolated and synthetic. No existing installation, provider account, production store or task database was accessed. Comparison requests were reads only; fixture reset/setup used disposable synthetic stores.

Commands ran from the repository root with this test environment:

```sh
PATH="$PWD/work/toolchain/bin:$PWD/work/toolchain/postgres/usr/lib/postgresql/18/bin:$PATH"
LD_LIBRARY_PATH="$PWD/work/toolchain/postgres/usr/lib/x86_64-linux-gnu"
HOME="$PWD/work/runtime/home"
XDG_CACHE_HOME="$PWD/work/runtime/xdg-cache"
XDG_CONFIG_HOME="$PWD/work/runtime/xdg-config"
XDG_DATA_HOME="$PWD/work/runtime/xdg-data"
TMPDIR="$PWD/work/runtime/tmp"
NOTICEOS_REQUIRE_POSTGRES=1
JOURNEY_WORKERS=2
```

The execution environment's additional network permission was enabled for test subprocess support. Browser and fixture offline/isolation guards remained enabled and passed. Root contracts retained the required preload.

## Commands and results

| Command | Result | Measured wall time | Log |
| --- | --- | ---: | --- |
| `pnpm --filter @noticeos/tower exec vitest run test/cost-comparison.test.ts test/cost-comparison-panel.test.tsx` | 20 passed; 0 skipped | 4.103 s | [focused-tests.log](focused-tests.log) |
| `pnpm --filter @noticeos/tower run typecheck` | App, Worker and normal journey checks passed | 51.036 s | [tower-typecheck.log](tower-typecheck.log) |
| `pnpm --filter @noticeos/tower exec tsc -p ../../work/cost-comparison-journey-tsconfig.json` | Nested journey and fixtures passed strict types | 5.737 s | [nested-journey-typecheck.log](nested-journey-typecheck.log) |
| `pnpm --filter @noticeos/tower run test:journeys -- --list monthly-cost-changes` | Existing CI configuration discovered 8 tests in the requested nested spec | 1.260 s | [ci-discovery.log](ci-discovery.log) |
| Root contract command below | 46 passed; 0 skipped | 5.762 s | [root-contracts.log](root-contracts.log) |
| `pnpm --filter @noticeos/tower run test:journeys -- monthly-cost-changes` | 8 passed; 0 skipped; 2 workers | 22.528 s | [journeys.log](journeys.log) |

```sh
node --import ./scripts/script-tests-setup.mjs --test \
  scripts/ui-lexicon.test.mjs scripts/ui-noun.test.mjs \
  scripts/component-registry.test.mjs scripts/journey-runner.test.mjs \
  scripts/journey-isolation-guard.test.mjs scripts/journey-browsers.test.mjs \
  scripts/ci-contract.test.mjs scripts/docs-index.test.mjs
```

The temporary nested-spec typecheck extended `apps/tower/e2e/tsconfig.json`, included `apps/tower/e2e/monthly-cost-changes/**/*.ts` and the normal Worker globals, and resolved inherited type libraries through the Tower's existing `node_modules/@types` and `node_modules`. No committed configuration was edited or check weakened.

The focused tests cover unchanged, increased and decreased costs; added and absent records; unknown labels; recorded zero; missing history and missing costs; failed reads and last-good data after failure; currencies; January rollover; exact identities and cent reconciliation; delayed mounting and normal cache reuse. `financials-route.test.tsx` was not used.

The browser checks cover 390px and 1440px, both themes, the recorded-cost view and unavailable history. Each successful comparison recorded exactly the initial September read plus one August read, including close/reopen, and no writes. Geometry checks found no horizontal overflow or clipped comparison text. The initial browser qualification also passed 8/8 in 25.366 s; its report was overwritten by the root runner's discovery test. The final browser run above regenerated and preserved the required artifacts. No further discovery or runner command ran afterward.

No recent full-suite baseline was measured, so no local CPU-reduction percentage is claimed. These are focused local checks; remote CI and the full repository gate remain separate qualifications.

## Browser evidence

| Project | Theme | Screenshot | Geometry and requests |
| --- | --- | --- | --- |
| Desktop, 1440px | Dark | [desktop-dark.png](desktop-dark.png) | [desktop-dark.json](desktop-dark.json) |
| Desktop, 1440px | Light | [desktop-light.png](desktop-light.png) | [desktop-light.json](desktop-light.json) |
| Mobile, 390px | Dark | [mobile-dark.png](mobile-dark.png) | [mobile-dark.json](mobile-dark.json) |
| Mobile, 390px | Light | [mobile-light.png](mobile-light.png) | [mobile-light.json](mobile-light.json) |

The independent verifier visually inspected mobile/light and desktop/dark screenshots. The comparison text and amounts fit their containers. The synthetic fixture uses unclassified provenance for its cost rows, so the existing composition's provenance chips show **No source**; comparison identities and labels still use the recorded source keys.

[Input hashes](input-sha256.txt) cover the source, tests, fixture, documentation and lockfile. [Artifact hashes](artifact-sha256.txt) cover every screenshot and geometry attachment. Source/test/fixture/lock hashes were checked again after all successful checks and matched.

## Owned-resource cleanup

The normal fixture teardown completed successfully, including offline/isolation checks, browser/context closure, fixture-server shutdown and disposable PostgreSQL cleanup. The owned temporary directory contained only Node and Playwright compilation caches afterward, with no fixture database/server folders. The verifier's temporary guidance file and empty scratch directory were removed. Test homes, caches, logs, the qualified toolchain and the pinned test browser remain under owned `work/` or repository test-cache paths for reuse. No existing resource was removed.
