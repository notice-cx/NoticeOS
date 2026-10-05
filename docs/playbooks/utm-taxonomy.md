---
id: utm-taxonomy
version: 1
origin: "one site's docs/utm-taxonomy.md (2026)"
status: active
---

# UTM taxonomy

The grammar for tagging **internal** campaign links so sends stay separable
after the fact and no session lands in the unattributed bucket. Five parameters,
fixed rules, one helper per surface.

## Use when

- Adding any tagged surface: email sends, share links, QR codes, pins, partner
  links.
- Investigating an unattributed-traffic share or a campaign whose audiences
  cannot be told apart.
- Reviewing a campaign report that reads as one undifferentiated row.

## Preconditions

- Knowing which medium values the analytics platform's default channel grouping
  actually recognizes. This is the single fact the whole taxonomy hangs on.
- A code path that builds links, so tagging can be single-sourced rather than
  hand-written.

## Method

1. **Pick a fixed `source` per surface** — the specific origin (the email
   provider, `share`, `qr-code`, the network name). One surface, one value,
   forever.
2. **Pick the `medium` from the platform's recognized channel list** —
   `email`, `social`, `referral`, or a paid medium. Never invent one.
3. **Set `campaign` to `<surface>-<yyyymmdd>`** in a fixed timezone, so each
   send is its own campaign rather than a merged lifetime bucket.
4. **Set `content` to the AUDIENCE segment.** This is the parameter that keeps
   two sends of the same issue to different segments separable.
5. **Leave `term` off** — it is the paid-search keyword slot.
6. **Route it through a helper.** Never concatenate a query string inline; the
   sender resolves the audience first, then composes the link, so a dry-run
   preview shows the exact tags a real send will carry.

## Decision rules

- If the medium is not a value the platform's channel grouping recognizes, the
  session lands in **Unassigned** and is invisible in acquisition reports. The
  medium slot always carries the *channel*; the origin detail goes in `source`.
- If two sends of the same content go to different audiences, they must differ
  in `content`. Same tags for different audiences is an unrecoverable defect —
  the data cannot be split afterward.
- If a surface is **evergreen** (it keeps driving clicks for years — a pinned
  image, a permanent share affordance), its campaign is **static, not dated**.
  Dating an evergreen surface shatters it into thousands of one-off campaigns
  that never close.
- If a link is meant to be copied widely by other people (an embed, a
  cite-this-page URL, an outbound citation), **leave it untagged**. Tagging it
  attributes every embedder's traffic to one campaign. Only internal links get
  tags.
- If a tagged link carries a payload as well, keep the tags in the query string
  and the payload in the fragment. The two never mix.
- If a constant must be duplicated outside the module that owns it (a build
  script that cannot import it), duplicate it with an explicit keep-in-sync
  note pointing at the single source.
- Tagging never bypasses consent. Tags ride on links; measurement still waits
  for the consent state, and sensitive routes stay out of the third-party stack
  entirely.

## Proof and abandonment

- Proof is a falling unattributed share and campaign reports that split by
  audience without manual work.
- A double-digit unattributed share is a **defect to investigate, not a
  channel**. It is also a reason to distrust every number computed from that
  source until fixed ([triangulate-before-acting](triangulate-before-acting.md)).
- There is no abandonment case. This is hygiene, not an experiment; the only
  question is whether it is enforced in code or left to memory.

## Calibration

Parameter names are the standard five. Recognized medium values, the timezone
for the date stamp, and the audience vocabulary are per-property — write them
down once, in the property's own taxonomy file, and have the senders read from
it.

## Origin evidence (2026-07, one site)

Written *because* of a defect: a month's digest sends were inseparable in
analytics — every send used one campaign value and no content value, so a send
to the newsletter segment and a send of the same issue to a calculator-leads
segment landed in one undifferentiated bucket. The fix was the fixed grammar
plus wiring the sender to fill it automatically: the endpoint resolves the
target segment first, then composes the email with a UTC-dated campaign and an
audience-mapped content value (unknown segment → a `general` fallback), so a
dry-run preview shows exactly what a real send will carry.

Two rules were bought with specific reasoning rather than convention. The medium
rule is load-bearing because the platform's default channel grouping keys off it
— which is why the share-link builder uses `referral` rather than the more
descriptive `share`. And the evergreen exception was reasoned from the surface's
lifetime, mirroring an existing static-campaign precedent already in the
codebase.

The same defect appears in the strategy document's correction ledger from the
other direction: with a double-digit unattributed session share, blank landing
rows, and digest audiences sharing campaign tags, the honest verdict was that
the analytics could **not** cleanly attribute growth — the first item in the
30-day plan is measurement repair, before interpreting any more growth.

## Related

- [triangulate-before-acting](triangulate-before-acting.md) — a broken
  collection is an unknown, not a small error.
- [release-cohort-attribution](release-cohort-attribution.md) — the release-side
  half of the same problem.
- [kill-thresholds](kill-thresholds.md) — "stop using identical campaign tags
  for materially different audiences" is on its stop-doing list.

Crystallized (partly) as the `measurement-integrity` rule in
`scripts/signal-insights.mjs`.
