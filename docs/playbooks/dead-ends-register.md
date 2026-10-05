---
id: dead-ends-register
version: 1
origin: "one site's docs/seo-geo-plan-2026.md (2026)"
status: active
---

# Dead-ends register

A documented dead end is method capital. This is the discipline of writing down
what was **built, measured, and written off** — with the measurement — so the
portfolio buys each negative result exactly once. Without it, every plausible
technique gets re-proposed by the next session that hears about it.

## Use when

- A technique has been implemented and measured to no effect.
- A vendor, pitch, or article proposes a technique — check the register *first*.
- Writing a plan: the register is the source of the "skip" list that keeps a
  plan honest about what it is deliberately not doing.

## Preconditions

- The technique was actually measured, or a credible source measured it. An
  opinion that something will not work is not a dead end; it is a guess, and it
  does not get an entry.
- The measurement's date and basis are recorded, because platform behavior
  changes and a dead end can revive.

## Method

1. **Write the entry when the negative result lands**, not at review time. The
   evidence is freshest and the disappointment is most credible then.
2. **Record five fields**: technique, what was expected, what was measured, the
   date, and the disposition (*stop investing* / *keep the artifact, stop
   counting it* / *revisit when X changes*).
3. **State the revival condition** where one exists. "Dead" and "dead until the
   platform changes" are different entries.
4. **Cite the register in plans.** A plan's skip-list should point at entries,
   not re-argue them.
5. **Check the register before funding any technique** that sounds like an easy
   win. The cheapest research is the research already done.
6. **Re-open on evidence, not on enthusiasm.** A revival needs the named
   condition to have actually changed.

## Decision rules

- If a technique was measured to no effect, it is not re-proposed without new
  evidence — and "a vendor says otherwise" is not new evidence.
- If an artifact was built for a benefit that has since disappeared, **keep the
  artifact if it is harmless and stop counting it as a win**. Removing it is
  usually more work than leaving it; counting it is the actual error.
- If the *benefit* died but the *content* still serves a purpose, reframe rather
  than delete — move the content to the surface where it still pays.
- If a metric passes its threshold, stop optimizing it. Beyond a pass, further
  investment is over-investment.
- A dead end for one property is a strong prior, not a verdict, for another.
  Note which properties it was measured on.

## Proof and abandonment

Proof is the absence of re-litigation: techniques in the register do not
reappear as proposals. Track re-proposals of registered entries — a rising count
means the register is not being read at plan time, which is a distribution
problem, not a content one.

## Seed entries from the origin (2026-07, one site)

Recorded in the origin's plan as "dead ends to stop investing in", each with its
basis:

| Technique | Expected | Measured | Date | Disposition |
|---|---|---|---|---|
| A machine-readable "here is my site for AI" manifest file | Answer engines would read it and cite the site | **Ignored by every answer engine.** The origin built it, then wrote it off | 2026-07 | Stop investing. Revisit only if a major answer engine publicly commits to reading one |
| FAQ rich results | A visible search-result treatment | **The rich result was removed by the search engine (May 2026).** The markup itself still parses fine | 2026-07 | Keep the markup, stop counting it as a win. **Reframe:** migrate the FAQ *content* into visible question-headed sections, which still serve answer-engine fan-out and "people also ask" |
| Structured-data markup as a lever for answer-engine inclusion | More citations in AI answers | **±noise in a controlled test.** Being indexed, snippet-eligible and quotable is what the platform's own guidance names | 2026-07 | Stop investing for that purpose. Markup keeps its ordinary uses |
| Core Web Vitals work beyond passing | Ranking gains | Tiebreaker only | 2026-07 | Pass it, then stop |
| Widget/embed links as an authority play | Link equity at scale | Widget links are auto-discounted, and keyword-anchored widget links at scale are a policy violation | 2026-07 | Reframe: one visible natural brand credit. **The mention is the value**, not the link |
| Paid, exchanged, or network-placed links | Authority | Enforcement is now near-real-time (one spam action completed in under 20 hours) | 2026-07 | Never. Not a dead end — a prohibition |
| Web-push retention (PWA reminder notifications) | Opt-in ≥5% and D7 return delta ≥+5pp (pre-registered) | **The experiment never ran** — VAPID keys were never provisioned; 7 subscribers out of 2,243 accounts accrued from the opt-in UI alone (2026-08-04 D1 pack) | 2026-08 | Killed; machinery removed (the site's commit f6ae6eb, decision bead mp-ufv.7). The dormant table stays. Revival = a new bead + revert of that commit, only with a retention thesis push specifically serves |

The reframes matter as much as the kills: two of these entries did not end an
activity, they moved it to the surface where it still pays. That is the most
common correct disposition, and the easiest one to miss when the instinct is to
delete.

## Market and product no-gos (one site, 2026-07/08)

Registered 2026-08-03 when the ROI backlog that carried them was audited and
deleted (detail per entry: `git -C ../<site-repo> show 52235c3:docs/backlog-roi-2026-08.md`,
kill list at L7; India analysis: `git ... show 52235c3:docs/market-india.md`).
These are declined bets, not measured techniques — the disposition column names
the revival condition where one exists.

| Bet | Basis for declining | Date | Disposition |
|---|---|---|---|
| India market expansion | Display revenue projected at ~1/15 the US rate per pageview at comparable volume; guideline localization heavy (see market-go-no-go origin evidence) | 2026-07 | NO-GO. Revisit only if IN display RPM economics change materially |
| UK market expansion | Declined in the strategy corpus (NHS Eatwell incumbency + authority gate) | 2026-07 | NO-GO |
| A sub-brand's standalone `.id` domain | Brand/trademark call; product copy never exposes ".id" | 2026-07 | Dead. Owner reversal only |
| Classroom per-seat SaaS | Willingness-to-pay research verdict: "nobody pays" | 2026-07 | Dead. Revisit on institutional pilot proof |
| RD lead-gen as a revenue line | Declined per strategy corpus | 2026-07 | Dead |
| API-as-revenue | Declined per strategy corpus (API/MCP stay free credibility surfaces) | 2026-07 | Dead |
| Generic head terms ("calorie calculator", "bmi calculator") | KD walls held by DR 80-90 incumbents; not our entity lane | 2026-07 | Do not chase. Our lane is the site's own entity + successor demand |
| Weight-loss reframing of the product | Brand/mission call | 2026-07 | Dead. Owner reversal only |
| Contacting nutrition.gov | Owner veto | 2026-07 | Prohibition. Owner reversal only |
| r/InternetIsBeautiful launch | Declined (Reddit posture) | 2026-07 | Dead |
| SNAP-Ed channel | Long-term park per docs | 2026-07 | Parked, not dead — no active work, no bead until a concrete opening appears |
| WIC channel | Declined per docs | 2026-07 | Dead |
| Korea 2026 travel/major spend | Owner ruling "no Korea in 2026" (closed decision bead mp-fuj.8) | 2026-08 | Dead for 2026. Program continues at P2-P4 (mp-fuj epic) |

## Calibration

Nothing here is threshold-based. What is property-specific is *which* dead ends
apply — record the property the measurement came from, and treat a cross-property
transfer as a strong prior rather than a settled fact.

## Related

- [kill-thresholds](kill-thresholds.md) — a fired kill rule usually produces an
  entry here.
- [market-go-no-go](market-go-no-go.md) — declined markets belong in a register
  for the same reason.
- [triangulate-before-acting](triangulate-before-acting.md) — how a negative
  result earns enough confidence to be written down.
