# 04 — Decision policy & context

*v2 — absorbs v1's context-packs doc and adds the part v1 referenced twice and
specified zero times: the actual ranking policy. For a low-oversight optimizer
the ranking function IS the product; leaving it as "scored on value/effort"
means the real policy is whatever order an agent happened to emit — invisible,
unversioned, unauditable. This doc makes it explicit, versioned, and the
subject of the Learn stage.*

## The scoring function (policy v1.0 — versioned, logged on every ranking)

Every backlog item enters with a **hypothesis card**: predicted Δ ledger value
(with a named revenue family and causal path), P(success), fully-loaded cost
(inference + operator minutes at `OPERATOR_RATE`), time-to-signal, change-class,
measurability tier ([doc 03](03-attribution.md)), and **kill criterion
(state + date)**, registered as the change's watch window when it ships —
no card, no ranking. Cards arrive from three sources:
inward sweeps (asset signals/anomalies), the operator, and the **outward scout
lanes** ([doc 13](13-opportunity-scouting.md)); scout-sourced cards carry
provenance and may carry a **`window`** (opens/closes + decay) — the score
gains a decay multiplier as a window closes, and window plays may jump the
batch cadence but never the intake bar.

```
score = (P_success × ΔV_predicted × F) / C_fully_loaded / max(T_signal, 2wk)
```

- **ΔV_predicted** — dollars per month + the enterprise-value delta that
  implies (24–40× durable monthly profit; concentration-discounted per
  [doc 00](00-objective-and-roi.md)).
- **F — forecastability multiplier** (0.5–1.2): revenue durability and source
  diversity. An algorithm-fragile win scores below an equal-EV durable one —
  the Onfolio lesson: variance of the stream is an allocation criterion, not a
  footnote.
- **C** includes the predicted *review* minutes — the scarcest resource is
  priced, so ten trivial PRs stop outranking one self-verifying batch.
- **T_signal** discounts long-delay bets (WSJF's cost-of-delay shape).
- **P_success priors come from the ledger**, per change-class, updated by
  Learn from the calibration report. This closes the loop: the system's
  estimates are graded against outcomes and the grading changes the estimates.
- **The card is editable until the change ships.** Its change entry then
  freezes ΔV per month, P_success, C and T_signal as they stood (D38), and
  grading reads those, never a later edit.

**Why not a live bandit:** SEO/revenue rewards arrive over weeks-to-months;
online bandits starve at that delay and chase noise. This is EV-scored batch
prioritization with **scheduled reallocation** on the attribution cadence —
bandit *mindset* (posterior-weighted, exploration-protected), batch mechanics.

## Portfolio allocation

- One queue across assets; scores are cross-asset comparable because they're
  denominated in dollars.
- **The explore sleeve: 15% of build capacity** (config), reserved for
  speculative, asymmetric bets that lose EV-ranking on P_success — justified as
  value-of-information and by the innovation-portfolio finding that the small
  transformational sleeve produces a disproportionate share of long-run
  returns. Sleeve bets require explicit kill criteria and bounded cost.
- **Concentration risk is a standing portfolio input:** the asset-level
  Google-organic share and single-revenue-family share appear on every Tower
  view; diversification work gets F > 1.
- **Kill criteria are pre-committed and automated.** Every bet's state+date is
  checked by cron; expiry → auto-park + ledger close-out (sunk cost is
  forward-looking only). Asset-class-level kill criteria exist too (the
  "content-site forecastability" question is periodically re-asked of every
  asset, with numbers).

## Goodhart guards (the constraints that make optimization safe to run)

The evidence is unambiguous: no unhackable proxy exists; frontier agents game
gameable harnesses at 25–100% rates; instructions don't fix it; structure does.

1. **Guarded metric bundles.** No target metric may be optimized without its
   paired counter-metrics: traffic ↔ thin-page ratio + originality gate;
   CTR ↔ post-click engagement + brand-rule compliance; RPM ↔ retention +
   CWV floor; positions ↔ revenue-per-session. Divergence between a rising
   proxy and flat/falling counter-metrics **freezes the change class** and
   routes to the operator — a live reward-hacking detector.
2. **Hard invariants, not scoring terms** (blocking, non-negotiable, and
   physically outside agent write scope where possible): brand/legal rules from
   context packs; no near-duplicate/scaled output; publishing-velocity caps per
   asset (scaled-content abuse is triggered by *proportion* of low-value pages
   and is an existential, whole-domain penalty); churn caps per surface
   (title-thrash reads as manipulation and destroys measurability); analytics/
   consent/holdout/guardrail-threshold code is operator-only.
3. **A sudden win is a review trigger.** Step-function gains from scaled
   changes get flagged, not celebrated — the same move that spikes a proxy is
   what SpamBrain pattern-matches.
4. **Judge hygiene.** Rubric-scoring LLMs are calibrated against operator-
   labeled anchors, are never from the same run that authored the change, and
   are stress-tested before becoming load-bearing
   ([doc 05](05-execution-and-accountability.md)).

## Context packs (carried from v1, with the staleness fix)

Two tiers, unchanged in concept: per-asset `AGENTS.md` (positioning, brand and
legal rules, do-not-touch, CI bar, deploy model, conventions) and the portfolio
context in NoticeOS (current focus, scoring config, global guardrails).

**The staleness mechanism v1 lacked** (its own invariants drifted within hours
of being written):

- `AGENTS.md` carries `reviewed: <date>`; **staleness beyond 30 days blocks the
  builder** on that asset (warn at 14).
- **Stable rules vs volatile state are separated.** Rules (brand, never-do,
  conventions) live in `AGENTS.md`; volatile facts (application states,
  pending reviews, temporary holds, dated postures) live in a `STATE` section
  with per-entry expiry dates — expired entries are treated as unknown, not as
  true.
- **Drift detection:** post-incident rules ([doc 05](05-execution-and-accountability.md))
  append to the pack via PR; a quarterly pack review is a scheduled, ledger-
  costed task. One canonical source: living memory feeds the pack; the pack —
  not memory, not tribal knowledge — is what agents obey. If they disagree, the
  pack wins until amended.

## Operator overrides (first-class inputs, not exceptions)

The queue ([doc 10](10-control-tower.md)) lets the operator approve, boost,
veto (reason required), edit, or park any card — and T2+ classes expose a
pre-ship hold. Every override is recorded against the card and the scoring-
policy version that ranked it. **Vetoes and boosts are prime Learn signal**:
a class the operator keeps vetoing has a miscalibrated value model or a
missing constraint, and the quarterly policy revision must address the
pattern, not just eat the labels. Hypothesis cards must cite their data
sources from the integrations catalog ([doc 11](11-integrations.md)) — a card
whose evidence can't be shown in the "why this rank" expander fails intake.

## What Learn changes here

Quarterly (or on every 20 closed changes per class): P_success priors re-fit
from realized outcomes; F multipliers re-examined against revenue durability;
surrogate metrics re-validated or retired; scoring-policy version bumped with a
changelog entry — the policy itself is under version control and its diffs are
annotations on every asset timeline.
