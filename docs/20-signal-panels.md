# 20 — Signal panels: the read contract for asset repos

*Each asset has a panel: its GA4, Google Search Console, Bing Webmaster,
DataForSEO, PostHog and Clarity reports, which NoticeOS collects centrally,
flattens into one table per report family and rebuilds every day. **An agent
working on an asset reads its panel through NoticeOS's MCP panel tools. It
never calls a provider about the asset.***

This doc is written for the agent working in an asset's repo, not for
NoticeOS. If you are here to change how panels are produced, the code is
`scripts/signal-panels-refresh.mjs`, the roster is
[`config/signal-panels.json`](../config/signal-panels.json), and the
per-integration catalog is
[`config/integrations.json`](../config/integrations.json). The tools are
`scripts/panel-mcp.mts`, over `scripts/panel-store.mts` and
`scripts/panel-query.mts`.

## How an agent reads a panel

The `noticeos` MCP server ([Connect an agent](guides/connect-an-agent.md))
serves four read-only tools. Each one names the workspace from
`list_workspaces`.

| Tool | What it returns |
|---|---|
| `list_panels` | Every asset with a published panel: its latest version, when it was built, and the report families that need attention. |
| `get_panel` | One version of an asset's panel (the latest unless `version` names another): when it was built, every report family with its newest report day, its age on the day of the read and its collection status, every table with its columns and row count, the versions kept, and the reading rules below in short form. |
| `query_panel` | One read-only SQL `SELECT` in DuckDB's dialect over a version's tables, named after their files (`posthog-web-vitals.csv` is `posthog_web_vitals`). It returns the column names and types and at most `max_rows` rows (200 unless named, 2000 at most), and marks a result it cut short. |
| `read_panel_document` | One of a version's JSON documents: `executive`, `summary`, `freshness` or `report`. A part larger than 64 KB returns as an outline of its keys; `pointer` (a JSON Pointer such as `/items/0`) selects a part. |

Open `get_panel` first. Its `attention` list names every report family whose
collection is failing, overdue or paused, every family with no report in the
panel, every family imported by hand and how old it is, and the panel itself
when it is not the latest version or the daily refresh has not published it
for more than 36 hours.

### Versions

Each daily refresh publishes a new **version**: a folder that is never
rewritten afterwards, named `<generation>-<built at>-<suffix>`, for example
`00000011-2026-10-13T13-10-04-637Z-4f83dc`. Its `report.json` lists every file
with its size and sha256.

- A version stays readable for 14 days (`PANEL_VERSION_KEEP_DAYS` in
  `scripts/panel-versions.mts`). The latest version and the one before it are
  stored as written; older ones are stored gzipped and return the same rows.
- **Cite the version you read in a finding**, so a later reader opens the same
  evidence. A review task filed by NoticeOS records the version it covers in
  `noticeos_panel_version` and names it in its description.
- A version that is no longer kept is refused with the latest version's name.
  No tool substitutes another version for the one you asked for.

### Report family status

`get_panel` gives each report family one `status`, measured when you read it:

| `status` | Meaning |
|---|---|
| `ok` | The panel holds the family and its newest report day collected successfully. |
| `failing` | The newest report day's collection failed. `collection.failing` lists the failed days with the reason code (for example `incomplete-report` when the provider cut the result short). |
| `overdue` | The collection did not run on its schedule. |
| `missing` | Collection expects the family, and the panel holds no report of it. |
| `imported` | An operator imports the family by hand; `ageDays` is the age of the newest import. |
| `paused` | Collection is turned off for this asset; the panel keeps the reports already collected. |
| `unchecked` | The panel was built without a collection-health read, or before families were recorded. |

`ageDays` is whole days from the family's newest report day to the day of the
read. The collection status is the one recorded when the version was built;
the Tower's Integrations page shows the status now.

### Query limits

A query runs in its own process: 30 seconds, 512 MB for DuckDB and 512 MB
for the process, one thread, and at most 256 KB of rows returned. It can read
only the files of the version it names. A text that is not exactly one `SELECT`
(`WITH … SELECT` included) is refused before it runs, so `COPY`, `ATTACH`,
`SET` and `INSTALL` never run. Filter and aggregate in SQL instead of reading
raw rows page by page.

## On the OS's own machine

The same versions are files on the machine NoticeOS runs on, under the
installation's `state/.local/signal-dumps/reports/` (in a checkout without
Docker, the checkout's `.local/signal-dumps/reports/`). `<asset>` there is a
link to the latest version in `<asset>.reports/`. The files are working data,
not a committed artifact: read them in place, and do not copy them into a
asset repo.

## Repeated report evidence

A refresh records `stability` inside `freshness.json`, separately from collection
health. It reads only local downloaded archives: at most four report dates per
family, 64 archives per refresh and 8 MiB per archive. Families are visited in
name order; inputs outside those limits, unreadable inputs, empty normalized
results or missing comparison identity remain unknown.

