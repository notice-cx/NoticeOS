# 03 — Attribution & evaluation

*Attribution puts accurate realized values into the ledger. The Learn stage
needs those values to calibrate Decide, and that calibration is what makes
improvement continuous. Attribution is also where overstated results most
easily enter the ledger, so this doc is mostly rules that prevent that.*

## The facts behind this design

1. **At 10k–100k PV/mo, most individual changes are unmeasurable.** Detecting a
   10% relative lift requires ~tens of thousands of visitors per arm; a 1–5%
   lift, the size of most real gains, cannot be detected for a single change.
   Practitioners' minimum: ~1,000 conversions/mo per surface before per-change
   testing is worthwhile.
2. **"Wins" from underpowered tests are misleading.** At low power,
   statistically significant estimates exaggerate true effects up to ~10× and
   get the *sign* wrong ~1 in 4 times (Type-M/Type-S, Gelman & Carlin). An
   optimizer that books raw observed lifts from underpowered tests optimizes
   noise while reporting success.
3. **SEO cannot be user-randomized** — the "user" is Googlebot. The valid
   design splits *pages* into control/variant cohorts, and needs hundreds of
   comparable template pages plus (rule of thumb) ~30k organic sessions/mo to
   the tested group (SearchPilot/Etsy methodology).
4. **The confounds are bigger than the effects**: Google updates (volatility up
   even as confirmed updates dropped), seasonality, SERP-feature changes, and
   indexing lag (days-to-weeks between deploy and effect — "tests fail because
   people gave up too early").

## Measurability tiers — assigned at intake, not after the fact

Every change is classed by Decide before it ships; the class determines how its
`realized` ledger field may ever be filled.

### Tier A — cohort-testable (the strongest evidence available)
Template-level changes touching large comparable page sets (recipe corpus,
foods pages, calculator constellation, programmatic locale sets).
- **Method:** stratified bucketing (rank pages by traffic, ntile, randomize
  within tiles — Etsy's design; simple randomization fails on skewed traffic),
  a control cohort left unchanged, forecast-the-control + measure divergence
  (CausalImpact-class or DiD when seasonality dominates).
- **Discipline:** measurement window starts at **confirmed recrawl** of variant
  pages (server logs / GSC), not at deploy; 4–8 week windows; Google's testing
  rules honored (302s not 301s, rel=canonical on variants, tests bounded in
  time). If a core update is released mid-window, extend the window and use only the
  divergence from the control.
- **A surface inside a measurement window is frozen:** before the ship that
  opens the window, its readback task is filed with the surfaces, the change
  and the dates, and anyone planning a later change checks that task for the
  measurement state. No separate file lists the open windows.
- Booked: the realized Δ with a credible interval, after shrinkage (below).

### Tier B — holdout-able (site-wide changes with a control somewhere)
Site-wide changes that can be staged (half the corpus first), or where sibling
portfolio assets form a plausible control series.
- Method: DiD / CausalImpact with the held-out slice or sibling asset as
  control. Weaker than Tier A; intervals widen accordingly.
- A genuinely site-wide, no-control change is evaluated as an interrupted time
  series **with the update calendar overlaid** and is booked with an "ITS-only"
  caveat flag — or deliberately batched (below).

### Tier C — unmeasurable by design (most changes; say so)
Small copy edits, single-page fixes, hygiene, most UX polish.
- **Booked `unmeasured`, value 0, with the pre-ship rubric score recorded.**
  The rubric + leading indicators (index status, CWV, CTR direction, engagement
  events) are quality gates, not value claims.
- Tier-C changes get a measured value only through **batch rollup**: grouped by
  change-class and evaluated at program level over quarters, where small
  effects aggregate above the noise floor.

## Booking rules (enforced by the ledger)

- **Shrinkage is mandatory.** Realized estimates shrink toward the change-class
  prior (empirical Bayes); the prior comes from the class's own history. Point
  estimates are never stored without intervals.
- **Without a control there is no causal claim.** The words "this change
  drove" may be used only for Tier A/B entries. Every other entry is labelled
  "shipped; program-level".
- **The program is the unit of account.** The operator-facing number is
  P&L per change-class per asset per quarter — predicted vs realized — because
  that is the finest level at which this portfolio's results can be measured.
  The predicted side is the value each change's ledger entry recorded when it
  shipped; the realized side is a later entry that supersedes it, never an
  edit.
- **Batching makes attribution possible.** Decide deliberately groups
  same-class changes into evaluable batches (one titles-batch per corpus per
  window) instead of shipping confounded single changes one at a time: several
  workstreams shipped on one day cannot be attributed separately.
- **Long-horizon holdout.** A small permanent slice (pages or one asset surface)
  stays outside the optimizer's control to detect drift: if the short-window
  gains on the optimized pages do not show up against the holdout over
  quarters, the surrogate metrics no longer track value and the Learn stage
  must recalibrate. Holdout assignment is outside agent write scope
  ([doc 01](01-architecture.md)).
- **Surrogate validation.** Leading indicators (CTR, engagement, AIO-citation)
  are only usable in rubrics while their correlation to ledger revenue is
  periodically re-established; a surrogate that stops predicting revenue is
  removed from scoring (Facebook's MSI metric is the warning example: the
  proxy was anti-correlated with quality and nobody checked for years).

## Watch windows — pre-registration

The rules above work only if the comparison is fixed **before** the numbers
exist; a window chosen after seeing the numbers can be picked to fit any
conclusion. The `watch_windows` table plus the ingest Worker's `POST /api/watch-windows`
route and its 03:30 UTC evaluator are that pre-registration in the store: the
metric, the pre-change baseline window, the days it will be re-read
(`[7, 14, 28]`-style offsets), and the ship/kill predicate, all written down at
registration time. That predicate and those days are the change's kill
criterion; its ledger entry does not repeat them. Backdated
registration is allowed, so a batch that already shipped can still be
measured against the baseline that preceded it.

**Query scope is measured at query grain.** A GSC window may be registered with
`scope_json = {"query":"…"}`; the evaluator reads that query from the retained
provider-final daily `gsc/query` R2 objects. A missing query row is treated
as missing, not zero, and counts against the normal coverage rule. Unsupported
or malformed scopes close `unmeasurable` rather than using site-wide numbers
for a narrower question.

The registration threshold uses the same grain. The Tower loads only that
query's bounded daily archive while its composer is open and measures adjacent
baseline-length windows with the evaluator's same coverage and mean-per-observed
day arithmetic. A usable floor is shown with the query, archive span, typical
move, ninetieth percentile, and valid comparison count. With insufficient
history, the threshold stays at a 10% starting point that is shown as
uncalibrated; it never takes on the property's site-wide volatility. Both site
and query calibration read the annotation ledger independently over the full
calibration horizon and exclude every
comparison pair crossing a recorded change. If that calendar is absent or
truncated, the Tower labels the number `HISTORICAL ONLY` and never presents it
as change-filtered.

Three rules for closing a window follow directly from the facts at the top of
this doc:

- **Without a predicate there is no verdict.** With no thresholds registered
  the window closes `inconclusive` with the numbers shown. The OS does not
  produce a verdict without registered thresholds; that would be exactly the
  underpowered "win" described above.
- **Unmeasurable is a separate outcome from inconclusive.** A zero
  baseline, an empty series, or a window whose days are mostly missing closes
  `unmeasurable`. Tier C's rule (booked `unmeasured`, value 0, and labelled as
  such) applies to windows too.
- **Interim readings are recorded but close nothing.** A post window is as
  long as the baseline, so a check whose offset is shorter than the baseline
  has a post window that reaches back over the change; the check records the
  numbers and how many pre-change days the window contains, and never closes
  anything.

When a window closes, the evaluator raises a flag
(`rule_id = watch-window-closed`; `warn` for `kill_confirmed`, `info`
otherwise) with the numbers, so the operator sees the result in the existing
alert views. It does **not** yet book a realized Δ: nothing writes shrinkage,
intervals or the change-class prior described above to the ledger yet, so a
`ship_confirmed` window is evidence for the operator, not a value claim. Once
that is built, the realized value, its interval and its method will be booked
as an entry superseding the change's.

## What Attribute emits

Per evaluated change/batch: `{ method, window, control, interval, shrunk-Δ,
confounds-noted, booked }` → ledger. Per quarter: the **calibration report** —
predicted-vs-realized by change-class, the input Learn uses to adjust Decide's
priors ([doc 04](04-decision-policy.md)) and the most important chart in the
Tower, because it shows *whether the system's predictions of what works are
getting more accurate*.
