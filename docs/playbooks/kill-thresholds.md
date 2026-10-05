---
id: kill-thresholds
version: 1
origin: "one site's docs/strategy-next-level.md + docs/press-pitch-playbook.md + docs/journalist-queries-playbook.md (2026)"
status: active
---

# Kill thresholds

Every line of investment carries a **quantitative stop rule written before the
spend starts**. Retiring something then becomes arithmetic rather than an
argument, and the person who proposed it does not have to lose a debate to end
it.

## Use when

- Opening any new channel, product line, market, or content cluster.
- Reviewing an existing line that has been running without a stated stop rule —
  write one now, from where it stands.
- Whenever "let's give it more time" is the argument for continuing.

## Preconditions

- A named metric the line can actually move, measurable from a source that is
  not the line's own optimism.
- A stated minimum sample. A stop rule fired below its sample is noise, and one
  that can never reach its sample is theater.
- An owner who can execute the stop.

## Method

1. **Write the rule at open**, in the form: *park / kill / scale `<line>` if
   `<metric>` is `<comparator>` `<threshold>` after `<sample or window>`.*
2. **Pair it with a scale rule** on the same metric. A line with only a kill
   rule gets defended; a line with both gets decided.
3. **Name the sample floor** — pitches sent, conversations held, iterations run,
   days elapsed. Thresholds without floors get fired early by a bad week.
4. **Require iterations, not just time, where the line is improvable.** Two
   focused iterations before a park is the honest bar for anything whose first
   attempt could simply be bad.
5. **Review on a fixed cadence**, per line, and record the reading even when
   nothing changes.
6. **Execute the stop when it fires.** A threshold that fires and is overridden
   is worse than no threshold, because it teaches everyone the numbers are
   decorative. If it is genuinely overridden, write the new rule and the reason.

## Decision rules

The transferable *shapes* (thresholds calibrate per property):

- **Zero-conversion retirement.** If a specific approach has produced zero
  results across a stated number of attempts, retire that approach — not the
  channel. Origin: retire an outreach angle at 0 for 15.
- **Sub-floor channel kill.** If a channel's conversion is below a floor after a
  stated volume, kill the channel. Origin: kill a query platform under ~5% after
  30+ pitches.
- **Free before paid.** Do not pay for a channel's premium tier until its free
  tier has produced the outcome. Origin: a $149/month platform was gated behind
  free-tier proof.
- **Retention gate before expansion.** Park major expansion of a product line if
  its retention metric stays below a floor after two focused iterations.
- **Pilot gate before build.** Park product development if a stated number of
  qualified conversations does not produce a stated number of paid pilots.
  Origin: 30 conversations → 3 pilots.
- **Mode, not company.** Keep an adjacent feature as a free mode unless its
  retention materially exceeds the base product or it raises paid conversion.
- **Inventory gate.** Do not scale a page cluster while existing high-impression
  pages in that cluster lack query-level diagnosis or fail to produce a useful
  downstream action after focused iteration
  ([impression-harvest](impression-harvest.md)).
- **Distribution gate.** Scale a distribution surface if it earns live links,
  activated users, repeat use, or qualified buyers — **never on page views
  alone**.
- **Rights gate.** Do not scale anything whose rights are unclear, whose data
  cannot be kept current, or which fails to produce a downstream action within
  its stated window.
- **Dependency contingency.** If a dependency is identified as a material
  existential risk, execute the prepared contingency *before* the switching cost
  deepens — not after the risk lands.
- **If a line fails, do not disguise it with a new one.** The permitted response
  to a failed engine is falling back to the engine that works, not launching a
  third.

## The stop-doing list

A kill threshold ends a line. A stop-doing list ends a *habit* — and habits do
not have metrics, so they need naming instead. The origin's list is largely
portfolio-generic; these transfer directly:

- Stop treating inventory count as product-market fit.
- Stop treating borrowed (successional or brand-memory) traffic as demand the
  business owns.
- Stop using aggregate sitewide click-through rate as the health score.
- Stop treating commit count as a causal growth metric, or bundling so many
  search-facing changes that no release can be evaluated
  ([release-cohort-attribution](release-cohort-attribution.md)).
- Stop using identical campaign tags for materially different audiences
  ([utm-taxonomy](utm-taxonomy.md)).
- Stop treating page views or unaudited analytics events as activation or
  retention.
- Stop creating new search pages before harvesting impressions the existing
  inventory already earned.
- Stop launching pillars faster than they can be measured.
- Stop using theoretical market size or revenue ceilings as forecasts.
- Stop calling public or reproducible data exclusive.
- Stop claiming review, citation, or endorsement without current proof.
- Stop adding country hubs without a native reviewer and a distribution plan.
- Stop making one surface carry every product — route each intent to one useful
  next action.

## Proof and abandonment

The meta-metric is **execution rate**: what fraction of fired thresholds were
actually executed. Below roughly half, the thresholds are not a decision system
and the right fix is fewer, harder rules — not more of them.

## Calibration

Every number above is the origin's; calibrate per property from its own base
rates. What transfers is the *form* — metric, comparator, threshold, sample
floor, iteration count — and the discipline of writing it before spending.

**For a watch window, the OS now does this calibration for you** *(2026-08-04,
bead `ro-5e8.2`)*. The property page's composer derives "smallest move that
counts" from that property's own `signal_observations` history, by making the
evaluator's exact comparison — mean daily value over two adjacent windows of the
baseline's length — over every quiet stretch the archives hold, and prefilling
the smallest whole percent above the ninetieth percentile of those moves. The
form states the span, the property's typical move, and the floor, so the number
is traceable rather than remembered; where a property has no usable history it
says so and falls back to the ±10% example, which is the honest version of what
every registration was silently doing before. Nothing is written down: the
calibration is re-derived from the archives on each open, so it cannot go stale
the way a recorded number would. Overriding it is one field and the form marks
the result as yours.

## Origin evidence (2026-07, one site)

The strategy document closes with an explicit "kill and scale rules" section and
a "stop-doing list", written at a point when several lines were still
attractive and unmeasured — the moment thresholds are worth the most and cost
the least. Both outreach playbooks carry their own numeric rules in the same
spirit (retire an angle at 0/15; kill a platform under 5% after 30+; pay for
nothing until the free tier proves out), each attached to a tracker table whose
explicit purpose is that "without this loop it's a one-shot blast."

## Related

- [market-go-no-go](market-go-no-go.md) — the locale and market gates.
- [impression-harvest](impression-harvest.md) — the inventory gate's method.
- [dead-ends-register](dead-ends-register.md) — where a fired kill rule's
  finding gets written down.
- [release-cohort-attribution](release-cohort-attribution.md) — makes the
  metrics readable enough to fire a threshold on.

Crystallized (partly) as the `concentration-risk` rule in
`scripts/signal-insights.mjs`.
