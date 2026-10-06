# 20 — Signal panels: the read contract for property repos

The [remote panel review build contract](briefs/2026-10-05-remote-panel-review.md)
defines the target API/MCP path and publication guarantees. The file-oriented
instructions below describe the existing path; they do not establish remote
access or immutable panel versions.

*The portfolio's standing answer to "what happened in search for this property
this week." NoticeOS collects GA4, Google Search Console, Bing Webmaster,
DataForSEO and PostHog centrally, flattens them into one directory per property, and keeps
that directory current on a cadence. **A property repo reads those files. It
never calls a provider about itself.***

This doc is written for the agent standing in a property's repo, not for
NoticeOS. If you are here to change how panels are produced, the machinery is
`scripts/signal-panels-refresh.mjs`, the roster is
[`config/signal-panels.json`](../config/signal-panels.json), and the
per-integration lane register is
[`config/integrations.json`](../config/integrations.json).

## The read path

```text
../noticeos/.local/signal-dumps/reports/<asset>/
```

The portfolio is laid out as siblings, so from any property repo the panel dir is
`../<the OS checkout>/.local/signal-dumps/reports/<your asset id>/` —
`../noticeos/…` for a checkout cloned under its own name. `<asset>` is the
site id exactly as the store spells it — for example `example.com`.

The directory is **gitignored working data**, not a committed artifact. It exists
on the operator's machine, where the OS runs. Read it; do not vendor it into a
property repo, and do not treat a copy you made last month as current.

## First: is it current?

**`freshness.json` is the first file you open.** It is written on every refresh
pass and it is the panel's own claim about itself:

```json
{
  "asset": "example.com",
  "refreshedAt": "2026-08-03T13:10:04.221Z",
  "maxAgeDays": 7,
  "fresh": true,
  "sources": [
    { "key": "bing-webmaster", "integration": "bing-webmaster", "collected": true, "newestReportDate": "2026-08-01", "ageDays": 2, "fresh": true },
    { "key": "ga4",            "integration": "ga4",            "collected": true, "newestReportDate": "2026-08-02", "ageDays": 1, "fresh": true },
    { "key": "gsc",            "integration": "gsc",            "collected": true, "newestReportDate": "2026-08-01", "ageDays": 2, "fresh": true }
  ],
  "stale": [],
  "uncollected": [
    { "key": "bing-webmaster/ai-queries", "integration": "bing-webmaster", "report": "ai-queries", "collected": false, "newestReportDate": "2026-02-14", "ageDays": 170, "fresh": false }
  ],
  "staleUncollected": ["bing-webmaster/ai-queries"]
}
```

- `sources[].newestReportDate` is the newest **provider report day** that
  integration has on disk — not when the file was written. Providers lag: GSC is
  typically 1–3 days behind, Bing's top-query and top-page snapshots update
  weekly.
- `fresh` is per integration against `maxAgeDays`, and the top-level `fresh` is
  true only when every source is. A property whose GSC is current and whose Bing
  stalled is a **partial** answer, and `stale` names which half.
- **No sources at all is `fresh: false`, never `true`.** An empty panel dir and a
  collapsed property look identical on disk, so "nothing to measure" is answered
  "no", never vacuously "yes".
- **`uncollected[]` is the families no cron produces**, aged from their own
  newest export rather than from the integration they share — today, the three
  `bing-webmaster-ai-*` exports (family contract below). Without this the nightly
  `bing-webmaster` API collection vouched for an AI export that could be six
  months old, and the reader had to already know which families were exempt from
  the claim `sources[]` was making. They are excluded from `sources[]` in both
  directions: a stale export cannot drag the integration down, and an export
  dropped this morning cannot make last night's collection look fresher than it
  was.
