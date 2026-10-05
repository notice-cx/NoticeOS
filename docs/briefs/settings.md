# Settings — every setting reads as label, control and current state

*Bead `ro-ujb9.96.6.3` (epic `ro-ujb9.96.6`), 2026-09-23. The global
`/settings` page carried 41 strings (944 words) over the Tower's text budget:
section help, field help, footers under tables, a 83-word paragraph under a
missing task database and a 25-word save toast. Doc 21 principle 3a: a setting
that needs a paragraph is a setting to redesign.*

## Prior art

| Product | Source | Pattern adopted here |
|---|---|---|
| Stripe — customized start of day | <https://docs.stripe.com/payouts/customized-start-of-day> | A time setting shows its **concrete effect** ("takes effect in 17 hours", which hours count as one day) instead of describing it. The timezone field's preview now lists the values the zone decides — the time now, which date is "yesterday" for revenue, which month is current — and they move as the operator picks another zone. |
| Smart Interface Design Patterns — time zone selection | <https://smart-interface-design-patterns.com/articles/time-zone-selection-ux/> | "Always show current times in locations"; zone abbreviation beside the time. The preview keeps the live time and the short zone name; the paragraph about what the zone controls is gone. |
| Vercel — Spend Management | <https://vercel.com/docs/spend-management> | A spend cap is an amount plus current spend against it, and what happens at the cap is a stated effect ("pause projects"), not an essay on what counts. The data cap keeps its meter and one effect line; its 31-word section note and 17-word field help are deleted. |
| Vercel — domain configuration | <https://vercel.com/docs/domains/working-with-domains/add-a-domain> | A misconfigured record gets a **status** and the fix methods as side-by-side alternatives, each with copyable values. A task project whose database is missing now leads with the consequence ("not being backed up") and offers the two fixes as two options — *Edit name* (focuses the field) or *Keep the name* (copyable command) — replacing the 83-word paragraph. |
| GitHub — suggested changes | <https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/incorporating-feedback-in-your-pull-request> | An edit to a file is shown as a diff (removed line, added lines), not described. The `.beads/config.yaml` setup step shows `- sync.remote` and `+ no-git-ops` / `+ import.auto` instead of a 39-word instruction. |
| Sonner / shadcn — toast with action | <https://www.shadcn.io/patterns/sonner-interactive-1> | One toast per save, with its one follow-up as a button. A save whose local file export failed now raises a single warning toast — "Saved — <field>", the command, **Copy command** and **Undo** — instead of a success toast stacked over a 25-word warning. |
| Linear — settings pages | <https://linear.app/changelog/2024-12-18-personalized-sidebar> | Settings as a summary of what is set, grouped by area, with sections that need no preamble. Section descriptions and "About" tooltips that restated the title are removed; scope is a chip in the section header ("All assets", "Read-only here"). |

## What the page does now

- **Section headers** carry a title and, where the scope is not obvious, one
  chip or link (Alert rules: *All assets*; Source catalog: *Status on Health*;
  Task projects in a deployed view: *Read-only here*). No description line, no
  help tooltip.
- **Every field** is label, unit/effect line, control with Save, and a visual of
  its current state in the right-hand column: the timezone's live values, the
  data cap's meter, the hourly figure of the time rate, the freshness bar's fit
  inside the history window (a ✓/✕ chip instead of a sentence).
- **Warnings** lead with what happened in plain words and end in buttons:
  sources missing a status are grouped **by asset** with a *Set status* link
  each; a missing task database says it is not backed up and offers two fixes.
- **Setup steps** after adding a task project are titles plus the exact text to
  paste — a command, a diff, a file — with Copy. No paragraph per step.
