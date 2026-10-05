# Decisions and findings without explanatory text

*Bead `ro-ujb9.96.6.8`, 2026-09-23. Surfaces: the Search tab's page
decisions (`PageDecisions`), the recommendation applicability check
(`shared/recommendation-validity.ts`, drawn by `RecommendationReview` /
`AnalysisEvidence`) and the Overview's full findings list
(`ExecutiveFindingsList`).*

The question these surfaces answer is "what should I do next, and is the advice
still good?". Before this change each answer arrived as a paragraph: a 25–37
word "next step" per page, a 10–15 sentence applicability tooltip, and three
reassurance sentences around the findings list.

## Prior art

| Product | Source | Pattern adopted |
|---|---|---|
| Sentry — Suspect Commits | https://docs.sentry.io/product/issues/suspect-commits/ | The tool does the "check the deploy timeline" step itself: the issue shows the commit that most likely caused it, not an instruction to go and look. A click-move page decision now tags the **likely cause** on its evidence: the signal that moved (ranking or demand), else a release recorded inside the comparison window, else the result page. The operator is not asked to work it out. |
| Vercel Speed Insights | https://vercel.com/docs/speed-insights/using-speed-insights | Routes are grouped by rating (poor / needs improvement / good) and sorted by volume inside each group; the numbers sit next to the rating, and methodology stays in the docs. The findings list groups by kind (warning signs, recommendations, discoveries, insights) with the original rank kept inside each group, and the group heading carries the count, replacing the separate count strip. |
| Ahrefs Site Audit | https://ahrefs.com/site-audit, https://help.ahrefs.com/en/collections/1539899-issues | Each issue shows its severity colour, its name and its affected count, and nothing else. "How to fix" is one click deeper. A closed decision row shows a glyph, the page, what happened, what to do and the click change. Opening it shows the evidence and the handoff actions. |
| GitHub Dependabot alerts | https://docs.github.com/en/code-security/dependabot/dependabot-alerts/viewing-and-updating-dependabot-alerts | Staleness and state are chips (Open / Fixed / Dismissed); a dismissed alert can be reopened. The timeline sits in the details. Applicability is now a state chip, shown on a row only when that row is different from its list (for example, linked work shipped). Source report dates, linked tasks and releases are a compact table in the evidence popover, not sentences. |
| Linear triage / Gmail undo | https://linear.app/docs/triage, https://m3.material.io/components/snackbar/guidelines | Reversible actions show that they are reversible when you use them: an **Undo** in the confirmation toast. Dismiss now shows "Finding dismissed" with Undo, so the "marks and dismissals are reversible" sentence is gone. |

## What changed

- **Page decisions.** Each closed row reads "what happened → what to do": a
  two-to-three-word label and one action of 12 words or fewer. A lost-clicks
  or gained-clicks row infers its likely cause from data it already has, most
  specific first: average position moved by a full position (ranking), else
  impressions moved by 20% (demand), else a release recorded inside the
  comparison window, else the result page itself. The matching evidence line
  carries a "Likely cause" tag. The rationale sentence that restated the
  evidence is gone; the copied brief names the same structured cause.
- **Applicability.** `recommendationValidity` returns structured checks (per
  source: analyzed window, latest report, status; linked tasks and the
  releases that name them; the recorded decision) instead of
  `reasons: string[]`. The "Source dates" popover draws them as a table. A
  closed row shows a state chip only when its state is not the default "Not
  rechecked". Page decisions all read one page report, so their shared state
  appears once in the list header, and a row shows a chip only where it
  differs.
- **Findings list.** Grouped by kind (Marked first), with the count in each
  heading. The rank continues across groups. Dismiss shows a "Finding
  dismissed" toast with Undo. The two small-print sentences and the "below
  the cut" paragraph are gone; the cut reads "N more below the top 8".
