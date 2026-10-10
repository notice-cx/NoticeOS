# 08 — SEO / SERP / GEO signal reference

*The search-signal families (S1–S6) as centrally-pulled **signals** under the
[signal contract](02-signal-contract.md). This is the domain reference; the
contract owns shapes/flags/latency rules, [doc 03](03-attribution.md) owns how
any of it becomes a causal claim, and the ledger ([doc 00](00-objective-and-roi.md))
is where value is booked — positions and citations are inputs, never outcomes.*

The product pulse ([doc 02](02-signal-contract.md)) covers the *on-site* half of
each asset's health. This doc specs the *demand-side* half: organic search and AI
answer engines, asset-agnostic from day one, same as the signal contract.

**Two realities shape the design:**
1. **Citation is the new position zero.** With an AI Overview present, organic #1
   loses ~58% of clicks; *cited* pages get ~2.3× the CTR of uncited ones. So we
   track "are we cited?" as a first-class dimension next to rank.
2. **Brand mentions out-predict backlinks ~3× for AI visibility** (Ahrefs, 75k
   brands). So brand-demand and mention signals are KPIs, not vanity metrics.

## Signals live in NoticeOS, not in asset workers

Unlike the product pulse (each asset self-reports), SEO signals are pulled
**centrally** by NoticeOS crons: the external APIs (GSC, GA4, DataForSEO) need
portfolio-level credentials and a shared spend budget, and none of it requires
code inside the asset. Assets stay dumb; the Tower joins product pulse × search
signals on the asset id. One table family in the store, one row per (asset, date, signal).

## Signal families

### S1 — Domain-wide ranking intelligence

The weekly central DataForSEO lane discovers each launched domain from Postgres and
archives its top 200 current Google rankings in the site's saved market
(United States · English by default). Each row keeps the
query, ranking URL/type/position, estimated demand, CPC, difficulty, intent,
SERP features, estimated visits/cost, rank-change fields, and any AIO-reference
result. This broad inventory feeds:

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
renames search volume as impressions. Rank movement is local evidence only when
the same query/page pair exists in two retained snapshots.

### S1b — Tracked-query SERP panel

