---
id: impression-harvest
version: 1
origin: "one site's docs/impression-harvest-2026-07.md (2026)"
status: active
---

# Impression harvest

Convert visibility a property has **already earned** into clicks before
building any new inventory. The unit of work is one indexed page carrying a
large discovery footprint and a near-zero click rate.

## Use when

- A page's impressions sit well above the property's median while its CTR sits
  well below — the high-impressions / near-zero-clicks shape.
- Anyone proposes new pages in a cluster where existing pages already hold
  unharvested impressions. Harvest first. The new page is the fallback the
  harvest's failure earns, not the opening move.

## Preconditions

- Page-level impressions and CTR over at least 28 days.
- A live-SERP source (who ranks, what their snippets promise, whether an AI
  Overview fires) and a keyword source (volume, difficulty). Without both you
  are rewriting copy blind — that is the failure this playbook exists to stop.
- The page is not frozen ([freeze-register](freeze-register.md)).

## Method

1. **Rank candidates** by impressions × (property median CTR − page CTR). Take
   the worst four to six. A harvest is a small batch you can recheck, not a
   backlog sweep.
2. **Find the query the page actually ranks for** — not the query it was built
   for. These differ more often than not, and the gap *is* the diagnosis.
3. **Pull the live SERP** for each intent-matched candidate query. Read three
   things: our real position, what the winning snippets promise, and whether an
   AI Overview sits on top.
4. **Apply the AI-Overview gate** before writing anything (rule below).
5. **Classify each page** into exactly one outcome: *winnable seam* (an
   AIO-free, intent-matched query where we already rank on page one),
   *wrong-intent* (we rank for a question the page does not answer),
   *bloat* (an ambiguous head term dragging blended CTR, unfixable by copy), or
   *authority-gated* (the SERP is owned by domains we cannot outrank — see
   [serp-authority-gate](serp-authority-gate.md)).
6. **Write the fix** for the winnable seams only, to
   [serp-snippet-standard](serp-snippet-standard.md).
7. **Deliver the snippet's promise above the fold.** A title that earns the
   click and a landing view that does not answer it buys one visit and sells
   the ranking. Fix the H1 or the first subheading in the same change.
8. **Register the recheck** at D7 / D14 / D28 with the metric named *per page*
   before the change ships (see Proof).

## Decision rules

- If an AI Overview fires on the query, do not spend copy budget on it — the
  answer is consumed inline. Route it to a citation play instead.
- If the page ranks for a different intent than it serves, retitle to claim the
  intent it *does* serve. Falling impressions on the abandoned query are then a
  success signal, not a loss — say so in the recheck before it happens.
- If blended page CTR is dominated by an ambiguous head term, measure the
  intent-matched query's CTR instead. Blended CTR on a bloated page is not a
  scoreboard.
- If the page is the property's best performer in the batch, make the smallest
  change that claims the wedge. Do not churn a winner.
- If the SERP's winners are a different *result style* (interactive tools,
  directories) rather than better copy, the honest read is a build decision, not
  a snippet one. Say that instead of rewriting again.
- Localized surfaces get their own per-locale surgery against their own SERP —
  never a translated echo of the source-language fix.
- No new inventory ships out of a harvest. The gate is the point.

## Proof and abandonment

- **Metric is named per page, in the cluster the fix targets** — not sitewide
  page CTR, which the unfixable remainder dominates.
- **D7 / D14 / D28.** D28 also re-checks that the engine renders the new title
  rather than re-truncating or rewriting it.
- **Expected-flat is stated up front.** Head-term position under an AIO or an
  authority moat is expected not to move; treating it as failure is how a
  working change gets reverted.
- **Abandonment:** if the targeted cluster's CTR has not moved by D28, the page
  lacks a winnable query. Drop it off the harvest list. **Do not add inventory
  to chase it** — that is the exact spend this playbook was written to prevent.

## Calibration

Impression floor, CTR floor, and batch size are property-specific; calibrate per
property. The origin ran four pages plus one query at floors of ~15k
impressions and CTR ≤0.73%, on a property doing ~10k clicks/month.

## Cost

Origin metered the diagnosis at **≈$0.06** total: one batched keyword-overview
call (35 candidate queries) plus 11 live SERP pulls. Diagnosis is cheap enough
that skipping it is never a budget decision.

## Origin evidence (2026-07, one site)

Four pages, 178k impressions between them, all under 0.75% CTR. Diagnosis found
one winnable branded seam (AIO-free, already ranked #6, title truncated so the
query echo was cut), one wrong-intent page ranking for how calories in *food*
are measured while answering how calorie *needs* are computed, one page whose
low CTR was an ambiguous 74k-volume head term that copy cannot fix, and one
whose head term is owned by the topic's institutional authority under an AIO.
The cross-cutting finding: **AI Overviews were the dominant zero-click force on
three of four** — harvestable clicks lived on the AIO-free intent-matched seams.
A fifth surface (4,170 impressions at position 6.7, zero clicks) was diagnosed
as result-style loss, not copy loss: the SERP's winners were generator apps and
directories, so the honest recheck note says a tool surface — not another
snippet — wins that intent.

Two evidence limits worth carrying: query-by-page data was unavailable, so the
ranking URL for one query was a best-evidence identification flagged for
re-confirmation; and one exact phrase failed at the SERP provider on all five
retries and was still billed.

## Related

- [serp-snippet-standard](serp-snippet-standard.md) — how the fix is written.
- [serp-authority-gate](serp-authority-gate.md) — the rank-versus-cite call.
- [freeze-register](freeze-register.md) — protects the recheck window.
- [release-cohort-attribution](release-cohort-attribution.md) — keeps the D7/D14/D28
  read attributable.
- [triangulate-before-acting](triangulate-before-acting.md) — why a
  single-source impression read is not a target list.

Crystallized (partly) as the `query-cannibalization`, `query-language-drift`,
`device-ctr-gap`, and `prune-candidates` rules in `scripts/signal-insights.mjs`.
