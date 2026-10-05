# Brief — settings save beside the field, schedules in Data collection, the Wall's Edit beside the TV (2026-09-23)

Beads: `ro-ujb9.96.7.12` (inline save with Undo, collection schedules in Data
collection, the TV dashboard entry's Edit) and `ro-p8qq` (a screen says "saves
paused" once). Flow measurements: the UX flow audit (private historical evidence),
rows `setting-timezone`, `setting-cadence`, `arrange-wall` in
`results.json` (private historical evidence). Operator rule
D30 (`config/decisions.md`): every setting is set in the Tower, through one
reusable pattern, and reachable from where its effect is visible.

## Prior art

| Product | Source | What it does | What we adopted |
|---|---|---|---|
| GitLab Pajamas — saving and feedback | https://design.gitlab.com/patterns/saving-and-feedback/ | Manual save by default. Autosave only where it clearly helps, and never for financial, security or privacy data. Inline "Saving…" and "Change saved". A failed save is an inline alert that stays until resolved. Undo is "a persistent inline control next to the change, not an action inside a toast". | The whole pattern: `InlineSaveState` beside every field and cell ("Saving…", "Saved · Undo", "Not saved · why"). No toast for a field edit. Money keeps its explicit Save. |
| Linear — workspace settings and undo | https://linear.app/docs/account-preferences · https://linear.app/changelog/undo-actions | Settings changes are saved automatically. Almost every change can be undone. | Low-risk picks save the moment they are made: the time zone, a collection's schedule, the panel-refresh roster, and Settings table cells when the cell is left. Undo is always one press away. |
| Grafana — data source settings | https://grafana.com/docs/grafana/latest/administration/data-source-management/ | A data source's own settings, including its timing and cache options, live on that data source's page, not on a separate operations screen. Provisioned (file-owned) sources are read-only in the UI. | A collection's schedule is edited in Settings → Data collection, on the collection's own row. System health keeps the runner's read-only view and links there. A read-only deployment shows a lock, and the page says why once. |
| Airtable — cell editing | https://community.airtable.com/t5/formulas/saving-and-deleting/td-p/90259 | A cell's value saves as it is edited or left, with ⌘Z to undo. | Settings tables (`CollectionEditor commit="auto"`) save a cell when it is left (Enter, Tab or a click elsewhere) and put Undo under the cell. Escape puts the stored value back. |
| PostHog — dashboard edit mode | https://posthog.com/docs/product-analytics/dashboards | Edit layout from the dashboard itself (E), move, then E to save or Esc to discard. | The sidebar's TV dashboard entry carries an Edit beside it. Arranging the Wall is Edit → move → Save, with no pass through Settings. |

## What each flow costs now

Measured by the audit walk (`docs/artifacts/ux-audit-2026-09-23/walk.mjs`) and
the flow gate (`apps/tower/e2e/ux-flows.mjs`), desktop / phone:

| Flow | Path | Actions | Screens | Page changes | Words | Empty steps |
|---|---|---|---|---|---|---|
| Change the time zone | sidebar Settings → pick a zone (saved) → Undo beside it | 3 / 4 (was 4 / 5) | 2 | 1 | 0 (was 11) | 0 |
| Change how often data is collected | sidebar Settings → Data collection → pick the row's time (saved beside the row) | 3 / 4 (was 7 / 8) | 3 (was 5) | 1 (was 2) | 0 (was 42) | 1 (was 2) |
| Arrange the TV Wall | Edit beside the sidebar's TV dashboard entry → move → Save | 3 / 4 (was 7 / 8) | 2 (was 4) | 1 (was 2) | 6 (was 279) | 0 (was 2) |

The one empty step left on the schedule flow is Settings' own section
navigator: Settings opens on Time & timezone, so reaching Data collection
passes through a screen that decides nothing. The 6 words on the Wall are the
Wall editor's own hint ("Select a widget in the preview."), which the D28
rebuild of that editor replaces. Both are tracked as beads, not fixed here:
`ro-hjd0` (the operator decides how Settings navigates) and `ro-trai.15`
(the Wall editor's hint).

## Decisions kept

- **Money keeps an explicit Save** (Pajamas). This covers the budget fields and the cost tables on /financials. Their outcome and Undo still show beside the field.
- **Structural moves keep their toast.** When a row is removed, the row the Undo would sit beside is gone.
- **The pattern has one confirmation.** `KnobEditor` has no toast mode any more, and every `CollectionEditor` cell says its outcome under itself. A future setting gets both for free.
