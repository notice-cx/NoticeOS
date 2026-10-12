# 07 — Roadmap

*The phases follow the stages of the loop, and every exit criterion is a
number: criteria such as "consistently useful," "healthy accept rate," and "no
prod incidents" would leave the most consequential decisions to subjective
judgement. Each phase ships something useful on its own, and each phase adds a
**Learn artifact**: from day one the system is graded on whether its
predictions about what works come true, not only on whether it runs.*

## Phase 0 — Ledger + contract on two nodes

Repo, central store, Tower shell behind CF Access, GitHub App. The first
two sites send contract-compliant reports; revenue & cost ingestion live (even
if revenue is "AdSense + CJ exports" initially); `OPERATOR_RATE` set; both
assets' `AGENTS.md` written dated, with facts separated from rules.

**Exit (all numeric):** 2 assets × 14 consecutive days of reports with zero
ingest-freshness flags; the ledger has revenue + cost rows for a full calendar
month; NoticeOS's own report live.
**Learn artifact:** the first monthly P&L per asset, however small.

## Phase 1 — Tower + attribution primitives

Portfolio views (P&L, concentration risk, flags with volume-aware rules,
deferral list), annotations recorded (deploys from both assets' CI,
external calendar), the broad DataForSEO ranking/link/LLM archive in place and
tracked device-specific SERP panels ported where justified, and the
**attribution toolkit**:
page-cohort bucketing tooling, holdout designation (outside agent write
scope), the update-calendar overlay.

**Exit:** a designated long-horizon holdout exists on ≥1 large corpus; one
Tier-A cohort test has run end-to-end (any subject) with a booked result that
includes a confidence interval; flag false-positive rate < 20% over 4 weeks
(operator-graded).
**Learn artifact:** the first calibration entry — predicted vs realized for
that first cohort test.

## Phase 2 — Decide: scored backlog

The scoring policy v1.0 implemented; hypothesis cards required; sweeps
(weekly + event-driven) produce ranked, cross-asset backlogs; explore sleeve
and kill-criterion automation live. A person triages the backlog: this phase
measures whether the ranking is reliable enough to act on, not whether
automated building is.

**Exit:** over 6 weeks, ≥40% of top-decile items are actioned by the operator
(action = built manually, dispatched, or explicitly parked with reason);
≤10% of cards fail intake validation (missing causal path / kill criterion);
scoring-policy version log exists with ≥1 Learn-driven revision.
**Learn artifact:** P_success priors per change-class seeded from the first
20+ closed cards.

## Phase 3 — Act at T1 (build + verify + PR)

Builder and independent verifier running under task contracts and
claims-as-artifacts; reliability ledger recording; budgets enforced at the
gateway (fail-closed, on by default); weekly review block; random audit
sampling ≥10%.

**Exit (per asset, per change-class, before T2 is considered):** ≥20
consecutive verified merges; ≥90% accepted without substantive rework (≤10
changed lines post-review, median); 0 sev-1 and ≤1 sev-2 in 8 weeks; verifier
catches ≥1 injected fault in a scheduled red-team drill (proof that
verification catches faults); cost-per-landed-change tracked and within the
class's predicted band.
**Learn artifact:** reliability-ledger baseline per agent-class; first
audit-cycle report.

## Phase 4 — T2 for the first change class

Auto-merge + outcome-watch + auto-revert for the single class with the best
record (likely `content-data` on the most-tested asset). Canary/watch windows
per class; revert drill executed successfully before enablement, not after.

**Exit:** 12 weeks at T2 with 0 sev-1; auto-revert fired correctly on ≥1 real
or injected regression; class ledger-positive including all system costs;
operator review minutes for the class down ≥70% vs Phase 3 with
retained-improvement flat or up.
**Learn artifact:** the class's calibration curve (predicted vs realized)
with error bounds narrowing across the phase.

## Phase 5 — Widen, or stop

Additional classes/assets move up the same autonomy ladder against the same
numbers. T3 only for classes with proven auto-revert, stable calibration, and
a full year of history. This phase is also where the **portfolio kill
criteria** get their first scheduled review.

## Standing kill criteria (state + date, pre-committed, applied to NoticeOS itself)

- If by **two quarters after Phase 3**, cost-per-landed-change × landed
  changes exceeds the ledger value they created (system ROI-negative and the
  trend isn't improving) → pause Act, keep Sense/Attribute running (the Tower
  alone is worth its cost), and reconsider the approach.
- If the calibration error per class isn't decreasing after 3 Learn cycles →
  predictions are not improving; stop extending autonomy until they do.
- If operator review minutes aren't falling by Phase 4 → the system is a tool
  that makes the operator more productive, not an autonomous optimizer;
  re-scope the product to match.

## Product scope

Selling NoticeOS is deferred until portfolio ROI and inbound demand are
demonstrated. Open-source readiness includes hosted tenant isolation and a
real public demo workspace. Customer onboarding is initially invitation-only;
public demo exploration is read-only. [Doc 23](23-configuration-ownership.md)
defines the trust boundary. None of this adds billing or authorizes public
production activation. The portfolio ROI and autonomy gates above remain.
