# 07 — Roadmap

*v2. Phases re-cut against the loop, and every exit criterion is now a number —
v1's "consistently useful," "healthy accept rate," and "no prod incidents"
gated the most consequential decisions on feel. Each phase still ships
something independently useful, and each phase adds a **Learn artifact**: from
day one the system is graded on whether it knows what works, not only on
whether it works.*

## Phase 0 — Ledger + contract on two nodes

Repo, central store, Tower shell behind CF Access, GitHub App. The first
two sites emit contract-compliant pulses; revenue & cost ingestion live (even
if revenue is "AdSense + CJ exports" initially); `OPERATOR_RATE` set; both
assets' `AGENTS.md` written with `reviewed:` dates and STATE separation.

**Exit (all numeric):** 2 assets × 14 consecutive days of pulses with zero
ingest-freshness flags; ledger shows revenue + cost rows for a full calendar
month; asset #0 pulse live.
**Learn artifact:** the first monthly P&L per asset, however humble.

## Phase 1 — Tower + attribution primitives

Portfolio views (P&L, concentration risk, flags with volume-aware rules,
deferral registry), annotations flowing (deploys from both assets' CI,
external calendar), the broad DataForSEO ranking/link/LLM archive landed and
tracked device-specific SERP panels ported where justified, and the
**attribution toolkit**:
page-cohort bucketing tooling, holdout designation (outside agent write
scope), the update-calendar overlay.

**Exit:** a designated long-horizon holdout exists on ≥1 large corpus; one
Tier-A cohort test has run end-to-end (any subject) with a booked,
interval-carrying result; flag false-positive rate < 20% over 4 weeks
(operator-graded).
**Learn artifact:** the first calibration entry — predicted vs realized for
that first cohort test.

## Phase 2 — Decide: scored backlog

The scoring policy v1.0 implemented; hypothesis cards required; sweeps
(weekly + event-driven) produce ranked, cross-asset backlogs; explore sleeve
and kill-criterion automation live. Human triages — this phase measures
whether the ranking is worth trusting, not whether building is.

**Exit:** over 6 weeks, ≥40% of top-decile items are actioned by the operator
(action = built manually, dispatched, or explicitly parked with reason);
≤10% of cards fail intake validation (missing causal path / kill criterion);
scoring-policy version log exists with ≥1 Learn-driven revision.
**Learn artifact:** P_success priors per change-class seeded from the first
20+ closed cards.

## Phase 3 — Act at T1 (build + verify + PR)

Builder and independent verifier live under task contracts and
claims-as-artifacts; reliability ledger recording; budgets enforced at the
gateway (fail-closed, on by default); weekly review block; random audit
sampling ≥10%.

**Exit (per asset, per change-class, before any T2 talk):** ≥20 consecutive
verified merges; ≥90% accepted without substantive rework (≤10 changed lines
post-review, median); 0 sev-1 and ≤1 sev-2 in 8 weeks; verifier catches ≥1
injected fault in a scheduled red-team drill (proof the net works);
cost-per-landed-change tracked and within the class's predicted band.
**Learn artifact:** reliability-ledger baseline per agent-class; first
audit-cycle report.

## Phase 4 — T2 for the first change class

Auto-merge + outcome-watch + auto-revert for the single strongest class
(likely `content-data` on the most-tested asset). Canary/watch windows per
class; revert drill executed successfully before enablement, not after.

**Exit:** 12 weeks at T2 with 0 sev-1; auto-revert fired correctly on ≥1 real
or injected regression; class ledger-positive including all system costs;
operator review minutes for the class down ≥70% vs Phase 3 with
retained-improvement flat or up.
**Learn artifact:** the class's calibration curve (predicted vs realized)
with error bounds tightening across the phase.

## Phase 5 — Widen, or stop

Additional classes/assets climb the same ladder on the same numbers. T3 only
for classes with proven auto-revert, stable calibration, and a full year of
history. This phase is also where the **portfolio kill criteria** get their
first scheduled review.

## Standing kill criteria (state + date, pre-committed — the system applies
its own medicine to itself)

- If by **two quarters after Phase 3**, cost-per-landed-change × landed
  changes exceeds the ledger value they created (system ROI-negative and the
  trend isn't improving) → freeze Act, keep Sense/Attribute (the Tower alone
  is worth its cost), rethink.
- If the calibration error per class isn't tightening after 3 Learn cycles →
  the loop isn't learning; stop widening autonomy until it does.
- If operator review minutes aren't falling by Phase 4 → the system is a
  human-amplifying tool, not an autonomous optimizer; re-scope honestly.

## Product scope

The original roadmap deferred selling NoticeOS until demonstrated portfolio
ROI and inbound demand. The owner expanded open-source readiness on 2026-10-01
to include hosted tenant isolation and a real public demo workspace (D39).
Customer onboarding is initially invitation-only; public demo exploration is
read-only. [Doc 23](23-configuration-ownership.md) defines the trust boundary,
and `ro-ujb9.289` carries implementation. This does not add billing or authorize
public production activation. The portfolio ROI and autonomy gates above remain.