- **They do not move the top-level `fresh`**, and `staleUncollected` is a
  separate list, because there is no promised cadence for them to miss. Folding
  a file an operator drops every few months into the panel's headline boolean
  would leave every panel permanently red — the standing-noise failure that gets
  a signal ignored. The refresh cadence these families DO have is owned by the
  property's weekly panel-review bead: when a review finds them >~2 weeks old,
  the operator export is one of that review's asks (owner ruling 2026-08-20;
  the mechanics live in
  [serp-opportunity-execution — Inventory pass](playbooks/serp-opportunity-execution.md#inventory-pass)).
  `fresh` answers "are the collectors current?"; `uncollected[]`
  answers "how old is the hand-dropped file?", out loud, in the file you already
  opened.
- **`freshness.json` missing means the refresh has never run for this property.**
  Check [`config/signal-panels.json`](../config/signal-panels.json): the property
  may be deliberately off the roster, and the entry says why. The operator can
  read the same row — and turn it on — from the Tower, on that asset's
  **Growth** tab (`/assets/<id>/growth`, section *Tracked panels*); see
  [Who edits the roster](#who-edits-the-roster-the-towers-growth-tab) below.

If the panel is stale, say so in whatever you produce. A conclusion drawn from a
three-week-old panel and labeled as this week's is worse than no conclusion.

## What is in the directory

One CSV per provider report family, named `<integration>-<report>.csv`, plus
three files that are not raw families:

| File | The question it answers |
|---|---|
| `signal-trend-daily.csv` | **Did clicks and impressions move?** The normalized daily site-level series — one row per `date,integration,metric,value,provisional`. The only file here that can be summed and differenced honestly. |
| `gsc-query.csv`, `gsc-page.csv`, `gsc-page-query.csv` | **Which queries and pages?** Google's per-day top-row exports, with `row_grain` separating property totals from page-level rows. |
| `gsc-country.csv`, `gsc-device.csv`, `gsc-page-country.csv`, `gsc-page-device.csv` | Where and on what. |
| `gsc-discover-page.csv`, `gsc-image-page-query.csv`, `gsc-search-appearance-pages.csv` | Discover, image search, and rich-result appearance. Frequently empty — see the absence rule below. |
| `bing-webmaster-queries.csv`, `-pages.csv`, `-rank-traffic.csv` | The same shape from Bing. **Weekly snapshots that get revised — never sum them across collection runs.** |
| `bing-webmaster-crawl-stats.csv`, `-crawl-issues.csv`, `-feeds.csv` | Crawl health and sitemap state. |
| `bing-webmaster-ai-overview.csv` | **Is an AI assistant citing this property, and since when?** Daily citations and cited-page counts from Bing's AI Performance report. `provider_date` is the day measured; `report_date` is the day the file was exported. |
| `bing-webmaster-ai-queries.csv`, `-ai-pages.csv` | **Which questions, and which pages.** Grounding queries (with `intent`, `topic`, `citation_share_percent`) and cited pages. Period totals as of `report_date` — no per-day breakdown exists. See the family contract below: these arrive by hand, not by cron. |
| `ga4-traffic-acquisition.csv`, `-traffic-sources.csv`, `-landing-pages.csv`, `-landing-page-acquisition.csv`, `-pages-screens.csv` | **What did the traffic do once it arrived?** The three attribution files (`-traffic-acquisition`, `-traffic-sources`, `-landing-page-acquisition`) carry `provisional` — see the honesty rules. |
| `ga4-events.csv`, `-events-28d.csv`, `-page-events.csv` | Conversions and interactions. |
| `ga4-js-errors.csv` | Client-side errors by `message_bucket`. Only where GA4 custom dimensions are registered. |
| `dataforseo-ranked-keywords.csv`, `-backlinks-summary.csv`, `-backlinks-new-lost.csv`, `-llm-mentions-*.csv` | Weekly off-property intelligence: rankings, links, AI mentions. Launched properties only. |
| `dataforseo-serp-panel.csv` | The tracked-query result-page panel (doc 08 §S1b). Configured properties only. **Two rows per term** since 2026-08-04 — one per `device` (`mobile`, `desktop`); never sum or average across them. `query_label` groups the rows by the **bet** each query measures, where the panel names one. |
| `index-coverage.csv` | **How many of our pages are indexed, and is that number moving?** Bing's own count, one row per measured day, plus the sitemap URL counts we submitted. **Derived** from families already archived — no collector, no quota. See the contract below: it is Bing's index, it is site-level, and it says nothing about any single URL. |
| `clarity-url-3d.csv` | Behavior rankings from Microsoft Clarity. Configured projects only. On one site it is history: Clarity was removed from the site on 2026-09-07 and PostHog replaced it. |
| `posthog-web-daily.csv` | **How many people used the site each day?** One row per `date`: `pageviews`, `people` (unique within that day), `sessions`. Trailing 28 days per read; a repeated day resolves to the newest read. PostHog projects only — see [the PostHog families](#the-posthog-families-product-data) below. |
| `posthog-events.csv` | **Which actions happen, and by how many people?** One row per `event` over the read's window: `count`, `people`, `first_seen`, `last_seen`. Top 500 by count, trailing 14 days. |
| `posthog-exceptions.csv` | **What breaks in the browser, and for how many people?** One row per exception `message` (200 characters at most): `count`, `people`, `sessions`, `max_per_session`, `has_source_file`, `top_path`, `top_browser`. Top 100 by count, trailing 14 days. |
| `posthog-rageclicks.csv` | **Which controls frustrate people?** One row per page + element (`path`, `tag`, `text`, `attr`): `clicks`, `people`, clicks by device, and `page_people` — the people who viewed that page in the window, the denominator. Top 100 by people, trailing 14 days. |
| `posthog-web-vitals.csv` | **How fast is the site for real visitors?** One row per page + `device` + `os`: 75th-percentile `lcp_p75`, `inp_p75`, `fcp_p75` (ms) and `cls_p75`, plus `measurements`. The 20 most-measured pages, trailing 14 days. |
| `posthog-funnels.csv` | **Where do people drop out of a journey?** One row per configured funnel step: `funnel_id`, `name`, `step`, `event`, `path`, `people`, ordered-step conversion inside a trailing 7-day window. Each read is kept beside the one before it for the week-over-week comparison. |
| `executive.json` | A **deterministic** rules-engine reading of the above — findings with source, evidence window, exact facts, confidence, and limitation. Not an LLM summary. |
| `summary.json` | Row counts per family, the archive manifest behind them, and the collection caveats. |

Not every property has every file. One site joined the DataForSEO lane on
2026-08-05 after the operator confirmed it live, but still has no
`clarity-url-3d.csv`; that file exists only where a Clarity project token is
provisioned. **A family that is absent is absent, not zero** — check
`summary.json` before concluding anything from a missing file.

## The `bing-ai` family: the one nobody collects

The three `bing-webmaster-ai-*.csv` files are the only families in this
directory that **no cron produces**. Bing Webmaster Tools' AI Performance report
— which questions Microsoft's assistants answered using this property, and which
pages they cited — exists in the dashboard and behind an Export button, and
nowhere on the documented API surface
([doc 11 §Bing AI Performance boundary](11-integrations.md#bing-ai-performance-boundary)).
Scraping the dashboard is ruled out on principle. So a human downloads a file and
one command turns it into evidence.

| | |
|---|---|
| **Provider** | Bing Webmaster Tools, AI Performance report (public preview). Same account and same verified site as the other `bing-webmaster-*` families — that is why they share the integration id. |
| **How it arrives** | An operator downloads the CSV and runs `pnpm bing-ai:import <file>`. Three exports exist: the daily overview series, the grounding-query report, and the page report. |
| **Grain** | `ai-overview` — one row per calendar day (`provider_date`), citations and cited pages. `ai-queries` — one row per grounding query for the export period. `ai-pages` — one row per cited page for the export period. |
| **Its date** | `report_date` is the day the FILE was exported, for all three. Two of the exports carry no date column at all; the query and page totals are period figures whose period Bing does not state. Do not read `report_date` as a measurement day, and do not difference two `ai-queries` exports as if they covered disjoint periods. |
| **Repeat exports** | Additive nowhere. A second export of the daily series re-sends every day it overlaps; the flattener resolves an overlapping day to the newest export, because a repeated Bing snapshot is a revision. Query and page exports append as a **dated series** — one set of rows per export date — so a query's rise over two exports is a real comparison of two snapshots, not of two periods. |
| **What absence means** | **Nobody has dropped that export yet.** An empty or missing file is never "Bing's assistants cite nothing". |
| **How you know how old it is** | `freshness.json` `uncollected[]`, one row per family, aged from that family's own newest `report_date` (`ro-b3t.2`, 2026-08-04). Before that these families had no collector to go stale loudly *and* no entry of their own, so the nightly `bing-webmaster` API collection vouched for them; the reader had to already know which families were exempt. They are still outside the top-level `fresh` — there is no cadence here to miss — so read `uncollected[]`, not just the headline. A family nobody has ever dropped has no row at all: absence is absence, never a stale claim about a file that does not exist. |
| **Where the originals are** | Every dropped file is archived byte-identical (base64, inside the gzip JSON archive in private R2) alongside the parse, so any later reader can redo the read without asking for a download that no longer exists. |

## The PostHog families: product data

*(2026-09-22, beads `ro-ghis.2`, `ro-ghis.3`.)* Search data says how people
arrive; PostHog says **what they do once they are here, and where it breaks** —
funnels, errors, rage clicks and real-visitor speed. It is collected per property
(each has its own PostHog project, host and read-only key, connected on the
Tower's Integrations page) and lands here as six `posthog-*.csv` files.

| | |
|---|---|
| **Provider** | PostHog, one project per property. Every read is an aggregate PostHog computes server-side; raw events never leave PostHog. |
| **Grain** | Every family except `web-daily` is a **window aggregate**: one row per event, message, page element, page segment or funnel step, over the read's own window. `web-daily` is one row per day. `row_grain` names which. |
| **Its dates** | `window_start`–`window_end` (inclusive, in the PostHog project's timezone, `project_time_zone`) is what a row measures. `report_date` is the window's end. **Read the window from the row**, never from `report_date`: a manual collection can end on the same day as the daily read over a different window. |
| **Windows on the daily read** | `web-daily` 28 days; `events`, `exceptions`, `rageclicks`, `web-vitals` 14 days; `funnels` 7 days. |
| **Repeat reads** | Consecutive daily reads overlap almost completely. **Read one `report_date` at a time** and never add rows across report dates. `web-daily` is resolved for you: a day re-sent by a later read keeps only the newest read's row. `funnels` keeps every read, so a funnel can be compared with the read that ended seven days earlier. |
| **People never add** | `people` is PostHog's unique-person count over that row's window. It does not add across rows (one person can hit three errors), across days, or across report dates. |
| **Row limits** | Each family is cut at a row limit (above). `provider_truncated=true` means the limit was reached, so the file is a top-N read and any total built from it is a floor. `row_limit` states the cut. |
| **What absence means** | An **empty** file (header only) is PostHog answering with no rows for that window — for example, no rage clicks captured. A **missing** file is a family nobody collected for this property. Neither is a measured zero for the site: see the honesty rules below. |
| **Rules over it** | `executive.json` carries five deterministic PostHog rules — rage-click clusters, error concentration with noise set aside, once-only events that repeat, real-visitor speed against Google's lines, and each funnel's largest drop — plus a `product` block the Tower's Growth tab reads. Each rule reports *fired*, *clear*, *not enough data* (naming the floor it missed) or *not collected*. |

## `index-coverage.csv`: the one family nobody collected

`gsc-page.csv` and `bing-webmaster-pages.csv` list pages that received
**impressions** — a strict subset of the indexed set, silent about a page that is
indexed and invisible. So a property watching traffic fall could not tell **"we
lost rankings" from "we lost the index"**, which are different emergencies with
different fixes. This family answers the second question, out of bytes the
nightly Bing lane already bought.

| | |
|---|---|
| **Provider** | **Bing Webmaster Tools**, and only Bing. Derived from the `crawl-stats` and `feeds` families this directory already carries — `GetCrawlStats` reports `InIndex`, Bing's count of this site's pages in its index, and `GetFeeds` reports each submitted sitemap's `UrlCount`. **Google has no Index Coverage API**; its per-URL Inspection endpoint is a separate, quota-budgeted lane that does not exist yet (`ro-2zk.4`). |
| **Cost** | Zero. No request, no quota, no credential: it is a view over archives the `15 12 * * *` cron already wrote. |
| **Grain** | Two, separated by `row_grain`. `site-day` — one row per day Bing measured: `pages_in_index`, `pages_crawled`, `crawl_errors`, `blocked_by_robots_txt`. `sitemap` — one row per submitted sitemap from the **newest collection only**: `urls_submitted`, `sitemap_status`, `sitemap_last_crawled`. |
| **Refresh** | Daily, with the Bing lane. Bing re-sends the whole daily series every collection, so a repeated day is a **revision**: the newest collection wins and nothing is summed across runs. |
| **No ratio** | The file computes no "coverage %". The index count is dated to a measured day; the sitemap count is "as of the last collection". A single percentage would look exact while straddling two dates — divide them yourself, knowing that. |
| **What absence means** | **UNKNOWN — never "not indexed".** A missing file means the Bing lane collected nothing for this property (unverified site, failed family, pre-launch), not an empty index. A URL you cannot find here is not absent from the index: this family is **site-level** and names no URLs at all. And it is Bing's answer — Google indexes different things, so a healthy `pages_in_index` is not evidence about Google, and a falling one is a lead to check in Search Console, not a verdict. |

## Answering "what happened in search this week"

1. `freshness.json` — is the panel current, and which integrations?
2. `signal-trend-daily.csv` — filter to `integration=gsc`, `metric=clicks` and
   `metric=impressions`, take the last 7 complete days against the 7 before.
   **Ignore rows with `provisional=1` when computing a change**: those are days
   the provider had not finished reporting, and they will rise.
3. `gsc-query.csv` and `gsc-page.csv` — which queries and pages carry the change.
   `gsc-page-query.csv` joins the two.
4. `bing-webmaster-rank-traffic.csv` — did Bing move the same way? A move on one
   engine only is usually a ranking change; a move on both is usually the site.
   If both moved, `index-coverage.csv` next: filter to `row_grain=site-day` and
   read `pages_in_index` across the drop. A falling index is a different
   emergency from falling rankings — and a flat one rules that emergency out for
   Bing, though never for Google.
5. `executive.json` — what the rules engine already noticed, with its evidence.
6. `dataforseo-serp-panel.csv`, where present — did an AI Overview appear on a
   tracked query? Read `aio_present`/`aio_cites_us` as **three-state**: empty is
   *unknown* and must never be read as `false`. **Read it per `device`**: the
   same term is collected on a phone and on a desktop, and a term walled by an
   overview on one surface and clear on the other is the finding, not a
   contradiction. Filter to one device before counting anything. Then group by
   `query_label` to ask it of a *bet* rather than of a term ("are the calculators
   winning — and on which surface?"), where the property's panel names its
   clusters.

## The honesty rules (they are the contract)

These are not caveats, they are the terms on which the data may be used. Each is
enforced upstream by the collector and the flattener; breaking them downstream
produces confident wrong answers.

- **Absent is never zero.** A missing row, a missing file, or an empty CSV means
  *the provider did not report it*, which includes "we could not ask". Only
  `signal-trend-daily.csv` carries values you may treat as counts.
- **Provisional days are marked, not hidden.** `provisional=1` means the provider
  was still filling that day in at collection time. It is a real observation that
  will be revised upward.
- **A GA4 day is provisional until it has had two days** (bead `ro-wo0j`). GA4
  keeps attributing a day after it ends, and its API says nothing about when it
  has finished, so a GA4 day stays `provisional=1` until it has been collected on
  day D+2 — in `signal-trend-daily.csv` and in the three attribution files. The
  newest GA4 day is therefore always provisional. On one site's 2026-09-21,
  read at D+1, 3,380 sessions sat in "Unassigned" (101–340 on every other day)
  and Organic Search read 1,096 against Search Console's 1,398 clicks. An
  "Unassigned" or `(data not available)` share above ~20% on a GA4 day marked
  `provisional=0` means this two-day rule is too short: file it in the OS's own task project.
  `executive.json`'s rules read only the `provisional=0` days of those three
  files (bead `ro-5e8.10`): an unsettled day is set aside rather than labelled,
  a card built beside one names it in a `Provisional days set aside` evidence
  row, and a file holding only unsettled days raises no card until they settle.
  So a `measurement-integrity` card about unattributed sessions is already about
  settled days, and it counts both halves of that signal: "Unassigned" /
  `(not set)` and `(data not available)` (bead `ro-5e8.11`). GA4 writes
  `(data not available)` in the source/medium column, so it shows up in
  `ga4-traffic-sources.csv` rather than the channel file. Before reading the
  card as a tagging fault, check the per-day share in
  `ga4-traffic-acquisition.csv` and `ga4-traffic-sources.csv` against the ~20%
  line above.
- **GSC page/query exports are top-row.** They omit anonymized and low-volume
  queries by design, so their totals do not reconcile with the site totals in
  `signal-trend-daily.csv`, and never will.
- **Bing weekly snapshots are revisions, not increments.** Summing two collection
  runs double-counts.
- **The `bing-ai-*` families are only as current as the last file a human
  dropped.** They have no collector to notice their own silence, so
  `freshness.json` `uncollected[]` states each one's age from its own newest
  export. Their `report_date` is an export day, not a measurement day.
- **GA4 rows are aggregate/modelled reports**, not raw event or session
  sequences.
- **DataForSEO values are provider models** — search volume, difficulty,
  estimated traffic and cost. They prioritize review; they are not ROI, sessions,
  or users.
- **`best_rank` empty means "not inside the tracked depth"**, never "does not
  rank".
- **`query_label` is what the COLLECTION recorded, not what the config says
  today.** The cluster is archived with each observation, so renaming a cluster
  in `config/serp-panel.json` changes the collections that follow and never the
  ones already stored — and an empty cell means that row was collected before its
  panel named clusters (or that query has none), never "unclustered". History is
  not backfilled, and a property that has never labelled a panel has no such
  column at all.
- **PostHog sees only browsers that load it.** A browser or extension that
  blocks PostHog is invisible, so PostHog's people and page views run **below
  GA4's**, and the gap is not a tracking bug (one site's bead `mp-hsx5` tracks it).
- **PostHog drops known bots; GA4 does not.** PostHog's browser library filters
  known crawlers before they are counted, so a spike that shows in GA4 and not
  in PostHog can be a crawler rather than people (one site's `mp-xbpk` is the first
  case).
- **Signed-in events are a floor.** On one site, events from signed-in pages
  (`/my`) reach PostHog only after the account holder consents, so their counts
  and funnel steps are floors, never totals.
- **Server-side and browser people do not join.** Events sent from the server
  (`$lib` = that site's worker, e.g. `example-worker`) carry account ids; browser events
  carry anonymous ids until consent. A unique-people count that spans the two
  counts one human twice — never add or compare them as one population.
- **An event with no properties is a design choice.** That site sends its
  own events to PostHog **by name only** (a privacy rule in its
  `src/lib/analytics.ts`), so an absent property is correct, not a collector
  defect — do not file one.

## Do not re-pull

A property repo must not call GA4, GSC, Bing, DataForSEO or PostHog's query API
about itself (its PostHog browser snippet, which SENDS events, is the property's
own and stays). That is
a hard architectural rule (`docs/01-architecture.md`, `docs/09-onboarding-a-site.md`
design decision 1), not a preference, and the panel dir is what makes obeying it
free:

- **Credentials.** The provider credentials live in the OS's secret store. A
  property that pulls its own analytics needs a copy of them, and a portfolio
  where five repos each hold Google service-account keys has five times the blast
  radius for no new information.
- **Quota and money.** DataForSEO is metered against a portfolio-wide $25/month
  data cap (`config/constants.json` `monthly_caps.data_usd`) with a fail-closed
  budget gate. Clarity allows ten calls per project per day. A repo that pulls
  independently spends a shared budget nobody is watching on its behalf.
- **One measurement channel.** Analytics pipelines are a `forbidden` surface on
  the autonomy ladder precisely because an agent that can edit the ruler
  eventually will. Reading a panel is not editing a ruler; adding a second
  collector is.

If the panel does not carry something you need, **file a task in the OS's own
task project** asking for the family. That is how `ga4-js-errors.csv` and the tracked
SERP panel got here.

## The stanza for a property repo

Paste this into the property's `AGENTS.md`, adjusting the asset id. Pointer, not
a copy — this doc moves, the stanza does not need to.

```markdown
## Search and traffic data comes from NoticeOS

Never call GA4, Search Console, Bing Webmaster or DataForSEO about this property.
NoticeOS collects them centrally and keeps a flattened panel current:

    ../noticeos/.local/signal-dumps/reports/<asset>/

Open `freshness.json` first (is it current, which integrations, and how old is
anything under `uncollected[]`?), then
`signal-trend-daily.csv` for the daily clicks/impressions series, then the
per-family CSVs for which query or page moved. Absent rows are unknown, never
zero; `provisional=1` days are still filling in.

Product data — funnels, errors, rage clicks, real-visitor speed — is in the
`posthog-*.csv` files. Do not query PostHog's API about this property; read one
`report_date` at a time and never add `people` across rows.

Full contract, file list, and honesty rules: `../noticeos/docs/20-signal-panels.md`.
Missing a family you need? File it in the OS's own task project — do not add a collector here.
```

## How the lane runs (for the curious, and for whoever debugs it)

- **Collection** is already on the OS's crons: `15 12 * * *` archives GA4, GSC
  and Bing Webmaster to private R2 with a D1 manifest; `45 12 * * 1` archives the
  weekly DataForSEO families behind a fail-closed spend gate; `30 4 * * *`
  archives Clarity.
- **Somebody is asked to read it.** Every property whose weekly DataForSEO
  collection lands gets one `panel-review` bead in its **own** tracker, filed by
  the runner within the hour and due seven days after the collection day
  ([serp-opportunity-execution](playbooks/serp-opportunity-execution.md)). A
  property with a tracked-query panel is asked for the panel walk *and* the
  inventory pass; one without is asked for the inventory pass, which is the whole
  of what it bought (`ro-478`). Only a property that collects nothing owes
  nothing — a panel dir with no reader is the failure this lane exists to end.
  **One collection day is one review however many devices it swept**: the panel's
  two devices are one family, one archive and one manifest row, so the phone did
  not add a second bead — it added a second row per term to the walk.
- **A property that launched today does not wait for Monday.**
  `pnpm signals:collect -- --asset <id> [--families serp-panel]` collects that
  one property now, through the ingest's operator-authed
  `POST /api/signal-collect`. It runs the same collector the weekly cron runs,
  scoped — same spend gate, same retries — so the landing is indistinguishable
  from a Monday one and this refresh reads it without a special case. It bills
  that property's families and no other property's, which is the whole reason it
  exists: firing the weekly cron early re-bills the portfolio.
- **A file the operator drops joins the same lane.** `pnpm bing-ai:import <path>`
  reads Bing's own filename for the property and the export date, POSTs the file
  through the ingest's operator-authed `POST /api/bing-ai-export`, and refreshes
  that property's panel dir in the same run. The archive is content-addressed
  over the file, so re-running it answers `unchanged` instead of double-counting
  — "did that land?" is answered by doing it again. An unrecognized header is
  refused, loudly, naming the three exports it knows: guessed columns are how
  silent corruption starts, and that is the whole reason this lane waited for a
  real file (`ro-2dn`).
- **The refresh** — the part this doc is about — runs at 13:10 UTC daily
  (`scripts/os-up.mjs` `CONFIG.panelRefreshCron`), after both archive lanes have
  landed. It walks the roster in
  [`config/signal-panels.json`](../config/signal-panels.json), fetches only
  archives this machine does not already hold, publishes Parquet history and
  analyzes that exact generation in a bounded DuckDB child. Reports,
  `signal-trend-daily.csv` and `freshness.json` become visible together at
  `reports/<asset>/`. The previous completed generation remains available if
  analysis fails. Earlier plain `analysis/<asset>/` folders remain untouched.
- **It costs nothing.** A pass makes **zero provider calls**. Every byte it
  writes was already bought by the collectors above; the refresh reads them back
  out of R2 and Postgres through the running ingest Worker
  (`GET /api/panel-source`, `GET /api/panel-object`, operator-authed, loopback
  only). So the cadence is chosen for the freshness bar, not for the budget —
  daily across the whole portfolio moves monthly data spend by **$0.00**.
- **It uses the ingest boundary.** The refresh needs no database credentials.
  The hand path uses the same boundary (`signals:download` reads
  `GET /api/signal-archives`, `signals:publish-insights` writes
  `POST /api/insight-snapshot`), so a panel dir built by hand and one built by
  the cron come from the same runtime and the same rows.
- **A new cron arms on the operator's next `os:up` restart.** The runner reads
  its schedule at startup.

## Who edits the roster: the Tower's Growth tab

*(2026-09-05, bead `ro-x5gu.4`.)* Both files this doc points at are edited from
one place in the Tower — the asset's own **Growth** tab
(`/assets/<id>/growth`), in a *Tracked panels* section under the board that
reads the panel back:

| What | File | What the surface may do |
|---|---|---|
| **Tracked queries** — the terms the weekly DataForSEO lane buys a live result page for | [`config/serp-panel.json`](../config/serp-panel.json) `/assets/<id>/queries` | add, relabel, remove, one changeset each with Undo. The FIRST term files the asset's whole entry (a pointer never creates structure) and the LAST removal takes it away again, because an empty `queries` array is a config error there while absence is a valid state |
| **Panel refresh** — this roster's own row | [`config/signal-panels.json`](../config/signal-panels.json) `/assets/<id>` | change `enabled`, `reason`, `note`, `since`. Never remove — a row leaves with its asset, through the Settings tab's Delete — and Add only when the row is missing, which repairs the membership invariant rather than growing the roster |

Neither file became wholesale-writable: both stay off the write lane's
`ALLOWED_FILES`, and the surface is licensed by the register declarations in
`scripts/config-registers.mjs`, which is also what the lane refuses against. The
refresh block, the cadence and `freshnessMaxAgeDays` are still hand edits.

**The asymmetry between the two is the point.** Turning the roster on costs
nothing — a refresh pass makes zero provider calls, at any cadence — while
adding a tracked query is a standing weekly bill *and* a standing weekly review
obligation, so that is the one the surface prices: it prints the panel's weekly
cost and its size against the query ceiling as a meter above the Add control,
and names the guard that already exists (the portfolio's
`monthly_caps.data_usd`, on `/settings`) rather than inventing a second one.

## What this does not carry yet

- **"Is THIS page indexed?"** `index-coverage.csv` answers *how many* of our
  pages are indexed — Bing's count, site-level. It names no URLs, so the
  per-page question is still unanswered here, and a page's absence from any
  file in this directory remains **unknown**, never "not indexed". Google has no
  Index Coverage API; the surface that answers per-URL is its URL Inspection
  endpoint, which is metered per property (2000/day, 600/minute) and so needs a
  page roster and a rotation policy before it can exist — bead `ro-2zk.4`.
- **One site** is off the roster until its collectors go live
  (`ro-2zk.2`), so that an empty dir never gets mistaken for a collapse.