Each family's latest reading records its report date, collection timestamp,
provider dates and comparison hashes. Up to three earlier report dates have one
state: `repeated` for equal normalized rows, `changed` for different rows,
`noncomparable` for different known contexts, or `unknown` for insufficient
evidence. Queries, reporting windows, markets, devices, resource identities,
data state and truncation stay in the comparison. Collection timestamps,
request attempts, response cost and transport metadata do not. Row ordering
and object key ordering do not affect equality; row multiplicity and every
normalized value do. Equal summary totals can accompany changed query rows.

This assessment compares distinct report dates. Same-report-date replacement
continues to use the archive and manifest rules. Repeated provider answers do
not change collection health or establish a collection failure. Manual download
and refresh use one path rule:
`<root>/<asset>/<integration>/<report>/<reportDate>.json`.

Backlink findings keep provider-observed new, lost and raw net domain totals.
A same-report-date referring-domain sample records assessed spam scores using
the existing score boundary of 40, with scores above 40 identified separately.
Missing or invalid scores remain unassessed. The sample is capped and ordered
by rank; quality outside it and quality of new/lost domains remain unknown,
even when every assessed score is 40 or lower. Sample counts are never
subtracted from the aggregate movement to calculate a clean net.

## What `freshness.json` records

Each version's `freshness.json` records how current its sources were when it
was built:

```json
{
  "asset": "example.com",
  "refreshedAt": "2026-08-03T13:10:04.221Z",
  "maxAgeDays": 7,
  "fresh": true,
  "sources": [
    { "key": "bing-webmaster", "integration": "bing-webmaster", "collected": true, "newestReportDate": "2026-08-01", "ageDays": 2, "fresh": true },
    { "key": "ga4",            "integration": "ga4",            "collected": true, "newestReportDate": "2026-08-02", "ageDays": 1, "fresh": true },
    { "key": "gsc",            "integration": "gsc",            "collected": true, "newestReportDate": "2026-08-01", "ageDays": 2, "fresh": true,
      "reports": [{ "report": "page", "newestReportDate": "2026-07-29" }, { "report": "query", "newestReportDate": "2026-08-01" }] }
  ],
  "stale": [],
  "uncollected": [
    { "key": "bing-webmaster/ai-queries", "integration": "bing-webmaster", "report": "ai-queries", "collected": false, "newestReportDate": "2026-02-14", "ageDays": 170, "fresh": false }
  ],
  "staleUncollected": ["bing-webmaster/ai-queries"]
}
```

- `sources[].newestReportDate` is the newest archive **report date** for that
  integration. Daily reports use the measured day; snapshots use their report
  or export day. `provider_date` records a provider row's measured day and
  `collected_at` records collection time. A later Bing collection can contain
  the same older provider dates. GSC typically lags 1–3 days; Bing's top-query
  and top-page snapshots update weekly.
- `sources[].reports[]` is each family's own newest report day under that
  integration (the example abbreviates it to one source). A collection is in the
  panel only when every one of its families has reached that collection's day; the weekly review
  is filed only then
  ([the panel-review filer](../scripts/README.md)).
- `fresh` is per integration against `maxAgeDays`, and the top-level `fresh` is
  true only when every source is. An asset whose GSC is current and whose Bing
  stalled is a **partial** result, and `stale` lists the stale integration.
- **No sources at all is `fresh: false`, never `true`.** An empty panel dir and a
  asset whose traffic fell to zero look identical on disk, so a panel with
  nothing to measure is marked not fresh.
- **`uncollected[]` lists the families that no cron produces**, aged from their
  own newest export rather than from the integration they share — today, the
  three `bing-webmaster-ai-*` exports (family contract below). Without this list
  the nightly `bing-webmaster` API collection would mark an AI export as fresh
  even when it was six months old, and the reader would need to know already
  which families the freshness in `sources[]` does not cover. They are excluded
  from `sources[]` in both directions: a stale export cannot mark the
  integration stale, and an export imported this morning cannot make last
  night's collection look newer than it was.
- **They do not change the top-level `fresh`**, and `staleUncollected` is a
  separate list, because they have no scheduled cadence to miss. Counting a file
  that an operator imports every few months in the panel's top-level boolean
  would keep every panel permanently red, and a signal that is always red gets
  ignored. These families are refreshed through the asset's weekly
  panel-review task: when a review finds them more than about 2 weeks old, the
  review task lists the operator export as one of its requests.
  `fresh` shows whether the collectors are current; `uncollected[]` shows how
  old each hand-imported file is, in the same file.
- **`families[]` is one row per report family** the panel holds or the
  asset's collection expects: its `role` (`collected` or `imported`), its newest
  report day, how many archived report days it has, and `collection`, the
  family's collection health when the version was built (state, reason code,
  last success and failing days). `collection` (top level) records when health
  was read and whether the read succeeded. `get_panel` derives each family's
  `status` from these.
