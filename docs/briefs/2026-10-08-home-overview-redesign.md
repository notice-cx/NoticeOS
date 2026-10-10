# Home and the site Overview, redesigned (2026-10-08, D44)

The operator's brief: the Home and each site's Overview "look boring, repetitive
of the details pages, cookie cutter, not visually engaging", pack "way lower
level than necessary", and the chosen components "seem unrelated to the
underlying business needs". Two further constraints: the operator has ADHD, so
the first screen must keep a distracted brain engaged without overwhelming it;
and a founder reviewer called the whole product "technical", which turns away
the business-focused founders NoticeOS is for.

This brief records the research, the decision and the prior art each new flow
cites. The directions themselves were presented as a private design canvas
(fifteen boards; historical evidence, not in the public source). The rule is
[doc 14](../14-design.md); this brief is the evidence behind its
2026-10-08 amendment.

## What the code showed (the diagnosis)

1. Home and the Overview share one grammar: strip, hero chart, two list
   panels, a table or small multiples. The eye learns nothing on the second page.
2. Home's first screen is plumbing: two of three status cells are the OS
   describing itself ("4 / 6 fresh · 12 jobs", "captured in preview").
3. Money is a caption: one column of four, composition under it, no pace, no
   yesterday. The Wall already leads with the month's revenue and its pace.
4. The loop is invisible: no surface shows a bet, a watch window, a prediction
   against its outcome or what shipped.
5. Nothing says "since you last looked". Every visit renders the same panels.
6. The altitude is wrong for the audience: "GA4", "nightly report",
   "provisional", "gate", "captured in preview" are operator-of-the-OS words.

## Decision (operator, 2026-10-08)

- **Home is the Morning Brief** (direction A). A greeting line with three small
  figures (yesterday's revenue, the month's pace, yesterday's visitors); then at
  most five "since you last looked" highlight cards, the first the big thing;
  then Decide, at most three rows; then the sites in seed order; then a finish
  line naming the next sweep. Chosen over the Money Clock hero (B).
- **A site's Overview is the Story** (direction 1 with 2's verdict line): a
  verdict pill and one line of three facts, a hero row of money, people, search
  and product, one chart carrying shipped changes and watch windows, bets
  ranked by dollars, product cells that say "normal".
- **Accent system 3, soft depth**: a card declares a kind and wears its tint,
  the live point has a halo, glass is for chrome only.
- **The language sweep covers the whole Tower**: the altitude rule in
  [doc 14](../14-design.md) and its test.

## Prior art

Every section below cites at least three comparable products, as the flow gate
and the UX gate require of a new flow or a widened surface.

### home

The first screen answers "what changed and what needs me", with the money as
one line, not a grid of equal cards.

