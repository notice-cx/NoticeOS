# 02 — The signal contract

*One capability-agnostic contract covering everything the Sense stage
ingests: asset reports, centrally-pulled external signals, revenue & cost, and
timeline annotations. Every asset sends data in the same **shapes**, so adding
a property means pointing NoticeOS at its report, not writing an integration.*

## Glossary

- **Pulse** (`PulseEnvelope`, the `pulses` table) — the code's name for an
  asset's nightly report: what the asset's own infrastructure can measure
  (worker counters, first-party DB rows, storage counts). It never contains
  client-side analytics or external API data about the asset. From here on,
  this doc uses "report" for it.
- **Signal** — anything NoticeOS pulls centrally about an asset: GSC, GA4,
  SERP panels, backlinks, revenue reports. Signals are joined to reports on
  asset id.
- **Metric** — one named series inside a report or signal.
- **Flag** — a computed anomaly with **severity** (`info | warn | error`) and
  **kind** (`anomaly | opportunity | milestone`) as separate fields, because a
  mixed enum cannot be thresholded; milestone-kind flags are always
  info-severity. The report JSON carries
  flags **in transit**; the central store saves them as separate
  queryable rows with disposition fields (mark-read/ack, snooze, tune,
  incident, hypothesis + `resolved_at`) — the triage loop and per-rule
  false-positive rates need flags in a table, not inside stored JSON.
- **Annotation** — a timeline event: deploy, model-version change, config/
  pricing change, incident, autonomy-tier change. Annotations are stored as
  their own records because attribution ([doc 03](03-attribution.md)) is
  impossible without them.

## The pulse

Capability-agnostic: an asset declares the metric families it can measure and
how (`d1 | analytics-engine | r2 | kv`). Storage is an implementation detail —
Analytics Engine `writeDataPoint()` is the minimum for assets without a
database; assets with D1 keep using D1.

```jsonc
{
  "asset": "example.com",
  "generatedAt": "…",
  "capabilities": ["signups", "plansSaved", "foodLog", "leads", "feedback"],
  "metrics": { "<name>": { "last24h": 0, "avg7d": 0.0, "total": 0 } },
  "negativeByPage": [ { "page": "/calculator", "count": 3 } ],
  "flags": [ { "severity": "warn", "kind": "anomaly", "metric": "plansSaved",
               "msg": "0 in last24h (avg7d 6.2, P(0)<0.002)" } ]
}
```

### Volume-aware anomaly rules

Central business-count alerts use eight complete, weekday-aligned historical
periods and a prediction interval for the next observation. Low-volume or
variable activity can remain unjudged. Uptime, report freshness and other
technical failure checks keep their existing timing.

- Test complete windows from one day through `max_window_days` (default 14).
  Each window uses eight earlier windows of the same length, ending on the
  same weekday and spaced ⌈window days ÷ 7⌉ weeks apart. These windows overlap
  neither one another nor the tested window. Select the shortest window that
  supports an alert. A missing or invalid count is unknown; a real zero stays
  zero. Missing required comparisons stop longer candidates; shorter complete
  candidates remain available.
  Report envelopes currently declare `last24h` without explicit period bounds or
  completeness metadata. Complete windows here require every stored daily
  counter; the detector cannot identify a reporter that supplies a number for
  an incomplete measurement. It never reconstructs absent reports as zeros.
- Fit a linear recent trend to `log1p(count)`. Use a Student-t future-observation
  interval with six residual degrees of freedom, including both residual
  variability and uncertainty in the fitted trend. A count-noise variance floor
  and the largest available weekday-specific residual variance can only widen
  the interval. At least four complete weekday fits are required. The fitted
  trend reference is not an arithmetic expected count.
