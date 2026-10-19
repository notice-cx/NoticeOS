# 00 — Objective & the ROI ledger

*This doc states the objective. Everything else in this repo exists to
achieve the sentence below; a design choice that does not help achieve it is
wrong.*

## The objective

> **Continuously improve the ROI of the assets under management, with as little
> operator oversight as each change class's track record allows.**

Three parts of that sentence need definition:

- **ROI** — a return computed from dollar-valued contribution and fully-loaded
  cost, not proxy signals. Traffic, positions, and engagement are *inputs* the
  system may optimize only insofar as they are shown to change a ledger amount
  (see below). The most-visited asset is not necessarily the highest-earning one.
- **Continuously** — a closed loop, not a pipeline. The system must measure the
  realized outcome of its own actions and use the gap between predicted and
  realized value to improve its next decision ([doc 01](01-architecture.md),
  [doc 03](03-attribution.md)).
- **Oversight set by track record** — autonomy is a per-change-class setting,
  raised on evidence and lowered automatically after a failure
  ([doc 05](05-execution-and-accountability.md)).
  The operator's review minutes are the portfolio's scarcest resource; the
  system's core efficiency metric is **retained improvement per operator-minute**,
  and a system that routes every change through four manual steps has failed the
  objective regardless of how good the changes are.

## Value contribution and ROI, defined

Per asset, per period:

```
value contribution ($) =
  Δ net revenue + Δ risk-adjusted asset value − fully-loaded system cost

ROI ratio =
  value contribution / fully-loaded system cost
```

The dollar-valued first quantity is what the ledger attributes. The ratio is
reported only when its cost denominator exists and the comparison is useful.
Monthly net P&L is neither quantity; the Tower labels it **Net P&L**, not ROI.

- **Net revenue** — the money families in the signal contract
  ([doc 02](02-signal-contract.md)): display ads (RPM × monetizable sessions),
  affiliate commissions, subscriptions, licensing. Booked from payout/reporting
  APIs and platform exports, not inferred from traffic.
