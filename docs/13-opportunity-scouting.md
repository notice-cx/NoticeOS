# 13 — Opportunity scouting

*The earlier docs improve what the portfolio already does. This doc adds the
function that looks outside the portfolio: finding what it **could** do — new
opportunities, new methods, unexpected advantages, time-sensitive
opportunities. It also states the principle directly: **NoticeOS's main
capability is continuously updating its estimates and methods from recorded
outcomes; continuous improvement is the result of those updates**, not a
separate feature. The calibration loop (doc 03/04) checks NoticeOS's own
predictions against outcomes; this doc covers gathering new information about
the world outside the portfolio.*

## Why this is a first-class function, not a nice-to-have

The portfolio's first successes all came from opportunities people found by
hand, outside the portfolio: a federal site's retirement (the case for an
entire asset from one policy event), the orphaned-demand opportunities (two
sites — Wayback mining), the Raptive threshold drop (an eligibility change
worth a step increase in revenue), a vendor pricing change that made the
reclamation program viable overnight. People found those. NoticeOS's
objective is compounding ROI, so its highest-expected-value kind of discovery
cannot depend on the operator finding things by chance.

## The two learning loops

- **Calibration loop:** predicted-vs-realized per change class →
  better priors ([docs 03](03-attribution.md)/[04](04-decision-policy.md)).
  Makes NoticeOS better at *what it already does*.
- **Knowledge-acquisition loop:** scouting + recording which methods work →
  new hypothesis cards and new playbook entries. Expands *what it can do*.
  Without this loop NoticeOS keeps refining what it already does until no
  further gain is left there (a local maximum); with it, the explore sleeve
  ([doc 04](04-decision-policy.md)) gets a steady supply of new candidates.

## Scouting categories (each a scheduled, budgeted sweep producing hypothesis cards)

1. **Demand events** — retirements, shutdowns, orphaned resources (Wayback /
   End-of-Term mining, discontinued .gov/.edu tools), seasonal/news demand
   spikes after which demand stays higher for a long time. This makes the method that
   has already worked a regular process.
2. **Platform & policy events** — ad-network threshold changes, affiliate
   commission changes, Google update announcements + spam-policy shifts,
   crawler/AI-platform policy changes (the doc-02 `external` annotations are
   this category's output too). These create **time-boxed** opportunities.
3. **Method & technique intelligence** — new SEO/GEO techniques with evidence,
   new platform features (GSC reports, schema types, ad formats), model/tool
   capability changes that alter the cost side of the ledger. Output here is a
   **playbook entry** (a method the builder may now use) as much as a card.
4. **Competitive intelligence** — changes among the competing results for
   tracked panels, competitor feature/content moves worth countering or
   ignoring (explicitly scored — most should be ignored).
5. **Adjacency & new-asset scouting** — adjacent niches where an existing
   template and the same approach to datasets can be reused. Includes
   acquisition monitoring (marketplace listings matching the portfolio's buy
   criteria) as a low-frequency category.
6. **Cross-asset transfer** — the cheapest category: a measured win on one
   asset automatically generates candidate cards for the others (the ledger
   already records what worked; transfer applies the portfolio's own evidence
   to other assets). The deterministic executive rules generalized from one
   site's manual analysis are this category's first output —
   [doc 08](08-seo-geo-signals.md)'s rule inventory, thresholds in
   `scripts/signal-insights.mjs`.

## News and trend intake (input to the scouting categories, not one of them)

HackerNews, tech/general news, **AI product announcements**, and industry
analysis are the raw input to the scouting categories — one HN post can be a
demand event (category 1), a method (category 3), a competitive threat
(category 4), or a change to NoticeOS's own cost structure (a new model/tool →
[doc 06](06-operations.md) model annotations + [doc 11](11-integrations.md)
catalog updates). AI announcements matter in two ways: as changes to the
surfaces the assets appear on (new answer engines, AIO behavior shifts — GEO
opportunities and threats) and as changes to NoticeOS's own capabilities and
costs.

How it works — three tiers, each more expensive and applied to fewer items
than the one before, because news monitoring can easily use up the whole token
budget:

1. **Collect** (free): RSS/API pulls (HN Algolia, curated feeds, update
   trackers) into the store; no model reads raw feeds.
2. **Skim** (cheap model, batched daily): headline+summary triage against the
   portfolio theses and current focus (from the portfolio context,
   [doc 04](04-decision-policy.md)); output = drop (default), or route to a
   category with a one-line reason.
3. **Investigate** (budgeted): only routed items get real model time; only
   a rare high-stakes find gets a deep-research run.

Intake rules: prefer recall over precision at the skim tier (dropping an item
costs little; missing a time-limited opportunity costs more). Routing an item
does not make it a finding: a routed item still has to pass a category's
investigation and intake to become a card. The intake's own noise statistics
(routed→carded→shipped rates) are part of the quarterly scout-ROI review;
feeds whose routed items never lead to a shipped card are removed.

