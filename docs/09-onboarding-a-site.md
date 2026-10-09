# 09 — Onboarding a site

*The template a new site's onboarding copies. The two design decisions it rests
on (server-observable reports, a storage-agnostic contract) are canonical in
[doc 02](02-signal-contract.md). One installation's own onboarding record lives
in that installation's notes (bead `ro-ujb9.175`); this page keeps what carries
to any site.*

A site's onboarding answers four questions: what its nightly report can count,
which search queries its panel watches, which served surfaces a deploy could
break, and what its own repository's agents must read instead of pulling
providers themselves.

For the first release, the operator implements the pulse endpoint and writes
the asset's `AGENTS.md` (D40). NoticeOS shows observed report coverage; asset
agent execution stays manual, and its pause check is unavailable (D43).
Completing data setup does not grant agent execution authority. See
[doc 14](14-design.md) for the onboarding screen as built and the kill-switch
and resume contract.

---

## Design decision 1: a report counts only what the site can observe — and a database is not the contract

A site need not have a database. A prerendered static site with a thin Worker
(an affiliate beacon, hosted share links, short-link redirects) keeps its
engagement in **GA4 custom events**, which its own worker cannot query when it
reports.

Two rules follow, and they belong in the contract, not in one site:

1. **The site's report contains only what its own infrastructure can observe**
   (worker requests, storage counts, first-party database rows). Client-side
   analytics (GA4) are an *external* signal — NoticeOS pulls them centrally
   (the same lane as Search Console), and the Tower joins them on the site id.
   Never make a site call the GA4 API to report on itself.
2. **Cloudflare Analytics Engine is the standard report counter for a site
   without a database.** One binding, `writeDataPoint()` at the worker routes
   worth counting, and the SQL API answers `last24h` / `avg7d` for the report
   endpoint. No schema, no migrations, and the free tier covers this usage. A
   site that already has a database keeps using it; Analytics Engine is the
   floor, not a migration.

   **Analytics Engine SQL gotchas (every site that counts with it copies
   these):** the dialect is ClickHouse-derived and function names are
   case-sensitive — `now()` works, `NOW()` is an unknown function; `if()`
   requires both value branches to share a type, so a sampling-corrected sum
   needs `if(cond, _sample_interval * double1, 0.0)` — the Int literal `0` is a
   422 against the Double product. And always surface the SQL API's response
   body in the site's error path: its 422s name the exact complaint, and
   swallowing them into a bare status costs a deploy-and-retry round trip per
   mistake. Count in one scan, with a per-window `if()` slice for each window.

## The site's report (the `metrics` set)

Server-observable counters at existing worker routes — no new user-facing
behaviour:

```jsonc
{
  "asset": "example.com",
  "metrics": {
    "affiliateClicks":  { "last24h": 0, "avg7d": 0.0, "total": 0 },  // an existing click beacon
    "receiptsHosted":   { "last24h": 0, "avg7d": 0.0, "total": 0 },  // a hosted share (dedupe hits count separately)
    "receiptVisits":    { "last24h": 0, "avg7d": 0.0, "total": 0 },  // a shared link opened — the viral loop closing
    "apiRequests":      { "last24h": 0, "avg7d": 0.0, "total": 0 },  // public API use (total = within retention)
    "catalogItems":     { "last24h": 0, "avg7d": 0.0, "total": 2402 }
  },
  "capabilities": ["affiliateClicks", "receiptsHosted", "receiptVisits", "apiRequests"],
  "flags": []
}
```

A site opts into what it has: no signups, no plans, no feedback until it has
them. A stock fact such as `catalogItems` rides in `metrics` for the compact
card's current-stock row, but stays out of `capabilities` and the anomaly rules,
because an unchanged catalogue is not a zero-activity day.

The **product-use stage view** is GA4's. The archive collects one rolling
28-complete-day `eventName × eventCount × totalUsers` report a day. Each count
is unique within its own action and window, so the aggregate cannot prove that
one person went from one step to the next: the Tower draws no causal arrows,
labels a step percentage as a stage-volume ratio rather than a cohort
conversion, and never adds daily uniques together. A missing event row is
unknown ("None recorded"), never a zero.

