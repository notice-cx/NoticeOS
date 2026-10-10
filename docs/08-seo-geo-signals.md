# 08 — SEO / SERP / GEO signal reference

*The search-signal families (S1–S6) as centrally-pulled **signals** under the
[signal contract](02-signal-contract.md). This is the domain reference; the
contract owns shapes/flags/latency rules, [doc 03](03-attribution.md) owns how
any of it becomes a causal claim, and the ledger ([doc 00](00-objective-and-roi.md))
is where value is booked — positions and citations are inputs, never outcomes.*

The product pulse ([doc 02](02-signal-contract.md)) covers the *on-site* half of
each asset's health. This doc specs the *demand-side* half: organic search and AI
answer engines. Everything here comes out of a July 2026 deep-dive on one site
(see that site's repo, `docs/seo-geo-plan-2026.md`, for the research basis) and is
designed to be asset-agnostic from day one, same as the signal contract.

**Two 2026 realities shape the design:**
1. **Citation is the new position zero.** With an AI Overview present, organic #1
   loses ~58% of clicks; *cited* pages get ~2.3× the CTR of uncited ones. So we
   track "are we cited?" as a first-class dimension next to rank.
2. **Brand mentions out-predict backlinks ~3× for AI visibility** (Ahrefs, 75k
   brands). So brand-demand and mention signals are KPIs, not vanity metrics.

## Architecture decision: signals live in NoticeOS, not in asset workers

Unlike the product pulse (each asset self-reports), SEO signals should be pulled
**centrally** by NoticeOS crons: the external APIs (GSC, GA4, DataForSEO) need
portfolio-level credentials and a shared spend budget, and none of it requires
code inside the asset. Assets stay dumb; the Tower joins product pulse × search
signals on the asset id. One table family in the store, one row per (asset, date, signal).

## Signal families

### S1 — Domain-wide ranking intelligence (landed)

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

***Landed 2026-07-31*** *(build-order item 4): the weekly Monday DataForSEO lane
gained a sixth report family,* `serp-panel` *— one*
`serp/google/organic/live/advanced` *call per tracked term with*
`load_async_ai_overview` *set, archived to the same immutable R2 + append-only
manifest boundary as the other five (one manifest row per property per run, the
per-query responses as its pages). The panel itself is*
[`config/serp-panel.json`](../config/serp-panel.json) *(+ README sibling);
the flattened family is* `dataforseo-serp-panel.csv`*. Full collector behavior
and its three departures from "one family, one call":*
[workers/ingest/README §The tracked SERP panel](../workers/ingest/README.md#the-tracked-serp-panel-serp-panel-s1b).
*Deltas from this section
as written, each deliberate:*

- ***Device was one dimension until 2026-08-04; the mobile/desktop pair below
  is now landed*** *(`ro-o1n`, the operator's "Yes" — most food/health search is
  on a phone, and phone result pages carry click-consuming blocks on different
  queries). Every tracked term is read on both devices: one call per (query,
  device), still one family, one archive and one manifest row per property per
  run. The device rides in the archived request body — a documented provider
  field — so it reached* `dataforseo-serp-panel.csv` *as a* `device` *column with
  no manifest column and no migration, and pre-2026-08-04 rows read* `desktop`
  *because the collector had no other literal in it. The panel bill doubled to
  ~$0.41/week and the query ceiling halved from 40 to 31, which is what the
  unchanged $0.25 per-report reserve buys at two devices. The executive
  snapshot's AI Overview evidence stays desktop for now —* `ro-14d.1`.
- *Depth is **20**, not the whole result page: a property below it records **no
  rank**, which the CSV and the Tower both state as "not inside the tracked
  depth" rather than "not ranking".*
- ***A missing AI Overview and an unreadable one are different facts.*** Where
  the asynchronous overview does not load, `aio_present` is **unknown** (empty),
  never `false`; only a cleanly parsed page with no overview says `false`. The
  decision rules treat unknown exactly like an untracked query.
- ***`secondPos`, `features[]` and `sitelinksUs` are flattened*** *(2026-08-04,
  `ro-463`), as* `second_rank`*/*`second_url`*,* `serp_features` *and*
  `sitelinks_us` *— no new provider spend, the bytes were already bought.*
  `sitelinks_us` *is three-state like the* `aio_*` *pair and for a sharper
  reason: empty means the property held no result inside the tracked depth, so
  there was nothing of ours for sitelinks to hang off — read as* `false` *it
  would fire the sitelink-loss alert every week a ranking slipped past depth 20.
  What deliberately stays in the archive rather than becoming a column: overview
  text and full citation lists, result titles and snippets, the question text
  inside* `people_also_ask`*/*`related_searches`*, and paid blocks —*
  [scripts/README §dataforseo-serp-panel.csv](../scripts/README.md) *says why for
  each.*
- *The alert rules below are **not** wired: the panel feeds the query
  **decision lanes** and the `search-striking-distance` gate (`ro-gyu`,
  2026-08-04), not the Needs Attention band. Promoting `bestPos` drift
  and lost citations to lifecycle flags waits on repeated snapshots, the same
  bar the broad S1 comparison is held to.* Tracked as `ro-770`.

**What it changed downstream.** The query-decision lanes
([doc 10](10-control-tower.md)) gained the two rules the sibling property had
been applying by hand:

- a decision that would have recommended **title or snippet surgery** on a query
  carrying an AI Overview that does not cite us is demoted from *act* to
  *investigate* — churn without reach: the impression-harvest gate (snippet
  work earns clicks only where the result is still the click), applied
  automatically;
- a query the overview **does** cite classifies as *protect* regardless of its
  position trend, with a next step that says not to wash out the cited content.

***Every collection is read (2026-08-02).*** *A landing now files a
`panel-review` bead into the property's own tracker — due seven days later,
one per property per panel day, by the runner lane in* `scripts/os-up.mjs` *off
the* `GET /api/serp-panel-landings` *read. The panel measures nothing until
somebody triages it, and one site's went three-plus weeks unread under the honor
system. Since 2026-08-03 the panel day is the ANCHOR and the scope is the
week's whole collection — the broad inventory, the link and LLM families and the
property's own GSC/GA4/Bing exports land on the same schedule and had no reader
of their own. What closing that bead requires — the panel walk, then the
inventory pass over the week's other families — is written into the bead by*
`scripts/runner/panel-review.mjs`*;
the triage state rides the beads snapshot as* `panelReview` *so the Tower can
show a property that is overdue.*

**Cost:** each tracked query is one metered call **per device** (~$0.004 each);
one site's panel, 28 terms, is roughly **$0.22/week** and a second site's 23 terms
~$0.18 — 102 calls, ~$0.41 a Monday, ~$1.75/month against the $25 cap. It reserves
the same per-report amount as every other family before calling and fails closed
under the same portfolio cap — there is no panel-shaped exception in the gate,
which is why the second device halved the query ceiling (40 → 31) rather than
widening the reserve.

A hand-picked panel of 10–31 head terms and strategic bets is what does
mobile/desktop SERP-neighborhood and exact citation monitoring:

```jsonc
{ "asset": "example.com", "date": "2026-07-06", "query": "example calculator",
  "device": "mobile", "bestPos": 3, "bestUrl": "/", "secondPos": 4,
  "top3": ["example.org", "example.gov", "example.com"],
  "aio": { "present": true, "citesUs": false, "cites": ["example.org", "..."] },
  "features": ["people_also_ask"], "sitelinksUs": false }
```

Reference
implementation: **one site's committed `scripts/seo/serp-panel.mjs`** (+ `npm run
seo:panel`, dated snapshots in `docs/seo-panel/`, 2026-07-02 baseline) already
emits the exact S1 fields — port that into the cron and add the device
dimension. Another site's skill dir's `serp.mjs` variants are the earlier
prototypes. *(Both halves are landed as described above — the cron on 2026-07-31
and the device dimension on 2026-08-04 — and the reference site has had its own central
panel since 2026-08-03; its in-repo panel remains separate and unported. The
last three S1 fields —* `secondPos`, `features[]` *and* `sitelinksUs` *— reached
the flattened family on 2026-08-04,* `ro-463`*.)*

A site's panel seed is its row in `config/serp-panel.json`: its brand and
navigational terms, the head terms it earns impressions for, and the bets its
current plan is testing — for example `example` · `example login` ·
`example calculator` · `best free calculators`. Its 18 to 20 queries are that
site's own; an installation keeps the history of each seed in its own notes.

*Add a query when Search Console shows four-figure impressions at position 1–5
with zero clicks and several URLs sharing byte-identical impression counts on
every date — the signature of one SERP block crediting the property, not of
pages competing (the false positive F1 fixes in the cannibalization rule,
private audit F6). Whether that
block is an AI Overview is unknowable from Search Console and is exactly what
the panel observes.*

***First panel collection landed 2026-07-31T20:34:50Z*** *(manual local run;
436 provider rows, $0.0705, `status = success`). Why it had not run before is
ordinary and nothing was mis-wired: the family shipped 2026-07-31 and its cron
is Mondays 12:45 UTC, so its first scheduled run is 2026-08-03, while the only
prior DataForSEO run — 2026-07-30, a Thursday, i.e. manual — predated the panel
code by ~19 hours.*

***What the first 20-term read says.*** *AI Overview **present on 12**, absent
on 7, **unknown on 1**; the overview **cites the site on 5** of the 12; the
property ranks inside the tracked depth on 11.*

- *`where to find free meal plans` — **`aio_present = true`, `aio_cites_us =
  false`, and no rank inside depth 20**. This is the direct answer to F1's
  question: the four-figure zero-click impressions are an overview consuming the
  click while crediting our URL at the block's position, not three pages
  competing. Copy surgery here would be churn without reach.*
- *`where to find free diet plans` — the provider answered `Internal SE Server
  Error`, so **every column is unknown**, not `false`. Billed, unanswered, and
  recorded as such: the tri-state discipline doing its job on real data. The
  Monday run retries it; a re-fire purely to chase one query is not worth
  ~$1.19.*

### S1c — Discovery (net-new demand and the competitive set)

***Landed 2026-08-31*** *(`ro-cda6.2`).* Every other search family in this doc is
**reflexive**: S1 reads what a property already ranks for, S1b reads terms an
operator already chose, S2 reads queries that already earned an impression. None
of them can propose a term the portfolio has never touched — so Decide could rank
existing opportunities and never generate one, which is the difference between
optimizing a page and choosing what to build. [doc 13](13-opportunity-scouting.md)
is the outer loop that starves without this.

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
  competitor. Today the competitive set is discovered only incidentally from the
  `top3` of whichever panel queries happen to be tracked, which makes it a
  property of the panel rather than of the market.

**Why monthly is the load-bearing decision.** Net-new demand and the competitive
set do not move week to week; collecting them weekly would buy four copies of one
answer. ~$0.02 a call means ~$0.20/month across the portfolio versus ~$0.87 at
weekly — small in isolation, and the discipline is the point: August 2026 had
already committed **$12.41 of the $25 cap** before either family existed.

**What the second cadence changed.** `DATAFORSEO_BASE_REPORTS` is what three read
models grade a `report_date` complete against. A 28-day family is legitimately
absent from three `report_date`s in four, so listing it there would call three
weeks in four torn. "Was this week whole" and "what may this property be asked
for" had one answer while every family shared one cadence, and are now two:
`dataForSeoReportsFor` answers the first, the collector's `dataForSeoFamiliesFor`
(reading the REPORTS registry and its `appliesTo`) answers the second.

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
by page. The landed analysis archive also retains page×country, page×device,
page-level search appearances, image-search page×query, and Discover pages.
Discover is collected in **probe mode**: while every completed run for a
property has returned nothing, only the newest revision date is requested, so a
family the property does not participate in costs one request a day instead of
four. The full revision window resumes the moment a run carries a row.
Store raw; derive the views that actually drive decisions:
- **Position-bucket distribution over time** — counts + impressions in pos 1–3 /
  4–10 / 11–20 / 21+. (One site's July read: 57 queries top-3 vs 580 at 4–10 with
  56k impressions — the "one push from the top" shape. This chart IS the strategy.)
- **Striking-distance list, auto-refreshed** — pos 4–12 × impressions ≥100,
  the standing to-do list for content work.
- **Brand vs generic split** (per-asset regex, e.g. `/my\s?plate\s?\.?(food)?/`)
  — branded-impressions trend is the leading indicator for sitelinks, AI
  visibility, and algorithm-update resilience.
- **CTR-vs-position curve** vs 2026 benchmarks (no-AIO ~3.3% / AIO-cited ~2.1% /
  AIO-uncited ~0.9%) — flags title/snippet problems (one site's DRI page sat at
  0.66% on 13.7k impressions for a quarter before anyone looked).
- GSC's **[Search Generative AI
  report](https://support.google.com/webmasters/answer/16984139)**
  (AIO/AI-Mode impressions, launched June 2026, impressions-only) — ingest when
  the API exposes it. The documented
  [Search Analytics API](https://developers.google.com/webmaster-tools/v1/searchanalytics/query)
  currently has no generative-report type, so ordinary Web Search data must
  not be relabeled as AIO-specific.

### S3 — AI/GEO visibility
- **GA4 "AI Assistant" channel** (native since May 2026): sessions/wk from
  chatgpt.com, perplexity.ai, claude.ai, etc. The daily
  `landing-page-acquisition` archive keeps the landing URL beside source,
  channel, engagement, key events, and revenue. Treat it as a *floor* — not
  every assistant supplies a usable referrer.
- **DataForSEO LLM-mentions** weekly target metrics for Google and ChatGPT:
  reported mentions, represented AI search volume, and leading source domains.
  The current endpoint accepts one task, so properties/platforms are separate
  calls rather than an invented portfolio batch. These are provider-dataset
  coverage metrics, not unique people or attributable sessions.
- S1b's `aio.citesUs` is landed for the tracked panel (2026-07-31): exact,
  per-query, live-SERP citation state for the terms on a property's panel. It
  covers the panel and nothing else — a query nobody tracks is unknown, not
  uncited.

### S4 — Authority & links
- **DataForSEO backlinks** weekly: current domain rank/backlinks/referring
  domains plus the provider's weekly-grouped 90-day new/lost series. The
  executive layer presents net referring-domain direction.

  ***The bounded backlink-detail report this section asked for landed
  2026-08-31*** *(`ro-cda6.1`), as two families rather than one:*
  `backlinks-referring-domains` *and* `backlinks-anchors`*, same weekly cadence
  and the same immutable R2 + append-only manifest boundary as the other
  families. Until then `-summary` reported how many referring domains a property
  had and `-new-lost` reported the weekly delta, and* ***neither named one***
  *— so "we lost 12 referring domains this week" could not be turned into a
  reclamation target, which is the decision these families exist to serve.*

  *Both are capped at the head 100 rows, ordered so that a truncated read still
  answers the question asked of it: referring domains by* `rank` *descending
  (the links worth having, not whichever scraper farm links most times), anchors
  by* `referring_domains` *descending (an anchor profile is read as a*
  ***distribution***, and the head carries its shape). The cap is a cost
  decision before a coverage one — the Backlinks API bills $0.024/request +
  $0.000036/row, so 100 rows is ~$0.0276 a call against the $0.25 per-family
  reserve, and August 2026 had already committed $12.41 of the $25 portfolio cap
  before these families existed.*

  *The anchor read is also an AI-visibility input, not only a risk one: this
  doc's own second premise is that brand mentions out-predict backlinks ~3x for
  AI visibility, and brand-vs-exact-match anchor share is the closest thing the
  link families can say about it.*
- **Reclamation pipeline** as a first-class table (target page, dead URL it
  replaces, contact, status, won-link URL) — wins are events on the timeline.
  One site's universe: 156k broken dofollow links to a retired government
  resource the site succeeds, 50 .edu/.gov domains in the first 1k sample; the
  same play exists wherever a dead .gov/.edu resource has a successor.
- Ahrefs free DR checkpoint quarterly.

### S5 — Tech/GEO hygiene (regression guards)

***Landed 2026-07-31*** *(build-order item 3): the nightly pure-fetch half —
static-HTML depth, robots AI access, sitemap, and (since 2026-08-31) page
structure — runs at 04:00 UTC in*
`workers/ingest/src/hygiene.ts`*, storing one row per (asset, check, day) in*
`hygiene_checks` *(migration `0014`). Six plain HTTPS requests per property, no
provider and no quota. Full behavior, honesty rules, and the parser's documented
limits:*
[workers/ingest/README §Hygiene guards](../workers/ingest/README.md#hygiene-guards-s5--the-served-layer).
*Deltas from this section as written, each deliberate:*

- ***Page-level directives landed 2026-08-04*** *(`ro-4ba`): `<meta name="robots">`
  and `X-Robots-Tag` are read on **three sampled real pages** per property per
  night, under rule `hygiene-page-directives`. The roster is the sitemap the
  sweep already fetched — the per-asset route list this section asked for was
  never built, because a list of key routes is a second register to keep true and
  the property already publishes one. The sample is stable (hash-ordered), so the
  same pages return night after night; it is three pages, and the reading says so
  rather than claiming the property is clean.*
- ***An unreachable home page landed 2026-08-04*** *(`ro-6ad`) as its own rule,
  `hygiene-home-unreachable`, on the same fetch as the depth check.*
- ***That fetch is also each site's uptime since 2026-09-23*** *(`ro-ujb9.165`):
  the home-page check alone runs every
  hour as well (`runUptimeChecks`), and `hygiene-home-unreachable` files at
  `error` — a site that does not answer is the revenue-off-switch band. Robots,
  sitemap and the page sample stay nightly.*
- ***A failure is confirmed before it alerts since 2026-09-24*** *(`ro-ujb9.180`): a
  home page that fails is asked once more 45 seconds later in the same run, the
  hourly check and the nightly sweep alike. Only two failures in a row file
  `hygiene-home-unreachable`; a page that answers the retry reads up, with the
  failed try on its reading.*
- ***Page structure landed 2026-08-31*** *(`ro-cda6.5`, migration `0026`) as a
  fourth check,* `page-structure`*, asking four more questions of the pages the
  directive rule already fetched: is there a* `<title>`*, a meta description,
  exactly one* `<h1>`*, and does the canonical point at this page or **disclaim
  it** in favour of another. It costs **no new requests** — a served page is one
  document, and reading it twice would double the nightly request count to learn
  nothing. Only transitions fire, so a page that has always shipped without a
  description is a standing editorial decision rather than tonight's incident.*

  *The taxonomy came from* **badseo.dev** *— the companion site OpenSEO points
  its own audit at, where every page breaks exactly one rule — and so did its
  test discipline:* `STRUCTURAL_FIXTURES` *has one page per fault and a coverage
  test that fails if the parser learns a fault no page proves. What did **not**
  come across is the other twenty-odd checks. This register records incidents,
  not a competitor's feature list: each founding guard came from a real "nobody
  noticed for months" event, and these four clear the same bar because each has a
  decision attached — the snippet standard (a title and description written
  for the query, not the page) for the snippet pair, and "a page canonicalized elsewhere cannot rank" for the
  loudest of the four. **Title and description length are deliberately excluded**:
  Google truncates by pixel width and rewrites titles at will, so "your title is
  61 characters" is taste with no decision behind it, and a check that fires on
  taste is one the operator learns to ignore.*

  *What it stops short of: a structural fault is not automatically an* act*. A
  missing title on a page with impressions is worth a morning; the same fault on
  a page nobody reaches is worth nothing. That triage needs traffic evidence,
  which lives in the Tower's page decisions and not in this lane.*
- *Severity landed at **warn**, not the `error` the alert-rules line below
  specifies. `error` is the revenue-off-switch band, and a hand-rolled word
  count that has never fired in production has not earned it. **Promote to
  `error` after the first true positive** — that is the trigger, and it is a
  one-line change.*
- *`robots.txt` is still parsed at **site level only** — a blanket `Disallow: /`
  per user-agent group. A path-scoped `Disallow` still reads as allowed, and
  longest-match evaluation is only worth building once a property actually ships
  path-scoped AI rules.*
- *CrUX is untouched — still unlanded.*

- **Static-HTML depth check**: for each asset's N key routes, words-of-visible-
  content in the built/served HTML. AI crawlers don't render JS; one site's home
  served *88 words* for months and nobody noticed. Nightly HEAD-less fetch +
  count, alert on -50% vs baseline.
- **robots/AI-crawler diff**: alert if robots.txt or meta-robots changes drop an
  AI search bot (OAI-SearchBot, ClaudeBot, PerplexityBot) or add nosnippet.
  Also diary: Cloudflare default-blocks mixed-use crawlers on ad-serving pages
  for new/free customers from 2026-09-15 — re-verify each asset when ads ship.
- **Sitemap reachability + URL count** *(landed with the above)*: resolve the
  sitemap from `robots.txt` (else `/sitemap.xml`), prove it parses, count
  `<loc>` entries following one level of `<sitemapindex>`; alert on unreachable,
  unparseable, or a -50% count collapse off a base of ≥50 URLs.
- **CrUX API** monthly: INP/LCP/CLS pass-fail per asset (tiebreaker-level
  priority, but free to watch).
- Scope note: several assets already prove link-graph/sitemap/canonical
  integrity in their own CI at build time (one site's `audit:static`). S5 guards the
  *served* layer (what a crawler actually receives); don't duplicate build-time
  proofs — require them in the asset's CI bar (`AGENTS.md`) instead.

### S6 — Monetization *platform-state* signals *(added with the second node — [doc 09](09-onboarding-a-site.md))*

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
  per-asset posture, not the invariant — one site runs the US opt-out model
  (default granted, denied on reject/GPC; flipped 2026-07 after default-deny
  silently halved GA4 reporting). A regression here is a compliance
  incident → **error**.
- **Ad-platform state diary**: AdSense/Ad-Manager application + policy-center
  states are manual-entry events on the asset timeline (e.g. one site's re-review
  window, ~2–4 weeks post-remediation) — the Tower shows "days since state
  change," the advisory layer knows not to propose risky content mid-review.
- **Affiliate-click trend** rides the asset pulse ([doc 02](02-signal-contract.md)); the Tower charts it
  next to RPM once ads are live.
- **Storage-lifecycle sanity** where user content is hosted (one site's R2
  `nom-shareables`): object count should plateau under the 30-day expiry;
  unbounded growth = the lifecycle rule silently dropped → **warn**.

## Alert rules (tunable per asset; flag shape = severity × kind per [doc 02](02-signal-contract.md))

- S1b: `bestPos` worsens ≥3 vs 4-week median → **warn/anomaly** · AIO citation
  lost → **warn/anomaly** · new domain takes #1 on a panel query →
  **info/anomaly** · sitelinks appear/disappear on brand query → **info/anomaly**.
  *None of these are wired as of the 2026-07-31 landing* — tracked as `ro-770`.
  The collector and the
  flattened family exist; the panel currently feeds query **decisions**, and
  every rule here compares against retained history the archive does not have
  yet. Same bar as the S1 line below: repeated snapshots first. (The columns all
  four read now exist: `second_rank`, `serp_features` and `sitelinks_us` landed
  2026-08-04, `ro-463`. What is left is history, not fields — and
  `sitelinks_us`'s empty state is load-bearing for the sitelink rule, which must
  compare observations to observations and skip the weeks the property held no
  result inside the tracked depth.)
- The landed broad S1 weekly comparison currently emits executive
  warnings/discoveries, not lifecycle flags; repeated provider snapshots and
  real GSC impact are required before promoting those rules into Needs
  Attention.
- S2: top-10 page's clicks last7d < 60% of trailing-28d avg → **warn/anomaly**
  (min-count gated per doc 02) · branded impressions −30% WoW → **warn/anomaly** ·
  new query enters striking distance with >500 impressions →
  **info/opportunity**.
- S4: DR-60+ referring domain lost → **info/anomaly** · reclamation win →
  **info/milestone** (morale is a metric; severity stays honest).
- S5: static-depth −50% on a key route → **error/anomaly** (deploy regression).
  *Landed 2026-07-31 at `warn`/anomaly, with `hygiene-robots-ai` and
  `hygiene-sitemap` alongside it at the same severity — see the S5 delta above
  for why, and for the trigger that promotes it.*

### Executive card rules — inventory *(20 landed; 7 added 2026-07-31; 3 more + 5 corrections from the audit below)*

Distinct from the lifecycle flags above: these are deterministic rules over the
archived report families that emit **cards**, not flags, and never write to the
Needs Attention lane. The full table with the exact family each rule reads lives
in [`scripts/README.md`](../scripts/README.md); the page sorts
`warning → recommendation → discovery → insight` and keeps eight. Each card
carries its rule id as evidence (`rule: <id>`). Cards past the eighth are named
in `suppressedItems` rather than dropped — the cap is a display decision, and the
system may decide not to *show* a finding but never not to *mention* it. *Since
2026-08-04 (`ro-wwm`) the Tower keeps that promise on the surface too: the
findings list carries a quiet "N more findings below the cut" reveal that
discloses their titles. A mention, not a rendered finding — kind dot and title
only, with no evidence and no mark/dismiss controls, because the page cannot
offer an action for a card it is not showing.*

The seven added 2026-07-31 come from one site's manual-analysis history
generalized to every property ([doc 13](13-opportunity-scouting.md) lane 6).
Thresholds and the finding each encodes:

- **`measurement-integrity`** (warning) — ≥10% Unassigned/`(not set)` sessions,
  or an event that ran ≥100/day dropping ≥90% WoW. That site ran 13.7% Unassigned
  and had to caveat every number in its largest analysis; `form_start` fired 8
  times against 41,195 completions. This card **bounds** the rest of the page
  rather than adding to it, and sorts first for that reason. The OS reports the
  fault only — the measurement channel is operator-only by invariant (doc 01).
- **`concentration-risk`** (warning) — organic search ≥85% of ≥100 sessions,
  the single-channel line [doc 00](00-objective-and-roi.md) names as the #1
  devaluation factor.
- **`query-cannibalization`** (recommendation) — ≥2 of the property's own pages
  each holding ≥20% of one query's impressions, above the striking-distance
  volume floor (25/reported date, never below 100). That site's homepage outranked
  its own interior pages for months before anyone looked.
- **`query-language-drift`** (recommendation) — a country holding ≥5% of
  impressions (≥1,000) clicking at ≤half the CTR the property earns
  **excluding that country**. That site found meta copy written in the site's
  language, not the searcher's; the Korean fix was one character and ~1,300
  impressions/month. Both gates are set by that case: it sat at 6.5% share, and
  a country large enough to matter also drags a property-wide CTR toward itself,
  so comparing against the overall number lets a locale gap hide inside its own
  comparator. *(Retuned 2026-07-31 from an initial 15%-share/overall-CTR
  version, which the origin case would have cleared neither gate of.)*
- **`device-ctr-gap`** (recommendation) — mobile CTR ≤ half desktop CTR, both
  ≥1,000 impressions. Not position-adjusted; a mobile-only ranking gap has the
  same shape, so the card says to compare positions first.
- **`prune-candidates`** (discovery) — pages under 5 impressions across a window
  of ≥14 reported dates, on properties with ≥100 reported pages. That site's
  noindex rule was "<5 impressions in 90d **AND** no internal links"; only the
  impressions half exists in this archive and the card states that rather than
  implying the link half was checked. A page missing from the export entirely is
  unknown, not zero, and is never counted.
- **`page-movers`** (insight) — page-grain clicks, ≥10 absolute change across
  two complete seven-date windows, mirroring the existing query movers. Cards
  only; it deliberately adds no payload block, so the Tower needs no change.

Currently quiet by design: on the 2026-07-31 archive only
`measurement-integrity` (4 of 5 properties) and `query-cannibalization`
(one property) fire. The rest wait on either accumulated history — the GSC
families retain 3 reported dates against the 14 the week-over-week and prune
rules require — or on a property actually crossing the line.

#### Corrections from one site's signal audit *(2026-07-31)*

An external audit
(private historical evidence) cross-checked every
card on that site against the raw archive CSVs. Four cards reproduced exactly,
**two were misleading, two were artifacts**, and several high-value conditions
produced no card at all. The rule engine's own defects, in the order they matter:

- **Quoted-literal queries are machine grounding, and they were contaminating
  every CTR rule.** 4,216 impressions — **9.0% of all captured page/query
  impressions** — came from queries like `"1 medium banana" "3/4 cup" food group`
  with **zero clicks** between them: retrieval verification, not people. They are
  now excluded from the CTR and position rules — and, since 2026-08-04, from the
  **query movers** the decision lanes read, Google first (`ro-frx`) and Bing once
  the signature had been measured there too (`ro-pvl`; that family is clean by
  three orders of magnitude, which is why the check runs on it rather than why it
  is skipped) — and **never silently** (each affected card, and each movers lane,
  states the excluded impressions and share, at zero as well), and they get their
  own discovery card, `llm-grounding-traffic`. That card is a GEO signal on the
  free lane with page-level detail the paid mention lane does not carry, and it
  corroborates S3 from an independent direction: the property that is the
  **#1 cited domain** on Google AI surfaces is also being read, at scale, by
  something that never clicks. The classifier covers the quoted signature only —
  unquoted homework-shaped queries stay in the series, so the number is a floor
  for the behavior rather than its measure.
- **`query-cannibalization` was firing on single-SERP-block artifacts.** Three
  URLs at position 1.0–1.3 with byte-identical impression counts and no clicks
  anywhere is *one block* — an AI Overview or a sitelink group — crediting
  several of the property's URLs at the block's own position. The consolidation
  the card recommended would have been actively harmful. This is exactly the
  question S1b's `aio_present` / `aio_cites_us` answers directly, which is why
  the two observed block queries were added to the panel. *Since 2026-08-04
  (`ro-gyu`) that answer is wired into a second rule:
  **`search-striking-distance` withholds a term the panel observed as an
  overview that does not cite this property** — the harvest rule rewards low
  click-through, so without the gate it preferentially recommended exactly those
  SERPs, and the card now names what it declined to recommend. Only the observed
  non-citation withholds; an untracked term, or one whose overview did not load,
  is still offered and marked unknown on the card.*
- **`device-ctr-gap` was one-directional** and stayed silent while desktop
  clicked at roughly a quarter of mobile's rate on double the impressions. It is
  bidirectional now. No archived family carries **query × device**, so the
  grounding exclusion cannot be subtracted where it was observed; it is charged
  entirely to the weaker surface as a worst case, which can only make the rule
  quieter. The site's gap survives that correction.
- **`bing-search-opportunity` presented a four-month decline as an opportunity**
  at high confidence, quoted the snapshot's date count rather than the query's,
  and joined an English/US Bing query to a Spanish page. It now reads the query's
  own periods, states the decline, names **intent mismatch** when a long window
  at a visible position takes no clicks, caps confidence at medium for either,
  and never joins across a locale subtree.
- **The backlink momentum card was built on an inventory of 11 referring
  domains** for a domain Ahrefs rates DR 32 — real direction on an unreal basis.
  The card now states the provider's observed inventory so coverage can be judged
  before direction. **A second link observer is still not wired** (S4 remains
  single-observer); that is the honest state, not a solved item — tracked as
  `ro-2hs`.
- **`distant-demand-cluster` is new** because the near-win band (position 4–20)
  is right for near-wins and wrong as a property's whole aperture: it hid ~56k
  monthly searches at positions 37–49 mapping to a page the site already has.
  [Doc 13](13-opportunity-scouting.md)'s outer loop exists precisely so a scope
  filter does not become a blind spot; this is that loop paying out.
- **`value-event-not-key-event` is new.** The site's `calculation_complete`
  (1,989 events / 5 days) carried `keyEvents = 0` while `auth_complete` carried
  142, silently zeroing every conversion-flavored read the OS does — including
  the `ai-referral-floor` card's own "Key events: 0" evidence row, which was this
  misconfiguration presented as behavior. Value events are declared per property
  in [`config/value-events.json`](../config/value-events.json) (+ README sibling).
  Both sides of the comparison are operator-owned — the measurement channel is
  `forbidden`-class — so the rule reports the disagreement and edits neither.

**What this changed on the site's page:** `query-cannibalization` moved off the
free-diet-plans artifact onto a real three-locale split for "ffmi";
`bing-search-opportunity` dropped to medium with the decline stated;
`device-ctr-gap` and `value-event-not-key-event` now fire; and the eight-card cap
binds for the first time — three warnings and five recommendations fill the page,
so `llm-grounding-traffic` and both cluster cards are named in `suppressedItems`
rather than shown. Whether to raise the cap is an operator decision, not a rule
change — and `ro-wwm` took the reveal option rather than the raise: the cap stays
at **8** (no evidence has been produced that eight is the wrong number of cards
to read in one sitting) and the Tower's findings list now discloses the
suppressed titles behind a one-line affordance, so the largest finding in the
archive is one click deep instead of invisible.

## The "did it help?" join

Annotate each asset's deploy dates (git tags / CI webhook) onto every S1/S2 time
series. The advisory layer's core question — *did the last change move the
signal?* — is answerable only if changes and signals share a timeline. One site's
July 2026 batch (titles, succession block, calculator static-bake, food-group
subpages, shipped 2026-07-02) is the first natural experiment: the panel + GSC
series should show whether it moved within 2–6 weeks.

## Cost envelope

The first landed five-family run cost $0.263692–$0.286540 per property
($1.122772 for four launched properties). Weekly cadence projects to roughly
$4.50/month at the current portfolio shape, below the existing $25/month data
cap. Exact cost is indexed per report; the scheduler reserves $0.25 before each
call and fails closed rather than crossing the cap. S2/S5/GA4 remain free.

The S1b panel adds roughly **$0.41/week** across one site's 28 terms and a second
site's 23 — 102 calls at ~$0.004 apiece, since 2026-08-04 one per (tracked query,
**device**) — and nothing at all for the properties without one: about
$1.75/month against the same cap.

The gate still needed no panel-specific arithmetic, but the second device is what
made that a live constraint rather than a comfortable one. A panel at the former
40-query ceiling would now cost $0.32 — more than the $0.25 the gate reserves for
one family, i.e. a family quietly outspending the reserve its own gate took. So
the ceiling became *derived*: 31 terms, which is exactly what $0.25 buys at two
devices. Adding a dimension halves it again; raising it is a decision about the
reserve, not a number to nudge.

## Build order

1. **Landed:** S2 GSC archive + striking-distance/query-movement views.
2. **Landed:** S1 domain ranking inventory, S3 weekly LLM mention metrics, S4
   backlink summary/movement, and GA4 AI-referral floor.
3. **Landed 2026-07-31:** S5 static-depth + robots + sitemap guards (pure fetch,
   no API), joined **2026-08-04** by page-level meta-robots/`X-Robots-Tag` over a
   three-page sitemap sample (`ro-4ba`) and a dedicated home-page-unreachable
   rule (`ro-6ad`). Remaining in the family: CrUX. Nothing renders the
   accumulating series yet — `ro-gct`.
4. **Landed 2026-07-31:** S1b tracked panel, seeded for one site alone —
   the rule "only where the broad inventory cannot answer the question" is now
   enforced by config: a property with no panel is skipped silently and costs
   nothing. A second site joined 2026-08-03 (`ro-e9h`); the **phone device dimension
   landed 2026-08-04** (`ro-o1n`), doubling the calls and halving the query
   ceiling; the last three S1 fields (`second_rank`/`second_url`,
   `serp_features`, `sitelinks_us`) were flattened **2026-08-04** (`ro-463`).
   Remaining in the family: the S1b alert rules (`ro-770`, waiting on history
   rather than on fields now), and the two device-aware readouts
   the phone's rows now deserve — the Tower's panel board (`ro-e46.2`) and the
   executive snapshot's panel block (`ro-14d.1`).
5. Add bounded backlink-detail reclamation candidates and the operator-exported
   Bing AI Performance lane when their real schemas are available.