- **`freshness.json` missing means the refresh has never run for this asset.**
  Check [`config/signal-panels.json`](../config/signal-panels.json): the asset
  may be deliberately off the roster, and the entry records why. The operator can
  read the same row — and turn it on — from the Tower, on that asset's
  **Growth** tab (`/assets/<id>/growth`, section *Tracked panels*); see
  [Who edits the roster](#who-edits-the-roster-the-towers-growth-tab) below.

If the panel is stale, say so in whatever you produce. A conclusion drawn from a
three-week-old panel and labeled as this week's is worse than no conclusion.

## What is in the directory

One CSV per provider report family, named `<integration>-<report>.csv`, plus
three files that are not raw families:

| File | The question it covers |
|---|---|
| `signal-trend-daily.csv` | **Did clicks and impressions move?** The normalized daily asset-level series — one row per `date,integration,metric,value,provisional`. The only file here whose values can be summed and differenced correctly. |
| `gsc-query.csv`, `gsc-page.csv`, `gsc-page-query.csv` | **Which queries and pages?** Google's per-day top-row exports, with `row_grain` separating property totals from page-level rows. |
| `gsc-country.csv`, `gsc-device.csv`, `gsc-page-country.csv`, `gsc-page-device.csv` | Where and on what. |
| `gsc-discover-page.csv`, `gsc-image-page-query.csv`, `gsc-search-appearance-pages.csv` | Discover, image search, and rich-result appearance. Frequently empty — see the absence rule below. |
| `bing-webmaster-queries.csv`, `-pages.csv`, `-rank-traffic.csv` | The same shape from Bing. **Weekly snapshots that get revised — never sum them across collection runs.** |
| `bing-webmaster-crawl-stats.csv`, `-crawl-issues.csv`, `-feeds.csv` | Crawl health and sitemap state. |
| `bing-webmaster-ai-overview.csv` | **Is an AI assistant citing this asset, and since when?** Daily citations and cited-page counts from Bing's AI Performance report. `provider_date` is the day measured; `report_date` is the day the file was exported. |
| `bing-webmaster-ai-queries.csv`, `-ai-pages.csv` | **Which questions, and which pages.** Grounding queries (with `intent`, `topic`, `citation_share_percent`) and cited pages. Period totals as of `report_date` — no per-day breakdown exists. See the family contract below: these are imported by hand, not by cron. |
| `ga4-traffic-acquisition.csv`, `-traffic-sources.csv`, `-landing-pages.csv`, `-landing-page-acquisition.csv`, `-pages-screens.csv` | **What did the traffic do once it arrived?** The three attribution files (`-traffic-acquisition`, `-traffic-sources`, `-landing-page-acquisition`) carry `provisional` — see the honesty rules. |
| `ga4-events.csv`, `-events-28d.csv`, `-page-events.csv` | Conversions and interactions. |
| `ga4-js-errors.csv` | Client-side errors by `message_bucket`. Only where GA4 custom dimensions are registered. |
| `dataforseo-ranked-keywords.csv`, `-backlinks-summary.csv`, `-backlinks-new-lost.csv`, `-llm-mentions-*.csv` | Weekly off-asset intelligence: rankings, links, AI mentions. Launched assets only. |
| `dataforseo-serp-panel.csv` | The tracked-query result-page panel (doc 08 §S1b). Configured assets only. **Two rows per term** — one per `device` (`mobile`, `desktop`); never sum or average across them. `query_label` groups the rows by the **bet** each query measures, where the panel defines one. |
| `index-coverage.csv` | **How many of our pages are indexed, and is that number moving?** Bing's own count, one row per measured day, plus the sitemap URL counts we submitted. **Derived** from families already archived — no collector, no quota. See the contract below: it is Bing's index, it is asset-level, and it has no data about any single URL. |
| `clarity-url-3d.csv` | Behavior rankings from Microsoft Clarity. Configured projects only; an asset that moved to PostHog keeps it as history. |
| `posthog-web-daily.csv` | **How many people used the asset each day?** One row per `date`: `pageviews`, `people` (unique within that day), `sessions`. Trailing 28 days per read; a repeated day resolves to the newest read. PostHog projects only — see [the PostHog families](#the-posthog-families-product-data) below. |
| `posthog-events.csv` | **Which actions happen, and by how many people?** One row per `event` over the read's window: `count`, `people`, `first_seen`, `last_seen`. Top 500 by count, trailing 14 days. |
| `posthog-exceptions.csv` | **What breaks in the browser, and for how many people?** One row per exception `message` (200 characters at most): `count`, `people`, `sessions`, `max_per_session`, `has_source_file`, `top_path`, `top_browser`. Top 100 by count, trailing 14 days. |
| `posthog-rageclicks.csv` | **Which controls frustrate people?** One row per page + element (`path`, `tag`, `text`, `attr`): `clicks`, `people`, clicks by device, and `page_people` — the people who viewed that page in the window, the denominator. Top 100 by people, trailing 14 days. |
| `posthog-web-vitals.csv` | **How fast is the asset for real visitors?** One row per page + `device` + `os`: 75th-percentile `lcp_p75`, `inp_p75`, `fcp_p75` (ms) and `cls_p75`, plus `measurements`. The 20 most-measured pages, trailing 14 days. |
| `posthog-inp-targets.csv` | **Which control makes a tap slow, and where does the time go?** One row per page + `device` + `os` + `target` (the CSS selector of the element behind each page view's slowest interaction) + `interaction_type` (`pointer` or `keyboard`): `measurements` (page views), `inp_p75` and its parts `input_delay_p75`, `processing_p75`, `presentation_delay_p75` (ms). The same 20 pages as `posthog-web-vitals.csv`, trailing 14 days. An empty `target` means the event carried no element: unknown. |
| `posthog-funnels.csv` | **Where do people drop out of a journey?** One row per configured funnel step: `funnel_id`, `name`, `step`, `event`, `path`, `people`, ordered-step conversion inside a trailing 7-day window. Each read is kept beside the one before it for the week-over-week comparison. |
| `executive.json` | A **deterministic** reading of the above by fixed rules — findings with source, evidence window, exact facts, confidence, and limitation. Not an LLM summary. |
| `summary.json` | Row counts per family, the archive manifest behind them, and the collection caveats. |

Not every asset has every file. An asset with DataForSEO collection may still
have no `clarity-url-3d.csv`; that file exists only where a Clarity project
token is provisioned. **A missing family is unknown, not zero** — check
`summary.json` before concluding anything from a missing file.

Every CSV is comma-separated with a header row. A value or column name that
holds a comma, a double quote or a line break is wrapped in double quotes, and
a double quote inside it is written twice. DuckDB's `read_csv` guesses the
format from a file's first rows, so a file whose first quoted value comes later
fails to load; read the files with `delim = ','`, `quote = '"'` and
`escape = '"'`, as `query_panel` does.

## The `bing-ai` family: the one nobody collects

The three `bing-webmaster-ai-*.csv` files are the only families in this
directory that **no cron produces**. Bing Webmaster Tools' AI Performance report
— which questions Microsoft's assistants answered using this asset, and which
pages they cited — exists in the dashboard and behind an Export button, and
nowhere on the documented API surface
([doc 11 §Bing AI Performance boundary](11-integrations.md#bing-ai-performance-boundary)).
Scraping the dashboard is ruled out on principle. So a person downloads a file
and one command imports it as evidence.

| | |
|---|---|
| **Provider** | Bing Webmaster Tools, AI Performance report (public preview). Same account and same verified asset as the other `bing-webmaster-*` families — that is why they share the integration id. |
| **How it arrives** | An operator downloads the CSV and runs `pnpm bing-ai:import <file>`. Three exports exist: the daily overview series, the grounding-query report, and the page report. |
| **Grain** | `ai-overview` — one row per calendar day (`provider_date`), citations and cited pages. `ai-queries` — one row per grounding query for the export period. `ai-pages` — one row per cited page for the export period. |
| **Its date** | `report_date` is the day the FILE was exported, for all three. Two of the exports carry no date column at all; the query and page totals are period figures whose period Bing does not state. Do not read `report_date` as a measurement day, and do not difference two `ai-queries` exports as if they covered disjoint periods. |
| **Repeat exports** | Never additive. A second export of the daily series re-sends every day it overlaps; the flattener resolves an overlapping day to the newest export, because a repeated Bing snapshot is a revision. Query and page exports append as a **dated series** — one set of rows per export date — so a query's rise over two exports is a real comparison of two snapshots, not of two periods. |
| **What absence means** | **Nobody has imported that export yet.** An empty or missing file is never "Bing's assistants cite nothing". |
| **How you know how old it is** | `freshness.json` `uncollected[]`, one row per family, aged from that family's own newest `report_date`; without a row of their own the nightly `bing-webmaster` API collection would mark them fresh and the reader would need to know already which families it does not cover. They are outside the top-level `fresh` — they have no cadence to miss — so read `uncollected[]`, not just the top-level `fresh`. A family nobody has ever imported has no row at all: a missing row means the file was never imported, not that an old file is stale. |
| **Where the originals are** | Every imported file is archived byte-identical (base64, inside the gzip JSON archive in private R2) alongside the parse, so any later reader can parse it again without needing a download that may no longer be available. |

## Ordered journeys

An asset's Journeys tab shows ordered GA4 user counts, completion, the largest
number of people lost between steps, and complete weekly history. Definitions
are saved in `config/value-events.json` under the asset's `journeys` list.
Each step has a business label and one or more event alternatives. Alternatives
may require an exact page path or exact event parameter values. A destination
step may set a time limit from the preceding step.

The scheduled GA4 archive job collects active funnel definitions through
Google's `v1alpha` `runFunnelReport` method. It requests 7-day and 28-day totals,
their preceding periods, and eight complete Monday–Sunday weeks directly.
Rolling periods end two calendar days before collection in the property's
reporting time zone. Weekly unique users are never added to produce a rolling
total. A missing property time zone prevents collection.

Archives preserve the definition identity, property, time zone, collection time,
ordered `activeUsers` counts, provider response and quality metadata. Dynamic
request reports are grouped as `ga4-journeys` in the panel. Requests use a
separate Funnel quota budget and stored results are reused before a provider
request. Recent windows are checked again until the settlement period ends.
The Tower reads the published snapshot; opening the page makes no provider
request.

An operator can run one Journey collection through
`POST /api/integrations/ga4/collect` with
`{"assets":["example.com"],"families":["journeys"]}`. It collects only active
funnels for the named assets, honors the saved archive-job pause, reuses cached
windows and retains the 96-request limit. It does not collect traffic or search
reports. The response lists each asset's stored report count and any collection
failure. The scheduled panel refresh publishes the stored results to the Tower.

Changed measurement rules start a separate history. Comparisons require the
same definition, property, time zone and user identity, with adjacent periods
of equal length. Sampled, thresholded, incomplete and unavailable results do
not receive improvement or regression colours. Counts are GA4 active users,
not visits, attempts or a cross-provider person count.

Planned definitions do not collect reports. Session exploration also requires
a separate source that records page order within each visit. The Journeys tab
shows this setup state; independent page totals and ordered user funnels do
not supply session branches.

## The PostHog families: product data

Search data shows how people
arrive; PostHog shows **what they do once they are on the asset, and where it
breaks** — funnels, errors, rage clicks and real-visitor speed. It is collected
per asset (each has its own PostHog project, host and read-only key,
connected on the Tower's Integrations page) and is written here as seven
`posthog-*.csv` files.

| | |
|---|---|
| **Provider** | PostHog, one project per asset. Every read is an aggregate PostHog computes server-side; raw events never leave PostHog. |
| **Grain** | Every family except `web-daily` is a **window aggregate**: one row per event, message, page element, page segment or funnel step, over the read's own window. `web-daily` is one row per day. `row_grain` records which. |
| **Its dates** | `window_start`–`window_end` (inclusive, in the PostHog project's timezone, `project_time_zone`) is what a row measures. `report_date` is the window's end. **Read the window from the row**, never from `report_date`: a manual collection can end on the same day as the daily read over a different window. |
| **Windows on the daily read** | `web-daily` 28 days; `events`, `exceptions`, `rageclicks`, `web-vitals`, `inp-targets` 14 days; `funnels` 7 days. |
| **Repeat reads** | Consecutive daily reads overlap almost completely. **Read one `report_date` at a time** and never add rows across report dates. `web-daily` is resolved for you: a day re-sent by a later read keeps only the newest read's row. `funnels` keeps every read, so a funnel can be compared with the read that ended seven days earlier. |
| **People counts do not add** | `people` is PostHog's unique-person count over that row's window. It does not add across rows (one person can hit three errors), across days, or across report dates. |
| **Row limits** | Each family is cut at a row limit (above). `provider_truncated=true` means the limit was reached, so the file is a top-N read and any total built from it is a floor. `row_limit` records the limit. |
| **What absence means** | An **empty** file (header only) means PostHog returned no rows for that window — for example, no rage clicks captured. A **missing** file is a family nobody collected for this asset. Neither is a measured zero for the asset: see the honesty rules below. |
| **Rules applied to it** | `executive.json` contains five deterministic PostHog rules — rage-click clusters, error concentration with noise set aside, once-only events that repeat, real-visitor speed against Google's thresholds, and each funnel's largest drop — plus a `product` block the Tower's Growth tab reads. Each rule reports *fired*, *clear*, *not enough data* (naming the floor it missed) or *not collected*. |

## `index-coverage.csv`: the one family nobody collected

`gsc-page.csv` and `bing-webmaster-pages.csv` list pages that received
**impressions** — a strict subset of the indexed set, with no row for a page
that is indexed but gets no impressions. So an operator seeing an asset's
traffic fall could not tell **"we lost rankings" from "we lost the index"**,
which are different emergencies with different fixes. This family covers the
second question, using data the nightly Bing collection already archived.

| | |
|---|---|
| **Provider** | **Bing Webmaster Tools**, and only Bing. Derived from the `crawl-stats` and `feeds` families this directory already carries — `GetCrawlStats` reports `InIndex`, Bing's count of this asset's pages in its index, and `GetFeeds` reports each submitted sitemap's `UrlCount`. **Google has no Index Coverage API**; its per-URL Inspection endpoint would need a separate, quota-limited collection that NoticeOS does not have yet. |
| **Cost** | Zero. No request, no quota, no credential: it is a view over archives the `15 12 * * *` cron already wrote. |
| **Grain** | Two, separated by `row_grain`. `site-day` — one row per day Bing measured: `pages_in_index`, `pages_crawled`, `crawl_errors`, `blocked_by_robots_txt`. `sitemap` — one row per submitted sitemap from the **newest collection only**: `urls_submitted`, `sitemap_status`, `sitemap_last_crawled`. |
| **Refresh** | Daily, with the Bing collection. Bing re-sends the whole daily series every collection, so a repeated day is a **revision**: the newest collection is kept and nothing is summed across runs. |
| **No ratio** | The file computes no "coverage %". The index count is dated to a measured day; the sitemap count is "as of the last collection". A single percentage would look exact while combining two dates; if you divide them yourself, account for the different dates. |
| **What absence means** | **UNKNOWN — never "not indexed".** A missing file means the Bing collection returned nothing for this asset (unverified asset, failed family, pre-launch), not an empty index. A URL you cannot find here is not absent from the index: this family is **asset-level** and lists no URLs at all. And it is Bing's count — Google indexes different things, so a healthy `pages_in_index` is not evidence about Google, and a falling one is a reason to check Search Console, not proof of a problem. |

## Answering "what happened in search this week"

Each file below is a `query_panel` table named after it
(`signal-trend-daily.csv` is `signal_trend_daily`).

1. `get_panel` — is the panel current, and which report families need attention?
2. `signal-trend-daily.csv` — filter to `integration=gsc`, `metric=clicks` and
   `metric=impressions`, take the last 7 complete days against the 7 before.
   **Ignore rows with `provisional=1` when computing a change**: those are days
   the provider had not finished reporting, and they will rise.
3. `gsc-query.csv` and `gsc-page.csv` — which queries and pages account for the change.
   `gsc-page-query.csv` joins the two.
4. `bing-webmaster-rank-traffic.csv` — did Bing move the same way? A move on one
   search engine only is usually a ranking change; a move on both is usually the asset.
   If both moved, `index-coverage.csv` next: filter to `row_grain=site-day` and
   read `pages_in_index` across the drop. A falling index is a different
   emergency from falling rankings — and a flat one rules that emergency out for
   Bing, though never for Google.
5. `executive.json` — what the deterministic rules already flagged, with their evidence.
6. `dataforseo-serp-panel.csv`, where present — did an AI Overview appear on a
   tracked query? Read `aio_present`/`aio_cites_us` as **three-state**: empty is
   *unknown* and must never be read as `false`. **Read it per `device`**: the
   same term is collected on a phone and on a desktop, and a term with an AI
   Overview on one device and none on the other is the finding, not a
   contradiction. Filter to one device before counting anything. Then group by
   `query_label` to ask the question of a *bet* rather than of a term ("are the
   calculators gaining — and on which device?"), where the asset's panel
   defines its clusters.

## The honesty rules (they are the contract)

These rules are the terms on which the data may be used. Each is enforced
upstream by the collector and the flattener; breaking them downstream produces
wrong conclusions that look certain.

- **A missing value is unknown, not zero.** A missing row, a missing file, or an
  empty CSV means *the provider did not report it*, which includes the case where
  the collector could not request it. Only
  `signal-trend-daily.csv` carries values you may treat as counts.
- **Provisional days are marked, not hidden.** `provisional=1` means the provider
  was still filling that day in when it was last collected. It is a real
  observation that will be revised upward. A later collection that reports the
  same number still settles the day.
- **A GA4 day is provisional until two days after it.** GA4
  keeps attributing a day after it ends, and its API does not report when it
  has finished, so a GA4 day stays `provisional=1` until it has been collected on
  day D+2 — in `signal-trend-daily.csv` and in the three attribution files. The
  newest GA4 day is therefore always provisional: read at D+1, a day can show
  ten times its normal "Unassigned" sessions and Organic Search well under
  Search Console's clicks. An "Unassigned" or `(data not available)` share
  above ~20% on a GA4 day marked `provisional=0` means this two-day rule is
  too short: file it in the OS's own task project. `executive.json`'s rules
  read only the `provisional=0` days of those three files: an unsettled day is set aside rather than labelled,
  a card built beside one lists it in a `Provisional days set aside` evidence
  row, and a file holding only unsettled days raises no card until they settle.
  So a `measurement-integrity` card about unattributed sessions is already about
  settled days, and it counts both halves of that signal: "Unassigned" /
  `(not set)` and `(data not available)`. GA4 writes
  `(data not available)` in the source/medium column, so it shows up in
  `ga4-traffic-sources.csv` rather than the channel file. Before reading the
  card as a tagging fault, check the per-day share in
  `ga4-traffic-acquisition.csv` and `ga4-traffic-sources.csv` against the ~20%
  threshold above.
- **GSC page/query exports are top-row.** They omit anonymized and low-volume
  queries by design, so their totals do not reconcile with the asset totals in
  `signal-trend-daily.csv`, and never will.
- **Bing weekly snapshots are revisions, not increments.** Summing two collection
  runs double-counts.
- **The `bing-ai-*` families are only as current as the last file a person
  imported.** They have no collector that could flag a missing export, so
  `freshness.json` `uncollected[]` records each one's age from its own newest
  export. Their `report_date` is an export day, not a measurement day.
- **GA4 rows are aggregate/modelled reports**, not raw event or session
  sequences.
- **DataForSEO values are provider models** — search volume, difficulty,
  estimated traffic and cost. They are for prioritizing review; they are not
  ROI, sessions, or users.
- **`best_rank` empty means "not inside the tracked depth"**, never "does not
  rank".
- **`query_label` is what the COLLECTION recorded, not what the config contains
  today.** The cluster is archived with each observation, so renaming a cluster
  in `config/serp-panel.json` changes the collections that follow and never the
  ones already stored — and an empty cell means that row was collected before its
  panel defined clusters (or that query has none), never "unclustered". History is
  not backfilled, and an asset that has never labelled a panel has no such
  column at all.
- **PostHog records only browsers that load it.** A browser or extension that
  blocks PostHog is not recorded, so PostHog's people and page views run **below
  GA4's**, and the gap is not a tracking bug.
- **PostHog drops known bots; GA4 does not.** PostHog's browser library filters
  known crawlers before they are counted, so a spike that shows in GA4 and not
  in PostHog can be a crawler rather than people.
- **Signed-in events are a floor.** On one asset, events from signed-in pages
  (`/my`) reach PostHog only after the account holder consents, so their counts
  and funnel steps are floors, never totals.
- **Server-side and browser people do not join.** Events sent from the server
  (`$lib` = that asset's worker, e.g. `example-worker`) carry account ids; browser events
  carry anonymous ids until consent. A unique-people count that spans the two
  counts one human twice — never add or compare them as one population.
- **An event with no properties is a design choice.** That asset sends its
  own events to PostHog **by name only** (a privacy rule in its
  `src/lib/analytics.ts`), so an absent property is correct, not a collector
  defect — do not file one.

## Do not re-pull

An asset repo must not call GA4, GSC, Bing, DataForSEO or PostHog's query API
about itself (its PostHog browser snippet, which SENDS events, is the asset's
own and stays). That is
a hard architectural rule (`docs/01-architecture.md`, `docs/09-onboarding-a-site.md`
design decision 1), not a preference, and with the panel tools, following it
costs nothing:

- **Credentials.** The provider credentials live in the OS's secret store. A
  asset that pulls its own analytics needs a copy of them, and a portfolio
  where five repos each hold Google service-account keys has five times the
  exposure if a key leaks, for no new information.
- **Quota and money.** DataForSEO is metered against a portfolio-wide $25/month
  data cap (`config/constants.json` `monthly_caps.data_usd`) with a fail-closed
  budget gate. Clarity allows ten calls per project per day. A repo that pulls
  independently spends from a shared budget without anyone tracking that repo's
  spending.
- **One measurement channel.** Analytics pipelines are a `forbidden` surface on
  the autonomy ladder because an agent that can change how results are measured
  will eventually do so. Reading a panel does not change measurement; adding a
  second collector does.

If the panel does not contain something you need, **file a task in the OS's own
task project** requesting the family. That is how `ga4-js-errors.csv` and the
tracked SERP panel were added.

## The stanza for an asset repo

Paste this into the asset's `AGENTS.md`, adjusting the asset id. The stanza
links to this doc instead of copying it, so it does not need to change when this
doc changes.

```markdown
## Search, traffic and product data come from NoticeOS

Never call GA4, Search Console, Bing Webmaster, DataForSEO, PostHog or Clarity
about this asset. NoticeOS collects them centrally and rebuilds this asset's
panel every day. Read it through the `noticeos` MCP server's panel tools:
`get_panel` with `asset: "<asset>"` first (its `attention` list names what is
failing, missing or old), then `query_panel` for SQL over its tables. Cite the
panel version you read in any finding.

Absent rows are unknown, never zero; `provisional=1` days are still filling in;
read one `report_date` at a time and never add `people` across rows.
Full contract and reading rules: docs/20-signal-panels.md in the NoticeOS repository.
Missing a report family you need? File it in the OS's own task project — do not
add a collector here.
```

## How the panels are produced (for the curious, and for whoever debugs it)

- **Collection** is already on the OS's crons: `15 12 * * *` archives GA4, GSC
  and Bing Webmaster to private R2 with a manifest row in the store; `45 12 * * 1` archives the
  weekly DataForSEO families behind a fail-closed spend gate; `30 4 * * *`
  archives Clarity.
- **Somebody is asked to read it.** Every asset whose weekly DataForSEO
  collection arrives gets one `panel-review` task in its **own** tracker, filed
  by the runner within the hour and due seven days after the collection day
  (`scripts/runner/panel-review.mjs` writes its requests). The review task for a
  asset with a tracked-query panel requests the panel walk *and* the
  inventory pass; for one without, it requests the inventory pass, which is all
  that its collection paid for. Only an asset that collects nothing gets no
  review task. The review task exists so that no panel dir goes unread.
  **One collection day is one review however many devices it covered**: the panel's
  two devices are one family, one archive and one manifest row, so the phone
  adds a second row per term to the walk, not a second task.
- **An asset that launched today can be collected before Monday.**
  `pnpm signals:collect -- --asset <id> [--families serp-panel]` (on a Compose
  installation, `pnpm os:collect -- --asset <id> [--families serp-panel]`)
  collects that one asset now, through the ingest's operator-authed
  `POST /api/signal-collect`. It runs the same collector the weekly cron runs,
  scoped — same spend gate, same retries — so the result is identical to a
  Monday collection and this refresh reads it without a special case. It pays
  only for that asset's families, which is why the command exists: firing
  the weekly cron early would pay for the whole portfolio's collection again.
- **A file the operator imports goes through the same path.** `pnpm bing-ai:import <path>`
  reads Bing's own filename for the asset and the export date, POSTs the file
  through the ingest's operator-authed `POST /api/bing-ai-export`, and refreshes
  that asset's panel dir in the same run. The archive is content-addressed
  over the file, so re-running it returns `unchanged` instead of double-counting;
  to check whether an import succeeded, run it again. A file with an
  unrecognized header is rejected with an error that lists the three supported
  exports. The parser accepts only the exact header rows of real exports,
  because guessing which column is which could corrupt data without any error.
- **The refresh** — the part this doc is about — runs at 13:10 UTC daily
  (`scripts/os-up.mjs` `CONFIG.panelRefreshCron`), after both archive collections
  have finished. It goes through each asset in the roster in
  [`config/signal-panels.json`](../config/signal-panels.json), fetches only
  archives this machine does not already hold, publishes Parquet history and
  analyzes that exact generation in a bounded DuckDB child. Reports,
  `signal-trend-daily.csv` and `freshness.json` become visible together at
  `reports/<asset>/`. The previous completed generation remains available if
  analysis fails. Earlier plain `analysis/<asset>/` folders remain untouched.
  Before the first asset, the pass reads the installation's collection health
  once (`GET /api/integrations/health` on the Tower, the read behind the
  Integrations page) and records each family's state in that asset's
  `freshness.json`; a failed read is recorded as unavailable and the panel
  still publishes.
- **It costs nothing.** A pass makes **zero provider calls**. Every byte it
  writes was already fetched by the collectors above; the refresh reads them
  back out of R2 and Postgres through the running ingest Worker
  (`GET /api/panel-source`, `GET /api/panel-object`, operator-authed, loopback
  only). So the cadence is chosen for the freshness target, not for the budget —
  daily across the whole portfolio moves monthly data spend by **$0.00**.
- **It uses the ingest boundary.** The refresh needs no database credentials.
  The hand path uses the same boundary (`signals:download` reads
  `GET /api/signal-archives`, `signals:publish-insights` writes
  `POST /api/insight-snapshot`), so a panel dir built by hand and one built by
  the cron come from the same runtime and the same rows.
- **A new cron takes effect on the app's next start.** The runner reads its
  schedule at startup, so a new cron takes effect after `pnpm os:update` or
  `pnpm os:restart`.

## Who edits the roster: the Tower's Growth tab

Both files this doc points at are edited from
one place in the Tower — the asset's own **Growth** tab
(`/assets/<id>/growth`), in a *Tracked panels* section under the board that
displays the panel:

| What | File | What the surface may do |
|---|---|---|
| **Tracked queries** — the terms for which the weekly DataForSEO collection buys a live result page | [`config/serp-panel.json`](../config/serp-panel.json) `/assets/<id>/queries` | add, relabel, remove, one changeset each with Undo. The FIRST term creates the asset's whole entry (a JSON-pointer write never creates structure) and the LAST removal deletes it again, because an empty `queries` array is a config error there while absence is a valid state |
| **Panel refresh** — this roster's own row | [`config/signal-panels.json`](../config/signal-panels.json) `/assets/<id>` | change `enabled`, `reason`, `note`, `since`. Never remove — a row is removed with its asset, through the Settings tab's Delete — and Add only when the row is missing, which repairs the membership invariant rather than growing the roster |

Neither file can be written whole: both stay out of the config write path's
`ALLOWED_FILES`, and the section's edits are permitted by the register
declarations in `scripts/config-registers.mjs`, which the write path also
checks to reject any other edit. The
refresh block, the cadence and `freshnessMaxAgeDays` are still hand edits.

**The two are handled differently on purpose.** Turning the roster on costs
nothing — a refresh pass makes zero provider calls, at any cadence — while
adding a tracked query is a standing weekly bill *and* a standing weekly review
obligation, so the section shows the cost of that one: a meter above the Add
control shows the panel's weekly cost and its size against the query limit, and
the section names the spending cap that already exists (the portfolio's
`monthly_caps.data_usd`, on `/settings`) rather than adding a second one.

## What this does not carry yet

- **"Is THIS page indexed?"** `index-coverage.csv` shows *how many* of our
  pages are indexed — Bing's count, asset-level. It lists no URLs, so this
  directory has no data for the per-page question, and a page's absence from any
  file in this directory remains **unknown**, never "not indexed". Google has no
  Index Coverage API; the endpoint that reports per URL is its URL Inspection
  endpoint, which is metered per property (2000/day, 600/minute) and so needs a
  page roster and a rotation policy before it can exist.
- An asset is off the roster until its collectors go live, so that an empty dir
  is never mistaken for an asset whose traffic fell to zero.