A counter nobody uses is a finding about the product, not a card to keep: a
share counter that reads one opener in 28 days is diagnostics, not a headline
total.

## S1 — the SERP panel (port a site's own, don't rebuild)

If the site already runs its own SERP panel (a live-SERP script writing dated
snapshots), port it into the central panel and add the device dimension rather
than building another. Seed the panel from the site's own Search Console: its
brand and navigational terms, the head terms it earns impressions for, and the
strategic bets its current plan is testing — for example `example` ·
`example login` · `example calculator` · `best free calculators`. Record the
baseline facts the alerts should move: on how many seeded queries an AI
Overview fires, and on how many it cites the site.

## S2 — the views a site needs first

- **Striking distance:** the queries at positions 4–10 and the share of all
  query impressions they hold. Position-bucket migration (4–10 → 1–3) is the
  primary success metric of most SEO plans.
- **CTR against position by page type:** a title-template defect can hold a
  page type at a fraction of the expected CTR for a quarter before anyone
  looks. Make page type a first-class Search Console dimension — derivable from
  the path prefix (`/guides/`, `/calculators/`, `/{category}/{item}`).
- **A brand regex** for the brand-vs-generic split, for example
  `/\bexample\b|\bexample score\b/i`.

## S5 — regression guards (the site's own list)

- **The served tables and answers** AI crawlers read: guard the count of
  table rows in the served HTML per page family; a 50% drop is a deploy
  regression. Check front-loaded answer sentences on a five-page sample.
- **robots.txt and the AI-crawler allowlist**, and the **consent-mode head**:
  the consent default must precede the analytics loaders in served HTML, and a
  reject or Global Privacy Control must skip the loaders. A consent regression
  is a compliance incident, not only an SEO one.
- A site whose own CI already audits its build (link graph, sitemap,
  canonicals) needs fetch guards on the *served* layer only; don't duplicate
  what the site's CI proves at build time.

## S6 — monetization signals (platform state — canonical in [doc 08](08-seo-geo-signals.md))

A site with ads or affiliate revenue carries the S6 family: `ads.txt`
reachability and content, an ad-network review window, a storage object count
against its lifecycle rule (unbounded growth means the rule was silently
dropped), the affiliate-click trend from its report, and the consent check it
shares with S5.

## Deploy annotation

A site whose deploy pipeline already posts a deploy notification (a Discord
webhook, for example) points the same notification at the NoticeOS ingest to
stamp deploys onto its S1/S2 timelines — no new plumbing in the site. Its first
natural experiment is then already loaded: the first deploy batch after the
panel baseline, against that baseline.

## AGENTS.md mapping (before a builder touches the site)

The raw material usually exists; the task is distillation, not research. Per
[doc 04](04-decision-policy.md), dated and volatile facts (a review window, a
pending application) go in the pack's expiring `STATE` section, not its rules.

| AGENTS.md section | Where it usually comes from |
|---|---|
| Positioning / thesis | the site's current SEO or growth plan (its one-sentence strategy) |
| Brand & voice rules | the site's design doc (copy rules, banned openers, typography); trademark nominative-use rules |
| Never-fabricate rule | claims only from the site's research sources or computed data; **never invent a number** |
| Do NOT touch | scoring weights and thresholds without data review; consent and privacy surfaces; byte-stability constraints |
| CI bar | the site's verify, build and smoke commands |
| Deploy model | who pushes and deploys, and what the pre-commit hook regenerates |
| Report endpoint | added with the report (this doc) |
| Gotchas | files outside the type checker; hook races worth a retry |

## Onboarding order

1. The Analytics Engine binding and counters at the worker routes; the report
   endpoint and the nightly push — contract-compliant from day one.
2. Port the site's own SERP panel into the central S1 panel; keep the in-repo
   command for ad-hoc runs.
3. The S5 fetch guards (served tables, answers, robots, consent head).
4. Search Console and GA4 central pulls pick the site up with no site-side work.
5. Write the site's `AGENTS.md` from the mapping above, with the panel stanza
   from [doc 20](20-signal-panels.md).
