# Search and Growth tabs as state, not sentences (2026-09-23, bead `ro-ujb9.96.6.5`)

The asset page's Search and Growth tabs carried 54 strings over the Tower's
text budget: two `About` disclosures (nine paragraphs), a tooltip paragraph per
section, a sentence inside every opened "where it breaks" row, and a
rationale plus a "next step" paragraph behind every query decision. This brief
records how the best comparable products show the same facts, and the pattern
each screen adopts. The redesign is doc 21 principle 3a applied: show the state,
never explain it.

## Prior art

Researched 2026-09-23 from each vendor's own documentation.

- **Semrush Position Tracking** — the rankings table puts SERP-feature icons
  next to each keyword ("you can hover over one to get its name") and a
  keyword's intent as an icon with a hover name; a keyword's position is a
  number in a column, its URL on hover. No row carries a sentence.
  https://www.semrush.com/kb/549-position-tracking-overview-manual ·
  https://www.semrush.com/kb/1435-ai-overview
- **Ahrefs Rank Tracker** — SERP features are coloured icons: "Blue means you
  rank for it, and grey means a competitor ranks for it"; rankings are
  filtered by position range and by improved/declined, not described.
  https://ahrefs.com/academy/how-to-use-ahrefs/rank-tracker/overview
- **Google Search Console, Performance report** — clicks, impressions, CTR and
  position are four toggled metrics over one chart; "Preliminary data is
  indicated by a dotted line on the graph". The report does not explain the
  chart in prose beside it.
  https://support.google.com/webmasters/answer/7576553
- **Plausible (Search Console keywords)** — impressions, CTR and position are
  columns behind an expand icon; the caveats (24–36 h delay, sampling, clicked
  keywords only) live in the docs, not in the dashboard.
  https://plausible.io/docs/google-search-console-integration
- **PostHog Web Vitals** — p75/p90/p99 is a selector, and each metric is rated
  against published bands ("≤ 2.5s" good, "2.5s - 4.0s" needs improvement,
  "> 4.0s" poor) per path, with Google's thresholds from
  https://web.dev/articles/vitals.
  https://posthog.com/docs/web-analytics/web-vitals
- **PostHog Error tracking** — an issue is read by its counts (exceptions,
  unique users, sessions) and its status (active, resolved, suppressed); the
  issue page shows the stack trace and properties, not a paragraph about them.
  https://posthog.com/docs/error-tracking/monitoring
- **PostHog Funnels** — steps as bars with "conversion relative to the first
  step" or "relative to the previous step", and the drop-off between steps.
  https://posthog.com/docs/product-analytics/funnels

## Adopted

- **Query decisions** (Semrush, Ahrefs): a row is the decision and one short
  imperative ("Near win → Sharpen the title and opening answer"), the query's
  AI Overview state as the existing glyph, and the number the decision is
  about. The applicability of the saved analysis is one state for the whole
  list, in its header; a row carries its own chip only when it differs (the
  same rule `PageDecisions` follows, bead `ro-ujb9.96.6.8`). "Original
  suggestion:" and the per-row "Analysis … · Window ends … · Not rechecked"
  line are gone. When Google and Bing compare the same two windows, the header
  says so once.
- **Charts** (Search Console): provisional days stay hollow points, deploys
  and timezone moves stay marks with their own hover, and the headline period
  is printed above each chart. The paragraphs that described those marks are
  deleted; the chart help carries only each provider's day coverage as counts.
- **Tracked panel** (Semrush, Ahrefs): its scope is one caption — the day, the
  surfaces read, US/English, the depth — shared by the Search board and the
  Growth scoreboard. A term past the depth reads ">20" with the hover "Not in
  the top 20".
- **Search context** (Ahrefs "traffic value"): the money figure is labelled
  for what it is, and the modelled nature and snapshot date are the caption.
- **Product: where it breaks** (PostHog error tracking, web vitals): an opened
  row is labelled counts and a state chip (where the error comes from: site
  code, no source file, unknown), plus one imperative where there is a fix. A
  speed chip's hover is Google's two lines ("INP p75 · good ≤ 200 ms · poor >
  500 ms").
- **Caveats** (Plausible): PostHog's measurement caveats (blocked browsers,
  bots, the consent floor) are documented in
  [doc 20](../20-signal-panels.md) and [doc 11](../11-integrations.md); the
  screen names the source in each section header instead of restating them.
