# 13 — Opportunity scouting & the learning engine

*The docs so far optimize what the portfolio already does. This doc adds the
outward-facing function: discovering what it **could** do — new opportunities,
new methods, unexpected advantages, time-sensitive plays. And it states the
philosophy plainly: **the system's power is continuous learning; continuous
improvement is the result of that learning**, not a separate feature. The
calibration loop (doc 03/04) is learning about our own predictions; this doc
is learning about the world.*

## Why this is a first-class function, not a nice-to-have

The portfolio's founding wins were all outward-scouted, by hand: a
federal site's retirement (an entire asset thesis from one policy event), the
orphaned-demand plays (two sites — Wayback mining), the Raptive
threshold drop (an eligibility event worth a revenue step-function), a vendor
pricing change that unlocked the reclamation program overnight. Humans found
those. A system whose objective is compounding ROI cannot leave its
highest-EV discovery class to operator serendipity.

## The two learning loops

- **Inner (calibration):** predicted-vs-realized per change class →
  better priors ([docs 03](03-attribution.md)/[04](04-decision-policy.md)).
  Makes the system better at *what it already does*.
- **Outer (knowledge acquisition):** scouting + method learning →
  new hypothesis cards and new playbook entries. Expands *what it can do*.
  Without the outer loop the system converges on a local maximum and
  optimizes it to exhaustion; with it, the explore sleeve
  ([doc 04](04-decision-policy.md)) has a supply line.

## Scout lanes (each a scheduled, budgeted sweep producing hypothesis cards)

1. **Demand events** — retirements, shutdowns, orphaned resources (Wayback /
   End-of-Term mining, dead .gov/.edu tools), seasonal/news demand spikes with
   durable tails. The proven playbook, systematized.
