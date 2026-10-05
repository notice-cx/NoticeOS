# 12 — Implementation readiness

*The bridge from design (docs 00–11) to Phase 0 ([doc 07](07-roadmap.md)):
what exists, what's missing, who owns each gap, and the questions the design
deliberately surfaces for the operator instead of assuming answers. The
implementation status below was verified from this repo on 2026-07-30. The
five-repo scout is a historical 2026-07-03 snapshot and is now expired.*

## Current implementation status (verified 2026-07-30)

| Build block | Current state |
|---|---|
| Central store | **Partial:** Phase-0 assets, pulses, flags, ledger, annotations, counter readings, append-only GA4/GSC/Bing observations, private R2 archive manifests including DataForSEO cost evidence, compact executive snapshots, and pre-registered watch windows landed through migration 0012. Ledger replay/reconciliation integrity gaps closed with migrations 0018 and 0020 ([doc 19](19-architecture-implementation-ux-audit.md) finding 1). |
| Accountable repo | **Landed:** context pack, CI, strict TS, tests, and builds. |
| Cron/ingest workers | **Partial:** pulse ingest, freshness, two per-property pull adapters, asset-#0 report, revenue CSV/JSON, fast counters, 15-minute GA4/GSC, daily Bing Webmaster, daily 25-family GA4/GSC/BWT raw archives (including one exact rolling 28-day GA4 event-user aggregate), weekly five-family DataForSEO ranking/backlink/LLM archives with fail-closed cost control, and private non-persistent GA4 current-display RPC reads landed. The display path combines exact 30-/5-minute Realtime windows with a bounded Core hourly today/7-days-ago comparison. On 2026-07-30 the real DataForSEO run stored 20/20 families for the four then-launched properties at $1.122772. On 2026-08-05 the operator confirmed property 5 live while retaining `sense_only=1`; its first scoped run stored all six configured families with no failures at $0.380940, including a 15-term × two-device SERP panel. The operator annotation writer and the daily watch-window evaluator (migration 0012; site-scope metrics only, closing outcomes surfaced as `watch-window-closed` flags) landed 2026-07-31, as did the sixth DataForSEO family — a config-gated tracked-query SERP panel (`config/serp-panel.json`, property 1's head terms at ~$0.004 each, one live desktop result page per term with AI Overview citation state). Also 2026-07-31, per the audit brief (private historical evidence): the GA4 `js-errors` family (F5 — event-parameter dimensions; `message`/`source` registered as custom dimensions on properties 1 and 2 that day, the other three properties still unregistered, so the `ga4_custom_dimension_unregistered` state stays live and applies per date because GA4 never backfills) and two more panel terms (F6 — 20). **The panel's first collection landed 2026-07-31T20:34:50Z** (manual local run, 436 provider rows, $0.0705): AI Overview present on 12 of 20 terms, citing property 1 on 5, one term unknown after a provider-side error. `where to find free meal plans` returned `aio_present=true` / `aio_cites_us=false` with no rank inside depth 20 — the direct evidence F1's zero-click question needed. The **Clarity** lane also landed 2026-07-31 (F9): operator-sanctioned migration `0016` widened the manifest `integration` CHECK, and `clarity-dumps.ts` runs on a new `30 4 * * *` cron — one Data Export call per configured project per day (the provider's cap is 10/project/day), URL-split, archived verbatim, with unconfigured properties skipped silently. The operator replaced the flat `CLARITY_PROJECT_API_TOKEN` with the canonical per-asset `CLARITY_TOKENS` map on 2026-08-04 (`ro-1zf`; probe verified through the map slot the same day), so any property joins by adding one line to that map. *Correction 2026-08-01: this row previously said `creds-check.mjs` probes only the map name and misreports a working lane — commit `1b6d347` (2026-07-31) taught it both shapes with the collector's precedence, and did not update this row.* *Correction 2026-08-04: the panel's **phone** device dimension landed that day (`ro-o1n`) — every tracked term is now read on mobile and desktop, one call per (query, device) into the same single archive and manifest row, with `device` carried in the archived request body and out to the flattened CSV. Landing beside the same day's property-2 panel grow (`ro-1yt`, 20 → 23 terms), the two panels now buy 102 calls a Monday, ~$0.41/week, and the query ceiling halved from 40 to 31 — what the unchanged $0.25 per-report reserve buys at two calls a term. Both downstream halves landed the same day: the executive snapshot's two panel readers now resolve per device (`ro-14d.1`, one AI-Overview reading per device on the query-decision join, one row per (query, device) on the Tower's panel block, with the striking-distance gate withholding on ANY uncited surface), and the Tower renders the split as one AI-Overview glyph per surface — phone then desktop — on both `SerpPanelBoard` and `QueryVisibilityRankings` (`ro-e46.2`, design recorded in [doc 17](17-ui-lexicon.md)). The panel's counts stayed term-counted through the change, so nothing on the page divides by a doubled denominator. **First real two-device data lands the following Monday**; everything above is proven against fixtures.* *Correction 2026-08-04: query-scoped GSC watch windows now read exact provider-final daily rows from the retained `gsc/query` R2 archive; missing days remain missing and unsupported scopes still close `unmeasurable`, with no site-wide fallback (`ro-5e8.7`).* The kill-criteria lanes have not landed. |
| Tower | **Partial:** Home/Wall expose a local clock, a shared configurable/read-only countdown, today-first Property cards with a full-day same-weekday reference, equal-hours pace, truthfully labeled stock groups, independently refreshed GA4 30-/5-minute active-user counts, supporting 28-day trends, and Needs Attention; the Portfolio ROI band renders again as of 2026-08-02 (bead `ro-qes`) with the headline over reconciled rows only and estimates in a separate labelled forecast block, while the still-uninstrumented System band is retained but hidden. Property 2's detail view now separates current catalog scope from exact 28-complete-day product-use/share stage signals without claiming cohort conversion. Applied Home/property changes converge on the Wall's 60-second payload poll; current GA4 display data uses an isolated 30-second query with last-good behavior while exact DAU remains on the 15-minute durable lane. Integrations, 90-day executive property detail with a compact DataForSEO search-intelligence strip and copyable deterministic findings, alert lifecycle, and collapsed config staging landed. Queue, registry, learning, phone approvals/kill switch, and later-phase objects have not. |
| Gateway/agent runtime | **Not implemented.** D1 remains a local pilot; no recurring builder should run without the fail-closed gateway. |
| Verifier venue | **Partial:** CI re-executes repository gates. There is no independent task verifier/evidence store. |
| Revert rails | **Not implemented.** |
| Attribution toolkit | **Not implemented.** |
| Per-asset onboarding | **Partial:** two self-report pull nodes are configured locally; the independent central GA4/GSC lanes are live for all five properties. Current remote self-report endpoint state and asset context packs were not re-verified in this audit. |

