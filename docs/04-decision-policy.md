# 04 — Decision policy & context

*For an optimizer with little oversight, the ranking function is the core of
the product. If it is left as "scored on value/effort", the real policy is
whatever order an agent happened to produce: not visible, not versioned and
not auditable. This doc defines it explicitly, versions it and makes it the
subject of the Learn stage.*

## The scoring function (policy v1.0 — versioned, logged on every ranking)

Every backlog item enters with a **hypothesis card**: predicted Δ ledger value
(with a named revenue family and causal path), P(success), fully-loaded cost
(inference + operator minutes at `OPERATOR_RATE`), time-to-signal, change-class,
measurability tier ([doc 03](03-attribution.md)), and **kill criterion
(state + date)**, registered as the change's watch window when it ships. An
item without a card is not ranked. Cards come from three sources:
scheduled sweeps of the assets' own signals and anomalies, the operator, and
**scouting sweeps** of outside sources ([doc 13](13-opportunity-scouting.md));
cards from scouting record their sources and may have a **`window`**
(opens/closes + decay) — the score is multiplied by a decay factor as the
window closes, and a card with a window may skip the batch schedule but never
the intake requirements.

```
score = (P_success × ΔV_predicted × F) / C_fully_loaded / max(T_signal, 2wk)
```

- **ΔV_predicted** — dollars per month + the enterprise-value delta that
  implies (24–40× durable monthly profit; concentration-discounted per
  [doc 00](00-objective-and-roi.md)).
- **F — forecastability multiplier** (0.5–1.2): revenue durability and source
  diversity. A gain that depends on a search algorithm scores below a durable
  gain with the same EV; the Onfolio case shows that the variance of a revenue
  stream is an allocation criterion, not a minor detail.
- **C** includes the predicted *review* minutes — review time, the scarcest
  resource, has a price, so ten trivial PRs no longer outrank one batch that
  includes its own verification.