2. **Platform & policy events** — ad-network threshold changes, affiliate
   commission changes, Google update announcements + spam-policy shifts,
   crawler/AI-platform policy changes (the doc-02 `external` annotations are
   this lane's output too). These create **time-boxed** windows.
3. **Method & technique intelligence** — new SEO/GEO techniques with evidence,
   new platform features (GSC reports, schema types, ad formats), model/tool
   capability changes that alter the cost side of the ledger. Output here is a
   **playbook entry** (a method the builder may now use) as much as a card.
4. **Competitive intelligence** — SERP neighborhood shifts on tracked panels,
   competitor feature/content moves worth countering or ignoring (explicitly
   scored — most deserve ignoring).
5. **Adjacency & new-asset scouting** — adjacent
   niches where an existing template + dataset discipline transfers. Includes
   acquisition-watch (marketplace listings matching the portfolio's buy
   criteria) as a low-cadence lane.
6. **Cross-asset transfer** — the cheapest lane: a measured win on one asset
   auto-generates candidate cards for the others (the ledger already knows
   what worked; transfer is scouting one's own evidence). *First harvest
   (2026-07-31): seven deterministic executive rules mined from one site's
   manual-analysis archaeology and generalized portfolio-wide —
   [doc 08](08-seo-geo-signals.md)'s rule inventory, thresholds in
   `scripts/signal-insights.mjs`.*

## The radar: ambient trend & news intake (feeds the lanes, isn't one)

HackerNews, tech/general news, **AI product announcements**, and industry
analysis are the raw feed the lanes drink from — one HN post can be a demand
event (lane 1), a method (lane 3), a competitive threat (lane 4), or a change
to the OS's own cost structure (a new model/tool → [doc 06](06-operations.md)
model annotations + [doc 11](11-integrations.md) catalog updates). AI
announcements matter twice: as asset-facing surface changes (new answer
engines, AIO behavior shifts — GEO opportunities and threats) and as
OS-facing capability/cost changes.

Mechanics — a **cost pyramid**, because news monitoring is where token budgets
go to die:

1. **Collect** (free): RSS/API pulls (HN Algolia, curated feeds, update
   trackers) into the store; no model touches raw feeds.
2. **Skim** (cheap model, batched daily): headline+summary triage against the
   portfolio theses and current focus (from the portfolio context,
   [doc 04](04-decision-policy.md)); output = drop (default), or route to a
   lane with a one-line why.
3. **Investigate** (budgeted): only routed items get real model time; only
   the rare high-stakes find earns a deep-research run.

Radar hygiene: recall over precision at the skim tier (dropping is cheap,
missing a window is not) but **routing is not finding** — a routed item still
has to survive a lane's investigation and intake to become a card. The radar's
own noise stats (routed→carded→landed rates) are part of the quarterly
scout-ROI review; feeds that never route anything that lands get pruned.

## Current stored search-opportunity substrate

The weekly DataForSEO archive is the first landed scouting input that is both
metered and historical. It stores, per launched property:

- ranked keyword + URL + position joined to estimated demand, CPC, difficulty,
  intent, SERP features, and estimated visits/cost;
- current backlink authority plus a 90-day new/lost referring-domain series;
- Google and ChatGPT mention totals plus leading source domains.

The executive rules use this data only for prioritization: near-ranking,
non-navigational inner pages; high-volume weekly rank changes between locally
retained snapshots; referring-domain direction; and provider-observed AI
visibility. They do not label their score “ROI,” add overlapping platform
mentions into people, or recommend deprecation from a missing row. GSC confirms
real impressions/clicks, GA4 confirms acquired behavior, revenue determines
value, and deploy annotations establish the outcome window. Because raw weekly
snapshots stay in R2, later investigations can compare history without buying
the old provider data again.

## Time-sensitive plays ("cash grabs") get urgency mechanics

- Hypothesis cards gain an optional **`window` field** (opens/closes dates +
  decay shape). The scoring function ([doc 04](04-decision-policy.md))
  multiplies by a decay factor as the window closes; the queue
  ([doc 10](10-control-tower.md)) surfaces expiring opportunities in a
  distinct band with countdowns.
- Window plays may **jump the batch cadence** (an eligibility change worth
  $X00/mo doesn't wait for the weekly sweep) — but never the intake bar:
  urgency compresses *scheduling*, never *verification*.

## Guardrails (scouting is the highest-Goodhart-risk surface in the system)

"Time-sensitive ROI cash grab" is also a perfect description of parasite SEO,
scaled content, and every play Google deindexes domains for. Therefore:

- **Scouts produce hypothesis cards, never actions.** Every find enters the
  standard intake: causal path to a ledger family, kill criterion, invariant
  screening. The hard invariants ([doc 04](04-decision-policy.md)) apply with
  extra prejudice to scout-sourced cards — an opportunity that only works by
  violating a quality invariant is not an opportunity, it's a time bomb with
  a yield curve.
- **Provenance required:** cards cite their scout lane + sources
  ([doc 11](11-integrations.md)); "the scout feels this is big" fails intake
  exactly like any other ungrounded claim
  ([doc 05](05-execution-and-accountability.md)).
- **Scouting bills itself.** Each lane has a budget line (deep-research runs
  are the expensive ones); the ledger tracks **scout ROI at program level** —
  value of landed scout-sourced cards vs total scouting spend, reviewed
  quarterly. A lane that never pays gets its cadence cut; that's a kill
  criterion like any other.
- **Novelty caps:** scout-sourced cards default to the explore sleeve and to
  conservative autonomy (T0/T1) regardless of the class's earned tier —
  new methods re-earn trust as methods, not just as classes.

## The playbook (method memory)

A versioned library of *how* — proven methods with their evidence, cost
profiles, and applicability conditions (e.g. "reclamation outreach: 10–20%
conversion on 1:1 dead-resource replacements; requires a live replacement page
+ human-written pitch"). Learn writes to it (post-attribution: method worked /
didn't, at what cost), scouts read from it (lane 6), context packs reference
it. This is where "continuous learning" accumulates as capital instead of
evaporating at session end. A playbook entry's mature form is a **tool**
(the crystallization rule, [doc 05](05-execution-and-accountability.md)):
method → documented playbook entry → deterministic script a cheap model
operates.

**Delta 2026-07-31 — the collection exists.** [`docs/playbooks/`](playbooks/README.md)
is live with eleven entries, seeded from one site's archaeology: this is
lane 6's *method*-capital harvest, the companion to the same day's rule harvest
(seven executive rules, above). Each entry carries `{id, version, origin,
status}` frontmatter and a fixed body — use-when, preconditions, method,
if-X-then-Y decision rules, proof-and-abandonment, calibration, dated origin
evidence — so an agent with no context on that site reaches the decision the origin
sessions reached. Captured: impression-harvest, triangulate-before-acting,
serp-authority-gate, market-go-no-go, serp-snippet-standard, kill-thresholds,
freeze-register, utm-taxonomy, reclamation-pipeline, release-cohort-attribution,
dead-ends-register. Three properties are deliberate. Numbers that were true of
one property sit in *Origin evidence* or a calibration line, never in a decision
rule — the method transfers, the thresholds are re-earned per asset. **Negative
results are entries too**: the dead-ends register holds what was built, measured
and written off (an AI-manifest file no answer engine reads; a rich-result
treatment the engine removed, kept as markup and reframed as content), because a
documented dead end is capital exactly like a working method. And the seven new
rules in `scripts/signal-insights.mjs` now carry a provenance block mapping
`rule: <id>` → playbook file, so a card's evidence row leads to the method
instead of ending at a threshold. Crystallization runs both directions: a
captured method becomes a rule, and a rule that fires cites the method that says
what to do about it.

**Delta 2026-07-31 — the first playbook to get a table.** `reclamation-pipeline`
crystallized one step further: its step-7 touch log is now
`db/migrations/0015_reclamation_targets.sql`, filled by
`scripts/reclamation-import.mjs`, read as the property page's Link outreach
funnel, and watched by a twenty-first rule (`reclamation-match`). The method text
is unchanged — a playbook earns a table when its log is the thing that makes its
own decision rules enforceable, and a campaign with no conversion rate cannot
run the abandonment rule it already documents.

## Integrations this adds ([doc 11](11-integrations.md) rows)

Web search API (grounded scouting), deep-research tooling (bounded, budgeted
runs for lane-1/3/5 investigations), Google Trends (demand timing), Wayback /
End-of-Term archives (orphaned-demand mining), update/volatility trackers,
marketplace feeds (acquisition watch — low cadence). Each with the standard
catalog entry: cost model, quota, degradation, and the rule that scouts cite
what they fetched.

## Cadence & phase fit

Lanes 2 and 6 are near-free and start in Phase 2 with the first sweeps; lanes
1/3/4 are weekly-to-monthly budgeted runs from Phase 2–3; lane 5 is quarterly.
The scout-ROI review joins the quarterly Learn cycle. Phase exits already
require a Learn artifact per phase ([doc 07](07-roadmap.md)); from Phase 3 the
playbook is that artifact's natural home.
