# 02 — The signal contract

*One capability-agnostic contract covering everything the Sense stage
ingests: asset pulses, centrally-pulled external signals, revenue & cost, and
timeline annotations. Every asset emits the same **shapes**, so adding a
property is "point at its pulse," not "write an integration."*

## Glossary

- **Pulse** — the nightly self-report an asset's own infrastructure can observe
  (worker counters, first-party DB rows, storage counts). Never client-side
  analytics; never external APIs about itself.
- **Signal** — anything NoticeOS pulls centrally about an asset: GSC, GA4,
  SERP panels, backlinks, revenue reports. Joined to pulses on asset id.
- **Metric** — one named series inside a pulse or signal.
- **Flag** — a computed anomaly with **severity** (`info | warn | error`) and
  **kind** (`anomaly | opportunity | milestone`) as separate fields, because a
  mixed enum cannot be thresholded; milestone-kind flags are always
  info-severity. The pulse JSON carries
  flags **in transit**; the central store persists them as their own
  queryable rows with disposition fields (mark-read/ack, snooze, tune,
  incident, hypothesis + `resolved_at`) — the triage loop and per-rule
  false-positive rates need flags as a table, not JSON archaeology.
- **Annotation** — a timeline event: deploy, model-version change, config/
  pricing change, incident, autonomy-tier change. Annotations are first-class
  because Attribute ([doc 03](03-attribution.md)) is meaningless without them.

## The pulse

Capability-agnostic: an asset declares the metric families it can observe and
how (`d1 | analytics-engine | r2 | kv`). Storage is an implementation detail —
Analytics Engine `writeDataPoint()` is the floor for database-less assets; D1
assets keep D1.

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

A fixed threshold ("0 in last24h when avg7d > ~1 → warn") false-positives
constantly on low-volume assets: at avg 4.1/day, a zero-day is routine Poisson
noise, and a stream of meaningless warns trains the operator to ignore the
channel — which defeats the entire observability purpose.

- Model each flow metric as Poisson(seasonal baseline·w). Flag only when
  `P(observed | baseline) < α` (default α = 0.01) **and** baseline ≥ 3/day.
- Every daily metric uses the mean of its four matching prior weekdays:
  Saturday compares with four prior Saturdays, not Friday or a flat seven-day
  mean. The asset-supplied `avg7d` remains diagnostic wire data and never moves
  the central ruler.
- Below 3/day, compare a full multi-day window (default 72h) with four
  equivalently aligned historical windows. A missing observation in any cohort
  keeps the metric quiet rather than silently changing the baseline.
- Percentage-drop rules gate on minimum absolute counts.
- Rules arm only after all four comparison observations exist. A new metric is
  therefore silent for at least 28 days. The Tower's one-week visual reference
  is context, not itself an alert threshold.
- A new reading resolves the prior open central flow alert for that metric
  before evaluating the current event. If the anomaly persists, the new daily
  event opens; if it recovered, the property stops carrying an obsolete yellow
  state. Operator-dispositioned history is never auto-reopened.
- Thresholds live in NoticeOS config, tunable per asset; every fired flag
  records the rule + inputs so false positives are auditable and the rules
  themselves improve (Learn applies here too).
- **A day a reporting-timezone change distorted stays in the baseline cohort.**
  When a provider's reporting timezone moves, the change day and the one before it are short and long by the move
  alone, and the Tower marks both on every chart that draws them. These rules
  keep reading them, because they do not read those days: the cohort is built
  from stored **pulses** — an asset reporting its own counters out of its own
  database — while a reporting timezone is a setting on a **provider's**
  property (GA4), and moving it redistributes hours only inside that provider's
  series. Excluding the day would also cost more than it saved: a cohort is used
  only when all four matching weekdays are present, so dropping one silences
  that metric for four weeks — a month of real blindness traded for a bias that
  is not in the data. **The boundary:** the first rule fed a provider-bucketed
  daily series (the GA4/GSC `signal_values` rows the Tower charts) must exclude
  the distorted days from its own cohort; `distortedDays()` in
  `workers/ingest/src/time-zone-change.ts` answers which they are.

## Central signals

GSC, GA4, DataForSEO ranking/SERP/LLM signals, backlinks and CrUX, pulled by
NoticeOS crons with portfolio credentials, plus the revenue and cost lane
below.

The ingest Worker's 15-minute Sense cron
pulls rolling 97-day daily windows for GA4 (`active_users`, `sessions`,
`page_views`, `event_count`) and GSC (`clicks`, `impressions`, `ctr`,
`position`): 90 visible property-detail dates plus seven calculation-only dates
for the first visible day's prior-week comparison. The 02:30 UTC nightly tick
discovers non-retired portfolio sites verified under the central Bing
Webmaster key and pulls their daily `clicks` and `impressions`, including
read-only observation of Sense-only pre-launch properties. It retains up to
the same 97-day retrieval horizon from the dates Bing actually returns. Every
attempt appends a run; observations append only when a provider value changes.
The longer request changes neither call cadence nor API request count. Google
service-account credentials are stored once and tagged with the properties
they support; one Bing user-level key covers all verified sites.

