# A PostHog site's project and funnels, picked on its Data sources row (2026-09-23, bead `ro-ujb9.96.7.24`)

*Public summary updated 2026-10-01: installation-specific identifiers are omitted or explicitly illustrative. The dated original is retained privately; measurements and vendor research are unchanged.*

The connect panel already finds a PostHog account's region, lists its
projects matched to sites by domain, and picks up each project's saved funnels
(bead `ro-ujb9.96.7.8`). A site's own PostHog row — where an operator goes to
change those values later — still asked for the region as a select, the
project id as a typed number and every funnel step as a typed event name and
page path, each with its own Save. The row now picks from the same account
read the panel makes (`GET /api/integrations/posthog/sites`).

## What the operator sees

- **Project** — one select of the account's projects, each by name, number
  and region (illustrative label: `Example site · 12345 · US`). A pick saves the region and the number
  in one write, with **Saved · Undo** beside it. A project the account no
  longer lists stays selected as itself (illustrative label: `12345 · not in this account`).
- **Funnels** — the site's funnels as rows (name and steps on one line), each
  with its own remove press, and **Add funnel**: a select of the project's
  saved funnels that are not on the list yet. A pick or a removal is saved at
  once, the whole list in one write, with **Saved · Undo** beside it.
- **The typed fields only when the account cannot be read** — PostHog not
  connected, PostHog refusing the key, or no answer. Then the row is the
  region, the project id and the typed funnel editor it was.

Built on the existing pieces: `useAccountSites` (the panel's read, one per
page), `FunnelListEditor`'s picked mode (`saved`), `InlineSaveState`, and the
Data sources tab's own write (`laneFieldOp`). Captures:
`ux-zero-2026-09-23/connect-2/` (private historical evidence).

## Prior art

Researched 2026-09-23 from each vendor's own documentation.

- **PostHog — dashboards.** A saved insight is added to a dashboard from the
  insight itself ("Add to dashboard"); the same insight can sit on several
  dashboards, so nothing is recreated.
  https://posthog.com/docs/product-analytics/dashboards
- **Grafana — library panels.** On a dashboard, **Use library panel** opens
  the panel library; search, click a panel, and it is on the dashboard.
  https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/manage-library-panels/
- **Metabase — dashboards.** A saved question is put on a dashboard with **Add
  to dashboard**, or picked from the saved questions with **+** in the
  dashboard's edit mode.
  https://www.metabase.com/docs/latest/dashboards/introduction
- **GitLab Pajamas — saving and feedback.** A single low-risk field saves on
  change, with "Saved" and Undo beside it.
  https://design.gitlab.com/patterns/saving-and-feedback/

**Adopted:**

- PostHog's, Grafana's and Metabase's reuse: a funnel defined once in PostHog
  is picked here from the project's saved ones, never retyped as event names.
- Pajamas' inline save: the pick is the save, with Undo beside the field —
  the same pattern the DataForSEO market uses on the same tab.
- The typed editor stays only as the fallback for an account the row cannot
  read, so a site on an older per-site key is never left with nothing.