The weekly Monday DataForSEO lane's `serp-panel` family makes one
`serp/google/organic/live/advanced` call per (tracked term, device) with
`load_async_ai_overview` set, archived to the same immutable R2 + append-only
manifest boundary as the other families (one manifest row per property per
run, the per-query responses as its pages). The panel itself is
[`config/serp-panel.json`](../config/serp-panel.json) (+ README sibling); the
flattened family is `dataforseo-serp-panel.csv`. Full collector behavior:
[workers/ingest/README §The tracked SERP panel](../workers/ingest/README.md#the-tracked-serp-panel-serp-panel-s1b).
The rules that depart from "one family, one call":

- **Every tracked term is read on both devices.** Most food/health search is
  on a phone, and phone result pages carry click-consuming blocks on different
  queries. One call per (query, device), still one family, one archive and
  one manifest row per property per run. The device rides in the archived
  request body — a documented provider field — and reaches
  `dataforseo-serp-panel.csv` as a `device` column. The executive snapshot's
  AI Overview evidence stays desktop.
- **Depth is 20**, not the whole result page: a property below it records **no
  rank**, which the CSV and the Tower both state as "not inside the tracked
  depth" rather than "not ranking".
- **A missing AI Overview and an unreadable one are different facts.** Where
  the asynchronous overview does not load, `aio_present` is **unknown** (empty),
  never `false`; only a cleanly parsed page with no overview says `false`. The
  decision rules treat unknown exactly like an untracked query.
- **`secondPos`, `features[]` and `sitelinksUs` are flattened** as
  `second_rank`/`second_url`, `serp_features` and `sitelinks_us` — no new
  provider spend, the bytes were already bought. `sitelinks_us` is three-state
  like the `aio_*` pair: empty means the property held no result inside the
  tracked depth, so there was nothing of ours for sitelinks to hang off — read
  as `false` it would fire the sitelink-loss alert every week a ranking slipped
  past depth 20. What deliberately stays in the archive rather than becoming a
  column: overview text and full citation lists, result titles and snippets,
  the question text inside `people_also_ask`/`related_searches`, and paid
  blocks — [scripts/README §dataforseo-serp-panel.csv](../scripts/README.md)
  says why for each.
- **The alert rules below are not wired**: the panel feeds the query
  **decision lanes** and the `search-striking-distance` gate, not the Needs
  Attention band. Promoting `bestPos` drift and lost citations to lifecycle
  flags waits on repeated snapshots, the same bar the broad S1 comparison is
  held to.

**What it changes downstream.** The query-decision lanes
([doc 10](10-control-tower.md)) apply two rules:

- a decision that would have recommended **title or snippet surgery** on a query
  carrying an AI Overview that does not cite us is demoted from *act* to
  *investigate* — churn without reach: the impression-harvest gate (snippet
  work earns clicks only where the result is still the click), applied
  automatically;
- a query the overview **does** cite classifies as *protect* regardless of its
  position trend, with a next step that says not to wash out the cited content.

**Every collection is read.** A landing files a `panel-review` task into the
property's own tracker — due seven days later, one per property per panel
day, by the runner lane in `scripts/os-up.mjs` off the
`GET /api/serp-panel-landings` read. The panel measures nothing until somebody
triages it. The panel day is the anchor and the scope is the week's whole
collection — the broad inventory, the link and LLM families and the property's
own GSC/GA4/Bing exports land on the same schedule. What closing that task
requires — the panel walk, then the inventory pass over the week's other
families — is written into the task by `scripts/runner/panel-review.mjs`; the
triage state rides the task snapshot as `panelReview` so the Tower can show a
property that is overdue.

**Cost:** each tracked query is one metered call **per device** (~$0.004 each);
a panel of 25 terms is roughly $0.20 a Monday, under $1/month against the $25
cap. It reserves the same per-report amount as every other family before
calling and fails closed under the same portfolio cap — there is no
panel-shaped exception in the gate, which is why the second device halves the
query ceiling rather than widening the reserve.

A hand-picked panel of 10–31 head terms and strategic bets is what does
mobile/desktop SERP-neighborhood and exact citation monitoring:

```jsonc
{ "asset": "example.com", "date": "2026-07-06", "query": "example calculator",
  "device": "mobile", "bestPos": 3, "bestUrl": "/", "secondPos": 4,
  "top3": ["example.org", "example.gov", "example.com"],
  "aio": { "present": true, "citesUs": false, "cites": ["example.org", "..."] },
  "features": ["people_also_ask"], "sitelinksUs": false }
```

A site's panel seed is its row in `config/serp-panel.json`: its brand and
navigational terms, the head terms it earns impressions for, and the bets its
current plan is testing — for example `example` · `example login` ·
`example calculator` · `best free calculators`. Its queries are that site's
own; an installation keeps the history of each seed in its own notes.

*Add a query when Search Console shows four-figure impressions at position 1–5
with zero clicks and several URLs sharing byte-identical impression counts on
every date — the signature of one SERP block crediting the property, not of
pages competing. Whether that block is an AI Overview is unknowable from
Search Console and is exactly what the panel observes.* A provider error on a
query leaves **every column unknown**, not `false`: billed, unanswered, and
recorded as such; the next scheduled run retries it.

### S1c — Discovery (net-new demand and the competitive set)

Every other search family in this doc is **reflexive**: S1 reads what a
property already ranks for, S1b reads terms an operator already chose, S2
reads queries that already earned an impression. None of them can propose a
term the portfolio has never touched — so Decide could rank existing
opportunities and never generate one, which is the difference between
optimizing a page and choosing what to build.
[Doc 13](13-opportunity-scouting.md) is the outer loop that starves without this.

Two families, both on a **28-day cadence** rather than weekly:

- **`keyword-ideas`** (`dataforseo_labs/google/keyword_ideas/live`) — net-new
  demand, head 100 by search volume. **Seeds come from the property's own
  `config/serp-panel.json` head terms**, not from a new config file and not from
  the stored `ranked-keywords` archive: the panel is the operator's own statement
  of which terms matter, it is already loaded by the collector, and reading the
  archive instead would put an R2 fetch and a gzip parse inside a paid lane. A
  property with no panel has no declared head terms and therefore gets no ideas,
  rather than ideas grown from a guess.
- **`serp-competitors`** (`dataforseo_labs/google/competitors_domain/live`) —
  head 20 ordered by `intersections`, i.e. how many of *our* keywords a domain
  also ranks for. A bigger domain that intersects us on nothing is not a
  competitor. Without it the competitive set is discovered only incidentally
  from the `top3` of whichever panel queries happen to be tracked, which makes
  it a property of the panel rather than of the market.

**Why monthly is the load-bearing decision.** Net-new demand and the competitive
set do not move week to week; collecting them weekly would buy four copies of one
answer. ~$0.02 a call means ~$0.20/month across a small portfolio versus ~$0.87
at weekly — small in isolation, and the discipline is the point against a
$25 cap.

**Two cadences, two questions.** `DATAFORSEO_BASE_REPORTS` is what the read
models grade a `report_date` complete against. A 28-day family is legitimately
absent from three `report_date`s in four, so listing it there would call three
weeks in four torn. "Was this week whole" and "what may this property be asked
for" are two answers: `dataForSeoReportsFor` answers the first, the collector's
`dataForSeoFamiliesFor` (reading the REPORTS registry and its `appliesTo`)
answers the second.

**Deliberately not built.** `domain_intersection` (the content gap — they rank,
we don't) is the sharpest *act* list of the three and is a follow-on rather than
part of this: it needs a chosen competitor per property, which `serp-competitors`
has to establish first, and guessing that target would buy the wrong gap.
Local-pack and Google Business Profile families are rejected outright — no
portfolio asset is a local business. Historical SERP families are rejected
because the archive accumulates its own history every Monday and paying for
backfill duplicates it.

### S2 — GSC daily pull (free, richest)
Search Analytics API nightly per asset: clicks/impressions/position by query and
by page. The analysis archive also retains page×country, page×device,
page-level search appearances, image-search page×query, and Discover pages.
Discover is collected in **probe mode**: while every completed run for a
property has returned nothing, only the newest revision date is requested, so a
family the property does not participate in costs one request a day instead of
four. The full revision window resumes the moment a run carries a row.
Store raw; derive the views that actually drive decisions:
- **Position-bucket distribution over time** — counts + impressions in pos 1–3 /
  4–10 / 11–20 / 21+. A property with a few dozen queries in the top 3 and
  hundreds at 4–10 has the "one push from the top" shape; this chart IS the
  strategy.
- **Striking-distance list, auto-refreshed** — pos 4–12 × impressions ≥100,
  the standing to-do list for content work.
- **Brand vs generic split** (per-asset regex over the brand's spellings)
  — branded-impressions trend is the leading indicator for sitelinks, AI
  visibility, and algorithm-update resilience.
- **CTR-vs-position curve** vs benchmarks (no-AIO ~3.3% / AIO-cited ~2.1% /
  AIO-uncited ~0.9%) — flags title/snippet problems: a page can sit under 1%
  CTR on five-figure impressions for a quarter before anyone looks.
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
  Treat it as a *floor* — not every assistant supplies a usable referrer.
- **DataForSEO LLM-mentions** weekly target metrics for Google and ChatGPT:
  reported mentions, represented AI search volume, and leading source domains.
  The endpoint accepts one task, so properties/platforms are separate calls
  rather than an invented portfolio batch. These are provider-dataset coverage
  metrics, not unique people or attributable sessions.
- S1b's `aio.citesUs` is exact, per-query, live-SERP citation state for the
  terms on a property's panel. It covers the panel and nothing else — a query
  nobody tracks is unknown, not uncited.

### S4 — Authority & links
- **DataForSEO backlinks** weekly: current domain rank/backlinks/referring
  domains plus the provider's weekly-grouped 90-day new/lost series. The
  executive layer presents net referring-domain direction.

  Two bounded detail families, `backlinks-referring-domains` and
  `backlinks-anchors`, run on the same weekly cadence and the same immutable
  R2 + append-only manifest boundary. A summary count and a weekly delta
  cannot name a lost domain; these families exist so "we lost 12 referring
  domains this week" can become a reclamation target.

  Both are capped at the head 100 rows, ordered so that a truncated read still
  answers the question asked of it: referring domains by `rank` descending
  (the links worth having, not whichever scraper farm links most times), anchors
  by `referring_domains` descending (an anchor profile is read as a
  **distribution**, and the head carries its shape). The cap is a cost
  decision before a coverage one — the Backlinks API bills $0.024/request +
  $0.000036/row, so 100 rows is ~$0.0276 a call against the $0.25 per-family
  reserve.

  The anchor read is also an AI-visibility input, not only a risk one: this
  doc's own second premise is that brand mentions out-predict backlinks ~3x for
  AI visibility, and brand-vs-exact-match anchor share is the closest thing the
  link families can say about it.
- **Reclamation pipeline** as a first-class table (target page, dead URL it
  replaces, contact, status, won-link URL) — wins are events on the timeline.
  The play exists wherever a dead .gov/.edu resource has a successor.
- Ahrefs free DR checkpoint quarterly.

### S5 — Tech/GEO hygiene (regression guards)

The nightly pure-fetch half — static-HTML depth, robots AI access, sitemap and
page structure — runs at 04:00 UTC in `workers/ingest/src/hygiene.ts`, storing
one row per (asset, check, day) in `hygiene_checks`. Six plain HTTPS requests
per property, no provider and no quota. Full behavior, honesty rules, and the
parser's documented limits:
[workers/ingest/README §Hygiene guards](../workers/ingest/README.md#hygiene-guards-s5--the-served-layer).

- **Page-level directives**: `<meta name="robots">` and `X-Robots-Tag` are
  read on **three sampled real pages** per property per night, under rule
  `hygiene-page-directives`. The roster is the sitemap the sweep already
  fetched — a list of key routes would be a second register to keep true, and
  the property already publishes one. The sample is stable (hash-ordered), so
  the same pages return night after night; it is three pages, and the reading
  says so rather than claiming the property is clean.
- **An unreachable home page** is its own rule, `hygiene-home-unreachable`,
  on the same fetch as the depth check.
- **That fetch is also each site's uptime**: the home-page check alone runs
  every hour as well (`runUptimeChecks`), and `hygiene-home-unreachable` files
  at `error` — a site that does not answer is the revenue-off-switch band.
  Robots, sitemap and the page sample stay nightly.
- **A failure is confirmed before it alerts**: a home page that fails is asked
  once more 45 seconds later in the same run, the hourly check and the nightly
  sweep alike. Only two failures in a row file `hygiene-home-unreachable`; a
  page that answers the retry reads up, with the failed try on its reading.
- **Page structure** is a fourth check, `page-structure`, asking four more
  questions of the pages the directive rule already fetched: is there a
  `<title>`, a meta description, exactly one `<h1>`, and does the canonical
  point at this page or **disclaim it** in favour of another. It costs **no
  new requests** — a served page is one document, and reading it twice would
  double the nightly request count to learn nothing. Only transitions fire, so
  a page that has always shipped without a description is a standing editorial
  decision rather than tonight's incident.

  The taxonomy follows **badseo.dev** — a site where every page breaks exactly
  one rule — and so does its test discipline: `STRUCTURAL_FIXTURES` has one
  page per fault and a coverage test that fails if the parser learns a fault
  no page proves. The other twenty-odd checks of a full audit are not carried
  across: this register records guards with a decision attached — the snippet
  standard (a title and description written for the query, not the page) for
  the snippet pair, and "a page canonicalized elsewhere cannot rank" for the
  loudest of the four. **Title and description length are deliberately
  excluded**: Google truncates by pixel width and rewrites titles at will, so
  "your title is 61 characters" is taste with no decision behind it, and a
  check that fires on taste is one the operator learns to ignore.

  A structural fault is not automatically an *act*. A missing title on a page
  with impressions is worth a morning; the same fault on a page nobody reaches
  is worth nothing. That triage needs traffic evidence, which lives in the
  Tower's page decisions and not in this lane.
- The depth, robots and sitemap guards file at **warn**, not the `error` the
  alert-rules line below specifies. `error` is the revenue-off-switch band, and
  a hand-rolled word count that has never fired in production has not earned
  it. **Promote to `error` after the first true positive** — that is the
  trigger, and it is a one-line change.
- `robots.txt` is parsed at **site level only** — a blanket `Disallow: /`
  per user-agent group. A path-scoped `Disallow` still reads as allowed, and
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
  priority, but free to watch).
- Scope note: an asset may already prove link-graph/sitemap/canonical
  integrity in its own CI at build time. S5 guards the *served* layer (what a
  crawler actually receives); don't duplicate build-time proofs — require them
  in the asset's CI bar (`AGENTS.md`) instead.

### S6 — Monetization *platform-state* signals ([doc 09](09-onboarding-a-site.md))

*Scope note: S6 is the platform-health guard family (ads.txt reachability,
consent regressions, application states) — distinct from the ledger's revenue
lane in [doc 02](02-signal-contract.md), which books actual dollars.*
The portfolio monetizes via ads + affiliate; platform state is a signal family,
not a spreadsheet someone remembers to check:
- **ads.txt reachability + content hash** per ad-serving asset; a 404 or an
  unexpected diff → **error** (revenue-off-switch class).
- **Consent-surface regression**: the consent-mode block (which reads the
  stored choice + GPC and sets consent signals) must precede analytics/ad
  loaders in served HTML, and a stored reject/GPC must skip the loaders;
  privacy-policy + "Do Not Sell" routes must return 200. The DEFAULT is a
  per-asset posture, not the invariant — a site may run the US opt-out model
  (default granted, denied on reject/GPC), and default-deny silently halves
  GA4 reporting. A regression here is a compliance incident → **error**.
- **Ad-platform state diary**: AdSense/Ad-Manager application + policy-center
  states are manual-entry events on the asset timeline (e.g. a re-review
  window, ~2–4 weeks post-remediation) — the Tower shows "days since state
  change," the advisory layer knows not to propose risky content mid-review.
- **Affiliate-click trend** rides the asset pulse ([doc 02](02-signal-contract.md)); the Tower charts it
  next to RPM once ads are live.
- **Storage-lifecycle sanity** where user content is hosted (an asset's
  user-upload bucket): object count should plateau under the 30-day expiry;
  unbounded growth = the lifecycle rule silently dropped → **warn**.

## Alert rules (tunable per asset; flag shape = severity × kind per [doc 02](02-signal-contract.md))

- S1b: `bestPos` worsens ≥3 vs 4-week median → **warn/anomaly** · AIO citation
  lost → **warn/anomaly** · new domain takes #1 on a panel query →
  **info/anomaly** · sitelinks appear/disappear on brand query → **info/anomaly**.
  *None of these are wired.* The collector and the flattened family exist;
  the panel feeds query **decisions**, and every rule here compares against
  retained history. Same bar as the S1 line below: repeated snapshots first.
  The columns all four read exist (`second_rank`, `serp_features`,
  `sitelinks_us`); what is left is history, not fields — and `sitelinks_us`'s
  empty state is load-bearing for the sitelink rule, which must compare
  observations to observations and skip the weeks the property held no result
  inside the tracked depth.
- The broad S1 weekly comparison emits executive warnings/discoveries, not
  lifecycle flags; repeated provider snapshots and real GSC impact are
  required before promoting those rules into Needs Attention.
- S2: top-10 page's clicks last7d < 60% of trailing-28d avg → **warn/anomaly**
  (min-count gated per doc 02) · branded impressions −30% WoW → **warn/anomaly** ·
  new query enters striking distance with >500 impressions →
  **info/opportunity**.
- S4: DR-60+ referring domain lost → **info/anomaly** · reclamation win →
  **info/milestone** (morale is a metric; severity stays honest).
- S5: static-depth −50% on a key route → **error/anomaly** (deploy regression).
  *Files at `warn`/anomaly today, with `hygiene-robots-ai` and
  `hygiene-sitemap` alongside it at the same severity — see S5 for why, and
  for the trigger that promotes it.*

### Executive card rules — inventory

Distinct from the lifecycle flags above: these are deterministic rules over the
archived report families that emit **cards**, not flags, and never write to the
Needs Attention lane. The full table with the exact family each rule reads lives
in [`scripts/README.md`](../scripts/README.md); the page sorts
`warning → recommendation → discovery → insight` and keeps eight. Each card
carries its rule id as evidence (`rule: <id>`). Cards past the eighth are named
in `suppressedItems` rather than dropped — the cap is a display decision, and the
system may decide not to *show* a finding but never not to *mention* it. The
Tower keeps that promise on the surface too: the findings list carries a quiet
"N more findings below the cut" reveal that discloses their titles. A mention,
not a rendered finding — kind dot and title only, with no evidence and no
mark/dismiss controls, because the page cannot offer an action for a card it
is not showing. The cap stays at **8** until evidence says eight is the wrong
number of cards to read in one sitting.

Rules generalized from manual-analysis history
([doc 13](13-opportunity-scouting.md) lane 6), with the threshold and the
finding each encodes:

- **`measurement-integrity`** (warning) — ≥10% Unassigned/`(not set)` sessions,
  or an event that ran ≥100/day dropping ≥90% WoW. A property running over 10%
  Unassigned has to caveat every number in its largest analysis. This card
  **bounds** the rest of the page rather than adding to it, and sorts first
  for that reason. The OS reports the fault only — the measurement channel is
  operator-only by invariant (doc 01).
- **`concentration-risk`** (warning) — organic search ≥85% of ≥100 sessions,
  the single-channel line [doc 00](00-objective-and-roi.md) names as the #1
  devaluation factor.
- **`query-cannibalization`** (recommendation) — ≥2 of the property's own pages
  each holding ≥20% of one query's impressions, above the striking-distance
  volume floor (25/reported date, never below 100). A homepage can outrank its
  own interior pages for months before anyone looks.
- **`query-language-drift`** (recommendation) — a country holding ≥5% of
  impressions (≥1,000) clicking at ≤half the CTR the property earns
  **excluding that country**. The finding it encodes is meta copy written in
  the site's language, not the searcher's; a one-character fix can be worth
  four figures of impressions a month. Both gates are set by that shape: a
  country large enough to matter also drags a property-wide CTR toward itself,
  so comparing against the overall number lets a locale gap hide inside its
  own comparator.
- **`device-ctr-gap`** (recommendation) — one device's CTR ≤ half the other's,
  both ≥1,000 impressions, in either direction. Not position-adjusted; a
  device-only ranking gap has the same shape, so the card says to compare
  positions first. No archived family carries **query × device**, so the
  grounding exclusion (below) cannot be subtracted where it was observed; it
  is charged entirely to the weaker surface as a worst case, which can only
  make the rule quieter.
- **`prune-candidates`** (discovery) — pages under 5 impressions across a window
  of ≥14 reported dates, on properties with ≥100 reported pages. A full prune
  rule is "<5 impressions in 90d **AND** no internal links"; only the
  impressions half exists in this archive and the card states that rather than
  implying the link half was checked. A page missing from the export entirely is
  unknown, not zero, and is never counted.
- **`page-movers`** (insight) — page-grain clicks, ≥10 absolute change across
  two complete seven-date windows, mirroring the existing query movers. Cards
  only; it deliberately adds no payload block, so the Tower needs no change.
- **`llm-grounding-traffic`** (discovery) — **quoted-literal queries are
  machine grounding**: queries like `"1 medium banana" "3/4 cup" food group`
  with zero clicks between them are retrieval verification, not people, and
  can be near a tenth of all captured page/query impressions. They are
  excluded from the CTR and position rules and from the **query movers** the
  decision lanes read, Google and Bing alike — and **never silently**: each
  affected card, and each movers lane, states the excluded impressions and
  share, at zero as well. The card is a GEO signal on the free lane with
  page-level detail the paid mention lane does not carry, and it corroborates
  S3 from an independent direction. The classifier covers the quoted signature
  only — unquoted homework-shaped queries stay in the series, so the number is
  a floor for the behavior rather than its measure.
- **`search-striking-distance`** withholds a term the panel observed as an
  overview that does not cite this property. Several of the property's URLs at
  position 1.0–1.3 with byte-identical impression counts and no clicks is *one
  block* — an AI Overview or a sitelink group — crediting them at the block's
  own position, and the consolidation a cannibalization card would recommend
  there is actively harmful. The harvest rule rewards low click-through, so
  without the gate it preferentially recommends exactly those SERPs; the card
  names what it declined to recommend. Only the observed non-citation
  withholds; an untracked term, or one whose overview did not load, is still
  offered and marked unknown on the card.
- **`bing-search-opportunity`** reads the query's own periods, states a
  decline rather than presenting it as an opportunity, names **intent
  mismatch** when a long window at a visible position takes no clicks, caps
  confidence at medium for either, and never joins across a locale subtree.
- **The backlink momentum card** states the provider's observed inventory so
  coverage can be judged before direction: a direction read over a dozen
  referring domains on a DR-30 domain is real direction on an unreal basis.
  **A second link observer is not wired** (S4 is single-observer); that is the
  honest state.
- **`distant-demand-cluster`** exists because the near-win band (position
  4–20) is right for near-wins and wrong as a property's whole aperture: it
  hides five-figure monthly searches at positions 37–49 mapping to a page the
  site already has. [Doc 13](13-opportunity-scouting.md)'s outer loop exists
  precisely so a scope filter does not become a blind spot.
- **`value-event-not-key-event`** — a value event carrying `keyEvents = 0`
  while a lesser event is marked key silently zeroes every conversion-flavored
  read the OS does, including the `ai-referral-floor` card's own "Key events"
  evidence row. Value events are declared per property in
  [`config/value-events.json`](../config/value-events.json) (+ README
  sibling). Both sides of the comparison are operator-owned — the measurement
  channel is `forbidden`-class — so the rule reports the disagreement and
  edits neither.

Several rules wait on accumulated history — the week-over-week and prune rules
need 14 reported dates — or on a property actually crossing the line.

## The "did it help?" join

Annotate each asset's deploy dates (git tags / CI webhook) onto every S1/S2 time
series. The advisory layer's core question — *did the last change move the
signal?* — is answerable only if changes and signals share a timeline. A batch
of search-facing changes shipped on one day is the natural experiment: the
panel + GSC series should show whether it moved within 2–6 weeks.

## Cost envelope

A five-family weekly run costs roughly $0.26–$0.29 per property; weekly cadence
projects to a few dollars a month for a small portfolio, below the $25/month
data cap. Exact cost is indexed per report; the scheduler reserves $0.25 before
each call and fails closed rather than crossing the cap. S2/S5/GA4 remain free.

The S1b panel adds ~$0.004 per (tracked query, **device**) and nothing at all
for the properties without one. A panel at a 40-query ceiling would cost $0.32
at two devices — more than the $0.25 the gate reserves for one family, i.e. a
family quietly outspending the reserve its own gate took. So the ceiling is
*derived*: 31 terms, which is exactly what $0.25 buys at two devices. Adding a
dimension halves it again; raising it is a decision about the reserve, not a
number to nudge.

## Not built

- S5: CrUX; nothing renders the accumulating hygiene series yet.
- S1b: the alert rules above (waiting on history, not fields); the Tower's
  device-aware panel board and the executive snapshot's panel block.
- S4: bounded backlink-detail reclamation candidates and a second link
  observer; the operator-exported Bing AI Performance lane, when its real
  schema is available.
