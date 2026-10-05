# Settings as a few focused forms (bead `ro-ujb9.18`, 2026-09-23)

*Epic `ro-ujb9` (a stranger's installation). Decisions D22 (settings live in
the store and are set in the Tower) and D30 (a new installation grasps what is
where from the product itself). Before this, `/settings` was eight thin
sections, one card each, in a left list: Time & timezone, TV dashboard,
Budget, Alert rules, Data collection, Source catalog, Ownership, Task projects
(before; historical reference excluded from public source). The first screen a
stranger met was one select. Changing the data budget took a press on
"Budget" first, and read a 9-word sentence under the meter. The data-source
catalog, which is product definition, was one of the eight
(`ro-ujb9.96.14` removed it).*

## Prior art

| Product | Source | Pattern adopted here |
|---|---|---|
| Vercel: project settings | <https://vercel.com/docs/project-configuration/project-settings> | Settings open on **General**, which holds the foundational settings. Specialised areas (Domains, Git, Functions, Cron Jobs…) are their own entries in the settings sidebar. NoticeOS opens on **General** (time zone and budget) instead of a one-field Time & timezone page. Alerts, Data collection, TV, Ownership and Task projects keep their own entries. |
| Vercel: Spend Management | <https://vercel.com/docs/spend-management> | A spend amount ("On-Demand Budget") sits beside the action taken at the amount, shown as a switch that is either on or off (**Pause Production Deployments**). Current spend is measured against the amount. The data budget keeps its meter of this month's spend. The 9-word sentence becomes a state chip, **Stops at the budget**. |
| Stripe: Dashboard settings | <https://docs.stripe.com/dashboard/basics> | Settings are grouped by what they apply to (Personal, Account, Product), and a product's settings sit with that product. What applies to every site is on `/settings`. A site's own settings stay on its Settings and Data sources tabs, and a provider's credential stays on Integrations. Settings links to those places and does not copy them. |
| Linear: preferences and workspace settings | <https://linear.app/docs/account-preferences>, <https://linear.app/docs/workspaces> | Short, labelled rows grouped under a few headings. Members see only the settings about their own work; admin sections appear for admins. **Task projects** is listed once a task source is connected or a project exists (D32). Before that it is reachable only from Integrations' Beads Connect, which opens it. |
| Plausible: site settings | <https://plausible.io/docs/change-domain-name> | Site settings → **General** holds the site's identity details and its reporting time zone ("Change your reporting timezone"). NoticeOS's reporting clock is on General too, and its first option is the zone this browser runs in. |

## What the page does now

- **Six entries, General first**: General · Alert rules · Data collection · TV
  dashboard · Ownership · Task projects (the last only with a task source or a
  saved project). The old addresses still open the right place:
  `#clock` and `#budget` open General at their card, `#data-sources` opens
  Integrations, and `#scheduled-jobs` opens Data collection.
- **General** is two cards: **Time zone** (the select, with this browser's
  zone as the first option, and the values it decides beside it) and
  **Budget** (the monthly data cap with its meter and the **Stops at the
  budget** chip, and the value of your time with its hourly figure).
- **Plain labels**: "Time zone" (was "Operator timezone"), "Value of your
  time" (was "Operator time rate"), "Nightly reports" and "Site health" in
  Data collection (was "Asset reports" and "Asset health", `ro-ujb9.153`).
- **Feedback is the same on every field**: Saved · Undo, or Not saved with the
  reason, beside the field (`KnobEditor` / `InlineSaveState`). A pick saves.
  Money keeps its Save.

## Walkthroughs (flow gate, `apps/tower/e2e/ux-flows.mjs`)

| Task | Before | After |
|---|---|---|
| Time zone (`setting-timezone`) | Settings → pick → Saved → Undo | the same; the field is on General |
| Spending cap (`setting-budget`) | Settings → **Budget** → type → Save, reading 9 words | Settings → type → Save, reading none |
| Collection setup (`setting-cadence`) | Settings → Data collection → pick a time → Saved | the same |
