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

A fixed threshold ("0 in last24h when avg7d > ~1 → warn") produces constant
false positives on low-volume assets: at an average of 4.1/day, a day with
zero is ordinary Poisson noise, and after a stream of meaningless warnings the
operator stops reading the alerts, which defeats the purpose of monitoring.

- Model each flow metric as Poisson(seasonal baseline·w) over a window of w
  whole days, and flag only when `P(observed | baseline·w) < α` (default
  α = 0.01).
- w is the shortest window, at most `max_window_days` (default 14), in which a
  run of zeros could fire: the smallest w with `e^(−baseline·w) < α`, which is
  `⌈ln(1/α) ÷ baseline⌉` days. At α = 0.01 a metric averaging 4.61 a day or more
  is tested on one day, 3 a day on two, 1.5 on four, 1 on five and 0.5 on ten.
  Under `ln(1/α) ÷ max_window_days` (0.33 a day by default) no window can fire,
  and the metric is not tested.
- Every daily metric uses the mean of its four matching prior weekdays:
  a Saturday is compared with the four prior Saturdays, not Friday or a flat
  seven-day mean. The asset-supplied `avg7d` remains diagnostic wire data and
  never changes the central baseline.
- A multi-day window is compared with four earlier windows of the same length
  that end on the same weekday, spaced ⌈w ÷ 7⌉ weeks apart so that none
  overlaps another or the window being tested. The window grows one day at a
  time until those four windows hold enough events for a run of zeros to fire.
  A missing observation in any cohort means the rule raises no alert for that
  metric; it does not switch to a different baseline.
- Percentage-drop rules apply only above minimum absolute counts.
- A rule starts evaluating only after all four comparison windows exist, so a
  new metric raises no alerts for at least 28 days, and a metric tested over
  more than a week for at least 8 weeks plus the window. The Tower's one-week
  visual reference is context, not itself an alert threshold.
- When a new reading arrives, the prior open central flow alert for that
  metric is resolved before the current event is evaluated. If the anomaly
  persists, the new daily event opens; if it recovered, the property no longer
  shows an outdated yellow state. Operator-dispositioned history is never
  auto-reopened.
- Thresholds are in NoticeOS config, tunable per asset; every raised flag
  records the rule + inputs so false positives can be audited and the rules
  themselves improved (the Learn stage applies here too).
- **A day distorted by a reporting-timezone change stays in the baseline cohort.**
  When a provider's reporting timezone changes, the change day and the day
  before it are shorter or longer only because of the change, and the Tower
  marks both on every chart that includes them. These rules keep those days in
  their cohorts because the distortion is not in the data they use: the cohort
  is built from stored **reports** (`pulses`) — an asset's own counters from
  its own database — while a reporting timezone is a setting on a
  **provider's** property (GA4), and changing it moves hours only within that
  provider's series. Excluding the day would also do more harm than good: a
  cohort is used only when all four matching weekdays are present, so dropping
  one would stop alerts for that metric for four weeks, a month with no
  monitoring, to remove a bias that is not in the data. **The limit:** the
  first rule that reads a provider-bucketed daily series (the GA4/GSC
  `signal_values` rows the Tower charts) must exclude the distorted days from
  its own cohort; `distortedDays()` in
  `workers/ingest/src/time-zone-change.ts` returns those days.

### Codebase report

A second report an asset sends about itself: one measurement of its
repository at one commit, sent to `POST /api/codebase-report` with the same
`ASSET_TOKENS` bearer as the nightly report and stored in
`noticeos.codebase_reports`. The schema is `CodebaseReport` in
`packages/contract/src/codebase.ts`; the measures, their labels and the four
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
  to 100, a ratio or an average is 0 or more.
- **A resend appends.** A second report on the same UTC day is the next
  revision of that day; `noticeos.current_codebase_reports` is the newest
  revision of each site and day.
- **Tool versions travel with the numbers.** `tools` names the versions that
  produced them, so a step on a version change reads as the tools, not the code.
- **Four rules run on each report**, with the thresholds in
  `config/constants.json` `codebase_rules`: `codebase-growth` (warn, anomaly),
  `codebase-duplication` (warn, opportunity), `codebase-unused` (info,
  opportunity) and `codebase-complexity` (info, opportunity). Each first
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
