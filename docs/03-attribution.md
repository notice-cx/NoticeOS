# 03 — Attribution & evaluation

*New in v2 — the stage v1 lacked entirely (its "did it help?" was a deploy
annotation and a hopeful look at the chart 2–6 weeks later). Attribution is what
lets the ledger contain truth, which is what lets Learn calibrate Decide, which
is what makes improvement continuous. It is also where the system is most
tempted to lie to itself, so this doc is mostly rules against self-deception.*

## The uncomfortable facts this design accepts

1. **At 10k–100k PV/mo, most individual changes are unmeasurable.** Detecting a
   10% relative lift wants ~tens of thousands of visitors per arm; a 1–5% lift —
   where most real wins live — is out of reach per-change. Practitioner floors:
   ~1,000 conversions/mo per surface before per-change testing is worthwhile.
2. **Underpowered "wins" are poison.** At low power, statistically significant
   estimates exaggerate true effects up to ~10× and get the *sign* wrong ~1 in 4
   times (Type-M/Type-S, Gelman & Carlin). An optimizer that banks raw observed
   lifts from underpowered tests hill-climbs on noise while reporting success.
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

### Tier A — cohort-testable (the strongest evidence this portfolio can make)
Template-level changes touching large comparable page sets (recipe corpus,
foods pages, calculator constellation, programmatic locale sets).
- **Method:** stratified bucketing (rank pages by traffic, ntile, randomize
  within tiles — Etsy's design; simple randomization fails on skewed traffic),
  a control cohort left unchanged, forecast-the-control + measure divergence
  (CausalImpact-class or DiD when seasonality dominates).
- **Discipline:** measurement window starts at **confirmed recrawl** of variant
  pages (server logs / GSC), not at deploy; 4–8 week windows; Google's testing
  rules honored (302s not 301s, rel=canonical on variants, tests bounded in
  time). A core update mid-window → extend and rely only on control-relative
  divergence.
- Books: realized Δ with credible interval, shrunk (below).

### Tier B — holdout-able (site-wide changes with a control somewhere)
Site-wide changes that can be staged (half the corpus first), or where sibling
portfolio assets form a plausible control series.
- Method: DiD / CausalImpact with the held-out slice or sibling asset as
  control. Weaker than Tier A; intervals widen accordingly.
- A genuinely site-wide, no-control change gets interrupted-time-series **with
  the update calendar overlaid** and is booked with an "ITS-only" caveat flag —
  or deliberately batched (below).

### Tier C — unmeasurable by design (most changes; say so)
Small copy edits, single-page fixes, hygiene, most UX polish.
- **Booked `unmeasured`, value 0, with the pre-ship rubric score recorded.**
  The rubric + leading indicators (index status, CWV, CTR direction, engagement
  events) are quality gates, not value claims.
- Tier-C changes earn measured value only through **batch rollup**: grouped by
  change-class and evaluated at program level over quarters, where small
  effects aggregate above the noise floor.

## Booking rules (enforced by the ledger, not by good intentions)

- **Shrinkage is mandatory.** Realized estimates shrink toward the change-class
  prior (empirical Bayes); the prior comes from the class's own history. Point
  estimates are never stored without intervals.
- **No control → no causal claim.** The words "this change drove" may only
  attach to Tier A/B entries. Everything else is "shipped; program-level".
- **The program is the unit of account.** The operator-facing number is
  P&L per change-class per asset per quarter — predicted vs realized — because
  that's the resolution at which this portfolio's truth exists. The predicted
  side is what each change's ledger entry froze when it shipped; the realized
  side is a later entry that supersedes it, never an edit (D38).
- **Batching discipline serves attribution.** Decide deliberately groups
  same-class changes into evaluable batches (one titles-batch per corpus per
  window) instead of dribbling confounded singles — v1's "first natural
  experiment" bundled four workstreams in one day and was unattributable by
  construction.
- **Long-horizon holdout.** A small permanent slice (pages or one asset surface)
  stays outside the optimizer's reach as the drift detector: if the optimized
  estate's short-window wins don't show up against the holdout over quarters,
  the surrogates have decoupled from value and Learn must recalibrate. Holdout
  assignment lives outside agent write scope ([doc 01](01-architecture.md)).
- **Surrogate validation.** Leading indicators (CTR, engagement, AIO-citation)
  are only usable in rubrics while their correlation to ledger revenue is
  periodically re-established; a surrogate that stops predicting dollars is
  retired from scoring (Facebook-MSI is the cautionary precedent — the proxy
  was actively anti-correlated with quality and nobody checked for years).

## Watch windows — pre-registration, implemented *(landed 2026-07-31)*

The rules above are only worth anything if the comparison is fixed **before**
the numbers exist; a window chosen after the fact is a story. Migration
`0012_watch_windows.sql` plus the ingest Worker's `POST /api/watch-windows`
route and its 03:30 UTC evaluator are that pre-registration in the store: the
metric, the pre-change baseline window, the days it will be re-read
(`[7, 14, 28]`-style offsets), and the ship/kill predicate, all written down at
registration time. That predicate and those days are the change's kill
criterion; its ledger entry does not repeat them (D38). Backdated
registration is allowed, so a batch that already shipped can still be
watched against the baseline that preceded it.

**Query scope is measured at query grain.** A GSC window may register
`scope_json = {"query":"…"}`; the evaluator reads that query from the retained
provider-final daily `gsc/query` R2 objects. A missing query row is missing, not
zero, and counts against the normal coverage rule. Unsupported or malformed
scopes close `unmeasurable` rather than answering a narrower question with
site-wide numbers.

The registration threshold follows the same grain. The Tower loads only that
query's bounded daily archive while its composer is open and measures adjacent
baseline-length windows with the evaluator's same coverage and mean-per-observed
day arithmetic. A usable floor names the query, archive span, typical move,
ninetieth percentile, and valid comparison count. Insufficient history stays a
visibly uncalibrated 10% starting point; it never inherits the property's
site-wide volatility. Both site and query calibration read the annotation
ledger independently over the full calibration horizon and exclude every
comparison pair crossing a recorded change. If that calendar is absent or
truncated, the Tower labels the number `HISTORICAL ONLY`; it cannot silently
claim change-filtered provenance.

Three closing rules follow directly from this doc's uncomfortable facts:

- **No predicate, no verdict.** With no thresholds registered the window closes
  `inconclusive` with the numbers shown. The OS does not invent a verdict it was
  not given — that is exactly the underpowered "win" this doc warns about.
- **Unmeasurable is a real outcome, not a rounding of inconclusive.** A zero
  baseline, an empty series, or a window whose days are mostly missing closes
  `unmeasurable`. Tier C's discipline ("booked `unmeasured`, value 0 — say so")
  applies to windows too.
- **Interim readings are readings.** A check that comes due before the baseline
  is long has a post window reaching back over the change; it records the
  numbers and how many pre-change days it contains, and never closes anything.

A closing window files a flag (`rule_id = watch-window-closed`; `warn` for
`kill_confirmed`, `info` otherwise) carrying the numbers, so the result reaches
the operator through the existing alert surfaces. What it does **not** yet do is
book a realized Δ: shrinkage, intervals, and the change-class prior described
above still have no ledger lane, so a `ship_confirmed` window is evidence for
the operator, not a value claim. When the lane exists, it books the realized
value, its interval and its method as an entry superseding the change's
(D38).

## What Attribute emits

Per evaluated change/batch: `{ method, window, control, interval, shrunk-Δ,
confounds-noted, booked }` → ledger. Per quarter: the **calibration report** —
predicted-vs-realized by change-class, the input Learn uses to adjust Decide's
priors ([doc 04](04-decision-policy.md)) and the single most important chart in
the Tower: *is this system getting better at knowing what works?*
