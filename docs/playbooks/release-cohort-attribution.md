---
id: release-cohort-attribution
version: 1
origin: "one site's docs/strategy-next-level.md (2026)"
status: active
---

# Release-cohort attribution

Ship search-facing and product changes in **registered cohorts** so that an
effect can be attributed to a cause at all. The failure this prevents is not
shipping too little; it is shipping so much, so densely, that nothing that
happens afterward can be read.

## Use when

- Any change that could move search visibility, acquisition, or activation.
- Planning a release cadence, or diagnosing why a growth period cannot be
  explained.
- Before claiming any shipped change caused any observed lift.

## Preconditions

- A release registry: for each cohort, the affected URLs, the hypothesis, the
  target query or audience, and the D7/D14/D28 outcome slots.
- Deploy annotations in whatever store the outcome data lands in, so the
  windows are machine-alignable rather than remembered.
- Working channel attribution ([utm-taxonomy](utm-taxonomy.md)) — otherwise the
  cohort's downstream half is unreadable regardless of how clean the ship was.

## Method

1. **Batch search-facing changes into a train** on a fixed cadence, rather than
   shipping them continuously.
2. **Register the cohort before it ships**: what changed, which URLs, what is
   expected to move, and on what clock.
3. **Freeze the affected surfaces** for the measurement window
   ([freeze-register](freeze-register.md)).
4. **Read at D7, D14 and D28**, on **each engine separately**. Cross-engine
   agreement is the credibility test; a single engine's move is a hypothesis.
5. **Record confounders in the same entry** — a send, a seasonal event, an
   algorithm update. A confounder discovered later is an argument; one recorded
   at ship time is a caveat.
6. **Write the outcome into the registry**, including "unreadable" when that is
   the truth. An unattributable cohort is a finding about the process.

## Decision rules

- If a window contains more than one hypothesis affecting the same surfaces, the
  cohort is unreadable. Say so rather than assigning credit.
- If the first week is negative, do not conclude. Broad indexing dilutes
  position and clicks before it pays; judge on the full window.
- If impressions rise while clicks fall, the change bought reach at lower
  positions. That is an optimization queue
  ([impression-harvest](impression-harvest.md)), not an automatic success or
  failure.
- If an email or campaign send overlaps the window, the direct-response traffic
  cannot appear in search data at all. Any same-period search lift is indirect
  branded demand or coincidence — never email referral.
- If a comparison would require a holdout and there is none, the result is
  directional only. Say "directional", and add the holdout next time.
- Commit volume is not a growth metric. If a case rests on how much shipped
  rather than what moved, it is not a case.
- Index-notification pings are for URLs **added, updated or deleted** — never
  the whole sitemap after every deploy. Debounce release trains and keep an
  explicit full-site override for genuine global template changes.
- Aggregate site-level click-through rate is not the scoreboard. Diagnose by
  query cluster, page, position, and release cohort.

## Proof and abandonment

Proof is the share of cohorts that close with a readable outcome. If most close
"unreadable", the cadence is too dense — widen the train before adding any more
measurement. Abandonment does not apply; a system with no attributable releases
is a system that cannot learn, which is the condition this exists to end.

## Calibration

Train cadence (weekly at the origin) and the recheck clock (D7/D14/D28) are
per-property. What transfers: registered cohorts, separate per-engine reads, the
full-window rule, and refusing to claim causality a dense window cannot support.

## Origin evidence (2026-07, one site)

A repository-history-versus-search-series analysis found "coherent release
effects, **not** a general rule that more commits create more traffic." The
cleanest cohort — a five-day wave of title de-cannibalization, intent-matched
metadata, a calculator constellation, static content depth, crawlable navigation
and internal linking — showed, against the preceding seven-day baseline:
clicks/day +45.7% and impressions/day +180.8% at 7–13 days on one engine, +48.7%
and +90.6% on the other, and +110.0% / +375.3% at 21–27 days, with weighted
average position recovering from 8.02 to 7.67 after the initial broad-indexing
dilution. **Cross-engine agreement made the direction credible; it still did not
isolate which commit earned it.**

An earlier wave is the warning case: impressions rose ~73–80% immediately while
clicks initially *fell* ~12%, and the surface later matured into a large
engagement asset. Judging that launch in its first week would have killed a
winner.

The following month was recorded as unattributable: dozens of overlapping
user-facing, metadata and product changes, plus a traffic spike confounded by
the first email digest whose three segments all shared one campaign tag. Commit
volume itself showed only a weak relationship with subsequent click growth and
almost none with impressions.

The release system's other blind spot was mechanical: an index-notification
script resubmitted all 5,981 sitemap URLs after every successful deploy, against
59 recorded main-branch updates in under a month — a theoretical maximum of
roughly 353,000 mostly-repeated notifications, against official guidance to
submit only added, updated or deleted URLs.

## Related

- [freeze-register](freeze-register.md) — keeps a cohort's surfaces clean.
- [impression-harvest](impression-harvest.md) — supplies the D7/D14/D28 shape.
- [utm-taxonomy](utm-taxonomy.md) — the downstream half of attribution.
- [triangulate-before-acting](triangulate-before-acting.md) — cross-engine
  agreement as a credibility test.

Crystallized (partly) as the `page-movers` rule in
`scripts/signal-insights.mjs`.