- **Apple Health — Highlights.** Short comparative statements ("walked more
  than yesterday"), one per card, tap to drill, "Show All Highlights" as the
  explicit end. https://support.apple.com/en-ca/HT203037
- **Oura — Today tab (2025).** Score chips, then ONE daily highlight ("One Big
  Thing") chosen by the day's shifts, then the day's timeline; modelled on a
  news app's top stories. https://ouraring.com/blog/new-oura-app-experience/
- **Linear — Pulse (2025).** A personalised feed of status-bearing update
  cards with a health badge, and the AI digest delivered to the inbox rather
  than squatting on the page. https://linear.app/changelog/2025-04-16-pulse
- **Ramp — homepage.** A task feed first, a spending snapshot beside it, FYI
  digest items, banners only for urgent actions; collapsed sections stay
  collapsed. https://support.ramp.com/introduction-to-homepage
- **Mediavine — rebuilt dashboard.** Yesterday, month to date and last month
  side by side, with a to-do list. https://www.mediavine.com/blog/mediavine-dashboard-rebuilt/

Adopted: bounded highlight cards ranked by severity, then dollars, then kind;
one big thing; a visible end; money as a header line.

### decide

The queue is cleared from the row, with one key per verb and undo instead of
confirmation.

- **Linear — Triage.** Accept, duplicate, decline, snooze from the row; keys
  1 / 2 / 3 / H. https://linear.app/docs/triage
- **Superhuman — triage.** Three outcomes per item: now, later, done.
  https://help.superhuman.com/article/502-triage
- **Codex — agents dashboard (2026).** Three groups in attention order: need
  input, working, ready to review.
  https://hackernoon.com/the-terminal-tab-problem-codex-finally-solved-for-multi-agent-work
- **Cursor — Needs Attention.** Agents blocked on you plus finished work not
  yet reviewed, grouped first. https://forum.cursor.com/t/agents-approval-window/170388

Adopted: Approve / Answer / Dismiss on the row (the Tasks board's own verbs),
Look / Snooze on an alert row, at most three rows, "more, not urgent" as the
link out.

### overview

One verdict, one chart that shows what was done to the site, bets with dollars.

- **Ahrefs — Site Explorer Overview 2.0.** Content changes and algorithm
  updates drawn on the traffic series, so cause and effect share an axis.
  https://ahrefs.com/blog/whats-new-at-ahrefs-2022/
- **Plausible — annotations.** Notes attached to the graph for launches and
  changes; hover to read. https://plausible.io/changelog
- **Linear — project health.** Exactly three verdict words: on track, at
  risk, off track; grey when stale.
  https://linear.app/docs/initiative-and-project-updates
- **Statsig / Eppo — lift display.** Interval bar centred on zero, grey while
  not significant, colour only on a verdict.
  https://docs.statsig.com/experiments/interpreting-results/read-results ·
  https://docs.geteppo.com/statistics/confidence-intervals/
- **Google Search Console — Overview.** Health first (manual actions, errors),
  then the performance card, then the reports.
  https://support.google.com/webmasters/answer/9133276

Adopted: verdict pill from one rule; watch windows shaded on the hero chart;
ship marks labelled on the plot; "usually N" as the one baseline word.

### surface-kinds

- **Mercury.** Green for growth, blue for stability, red and yellow only for
  errors and warnings, no aggressive accent.
  https://www.925studios.co/blog/mercury-design-breakdown
- **Raycast 2 (2026).** Liquid glass "in tasteful ways", dark first, one
  accent, translucency kept off dense data.
  https://raycast.com/blog/the-new-raycast
- **Copilot Money.** Strict semantic colours; charts as the primary
  interaction layer. https://blakecrosley.com/guides/design/copilot-money
- **Stephen Few — bullet graphs** (over gauges and rings):
  https://www.tableau.com/chart/what-is-bullet-graph · Apple's HIG forbids
  repurposed Activity rings:
  https://developer.apple.com/design/human-interface-guidelines/activity-rings

Adopted: four card kinds (money, alert, win, neutral) as tints on one card
shape; the now-point halo the Wall already draws; glass on chrome only; no
rings or gauges anywhere.

### language

- **W3C COGA — Content Usable.** Avoid too much content, make the most
  important actions easy to find, keep text succinct, consistent visual
  design. https://www.w3.org/TR/coga-usable/
- **NN/g — dashboards.** One task per dashboard; colour reinforces, never
  carries alone. https://www.nngroup.com/articles/dashboards-preattentive/
- **GrowthBook — decision statuses.** "Ship now", "Roll back now", "~7 days
  left": verdict words, not statistics.
  https://dev.to/growthbook/experiment-decision-framework-for-automated-shipping-recommendations-5a5o
- **The 2026 "default Linear look" critique.** Differentiation comes from
  prioritisation logic and theming, not the palette.
  https://www.buildmvpfast.com/blog/linear-aesthetic-tokens-density-keyboard-first-ux-2026

Adopted: three altitudes (business, operational, technical); a word appears on
its own altitude or below, never above; enforced per route group in
`scripts/ui-lexicon.test.mjs`.

## ADHD rules the first screens meet

From the research (COGA, NN/g, Bach et al.'s dashboard patterns, the 2026
AttentionGuard and FocusView studies, practitioner ADHD-UX writing):

1. At most five regions above the fold, stratified top-down, one hero.
2. The first region is what changed or needs a decision, never static totals.
3. Every list has an end and a count; "running" things are closed by default.
4. Four verbs clear anything, with undo and never a confirmation.
5. Relative time everywhere, "data as of" on live figures, days left on bets.
6. Big number, delta, sparkline; bullets, never gauges or rings.
7. Colour is a verdict or an identity, always with a glyph or a word.
8. A 14 px body floor, at most three weights, hierarchy by size.
9. No paragraphs; the twelve-word gate.
10. Motion only on a data change, 150–400 ms, parity under reduced motion.
11. Chrome never moves; novelty comes from the data.
12. Keys shown inline; the palette from anywhere.
13. A finish line that names the next obligation; no streaks.
14. Exits from every rabbit hole: park for later, a breadcrumb with a count.
15. At most three personalisation controls.

## What stays honest

Provisional is hollow, missing is a dash, unmeasured says so, a projection is
dashed and neutral, a comparison that is not like for like carries no colour.
Said-versus-got (the Learn stage) draws nothing until the realized-value lane
exists ([doc 00](../00-objective-and-roi.md), state 2026-09-30).