- **T_signal** discounts long-delay bets (WSJF's cost-of-delay shape).
- **P_success priors come from the ledger**, per change-class, updated by
  Learn from the calibration report. This closes the loop: the system's
  estimates are graded against outcomes and the grading changes the estimates.
- **The card is editable until the change ships.** Its change entry then
  records ΔV per month, P_success, C and T_signal as they stood, and
  grading uses those values, never a later edit.

**Where the card is today.** A task carries its card in its metadata as
`noticeos_card`, and its change-class as `noticeos_change_class`
([the fields and their limits](../config/beads.README.md#what-a-task-is-worth)).
An agent writes both through the task tools' `card` and `change_class`
arguments on `create_task`, `create_tasks` and `update_task`; the operator
writes them in the Tower's New task and on a task's page under "Why it
ranks". The Tower ranks the operator's decisions and the agents' ready work
with policy v1.0 on every read of the tasks, pricing review minutes at the
installation's `operator_rate_usd_per_min` (Settings' "Value of your time");
build minutes are shown beside the score and not priced, and a task without a
card is listed after the ranked ones with no score. When a task with a card
closes as done, through the task tools, the hosted Tasks API or the Tower's
task lane, the server keeps the card as it stood in the task's metadata as
`noticeos_card_shipped`, with the close time and the commit the close reason
names; the task's page shows those figures with **as shipped** and the day,
and from then on every writer stops a change to that task's card, also after
the task is reopened. A close with any other resolution keeps no card. Not
built yet: the change entry. No code books a `change` row in
`ledger_entries`, so the figures as they stood at ship are recorded on the
task and not in the ledger, and nothing grades a prediction yet. When the
booking is built, it reads the entry's prediction from the shipped card: ΔV
per month from `valuePerMonth` in minor units, P_success from `likelihood`,
C from `reviewMinutes` at the operator rate, and T_signal from
`daysToSignal`. Also not built: the scheduled batch reallocation below, so
the ranking is the live order and no batch is planned from it.

**Why not a live bandit:** SEO/revenue rewards arrive over weeks-to-months;
at that delay, online bandit algorithms get too little feedback and end up
optimizing noise. This policy is EV-scored batch prioritization with
**scheduled reallocation** on the attribution schedule: it uses the bandit
approach (posterior-weighted, with protected exploration) but runs in batches.

## Portfolio allocation

- One queue across assets; scores are cross-asset comparable because they're
  denominated in dollars.
- **The explore sleeve: 15% of build capacity** (config), reserved for
  speculative, asymmetric bets that rank low on EV because of low P_success —
  justified as value-of-information and by the innovation-portfolio finding
  that the small transformational sleeve produces a disproportionate share of
  long-run returns. Sleeve bets require explicit kill criteria and bounded cost.
- **Concentration risk is a standing portfolio input:** the asset-level
  Google-organic share and single-revenue-family share appear on every Tower
  view; diversification work gets F > 1.
- **Kill criteria are pre-committed and automated.** Every bet's state+date is
  checked by cron; when the date passes, the bet is parked automatically and
  closed out in the ledger (sunk cost does not count in later decisions).
  Asset-class-level kill criteria exist too (the "content-asset
  forecastability" question is periodically re-evaluated for every asset, with
  numbers).

## Goodhart guards (the constraints that make optimization safe to run)

Goodhart's law: once a metric becomes the target of optimization, it stops
being a reliable measure of the goal. The evidence is unambiguous: no proxy is
immune to gaming; frontier agents game gameable harnesses at 25–100% rates;
instructions do not prevent it, structural constraints do.

1. **Guarded metric bundles.** No target metric may be optimized without its
   paired counter-metrics: traffic ↔ thin-page ratio + originality gate;
   CTR ↔ post-click engagement + brand-rule compliance; RPM ↔ retention +
   CWV floor; positions ↔ revenue-per-session. Divergence between a rising
   proxy and flat/falling counter-metrics **freezes the change class** and
   sends the case to the operator, so reward hacking is detected while it
   happens.
2. **Hard invariants, not scoring terms** (blocking, non-negotiable, and
   enforced outside agent write scope where possible): brand/legal rules from
   context packs; no near-duplicate/scaled output; publishing-velocity caps per
   asset (the scaled-content abuse penalty depends on the *proportion* of
   low-value pages and applies to the whole domain, which can destroy the
   asset's value);
   churn caps per surface (frequent title changes look like manipulation to
   search engines and make measurement impossible); analytics/
   consent/holdout/guardrail-threshold code is operator-only.
3. **A sudden gain triggers a review.** A sudden jump in gains from scaled
   changes is flagged for review, not treated as success: the same kind of
   change that makes a proxy jump is what Google's SpamBrain detects.
4. **Rules for LLM judges.** Rubric-scoring LLMs are calibrated against
   operator-labeled anchors, are never from the same run that authored the
   change, and are stress-tested before their scores are relied on
   ([doc 05](05-execution-and-accountability.md)).

## Context packs

Two tiers: per-asset `AGENTS.md` (positioning, brand and
legal rules, do-not-touch, CI bar, deploy model, conventions) and the portfolio
context in NoticeOS (current focus, scoring config, global guardrails).

**The staleness mechanism** (the facts in a pack become inaccurate within
hours of being written unless they carry dates):

- `AGENTS.md` contains `reviewed: <date>`, so a reader knows how old its facts
  are; the pack is dated, with facts separated from rules.
- **Stable rules vs volatile state are separated.** Rules (brand, never-do,
  conventions) are in `AGENTS.md`; volatile facts (application states,
  pending reviews, temporary holds, dated postures) are in a `STATE` section
  with per-entry expiry dates — expired entries are treated as unknown, not as
  true.
- **Drift detection:** post-incident rules ([doc 05](05-execution-and-accountability.md))
  are added to the pack via PR; a quarterly pack review is a scheduled, ledger-
  costed task. One canonical source: what agents note in memory is written
  into the pack, and agents follow the pack, not memory or unwritten team
  knowledge. When the two conflict, the pack applies until it is amended.

## Operator overrides (first-class inputs, not exceptions)

In the queue ([doc 10](10-control-tower.md)) the operator can approve, boost,
veto (reason required), edit, or park any card, and can hold a change in a
T2+ class before it ships. Every override is recorded against the card and the
scoring-policy version that ranked it. **Vetoes and boosts are a primary input
to the Learn stage**: a class the operator keeps vetoing has a miscalibrated
value model or a missing constraint, and the quarterly policy revision must
fix the cause of the pattern, not only record the labels. Hypothesis cards
must list their data sources from the integrations catalog ([doc 11](11-integrations.md)) — a card
whose evidence can't be shown in the "why this rank" expander fails intake.

## What Learn changes here

Quarterly (or after every 20 closed changes per class): P_success priors re-fit
from realized outcomes; F multipliers re-examined against revenue durability;
surrogate metrics re-validated or retired; scoring-policy version bumped with a
changelog entry — the policy itself is under version control and its diffs are
annotations on every asset timeline.
