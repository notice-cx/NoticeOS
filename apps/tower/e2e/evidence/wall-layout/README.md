# Independent Wall verification

Verified code: `df0e2074ec4f3cd7f16c3f5178ad951908e8d177`; audited base: `ae864db37cc8026a018043e688b62c3b15951870`. The published code commit is 5617e9452dc9a7822546e2f271c912dfbe69fde6, with the exact same Git tree bb90fd2c24d3aa910b399613d9e643167a3dffb1 as the verified local code. publication.json maps the local and GitHub App commit identities; only commit metadata differs. Review found no outstanding code findings or product blockers after the three-row normalization correction. The verifier changed no product/test files and created no commits.

| Final check | Result | Measured command seconds |
|---|---|---:|
| Wall reducer and editor-route rendering | 149 tests passed | 15.625 |
| Affected app and explicit nested journey types | passed | 44.914 |
| Standard Playwright --list wall-layout | 9 tests discovered | 1.431 |
| New guarded desktop/phone Wall journeys | 9 passed, 0 skipped | 102.976 |
| Existing shared TV-fit, drag/resize/save and dark-preview journeys | 3 passed, 0 skipped | 57.256 |

Exact commands, commit bindings and stdout/stderr are in per-check JSON files in commands/ and command output in logs/. Final commands total 222.202 measured command seconds; several ran concurrently, so this is not overall elapsed time or CPU time. No recent full-suite timing is available for comparison.

The first pass on e8bf6b98e4e5b986255603b2d5cee79afe63c810 also passed all five focused unit/rendering files (230 tests, 18.358 seconds), relevant root contracts (65 tests, 0 skipped, 2.325 seconds), pnpm generate -- --check (15.918 seconds), and full Tower app/worker/shared-journey plus explicit nested typechecks (71.348 seconds). The final delta changes only wall-editor.ts, WallPreview.tsx, the editor test and nested browser spec. Updated files were rechecked; passing evidence for unchanged schema/canvas/preset tests, configuration/fit/declaration contracts, generated siblings and worker/shared-journey types carries forward. Root copy checks remain applicable because no visible product strings changed in the final delta. The five unit files cover 231 cases including the added regression: 149 rechecked cases plus 82 unchanged cases. Root tests used --import ./scripts/script-tests-setup.mjs; checks used NOTICEOS_REQUIRE_POSTGRES=1.

Runtime: Node 24.21.0, pnpm 12.8.1, PostgreSQL 18.6, TypeScript 6.0.3, Vitest 4.1.9, Playwright 1.63.0, Chromium headless shell 153.0.8010.12/revision 1243. Existing lock-matched modules and the pinned disposable browser were reused. input-hashes.json and final-input-hashes.json hash exact Git-commit contents. Shared journeys and Playwright configuration have no diff from the audited base.

## Per-task evidence

- ro-qlv3: weighted full-width validation, persistence and rendering passed. Browser pointer/keyboard checks cover snap, conservative minimums, one Undo, Redo and restored geometry. Review discovered clamping small pair weights could resize the unrelated fill row. The final probe gives weights {strip:1.6,loop:1.95,body:12} for intended heights [104,128,784], producing [104.5402,127.4084,784.0514]: maximum error 0.59164 px. final-numeric-probe.json records the result. The added browser regression keeps the large fill row within 3 px during an actual short-row drag. The existing column-divider drag/save journey passes with its handle order preserved.
- ro-m2he: one site fits and eight warn at identical geometry on desktop/phone. Filtering eight sites down to one clears the warning without resizing. Six animation frames show no fit-note attribute churn, with no ResizeObserver errors. Review confirms the existing browser-safe fit measurement is scoped to content wrappers; mutation/font events schedule reads without a new poll timer, and warning/selection chrome sits outside observed content.
- ro-lkgf: default-fit-summary.json and fit-*.json bind all seven 1920×1080 variants. Business-column maximum gaps are 37, 20, 20, 41.40625, 37.015625, 32.703125, 36.15625 px for one, two, three, six, seven, eight, fire. Every side-column gap is 21 px. Every fixture has zero shared-audit ink/text clipping. Natural-height Work leaves remaining height for the existing revenue chart. Site rows remain fully reachable; eight sites retain existing internal scrolling, not a claim of simultaneous visibility. The separately preserved developer baseline has a 362 px empty side block.
- ro-x9se: all 41 gallery Wall roots have effective dark scopes and equal foreground/tokens in light/dark themes under both viewport projects. See specimens-desktop.json and specimens-mobile.json. Foreground is rgb(240,243,255), with black Wall background. The existing journey confirms the preview uses the TV's colors on a light desk.

## Captures and limits

Selected captures and extracted measurements are packaged in this directory. The complete guarded browser reports remain in work/wall-layout/verify/final-browser/ and work/wall-layout/verify/shared-browser/ in the execution workspace. Desktop/phone actual Wall/editor captures and desktop gallery captures were visually inspected. The phone actual Wall stacks without page-width overflow and the one/eight-site fit results appear in editor captures.

Do not publish mobile gallery wall-specimen-*-mobile.png files: Chromium's deep-gallery element capture selected an unrelated page region. All 41 computed mobile root/theme assertions passed, and actual phone Wall/editor captures are valid. This is an evidence-capture limitation, not a product color failure. Full CI, unrelated workspaces, the full browser suite and real installations/providers were not exercised locally.

## Resource boundary

Checks used disposable synthetic Postgres clusters/copies, guarded fixture servers, offline browser transport and fresh pinned-browser contexts. Owned runtime paths are this directory's home, tmp, cache, config, data, logs and report folders. Every runner exited 0 and closed its server/database/browser resources; tmp retains compilation/transform caches only. During verification there was no production/provider/installation access, migration, protected-policy change, task tracking, push, merge or deployment. No blanket cleanup was performed.

Selected images: before-one-tv.png, after-one-tv.png, after-eight-tv.png, wall-phone.png, editor-phone.png, fit-one-preview.png, fit-eight-preview.png, top-level-resized.png, short-rows-undo.png and specimen-{light,dark}-desktop.png. before-one-fit.json and baseline.log record the expected baseline failure before the default composition changed.

Refs: ro-qlv3, ro-m2he, ro-lkgf, ro-x9se
