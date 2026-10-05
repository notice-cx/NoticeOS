---
id: serp-authority-gate
version: 1
origin: "one site's docs/seo-korea.md + docs/growth-patterns.md + docs/seo-germany-dach.md (2026)"
status: active
---

# SERP authority gate ("cite, don't fight")

Decide **rank versus cite** from who currently holds the result page. Keyword
volume and difficulty score the prize; the identity of the incumbents decides
whether the prize is reachable at all. This gate runs before any content is
scheduled against a query.

## Use when

- A high-volume, apparently low-difficulty query is about to become a content
  or page plan.
- A market or cluster assessment reaches the "which terms do we chase" step.
- A page has been optimized twice and its head-term position has not moved.

## Preconditions

A live result page for the exact query, in the exact locale, with the answer
engine's inline summary requested. Difficulty scores alone are insufficient —
they are the input this gate exists to override.

## Method

1. **Pull the live SERP** for the query in-locale, including whether an
   AI-Overview-style answer fires and which sources it cites.
2. **Classify the top ten by holder class:**
   - *state/institutional* — government, ministry, national health body, the
     standard-setter that owns the concept;
   - *entrenched brand* — the organization whose name the query contains, or
     which the topic is named after;
   - *commercial thin* — shops, magazines, lead-gen widgets, single-purpose
     pages with no depth or method;
   - *tool* — a calculator or generator ranking on utility, not authority.
3. **Read the structural gap.** Ask what the incumbents cannot do — publish
   their formulas, serve without a login, cover the whole set, stay current,
   answer in the searcher's own words.
4. **Assign the play** from the rules below, and record the assignment with the
   date and the SERP evidence.
5. **Re-check on a cadence.** SERP composition is the input; a stale
   classification is a wrong one.

## Decision rules

- If the top ten is held by **state/institutional** domains, do not chase the
  rank. Become the source those results and the answer engine cite: extractable
  answers, concrete numbers with inline attribution to the same primary source
  the incumbents use, one idea per section. **Cite, don't fight.**
- If the query is **navigational to an entrenched brand** (including a retired
  one), only the brand's own successor demand is honestly chaseable. Chasing the
  navigational term itself is not a plan.
- If an **answer engine's inline summary** fires on the query, treat the click
  as largely consumed: the play is citation share, and success is being cited,
  not being ranked.
- If the incumbents are **commercial thin** pages ranking on domain weight, the
  gap is a product gap. A free, sourced, method-transparent tool wins directly —
  this is the highest-ROI class on the board.
- If a **tool** ranks top-five on an informational query, a tool can win it. A
  copy tweak to a prose page cannot.
- If our authority is an order of magnitude below the incumbents and the SERP
  is not thin, the constraint is links. Route to
  [reclamation-pipeline](reclamation-pipeline.md); do not schedule more content
  against that term.
- Where a query's answer is a national or institutional standard we implement,
  the honest posture is implementation plus attribution — and the standard-setter
  is a relationship, not a competitor.

## Proof and abandonment

- **Rank plays** prove out on position in the tracked panel, on the normal
  D7/D14/D28 clock.
- **Citation plays** prove out on citation share and on referrals from answer
  surfaces — a different scoreboard, and one that must be baselined *before*
  the work, because "we were not cited before either" is otherwise unfalsifiable.
- **Abandonment:** a rank play whose head-term position has not moved after two
  focused iterations is re-classified as authority-gated. Stop optimizing; the
  next honest move is links or citations.

## Calibration

Holder classes are universal; the authority thresholds are not. Compare our
domain authority to the *median of the top ten*, not to the leader, and
calibrate the "order of magnitude" line per property. The origin's competitors
ran domain ratings of 72–95 against its own 29.

## Origin evidence (2026, one site)

- **Institution-locked, so cite:** the generic category terms carried an AI
  Overview and were held by national health institutes, a foreign government
  health portal, a university nutrition source, and an encyclopedia. Recorded
  verdict: "hard organically → the realistic play is a citation angle, not
  organic rank." The same call was made in-locale for a national nutrient-standard
  term held by the standards body and government ("cite-don't-fight"), and for
  another market's official plate term on a government domain under an AIO.
- **A whole market ruled out by this gate:** one English-speaking market was
  declined despite obvious demand because the category SERP was "a state
  fortress" — the national health service, the government portal, the food
  standards agency and the nutrition foundation held the entire top ten.
- **Commercial-thin, so build:** in another market the same category was held by
  insurers, clinics, supplement shops and fitness magazines running thin
  single-widget pages with no method or depth. Difficulty scores of 0–13 across
  the cluster were *genuine*, and a free, formula-transparent, sourced
  calculator was recorded as "a straight product win."
- **Tool-rankable proof:** a general-purpose calculator site ranking third on a
  low-difficulty definitional term was read as proof that a tool — not a prose
  section on an existing page — could take it.

## Related

- [market-go-no-go](market-go-no-go.md) — this gate is its step 2.
- [impression-harvest](impression-harvest.md) — classification step 5 uses it.
- [triangulate-before-acting](triangulate-before-acting.md) — how the authority
  gap gets measured.
- [reclamation-pipeline](reclamation-pipeline.md) — the answer when the gate
  says "links."
