# The Sites list needs no explanation (2026-09-23, bead `ro-ujb9.96.6.10`)

The Sites page carried 387 words of explanation — an About of five paragraphs
under the table, two paragraph tooltips on its column headers, and sentences in
every dash — and its setup checklist and entity rules carried 67 more. Each
fact is now on the page as a label, a state or a line's own readout, or it is
gone because the screen already showed it. Captures:
`ux-zero-2026-09-23/add-site-copy/` (private historical evidence).

## What the operator sees

- **No About.** Its five paragraphs said what the columns are (the headers
  already do), that a row opens its site (the pointer and the link do), how
  the lines are averaged (each line's own readout names its 7-day average),
  what Net is (the header names the month and the booking state), and that
  the strip ignores the filters (the line above the table names the view).
- **The move rides its line.** The users column was a line, then a column
  headed `28-day` holding a percentage that needed a paragraph to say what it
  compared. The percentage now sits beside the users line under
  **Users · 28d**, which is the header that orders by it. At 90 days there is
  no earlier 90 to compare with, so no percentage is drawn — no column of
  dashes with hover sentences.
- **Search clicks · 28d**, not "Clicks": a portfolio with ad and affiliate
  clicks cannot misread it. Google and Bing are one line, as before.
- **Today shows its day.** When the newest number is a settled past day, the
  day is printed under it (`100` over `Sep 5`) instead of a hover sentence
  saying so.
- **The table fits the card at 1440** on Sites and Home (0px sideways; before,
  the Reported column was cut off): one column fewer, and the headers name
  only the quantity and the window.
- **A dash says why in a label**: *No days reported yet*, *Only 2 days
  reported*, *No task data*. The Tasks cell no longer names a config file.
- **No sites match these filters** says only that: the line above it names the
  filters and holds Clear.
- **KPIs**: Sites is the count and the receiving-data bar (the derivation note
  went); Avg. daily users keeps one label-length fact — *Every site's users
  added together*; empty counts say *No daily history kept*.
- **Setup checklist notes are counts**: *9 of 28 days* under *Report coverage ·
  28 days*; *Unknown*; *No name · shows as example.com*.
- **Entities**: the refusal sentence for a site claimed by two entities was in
  a function nothing called — Settings does not offer an entity's site list,
  and a site's own card moves it in one change — so it is gone.

## An empty site list is a door (bead `ro-ujb9.96.6.18`)

The site table's default empty state read *No sites onboarded yet — The first
site arrives with its seed row and its nightly report*, from before a site
could be added in the Tower. It is now **No sites yet** with **Add a site**
beside it (`NoSitesYet`, in `components/AddSite.tsx`), for any list whose page
has no Add a site of its own. Sites keeps its header's Add a site and a bare
*No sites yet*, so the page has one button, not two. The TV card grid says
*No sites yet* and offers nothing: nobody presses a TV.

## Prior art

| Product | Source | Pattern adopted |
|---|---|---|
| Plausible — the sites index | https://plausible.io/sites | Each site is a row with its visitors, a small graph and the change beside the graph; nothing on the page explains the arithmetic. The move rides its line here the same way. |
| Stripe — Home's metric cards | https://dashboard.stripe.com | A metric is its value, its change against the prior period as a small signed chip, and its chart; the comparison window is named once in the page's range control, never in a sentence. |
| Google Search Console — Performance, compare mode | https://search.google.com/search-console/performance/search-analytics | Comparison columns exist only while a comparison is selected; with nothing to compare, no difference column is drawn. Here: no earlier range, no percentage. |
| Vercel — the projects list with no project | https://vercel.com/new | An empty list is one line and the one action that fills it; it never explains how items used to arrive. `NoSitesYet` is that shape. |
