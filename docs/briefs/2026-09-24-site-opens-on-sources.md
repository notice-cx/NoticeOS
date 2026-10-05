# A new site opens on its Data sources (2026-09-24, bead `ro-ujb9.96.7.4`)

Configuring a site's sources (the flow gate's `configure-sources`) walked
Home → the site's Overview → its Data sources. The Overview of a site with no
number yet has nothing to draw, so the gate counted it as an empty step: a
screen the operator passed through without deciding anything. The UX audit had
already proposed the fix (docs/reports/2026-09-23-ux-flow-audit.html,
"Configure an asset's sources"): "While setup is unfinished, the asset opens on
Data sources."

## What the operator sees

- Until a site has its first number, its row in the sidebar, in the Sites
  table and in the command palette opens its **Data sources**, where its next
  action is (Connect on each source).
- From the first number on, the same links open its **Overview**.
- "First number" is Home's own rule (`siteHasFirstNumber` in
  `apps/tower/shared/first-run.ts`): a day of users or search clicks, a nightly
  report, money, or a recorded collection. The same rule ends Home's setup
  guide, so the guide and the site's links change at the same moment.
- The sidebar row still lights on every tab of its site, whichever tab it
  opens on.

Flow gate (`apps/tower/ux-flows.json`, `configure-sources`): desktop 7 → 6
actions, 3 → 2 screens, 1 → 0 empty steps; phone 9 → 8, 3 → 2, 1 → 0.

## Prior art

Researched 2026-09-24.

- **Linear — the sidebar goes to a team's own pages.** "Open any team's home
  page by clicking on the team's name in your sidebar"; its settings are one
  menu away ("hover over the team name in your sidebar, click the three dots
  `···` menu, and select Team settings").
  https://linear.app/docs/teams
- **Vercel — one click between the team's and the project's version of a
  page.** The 2025 navigation moved project pages into the sidebar and lets you
  "Switch between team and project versions of the same page in one click".
  https://vercel.com/changelog/new-dashboard-navigation-available
- **Sentry — a new project opens on its setup.** After a project is created
  "you're taken to the quick Configure [SDK] guide", and Issues is the next
  press ("Take me to Issues").
  https://docs.sentry.io/product/sentry-basics/integrate-frontend/create-new-project/
- **Plausible — a site's page becomes its dashboard at the first visit.** "The
  dashboard starts displaying stats in real-time as soon as the first visit is
  counted"; before that the site is waiting on its setup (see
  [the first-run brief](2026-09-23-first-run.md#prior-art)).
  https://plausible.io/docs/troubleshoot-integration

**Adopted:** Sentry's and Plausible's rule — a new site opens on its setup and
becomes its dashboard at the first number — with Linear's direct sidebar link
to the site itself.

**Not adopted:** a Linear-style `···` menu on each sidebar row (a second
control on every row, for a destination the row itself now reaches), and
Vercel's same-page switch (the flow starts on Home, where there is no site page
to keep).

## What is still short of the audit's 4 actions

The audit's target of 4 assumed "Not using" would be one click with an
optional reason. The operator chose a required reason chip instead (answer A
on `ro-ujb9.96.7.13`), which adds one press. Opening each collapsed row adds
one more per source, because each row's face carries one action (Connect).
The walk is now: open the site (1), open Clarity (1), Not using (1), the
reason (1), open DataForSEO (1), the market (1) = 6. Whether 6 is the target
is the operator's call: bead `ro-ujb9.96.7.27`.
