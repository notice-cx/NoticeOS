# Site setup qualification

Synthetic UI evidence from independent verification of `4aef662e2ae3b6ae6305660eac0ebb66ed728e7a`, based on main `cf1279d70a702522043e55515c51e54a75d90377`.

[Verification receipt and actual timings](verification.md) · [final source/test hashes](final-input-hashes.json) · [capture dimensions and hashes](capture-manifest.json)

| Task | Result and regression proof |
| --- | --- |
| ro-ejju | Entity Add offers Id, Name, Legal form and Registered in. The insert omits `assets`; site Identity ownership operations pass. [Settings interaction/operation test](../../../test/settings-route.test.tsx). |
| ro-winz | Separate mark and content columns keep the mark beside the first lead line. [Geometry JSON](geometry/) records a maximum center difference of 0.5px, with text wrapping in the lead column. Ring/link, warning/button, neutral/no-action and closed variants are covered. |
| ro-xrnu | Sources with GA4 and PostHog opened and Tune with two disabled settings each count exactly one paused explanation. [Focused unit cases](../../../test/site-paused-saves.test.tsx), [browser assertions](../../site-setup-polish.spec.ts), and corrected captures below. |
| ro-ryiu | Booked costs with estimated-only revenue, ordinary booked revenue and absent estimates are covered by [Overview tests](../../../test/asset-overview-tab.test.tsx). Mixed views show “booked net so far” and “est. · unbooked”. Ledger calculations are unchanged. |
| ro-q9nu | Current DailyMeasureChart already passes; no renderer change. Same-date change/watch tests measure the first W and full label, require visibility and clipping containment, and exclude overlap with all change glyph/label/line targets. The 214px label fits; the nearest marker target ends 26px above it. [Geometry JSON](geometry/). |

## Captures

The standard captures are exactly 1440×900 or 390×844. Sources also has full-page captures of all opened rows; the gallery variant captures are cropped to their region. Sources/Tune images use the corrected capture pass; other images retain the passing unchanged-input qualification. [Manifest](capture-manifest.json).

| Surface | 1440 dark | 1440 light | 390 dark | 390 light |
| --- | --- | --- | --- | --- |
| Integrations | [View](images/integrations-dark-desktop.png) | [View](images/integrations-light-desktop.png) | [View](images/integrations-dark-mobile.png) | [View](images/integrations-light-mobile.png) |
| Site connect panel | [View](images/site-connect-dark-desktop.png) | [View](images/site-connect-light-desktop.png) | [View](images/site-connect-dark-mobile.png) | [View](images/site-connect-light-mobile.png) |
| Data sources — viewport | [View](images/sources-paused-dark-desktop.png) | [View](images/sources-paused-light-desktop.png) | [View](images/sources-paused-dark-mobile.png) | [View](images/sources-paused-light-mobile.png) |
| Data sources — all opened rows | [View](images/sources-paused-dark-full-desktop.png) | [View](images/sources-paused-light-full-desktop.png) | [View](images/sources-paused-dark-full-mobile.png) | [View](images/sources-paused-light-full-mobile.png) |
| Alert Tune panel | [View](images/tune-paused-dark-desktop.png) | [View](images/tune-paused-light-desktop.png) | [View](images/tune-paused-dark-mobile.png) | [View](images/tune-paused-light-mobile.png) |
| Current chart — coincident change/watch | [View](images/coincident-watch-dark-desktop.png) | [View](images/coincident-watch-light-desktop.png) | [View](images/coincident-watch-dark-mobile.png) | [View](images/coincident-watch-light-mobile.png) |
| Other StatusBanner variants | [View](images/status-variants-dark-desktop.png) | [View](images/status-variants-light-desktop.png) | [View](images/status-variants-dark-mobile.png) | [View](images/status-variants-light-mobile.png) |

## Scope and remaining checks

All five requested local acceptance criteria are qualified. The independent receipt records the initial stale test assertion and the capture correction, the focused follow-ups, selection skips, runtime versions and fixture cleanup. Full unrelated monorepo/Compose qualification was left to CI; no remote CI success is claimed by this receipt. No real installation or provider access was used.