## Current stored search-opportunity data

The weekly DataForSEO archive is the first implemented scouting input that is
both metered and historical. It stores, per launched property:

- ranked keyword + URL + position joined to estimated demand, CPC, difficulty,
  intent, SERP features, and estimated visits/cost;
- current backlink authority plus a 90-day new/lost referring-domain series;
- Google and ChatGPT mention totals plus leading source domains.

The executive rules use this data only for prioritization: near-ranking,
non-navigational inner pages; high-volume weekly rank changes between locally
retained snapshots; referring-domain direction; and provider-observed AI
visibility. They do not label their score “ROI,” add overlapping platform
mentions into people, or recommend deprecation from a missing row. GSC data
confirms real impressions/clicks, GA4 data confirms acquired behavior, revenue
determines value, and deploy annotations set the outcome window. Because raw
weekly snapshots stay in R2, later investigations can compare history without
buying the old provider data again.

## Time-sensitive opportunities ("cash grabs") get urgency mechanics

- Hypothesis cards gain an optional **`window` field** (opens/closes dates +
  decay shape). The scoring function ([doc 04](04-decision-policy.md))
  multiplies by a decay factor as the window closes; the queue
  ([doc 10](10-control-tower.md)) shows expiring opportunities in a
  separate band with countdowns.
- Cards with a window may **skip the batch schedule** (an eligibility change
  worth $X00/mo doesn't wait for the weekly sweep) — but never the intake
  requirements: urgency shortens *scheduling*, never *verification*.

## Guardrails (scouting is the highest-Goodhart-risk surface in the system)

"Time-sensitive ROI cash grab" also describes parasite SEO, scaled content,
and every tactic Google deindexes domains for. Therefore:

- **Scouts produce hypothesis cards, never actions.** Every find enters the
  standard intake: causal path to a ledger family, kill criterion, invariant
  screening. The hard invariants ([doc 04](04-decision-policy.md)) are applied
  most strictly to scout-sourced cards — an opportunity that only works by
  violating a quality invariant is rejected, because it pays only until the
  violation is penalised.
- **Provenance required:** cards cite their scouting category + sources
  ([doc 11](11-integrations.md)); a claim such as "the scout feels this is
  big" fails intake exactly like any other unsupported claim
  ([doc 05](05-execution-and-accountability.md)).
- **Scouting is charged to its own budget.** Each category has a budget line
  (deep-research runs are the expensive ones); the ledger records **scout ROI
  at program level** — value of shipped scout-sourced cards vs total scouting
  spend, reviewed quarterly. A category whose finds never pay back its cost is
  run less often; that is a kill criterion like any other.
- **Novelty caps:** scout-sourced cards default to the explore sleeve and to
  conservative autonomy (T0/T1) regardless of the tier the change class has
  reached — a new method has to reach a higher tier on its own record as a
  method, not only on its class's record.

## The playbook (the record of methods)

A versioned library of *how* — proven methods with their evidence, cost
profiles, and applicability conditions (e.g. "reclamation outreach: 10–20%
conversion on 1:1 dead-resource replacements; requires a live replacement page
+ human-written pitch"). The Learn stage writes to it (post-attribution: method
worked / didn't, at what cost), scouts read from it (category 6), context packs
reference it. This is where the results of those updates are kept, so they
are not lost when a session ends. The final form of a playbook entry is a
**tool** (the rule in [doc 05](05-execution-and-accountability.md) that a
repeated task becomes a tool): method → documented playbook entry →
deterministic script a cheap model operates.

**There is no playbook library in this repo.** The methods that are
portfolio-generic are kept as rules in [doc 08](08-seo-geo-signals.md) and in
the instructions of the panel-review task (`scripts/runner/panel-review.mjs`);
one site's own methods belong in that site's repository. A method is
portfolio-generic only when its thresholds are re-established for each asset,
its negative results are recorded as part of the method, and its final form is
a tool.

**A playbook gets its own table when its log is needed to enforce its own
decision rules.** `reclamation-pipeline`'s outreach log is
`noticeos.reclamation_targets`, filled by `scripts/reclamation-import.mjs`,
shown as the property page's Link outreach funnel, and checked by the
`reclamation-match` rule — without a recorded conversion rate, a campaign
cannot apply the abandonment rule it documents.

## Integrations this adds

Each scout data source is a row of [doc 11's catalog](11-integrations.md#the-catalog),
with its cost, quota and degradation; scouts cite what they fetched.

## Cadence & phase fit

Categories 2 and 6 cost almost nothing and start in Phase 2 with the first
sweeps; categories 1/3/4 are weekly-to-monthly budgeted runs from Phase 2–3;
category 5 is quarterly. The scout-ROI review becomes part of the quarterly
Learn cycle. Each phase already requires a Learn artifact before it can end
([doc 07](07-roadmap.md)); from Phase 3 that artifact is kept in the
playbook.
