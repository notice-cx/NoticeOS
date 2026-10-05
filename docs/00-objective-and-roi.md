# 00 — Objective & the ROI ledger

*The keystone doc. Everything else in this repo is machinery for the sentence
below; if a design choice doesn't serve it, the choice is wrong.*

## The objective

> **Continuously improve the ROI of the assets under management, with as little
> operator oversight as each change class has earned.**

Three words carry the load:

- **ROI** — a return computed from dollar-valued contribution and fully-loaded
  cost, not proxy signals. Traffic, positions, and engagement are *inputs* the
  system may optimize only insofar as they provably feed the ledger (§below).
  Most-visited ≠ highest-grossing.
- **Continuously** — a closed loop, not a pipeline. The system must measure the
  realized outcome of its own actions and use the gap between predicted and
  realized value to improve its next decision ([doc 01](01-architecture.md),
  [doc 03](03-attribution.md)).
- **Earned oversight** — autonomy is a per-change-class dial opened by evidence
  and closed automatically by failure ([doc 05](05-execution-and-accountability.md)).
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
- **Risk-adjusted asset value** — the design's 2026-07-03 working assumption
  was **~24–40× monthly net profit**. That market range is a dated STATE input,
  not a permanent rule: re-verify it before each scoring-policy version that
  uses asset value. Heavily discount any current multiple for
  **traffic-source concentration** (85%+ Google-organic + single revenue stream
  trades at the bottom of the range and is "very hard to sell" — the #1
  devaluation factor and the portfolio's dominant correlated risk). So value
  creation counts twice: raising profit AND diversifying its sources; a change
  that adds $50/mo of algorithm-fragile revenue is worth less than one that adds
  $50/mo of email/direct/subscription revenue, and the scoring function prices
  that ([doc 04](04-decision-policy.md)).
- **Fully-loaded system cost** — the side v1 of these docs didn't have:
  - agent inference (tokens per proposal/build/verify run, metered per change —
    *not yet: nothing in the OS calls a model, so this arrives as an imported
    monthly cost row, see principle 5*),
  - external API spend (SEO data, search-console quotas),
  - infrastructure (negligible today; still on the ledger),
  - **operator minutes, priced explicitly** (config: `OPERATOR_RATE`,
    default-high on purpose — if a change needs 30 min of review to win $2/mo,
    the ledger must say so),
  - OS overhead (crons, storage, the Tower), allocated across assets.

## The ledger

One append-only record per asset, with three kinds of entry: revenue, cost and
change ([D36](../config/decisions.md)); the shared substrate every loop stage
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

**One change, one id, three views** (so builders don't model it thrice):
Decide creates the hypothesis card (status `ranked`), and the card's id is
the change's id from then on. When the change ships, the ledger books its
change entry under that id (the accounting view above, D36); the registry row
is the Tower's post-ship view of it (doc 10), and every cost spent on the
change names the same id. The entry freezes the prediction the change shipped
with (D38): the card can be edited until then, the entry never. The kill
criterion is the change's watch window ([doc 03](03-attribution.md)), not
part of the entry. What happens to the change afterwards (its revert, its
realized value) is a new entry that supersedes it and repeats its
prediction, so the chain's newest entry is the change's current record. A
change entry books no money and the P&L never counts it: the revenue a change
earns is already booked as revenue, and the entry only attributes it.

**State, 2026-09-30:** the Postgres model ([`db/postgres/`](../db/postgres/README.md))
books a change entry's site, the month it shipped, its class, its id and the
prediction it shipped with, and no amount (D38). No code books a change entry
yet, and the realized value has no lane until doc 03's attribution is built.

### Booking rules (the honesty core)

1. **Measured lift only enters via [doc 03](03-attribution.md)'s methods.**
   A change without a valid control/holdout is booked `unmeasured` — with its
   pre-ship rubric score recorded — never at its eyeballed lift. (At this
   portfolio's traffic, most individual changes ARE unmeasured; pretending
   otherwise is how an optimizer hill-climbs on noise.)
2. **No raw-lift banking from underpowered winners.** Significant-looking
   results from low-power tests overstate true effects up to ~10× and get the
   sign wrong ~1 in 4 times (winner's curse / Type-M, Gelman & Carlin). Realized
   values are shrunk toward the change-class prior (empirical Bayes) and stored
   as intervals, not points.
3. **The program, not the change, is the honest ROI unit.** Individual entries
   roll up to change-class and asset level; the number the operator steers by is
   the program-level P&L, where small effects aggregate into measurable ones.
4. **Prediction is mandatory, and the gap is the product.** Every change carries
   `predicted` at intake, and its ledger entry freezes it at ship (D38), so
   grading reads the prediction as it shipped, never a later edit.
   Predicted-vs-realized calibration per change class is
   what the Learn stage feeds on ([doc 01](01-architecture.md)) — it is the
   mechanism that makes improvement *continuous* rather than episodic.
5. **The system bills itself.** Every agent run logs its inference cost against
   the change (or against `os-overhead` for sweeps). The OS's own
   cost-per-shipped-retained-improvement is a first-class Tower metric
   ([doc 06](06-operations.md)); an optimizer that costs more than it returns
   gets caught by its own ledger.
   **State, 2026-09-05:** it does not bill itself yet, and nothing pretends
   otherwise. No process in this repo calls a model — the analyzer is
   rule-based and every model call happens in a Claude Code session billed
   outside the OS — so inference reaches the ledger only as a monthly
   `os-overhead` cost row somebody imports, never metered per run. The monthly
   inference cap was withdrawn for exactly that reason (D6, bead `ro-uj7x`);
   this principle returns to force the day the OS makes a model call of its
   own. The data plane already works this way and keeps its fail-closed cap.

## Near-term ROI levers already visible in the ledger frame

Grounding, so the first backlogs rank against real numbers:

- **Ad-network eligibility is the single largest step function.** Raptive now
  admits at 25k PV/mo (≥50% tier-1 for the 25k–100k band); Mediavine Journey at
  1k sessions with an "Official" tier at $5k annual ad revenue. Managed-network
  RPMs (~$11–15 typical, $30–50+ in strong niches/Q4) are multiples of AdSense.
  Portfolio assets at 10k–100k PV/mo are *inside* eligibility today.
- **Affiliate is declining/volatile at the Amazon end** (rate cuts up to 50%,
  degraded reporting, 60-day payment lag — and the portfolio's own measured
  $2.92 experiment). Favor higher-EPC direct programs, contextually placed;
  treat affiliate forecasts with a wide interval.
- **Subscriptions/licensing are the concentration hedge** — the revenue families
  the asset-value discount rewards most.
- **The structural edge is agent economics — if quality holds.** A landed agent
  change costs **~$17–25 fully loaded** at realistic autonomous success rates
  (~$1–10/attempt × 20–30% landing, before review loops improve it). Against the
  $24–40× value conversion, a change adding even **$2/mo of durable net profit
  pays for itself in enterprise value on landing day** — converting marginal
  improvements (EV $1–5/mo) from unbuildable-by-humans to profitable. The hard
  constraint: this only holds under the quality gates of
  [doc 04](04-decision-policy.md) — scaled low-quality output is the documented
  deindexing profile that zeroes the whole asset, and "information/tools"
  category pages are already among the most AIO-exposed.

## What this doc forbids

- Optimizing any signal that lacks a written causal path to a ledger family.
- Reporting system success in changes shipped, PRs opened, or positions gained.
  Those are activity metrics; the Tower's headline is reconciled net P&L, with
  ROI and retained-improvement-per-operator-minute in decision-grade
  drill-downs.
- Booking asset-value gains from traffic that increases concentration risk
  without a corresponding discount.
