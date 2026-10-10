# 11 — Integrations & their economics

*Agents are only as effective as the data they can actually reach. A plan
devised from stale or imagined data is confabulation with extra steps — so
every third-party integration is cataloged here with its access mode, cost
model, quota reality, consuming stage, and degradation posture. Two hard
rules: (1) **hypothesis cards must cite their data sources** from this catalog
([doc 10](10-control-tower.md)'s "why this rank" expander shows them); an agent
that couldn't reach a source says so in its contract report — it never guesses
([doc 05](05-execution-and-accountability.md)). (2) Every metered integration
has a budget line on the asset-#0 ledger and a fail-closed posture in
[doc 06](06-operations.md).*

## The catalog

| Integration | Provides | Consumed by | Access | Cost model | Quota / limit reality | On failure |
|---|---|---|---|---|---|---|
| **GSC API** | live collector: daily Google-search clicks, impressions, CTR, average position; daily archive: ten report families ([doc 02](02-signal-contract.md#central-signals)) | Sense (S2), Attribute | service account; Full-user grant per property; read-only API scope | Free | live total query runs 96/day/site; the archive adds 40 base requests/day/property (ten report families × four dates), search-appearance expansion, and pagination. Search Analytics exposes at most 50k rows/day/search type and does not guarantee every row, so an archive is analysis-grade evidence, not a complete log | retain last good snapshot/archive, record the failed report manifest, suppress dependent flags |
| **GA4 Data API** | live collector: daily active users, sessions, page views, events; on-demand display read: exact distinct users in trailing 30- and 5-minute windows, users per minute over the last 30, plus today-by-hour against the same weekday last week; daily archive: eight report families plus an exact rolling 28-day event-user aggregate ([doc 02](02-signal-contract.md#central-signals)) | Sense, Attribute | service account; Viewer grant per property; read-only API scope | Free tier (separate token quotas per property and request category) | daily-series query runs 96/day/property; open Tower displays share two Realtime requests/property per minute (both minute ranges, and the per-minute rows of the Wall's minute pulse), and one bounded Core hourly request/property per 15 minutes for today plus seven days ago; a display whose cache was emptied (a deploy, eviction, a new day or clock) reads at once instead of waiting out that cadence, at most one extra read per window; hidden tabs stop polling, and refused requests enter a shared cooldown; archive adds 33 base requests/day/property (eight daily families × four revision dates plus one rolling aggregate), plus pagination, and caps each report at 250k rows. Data API is aggregate/modelled reporting, not raw event/session export. **Event parameters** (`customEvent:*`) answer only after an operator registers them as custom dimensions, and are never backfilled. Every lane sends `returnPropertyQuota`, so token spend is measured rather than inferred from request counts | retain last good daily/display snapshot and archive; record a failed durable report manifest; never turn a provider failure or a future hour into zero; today remains visibly incomplete; an unregistered custom dimension is its own manifest state (`ga4_custom_dimension_unregistered`), never an empty success; scheduled collection names an exhausted token budget `ga4_quota_exhausted`; display reads return a safe quota category and next permitted attempt, and a bucket under 20% remaining raises `ga4-quota-pressure` before the failures start |
| **Bing Webmaster Tools API** | live: site-level daily clicks/impressions; archive: six report families ([doc 02](02-signal-contract.md#central-signals)). The separate AI Performance UI report is not exposed by the documented API | Sense (S2 complement), Attribute | user-level API key on one central BWT account; sites verified per property (GSC import supported) | Free | one live request/site/day plus one shared site-list request and four archive requests/verified site/day — six on the day the two weekly families come due. Microsoft publishes no read-quota figure; query/page reports update weekly, are collected weekly, and can trail the wall clock | retain last good live snapshot; record each failed archive family independently; never fill an absent trailing day with zero or relabel undifferentiated impressions as AI citations |
| **MS Clarity data-export API** | session behavior aggregates (rage/dead clicks, quickbacks, script errors, scroll) | Sense (UX signals), hypothesis grounding | API token per project | Free, but **10 calls/project/DAY hard cap**; trailing 72h only; ≤3 dims; 1,000 rows, no pagination | one call returns ALL metric blocks per dimension split, so URL + Device = full read in 2 calls; ALWAYS snapshot to store and analyze from disk; counts only — element detail needs dashboard replays; `clarity.ms` is adblock-DNS-listed (undercounts ~15–25%, rankings hold; can also blackhole the OS's own probes) | optional lane — degrade silently, flag staleness |
| **PostHog query API** ([below](#posthog)) | product behaviour: daily visits, event taxonomy, errors, rage clicks, real-visitor page speed (LCP/INP/CLS/FCP p75), declared funnels | Sense (UX and product signals), Decide (hypothesis grounding) | one read-only personal API key for the account (Project, Insight and Query read), connected on `/integrations`; region, projects and saved funnels discovered | Free per query | 2,400 requests/hour, 240/minute, 3 concurrent queries, a 10-second execution cap and an hourly bytes-read budget per project; six bounded, server-aggregated queries per asset per day, run one at a time | keep the last archive, mark the source degraded, name the refused or skipped family; a 429 stops the run; missing rows are not zeros |
| **DataForSEO** | top ranked keywords with demand/difficulty/CPC/SERP features, backlink stock + 90-day new/lost movement, Google/ChatGPT mention metrics, and live result pages for an operator-chosen head-term panel | Sense (S1/S1b/S3/S4), Decide (opportunity sizing, the AI-Overview gate) | one shared API login/password; launched domains are discovered from Postgres; tracked terms from `config/serp-panel.json` | Metered: roughly $0.26–$0.29 per property per weekly run, plus ~$0.004 per tracked panel term per device; each report records exact provider cost | five bounded calls/week/launched property plus one per tracked query **per device**; the site's saved market (United States · English by default), phone and desktop; 200-row ranked-keyword cap, a 31-term panel ceiling and a 20-result panel depth. A $0.25/report reserve makes the $25/month portfolio data cap fail closed before a call, and the provider card renders how much of that cap is left this month, counted from the costs the reports themselves recorded, plus the prepaid account credit as a dated sighting — refreshed by ONE free `appendix/user_data` read at the end of every sweep that worked, which is metered spend of zero and is never retried | retain the latest stored snapshot, mark the lane degraded, and never interpolate missing rankings, links, AI mentions, or AI-Overview state |
| **Ahrefs** | DR (free tier), site metrics (plan-gated) | Decide (sizing), Attribute (links) | MCP (existing) | Plan-dependent; many endpoints 403 on current plan | treat as best-effort enrichment only | fall back to DataForSEO backlinks |
| **Cloudflare** | R2 (raw archives), Analytics Engine (pulse floor for database-less assets), D1 asset-database backups ([below](#cloudflare-d1-backups)); GraphQL analytics (edge traffic, crawler hits); **AI Gateway** (budget enforcement, fallbacks); health checks | everything; Act (deploys); doc 06 (caps) | API tokens, scoped per account | Infra ≈ free tier today; AI Gateway free (pays for itself in enforcement) | AE free tier covers pulse volume; GraphQL analytics rate-limited but generous | infra failure = incident, not degradation |
| **GitHub App** | PR create/read, checks, deploy webhooks, file contents | Act, Sense (deploy annotations) | App private key (the crown jewel — doc 06 rotation) | Free | 5k req/hr/installation — ample | Act pauses; Sense keeps running |
| **Model providers (via AI Gateway)** | builder/verifier/judge inference | Act, Decide sweeps | keys behind the gateway only | Metered per token; **the dominant OS cost** | per-run/day/month caps, velocity breaker (doc 06) | fallback chain → pause Act |
| **Ad networks** | revenue reporting → shared financial reads | Sense (revenue lane) | Mediavine daily collector; CSV for other providers | Free reporting | provider estimates stay estimated until payment reconciliation | keep saved history; missing reports are not zero |
| **Affiliate networks** (CJ, Amazon) | commissions, EPC → ledger; **CJ product feed** (GraphQL `ads.api.cj.com`: live prices/sale prices/images/tracked deep links) + link-search promos → placement data | Sense (revenue lane), Act (placement refresh) | CJ: PAT + CID (developer portal); transaction reports filter by SID = per-placement conversion attribution | Free | a CJ feed is best consumed as a crystallized tool: feed → committed catalog with honesty gates (14-day price staleness ⇒ card self-degrades; no promo without a real end date); Amazon reporting is degraded with a 60-day lag | wide intervals; book on payment |
| **Uptime** | up/down per site, with when it was last checked | Sense, incident detection | none — no account and no connect step: the ingest GETs each site's home page itself (`runUptimeChecks`, `workers/ingest/src/hygiene.ts`) on the hourly tick, reusing the nightly served-layer check and its `hygiene_checks` reading | Free | one request per site per hour; a site read in the last 30 minutes is skipped | a home page that does not answer twice in a row, 45 seconds apart, files `hygiene-home-unreachable` at error (one failed try files nothing and the row reads Up · 1 failed try); an OS that cannot reach the network accuses no site (the egress gate) and the row reads Not checked |
| **Discord webhooks** | operator notifications — a **new open error alert** and a **data source that stops working**, and nothing else; the list is declared once in `packages/contract` (`NOTIFIED_CONDITIONS`) so the card and the sender cannot drift | ingest → operator | one webhook url, connected on `/integrations` ([below](#how-to-connect-one)) | Free | keep channels few — alert fatigue is a documented failure mode, which is why the list is two lines rather than a digest | fall back to email |
| **Web search API** | grounded scouting (lanes 1–4, [doc 13](13-opportunity-scouting.md)) | Scout sweeps | API key | Metered, cheap per query | budgeted per lane; results cached to the store | lane skips cycle |
| **Deep-research runs** | bounded multi-source investigations for high-stakes scout finds | Scout (lanes 1/3/5) | via model gateway | **The expensive lane** — per-run cap mandatory | few runs/month; each must name its target find | skip; never substitute a shallow guess |
| **Google Trends** | demand timing/seasonality for scout finds | Scout, Decide sizing | public/unofficial API | Free | rate-limited; directional only | omit trend dimension |
| **Wayback / End-of-Term archives** | orphaned-demand mining | Scout lane 1 | public APIs | Free | slow; batch politely | lane pauses |
| **Update/volatility trackers** | Google update calendar + SERP volatility for doc-02 `external` annotations + doc-03 confound hygiene | Sense, Attribute, Scout lane 2 | scrape/RSS | Free | secondary sources; corroborate before annotating | manual entry fallback |
| **Marketplace feeds** (Flippa-class) | acquisition watch against portfolio buy criteria | Scout lane 5 (quarterly) | RSS/alerts | Free tier | low cadence by design | dormant lane |
| **HN (Algolia API)** | radar: tech/AI/industry signal, front-page + keyword queries | Scout radar (collect tier) | public API | Free | generous; poll daily, not live | radar gap, note it |
| **News/RSS aggregation** | radar: curated industry + AI-announcement feeds | Scout radar (collect tier) | RSS | Free | curate hard — feed count is a noise budget | prune dead feeds |
| **shadcn MCP + skills** | component registry browse/install + composition knowledge for Tower UI work ([doc 14](14-design.md)) | Act (UI builds) | MCP server | Free | registry-driven — agents compose, don't hand-roll | build from in-repo components only |

## Mediavine revenue

Mediavine ships with NoticeOS as `packages/mediavine`; no separate installation,
Go binary, browser automation, or external CLI dependency is required. Its
private publisher GraphQL interface is isolated in that package. NoticeOS owns
the credential store, scheduling, retries, settings, and financial reads. This
is the model for bundled integrations: a provider client with a small typed
interface, plus an adapter to the existing NoticeOS services. A general plugin
loader is unnecessary for this integration.

1. On **Integrations**, Mediavine's **Connect** (or the site's **Ad revenue**
   row's Connect) opens the connect panel: your publisher email and password,
   then **Connect**. NoticeOS signs in and lists the account's sites before it
   keeps the login; a refused login is never stored.
   Credentials and access/refresh tokens use the existing encrypted credential
   store and key rotation, and the session and site list the sign-in produced
   are kept with them, so the list that follows asks Mediavine nothing more.
2. Each site is matched to the Mediavine site on its own domain and ticked; a
   site the account holds that no site claims is listed under them.
   **Start collecting** saves the site id on the site's ad revenue entry — the
   only field it writes — and runs the first sync at once: the current month
   so far (before 06:10 Pacific, through the day before yesterday).
3. A site with a saved Mediavine site id syncs daily until its Data sources row
   says **Not using**; `mediavineSyncOn` in `packages/contract/src/mediavine.ts`
   is that one rule, read by the sync, the row and the monitoring. Financials,
   Home, the TV dashboard, and asset revenue all read the same saved figures.

The scheduled target is **06:10 Pacific time**, including daylight saving
changes. Yesterday is requested explicitly, regardless of portal presets. The
06:00 availability observation comes from the operator; missing/null days are
treated as incomplete and retried, never recorded as zero. Scheduler ticks at
minutes 10, 30 and 50 merely check whether work is due. A successful day causes
no more automatic provider calls that day. After downtime, collection catches
up missing days in one bounded request (at most 366 days).

There are at most three automatic report attempts per day. Failures back off
20 then 40 minutes, with provider `Retry-After` taking precedence. Authentication
failure stops automatic attempts until reconnection. Manual attempts are at
least 15 minutes apart. Site discovery caches successful results for 15 minutes
and also delays repeated failed probes. One durable, renewed lease serializes
discovery, authentication, collection, and credential/settings changes.

Access tokens are reused and refreshed only when due or rejected; password login
is reserved for a missing/rejected refresh session. The provider supplies access
expiry; refresh-token lifetime is not assumed. Page views and status reads never
contact Mediavine. Not using stops a site's collection; Disconnect deletes the
encrypted credentials and session and leaves each site's saved Mediavine site
id as it was. Both retain financial history. Connecting again lists those
sites as already mapped, and Start resumes them. A site with stored revenue remains assigned to its
original asset, preventing the same site's history from appearing twice.

`mediavine_daily` keeps changed daily observations in integer USD cents;
`mediavine_runs` keeps attempted ranges, outcome, and the portal summary versus
the daily sum. Daily sums drive the shared `financial_ledger` view. A reported
summary discrepancy is shown, not distributed across dates. Missing or partial
responses preserve the last complete data. Daily estimates replace an older
Mediavine CSV estimate only once they cover its recorded window; unknown CSV
coverage requires the full month. Reconciled payments, including their
superseding lineage, take precedence. Original ledger rows are never rewritten.

Use **Backfill or recheck dates** to retrieve older reports or revisions. The
thin command-line interface uses the same NoticeOS collector and session:

```sh
pnpm mediavine status --asset example.com
pnpm mediavine sites
pnpm mediavine sync --asset example.com
pnpm mediavine sync --asset example.com --start 2026-08-01 --end 2026-08-31
```

All commands return JSON; `--url` selects a different NoticeOS origin. Credentials
are configured in the UI. The earlier standalone `mediavine-cli` is a prototype,
not a NoticeOS runtime dependency. The tables are included in the
[Postgres schema](../db/postgres/migrations/0001_baseline.sql); schema changes
follow the operator-only maintenance sequence in
[AGENTS.md](../AGENTS.md#local-os-health-and-recovery).

### Wall revenue outlook

The Wall replaces its daily-users headline with **Projected ad revenue**
for the current month. It shows the projected total, estimated earnings per
remaining day, and the projected change against the previous complete month.
The headline's hover text includes reported earnings and their date.
The existing daily traffic bar chart, comparisons, and date labels stay intact;
only its headline shows the revenue projection and pace.
Projections never become financial-ledger entries or reconciled revenue.

The model reads saved Mediavine reports and GA4 sessions; viewing the Wall
does not contact either provider. Backfill about twelve weeks of revenue for
initial calibration and a complete previous-month comparison. At least 21
matched traffic/revenue days and two observations of every weekday are needed.
Each weekday uses its latest four traffic observations, weighted toward recent
weeks. Earnings use the median revenue per session from up to seven days with
similar traffic in the last eight weeks. Weekend behavior is learned from the
asset's observations, with no site-specific coefficients.

Under **Ad revenue → Forecast holiday calendar**, choose US, Canada, both, or
weekday patterns only. Public holiday dates come from
[date-holidays](https://github.com/commenthol/date-holidays) (ISC code;
CC BY-SA 3.0 calendar data). Holiday traffic is compared with nearby normal
occurrences of the same weekday; a multiplier is learned only after two
distinct holidays have observations. It can represent an increase or a decrease.
School vacations, private closures, and other unobserved events are not inferred.

An upcoming holiday without enough evidence, missing current-month reports,
stale traffic, or traffic far outside the earnings history withholds the
projection and displays the reason. The prior-month comparison also waits for
that entire month. Reported earnings remain visible while a projection is
unavailable. Forecasts assume recent patterns continue; they are estimates,
not promises of payment.

## How to connect one

Every provider is connected in the product, on the Tower's `/integrations`
page; `/health` shows what each data source is producing. How the credential
store works (encryption, store before environment, what a run records, the
legacy environment fallback and **Import from this machine**) is written once,
in the [ingest README](../workers/ingest/README.md#credential-store-one-key-every-provider).

What **Test connection** costs is declared on the card. Five probes are a free
read-only call. Two are not, and the card says so before the press: Discord's
posts a real message, and the OAuth app's calls nobody.

| Provider (id) | Fields | Probe the *Test connection* button makes |
|---|---|---|
| Mediavine (`mediavine`) | publisher email and password | permitted-site discovery; session reuse and a 15-minute cache/cooldown are shared with collection |
| Google (`google`) | **either** a sign-in (`GOOGLE_OAUTH_REFRESH_TOKEN`, written by the flow — see [Connecting Google](#connecting-google)) **or** `GOOGLE_SIGNAL_ACCOUNTS`, the account-label → `{service_account_b64, properties}` map | gets a read-only token, then Search Console `sites.list` and one GA4 `properties/{id}/metadata` read. Identical for both ways in; only the refusal differs, because "add the robot as a Full user" and "check which account you signed in with" are different instructions. No day of data is requested and no reporting token is spent |
| Google OAuth app (`google-oauth-app`) | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | a shape check, deliberately: no free Google call proves a client id and secret without dragging a person through a consent screen, so the honest verdict is *looks right, now sign in*. **Not a card of its own** — the Google card asks for it in place |
| Bing Webmaster (`bing-webmaster`) | `BING_WEBMASTER_API_KEY` | `GetUserSites` — the same call the collector opens with |
| DataForSEO (`dataforseo`) | `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` | `appendix/user_data`; free, and it reports the credit left before the metered lane stops — recorded with the instant it was seen so the card shows it dated without pressing anything; the budget line beside it shows the monthly cap |
| Calendar feeds (`calendar`) | `CALENDAR_FEEDS` — name → secret ICS url | one bounded GET per feed, reported **by label**; the url is the credential and never appears in a verdict |
| Discord (`discord`) | `DISCORD_WEBHOOK_URL` — the whole `https://discord.com/api/webhooks/…` address | **posts one labelled message to the channel, and the card says so before the press.** Discord does offer a read of the webhook object and it would prove the wrong thing: the catalog row above defines this data source as live when the OS *can deliver a notification* — "not merely that a webhook URL exists" — and a webhook whose channel the operator lost still answers a read. The url is the credential and never appears in a verdict, and Discord's own error body is never reflected back |

### What the notification channel carries

- **Two conditions.** `NOTIFIED_CONDITIONS` in `packages/contract` is both what
  the notifier sends and what the card promises: a new open **error** alert,
  and a data source that turns **Failing** (read through the same
  `connectionState` as the card's chip). Nothing else.
- **Once per condition.** The lane runs hourly at `:05`. The `notifications`
  table records each condition only after a successful delivery, so a failed
  send is retried next tick and the Alerts row's *notified* mark means a
  message landed.
- **A real delivery stamps the credential**, like the Clarity export does.
- **No `notifications` table, nothing sent**, and the card says so; migrations
  are operator-only.
- **A 24-hour horizon**, so the first tick is not a replay, and at most ten
  lines per message with a count of the rest.

### Clarity: the one per-asset credential

- **One connection, one map.** Clarity issues a token per project, so its
  credential is an `asset-map` field (asset id → that asset's token) on the
  provider's one connection. *Per-asset* changes the form (one input per asset)
  and the card (which assets have a key), not the store.
- **The single-project `CLARITY_PROJECT_API_TOKEN` is one entry of that map**,
  declared as `legacyAssetBinding` in `packages/contract`. The card counts it,
  **Import from this machine** moves it into the map, and the export records
  which slot answered. The map wins wherever both name the asset, and the form
  offers no input for the single token.
- **Calls left today, per asset**, counted from the `archive_runs` rows the
  export wrote (one per call, a failed call included) in UTC days. Reading it
  costs no provider call.
- **Test connection calls nobody.** With ten calls a day and no free endpoint,
  the test reports which assets hold a token and leaves `last_ok_at` alone; the
  04:30 export is the proof that stamps it.

### DataForSEO: the month's cap and the account's credit

- **The bar is the cap**: month-to-date metered spend against
  `monthly_caps.data_usd`, the reserve that fails closed before a call. One bar
  for the portfolio, not one per asset; the cap is edited in `/settings`.
- **The credit is a dated sighting beside it**, from the free
  `appendix/user_data` read that **Test connection** makes and the weekly sweep
  repeats once after a run that worked (never retried). It is stored as
  `balance_usd` and `balance_seen_at` on `noticeos.integration_connections` and
  shown as *Account credit $18.72 · seen 2h ago*. A sighting older than
  fourteen days turns warn-toned; an unparseable one is dropped; a rotation
  clears it.
- **One sum.** The card, `/health`, `/settings`, the Wall's pace and the
  collector's own cap gate all read `loadMeteredDataSpend` in
  [`packages/contract`](../packages/contract/src/metered-spend.ts): each
  collected report's `provider_cost_usd` plus the
  [`research_log`](../db/postgres/migrations/0001_baseline.sql) rows bought one
  question at a time, disjoint by `actor`.

## Connecting Google

Google is the one provider with two ways in, and **both stay valid**: an
install running on a service account is not asked to move. The service-account
path asks an operator to create a robot in a cloud console, download a JSON
key and grant that robot on every property one at a time; signing in does the
same job with one consent screen. The card shows which is in force.

The operator's steps are the [Connect Google](guides/connect-google.md) guide;
how the round trip, the signed state, the expiry and the revoke are built is in
[the ingest README](../workers/ingest/README.md#two-ways-in-for-google).

**What it costs.** Nothing at Google: the sign-in, *Test connection* and the
property listing are free read calls, and no reporting token is spent until a
collector runs (the [catalog](#the-catalog) rows carry those quotas). The OS
asks for exactly two read-only scopes plus the operator's address:
`analytics.readonly`, `webmasters.readonly` (deliberately **not**
`webmasters`, which can also verify and delete sites) and `openid` + `email`,
so the card can say *Connected as ops@example.com*, the only version that
catches signing in with the wrong Google account.

**How it fails, and what the operator sees:**

- **A box unticked on the consent screen.** A grant missing either read scope
  is refused, not stored; otherwise a credential that reads Analytics but not
  Search Console would look connected and fail one lane a day later.
- **`redirect_uri_mismatch` or a refused http address.** The redirect URI is
  derived from the address the browser is on, never configured, and Google
  refuses plain http except on loopback. A Tower reached by a LAN address
  offers its `127.0.0.1` address instead; a deployed Tower on https needs
  neither.
- **The seven-day clock.** A consent screen left in Testing expires every
  refresh token seven days after it is granted, and Google publishes no API
  that says whether a screen is published. The card counts down (warn-toned
  inside 14 days, so from the moment a seven-day grant is made) and offers
  *it does not expire* as the operator's answer. **Publishing the app is the
  real fix**; the read-only scopes are not sensitive enough to need
  verification for a standalone install.
- **A revoked or expired grant** answers `invalid_grant`; the card and
  `last_error` say *Google revoked this sign-in* in one fixed sentence rather
  than blaming the network, and the fix is to sign in again.
- **Signed in, nothing mapped.** A sign-in says which GA4 properties and
  Search Console sites the account can see; **which site each belongs to is the
  operator's answer**, on the site's Data sources tab. Until one is mapped the
  collector collects nothing and says so once per pull rather than failing.
- **Disconnect** revokes the grant at Google first, best effort, then deletes
  it.

## Grounding rules (why this doc exists)

- **Tool access is via MCP/gateway from the agents' side** — agents query live
  data during sweeps and builds (a title-change proposal cites the actual GSC
  CTR series it read; a reclamation card cites the actual backlink rows). The
  integration layer is what separates "the agent devised a task from evidence"
  from "the agent wrote plausible fiction."
- **Freshness requirements per use:** Decide may use day-old data; Attribute
  must respect the finalization windows ([doc 02](02-signal-contract.md)
  distortions table); Act's verifier re-queries rather than trusting the
  card's snapshot when the data is load-bearing.
- **Cost attribution:** metered calls made *for* a change bill to that
  change-id; sweep calls bill to `os-overhead`. The monthly integration
  envelope (target: **≤ low tens of dollars/mo** for the data plane at current
  scale; inference dominates everything else) is an asset-#0 budget with the
  same fail-closed treatment as inference.
- **Setup state is tracked in the Tower** (asset detail → integrations tile):
  `live | degraded | needs-setup | skipped | not-applicable` per asset per
  integration (`skipped` = relevant but operator-declined for now, reason
  required; `not-applicable` = the catalog says it never applies to this
  asset). Release claims reference these states instead of vibes. Bing AI
  Performance ingestion is an operator-export lane because the documented API
  does not expose that report.

  **Clarity's two secret shapes.** `CLARITY_TOKENS` (asset → project token) is
  the shape `.dev.secrets.example.json` advertises and the only one that can
  express the portfolio. `CLARITY_PROJECT_API_TOKEN`, a flat string bound to
  one site, is a documented fallback. The collector and `scripts/creds-check.mjs`
  apply the **same** precedence: the map wins wherever both name an asset, so
  `pnpm creds:check --lane clarity` recognizes either shape (the probe is
  explicit-only because it burns 1 of the project's 10 daily calls). Migrating
  the secret to the map is a rename, not a rewrite.

  **Connecting it.** Clarity connects in the
  Integrations connect panel with one row per site: a token pasted on a site's
  row is saved at once (`PUT /api/integrations/clarity/site-token`, merged into
  `CLARITY_TOKENS` inside the ingest by `workers/ingest/src/site-tokens.ts`, so
  one paste never replaces another site's token), and the row wears the site's
  status. There is still no free call to prove a token, so the first export is
  an explicit **Run now · 1 of 10** — the 04:30 job's own step (`collectNow` on
  the `clarity` job), for the sites holding a token and calls to spare, each
  spending one of that site's ten daily calls.

## Credential naming — the `ASSET_TOKEN` convention

**The scheme, in one sentence.** Every asset holds ONE secret named
`ASSET_TOKEN` — it gates that asset's metrics/self-report endpoint and
authenticates that asset's pushes to the ingest Worker — and the ingest Worker
holds ONE map, `ASSET_TOKENS` `{ "<asset-id>": "<token>" }`, which it checks
inbound pushes against and presents as the bearer on outbound pulls. **No other
credential names exist in the asset ↔ hub relationship.** A third-party provider
credential (GA4, Bing, Clarity, DataForSEO) is a different thing entirely and
keeps its own slot; this section governs only the tokens the OS and its own
properties use on each other.

**One token per asset covering *both* directions is deliberate**, not an
oversight. The accepted tradeoff is stated
plainly: a leaked `ASSET_TOKEN` lets the holder forge that asset's pulses as
well as read its counts-grade metrics. That is priced in — the blast radius is
one property's counts and one property's ledger of daily numbers, both
re-derivable from the property itself, and the flags a forged pulse could raise
are visible to the operator on the Wall. Re-splitting the directions to shrink
that radius would reintroduce exactly the second map this scheme deleted, with
two secrets per asset that must be rotated in lockstep and drift silently when
they are not. **If you are about to propose a separate pull credential, you are
proposing `PULL_TOKENS` again — read this paragraph first.**

**Retired names.** Greps and old memories should resolve here, not to a live
credential:

| Retired name | Was | Now |
|---|---|---|
| `PULL_TOKENS` (ingest Worker) | a second per-asset map holding the outbound scrape bearers | deleted — `ASSET_TOKENS` serves both directions |
| `METRICS_SCRAPE_TOKEN` (one asset) | the per-asset secret gating `GET /api/internal/metrics` | renamed to that asset's `ASSET_TOKEN` |
| `ADMIN_TOKEN` (another asset), and the copy of it the OS kept under its own name | the secret gating `GET /api/admin/overview`, lent to the OS so a cron could read it | renamed to that asset's `ASSET_TOKEN`; the OS's copy is gone (`scripts/pulse-relay.mjs` reads that asset's `ASSET_TOKENS` entry for both hops) |

**Onboarding a new asset — three steps.**

1. **Mint** a strong `ASSET_TOKEN` on the asset's own worker
   (`openssl rand -hex 32`, then `wrangler secret put ASSET_TOKEN`), and gate its
   self-report endpoint on it.
2. **Register** the same value in the hub's one map: add the `"<asset-id>":
   "<token>"` entry to `ASSET_TOKENS` (`.dev.secrets.json` locally,
   `wrangler secret put ASSET_TOKENS` on a deployed ingest).
3. **Prove** it with a real call: `pnpm creds:check --lane pull` for the pull
   direction, and — if the asset pushes — one `POST /api/pulse` that returns
   `201`. A checkmark is not proof; the probe prints the counters the endpoint
   actually returned.

**Rotation is the same three steps with new values**, in that order: the asset's
secret first, the map second, the probe third. Between steps 1 and 2 that
asset's lane fails closed with `asset-pull-failed` and auto-resolves on the next
successful pull — no other property is affected.

**Worked example — a pull-only asset.** The asset has no push cron of its
own; the OS reads its envelope from `GET /api/admin/overview` on the nightly
pull. `scripts/pulse-relay.mjs` (`pnpm pulse:relay`) does that same read by hand and
then forwards the envelope through `POST /api/pulse` — so it presents
`ASSET_TOKENS["example.org"]` on **both** hops, outbound to the asset and inbound to
ingest, and one entry satisfies both. The asset's `ASSET_TOKEN` is meanwhile
pre-documented in its `wrangler.jsonc` as the future push credential, which is
the whole point of the convention: the token an asset already has for being read
is the token it will present when it starts pushing. Nothing is minted, renamed,
or added to the map on that day.

**Where this is implemented.** Mechanics live in
[`workers/ingest/README.md`](../workers/ingest/README.md) — the pulse Auth model
and the pull's `Auth — env.ASSET_TOKENS` section — which point back here for the
rationale rather than restating it. `scripts/creds-check.mjs` names this section
in its fix messages when a property rejects the OS's bearer.

## Central Google signal collector

What the 15-minute GA4 and GSC lane collects is the
[signal contract](02-signal-contract.md#central-signals); how it is built
(the account map, token reuse, provisional days, append-only runs) is
[the ingest README](../workers/ingest/README.md#google-signals-ga4--gsc).

**What it costs.** One GA4 and one GSC request per property every 15 minutes,
96 a day per provider, whatever the date range: the 97-day window adds no
requests. That is far below GSC's 1,200 queries/min/site and GA4's
200,000 tokens/day and 40,000/hour per property (most of these requests cost
fewer than ten tokens). Every request asks GA4 for its quota state, so spend is
measured rather than inferred
([GA4 quota](../workers/ingest/README.md#ga4-quota--what-the-heavy-lanes-are-spending)).

**How it fails.** The Tower never calls Google; it reads the latest run for
source health and the latest successful values for the charts, so a failed
pull turns the source red while the last-good chart stays. GSC headlines the
latest completed day, so a partial current day cannot masquerade as a
collapse. A permission-denied
attempt before a property's grant stays in the append-only history; the latest
success drives health. A credential-label rename is prospective: rows under the
old label stay as historical evidence.

### GA4 realtime read path

The live visitor glance is a display read, never a ledger or analysis dataset,
and the one Google lane whose cost is set by a screen's poll rate rather than a
schedule. One
realtime request costs a property about 46–49 tokens; polled every 30 seconds
by a Wall left on all day, that is roughly two thirds of the 200k-token daily
realtime budget. So every open display shares **one reading a minute** (the two
realtime requests behind it, both minute windows and the Wall's per-minute
pulse), the today-by-hour Core read is refreshed every 15 minutes, hidden tabs
stop polling, and refused requests enter a shared cooldown. Any future cadence
or multi-display expansion must be justified against the token use GA4 reports
back, not a request count. How it is built is
[the ingest README](../workers/ingest/README.md#ga4-realtime-rpc).

**How it fails.** A valid empty report is zero; a failed or malformed one is an
explicit unavailable state with null values, never a false zero. The Tower keeps
the last good snapshot during a failed poll and labels it *Reconnecting*.

## Daily provider analysis archive

Which GSC, GA4 and Bing Webmaster report families the 12:15 UTC archive keeps,
and what each may be used to conclude, is the
[signal contract](02-signal-contract.md#central-signals); how the lane is built
(revision window, probe mode, weekly families, content-hash dedupe) is
[the ingest README](../workers/ingest/README.md#analysis-grade-provider-signal-dumps);
the commands that collect and read it back are in
[`scripts/README.md`](../scripts/README.md); what a property repo may conclude
from the panel files is [doc 20](20-signal-panels.md).

**What it costs.** Every call is free; the limits are request and row counts:

- **GSC:** 40 base requests a day per property (ten families × four revision
  dates), plus the search-appearance expansion and pagination. Discover runs in
  probe mode, so a property Google never shows in Discover costs one request a
  day rather than four.
- **GA4:** 33 base requests a day per property (eight daily families × four
  dates, plus one rolling 28-day aggregate), plus pagination; `js-errors` runs
  in probe mode too, so a property whose pages never throw costs one request a
  day for it. The archive keeps each collection's quota beside the pages, never
  inside the hashed bytes, and a bucket under 20% raises `ga4-quota-pressure`
  before the failures start.
- **Bing Webmaster:** one shared site-list request, then four requests per
  verified property a day, six on the property's own seventh day, because the
  top-query and top-page reports are weekly snapshots.
- **Ceilings:** 8 MiB per provider response, 32 MiB per archive, 50k rows per
  GSC report/day and 250k per GA4 report/day. A capped report is stored as
  `provider_truncated=1`, never described as complete. The ceilings follow
  Google's
  [Search Analytics extraction guidance](https://developers.google.com/webmaster-tools/v1/how-tos/all-your-data)
  and the [GA4 Data API pagination contract](https://developers.google.com/analytics/devguides/reporting/data/v1/basics).

**One operator step.** The GA4 `js-errors` family reads event parameters, which
answer only after an operator registers them as custom dimensions in GA4 admin
and are never backfilled. Registration is operator work (the analytics pipeline
is operator-only per [AGENTS.md](../AGENTS.md#hard-invariants)), recorded in
[`config/ga4-custom-dimensions.json`](../config/ga4-custom-dimensions.json);
until then the family is skipped or reads `ga4_custom_dimension_unregistered`
([details](../workers/ingest/README.md#ga4-event-parameters-need-operator-registration)).

**How it fails.** Each family fails on its own manifest row; the Tower rolls the
Bing lane up across its families, so a weekly family that was not due never
reddens it. A refresh of the local panel files makes **zero** provider calls: it
materializes archives the crons already bought.

## Microsoft Clarity export

`workers/ingest/src/clarity-dumps.ts` runs at **04:30 UTC**, last in the nightly
chain because it depends on nothing the earlier slots write. It is the
portfolio's hardest-capped provider — **10 calls per project per DAY**, trailing
72 hours only, ≤3 dimensions, 1,000 rows and no pagination — and every design
choice is that cap:

- **One call per property per day**, one dimension (`URL`), archived verbatim to
  R2 under one `archive_runs` row (`integration = 'clarity'`, `report =
  'url-3d'`). Analysis re-reads the stored object; re-reading
  must never cost one of the ten. A second dimension split is a second call and
  therefore a separate budget decision, not a free addition.
- **A property with no token is skipped** — no call, no manifest row, no error.
  The run log counts them as `skippedNoToken` so an all-skipped run cannot read
  as a clean run. This is the same rule the SERP panel applies to a property
  with no configured queries: absence of config is not a failed collection.
- **Failures split by the operator action they need**:
  `clarity_token_rejected` (401/403), `clarity_daily_cap_reached` (402/429 — the
  ten are spent), `clarity_invalid_response` (the call was spent and answered
  with nothing recognizable — a failed observation, never a property with no
  behavior), `clarity_http_<status>` otherwise.
- **A block on the 1,000-row cap is `provider_truncated`.** There is no
  pagination past it, so the number is a floor.

The flattened family is `clarity-url-3d.csv`, written **long** — one row per
(metric, URL) — because the blocks genuinely do not share a schema: `Traffic`
counts sessions and bots, `EngagementTime` reports seconds, `ScrollDepth` a
single average. `Traffic` also carries a null URL for its unattributed
aggregate, which stays empty rather than becoming a URL of `""`. Sessions are
sampled and `clarity.ms` is adblock-DNS-listed (undercounts ~15–25%), so these
are behavior **rankings**, never population counts — the caveat rides on
`summary.json`.

**The manifests are the lane's health.** The
Tower reads each asset's newest `clarity` manifest the way it reads DataForSEO's
and PostHog's (`apps/tower/worker/integration-evidence.ts`): a success inside two
days is Working, a failed export (a rejected token, the ten calls spent, an empty
answer) or one older than two days is degraded with the stored reason, and no
manifest at all is not set up. That verdict drives the Clarity mark on the
source strip (Wall, Home, asset header), the integrations matrix and the asset's
Sources tab, so it agrees with the ingest's own health read on `/health`. A
lane declared `skipped` or `not-applicable` keeps that decision. An asset that
moved to another behavior source should be declared `skipped` and lose its
token, so the 04:30 export stops spending a call on it; the Tower does not guess
that from the calendar.

## PostHog

*Product analytics archive. Collector: `workers/ingest/src/posthog-dumps.ts`.
Archive contract: `packages/contract/src/posthog.ts`.*

Search data says who arrives. PostHog says what they do once they are on the
page: which steps of a journey they finish, which errors they hit, where they
rage-click, and how fast the page is on their own device.

**What runs, and when.** A daily run at **12:30 UTC** (`30 12 * * *`). It
starts after the 12:15 Google/Bing archives and before the 13:10 local summary
rebuild. For each launched asset that has both a key and a saved region and
project, the run reads the project's timezone. It then runs six queries, one at
a time, each ending on the last complete day in that timezone:

| Family (report) | Window | One row is | Bound |
|---|---|---|---|
| `web-daily` | trailing 28 days | one day: pageviews, unique people that day, sessions | 28 rows |
| `events` | trailing 14 days | one event name: count, unique people, first and last day seen | top 500 by count |
| `exceptions` | trailing 14 days | one error type + message (first 200 characters): count, people, sessions, most in one session, whether any stack frame names a source file, top page, top browser | top 100 by count |
| `rageclicks` | trailing 14 days | one page + element (tag, text, name-or-id attribute): clicks, people, desktop/mobile/tablet clicks, people who viewed that page | top 100 by people |
| `web-vitals` | trailing 14 days | one page × device × OS: 75th-percentile LCP, INP, CLS, FCP and the measurement count | top 20 pages by measurements, all their segments, at most 300 rows |
| `funnels` | trailing 7 days | one step of a declared funnel: people who reached it in order within the window | the declared steps |

**Window grain, not day grain.** Unique people and percentiles cannot be
added across days, so a 14-day total built from daily rows would be wrong. So `events`, `exceptions`, `rageclicks`, `web-vitals` and
`funnels` are one row per item over the whole window. Only `web-daily` has one
row per day, and its `people` is unique within that day. The archive body names
its own window (`window.start`/`window.end`, inclusive, in the project's
timezone), so a reader never has to assume one.

**Where it lands.** Each family is saved as one R2 object per asset and window
end, through the ordinary signal-dump path. Every attempt adds one report run
(`noticeos.archive_runs`: `integration = 'posthog'`, `report` = family,
`report_date` = window end). The object is the
standard envelope with one page. That page's `response` is the contract body,
checked against its zod schema before anything is stored. The body's own
`collectedAt` is left out of the content hash, so re-reading a settled window
is recorded as `unchanged`.

**Read-only, bounded, budget-aware.** The collector calls exactly two
endpoints:

- `GET /api/projects/{id}/` reads the project's timezone.
- `POST /api/projects/{id}/query/` sends one `HogQLQuery`.

Both use `Authorization: Bearer <key>`. Every query:

- aggregates inside PostHog;
- filters on `timestamp` to its window;
- ends in an explicit `LIMIT` of the bound plus one (the extra row is how
  truncation is detected; it is then dropped and the archive marked
  `truncated`);
- never uses `OFFSET`, which PostHog refuses for personal keys.

PostHog allows 3 concurrent queries per project and an hourly bytes-read
budget. Families therefore run one after another, and
`X-PostHog-Query-Budget-Remaining-Bytes` is read on every answer. A **429 stops
the whole run.** The refused family gets an error row:
`posthog_query_budget_exceeded` for the budget, `posthog_rate_limit` for the
request rate. Every family not yet asked is listed as skipped on the completion
line, with no request made and no row written.

**One run per asset at a time.** Every run takes the asset's lease before its
first PostHog request: the daily run, the runner's `runScheduled` and
`signals:collect` alike. The lease is one `integration_leases` row,
`provider = 'posthog:<asset>'`, so no migration is involved. It is given back
when the run ends, however it ends. A run that crashed leaves it behind for at
most `POSTHOG_LEASE_MS` (30 minutes), more than four times the longest possible
run. A run that finds the asset held asks PostHog nothing for it. On demand
that is `409 collection_in_flight`, naming when the other run started and when
the lease runs out. The daily run skips that asset with the reason `in-flight`
and carries on with the others.

**Skipped, with the reason named.** In each of these cases there is no call and
no row:

- no key and no project;
- a project saved but no key (`no-key`);
- a key but no saved region or project (`mapping-missing`);
- a saved region or project that is not valid (`mapping-invalid`);
- no funnels declared (only the funnels family is skipped);
- another run already collecting that asset (`in-flight`, above).

**Failures.** Each failure's code says what to fix:

- A key PostHog refuses (401 or 403) is `posthog_access_denied`. It is written
  for every family that was due and never crashes the run.
- A project that is not in that region is `posthog_mapping_project_not_found`.
- An answer whose columns or values do not match the query is
  `posthog_invalid_response`.
- An answer this machine could not save (a Postgres or R2 failure while archiving
  it) is `local_store_failed`, on every archive lane, not just PostHog. The Integrations page shows it as NoticeOS's fault, not the
  provider's. PostHog's key verdict ignores it, and it is never asked again
  daily: the provider already answered.

**An offline night.** A PostHog call that never came back
asks the OS's egress gate first. When this machine is what is offline, the
window writes no row and is named on the one `os-egress-down` alert instead.
A window end the alert names, or whose latest attempt failed at the network
(`posthog_request_failed`, `posthog_timeout`), is asked again by the next daily
run: up to six a run per asset, oldest first. A refused key (401/403) is not
asked again daily. Details:
[workers/ingest/README.md](../workers/ingest/README.md).

**A "not now" from PostHog.** A window PostHog answered with
a 5xx, a malformed answer or a 429 is asked once more by the next daily run,
within the same six and order. The same kind of answer twice for one window is
PostHog's settled answer and stays on the Integrations page. A 429 still stops
the whole run. The windows it never asked, on this asset and every asset after
it, are asked by the next run too: the 429's own row names the stopped run, so
no other record is written.

**Configuration: everything the operator sets, and where.**

| Setting | Where | Notes |
|---|---|---|
| Key (`POSTHOG_API_KEY`: one personal API key for the account) | `/integrations`, the connect panel | Create the key under PostHog → account settings → Personal API keys, with read access to Project, Insight and Query. Connect shows it to the US and EU clouds at once and keeps it only where it is accepted; that cloud is the region. An install that connected a key per site before (`POSTHOG_KEYS`: asset → key) keeps collecting with it — a site with its own key uses it, every other site the account key; nothing asks for a per-site key any more. The env bindings of the same names are the legacy fallback. |
| `host` (`us` or `eu`) and `projectId` (digits) | Discovered: the connect panel lists the region's projects, matched to sites by the domain each project records (its app URLs, then its recording domains, then a name that is a domain), and Start saves them on the site's Data sources entry | Standard mapping fields, still editable on the Data sources row. No fallback: a guessed region or project would read another site's data. |
| `funnels` (list of `{ id, name, steps: [{ event, path? }] }`, 2–10 steps each, at most 10 funnels) | Picked up: the project's saved funnel insights, written by Start only where the site's entry holds none | Only funnels whose every step is a named event, optionally on one exact `$pathname`, are picked up — the archive cannot count any other filter as PostHog does. Judged by `posthogFunnelsRefusal`, the same rule the store save runs. |

**When the panel calls PostHog.** Only after Connect is pressed (two
`GET /api/projects/` reads, one per region, at once) and when the panel lists
the account's sites (the project list, then each project's details and saved
insights, at most 20 projects). Every read is bounded at 10 seconds; a refusal
in both regions reads "PostHog refused this key", anything else "PostHog did
not answer", with Try again (`workers/ingest/src/posthog-account.ts`).

**Connection test.** The Test button reads each mapped site's project settings
once (the account key's project list when no site is mapped yet). No query
runs, so none of the hourly budget is spent.

**Running it on demand.**

```sh
pnpm signals:collect -- --asset example.com --families 'posthog-*' [--start 2026-09-08 --end 2026-09-22]
```

Quote `posthog-*` in zsh, or write `posthog`. With `--start`/`--end`, every
family uses that one inclusive window (at most 28 days), so a past manual
reading can be reproduced. A run with a fixed window shares its `report_date`
with the daily run that ends on the same day. Read `window` from the body.
Without a fixed window, the run also asks the earlier windows the asset is
owed, as the daily run does. The body names them in `retried` and counts the
ones left for the next run in `retryNotAsked`.

**Event notes.**

- First-party events reach PostHog by name only. A missing property is a
  privacy choice, not missing data.
- Events behind consent arrive only after consent, so they are a floor.
- Events whose `$lib` is the site's own worker (e.g. `example-worker`) are server-side and use different ids.
- `people` is `uniq(person_id)`, PostHog's own unique-person count. A manual
  reading that counts `distinct_id` instead differs slightly wherever PostHog
  has merged a person across ids.
- Web-vitals percentiles use `quantileExact`, so a re-run gives the same
  answer. PostHog's own dashboards use an approximate percentile.

**Checklist, filled.**

- Purpose: product behaviour.
- Consuming stages: Sense and Decide.
- Auth: one read-only personal API key for the account in the credential
  store (doc 06); an older per-site key map still collects.
- Cost: none per query. The only limit is PostHog's hourly budget.
- Quota and distortions: above, plus adblock undercount and consent floors.
- Degradation: keep the last archive, mark the source degraded, name the
  refused family, and never fill a missing row with zero.
- Tower: collector-backed. The Sources tab shows working or degraded from real
  runs.

## Weekly DataForSEO search-intelligence archive

`workers/ingest/src/dataforseo-dumps.ts` runs Mondays at 12:45 UTC for each
non-OS asset whose lifecycle is neither `pre-launch` nor `retired`. The
canonical domain comes from Postgres. Each property gets five independently durable
domain-driven report families, plus a sixth where an operator has chosen head
terms to watch:

- `ranked-keywords`: the top 200 current Google results in the site's saved market
  (United States · English by default), ordered by
  estimated search volume, with rank, URL, demand, CPC, difficulty, intent,
  SERP features, estimated visits/cost, rank-change fields, and AIO references;
- `backlinks-summary` and `backlinks-new-lost`: current authority/link stock
  plus DataForSEO's weekly-grouped 90-day movement series;
- `llm-mentions-google` and `llm-mentions-chatgpt`: platform totals and the
  leading source domains from the current target-metrics endpoint;
- `serp-panel` ([doc 08 §S1b](08-seo-geo-signals.md)): one live result page in the site's saved market
  (United States · English by default) per tracked head term **per device**, with the asynchronous AI Overview
  requested, read to depth 20. The panel comes from
  [`config/serp-panel.json`](../config/serp-panel.json) — the one place a
  tracked-query list is written down, capped at 31 per property (what the $0.25
  per-report reserve buys at two devices). A property with **no panel is
  skipped silently**: no call,
  no manifest row, no attempt, because absence of config is not a failed
  collection. The live/advanced endpoint takes one task per request and the
  device is a property of the task, so a panel is (terms × devices) calls landing
  in **one** archive under **one** manifest row — which is why the second device
  needs no migration, no second family and no second review task: `device` rides
  in the archived request body and comes out as a CSV column. A term the
  provider accepts and cannot answer is archived with the others rather than
  discarding the run, and a panel whose every term failed is an error, not an
  empty success.

Responses use the same immutable gzip-JSON R2 envelope and append-only Postgres
manifest as the daily provider archive. Every provider response retains its
exact cost. The manifest also indexes that compact cost so
the scheduler can stop before a call could cross the existing $25/month data
cap; a conservative $0.25 reserve is required before every call. Missing
credentials, budget exhaustion, provider errors, and partial runs are explicit
red/degraded evidence in the same property integration icon. A tracked panel
costs ~$0.004 per term (~$0.08/week for a 20-term panel) and rides the same $0.25
reserve as every other family — the gate has no panel-shaped exception, and a
malformed panel fails that one property with `config_invalid` while every other
property still collects.

The cron is only a wake-up; it is not permission to buy the same snapshot
again. Every family declares a seven-day `cadenceDays` in the collector's
machine-readable report registry, exported as
`DATAFORSEO_REPORT_CADENCE_DAYS`. An automated cron or startup catch-up checks
the newest `success`/`unchanged` manifest for each property and family, skips it
until that cadence is due, logs the skipped family with its next due date, and
writes no pretend attempt. Thus a later successful sweep satisfies a missed
Monday job even when the runner's job record says that original invocation
failed. A failed family remains due. The explicitly scoped operator command is
the deliberate exception: it may force only the named property/families for a
new baseline or repair, while the lane lock still prevents concurrent rebuying.

The analyzer reads locally retained weekly snapshots. Current executive facts
use the newest snapshot; ranking-movement findings compare the newest two;
backlink momentum uses the stored 90-day provider series. When a genuinely due
response matches its prior archive, the collector appends an `unchanged` row
proving the provider was asked while reusing the prior R2 object. Cadence skips
keep the earlier manifest current and write no synthetic row. Analysis therefore
never pays to retrieve historical DataForSEO data again.
Provider search volume, difficulty, estimated traffic/cost, and AI search
volume remain modelled prioritization inputs—not causal ROI, sessions, or
unique people.

The compact property read model publishes up to 16 useful query rows from the
latest ranked-keyword archive, including current organic position, demand,
difficulty, page, AI Overview presence, and provider-returned AI-reference
position. It is available on the first snapshot. A stored previous organic
position and movement appear only for an exact normalized-query/page match in
the preceding snapshot. Where the tracked panel covers one of those queries, the
row also carries the live result page's AI Overview presence and whether it
cited this property — three-state, matching by normalized query. The panel is
**additive**: it contributes no rows of its own, and a query it does not cover
(or one whose overview failed to load) stays **unknown**, which every rule
downstream treats exactly as it treated an untracked query before the panel
existed. The Tower merges this with Google/Bing rows by query
for scanning while preserving the crucial unit boundary: webmaster
`impressions` are observed property exposure; DataForSEO `search_volume` is
modelled demand in the site's saved market (United States · English by default).

A property that reaches the explicit 200-row keyword cap has that family
marked truncated in the manifest rather than implying complete keyword
coverage.

The analysis tool keeps missing rows unknown and emits provider dimensions and
metrics without inventing totals. Its `row_grain` column distinguishes the
search-appearance discovery totals from the filtered page rows; those two
grains must never be summed together.

This archive can ground opportunity discovery, page-extension/deprecation
reviews, and feature-behavior analysis, but it is not causal evidence by itself.
Decisions still join it to deploy/change annotations, the product pulse,
revenue/cost rows, and (where possible) holdouts/cohorts. GSC page/query exports
can omit anonymized or low-volume rows, and GA4 Data API reports are aggregates,
not raw event/session sequences. GA4 BigQuery export remains the later option
for funnels, retention, and user/session paths.

Google's separate
[Search Generative AI report](https://support.google.com/webmasters/answer/16984139)
exposes AI Overview/AI Mode impressions in the Search Console UI, but the
[documented Search Analytics API](https://developers.google.com/webmaster-tools/v1/searchanalytics/query)
has no corresponding report type. Do not label ordinary Web Search rows as
AIO-specific. Until Google adds API access, known assistant referrals come
from GA4, broad AI visibility comes from the weekly DataForSEO Google/ChatGPT
mention snapshots, and exact query-level citation detail comes from the tracked
`serp-panel` above — for the terms on a property's panel, and no others.
Property-wide AIO/AI-Mode impression totals still require an operator-downloaded
Search Console generative export.

### Bing AI Performance boundary

Bing Webmaster Tools' public-preview
[AI Performance report](https://www.bing.com/webmasters/help/ai-performance-9f8e7d6c)
adds citations, cited pages, grounding queries, citation-to-page mappings,
time series, and preview intent/topic/citation-share comparisons across
Microsoft Copilot, Bing AI summaries, and participating partner surfaces. It
can export CSV/Excel from the operator UI.

Those dimensions are absent from the documented
[`IWebmasterApi` method surface](https://learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.iwebmasterapi?view=bing-webmaster-dotnet).
Search Performance impressions can include a chat response, but the standard
API does not identify that subset. NoticeOS therefore keeps AI Performance as
a separate operator-import lane and does not infer AI citations from ordinary
BWT query or traffic rows.

**The import lane.** The parser is pinned to three real exports, not to a
guess: `workers/ingest/src/bing-ai-exports.ts` reads exactly three header rows —
`AIPerformanceOverviewStats` (daily `Date`/`Citations`/`Cited Pages`),
`AISearchQueriesReport` (`Grounding Query`/`Intent`/`Topic`/`Citations`/
`Citation Share`), and `AIPageStatsReport` (`Page`/`Citations`) — and refuses
anything else rather than mapping columns by position. UTF-8 BOM, fully-quoted
fields, `M/D/YYYY 12:00:00 AM` dates, `12.34%` share strings and digits-only
counts are all part of the pinned format; a thousands separator is a refusal,
not a coercion.

The operator's whole job is one command:

```
pnpm bing-ai:import ~/Downloads/example.com_AISearchQueriesReport_8_4_2026.csv
```

`scripts/bing-ai-import.mjs` reads the property and the export date off Bing's
own filename (`<site>_<Report>_<M_D_YYYY>.csv` — the only place two of the three
exports carry a date at all), POSTs the bytes through the loopback ingest door
(`POST /api/bing-ai-export`, operator-authed) and refreshes the property's panel
dir. The archive is the house one — gzip JSON in private R2 with an append-only
`archive_runs` row, integration `bing-webmaster`, reports `ai-overview` /
`ai-queries` / `ai-pages`, `data_state='provider-snapshot'`, `report_date` = the
export date — and it holds the original file byte-identical beside the parse, so
the read can always be redone. Content addressing makes a re-import `unchanged`
rather than a second copy; a later export appends as the next dated snapshot.
The panel contract (grain, and what an absent family means) is
[doc 20 §The `bing-ai` family](20-signal-panels.md#the-bing-ai-family-the-one-nobody-collects).
Dashboard scraping remains outside scope.

## Central Bing Webmaster collector

`workers/ingest/src/bing-signals.ts` runs once on the existing 02:30 UTC
nightly pull tick because Microsoft updates `GetRankAndTrafficStats` daily.
`BING_WEBMASTER_API_KEY` is a user-level credential: one key lists every site
verified under the operator's account. The Worker intersects that list with
launched, non-OS portfolio assets, then calls the traffic endpoint once for
each match.

The provider returns daily clicks and impressions without date-range request
arguments. The Worker retains the actual returned dates inside a rolling
97-day retrieval horizon and appends them through the same change-only signal
store used by Google. The Tower renders at most 90 of those dates and uses up
to seven earlier dates only as calculation context. It does not fill missing
dates or the tail after Bing's latest row: unreported provider dates are
unknown, not zero. The Tower reads Google and Bing separately, aligns them by
calendar date on one zero-based Web Search Clicks scale, colors Bing with the
provider-identity blue token, and lets either line end on its own latest date.
Both retain same-weekday-last-week references. Bing's retention reaches back
well past four weeks; a shorter series is a young property, not a provider
limit. A property moved to `live` with `sense_only=1` participates in the
launched-property collectors without enabling an Act loop.

## Cloudflare D1 backups

Connect **Cloudflare** in **Integrations** with the account ID and an
[account-owned API token](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)
restricted to that account's D1 resources. Use **Account → D1 → Edit**;
Cloudflare documents this scope for its
[D1 REST API setup](https://developers.cloudflare.com/d1/tutorials/import-to-d1-with-rest-api/).
Do not grant DNS, Workers deployment or unrelated account permissions.
The API reference does not publish a narrower accepted-permission list for
[export](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/);
NoticeOS does not promise that a read-only token can export.

Connect and Check read the account's database list. That proves list access,
not export permission. The token uses the existing encrypted workspace store;
it is never returned to the browser. The account connection is separate from
any Cloudflare credential used to host NoticeOS itself.

Choose each D1 database and its portfolio asset in the same connection panel,
then press **Back up selected**. Nothing infers an asset from a database name.
Token replacement preserves selections; changing accounts requires an explicit
selection for the new account. Hosted calls recheck owner membership in both
Workers; demo visitors cannot list provider databases, select targets, export,
or retrieve private SQL.

An export polls the native API with the original continuation bookmark, then
downloads SQL without sending the API token or following redirects. The current
bounds are 100 selected databases, three minutes per export and 4 GiB per SQL
artifact. SQL streams through 8 MiB multipart buffers with a SHA-256 hash into
the existing private object binding, under workspace/account/database/run IDs.
Receipts live in the workspace's provider-coordination row; a transaction checks
the current connection, selection and run lease before publishing completion.
An expired run cannot publish over its successor. A failure keeps the last
complete backup; successful publication retains the current and previous
complete SQL objects. Storage operations with an unknown completion outcome
are not promoted. **Export stored** proves stored bytes, not a restore drill.

Downloads accept only HTTPS Cloudflare R2 storage endpoints. Cloudflare's D1
export reference does not guarantee a download hostname; the first approved
account check must confirm that boundary. Other hosts are refused, not followed.
On standalone installations and the protected Compose backup profile, the
saved targets join the existing **04:00 UTC** backup operation. Its fixed
machine route accepts the installation's bootstrap bearer before store access;
hosted and demo profiles refuse that route. The host reads no provider token
from the encrypted store and needs no asset checkout or Wrangler login.
It verifies receipt identities, SQL bytes and hashes while streaming gzip into
`cloudflare-d1/<account>/<database>/` in the dated set. Each directory carries
`receipt.json` with compressed hashes and a REST import pointer; `backup.json`
records the whole selected set. Changed selection, unknown inventory or any
failed target prevents publication, offsite handoff and retention. The previous
complete set stays intact. Native and legacy exporters covering the same asset
are refused before either runs. Hosted exports remain manual.
No provider is activated by committing this adapter. A real export needs the
owner's approval for the exact account, database and verification scope:
Cloudflare's running export temporarily blocks queries and must be polled
until completion. The API download URL expires after one hour.

## Provider-reported issues and recommendations

These are not interchangeable with traffic anomalies. A provider finding must
be labeled with provider origin, retain the affected URL/site and provider
evidence, and have first-seen/last-seen lifecycle fields so a disappeared issue
auto-resolves without erasing history.

| Provider | What is actually available | Practical NoticeOS lane |
|---|---|---|
| Bing Webmaster | [`GetCrawlIssues`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.iwebmasterapi.getcrawlissues?view=bing-webmaster-dotnet) returns crawl-issue records for a site | Landed in the daily archive. The latest snapshot can produce an executive warning with affected URLs and crawl evidence; promoting it into mutable Needs Attention lifecycle records still requires first-seen/last-seen deduplication |
| Google Search Console | No site-wide Recommendations/Issues feed appears in the [API surface](https://developers.google.com/webmaster-tools/v1/api_reference_index). [URL Inspection](https://developers.google.com/webmaster-tools/v1/urlInspection.index/UrlInspectionResult) returns indexing/fetch/robots/canonical/mobile/rich-result state for a requested URL | Inspect a bounded, evidence-selected priority URL set; never present it as a whole-site health scan |
| Google Analytics 4 | The [Data API](https://developers.google.com/analytics/devguides/reporting/data/v1/basics) reports metrics and the [Admin API](https://developers.google.com/analytics/devguides/config/admin/v1) manages configuration/change history; neither documents a Recommendations/Insights feed | Continue deriving anomalies centrally from finalized reporting data; do not claim GA UI recommendations through the API |

GSC URL Inspection should wait until the OS has an explicit priority-URL
selector and quota budget. GA4 remains an evidence source for OS rules, not a
provider-advice source.

## Adding an integration (the checklist)

Purpose → consuming stage → auth + storage of creds (doc 06) → cost model +
budget line → quota/latency/distortions entry (doc 02 table) → degradation
posture (doc 06 table) → Tower setup-state tile → only then may hypothesis
cards cite it.
