# 08 — SEO / SERP / GEO signal reference

*The search-signal families (S1–S6) as centrally-pulled **signals** under the
[signal contract](02-signal-contract.md). This is the domain reference; the
contract defines shapes/flags/latency rules, [doc 03](03-attribution.md)
defines how any of it becomes a causal claim, and the ledger ([doc 00](00-objective-and-roi.md))
is where value is booked — positions and citations are inputs, never outcomes.*

The asset's own report ([doc 02](02-signal-contract.md)) covers the *on-site*
half of each asset's health. This doc specifies the *demand-side* half: organic search and AI
answer engines, asset-agnostic from day one, same as the signal contract.

**Two facts determine the design:**
1. **A citation in an AI Overview has replaced the featured snippet ("position
   zero") as the top placement.** With an AI Overview present, organic #1
   loses ~58% of clicks; *cited* pages get ~2.3× the CTR of uncited ones. So we
   track "are we cited?" as a first-class dimension next to rank.
2. **Brand mentions predict AI visibility ~3× better than backlinks do**
   (Ahrefs, 75k brands). So brand-demand and mention signals are KPIs, not vanity metrics.

## Signals live in NoticeOS, not in asset workers

Unlike the asset's report (each asset reports on itself), SEO signals are
pulled **centrally** by NoticeOS crons: the external APIs (GSC, GA4,
DataForSEO) need portfolio-level credentials and a shared spend budget, and
none of it requires code inside the asset. Assets contain no search-signal
code; the Tower joins the asset's report × search signals on the asset id. One table family in the store, one row per (asset, date, signal).

## Signal families

### S1 — Domain-wide ranking intelligence

The weekly central DataForSEO collection reads each launched domain from Postgres and
archives its top 200 current Google rankings in the site's saved market
(United States · English by default). Each row keeps the
query, ranking URL/type/position, estimated demand, CPC, difficulty, intent,
SERP features, estimated visits/cost, rank-change fields, and any AIO-reference
result. This broad inventory is used for:

- current top-3/top-10/top-20 footprint;
- ranked near-win recommendations that exclude navigational and home-page
  queries before prioritizing volume, rank, CPC, and difficulty;
- locally retained week-over-week rank gains/losses;
- AIO-reference counts without relabeling ordinary organic rows as AI.

The 200-row ceiling is explicit and means “highest-volume provider rows,” not
complete keyword coverage.

The property-detail read model exposes a bounded current query baseline from
this archive even before a second weekly snapshot exists: modelled monthly
searches, organic position, keyword difficulty, landing page, SERP AI Overview
presence, and query-level `ai_overview_reference` citation position. It joins
those facts by normalized query to GSC/BWT movement for presentation, but never
labels search volume as impressions. Rank movement is local evidence only when
the same query/page pair exists in two retained snapshots.

### S1b — Tracked-query SERP panel

The weekly Monday DataForSEO collection's `serp-panel` family makes one
`serp/google/organic/live/advanced` call per (tracked term, device) with
`load_async_ai_overview` set, archived to the same immutable R2 + append-only
manifest boundary as the other families (one manifest row per property per
run, the per-query responses as its pages). The panel itself is
[`config/serp-panel.json`](../config/serp-panel.json) (+ README sibling); the
flattened family is `dataforseo-serp-panel.csv`. Full collector behavior:
[workers/ingest/README §The tracked SERP panel](../workers/ingest/README.md#the-tracked-serp-panel-serp-panel-s1b).
The rules that differ from "one family, one call":

- **Every tracked term is read on both devices.** Most food/health search is
  on a phone, and phone result pages show blocks that take clicks on different
  queries. One call per (query, device), still one family, one archive and
  one manifest row per property per run. The device is stored in the archived
  request body — a documented provider field — and appears in
  `dataforseo-serp-panel.csv` as a `device` column. The executive snapshot's
  AI Overview evidence stays desktop.
- **Depth is 20**, not the whole result page: a property below it records **no
  rank**, which the CSV and the Tower both show as "not inside the tracked
  depth" rather than "not ranking".
- **A missing AI Overview and an unreadable one are different facts.** Where
  the asynchronous overview does not load, `aio_present` is **unknown** (empty),
  never `false`; only a cleanly parsed page with no overview records `false`. The
  decision rules treat unknown exactly like an untracked query.
- **`secondPos`, `features[]` and `sitelinksUs` are flattened** as
  `second_rank`/`second_url`, `serp_features` and `sitelinks_us` — no new
  provider spend, because the response was already paid for. `sitelinks_us` is
  three-state like the `aio_*` pair: empty means the property had no result
  inside the tracked depth, so there was no result of ours that could show
  sitelinks — read as `false`, it would raise the sitelink-loss alert every
  week a ranking dropped below depth 20. What deliberately stays in the archive
  rather than becoming a column: overview text and full citation lists, result
  titles and snippets, the question text inside
  `people_also_ask`/`related_searches`, and paid blocks —
  [scripts/README §dataforseo-serp-panel.csv](../scripts/README.md) gives the
  reason for each.
- **The alert rules below are not wired**: the panel is an input to the query
  **decisions** and the `search-striking-distance` gate, not to the Needs
  Attention section. Promoting `bestPos` drift and lost citations to lifecycle
  flags requires repeated snapshots, the same requirement the broad S1
  comparison has.

**Effect on query decisions.** The query decisions
([doc 10](10-control-tower.md)) apply two rules:

- a decision that would have recommended **title or snippet changes** on a
  query with an AI Overview that does not cite us is demoted from *act* to
  *investigate*, because the change would add churn without gaining clicks.
  This is the impression-harvest gate (snippet work gains clicks only where
  users still click the result), applied automatically;
- a query the overview **does** cite is classified as *protect* regardless of
  its position trend, with a next step that recommends keeping the cited
  content intact.

**Every collection is reviewed by a person.** When a panel collection
arrives, the runner job in `scripts/os-up.mjs` files a `panel-review` task into
the property's own task project — due seven days later, one per property per
panel day, based on the `GET /api/serp-panel-landings` read. The panel data
is of no use until someone triages it. The panel day sets the date and the
review covers the week's whole collection — the broad inventory, the link and
LLM families and the property's own GSC/GA4/Bing exports arrive on the same
schedule. What closing that task requires — reviewing the panel, then the
inventory of the week's other families — is written into the task by
`scripts/runner/panel-review.mjs`; the triage state is stored in the task
snapshot as `panelReview` so the Tower can show a property whose review is
overdue.

**Cost:** each tracked query is one metered call **per device** (~$0.004 each);
a panel of 25 terms is roughly $0.20 a Monday, under $1/month against the $25
cap. It reserves the same per-report amount as every other family before
calling and fails closed under the same portfolio cap — there is no
panel-specific exception in the gate, which is why the second device halves the
query ceiling rather than widening the reserve.

A hand-picked panel of 10–31 head terms and strategic bets provides the
mobile/desktop monitoring of neighbouring results and exact citations:

```jsonc
{ "asset": "example.com", "date": "2026-07-06", "query": "example calculator",
  "device": "mobile", "bestPos": 3, "bestUrl": "/", "secondPos": 4,
  "top3": ["example.org", "example.gov", "example.com"],
  "aio": { "present": true, "citesUs": false, "cites": ["example.org", "..."] },
  "features": ["people_also_ask"], "sitelinksUs": false }
```

A site's panel seed is its row in `config/serp-panel.json`: its brand and
navigational terms, the head terms it gets impressions for, and the bets its
current plan is testing — for example `example` · `example login` ·
`example calculator` · `best free calculators`. Its queries are that site's
own; an installation keeps the history of each seed in its own notes.

*Add a query when Search Console shows four-figure impressions at position 1–5
with zero clicks and several URLs sharing byte-identical impression counts on
every date — the pattern produced by one SERP block crediting the property,
not by pages competing. Search Console data cannot show whether that block is
an AI Overview; the panel records exactly that.* A provider error on a query
leaves **every column unknown**, not `false`: the call is billed, returns no
data, and is recorded as such; the next scheduled run retries it.

### S1c — Discovery (net-new demand and the competitive set)

Every other search family in this doc covers only **existing** terms: S1
reads what a property already ranks for, S1b reads terms an operator already
chose, S2 reads queries that already received an impression. None of them can
propose a term the portfolio has never targeted, so Decide could rank existing
opportunities but never find a new one; that is the difference between
optimizing a page and choosing what to build.
[Doc 13](13-opportunity-scouting.md)'s opportunity scouting has no input
without these families.

Two families, both on a **28-day cadence** rather than weekly:

- **`keyword-ideas`** (`dataforseo_labs/google/keyword_ideas/live`) — net-new
  demand, top 100 by search volume. **Seeds come from the property's own
  `config/serp-panel.json` head terms**, not from a new config file and not from
  the stored `ranked-keywords` archive: the panel is the operator's own statement
  of which terms matter, it is already loaded by the collector, and reading the
  archive instead would put an R2 fetch and a gzip parse inside a paid
  collection. A property with no panel has no declared head terms and therefore
  gets no ideas, rather than ideas generated from a guess.
- **`serp-competitors`** (`dataforseo_labs/google/competitors_domain/live`) —
  top 20 ordered by `intersections`, i.e. how many of *our* keywords a domain
  also ranks for. A bigger domain that shares none of our keywords is not a
  competitor. Without it, competitors are found only incidentally from the
  `top3` of whichever panel queries happen to be tracked, so the competitor
  list would depend on the panel rather than on the market.

**Why the monthly cadence matters.** Net-new demand and the competitive set
do not change week to week; collecting them weekly would pay for four copies of
the same result. ~$0.02 a call means ~$0.20/month across a small portfolio
versus ~$0.87 at weekly — small on its own, but keeping each family's cost low
is what keeps total spend within a $25 cap.

**Two cadences, two separate checks.** The read models check whether a
`report_date` is complete against `DATAFORSEO_BASE_REPORTS`. A 28-day family is
expected to be absent from three `report_date`s in four, so listing it there
would mark three weeks in four incomplete. "Was this week complete?" and
"which families may be requested for this property?" are separate questions:
`dataForSeoReportsFor` handles the first, and the collector's
`dataForSeoFamiliesFor` (reading the REPORTS registry and its `appliesTo`)
handles the second.

**Deliberately not built.** `domain_intersection` (the content gap — they rank,
we don't) is the most directly actionable list of the three and is planned as
later work rather than part of this: it needs a chosen competitor per property,
which `serp-competitors` has to establish first, and guessing that competitor
would pay for the wrong gap. Local-pack and Google Business Profile families
are not collected — no portfolio asset is a local business. Historical SERP
families are not collected because the archive builds its own history every
Monday and paying for backfill would duplicate it.

### S2 — GSC daily pull (free, richest)
Search Analytics API nightly per asset: clicks/impressions/position by query and
by page. The analysis archive also retains page×country, page×device,
page-level search appearances, image-search page×query, and Discover pages.
Discover is collected in **probe mode**: while every completed run for a
property has returned nothing, only the newest revision date is requested, so a
family the property does not participate in costs one request a day instead of
four. The full revision window resumes as soon as a run returns a row.
Store the raw data; derive the views that decisions are based on:
- **Position-bucket distribution over time** — counts + impressions in pos 1–3 /
  4–10 / 11–20 / 21+. A property with a few dozen queries in the top 3 and
  hundreds at 4–10 has most of its queries just below the top 3; for such a
  property, this chart tracks the strategy directly.
- **Striking-distance list, auto-refreshed** — pos 4–12 × impressions ≥100,
  the standing to-do list for content work.
- **Brand vs generic split** (per-asset regex over the brand's spellings)
  — branded-impressions trend is the leading indicator for sitelinks, AI
  visibility, and algorithm-update resilience.
- **CTR-vs-position curve** vs benchmarks (no-AIO ~3.3% / AIO-cited ~2.1% /
  AIO-uncited ~0.9%) — flags title/snippet problems: a page can stay under 1%
  CTR on five-figure impressions for a quarter before anyone notices.
- GSC's **[Search Generative AI
  report](https://support.google.com/webmasters/answer/16984139)**
  (AIO/AI-Mode impressions, impressions-only) — ingest when the API exposes
  it. The documented
  [Search Analytics API](https://developers.google.com/webmaster-tools/v1/searchanalytics/query)
  has no generative-report type, so ordinary Web Search data must not be
  relabeled as AIO-specific.

### S3 — AI/GEO visibility
- **GA4 "AI Assistant" channel**: sessions/wk from chatgpt.com, perplexity.ai,
  claude.ai, etc. The daily `landing-page-acquisition` archive keeps the
  landing URL beside source, channel, engagement, key events, and revenue.
  Treat it as a *lower bound* — not every assistant supplies a usable referrer.
- **DataForSEO LLM-mentions** weekly target metrics for Google and ChatGPT:
  reported mentions, represented AI search volume, and leading source domains.
  The endpoint accepts one task, so properties/platforms are separate calls
  rather than one combined portfolio batch. These are provider-dataset coverage
  metrics, not unique people or attributable sessions.
- S1b's `aio.citesUs` is exact, per-query, live-SERP citation state for the
  terms on a property's panel. It covers the panel and nothing else — a query
  nobody tracks is unknown, not uncited.

### S4 — Authority & links
- **DataForSEO backlinks** weekly: current domain rank/backlinks/referring
  domains plus the provider's weekly-grouped 90-day new/lost series. The
  executive cards show net referring-domain direction.

  Two bounded detail families, `backlinks-referring-domains` and
  `backlinks-anchors`, run on the same weekly cadence and the same immutable
  R2 + append-only manifest boundary. A summary count and a weekly delta
  cannot identify which domain was lost; these families exist so "we lost 12
  referring domains this week" can become a list of reclamation targets.

  Both are capped at the top 100 rows, ordered so that a truncated read still
  contains the rows that matter: referring domains by `rank` descending
  (the links worth having, not whichever scraper farm links most times), anchors
  by `referring_domains` descending (an anchor profile is read as a
  **distribution**, and the top rows show most of it). The cap is chosen for
  cost first and coverage second — the Backlinks API bills $0.024/request +
  $0.000036/row, so 100 rows is ~$0.0276 a call against the $0.25 per-family
  reserve.

  The anchor read is also an AI-visibility input, not only a risk one: this
  doc's second premise is that brand mentions predict AI visibility ~3x better
  than backlinks, and brand-vs-exact-match anchor share is the closest measure
  of that in the link families.
- **Reclamation pipeline** as a first-class table (target page, dead URL it
  replaces, contact, status, won-link URL) — wins are events on the timeline.
  This tactic applies wherever a dead .gov/.edu resource has a successor.
- Ahrefs free DR checkpoint quarterly.

### S5 — Tech/GEO hygiene (regression guards)

The nightly half that only fetches pages — static-HTML depth, robots AI
access, sitemap and page structure — runs at 04:00 UTC in
`workers/ingest/src/hygiene.ts`, storing one row per (asset, check, day) in
`hygiene_checks`. Six plain HTTPS requests per property, no provider and no
quota. Full behavior, reporting rules, and the parser's documented limits:
[workers/ingest/README §Hygiene guards](../workers/ingest/README.md#hygiene-guards-s5--the-served-layer).

- **Page-level directives**: `<meta name="robots">` and `X-Robots-Tag` are
  read on **three sampled real pages** per property per night, under rule
  `hygiene-page-directives`. The sample is drawn from the sitemap the sweep
  already fetched — a separate list of key routes would be a second list to
  keep up to date, and the property already publishes one. The sample is
  stable (hash-ordered), so the same pages are checked night after night; it
  is three pages, and the recorded reading states that rather than presenting
  the property as clean.
- **An unreachable home page** is its own rule, `hygiene-home-unreachable`,
  on the same fetch as the depth check.
- **That fetch is also each site's uptime check**: the home-page check alone
  runs every hour as well (`runUptimeChecks`), and `hygiene-home-unreachable`
  files at `error` — `error` is reserved for failures that stop revenue, and
  a site that does not respond is one.
  Robots, sitemap and the page sample stay nightly.
- **A failure is confirmed before it raises an alert**: a home page that fails
  is requested once more 45 seconds later in the same run, in both the hourly
  check and the nightly sweep. Only two failures in a row file
  `hygiene-home-unreachable`; a page that responds to the retry is recorded as
  up, with the failed attempt noted on its reading.
- **Page structure** is a fourth check, `page-structure`, making four more
  checks on the pages the directive rule already fetched: is there a
  `<title>`, a meta description, exactly one `<h1>`, and does the canonical
  point at this page or **point away from it** to another. It costs **no
  new requests** — a served page is one document, and fetching it twice would
  double the nightly request count with no new information. Only changes raise
  a flag, so a page that has always shipped without a description is treated
  as a standing editorial decision rather than a new incident.

  The taxonomy follows **badseo.dev** — a site where every page breaks exactly
  one rule — and so does its test approach: `STRUCTURAL_FIXTURES` has one
  page per fault and a coverage test that fails if the parser detects a fault
  that no fixture page demonstrates. The other twenty-odd checks of a full
  audit are not included: this list records only guards with a decision
  attached — the snippet standard (a title and description written for the
  query, not the page) for the snippet pair, and "a page canonicalized
  elsewhere cannot rank" for the most serious of the four. **Title and
  description length are deliberately excluded**: Google truncates by pixel
  width and rewrites titles at will, so "your title is 61 characters" is a
  matter of taste with no decision behind it, and an operator who receives
  flags about matters of taste starts ignoring the check.

  A structural fault is not automatically an *act*. A missing title on a page
  with impressions is worth a morning's work; the same fault on a page nobody
  reaches is worth nothing. That triage needs traffic evidence, which is in the
  Tower's page decisions and not in this check.
- The depth, robots and sitemap guards file at **warn**, not the `error` the
  alert-rules line below specifies. `error` is reserved for failures that stop
  revenue, and a hand-written word count that has never fired in production
  has not yet shown it is reliable enough for that level. **Promote to `error`
  after the first true positive** — that is the trigger, and it is a one-line
  change.
- `robots.txt` is parsed at **site level only** — a blanket `Disallow: /`
  per user-agent group. A path-scoped `Disallow` is still treated as allowed, and
  longest-match evaluation is only worth building once a property actually ships
  path-scoped AI rules.
- CrUX is not built.

- **Static-HTML depth check**: words-of-visible-content in the served HTML.
  AI crawlers don't render JS; a home page can serve under a hundred words for
  months with nobody noticing. Nightly fetch + count, alert on -50% vs
  baseline.
- **robots/AI-crawler diff**: alert if robots.txt or meta-robots changes drop an
  AI search bot (OAI-SearchBot, ClaudeBot, PerplexityBot) or add nosnippet.
  Cloudflare default-blocks mixed-use crawlers on ad-serving pages for
  new/free customers — re-verify each asset when ads ship.
- **Sitemap reachability + URL count**: resolve the sitemap from `robots.txt`
  (else `/sitemap.xml`), prove it parses, count `<loc>` entries following one
  level of `<sitemapindex>`; alert on unreachable, unparseable, or a -50%
  count collapse off a base of ≥50 URLs.
- **CrUX API** monthly: INP/LCP/CLS pass-fail per asset (tiebreaker-level
  priority, but free to monitor).
- Scope note: an asset may already prove link-graph/sitemap/canonical
  integrity in its own CI at build time. S5 checks the *served* layer (what a
  crawler actually receives); don't duplicate build-time proofs — require them
  in the asset's CI bar (`AGENTS.md`) instead.

### S6 — Monetization *platform-state* signals ([doc 09](09-onboarding-a-site.md))

*Scope note: S6 is the platform-health guard family (ads.txt reachability,
consent regressions, application states) — distinct from the ledger's revenue
collection in [doc 02](02-signal-contract.md), which books actual dollars.*
The portfolio monetizes via ads + affiliate; platform state is collected as a
signal family, not kept in a spreadsheet that someone has to remember to check:
- **ads.txt reachability + content hash** per ad-serving asset; a 404 or an
  unexpected diff → **error** (a failure that stops revenue).
- **Consent-surface regression**: the consent-mode block (which reads the
  stored choice + GPC and sets consent signals) must precede analytics/ad
  loaders in served HTML, and a stored reject/GPC must skip the loaders;
  privacy-policy + "Do Not Sell" routes must return 200. The DEFAULT is a
  per-asset setting, not the invariant — a site may run the US opt-out model
  (default granted, denied on reject/GPC), and default-deny halves GA4
  reporting without any visible error. A regression here is a compliance incident → **error**.
- **Ad-platform state log**: AdSense/Ad-Manager application + policy-center
  states are manual-entry events on the asset timeline (e.g. a re-review
  window, ~2–4 weeks post-remediation) — the Tower shows "days since state
  change," and the advisory layer does not propose risky content during a
  review.
- **Affiliate-click trend** is part of the asset's report ([doc 02](02-signal-contract.md)); the Tower charts it
  next to RPM once ads are live.
- **Storage-lifecycle check** where user content is hosted (an asset's
  user-upload bucket): object count should level off under the 30-day expiry;
  unbounded growth means the lifecycle rule was removed without anyone
  noticing → **warn**.

## Alert rules (tunable per asset; flag shape = severity × kind per [doc 02](02-signal-contract.md))

- S1b: `bestPos` worsens ≥3 vs 4-week median → **warn/anomaly** · AIO citation
  lost → **warn/anomaly** · new domain takes #1 on a panel query →
  **info/anomaly** · sitelinks appear/disappear on brand query → **info/anomaly**.
  *None of these are wired.* The collector and the flattened family exist;
  the panel is an input to query **decisions**, and every rule here compares
  against retained history. As with the S1 line below, these rules need
  repeated snapshots first. The columns all four rules read exist
  (`second_rank`, `serp_features`, `sitelinks_us`); what is missing is
  history, not fields — and the sitelink rule depends on `sitelinks_us`'s
  empty state: it must compare only weeks that have an observation and skip
  the weeks the property had no result inside the tracked depth.
- The broad S1 weekly comparison emits executive warnings/discoveries, not
  lifecycle flags; repeated provider snapshots and real GSC impact are
  required before promoting those rules into Needs Attention.
- S2: top-10 page's clicks last7d < 60% of trailing-28d avg → **warn/anomaly**
  (min-count gated per doc 02) · branded impressions −30% WoW → **warn/anomaly** ·
  new query enters striking distance with >500 impressions →
  **info/opportunity**.
- S4: DR-60+ referring domain lost → **info/anomaly** · reclamation win →
  **info/milestone** (wins are recorded for morale; their severity stays info).
- S5: static-depth −50% on a key route → **error/anomaly** (deploy regression).
  *Files at `warn`/anomaly today, with `hygiene-robots-ai` and
  `hygiene-sitemap` alongside it at the same severity — see S5 for why, and
  for the condition that promotes it.*

### Executive card rules — inventory

Distinct from the lifecycle flags above: these are deterministic rules over the
archived report families that emit **cards**, not flags, and never write to the
Needs Attention list. The full table with the exact family each rule reads is
in [`scripts/README.md`](../scripts/README.md); the page sorts
`warning → recommendation → discovery → insight` and shows eight. Each card
includes its rule id as evidence (`rule: <id>`). Cards after the eighth are
listed in `suppressedItems` rather than dropped. The cap limits only what is
displayed in full: a finding past the cap is not shown as a card, but it is
always listed. The Tower lists them too: below the findings, a small grey
"N more below the top 8" expander shows their titles. Each entry has only the
kind dot and title, not a rendered finding: no evidence and no
mark/dismiss controls, because the page cannot offer an action for a card it
is not showing. The cap stays at **8** until evidence shows eight is the wrong
number of cards to read in one sitting.

Rules generalized from manual-analysis history
([doc 13](13-opportunity-scouting.md) category 6), with the threshold and the
finding each encodes:

- **`measurement-integrity`** (warning) — ≥10% Unassigned/`(not set)` sessions,
  or an event that ran ≥100/day dropping ≥90% WoW. A property with over 10%
  Unassigned sessions must qualify every number in its largest analysis. This
  card **qualifies** every other card on the page rather than adding a
  finding, and sorts first for that reason. The OS reports the fault only — the measurement channel is
  operator-only by invariant (doc 01).
- **`concentration-risk`** (warning) — organic search ≥85% of ≥100 sessions,
  the single-channel threshold [doc 00](00-objective-and-roi.md) lists as the
  #1 devaluation factor.
- **`query-cannibalization`** (recommendation) — ≥2 of the property's own pages
  each holding ≥20% of one query's impressions, above the striking-distance
  volume minimum (25/reported date, never below 100). A homepage can outrank its
  own interior pages for months before anyone notices.
- **`query-language-drift`** (recommendation) — a country holding ≥5% of
  impressions (≥1,000) clicking at ≤half the CTR the property gets
  **excluding that country**. The problem it detects is meta copy written in
  the site's language, not the searcher's; a one-character fix can be worth
  four figures of impressions a month. Both thresholds follow from that
  pattern: a country large enough to matter also pulls the property-wide CTR
  toward its own CTR, so comparing against the overall number would hide a
  locale gap, because the country is part of the number it is compared with.
- **`device-ctr-gap`** (recommendation) — one device's CTR ≤ half the other's,
  both ≥1,000 impressions, in either direction. Not position-adjusted; a
  device-only ranking gap produces the same pattern, so the card recommends
  comparing positions first. No archived family contains **query × device**,
  so the grounding exclusion (below) cannot be subtracted where it was
  observed; it is attributed entirely to the weaker device as a worst case,
  which can only make the rule fire less often.
- **`prune-candidates`** (discovery) — pages under 5 impressions across a window
  of ≥14 reported dates, on properties with ≥100 reported pages. A full prune
  rule is "<5 impressions in 90d **AND** no internal links"; only the
  impressions half exists in this archive and the card shows that rather than
  implying the link half was checked. A page missing from the export entirely is
  unknown, not zero, and is never counted.
- **`page-movers`** (insight) — page-grain clicks, ≥10 absolute change across
  two complete seven-date windows, mirroring the existing query movers. Cards
  only; it deliberately adds no payload block, so the Tower needs no change.
- **`llm-grounding-traffic`** (discovery) — **quoted-literal queries are
  machine grounding**: queries like `"1 medium banana" "3/4 cup" food group`
  with zero clicks between them are automated retrieval checks, not people,
  and can be close to a tenth of all captured page/query impressions. They are
  excluded from the CTR and position rules and from the **query movers** the
  query decisions read, Google and Bing alike — and **the exclusion is always
  shown**: each affected card, and each movers list, shows the excluded
  impressions and share, including when they are zero. The card is a GEO
  signal from the free GSC data with page-level detail the paid mention
  collection does not have, and it supports S3 with independent data. The
  classifier covers the quoted pattern only — unquoted queries that
  look like homework questions stay in the series, so the number is a lower bound for the behavior
  rather than a full measure of it.
- **`search-striking-distance`** withholds a term where the panel observed an
  AI Overview that does not cite this property. Several of the property's URLs
  at position 1.0–1.3 with byte-identical impression counts and no clicks is
  *one block* — an AI Overview or a sitelink group — crediting them at the
  block's own position, and the consolidation a cannibalization card would
  recommend there would cause harm. The harvest rule favours low
  click-through, so without the gate it would recommend exactly those SERPs
  first; the card lists the terms it withheld. Only an observed non-citation
  withholds a term; an untracked term, or one whose overview did not load, is
  still listed and marked unknown on the card.
- **`bing-search-opportunity`** reads the query's own periods, labels a
  decline as a decline rather than as an opportunity, labels it **intent
  mismatch** when a long window at a visible position gets no clicks, caps
  confidence at medium for either, and never joins across a locale subtree.
- **The backlink momentum card** shows the provider's observed inventory so a
  reader can judge coverage before direction: a direction measured over a
  dozen referring domains on a DR-30 domain is a real change measured on too
  small a sample. **A second link data source is not wired** (S4 has one
  source); that is the current state.
- **`distant-demand-cluster`** exists because the near-win range (position
  4–20) suits near-wins but is too narrow as the only range checked for a
  property: it misses five-figure monthly searches at positions 37–49 that map
  to a page the site already has. [Doc 13](13-opportunity-scouting.md)'s
  opportunity scouting exists so that a scope filter does not hide
  opportunities like this.
- **`value-event-not-key-event`** — a value event carrying `keyEvents = 0`
  while a lesser event is marked key sets every conversion-based read the OS
  makes to zero without any error, including the `ai-referral-floor` card's own
  "Key events" evidence row. Value events are declared per property in
  [`config/value-events.json`](../config/value-events.json) (+ README
  sibling). Both sides of the comparison are operator-only — the measurement
  channel is `forbidden`-class — so the rule reports the mismatch and edits
  neither.

Several rules fire only after enough history has accumulated — the
week-over-week and prune rules need 14 reported dates — or once a property
actually crosses a threshold.

## The "did it help?" join

Annotate each asset's deploy dates (git tags / CI webhook) onto every S1/S2 time
series. The advisory layer's core question — *did the last change move the
signal?* — can be answered only if changes and signals share a timeline. A
batch of search-facing changes shipped on one day is a natural experiment: the
panel + GSC series should show whether it moved within 2–6 weeks.

## Cost envelope

A five-family weekly run costs roughly $0.26–$0.29 per property; weekly cadence
projects to a few dollars a month for a small portfolio, below the $25/month
data cap. Exact cost is indexed per report; the scheduler reserves $0.25 before
each call and fails closed rather than crossing the cap. S2/S5/GA4 remain free.

The S1b panel adds ~$0.004 per (tracked query, **device**) and nothing at all
for the properties without one. A panel at a 40-query ceiling would cost $0.32
at two devices — more than the $0.25 the gate reserves for one family, i.e. a
family spending more than the reserve its own gate took, without any error. So
the ceiling is *derived*: 31 terms, which is exactly what $0.25 pays for at two
devices. Adding a dimension halves it again; raising it requires a decision to
change the reserve, not only a new number.

## Not built

- S5: CrUX; no screen shows the accumulating hygiene series yet.
- S1b: the alert rules above (they need history, not new fields); the Tower's
  device-aware panel board and the executive snapshot's panel block.
- S4: bounded backlink-detail reclamation candidates and a second link
  data source; the operator-exported Bing AI Performance collection, when its real
  schema is available.