- Allocate `alpha / (2 × max_window_days)` to each tail of each candidate
  interval. A decline must also pass a Poisson Chernoff noise filter using the
  smaller of the fitted reference and historical mean. The two filters are
  dependent; their probabilities are not multiplied. The log-count model is an
  approximation. These settings provide no universal false-alarm guarantee
  across repeated daily checks, assets or arbitrary seasonal patterns.
- A window is eligible only if a zero count could support an alert under both
  filters. A wide range that includes zero cannot produce a warning. Sparse
  activity may need several days, or remain unjudged through the maximum.
  The model handles matching weekdays and recent trends; it does not explicitly
  fit annual seasonality or holidays.
- The first daily prediction needs eight matching periods plus enough prior
  weekdays to estimate variability, at least 59 days. The default maximum
  history read is 131 days. Longer windows need more history. Asset-supplied
  `avg7d` never replaces missing central history.
- Every new alert stores its model version, comparison dates and counts,
  observation window, predicted range and decision inputs. The Tower displays
  that stored range. Older Poisson alerts retain their original interpretation;
  unknown model versions receive no inferred range. Replay uses the same
  historical assembly and scoring, and displays the selected window and why
  a day could not be judged.
- A new report resolves prior untouched central count warnings for its metrics,
  then records any current warning. Recognized legacy asset count warnings are
  replaced only when their arithmetic matches their owning report. Arbitrary
  asset warnings and technical failures remain unchanged. Active recognized
  legacy snoozes suppress replacement warnings until expiry or recovery;
  acknowledged and resolved operator history is preserved.
- Sensitivity and maximum observation length remain operator-controlled in
  **Alert rules**. The synthetic rolling benchmark in
  `packages/contract/test/count-detection-simulation.test.ts` checks warning
  days, warning episodes, eligibility, incident detection and detection delay
  against frozen seeds and acceptance criteria. It does not establish live
  outcome performance.
- Provider reporting-timezone changes do not alter these asset-reported
  counters. Rules using provider-bucketed daily series must exclude distorted
  dates using `distortedDays()` in `workers/ingest/src/time-zone-change.ts`.