The separate 12:15 UTC analysis lane archives the previous four completed
Google dates plus the current Bing Webmaster snapshots through operator-owned
credentials. It preserves bounded provider responses in the private/local
`RAW_SIGNALS` R2 bucket. The families are below; their request costs and
ceilings are in [doc 11](11-integrations.md#daily-provider-analysis-archive)
and the lane's mechanics in the
[ingest README](../workers/ingest/README.md#analysis-grade-provider-signal-dumps).

| Provider | Families |
|---|---|
| GSC (`dataState=final`) | web search `page-query`, `page`, `query`, `country`, `device`, `page-country`, `page-device`; `search-appearance-pages` (two-step: the appearance types, then the pages under each); `image-page-query`; `discover-page` |
| GA4 (completed days) | `pages-screens`, `landing-pages`, `traffic-acquisition`, `traffic-sources` (source/medium × campaign), `events`, `page-events` (page × event), `js-errors` (message × source × page), `landing-page-acquisition` (landing page × source and channel, including `AI Assistant` referrals); plus `events-28d`, one rolling 28-complete-day event-user aggregate per run |
| Bing Webmaster | `rank-traffic`, `crawl-stats`, `crawl-issues`, `feeds` daily; `queries` and `pages` weekly, because Microsoft rebuilds those top-result snapshots weekly |

`js-errors` reads GA4 **event parameters**, which the Data API answers only for
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
The analyzer emits a bounded evidence-bearing executive snapshot, an optional
exact-window product-use snapshot, plus compact Google/Bing query-visibility
movers. The product snapshot uses the provider's aggregate unique-user count
independently per event; it never adds daily uniques or claims a same-person
sequence. Query movers compare seven reported
dates with the preceding equal-length window and rank only queries present in
both; top-row omissions never become invented zeroes. The store keeps only
that compact read model (`asset_insight_snapshots`) for the Tower, never the
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
  explicitly selected URLs, so it belongs in a bounded priority-URL lane rather
  than pretending to cover the whole property.
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
- **Cost**: the OS meters itself — inference spend per run (tagged to change-id
  or `os-overhead`), external API spend, operator minutes (from review/triage
  timestamps, priced at `OPERATOR_RATE`). No cost lane → no ROI → no objective.

Ledger amounts are integer minor units of their stated supported uppercase
currency. Uploads may omit `currency` only for legacy USD compatibility. Currency
precision is respected when importing; replay and corrections retain the currency
of the original row. Readers never sum or compare different currencies. Mixed
figures are unavailable, with their constituent rows still readable; no exchange
rate is inferred.

### Known distortions table (encode, don't rediscover)

Signals lie in documented ways; Attribute and the alert rules must read this
table rather than treating any series as truth:

| Signal | Latency / finalization | Known distortions |
|---|---|---|
| GSC | today is always provisional in the live aggregate; the archive requests provider-final rows for completed dates and re-pulls four dates for late arrival | never alert on incomplete windows; page/query exports are top-row datasets, can omit anonymized/low-volume data, and grouped totals do not always reconcile |
| GA4 | today is incomplete in the daily chart; recent processed values can still be revised for 24–48h, so a day stays marked provisional until it has been collected on day D+2 (`GA4_SETTLE_DAYS`) | never alert on today's partial value; consent-mode config changes step the series (a consent flip can halve reported sessions — config, not reality); AI-Mode strips referrers (floor, not truth) |
| Bing Webmaster | rank-and-traffic data updates daily and currently trails the wall clock by days | stop the series at the latest reported date; never fill the provider-lag tail with zeroes |
| SERP panels | point-in-time, per-locale/device | volatility ≠ trend; algorithm-update calendar overlay required |
| Ad revenue | Net-45/60 payouts; estimated → reconciled | seasonality 1.5–2× trough-to-peak (Jan/Jul low, Q4 high) — compare seasonally, book reconciled |
| Affiliate | cookie windows, 60-day payment lag | order-level attribution opaque; wide intervals |

## Annotations

`{ "asset", "at", "kind": "deploy|model-change|config|incident|autonomy-change|external", "ref", "note" }`

- **Deploys**: from asset CI webhooks (assets that already emit Discord deploy
  notifications point the same event here — zero new asset plumbing).
- **Model changes are deploys of the OS**: builder/verifier model+version is
  logged on every run; an upgrade is an annotation on every asset timeline,
  because it silently changes output quality and would otherwise confound both
  attribution and the reliability ledger.
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
`packages/postgres/`): `(asset, date)` pulse rows + normalized signal
tables + raw-object manifests + compact insight snapshots + the ledger +
annotations + pre-registered watch windows
(`watch_windows`, [doc 03](03-attribution.md)). The private
`RAW_SIGNALS` R2 bucket holds gzip provider-response archives; locally it is
persisted under `.wrangler/state`. Both stores are
append-only; history is what powers trends, baselines, attribution, and
calibration. An open flag is the one row whose summary moves: a lane that keeps
one open flag for a lasting condition (the nightly pull's `asset-pull-failed`)
refreshes its `message` and `rule_inputs` to the latest run, because the alert
must speak for tonight, and appends every run's own reading to `flag_evidence` — the summary is a
current view, never the only copy. The store's own ingest freshness is a Tower metric
([doc 06](06-operations.md)) — a push-cron that died silently three weeks ago
must be an `error` flag on asset #0, not a discovery.
