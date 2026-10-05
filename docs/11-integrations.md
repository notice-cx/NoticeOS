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
| **GSC API** | live collector: daily Google-search clicks, impressions, CTR, average position; daily archive: web page/query/country/device, page-level search appearance, image page×query, and Discover page responses | Sense (S2), Attribute | service account; Full-user grant per property; read-only API scope | Free | live total query runs 96/day/site; the archive adds 40 base requests/day/property (ten report families × four dates), search-appearance expansion, and pagination. Search Analytics exposes at most 50k rows/day/search type and does not guarantee every row, so an archive is analysis-grade evidence, not a complete log | retain last good snapshot/archive, record the failed report manifest, suppress dependent flags |
| **GA4 Data API** | live collector: daily active users, sessions, page views, events; on-demand display read: exact distinct users in trailing 30- and 5-minute windows, users per minute over the last 30, plus today-by-hour against the same weekday last week; daily archive: pages/screens, landing pages, acquisition, source/campaign, events, page×event, `js_error` message×source×page, landing-page×source/channel, and an exact rolling 28-day event-user aggregate | Sense, Attribute | service account; Viewer grant per property; read-only API scope | Free tier (separate token quotas per property and request category) | daily-series query runs 96/day/property; open Tower displays share two Realtime requests/property per minute (both minute ranges, and the per-minute rows of the Wall's minute pulse, bead `ro-trai.27`), and one bounded Core hourly request/property per 15 minutes for today plus seven days ago; a display whose cache was emptied (a deploy, eviction, a new day or clock) reads at once instead of waiting out that cadence, at most one extra read per window (bead `ro-trai.40`); hidden tabs stop polling, and refused requests enter a shared cooldown; archive adds 33 base requests/day/property (eight daily families × four revision dates plus one rolling aggregate), plus pagination, and caps each report at 250k rows. Data API is aggregate/modelled reporting, not raw event/session export. **Event parameters** (`customEvent:*`) answer only after an operator registers them as custom dimensions, and are never backfilled. Every lane sends `returnPropertyQuota`, so token spend is measured rather than inferred from request counts | retain last good daily/display snapshot and archive; record a failed durable report manifest; never turn a provider failure or a future hour into zero; today remains visibly incomplete; an unregistered custom dimension is its own manifest state (`ga4_custom_dimension_unregistered`), never an empty success; scheduled collection names an exhausted token budget `ga4_quota_exhausted`; display reads return a safe quota category and next permitted attempt, and a bucket under 20% remaining raises `ga4-quota-pressure` before the failures start |
| **Bing Webmaster Tools API** *(live + archive collectors landed 2026-07-29)* | live: site-level daily clicks/impressions; archive: rank traffic, top queries/pages, crawl stats/issues, and feeds. The separate AI Performance UI report is not exposed by the documented API | Sense (S2 complement), Attribute | user-level API key on one central BWT account; sites verified per property (GSC import supported) | Free | one live request/site/day plus one shared site-list request and four archive requests/verified site/day — six on the day the two weekly families come due. Microsoft publishes no read-quota figure; query/page reports update weekly, are collected weekly, and can trail the wall clock | retain last good live snapshot; record each failed archive family independently; never fill an absent trailing day with zero or relabel undifferentiated impressions as AI citations |
| **MS Clarity data-export API** *(central archive collector landed 2026-07-31; per-asset token map since 2026-09-05)* | session behavior aggregates (rage/dead clicks, quickbacks, script errors, scroll) | Sense (UX signals), hypothesis grounding | API token per project | Free, but **10 calls/project/DAY hard cap**; trailing 72h only; ≤3 dims; 1,000 rows, no pagination (verified 2026-07-04) | one call returns ALL metric blocks per dimension split, so URL + Device = full read in 2 calls; ALWAYS snapshot to store and analyze from disk (example.com: `scripts/clarity-export.mjs` → `_analytics/`); counts only — element detail needs dashboard replays; `clarity.ms` is adblock-DNS-listed (undercounts ~15–25%, rankings hold; can also blackhole the OS's own probes) | optional lane — degrade silently, flag staleness |
| **PostHog query API** *(daily archive collector landed 2026-09-22, [below](#posthog))* | product behaviour: daily visits, event taxonomy, errors, rage clicks, real-visitor page speed (LCP/INP/CLS/FCP p75), declared funnels | Sense (UX and product signals), Decide (hypothesis grounding) | one read-only personal API key for the account (Project, Insight and Query read), connected on `/integrations`; region, projects and saved funnels discovered (bead `ro-ujb9.96.7.8`) | Free per query | 2,400 requests/hour, 240/minute, 3 concurrent queries, a 10-second execution cap and an hourly bytes-read budget per project; six bounded, server-aggregated queries per asset per day, run one at a time | keep the last archive, mark the source degraded, name the refused or skipped family; a 429 stops the run; missing rows are not zeros |
| **DataForSEO** *(weekly archive collector landed 2026-07-30; tracked SERP panel 2026-07-31)* | top ranked keywords with demand/difficulty/CPC/SERP features, backlink stock + 90-day new/lost movement, Google/ChatGPT mention metrics, and live result pages for an operator-chosen head-term panel | Sense (S1/S1b/S3/S4), Decide (opportunity sizing, the AI-Overview gate) | one shared API login/password; launched domains are discovered from Postgres; tracked terms from `config/serp-panel.json` | Metered. The first real four-property run cost **$1.122772** total; the two panels add ~$0.41/week (28 + 23 terms on two devices); each report records exact provider cost | five bounded calls/week/launched property plus one per tracked query **per device**; the site's saved market (United States · English by default), phone and desktop; 200-row ranked-keyword cap, a 31-term panel ceiling and a 20-result panel depth. A $0.25/report reserve makes the existing $25/month portfolio data cap fail closed before a call, and since 2026-09-05 (`ro-qpas`) the provider card renders how much of that cap is left this month, counted from the costs the reports themselves recorded, plus the prepaid account credit as a dated sighting — refreshed since 2026-09-05 (`ro-vu8d.26`) by ONE free `appendix/user_data` read at the end of every sweep that worked, which is metered spend of zero and is never retried | retain the latest stored snapshot, mark the lane degraded, and never interpolate missing rankings, links, AI mentions, or AI-Overview state |
| **Ahrefs** | DR (free tier), site metrics (plan-gated) | Decide (sizing), Attribute (links) | MCP (existing) | Plan-dependent; many endpoints 403 on current plan | treat as best-effort enrichment only | fall back to DataForSEO backlinks |
| **Cloudflare** | Workers/D1/KV/R2/Analytics Engine (infra + pulse floor); GraphQL analytics (edge traffic, crawler hits); **AI Gateway** (budget enforcement, fallbacks); health checks | everything; Act (deploys); doc 06 (caps) | API tokens, scoped per account | Infra ≈ free tier today; AI Gateway free (pays for itself in enforcement) | AE free tier covers pulse volume; GraphQL analytics rate-limited but generous | infra failure = incident, not degradation |
| **GitHub App** | PR create/read, checks, deploy webhooks, file contents | Act, Sense (deploy annotations) | App private key (the crown jewel — doc 06 rotation) | Free | 5k req/hr/installation — ample | Act pauses; Sense keeps running |
| **Model providers (via AI Gateway)** | builder/verifier/judge inference | Act, Decide sweeps | keys behind the gateway only | Metered per token; **the dominant OS cost** | per-run/day/month caps, velocity breaker (doc 06) | fallback chain → pause Act |
| **Ad networks** | revenue reporting → shared financial reads | Sense (revenue lane) | Mediavine daily collector; CSV for other providers | Free reporting | provider estimates stay estimated until payment reconciliation | keep saved history; missing reports are not zero |
| **Affiliate networks** (CJ live, Amazon off) | commissions, EPC → ledger; **CJ product feed** (GraphQL `ads.api.cj.com`: live prices/sale prices/images/tracked deep links) + link-search promos → placement data | Sense (revenue lane), Act (placement refresh) | CJ: PAT + CID (developer portal); transaction reports filter by SID = per-placement conversion attribution | Free | CJ LIVE on one site since 2026-07-04 (Magnifique): the crystallized-tool exemplar is `gen:magnifique` — feed → committed catalog with honesty gates (14-day price staleness ⇒ card self-degrades; no promo without a real end date); Amazon reporting degraded + 60-day lag, program disabled | wide intervals; book on payment |
| **Uptime** *(the OS's own hourly check since 2026-09-23, bead `ro-ujb9.165`, [brief](briefs/2026-09-23-uptime.md))* | up/down per site, with when it was last checked | Sense, incident detection | none — no account and no connect step: the ingest GETs each site's home page itself (`runUptimeChecks`, `workers/ingest/src/hygiene.ts`) on the hourly tick, reusing the nightly served-layer check and its `hygiene_checks` reading | Free | one request per site per hour; a site read in the last 30 minutes is skipped | a home page that does not answer twice in a row, 45 seconds apart, files `hygiene-home-unreachable` at error (one failed try files nothing and the row reads Up · 1 failed try, bead `ro-ujb9.180`); an OS that cannot reach the network accuses no site (the egress gate) and the row reads Not checked |
| **Discord webhooks** | operator notifications — since 2026-09-05 (`ro-vu8d.23`) a **new open error alert** and a **data source that stops working**, and nothing else; the list is declared once in `packages/contract` (`NOTIFIED_CONDITIONS`) so the card and the sender cannot drift | ingest → operator | one webhook url, connected on `/integrations` ([below](#how-to-connect-one-landed-2026-09-05-epic-ro-vu8d)) | Free | keep channels few — alert fatigue is a documented failure mode, which is why the list is two lines rather than a digest | fall back to email |
| **Web search API** | grounded scouting (lanes 1–4, [doc 13](13-opportunity-scouting.md)) | Scout sweeps | API key | Metered, cheap per query | budgeted per lane; results cached to the store | lane skips cycle |
| **Deep-research runs** | bounded multi-source investigations for high-stakes scout finds | Scout (lanes 1/3/5) | via model gateway | **The expensive lane** — per-run cap mandatory | few runs/month; each must name its target find | skip; never substitute a shallow guess |
| **Google Trends** | demand timing/seasonality for scout finds | Scout, Decide sizing | public/unofficial API | Free | rate-limited; directional only | omit trend dimension |
| **Wayback / End-of-Term archives** | orphaned-demand mining (a playbook proven on two properties) | Scout lane 1 | public APIs | Free | slow; batch politely | lane pauses |
| **Update/volatility trackers** | Google update calendar + SERP volatility for doc-02 `external` annotations + doc-03 confound hygiene | Sense, Attribute, Scout lane 2 | scrape/RSS | Free | secondary sources; corroborate before annotating | manual entry fallback |
| **Marketplace feeds** (Flippa-class) | acquisition watch against portfolio buy criteria | Scout lane 5 (quarterly) | RSS/alerts | Free tier | low cadence by design | dormant lane |
| **HN (Algolia API)** | radar: tech/AI/industry signal, front-page + keyword queries | Scout radar (collect tier) | public API | Free | generous; poll daily, not live | radar gap, note it |
| **News/RSS aggregation** | radar: curated industry + AI-announcement feeds | Scout radar (collect tier) | RSS | Free | curate hard — feed count is a noise budget | prune dead feeds |
| **shadcn MCP + skills** | component registry browse/install + composition knowledge for Tower UI work ([doc 14](14-ui-standards.md)) | Act (UI builds) | MCP server | Free | registry-driven — agents compose, don't hand-roll | build from in-repo components only |

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
   keeps the login (bead `ro-ujb9.96.7.6`); a refused login is never stored.
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

## How to connect one (landed 2026-09-05, epic `ro-vu8d`)

Everything in the catalog above used to be connected by editing two gitignored
files and restarting the OS. Since 2026-09-05 every provider with a portfolio
credential is connected **in the product**, on the Tower's `/integrations`
page — `/health` remains the observability view of what each data source is
producing.

**What *Test connection* costs is declared, not assumed.** Five of the probes
below are the free read-only call a Test button is taken to be, and the card
says nothing about them. Two are not, and the card prints the sentence in the
last column **before** the press: Discord's posts a real message into the
operator's channel, and the OAuth app's calls nobody at all. A button that
surprises somebody once is a button they stop pressing.

| Provider (id) | Fields | Probe the *Test connection* button makes |
|---|---|---|
| Mediavine (`mediavine`) | publisher email and password | permitted-site discovery; session reuse and a 15-minute cache/cooldown are shared with collection |
| Google (`google`) | **either** a sign-in (`GOOGLE_OAUTH_REFRESH_TOKEN`, written by the flow — see [Connecting Google](#connecting-google)) **or** `GOOGLE_SIGNAL_ACCOUNTS`, the account-label → `{service_account_b64, properties}` map | gets a read-only token, then Search Console `sites.list` and one GA4 `properties/{id}/metadata` read. Identical for both ways in; only the refusal differs, because "add the robot as a Full user" and "check which account you signed in with" are different instructions. No day of data is requested and no reporting token is spent |
| Google OAuth app (`google-oauth-app`) | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | a shape check, deliberately: no free Google call proves a client id and secret without dragging a person through a consent screen, so the honest verdict is *looks right, now sign in*. **Not a card of its own** — the Google card asks for it in place |
| Bing Webmaster (`bing-webmaster`) | `BING_WEBMASTER_API_KEY` | `GetUserSites` — the same call the collector opens with |
| DataForSEO (`dataforseo`) | `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` | `appendix/user_data`; free, and it reports the credit left before the metered lane stops — recorded with the instant it was seen (`ro-qpas`) so the card shows it dated without pressing anything; the budget line beside it shows the monthly cap |
| Calendar feeds (`calendar`) | `CALENDAR_FEEDS` — name → secret ICS url | one bounded GET per feed, reported **by label**; the url is the credential and never appears in a verdict |
| Discord (`discord`) | `DISCORD_WEBHOOK_URL` — the whole `https://discord.com/api/webhooks/…` address | **posts one labelled message to the channel, and the card says so before the press** (bead `ro-vu8d.18`). Discord does offer a read of the webhook object and it would prove the wrong thing: the catalog row above defines this data source as live when the OS *can deliver a notification* — "not merely that a webhook URL exists" — and a webhook whose channel the operator lost still answers a read. The url is the credential and never appears in a verdict, and Discord's own error body is never reflected back |

### What the notification channel actually carries *(2026-09-05, bead `ro-vu8d.23`)*

Until this, the OS held a Discord credential and had no SENDER: the only thing
that ever wrote to the webhook was the connection test above. The catalog row
had promised a digest, approvals-needed and kill-switch confirmations since
2026-07-06, and every one of them reached the operator only if they opened the
Tower.

- **Two conditions, declared once.** `NOTIFIED_CONDITIONS` in
  `packages/contract` is what the notifier decides from AND what the card prints
  before you connect it, so the promise and the delivery are one list: a **new
  open error alert** (error only — `warn` is what the desk is for, and a
  notifier that forwarded every alert would be `/alerts` again, at 3am), and a
  **data source that turns Failing**, read through the same `connectionState`
  the card's own chip is derived from. Nothing else. Alert fatigue is this
  channel's documented failure mode, and the shortest honest list is the design.
- **Once per condition, and that needs a memory.** The lane runs hourly at
  `:05`, so a notifier with no record of what it had already said would re-send
  every open condition every hour. `notifications` (db/0031) is that record, and
  it is written **only on a successful delivery** — a failed send is retried on
  the next tick, and the Alerts row's *notified* mark therefore means a message
  actually landed rather than that one was attempted.
- **A real delivery stamps the credential.** The card's verdict now comes from
  the channel doing its job, not only from a Test press — the same rule the
  04:30 Clarity export follows.
- **Where db/0031 is not applied, nothing is sent, and the card says so.**
  Migrations are operator-only ([AGENTS.md](../AGENTS.md)), so this ships before
  the table exists on any install. Silence with a sentence and the apply command
  is the honest degradation; sending without being able to record would be the
  fatigue this whole design avoids. Applying it is task `ro-klvq`.
- **A horizon, so the first tick is not a replay.** Only conditions that arose
  in the last 24 hours qualify, and one message carries at most ten lines with a
  count of the rest — doc 15 flow E's own rule for this channel, that if more
  than ten things need attention the volume is itself the finding.

**Clarity is the one `per-asset` credential** (bead `ro-vu8d.9`), and both of
the things that used to keep it out are answered rather than worked around:

- **One row, one map.** Clarity issues a data-export token per project, so the
  credential is an `asset-map` field — `asset id → that asset's token` — inside
  the single `credentials` row keyed on the provider. A compound
  `(provider, asset)` key would have been a migration, and migrations are
  operator-only; what *per-asset* actually changes is the FORM (one input per
  asset) and the CARD (which assets have a key), not the store.
- **The older single-project binding is one entry of that map** *(2026-09-05,
  bead `ro-vu8d.24`)*. `CLARITY_PROJECT_API_TOKEN` — the shape this repo's
  install was configured with first — is **kept, not retired**, and it is
  declared on the map field (`legacyAssetBinding` in `packages/contract`) rather
  than read separately by the collector. One declaration, three readers: the
  card counts it as the first Clarity asset's key so an install running on it stops
  reading *Not connected* over a data source that is collecting, **Import from
  this machine** moves it into the store as that one map entry, and the nightly
  export still records `CLARITY_PROJECT_API_TOKEN` on the manifest row it
  answered for, so *which slot held this token* stays a fact you read. **The map
  wins wherever both name the asset**, and there is deliberately **no form input
  for it**: the product teaches the map, because a field offering "the token,
  but only for one asset" would teach the shape it replaced.
- **Its cap is now a number on the card, not a sentence** *(2026-09-05, bead
  `ro-vu8d.25`)*, and so is DataForSEO's — see below.
  Doc 15 flow C step 3's *"Clarity: 7/10 calls left today"* is
  rendered per asset, and it costs nothing to read: the export writes one
  manifest row per call it makes, so calls-spent-today is a COUNT of
  `signal_dump_runs` rows this OS wrote — never a provider call, which on a
  ten-a-day cap would be the meter spending what it measures. It counts ROWS
  rather than `request_count`, because a failed call archives no pages and
  summing that column would report a rejected token as budget still available.
  Days are UTC, like the metered spend figure beside it: the OS cannot know
  Clarity's own reset clock, and the card says which calendar it counted in
  rather than implying it does.
- **Its test calls nobody, and says so.** Ten calls per project per day and no
  free metadata endpoint means the cheapest available probe would spend a tenth
  of one asset's daily budget. So *Test connection* reports which assets hold a
  token, states plainly that it did not call Clarity, and — because it proved
  nothing — leaves `last_ok_at` alone. **The 04:30 export is the proof**: that
  run stamps the credential, so the verdict on the card comes from a real
  collection rather than from a button.

**DataForSEO's card says how much of the month's data cap is left** *(2026-09-05,
bead `ro-qpas`)*, on the same budget line Clarity's card gained the same day.
It is the second and last provider with a ceiling this OS can count, and the two
ceilings are different in kind, which is what the design turns on:

- **The bar is the CAP, not the account.** DataForSEO is prepaid, and the two
  numbers are different in kind: the cap is a ceiling this OS enforces and can
  count, the credit is the vendor's own figure. The bar draws the one that
  actually decides whether next Monday's sweep runs — month-to-date spend
  against `monthly_caps.data_usd`, the $25 portfolio reserve that **fails
  closed** before a call.
- **The credit sits beside it as a dated sighting.** It is recorded from the free
  `appendix/user_data` read — the one behind *Test connection*, and, since
  2026-09-05 (`ro-vu8d.26`), the SAME ONE CALL the weekly sweep makes at the end
  of a run that worked. That second half is what stops the figure from ageing for
  months: `ro-qpas` had the sweep watch the answers it was already buying for a
  `money` object, and the report endpoints never carry one, so nothing was ever
  stamped and only a button moved the number. Asking the free endpoint once is
  the cheapest honest fix — no money, no metered quota, outside the cap guard
  because there is nothing to cap, and **never retried**, since a courtesy read
  has nothing to lose. A sweep that failed or had nothing due asks nothing at
  all, and a read that is refused or times out leaves the run green and the card
  on its last sighting with its age. The run's `dataforseo_dumps_complete` line
  says `refreshed` or `not refreshed` — the word, never the figure. The sighting
  is stored as a non-secret fact in `credentials.fields_json`
  beside the ciphertext (`CredentialMetadata.balance`, the same public half the
  expiry uses, so no migration, no re-seal and no `CREDENTIALS_KEY`). The card
  reads *Account credit $18.72 · seen 2h ago*, with the exact instant on hover.
  **The amount and its age are one sentence**, because a stale balance drawn as
  a live one is the failure this task existed to prevent; a sighting whose
  stored instant will not parse is dropped rather than shown undated. **And a
  sighting older than fourteen days — two missed weekly refreshes — is said to
  be too old to act on** (`ro-vu8d.27`): the free refresh is silent when it is
  refused, so the age turns warn-toned and says so instead of leaving the
  operator to do arithmetic on a timestamp; the amount stays, dimmed. It is
  **not drawn as a bar** — a balance has no ceiling to draw against — and an
  account nobody has read yet says so in words rather than leaving the line out,
  which would read as an account with no credit on it. **A rotation drops it**:
  what was just pasted may name a different account, so the figure goes and the
  next answer replaces it. One writer (`setCredentialBalance`), one caller-shared
  account read and one wire parse (`workers/ingest/src/dataforseo-balance.ts`),
  one reader (`credentialBalance` in `packages/contract`).
- **One representation, no second sum — and the same sum the gate enforces.**
  The card reads `loadDataForSeoSpend`, which is the Tower's name for
  `loadMeteredDataSpend` in [`packages/contract`](../packages/contract/src/metered-spend.ts) —
  the one body `/health`'s spend summary, `/settings`' budget meter, the Wall's
  daily pace **and the collector's own cap gate** all read. A second aggregate
  over the same rows would be free to disagree by a float, and three surfaces
  quoting three different months is worse than one surface quoting none.
- **The figure includes ad-hoc research** *(2026-09-05, bead `ro-ukus`)*. Metered
  spend is two tables, because the portfolio spends this account two ways: the
  `provider_cost_usd` column every collected report writes on its own manifest
  row (db/0010), **plus** [`research_log`](../db/postgres/migrations/0001_baseline.sql) —
  what an agent or the operator bought one question at a time on the same
  credentials. The gate had counted both since `ro-cda6.3` while every desk
  meter counted only the first, so the desk could read comfortably under the cap
  on a month the collector then refused to spend in; a budget display that errs
  low is the one error it must not make. The two halves are disjoint by
  `actor` — research rows the collector wrote for itself are already in its
  manifest rows — and research bought about no single property is stated as its
  own line rather than pinned onto an asset that did not spend it.
- **One line, not one per asset.** Clarity's cap is per asset, so it draws a line
  per asset; this cap is portfolio-wide, so drawing it five times would say the
  same thing five times against a ceiling none of them individually has. Which
  asset the month's money went on is already a per-asset list on `/health`.
- **The ceiling is not in the catalog.** `monthly_caps.data_usd` is edited in
  `/settings`, so the provider declaration carries no copy of it; the cap rides
  on the reading, and a card with no cap to draw against draws nothing.

The rules the implementation keeps, each test-pinned
([`workers/ingest/test/credentials.test.ts`](../workers/ingest/test/credentials.test.ts)):

- **Connect it on `/integrations`; env is the legacy fallback.** Every provider
  below is connected, tested and disconnected in the product, and its credential
  lives AES-GCM-encrypted in [`credentials`](../db/postgres/README.md). An
  install still holding a binding keeps working, and moves when it wants to.
  Which secrets stay in the environment and why is written once, in
  [doc 06 § Bootstrap secrets vs. integration credentials](06-operations.md#bootstrap-secrets-vs-integration-credentials).
- **One env secret for this.** `CREDENTIALS_KEY`, 32 bytes base64
  (`openssl rand -base64 32`), in `.dev.vars` locally or
  `wrangler secret put CREDENTIALS_KEY` deployed.
- **Store first, env second, all or nothing.** A provider with a stored row is
  served entirely from the store; one without falls back entirely to its legacy
  binding. `signal_runs.credential_ref` records which — `store:` prefixed when
  the product's credential ran the pull — so "the collector is still on
  `.dev.vars`" is a fact you read rather than one you assume.
- **The plaintext never leaves the ingest Worker.** The Tower asks over a
  private Service Binding for the *answer* — is this connected, when did it last
  work — and receives field NAMES and metadata. A PUT answers `204` with no
  body: there is nothing safe to echo.
- **Nothing about a probe is persisted.** A connection test is not evidence; it
  writes no observation, no manifest and no R2 object, and it stamps only the
  credential's own `last_ok_at` / `last_error`.
- **Moving without retyping:** a provider still reading its binding wears the
  *Legacy env* chip on `/integrations`, and the card carries **Import from this
  machine** — one press reads the operator's existing `.dev.secrets.json` and
  PUTs every complete provider through the running Tower (bead `ro-vu8d.7`). It
  is the same code `pnpm dev:secrets:import` runs, which is what a deployed
  Tower shows instead: there is no secrets file beside a Worker to read. The
  bindings stay as the fallback either way; the store wins.

## Connecting Google

*Landed 2026-09-05, bead `ro-vu8d.3`. **Both ways in stay valid** — an install
already running on a service account is not asked to move, and nothing about
that path changed.*

Google is the one provider with two ways in, because the service-account path
asks an operator to create a robot in a cloud console, download a JSON key,
base64 it, and then grant that robot on every property one at a time. Signing in
does the same job with a consent screen. The card shows which is in force.

**What the OS asks for, and nothing more** — two read-only scopes plus the
operator's address:

| Scope | Why |
|---|---|
| `.../auth/analytics.readonly` | the Data API the collectors read, and the Admin API that lists which properties the account can see |
| `.../auth/webmasters.readonly` | Search Console's read scope. Deliberately **not** `webmasters`, which can also verify and delete sites |
| `openid` + `email` | so the card can say *Connected as ops@example.com* rather than just *Connected* — the only version that catches signing in with the wrong Google account |

A grant that comes back missing either read scope is **refused, not stored**:
Google's consent screen lets an operator untick a box, and a credential that
reads Analytics but not Search Console would look connected and then fail one
lane a day later with a 403 nobody could trace back to a checkbox.

### Connecting in the panel *(2026-09-23, bead `ro-ujb9.96.7.7`)*

Google connects in the same panel as every key provider (connect kind
`sign-in`, `GoogleSignInSetup`), never on a page of instructions. Connect Google
on `/integrations` or on a site's Data sources row opens it.

- **Hosted** — the installation's sign-in app is the host's, already
  registered — the panel is the two read-only grants and **Continue with
  Google**. Where a hosted deployment keeps that app, and its verification by
  Google, is the operator's decision (bead `ro-fuav`, `human`); today the panel
  treats a client from the environment binding as the host's.
- **Self-hosted** — the installation registers its own app once — the panel is
  three presses and a file: **Open** turns on the three APIs in one console
  confirmation (Analytics Data, Analytics Admin, Search Console); **Open**
  creates a web client, with this Tower's redirect address and Copy beside it;
  then the `client_secret.json` Google hands back is dropped on the panel. Its
  id and secret are stored as `google-oauth-app` (encrypted like any other
  credential); a desktop or service-account file is refused and nothing is
  stored; a client whose redirect list lacks this address says *Redirect address
  not in the client* before Google would refuse it
  (`apps/tower/shared/google-client-file.ts`). The consent screen stays in
  Testing until it is published, so the panel keeps the seven-day chip with
  Publish beside it ([below](#the-seven-day-clock-on-a-testing-consent-screen-2026-09-05-bead-ro-vu8d8)).
  This installation's own one-time setup is bead `ro-vu8d.13`.

After consent Google returns to the panel (`/integrations?connect=google`), not
to a page: the sign-in itself is the proof (it stamps the credential's last
good answer), and the panel lists the account's GA4 properties — each matched by
its web stream's address, or a property named for its domain — and its Search
Console sites, both on the site's one row (`discoverGoogleSites`,
`workers/ingest/src/credential-probes.ts`; an unverified Search Console site is
listed, never ticked). **Start** writes the Data sources rows' own mappings and
runs the quarter-hourly Google step for the named sites only.

The service-account way in keeps its page (*Service account instead*).

### The redirect URI, and the loopback dance

The redirect URI is **derived from the origin the browser is on**, never
configured — a configured copy would be a second answer, and the one that lost
would produce `redirect_uri_mismatch`, the single most common way an OAuth setup
fails. The card prints the exact string with a Copy button.

**Google refuses every plain-http redirect that is not loopback.** `pnpm os:up`
binds `0.0.0.0` by default, so the normal way to reach this Tower is a LAN
address — and that address cannot be registered. The dance:

- Register `http://127.0.0.1:5173/api/integrations/google/oauth/callback` and
  `http://localhost:5173/api/integrations/google/oauth/callback`.
- **Connect once from `http://127.0.0.1:5173`** on the machine running the OS.
- Every other device then reads the card from the LAN as usual: the credential
  is stored, and the card keeps saying *Connected* from any address. Only
  *starting* a sign-in needs the loopback one, and the card says so with the
  address to use when it is opened somewhere Google would refuse.
- A deployed Tower on https needs neither dance — register that origin's
  callback path instead.

### What the round trip does

`GET /api/integrations/google/oauth/start` → 302 to Google ·
`GET /api/integrations/google/oauth/callback` → 302 back to
`/integrations?google=…`

- **The Tower holds nothing.** It carries an origin in and a redirect out; the
  authorization URL is built inside the ingest Worker (it needs the client id),
  the code is exchanged there (it needs the secret), and the refresh token is
  sealed into the store there. No token, no secret and no signing key crosses
  the Service Binding in either direction.
- **The state is signed, not stored.** A nonce table would be a migration, and
  migrations are operator-only — so the state is a ten-minute HMAC over a random
  nonce, an expiry, and *the redirect URI it was minted for*, keyed by an HKDF
  of `CREDENTIALS_KEY`. Binding the redirect in is what stops a state minted at
  one origin being replayed at another. A state that does not check out never
  reaches Google's token endpoint at all.
- **Start is same-site; the callback cannot be.** A cross-site link into
  `…/oauth/start` is refused (login CSRF is how an attacker gets *their* Google
  account connected to somebody else's OS); the callback arrives from
  accounts.google.com and is defended by the state instead.
- **`access_type=offline` + `prompt=consent`**, together, are what guarantee a
  refresh token. Google issues one only on a fresh consent, so a reconnect
  without them would return an hour-long access token and a card that dies
  overnight.
- **Disconnect revokes at Google first, then deletes.** In that order: a network
  failure leaves the token still stored and still revocable, never a live grant
  on the operator's Google account that this OS can no longer name. The revoke
  is best effort and never blocks the delete.

### The seven-day clock on a Testing consent screen *(2026-09-05, bead `ro-vu8d.8`)*

**A consent screen left in Testing expires every refresh token seven days after
it is granted.** The console steps above produce exactly that — External, plus
yourself as a test user — so a first sign-in is on a clock, and until this
landed the first sign of it was a nightly pull failing.

- The OAuth exchange records `expiresAt = connectedAt + 7 days` in the
  credential's public metadata (`credentials.fields_json`, no new column), and
  the card counts down, turning warn-toned at T-14d — which for a seven-day
  grant means from the moment it is made.
- **Google publishes no API that reports whether a consent screen is
  published**, so the card states the assumption rather than hiding it, and
  offers one press — *it does not expire* — recorded as the **operator's**
  answer. `carriedExpiry` in `workers/ingest/src/credentials.ts` keeps that
  answer through every later sign-in; nothing else would, and a correction that
  has to be re-made after each reconnect is a warning people learn to dismiss.
- **Publishing the app is the real fix.** Google Cloud console → OAuth consent
  screen → *Publish app*. A published screen issues refresh tokens with no
  seven-day limit; the read-only scopes this OS asks for are not sensitive
  enough to need verification for a single-operator install.
- **After the fact, the sentence names the cause** *(2026-09-05, bead
  `ro-vu8d.14`)*. A revoked or expired grant answers `invalid_grant` at the
  token endpoint; `refreshGoogleAccessToken` raises `google_oauth_revoked`
  carrying `GOOGLE_OAUTH_REVOKED_MESSAGE`, which is what reaches
  `credentials.last_error` and the card. It is a **constant this repo wrote**,
  never anything derived from a request that held a refresh token. Two silent
  paths were closed with it: `probeCredential` used to rewrite every thrown
  error as *"Google could not be reached"* — telling the operator their network
  was at fault — and the nightly pull used to stamp
  *"Every Google property failed (google_oauth_revoked)"*, an enum shown to a
  person. The per-property outcomes still carry the code; only the
  operator-facing column changed.

### What a sign-in does not decide

It tells the OS which GA4 properties and Search Console sites the account can
see — the card lists them on demand, and
`GET /api/integrations/google/properties` is the payload — but **which asset each
one belongs to is the operator's answer**. Since `ro-vu8d.4` that answer is the
asset's own Sources tab, written to `config/integrations.json` and read by one
resolver (`workers/ingest/src/lane-mapping.ts`); a sign-in plus a mapping is a
whole setup, with no account map to paste. An OAuth-only install that has mapped
nothing collects nothing and says so once per pull
(`google_signals_no_properties_mapped`) rather than failing.

**And the account map is no longer a second home for that fact** *(2026-09-05,
bead `ro-90mr`)*. `GOOGLE_SIGNAL_ACCOUNTS` still carries a `ga4_property_id` /
`gsc_site_url` per asset for installs that predate the mapping, and the collector
reads them **per data source, and only while at least one asset it names has no
mapping of its own**. Once all of them do, those two fields are not read at all
and the entry is down to what it always had to be: which account authenticates
which asset, plus that entry's `time_zone`. No migration and no operator step —
the day it flips, the value the collector stops reading was already being
shadowed. The Google card on `/integrations` says which of the two states holds
and names each asset × data source still waiting. An install that pastes the map
for its *properties* and signs in for its *auth* holds both, and each account
entry that names no `service_account_b64` authenticates with the sign-in.

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
  required — doc 15 flow A; `not-applicable` = the catalog says it never
  applies to this asset) —
  Phase 0/1 exits ([doc 07](07-roadmap.md)) reference these states instead of
  vibes. The central GSC/GA4 collectors landed 2026-07-29. On 2026-07-30, one
  live 15-minute run proved all ten configured Google targets: GA4 + GSC for
  the five configured properties. The BWT collector
  also landed that day; all five properties are now verified and proved,
  including read-only pre-launch collection for the one not yet launched. The weekly
  DataForSEO archive is also live for the four launched properties; its first
  run stored 20/20 report families and cost $1.122772. Current gaps:
  Clarity export tokens; ad/affiliate report ingestion;
  uptime lane. Bing AI Performance ingestion awaits one operator-exported
  sample because the documented API does not expose that report.

  **2026-07-31 — the Clarity gap is wider than "no token."** Checked against
  the repo while working the
  audit brief (private historical evidence) F9: NoticeOS
  has **no Clarity ingest lane at all**. What exists is a credential probe
  (`pnpm creds:check --lane clarity`, deliberately explicit-only because a probe
  burns 1 of the project's 10 daily calls), the `CLARITY_TOKENS` secret slot,
  and the per-asset inventory in `config/integrations.json`. The behavior
  snapshots the brief refers to are the **property's own**
  `scripts/clarity-export.mjs` in its repo writing to `_analytics/`
  — not a central lane, and nothing this repo consumes. Building one is blocked
  on more than the token: `signal_dump_runs.integration` is `CHECK`-constrained
  to `('ga4','gsc','bing-webmaster','dataforseo')` (migration 0010), so a
  Clarity manifest row cannot be written until an operator widens it, and DB
  migrations are `forbidden`-class per AGENTS.md.

  **2026-07-31, later the same day — the lane landed.** The operator supplied a
  project token and sanctioned the schema change, so migration
  `0016_clarity_signal_dumps.sql` widened the `integration` CHECK (a table
  rebuild copying every prior manifest, the same shape as `0009`/`0010`) and
  `workers/ingest/src/clarity-dumps.ts` now runs on a new `30 4 * * *` cron. See
  [the Clarity lane](#microsoft-clarity-export-landed-2026-07-31) below.

  Two credential facts survive the landing and are worth keeping in front of the
  operator:

  - **It is one project's token, not a per-asset map**, so the lane is
    **single-property** — one site — until a map replaces it. Clarity issues
    tokens per project; there is no portfolio credential to grow into. The
    migration to the map is tracked as `ro-1zf`.
  - **Two secret shapes are accepted, and the map is canonical.**
    `CLARITY_TOKENS` (asset → project token) is the shape
    `.dev.secrets.example.json` advertises and the only one that can express the
    portfolio. `CLARITY_PROJECT_API_TOKEN` — the flat string the operator
    configured first — is a documented fallback bound to that one site. The
    collector and `scripts/creds-check.mjs` apply the **same** precedence: the
    map wins wherever both name an asset, so `pnpm creds:check --lane clarity`
    now recognizes either shape instead of reporting a configured token as
    missing. Migrating the secret to the map is a rename, not a rewrite.

  **Connecting it (bead `ro-ujb9.96.7.9`).** Clarity connects in the
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

**The decision (owner, 2026-08-05).** One token per asset covering *both*
directions is deliberate, not an oversight. The accepted tradeoff is stated
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
| `ADMIN_TOKEN` (another asset), and `NOM_ADMIN_TOKEN`, the copy of it the OS kept | the secret gating `GET /api/admin/overview`, lent to the OS so a cron could read it | renamed to that asset's `ASSET_TOKEN`; the OS's copy is gone (`scripts/pulse-relay.mjs` reads that asset's `ASSET_TOKENS` entry for both hops) |

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

## Central Google signal collector (landed 2026-07-29)

`workers/ingest/src/google-signals.ts` runs on the existing 15-minute Sense
tick. The readable `GOOGLE_SIGNAL_ACCOUNTS` source stores each base64
service-account JSON once and maps that account alias to the properties it
supports. Local compilation extracts each encoded key to its own bounded
`GOOGLE_SERVICE_ACCOUNT_*` secret and leaves only account/property routing in
the runtime `GOOGLE_SIGNAL_ACCOUNTS` binding. The Worker resolves the named
credential, mints one read-only token per account/scope, and reuses it across
that account's property targets.

The local editing source is the formatted, gitignored
`workers/ingest/.dev.secrets.json`; its `GOOGLE_SIGNAL_ACCOUNTS` member is a
normal nested object. `os:up` compiles it to the routing plus per-account string
bindings Wrangler expects in `.dev.vars`. Production uses the same split as
encrypted Cloudflare secrets—no filesystem read is introduced into the Worker.

Each pull requests a bounded 97-day, date-only dataset. The Tower exposes 90
dates on property detail and retains the preceding seven out of view so
same-weekday comparisons and rolling lines can start on the first visible day.
GA4 returns `activeUsers`, `sessions`, `screenPageViews`, and `eventCount`; GSC
returns property-total `clicks`, `impressions`, `ctr`, and `position` with
`dataState=all`. Today is the only visually incomplete GA4 day. GSC also treats
today as provisional when response metadata is absent; the provider's
`first_incomplete_date`, when earlier, expands the provisional tail.
GA4's day boundary comes from each map entry's IANA `time_zone` (PT default),
matching [GA4 property reporting-timezone
semantics](https://support.google.com/analytics/answer/9744165); GSC dates use
the Search Analytics API's [documented PT
boundary](https://developers.google.com/webmaster-tools/v1/searchanalytics/query).
The collector never uses UTC rollover to open a tomorrow bucket before the
provider's reporting day does.
The append-only store records every run, including errors, but appends metric
rows only when a value is new or revised. This preserves provider revisions
without copying an unchanged 97-day snapshot 96 times a day. The larger date
range does not add requests: cadence remains one GA4 and one GSC request per
property every 15 minutes.

The Tower never calls Google. It reads the latest run for red/green source
health and reconstructs the latest successful values for the charts. A failed
pull therefore turns the icon red while leaving the last-good chart visible.
Both charts overlay the same weekday from the prior week and compute their
growth delta from the latest completed day. GA4 still headlines today's
frequently refreshed provisional value; GSC headlines the latest completed
day so a partial current day cannot masquerade as a collapse.
The 2026-07-30 local run used one credential label for two properties and
a second for the other three. All ten
targets completed without error over the bounded 2026-05-02–2026-07-30 window.
The credential-label rename is prospective: rows under the old label's
`credential_ref` remain immutable historical evidence, while new runs use
the new label. A permission-denied GSC attempt immediately before one property's
operator grant likewise remains in the append-only history; the latest
successful attempt drives green health.

### GA4 realtime read path

Realtime active users are intentionally separate from the durable 15-minute
daily-series collector. The Tower browser polls its own
`GET /api/ga4/realtime` endpoint every 30 seconds. The Tower Worker reaches
ingest through a private Cloudflare
[Service Binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
RPC method, so `GOOGLE_SIGNAL_ACCOUNTS` and Google access tokens remain owned by
ingest. Ingest reuses the read-only OAuth access token for at most 50 minutes
and makes these concurrent, bounded reads per configured property:

- one
  [`runRealtimeReport`](https://developers.google.com/analytics/devguides/reporting/data/v1/realtime-basics)
  with named inclusive 0–29-minute and 0–4-minute ranges, beside a second one
  grouped by `minutesAgo` over GA4's default last 30 minutes — the Wall's
  minute pulse (bead `ro-trai.27`). The two are one reading, shared by every
  open display for **one minute**: the pulse is per-minute, and two realtime
  requests a minute spend what the single request every 30 seconds did (one
  costs a property ~46–49 tokens,
  `ga4-recovery-2026-09-12.json`; private historical evidence;
  at 30 seconds a Wall left on all day spent ~132k of the 200k-token daily
  realtime budget, so doubling the requests at that cadence would run it out).
  The per-minute rows are parsed as strictly as the windows; refused or
  failed, the reading stands without a pulse. `ga4MinuteBuckets`
  (`packages/contract`) places them on the clock the snapshot is served at:
  a minute with no row is 0, a minute the reading did not cover is `null`; and
- one Core `runReport`, grouped by `dateHour` over `yesterday…today` and
  `8daysAgo…6daysAgo`, which ingest re-buckets from the property's reporting
  timezone (the response's `metadata.timeZone`) into `OS_TIME_ZONE` — the
  operator's clock, configured as `config/constants.json` `os_time_zone` and
  read once by `packages/contract` (bead `ro-py40`) — so every property's
  today-line shares one x-axis. An Eastern property's OS day starts at its 3 AM; the two neighbouring
  property days are requested because the OS day straddles them.

Each row converts with the reporting timezone in effect on its own date, read
from the `reporting-time-zone-changed` annotations (ro-tzq), because GA4 does
not reprocess history: after a PT→ET move, last week's hours are PT-bucketed
and today's ET-bucketed, and both land on the same OS hours. The pace chip
therefore compares the same real hours across a change; only the two distorted
days around it are marked.

The card presents **30 min** before **5 min** because the broader window is the
more stable glance value. Above the historical daily chart, it draws today's
reported hourly shape, on the operator's clock, over a dotted full-day
same-weekday reference. Future today hours are `null`, not forecast zeros,
while the prior day retains all 24 hours. The pace delta compares only the hours reported for both days. Hourly
active-user observations are not added into the large DAU headline because a
person may appear in multiple hours; that headline remains the exact distinct
daily value from the durable 15-minute collector.

This read is current state, not a ledger or analysis dataset: it writes neither
Postgres nor R2 and does not participate in anomaly rules. Provider/property failures
are isolated. A valid empty report is zero; a failed or malformed report is an
explicit unavailable state with null values. React Query retains the last good
snapshot during a later failed poll and labels it “Reconnecting,” while the
independent `/api/wall` payload and property cards continue rendering. Each
provider read asks GA4 to return its property-quota state; any future cadence or
multi-display expansion must be justified against that measured token use
rather than assuming a request count equals token cost.

*Landed 2026-08-04 (`ro-ert`): the two lanes that actually spend — the 12:15
archive and the 15-minute collector — ask as well. The archive keeps each
collection's quota in its R2 envelope beside the pages (never inside the hashed
bytes, or the unchanged-detection would retire itself); both lanes log it and
raise one `ga4-quota-pressure` flag on the property while a bucket is under 20%
remaining; and an exhausted budget is `ga4_quota_exhausted` on the run row
rather than a generic 429. Shared vocabulary:*
`workers/ingest/src/ga4-quota.ts`.

## Daily provider analysis archive (landed 2026-07-29)

`workers/ingest/src/signal-dumps.ts` runs at 12:15 UTC, when the prior UTC date
is also complete in the portfolio's continental-US property timezones. It
re-fetches the previous four completed dates to retain provider revisions.
GSC requests `dataState=final` for ten durable families:

- Web Search: `page-query`, `page`, `query`, `country`, `device`,
  `page-country`, and `page-device`.
- Search result treatments: `search-appearance-pages` first discovers the
  available appearance types, then follows Google's required second-query
  pattern to retain the page attached to each type.
- Other surfaces: `image-page-query` and `discover-page`.

GA4 archives eight completed-day families: `pages-screens`, `landing-pages`,
`traffic-acquisition`, `traffic-sources`, `events`, `page-events`, `js-errors`,
and `landing-page-acquisition`, plus one `events-28d` aggregate ending on the
newest completed date. The rolling family runs once per archive job, not once for each
revision date, and supplies exact per-step unique-user counts without summing
daily uniques. The last two daily families close the most important decision
joins: which on-page events happened on which URL, and which landing URL earned
engaged sessions/key events from each source and channel (including identifiable
`AI Assistant` referrals).

***Landed 2026-07-31*** *(private audit, F5): `js-errors` is the first family
that reads GA4 **event parameters** rather than built-in dimensions — `customEvent:message` and `customEvent:source` beside
the page, filtered to `eventName = js_error`. It exists because the
`javascript-errors` card could name the worst page (one site's `/calculator`, 125
events / 1,905 views) but not the error, which is the only part an engineer can
act on.*

*Two operator facts ride with it. The Data API refuses to answer for a parameter
nobody has registered as a custom dimension in GA4 admin, and GA4 backfills
**nothing** — data begins at registration, so earlier dates are permanently
unknown. Registration is operator work; the analytics pipeline is
`forbidden`-class per AGENTS.md. Until it happens the collector records
`ga4_custom_dimension_unregistered` on the manifest, which is deliberately
neither a generic HTTP failure (which would send the operator to check
credentials) nor a zero-row success (which would state that the property throws
no JavaScript errors). The family also runs in probe mode, so a property whose
pages never throw costs one request a day rather than four.*

***Registration state, 2026-07-31 (re-verify before relying):*** `message` *and*
`source` *are registered as event-scoped custom dimensions on **two
properties**, and*
[`config/ga4-custom-dimensions.json`](../config/ga4-custom-dimensions.json)
*records exactly that. The family is offered only to the properties that file
covers — the other three are skipped silently, no request and no manifest row,
because a permanent known gap must not generate a daily error row.*

*The gate does **not** retire the unregistered state. Registration is
forward-only, so a listed property can still be asked for a date before its
dimensions existed; and the file is a hand-maintained claim about a system it
cannot inspect, so a wrong entry has to fail loudly rather than read as zero.
Absent is per-date, and it is never an error-free day.*

***First real collection, 2026-07-31 (local run of the 12:15 lane).*** *All
three states appeared at once on live data, which is the proof the family was
built for:*

| Property | Manifest | Reading |
|---|---|---|
| first registered property | `success`, 84/66/67/74 rows (07-27→30) | real triage data |
| second registered property | `success`, **0 rows** | registered, queryable, genuinely no `js_error` — a **true zero** |
| the other three | `error`, `ga4_custom_dimension_unregistered` | never answerable |

*Without the distinct error code, the second property's honest zero and the three
unregistered properties would be the same empty row.*

***The no-backfill rule is not theoretical — read the first CSV carefully.*** *In
the first property's 683 events across 07-27→30,* `source` *resolves to 40 distinct bundle
positions (`vendor-react-DO8020zi.js:38:3302`), while* `message` *is* `(not set)`
*on **every** row. The emitter is not at fault:*
`src/lib/analytics.ts` *in that repo sends* `event("js_error", { message, source,
page })`*, so the parameter name is right. The asymmetry is best explained by the
two dimensions having been registered on **different dates** —* `source` *earlier,*
`message` *today — and GA4 backfilling neither. Expect real message text only
from **2026-07-31 forward**; the operator can confirm each dimension's creation
date in GA4 admin. Until then* `/calculator` *at 160 events is still the leading
page, and the bundle position is already more actionable than the page alone.*

*Operator answer (2026-08-04, `ro-rkx`): GA4 admin does not display a
dimension's creation date, so the exact boundary is unknowable from the console
— but the operator re-fixed both dimensions around **2026-08-01/02**, so treat
message text as trustworthy from then and every earlier `(not set)` as
permanent. The other three properties stay unregistered by choice ("no need
yet"); their nightly `ga4_custom_dimension_unregistered` state remains the
honest record until that changes.

Responses are paginated and bounded before parsing: 8 MiB per provider
response, 32 MiB per archive, 50k rows per GSC report/day and 250k per GA4
report/day. Hitting a provider cap is stored as `provider_truncated=1`; it is
never silently described as complete. Those ceilings follow Google's
[Search Analytics extraction guidance](https://developers.google.com/webmaster-tools/v1/how-tos/all-your-data)
and [GA4 Data API pagination contract](https://developers.google.com/analytics/devguides/reporting/data/v1/basics).
Every gzip JSON object contains the exact request bodies and provider response
pages but no Authorization header, JWT, service-account key, or access token.

The same cron lists verified BWT sites once, then archives six independently
failure-isolated families per launched property — but not all six every day.
Four are genuine daily provider series, each gaining a day of history every
day, and are archived daily: `GetRankAndTrafficStats`, `GetCrawlStats`,
`GetCrawlIssues`, and `GetFeeds`. The other two, `GetQueryStats` and
`GetPageStats`, are current top-result snapshots that Microsoft rebuilds
weekly, not guaranteed complete daily exports, so asking daily re-downloaded
the same snapshot six times out of seven; since `85b9c2c` each is collected
once every seven days. The analyzer already treated them that way: it uses
only the latest downloaded BWT snapshot for findings and never adds rows from
repeated collection runs.

Due-ness is measured from **the property's own archives**, not from a calendar
anchor: before it calls anything the run asks that property's
`signal_dump_runs` history for the newest date each family has archived, and
collects a weekly family only once that date is seven or more days behind the
date being collected. So a missed run leaves the family overdue the next day
instead of pushing it a further week out; a failed fetch never satisfies a
cadence; and a family that was not due is not asked on any path, including the
credential-failure one. **A day nobody asked writes no manifest row at all** —
`status` is a closed vocabulary of attempts, so "we asked and it was the same"
(`unchanged`) stays distinguishable from "we did not ask". On an ordinary day
the 12:15 UTC run therefore requests four BWT families per property, and six on
each property's own seventh day. Mechanics and the three properties that follow
from them: [`workers/ingest/README.md`](../workers/ingest/README.md#weekly-families-on-a-daily-cron).

Lane health survives the split cadence because the Tower rolls the lane up
across its families (`aggregateArchiveRuns` in
[`apps/tower/worker/integration-evidence.ts`](../apps/tower/worker/integration-evidence.ts)):
the four daily families carry the lane's freshness to today, and only a family's
failed manifest reddens it — which a skip cannot produce. The archive evidence
line counts only the families the date it names covers ("4 of 6 … archived for
2026-08-04. Last archived earlier: pages (2026-07-29) and queries (2026-07-29)"),
so a correctly-working weekly family reads as a cadence rather than as a gap.

The `RAW_SIGNALS` R2 binding is private. Wrangler uses local R2 by default and
persists it under the repo's shared `.wrangler/state`. The archive tools use
the installation's ingest API. Postgres's `signal_dump_runs` table is the
append-only evidence index. A content hash
deduplicates unchanged re-fetches while preserving an `unchanged` attempt row
that proves the job ran.

Operator workflow:

```bash
pnpm os:cron -- "15 12 * * *"                    # collect into local R2
pnpm signals:download -- --asset example.com     # latest local object per report/day
pnpm signals:history -- --asset example.com --in .local/signal-dumps/downloads/example.com --out .local/signal-dumps/history/example.com
pnpm signals:analyze-history -- --asset example.com --history .local/signal-dumps/history/example.com --out .local/signal-dumps/reports/example.com
pnpm signals:publish-insights -- --asset example.com --file .local/signal-dumps/reports/example.com/executive.json # compact snapshot → Postgres
```

`os:cron` fires a WHOLE lane, every property. To baseline one property the day it
launches — without re-billing the other four — ask for it by name instead
(`ro-282.1`); it runs the same collector, scoped, so what lands is what the
weekly lane would have landed for that property:

```bash
pnpm signals:collect -- --asset example.com --families serp-panel
```

All four run **beside a live `pnpm os:up`** and none of them opens the store: the
local halves read and write through the ingest's operator-authed routes on the
loopback door (`GET /api/signal-archives`, `GET /api/panel-object`,
`POST /api/insight-snapshot`), so one workerd runtime owns the sqlite file
(`ro-mad`, ported in `ro-2zk.3`). `--remote` still uses wrangler, where there is
no local file to share.

Those four commands are the **hand** path. Since 2026-08-03 the download +
flatten half also runs on its own cadence for every property on the roster in
[`config/signal-panels.json`](../config/signal-panels.json), so the panel dir a
property repo reads is standing data rather than whatever an operator last
pulled. The refresh makes **zero** provider calls — it materializes archives the
crons above already bought — so it moves nothing against the monthly data cap at
any cadence. What a consumer may conclude from those files, and the honesty rules
that bind them, is [doc 20](20-signal-panels.md).

## Microsoft Clarity export (landed 2026-07-31)

`workers/ingest/src/clarity-dumps.ts` runs at **04:30 UTC**, last in the nightly
chain because it depends on nothing the earlier slots write. It is the
portfolio's hardest-capped provider — **10 calls per project per DAY**, trailing
72 hours only, ≤3 dimensions, 1,000 rows and no pagination — and every design
choice is that cap:

- **One call per property per day**, one dimension (`URL`), archived verbatim to
  R2 under one `signal_dump_runs` row (`integration = 'clarity'`, `report =
  'url-3d'`, migration `0016`). Analysis re-reads the stored object; re-reading
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

**The manifests are the lane's health** *(2026-09-23, bead `ro-at7t`)*. The
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

*Product analytics archive, landed 2026-09-22 (bead `ro-ghis.1`, epic
`ro-ghis`). Collector: `workers/ingest/src/posthog-dumps.ts`. Archive
contract: `packages/contract/src/posthog.ts`.*

Search data says who arrives. PostHog says what they do once they are on the
page: which steps of a journey they finish, which errors they hit, where they
rage-click, and how fast the page is on their own device. PostHog replaced
Clarity on one site on 2026-09-07.

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

**Window grain, not day grain.** This differs from the bead text on purpose.
The bead text asked for "per day" rows in five families. Unique people and
percentiles cannot be added across days, so a 14-day total built from daily
rows would be wrong. So `events`, `exceptions`, `rageclicks`, `web-vitals` and
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
  it) is `local_store_failed` (bead `ro-aed0.10`), on every archive lane, not
  just PostHog. The Integrations page shows it as NoticeOS's fault, not the
  provider's. PostHog's key verdict ignores it, and it is never asked again
  daily: the provider already answered.

**An offline night** (bead `ro-aed0.8`). A PostHog call that never came back
asks the OS's egress gate first. When this machine is what is offline, the
window writes no row and is named on the one `os-egress-down` alert instead.
A window end the alert names, or whose latest attempt failed at the network
(`posthog_request_failed`, `posthog_timeout`), is asked again by the next daily
run: up to six a run per asset, oldest first. A refused key (401/403) is not
asked again daily. Details:
[workers/ingest/README.md](../workers/ingest/README.md#and-the-dates-it-cost-bead-ro-aed07).

**A "not now" from PostHog** (bead `ro-aed0.9`). A window PostHog answered with
a 5xx, a malformed answer or a 429 is asked once more by the next daily run,
within the same six and order. The same kind of answer twice for one window is
PostHog's settled answer and stays on the Integrations page. A 429 still stops
the whole run. The windows it never asked, on this asset and every asset after
it, are asked by the next run too: the 429's own row names the stopped run, so
no other record is written.

**Configuration: everything the operator sets, and where.**

| Setting | Where | Notes |
|---|---|---|
| Key (`POSTHOG_API_KEY`: one personal API key for the account) | `/integrations`, the connect panel (D21, bead `ro-ujb9.96.7.8`) | Create the key under PostHog → account settings → Personal API keys, with read access to Project, Insight and Query. Connect shows it to the US and EU clouds at once and keeps it only where it is accepted; that cloud is the region. An install that connected a key per site before (`POSTHOG_KEYS`: asset → key) keeps collecting with it — a site with its own key uses it, every other site the account key; nothing asks for a per-site key any more. The env bindings of the same names are the legacy fallback. |
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
ones left for the next run in `retryNotAsked` (bead `ro-aed0.11`).

**Event notes from the first site (epic `ro-ghis`).**

- First-party events reach PostHog by name only. A missing property is a
  privacy choice, not missing data.
- `/my` events arrive only after consent, so they are a floor.
- Events whose `$lib` is the site's own worker (e.g. `example-worker`) are server-side and use different ids.
- `people` is `uniq(person_id)`, PostHog's own unique-person count. The
  2026-09-22 manual readings counted `distinct_id` in places, so a person
  PostHog has merged across ids can make the two differ slightly.
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

## Weekly DataForSEO search-intelligence archive (landed 2026-07-30)

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
- `serp-panel` *(landed 2026-07-31; the phone joined the desktop 2026-08-04,
  `ro-o1n`; [doc 08 §S1b](08-seo-geo-signals.md))*: one live result page in the site's saved market
  (United States · English by default) per tracked head term **per device**, with the asynchronous AI Overview
  requested, read to depth 20. The panel comes from
  [`config/serp-panel.json`](../config/serp-panel.json) — the one place a
  tracked-query list is written down, capped at 31 per property (what the $0.25
  per-report reserve buys at two devices), seeded for the first two properties.
  A property with **no panel is skipped silently**: no call,
  no manifest row, no attempt, because absence of config is not a failed
  collection. The live/advanced endpoint takes one task per request and the
  device is a property of the task, so a panel is (terms × devices) calls landing
  in **one** archive under **one** manifest row — which is why the second device
  needed no migration, no second family and no second review bead: `device` rides
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

The first real local run on 2026-07-30 archived 20/20 families for the four
launched properties for **$1.122772** total. Two of them
each reached the explicit 200-row keyword cap; the manifest marks those
families truncated rather than implying complete keyword coverage.

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

As of 2026-07-29, Google's separate
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

**The import lane (landed 2026-08-04, `ro-2dn`).** The operator delivered three
real exports and the parser is pinned to them, not to a guess:
`workers/ingest/src/bing-ai-exports.ts` reads exactly three header rows —
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
`signal_dump_runs` row, integration `bing-webmaster`, reports `ai-overview` /
`ai-queries` / `ai-pages`, `data_state='provider-snapshot'`, `report_date` = the
export date — and it holds the original file byte-identical beside the parse, so
the read can always be redone. Content addressing makes a re-import `unchanged`
rather than a second copy; a later export appends as the next dated snapshot.
The panel contract (grain, and what an absent family means) is
[doc 20 §The `bing-ai` family](20-signal-panels.md#the-bing-ai-family-the-one-nobody-collects).
Dashboard scraping remains outside scope.

## Central Bing Webmaster collector (landed 2026-07-29)

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
Both retain same-weekday-last-week references.

After the 90-day collector landed, the real local run on 2026-07-29 succeeded
for four properties.
The two older series each contain 87 actual dates
(2026-05-02–2026-07-27); the third contains 38 (2026-06-20–2026-07-27), and the fourth
contains 37 (2026-06-21–2026-07-27). Bing returned 129, 197, 38, and 37 raw
rows respectively. This proved the prior four-week result was our collector
filter, not a Bing retention limit. On 2026-08-05 the operator confirmed
a fifth property live; the guarded local asset-state changeset moved its lifecycle
to `live` while retaining `sense_only=1`, so it now participates in launched-
property collectors without enabling an Act loop.

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
