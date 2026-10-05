---
id: market-go-no-go
version: 1
origin: "one site's docs/market-india.md + docs/seo-germany-dach.md + docs/seo-korea.md (2026)"
status: active
---

# Market go / no-go

Whether to enter a geography, language, or locale at all. Four gates in a fixed
order, each able to end the assessment. The order matters: the cheap gates run
first, and **the attractive-keyword gate is not the last word** — economics
overrides it.

## Use when

- Anyone proposes a new locale, country hub, or translated surface.
- A property shows organic traction in a market nobody planned for.
- Periodically, against markets previously declined — the gates' inputs move.

## Preconditions

- Keyword volume + difficulty for the market's own idiom, in-language.
- Live result pages from that market's dominant engine, in-locale.
- Revenue-per-thousand-views expectations for the market and the property's ad
  or affiliate posture, including any network eligibility ratio.
- The licensing status of the local standard the content would implement.

## Method

1. **Demand** — size the cluster in the market's *own idiom*, not a translation
   of ours. Idiom errors invalidate the entire sizing.
2. **Authority** — run [serp-authority-gate](serp-authority-gate.md) on the top
   money terms. This is the real gate; difficulty scores are the input to it.
3. **Economics** — revenue per thousand views × realistic reach, and the effect
   of the new traffic on any ad-network ratio the existing traffic depends on.
4. **Licensing** — check whether the local standard is public domain,
   attribution-permissive, or actively licensed.
5. **Cost of entry** — incremental cost against the existing pipeline. A locale
   the pipeline already produces is a different proposition from one needing new
   data, new content, and native review.
6. **Write a verdict with conditions.** GO, NO-GO, or CONDITIONAL-with-named-
   conditions — never an unqualified maybe. Record the date and the evidence.

## Decision rules

- If demand is enormous but revenue per view is a small fraction of the
  portfolio's best market, **the demand is not the decision**. Attractive
  keywords with low monetization are a no-go as a revenue market.
- If the new traffic could dilute a ratio an existing ad network's tier depends
  on, the network-standing risk is a first-class cost, not a footnote. Compute
  how much of the ratio the new market would consume before committing.
- If the market's incumbents own the category app-first and the web tool space
  is thin, that structural gap is the opportunity — and it recurs across
  markets, so check for it explicitly.
- If a market's reach is capped by language (only a minority of its users search
  in the language we serve), size against the reachable minority, not the
  population.
- If the local standard is copyrighted or actively licensed, entry is permitted
  **only as a cleanroom implementation**: our own copy and visuals, the
  published numbers used as facts, prominent attribution to the standard-setter,
  and zero reproduction of their artwork or text. If that is not achievable,
  it is a no-go.
- If a market fails as revenue but passes as a near-zero-cost mission or
  citation asset, the verdict is CONDITIONAL, with the conditions written as
  gates: reuse the existing engine at near-zero incremental cost; never framed
  as a revenue line; the market stays a small traffic minority.
- If no positive precedent exists of comparable operators profitably monetizing
  that market's traffic, say so — absence of precedent is evidence.
- If a market's case is founder interest or story rather than return, label it
  that way. A heart-play declared honestly is a legitimate choice; one disguised
  as ROI is not.
- No new locale ships without native review plus a demand or distribution case.

## Proof and abandonment

- A GO is proven by the entry cluster's ranking and, within two quarters,
  revenue per view landing in the modeled band.
- A CONDITIONAL is re-checked when — and only when — its named condition
  changes. Otherwise the file stands and no one re-litigates it.
- **Abandonment:** if the economics gate's assumption proves wrong (revenue per
  view materially below model, or network standing actually threatened), pull
  back to the passive posture and record the correction in the market's file.

## Calibration

Every threshold here is property-specific. What transfers is the gate order and
the override rule (economics beats keywords). The origin's numbers, for shape
only: a declined market showed page revenue at roughly one fifteenth to one
thirtieth of its best market; the recommended market showed mid-single-digit to
low-double-digit revenue per thousand views with difficulty scores of 0–13
across the money cluster.

## Cost

The origin priced each full market assessment at **$0.05–$0.10** in provider
calls. At that price, "we assessed it and declined" should always be cheaper
than an argument about it.

## Origin evidence (2026-07, one site)

- **NO-GO on demand-rich, revenue-poor.** A market with a 1.5M-per-month head
  term at a two-cent cost-per-click was declined: display revenue projected at a
  small fraction of the primary market, affiliate programs thin, an ad network's
  tier-one ratio threatened by a large slug of it, reach capped because only
  ~40–43% of the market's internet users search in the language served, and the
  incumbents owning the ground app-first. Verdict: **NO-GO as a revenue market,
  CONDITIONAL as a near-zero-cost guideline asset** under three named
  conditions — with the cleanroom rule attached, because the local standard was
  copyrighted rather than public domain.
- **GO on a market nobody had looked at.** The next assessment found the best
  raw return of any market probed: ~1.15M monthly demand at single-digit
  difficulty almost throughout, incumbents thin, the whole cluster served by our
  own public-domain math (zero licensing exposure), one locale covering three
  countries — and it had been invisible precisely *because* no locale existed to
  generate breadcrumbs. Constraints recorded honestly alongside: the local
  standard's imagery is actively licensed (cleanroom only), a child-health
  metric uses a different national reference than ours, and network eligibility
  was verified from the primary policy pages rather than assumed.
- **NO-GO on authority.** A third market was declined on the authority gate
  alone (state fortress SERP), with the note that its upside already accrues for
  free through existing global-language pages.
- **Heart-play, labeled.** A fourth market was recorded as worth doing someday
  for the founder story, explicitly "not for revenue" — including the useful
  detail that its national-standard term carries zero difficulty and would rank
  quickly whenever chosen.

## Related

- [serp-authority-gate](serp-authority-gate.md) — gate 2.
- [kill-thresholds](kill-thresholds.md) — the locale rule lives there too.
- [dead-ends-register](dead-ends-register.md) — declined markets belong in a
  register, so they are not re-proposed from scratch.
