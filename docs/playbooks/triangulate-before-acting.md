---
id: triangulate-before-acting
version: 1
origin: "one site's docs/growth-patterns.md (2026)"
status: active
---

# Triangulate before acting

No single data source is allowed to authorize a build. A read becomes a
decision only after a second independent source confirms it — and the sources
are chosen so that each one can measure what the others structurally cannot.

## Use when

- A signal is about to become a build order, a page cluster, or a spend.
- Any ranking or prioritization derived from one provider's export.
- Before writing a target into a roadmap, especially when the number is large
  and flattering. Big numbers from one source are the ones that mislead.

## Preconditions

At least two sources that see the same phenomenon from different positions.
The standard triad:

| Source class | Answers | Structurally cannot answer |
|---|---|---|
| **Own search console** | what *we* were shown for, and clicked on | whether that demand is concentrated or winnable |
| **Keyword/SERP provider** | market volume, difficulty, who ranks, whether an answer engine intercepts | what we actually earn |
| **Backlink/authority provider** | whether the gap is content or authority; concentration risk | intent, or on-page fixability |

Analytics answers acquired behavior; revenue answers value. Neither substitutes
for the three above.

## Method

1. **State the read** as a falsifiable sentence, with the source named:
   "source X says page P has N impressions, so P is the biggest opportunity."
2. **Ask what that source cannot see.** Impressions do not distinguish one
   concentrated winnable term from a diffuse long tail of terms we rank 50th
   for. Volume does not distinguish an authority gap from a content gap.
3. **Pull the second source against the same objects** — the specific pages and
   queries, not the aggregate.
4. **Pull the third when the first two disagree, or when the decision is
   expensive.** Disagreement is the signal, not an inconvenience.
5. **Write the correction into the document that carried the original read**,
   dated, with the demoted item explicitly demoted. A correction that lives only
   in a session is a correction that gets re-made.
6. **Re-rank the build order** from the triangulated read, then act.

## Decision rules

- If impressions are large but no single query in them carries concentrated
  winnable volume, the opportunity is a **mirage** — demote it, do not build for
  it.
- If a source's own collection is broken (large unattributed share, an event
  that stopped firing), fix collection before interpreting anything from it. A
  broken ruler is not a small error; it is an unknown.
- If two sources agree and a third contradicts, the third is a finding to
  investigate — never a rounding error to drop.
- If a competitor analysis shows the SERP is held by domains an order of
  magnitude above our authority, the constraint is links, not copy — route to
  [serp-authority-gate](serp-authority-gate.md), and stop scheduling content
  work against it.
- If a single channel or a single page carries the overwhelming majority of
  acquisition, record it as a **concentration risk** in the same breath as the
  win. The two readings are the same fact.
- Cross-engine agreement (two independent search engines moving together) makes
  a directional result credible. It still does not isolate which change caused
  it — that is [release-cohort-attribution](release-cohort-attribution.md)'s job.

## Proof and abandonment

Triangulation is a gate, not an experiment; its proof is that corrections keep
getting caught. Track the correction rate: how often the second source changes
the build order. If it never does, the second source is redundant and the
sweep is spend without information — cut it. If it changes the order often,
the gate is paying for itself and belongs earlier in the sequence.

## Calibration

Which providers fill the three source classes is per-portfolio. Cost per
cross-reference is small relative to a wrong build; the origin priced a full
cross-reference sweep in cents, against build decisions worth weeks.

## Origin evidence (2026-06, one site)

A search-console-only read named two pages as the top opportunities on
impressions alone (10,015 and 9,204 impressions at positions ~8). The
keyword/SERP cross-reference **demoted both**: the impressions were diffuse
long tail with no concentrated head term behind them — recorded in the doc as
"the impressions were a mirage" — while the real prize turned out to be the
home page against a 220k-combined-volume brand cluster it already ranked 6th
for. The same pull found that a low-difficulty term needed a dedicated tool
rather than a copy tweak, because a calculator competitor ranked third on it.

A third source (backlink/authority) then confirmed the corrected read and added
what neither of the first two could see: the organic climb was **link-gated**
(the link profile was almost entirely spam, real authority ≈ one legitimate
link), the competitors held domain ratings of 72–95, and ~90% of ranking
keywords plus ~85% of organic traffic sat on one brand cluster — a
single-point-of-failure risk recorded alongside the win.

The negative half is equally instructive: the same triangulation is what
established that the head content terms were **not winnable organically at
all**, redirecting the effort to citation capture rather than another content
push.

## Related

- [impression-harvest](impression-harvest.md) — the per-page application.
- [serp-authority-gate](serp-authority-gate.md) — what to do once the gap is
  authority, not content.
- [release-cohort-attribution](release-cohort-attribution.md) — triangulating
  *causes*, once a change has shipped.
- [utm-taxonomy](utm-taxonomy.md) — keeps the analytics source measurable
  enough to triangulate with.

Crystallized (partly) as the `measurement-integrity` and `concentration-risk`
rules in `scripts/signal-insights.mjs`.