The future-observation interval includes residual and fitted-trend uncertainty
([NIST](https://www.itl.nist.gov/div898/handbook/pmd/section5/pmd512.htm)).
Rolling validation trains only on observations before each tested window
([Forecasting: Principles and Practice](https://otexts.com/fpp3/tscv.html)).

### Codebase report

A second report an asset sends about itself: one measurement of its
repository at one commit, sent to `POST /api/codebase-report` with the same
`ASSET_TOKENS` bearer as the nightly report and stored in
`noticeos.codebase_reports`. The schema is `CodebaseReport` in
`packages/contract/src/codebase.ts`; the measures, their labels and the five
rules are in `packages/contract/src/codebase-measures.ts`. Why these measures
and these rules: [doc 27](27-codebase-health.md).

```jsonc
{
  "asset": "example.com",
  "generatedAt": "2026-10-15T03:12:44Z",
  "repository": { "remote": "github.com/example/site", "ref": "main",
                  "commit": "0123456789abcdef0123456789abcdef01234567",
                  "committedAt": "2026-10-14T22:01:00Z" },
  "paths": ["apps/site"],
  "tools": { "image": "ghcr.io/notice-cx/noticeos-codebase-report@sha256:…",
             "scc": "3.7.0", "jscpd": "5.4.0", "lizard": "1.24.0" },
  "measures": { "code_lines": 48210, "duplication_percent": 4.0, "unused_files": 9,
                "complex_functions": 23, "test_ratio": 0.19, "commits_30d": 84 },
  "unmeasured": { "unused_dependencies": "Unused packages are not measured yet." },
  "byLanguage": [ { "language": "TypeScript", "files": 300, "code_lines": 40000 } ],
  "findings": {
    "duplicates": [ { "lines": 48, "files": [ { "path": "src/a.ts", "startLine": 10 },
                                              { "path": "src/b.ts", "startLine": 88 } ] } ],
    "complexFunctions": [ { "path": "src/x.ts", "name": "render", "line": 120, "complexity": 41, "length": 210 } ],
    "unused": [ { "kind": "file", "path": "src/old.ts" } ],
    "largestFiles": [ { "path": "src/big.ts", "code_lines": 2400 } ]
  }
}
```

- **Every measure is optional, and an absent measure is unmeasured.** It is
  never stored or read as 0; `unmeasured` may give the reason the Tower shows
  beside "Not measured", and a rule whose input is absent does not run.
- **Paths, never source text.** Findings carry repository-relative paths, line
  numbers and function names. Lists are bounded (20 repeated blocks of at most
  10 files, 20 functions, 50 unused items, 10 largest files, 12 languages, 20
  measured paths), a path is at most 512 characters with no `..`, and the body
  is at most 256 KiB.
- **Units are checked.** Counts are whole numbers of 0 or more, a percent is 0
  to 100, a ratio or an average is 0 or more, and a pass (`build_passed`,
  `tests_passed`) is 1 for passed or 0 for failed. The measuring image never
  builds or tests the code, so the two passes and `vulnerable_dependencies`
  are present only when the sender's own build, test and audit steps pass
  them in.
- **A resend appends.** A second report on the same UTC day is the next
  revision of that day; `noticeos.current_codebase_reports` is the newest
  revision of each site and day.
- **Tool versions travel with the numbers.** `tools` names the versions that
  produced them, so a step on a version change reads as the tools, not the code.
- **Five rules run on each report**, with the thresholds in
  `config/constants.json` `codebase_rules`: `codebase-growth` (warn, anomaly),
  `codebase-duplication` (warn, opportunity), `codebase-unused` (info,
  opportunity), `codebase-complexity` (info, opportunity) and
  `codebase-vulnerabilities` (info, opportunity). Each first
  resolves its open alert for the site, as the volume-aware rules do.

## Central signals

GSC, GA4, DataForSEO ranking/SERP/LLM signals, backlinks and CrUX, pulled by
NoticeOS crons with portfolio credentials, plus the revenue and cost data
below.

The ingest Worker's 15-minute Sense cron
pulls rolling 97-day daily windows for GA4 (`active_users`, `sessions`,
`page_views`, `event_count`) and GSC (`clicks`, `impressions`, `ctr`,
`position`): 90 visible property-detail dates plus seven calculation-only dates
for the first visible day's prior-week comparison. The 02:30 UTC nightly run
lists the non-retired portfolio sites verified under the central Bing
Webmaster key and pulls their daily `clicks` and `impressions`, including
read-only collection for Sense-only pre-launch properties. It keeps up to
the same 97 days of history from the dates Bing actually returns. Every
attempt appends a run; an observation is appended only when a provider value
changes.
The longer request changes neither call cadence nor API request count. Google
service-account credentials are stored once and tagged with the properties
they give access to; one Bing user-level key covers all verified sites.

The separate 12:15 UTC analysis job archives the previous four completed
Google dates plus the current Bing Webmaster snapshots through operator-owned
credentials. It preserves bounded provider responses in the private/local
`RAW_SIGNALS` R2 bucket. The families are below; their request costs and
ceilings are in [doc 11](11-integrations.md#daily-provider-analysis-archive)
and the job's mechanics in the
[ingest README](../workers/ingest/README.md#analysis-grade-provider-signal-dumps).

| Provider | Families |
|---|---|
| GSC (`dataState=final`) | web search `page-query`, `page`, `query`, `country`, `device`, `page-country`, `page-device`; `search-appearance-pages` (two-step: the appearance types, then the pages under each); `image-page-query`; `discover-page` |
| GA4 (completed days) | `pages-screens`, `landing-pages`, `traffic-acquisition`, `traffic-sources` (source/medium × campaign), `events`, `page-events` (page × event), `js-errors` (message × source × page), `landing-page-acquisition` (landing page × source and channel, including `AI Assistant` referrals); plus `events-28d`, one rolling 28-complete-day event-user aggregate per run |
| Bing Webmaster | `rank-traffic`, `crawl-stats`, `crawl-issues`, `feeds` daily; `queries` and `pages` weekly, because Microsoft rebuilds those top-result snapshots weekly |

`js-errors` reads GA4 **event parameters**, which the Data API returns only for
parameters an operator has registered as custom dimensions and which GA4 never
backfills. `config/ga4-custom-dimensions.json` records where that registration
has happened, and a property it does not cover is skipped without a manifest
row; where the API does reject the field, the attempt is recorded as
`ga4_custom_dimension_unregistered`, never as an empty success. The analyzer
reads only the latest Bing query/page snapshot and never adds rows from
repeated collection runs.

The archive manifest (`archive_runs`) appends one row per report attempt;
unchanged re-fetches point at the prior content-addressed object instead of
duplicating bytes. This makes the deeper data available to offline scripts
without turning the store into a document store or making the Tower wait on Google.
The analyzer emits a bounded executive snapshot with its evidence, an optional
exact-window product-use snapshot, plus compact Google/Bing query-visibility
movers. The product snapshot uses the provider's aggregate unique-user count
independently per event; it never sums daily unique users or presents events
as one person's sequence. Query movers compare seven reported
dates with the preceding equal-length window and rank only queries present in
both; a query missing from the top rows is never counted as zero. The store
keeps only that compact read model (`asset_insight_snapshots`) for the Tower, never the
raw rows. A warning-style interpretation is not a flag and
does not affect property health. Mark/dismiss choices in the Tower are
reversible browser display preferences, not mutations of this evidence.
Targeted GSC URL Inspection and GA4 raw event/session sequences remain deferred;
the Data API archive is aggregate reporting, not a substitute for GA4 BigQuery
export. BWT's AI Performance dimensions are available only through the
operator UI export today and are not inferred from standard API impressions.

Provider-reported issues are a distinct future signal class, not a substitute
for OS-derived traffic anomalies:

- Bing Webmaster exposes site crawl issues through
  [`GetCrawlIssues`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.iwebmasterapi.getcrawlissues?view=bing-webmaster-dotnet).
  The daily archive and executive warning are implemented. A future
  first-seen/last-seen materialization can promote them into lifecycle-managed
  Needs Attention events.
- GSC has no site-wide Recommendations/Issues feed in its
  [API surface](https://developers.google.com/webmaster-tools/v1/api_reference_index).
  Its [URL Inspection result](https://developers.google.com/webmaster-tools/v1/urlInspection.index/UrlInspectionResult)
  reports indexing, fetch, robots, canonical, mobile, and rich-result state for
  explicitly selected URLs, so it belongs in a bounded collection of priority
  URLs rather than being presented as covering the whole property.
- GA4's [Data API](https://developers.google.com/analytics/devguides/reporting/data/v1/basics)
  is reporting and its [Admin API](https://developers.google.com/analytics/devguides/config/admin/v1)
  is configuration/change history; neither documents a Recommendations or
  Insights feed. GA4 Needs Attention items therefore remain OS-derived.

Every provider finding must retain `origin=provider`, provider issue type,
affected URL/site, first/last seen, and provider evidence. It must never be
merged indistinguishably with a statistical anomaly.

### Revenue & cost (the ledger feeds — REQUIRED)

- **Revenue**: ad-network reporting (Raptive/Mediavine/AdSense APIs or exports),
  affiliate-network exports (CJ, Amazon), subscription MRR (billing provider),
  licensing invoices. Ingested per asset per period into ledger `revenue` rows
  ([doc 00](00-objective-and-roi.md)).
- **Cost**: the OS measures its own costs — inference spend per run (tagged to
  change-id or `os-overhead`), external API spend, operator minutes (from
  review/triage timestamps, priced at `OPERATOR_RATE`). Without cost data there
  is no ROI, and without ROI the objective cannot be measured.

Ledger amounts are integer minor units of their stated supported uppercase
currency. Uploads may omit `currency` only for legacy USD compatibility. Currency
precision is respected when importing; replay and corrections retain the currency
of the original row. Readers never sum or compare different currencies. Mixed
figures are unavailable, with their constituent rows still readable; no exchange
rate is inferred.

### Known distortions

Signals are distorted in documented ways; Attribute and the alert rules must
apply this table instead of treating any series as exact:

| Signal | Latency / finalization | Known distortions |
|---|---|---|
| GSC | today is always provisional in the live aggregate; the archive requests provider-final rows for completed dates and re-pulls four dates for late arrival | never alert on incomplete windows; page/query exports are top-row datasets, can omit anonymized/low-volume data, and grouped totals do not always reconcile |
| GA4 | today is incomplete in the daily chart; recent processed values can still be revised for 24–48h, so a day stays marked provisional until it has been collected on day D+2 (`GA4_SETTLE_DAYS`) | never alert on today's partial value; consent-mode config changes step the series (a consent flip can halve reported sessions — config, not reality); AI-Mode strips referrers (a lower bound, not the true count) |
| Bing Webmaster | rank-and-traffic data updates daily and currently lags real time by days | stop the series at the latest reported date; never fill the provider-lag tail with zeroes |
| SERP panels | point-in-time, per-locale/device | volatility is not a trend; algorithm-update calendar overlay required |
| Ad revenue | Net-45/60 payouts; estimated → reconciled | seasonality 1.5–2× trough-to-peak (Jan/Jul low, Q4 high) — compare seasonally, book reconciled |
| Affiliate | cookie windows, 60-day payment lag | order-level attribution opaque; wide intervals |

## Annotations

`{ "asset", "at", "kind": "deploy|model-change|config|incident|autonomy-change|external", "ref", "note" }`

- **Deploys**: from asset CI webhooks (assets that already send Discord deploy
  notifications send the same event here, with no new asset code).
- **Model changes are deploys of the OS**: builder/verifier model+version is
  logged on every run; an upgrade is an annotation on every asset timeline,
  because it can change output quality with no other visible change and would
  otherwise confound both attribution and the reliability ledger.
- **External**: Google update calendar entries, network policy changes
  (e.g. eligibility-threshold moves), vendor pricing changes.
- **Writer**: `POST /api/annotations` on the ingest Worker, operator-authed;
  the timeline, alert correlation and freshness readers all depend on it.
  Backdating is allowed and expected (an event is recorded at the time
  it happened, not the time somebody remembered it); a future `at` is rejected;
  identity is `(asset, at, kind, ref)`, so a retried post or replayed CI
  webhook returns the existing row instead of duplicating a timeline event.

## Central store

One Postgres database (the frozen schema in `db/postgres/`, the helper in
`packages/postgres/`): `(asset, date)` report rows (`pulses`) + normalized signal
tables + raw-object manifests + compact insight snapshots + the ledger +
annotations + pre-registered watch windows
(`watch_windows`, [doc 03](03-attribution.md)). The private
`RAW_SIGNALS` R2 bucket holds gzip provider-response archives; locally it is
persisted under `.wrangler/state`. Both stores are
append-only; history is the input to trends, baselines, attribution, and
calibration. An open flag is the one row whose summary changes: a scheduled
job that keeps one open flag for a lasting condition (the nightly pull's
`asset-pull-failed`) updates its `message` and `rule_inputs` to the latest
run, because the alert must describe the latest night, and appends every
run's own reading to `flag_evidence` — the summary is a current view, never
the only copy. The store's own ingest freshness is a Tower metric
([doc 06](06-operations.md)) — a push cron that stopped three weeks ago with
no alert must raise an `error` flag on NoticeOS's own asset (`is_os`), not be
found later by chance.