- **Risk-adjusted asset value** — the working assumption is **~24–40× monthly
  net profit**. That market range is a market input, not a permanent rule:
  re-verify it before each scoring-policy version that uses asset value.
  Heavily discount any current multiple for
  **traffic-source concentration** (85%+ Google-organic + single revenue stream
  trades at the bottom of the range and is "very hard to sell" — the #1
  devaluation factor and the portfolio's dominant correlated risk). So value is
  created in two ways: raising profit AND diversifying its sources; a change
  that adds $50/mo of algorithm-fragile revenue is worth less than one that adds
  $50/mo of email/direct/subscription revenue, and the scoring function accounts
  for that difference ([doc 04](04-decision-policy.md)).
- **Fully-loaded system cost**:
  - agent inference (tokens per proposal/build/verify run, metered per change —
    *not yet: nothing in the OS calls a model, so this is recorded as an
    imported monthly cost row, see principle 5*),
  - external API spend (SEO data, search-console quotas),
  - infrastructure (negligible today; still on the ledger),
  - **operator minutes, priced explicitly** (config: `OPERATOR_RATE`,
    default-high on purpose — if a change needs 30 min of review to gain
    $2/mo, the ledger must show that cost),
  - OS overhead (crons, storage, the Tower), allocated across assets.

## The ledger

One append-only record per asset, with three kinds of entry: revenue, cost and
change; the shared record every loop stage
reads and writes ([doc 01](01-architecture.md)). A booked entry never changes:
a correction is a new entry that supersedes it.

```jsonc
// ledger entry classes
{ "kind": "revenue",  "asset": "…", "period": "2026-07", "family": "ads|affiliate|subs|licensing", "amount": 0, "source": "raptive-report|cj-export|…" }
{ "kind": "cost",     "asset": "…", "period": "2026-07", "family": "inference|api|infra|operator|os-overhead", "amount": 0, "ref": "change-id|run-id" }
{ "kind": "change",   "id": "…", "asset": "…", "period": "2026-07", "class": "content-data|copy|template|feature|infra",
  "currency": "USD", "predicted": { "valuePerMonth": 0, "p": 0.0, "cost": 0, "daysToSignal": 42 } }
// later, superseding it: the same change and prediction, plus
//   "realized": { "value": …, "interval": …, "method": "cohort-test|holdout|unmeasured" }
```

**One change, one id, three views** (so builders model it once):
Decide creates the hypothesis card (status `ranked`), and the card's id is
the change's id from then on. When the change ships, its change entry is
booked in the ledger under that id (the accounting view above); the registry
row is the Tower's post-ship view of it (doc 10), and every cost spent on the
change records the same id. The entry records the prediction as it stood at
ship time: the card can be edited until then, the entry never. The kill
criterion is the change's watch window ([doc 03](03-attribution.md)), not
part of the entry. What happens to the change afterwards (its revert, its
realized value) is recorded as a new entry that supersedes it and repeats its
prediction, so the chain's newest entry is the change's current record. A
change entry has no amount and the P&L never includes it: the revenue a change
brings in is already booked as revenue, and the entry only attributes it.

**State:** the Postgres model ([`db/postgres/`](../db/postgres/README.md))
stores a change entry's site, the month it shipped, its class, its id and the
prediction it shipped with, and no amount. No code books a change entry
yet, and nothing records the realized value until doc 03's attribution is
built.

### Booking rules

1. **A measured lift is booked only through [doc 03](03-attribution.md)'s methods.**
   A change without a valid control/holdout is booked `unmeasured` — with its
   pre-ship rubric score recorded — never at a lift estimated by looking at a
   chart. (At this portfolio's traffic, most individual changes ARE
   unmeasured; booking them as measured would make the optimizer select
   changes based on random noise.)
2. **The raw lift of an underpowered test is never booked.** Significant-looking
   results from low-power tests overstate true effects up to ~10× and get the
   sign wrong ~1 in 4 times (winner's curse / Type-M, Gelman & Carlin). Realized
   values are shrunk toward the change-class prior (empirical Bayes) and stored
   as intervals, not points.
3. **ROI is measured per program, not per change.** Individual entries
   roll up to change-class and asset level; the number the operator uses for
   decisions is the program-level P&L, where many small effects add up to a
   measurable one.
4. **A prediction is mandatory, and the gap between predicted and realized
   value is the key output.** Every change carries `predicted` at intake, and
   its ledger entry fixes it at ship, so grading uses the prediction as it
   shipped, never a later edit. Predicted-vs-realized calibration per change
   class is the input to the Learn stage ([doc 01](01-architecture.md)), and it
   is what makes improvement *continuous* rather than occasional.
5. **The system records its own cost.** Every agent run logs its inference
   cost against the change (or against `os-overhead` for sweeps). The OS's own
   cost-per-shipped-retained-improvement is a primary Tower metric
   ([doc 06](06-operations.md)); an optimizer that costs more than it returns
   shows a loss in its own ledger.
   **State:** it does not meter its own inference cost per run. No
   process in this repo calls a model — the analyzer is rule-based and every
   model call happens in an agent session billed outside the OS — so
   inference enters the ledger as monthly `inference` cost rows a person
   imports from the provider's usage export with `pnpm cost:import-inference`
   ([guide](guides/record-revenue-and-costs.md#import-inference-costs)), never
   metered per run. There is no monthly inference
   cap for the same reason; this rule takes effect again from the day the OS
   makes a model call of its own. The data plane already works this way and
   keeps its fail-closed cap.

## Near-term ROI opportunities, in ledger terms

These facts give the first backlogs real numbers to rank against:

- **Qualifying for a managed ad network is the largest single jump in
  revenue.** Raptive now admits at 25k PV/mo (≥50% tier-1 for the 25k–100k band); Mediavine Journey at
  1k sessions with an "Official" tier at $5k annual ad revenue. Managed-network
  RPMs (~$11–15 typical, $30–50+ in strong niches/Q4) are multiples of AdSense.
  Portfolio assets at 10k–100k PV/mo already meet these thresholds.
- **Affiliate revenue from Amazon is declining and volatile** (rate cuts up to
  50%, degraded reporting, 60-day payment lag). Favor higher-EPC direct
  programs, contextually placed; treat affiliate forecasts with a wide
  interval.
- **Subscriptions and licensing lower concentration risk** — of all revenue
  families, they reduce the asset-value discount the most.
- **Agent-built changes are cheap, if their quality stays high.** A merged
  agent change costs **~$17–25 fully loaded** at realistic autonomous success
  rates (~$1–10/attempt × 20–30% of attempts merged, before review improves
  that rate). At the 24–40× value multiple, a change adding even **$2/mo of
  durable net profit adds more enterprise value than it cost on the day it
  merges**. That makes small improvements (EV $1–5/mo), which are not worth a
  person's time to build, profitable. The hard constraint: this holds only
  under the quality gates of [doc 04](04-decision-policy.md). Publishing
  low-quality content at scale is the documented pattern that gets a site
  deindexed and takes the whole asset's value to zero, and "information/tools"
  category pages are already among the pages most exposed to AI Overviews
  (AIO).

## What this doc forbids

- Optimizing any signal that lacks a written causal path to a ledger family.
- Reporting system success in changes shipped, PRs opened, or positions gained.
  Those are activity metrics; the Tower's main figure is reconciled net P&L,
  with ROI and retained-improvement-per-operator-minute in the detail views
  used for decisions.
- Booking asset-value gains from traffic that increases concentration risk
  without a corresponding discount.