Both Wrangler configs contain the all-zero D1 placeholder. Phase 0 has not
exited on repository evidence: there is no checked-in proof of 14 clean days
for two properties or a full reconciled calendar month.

## Historical five-node scout (scouted 2026-07-03; expired)

Every external fact in this section is **unknown until re-verified**. It is
retained as historical reconnaissance, not current STATE.

| Node | Stack | Pulse readiness | Revenue today | Onboarding notes |
|---|---|---|---|---|
| **Property 1** | Vite/React + Workers + D1 + Clerk | `/api/admin/overview` exists; needs contract envelope + nightly push + flags. Sense raw material live (2026-07-04): `js_error` GA4 telemetry, `tracker_log_open`, `affiliate_click` (+ Discord webhook opt-in), `scripts/clarity-export.mjs` snapshots | AdSense-eligible traffic; **CJ LIVE 2026-07-04** (Magnifique, per-placement SID attribution — the revenue lane's first API-readable source); Amazon OFF; a subscription later | Reference node. Deepest CI (295 DOM + smoke both viewports + integrity guards) → first T2 candidate (`content-data`). GA4+GSC+Clarity live. The 2026-07-04 Clarity→fixes cycle (dead-clicks/quickbacks → 4 scoped agents → re-verified gate) is the Sense→Decide→Act→verify loop executed manually — Phase 0 mechanizes exactly that. |
| **Property 2** | Vite/React + Workers, **no D1, no auth** | Onboarded from [doc 09](09-onboarding-a-site.md)'s template: Analytics Engine counters + endpoint + push | AdSense application pending (dated STATE fact); affiliate beacon live | S1 panel already implemented in-repo (port it). GA4 live. The contract's heterogeneity proof. |
| **Property 3** | Vite/React + Workers | No pulse; no onboarding doc — needs the doc-09 treatment | Ads-intended (orphaned-demand play) | Analytics inventory unverified. Likely a light node: Sense-only until revenue exists. |
| **Property 4** | Vite/React + Workers (+ API/MCP heritage shared with property 1) | No pulse; no onboarding doc | Ads/affiliate-intended | Analytics inventory unverified. Template parent of property 5 — onboard together, share the work. |
| **Property 5** | property-4 fork + Worker SSR + D1 lookups; **pre-launch** (P0 scaffolded) | No pulse; no onboarding doc | None (pre-launch); ad+affiliate intended — finance monetizes best in the portfolio | **YMYL-finance: the strictest invariants in the portfolio.** Its data-confidence discipline (verified/cross-checked/unverified labels, never publish unverified routing data, noindex candidate lanes) is `AGENTS.md` raw material and must become hard invariants before any agent touches content. Sense-only node until launch. |

## Build blocks (target architecture), in dependency order

1. **Central store schema** — freeze docs 00/02/05 shapes into D1 migrations.
   **Phase-0-LIVE tables** (what the Phase-0 exit actually exercises):
   assets, pulses, flags (queryable rows w/ disposition — doc 02), ledger
   revenue/cost, annotations. The first external-signal slice (GA4/GSC daily
   metrics plus collector-run health) landed in migration 0005; migration 0006
   extended the same append-only store to Bing Webmaster. Migration 0007
   indexes deep private-R2 Google archives, 0008 stores only their compact
   content-addressed executive read model, and 0009 extends the same archive
   manifest contract to BWT. Migration 0010 extends the archive vocabulary to
   DataForSEO; 0011 indexes exact metered-provider cost for cap enforcement.
   **Scaffold-later** (numbered migrations land when their phase does): the
   wider signals family (tracked SERP-neighborhood panels and deeper
   backlink-reclamation rows; broad ranking/link/LLM snapshots have landed),
   changes (hypothesis card, change entry and registry row share one id,
   doc 00; the change entry is the ledger's third kind, D36, modelled in
   `db/postgres/` and booked when a change ships, with the prediction it
   shipped with, D38), reliability ledger, WIP/deferral
   registry, holdouts, plus the docs-15/16 objects: runbooks + grants,
   scout finds, investigations/cause reports, commissions, research briefs,
   layout/config versions (landed in migration 0029: config is a store
   document, seeded from the installation folder or the `config/` defaults and
   exported back to the installation folder — doc 06).
2. **This repo becomes an accountable codebase** (the bootstrap rule): its own
   `AGENTS.md`, CI bar, and task contracts from commit #1 — the accountability
   system must not be built unaccountably.
3. **Cron workers**: pulse ingest + freshness flags; GSC/GA4/Bing/Clarity pulls;
   tracked SERP panel where broad DataForSEO inventory is insufficient
   (**landed 2026-07-31** as the `serp-panel` family on the existing weekly
   DataForSEO cron, config-gated per property in `config/serp-panel.json`;
   **phone and desktop since 2026-08-04** (`ro-o1n`: one call per query per
   device, one archive, one manifest row, and a query ceiling of 31 because the
   $0.25 per-report reserve did not move), and property 2's `serp-panel.mjs` was
   reimplemented centrally rather than ported);
   revenue ingest; watch-window evaluation; kill-criteria checks.
4. **The Tower** ([doc 10](10-control-tower.md)): Wall → queue → registry →
   asset detail → phone mode, reading the store only.
5. **Gateway**: AI Gateway (or LiteLLM-class) with fail-closed caps + velocity
   breaker + fallback chain ([doc 06](06-operations.md)) — before any
   recurring agent runs, not after.
6. **Verifier venue**: the re-execution runner for gate commands
   (GitHub Actions is the default answer — a CF Worker can't run `npm run
   build`). Includes the artifact/evidence store for claims.
7. **Revert rails**: revert automation via the App per asset (constrained by
   the deploy-model decision, D2 below).
8. **Attribution toolkit**: cohort bucketing + holdout designation on the two
   big corpora (property 1's recipes/foods; property 2's items) — holdout tables live in the
   central store, outside asset repos, per [doc 01](01-architecture.md).
9. **Per-asset onboarding ×5**: pulse endpoint + push + `AGENTS.md`
   (with `reviewed:` + STATE sections). Write doc-09-style onboarding records
   for properties 3–5.

## Operator decision list (blocks that are yours, not code)

| # | Decision | Why it blocks | Default proposal |
|---|---|---|---|
| D1 | **Where the OS runs agents + billing model** — scheduled cloud (Actions/CF cron + API billing) vs your machine (subscription). *Status: deferred 2026-07-03, operator thinking.* Decided regardless: the intelligence-tiering principle ([doc 05](05-execution-and-accountability.md)) — frontier models for the hardest problems + tool authorship; cheap/local models operate the tools — which narrows D1 to "where do the frontier runs happen," since tool execution is substrate-trivial | Determines the execution substrate, the cost structure (order-of-magnitude), and whether "without oversight" is even mechanical | Cloud/scheduled for Sense/Decide crons; builder runs on Actions with API billing behind the gateway; revisit at Phase 3 with real cost data |
| D2 | **Resolve never-push vs T2** — today: agents never push, you push, CI deploys main on push. T2 auto-merge = deploy under that CI. *Sharpened by the runbook trust model ([doc 05](05-execution-and-accountability.md)): push/merge rights are granted to **approved runbook versions**, never to agents — the amendment becomes "runbook X (v N), which I reviewed, may merge class Y on asset Z," which is a far smaller grant* | T2 is impossible without amending a standing portfolio rule; must be your explicit, per-asset sign-off | Branch protection + App-merge scoped to approved-runbook manifests only; asset CI unchanged (merge = deploy); the grant is recorded in the runbook manifest + the asset's `AGENTS.md` |
| D3 | **Concurrency discipline** — OS agents vs interactive Claude sessions on the same repo (this week ran both, coordinated by hand) | Un-coordinated writers corrupt each other's work | OS works on branches only + a repo-level advisory lock file the interactive convention respects; OS defers when the lock is fresh |
| D4 | **Canonical remotes** — confirm all five repos are pushed to GitHub where the App can reach them | The OS cannot operate a laptop-only repo | Verify + push any stragglers during Phase 0 |
| D5 | **Revenue-account plumbing** — AdSense/CJ/Raptive/Mediavine reporting under which entity; is the LLC paperwork done enough for the reporting APIs to exist | The ledger's revenue lane blocks on accounts, not code | Inventory during Phase 0; ledger launches with whatever reporting exists (even manual monthly CSV) rather than waiting for perfect APIs |
| D6 | **The budget number** — monthly OS appetite (inference + data), which sizes every cap in doc 06 | Fail-closed caps need values | Propose: data plane ≤ $25/mo; inference cap $100/mo Phase 0–2, revisited at Phase 3 with cost-per-landed-change data |
| D7 | **Config constants**: `OPERATOR_RATE`, explore-sleeve %, first T2 class | Scoring + ladder need them | $2/min · 15% · `content-data` on property 1 |
| D8 | **Analytics inventory** — GA4/GSC access is now verified for all five properties; Clarity remains unverified outside property 1 | Sense lanes per node | Keep the proved Google map current; audit/install Clarity during each remaining node onboarding |
| D9 | **Weekly review block** — the actual calendar slot the T1 SLA references | The review SLA is a promise to a calendar, not a vibe | You pick; the Tower digest lands the evening before |
| D10 | **DR posture** — asset D1 backups + central-store backup cadence | Untested backups are hopes | Nightly D1 export to R2, quarterly restore drill (asset #0 task) |

## Original Phase-0 sprint checklist

This is the original execution order, not a current completion checklist. Use
the verified status table above for current state.

1. Accounts pass (yours, ~1 sitting): a GitHub org + GitHub App; CF zone +
   Access for the OS's own hostname; AI Gateway; Google signal service
   accounts enrolled in GSC + GA4 and stored once in the central account map;
   Clarity tokens; Discord webhooks; DataForSEO creds moved to the central
   secret store. Decisions D1–D7 recorded (one line each is enough — they
   become the first config commit).
2. Repo scaffold: store migrations + `AGENTS.md` + CI (the bootstrap rule).
3. Property 1 pulse: envelope + push + flags (the doc-02 retrofit) + its
   `AGENTS.md` distilled from living memory.
4. Property 2 pulse per doc 09 + `AGENTS.md`.
5. Ingest-freshness flags + asset-#0 pulse (the OS watches itself before it
   watches anything else).
6. Revenue lane v0: whatever reporting D5 surfaced, even manual CSV ingestion
   — a real P&L for one calendar month is the phase exit, not API elegance.
7. First Wall iteration (portfolio band + asset cards + attention band) — TV
   on the wall, day one; it motivates everything else.

*Exit criteria are [doc 07](07-roadmap.md) Phase 0's — this checklist is how,
that doc is whether.*

## Expired external-facts register

All entries below are historical and **unknown as of 2026-07-29** unless a
newer source is added.

- Property 5 state = "P0 scaffolded, pre-launch" (2026-07-03), superseded by
  the operator's 2026-08-05 live confirmation and guarded local asset-state
  changeset; the historical row above remains a snapshot, not current STATE.
- Property 2 AdSense = "application pending, re-review ~2–4wk" (2026-07).
- Property 1 affiliates (2026-07-04): Amazon OFF; **CJ Magnifique LIVE** on
  recipe appliance-moments + meal-plan/calculator meal-prep surfaces, product
  cards fed by `gen:magnifique`; per-placement SID attribution in CJ reports.
- Clarity Data Export quotas verified 2026-07-04: 10 calls/project/day, 72h
  window, 1,000 rows — snapshot-to-store is mandatory, not a preference.
- Raptive 25k / Mediavine $5k eligibility thresholds (late 2025 policies).
- All five repos scouted on this date; verify before Phase 0 starts if weeks
  have passed.
- **Repo-local correction (re-verified in config 2026-07-29):** the Property 1 row's
  "`/api/admin/overview` exists" is true but useless for Sense — that endpoint
  is gated by a Clerk session JWT + admin allowlist, which no machine cron can
  mint. The machine-scrapable self-report is `GET /api/internal/metrics`
  (a static bearer — that property's worker's `ASSET_TOKEN` since the 2026-08-05
  token-map collapse, `METRICS_SCRAPE_TOKEN` before it — Prometheus text,
  per-table totals + 24h/7d windows); the Phase-0 pull adapter is configured to
  target it (`config/pull.json`). The remote endpoint itself was not re-verified.
