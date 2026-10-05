# A collection's schedule is changed on its source's connection (2026-09-24, bead `ro-ujb9.96.7.28`)

Operator decision 2026-09-24, recorded on the bead. It replaces where bead
`ro-ujb9.96.7.12` put the schedules (Settings → Data collection). Decision
`ro-hjd0` still stands: Settings keeps showing one section at a time. The
schedule moves out of Settings, and Settings itself does not change.

## Why

To change how often data is collected, the flow gate's `setting-cadence`
walked Sidebar Settings → the section list's **Data collection** → the row's
time. The Settings page opens on General, so the section press was a screen
where nothing was decided. That was the last empty step in the flow registry
(`Legacy debt still held for epic ro-ujb9.96.7: emptySteps 2`).

Moving Settings' landing section could not fix it. Changing the time zone,
changing the budget and changing a schedule all start from the same state.
So any rule for where Settings opens makes two of them pay for the third.

## Prior art

Researched 2026-09-24. Every comparable data-sync product puts the sync
schedule on the connection it collects from.

| Product | Source | Where the schedule is |
|---|---|---|
| Fivetran | <https://fivetran.com/docs/core-concepts/syncoverview> | "On the Settings tab of your connection details page, select your Sync frequency." |
| Airbyte | <https://docs.airbyte.com/platform/cloud/managing-airbyte-cloud/configuring-connections> | Connections → the connection → Settings tab → **Schedule Type** (scheduled, cron or manual). |
| Hightouch | <https://hightouch.com/docs/syncs/schedule-sync-ui> | The sync's own **Schedule** tab. |
| Grafana | <https://grafana.com/docs/grafana/latest/administration/data-source-management/> | A data source's own settings, including timing and caching, are on that data source's page. |

Not adopted: Vercel's separate **Cron Jobs** entry in its settings sidebar
(<https://vercel.com/docs/cron-jobs/manage-cron-jobs>). It is one more press
from the settings landing, which is the step this bead removes.

**Adopted:** the Fivetran and Airbyte placement. NoticeOS's connection page is
its Manage panel on Integrations, so a collection's schedule is a row there.

## What the operator sees

- **Integrations → a source's Manage → its collection's time.** The row sits
  under the connection's Replace and Disconnect, above its sites. It is the
  same picker Settings used (`ScheduleRows`). Picking saves, and
  **Saved · Undo** appears beside the row.
- **One job, several sources.** The traffic and search archives are collected
  from Google (Analytics and Search Console share one Google connection) and
  from Bing. The job's row, headed by the job's own name, is on both panels.
  A pick in either writes the job's one saved schedule.
- **Per source:**
  - Mediavine → Ad revenue
  - Clarity → Clarity recordings summary
  - PostHog → Product analytics archives
  - DataForSEO → Search rankings and backlinks
  - Google and Bing → Traffic and search archives
- **Settings → Data collection keeps what no connection feeds:** Nightly
  reports, Live traffic and counters, Local research summaries. It also keeps
  its history-window settings and nightly report pulls, so the section stays.
- **System health → a collection's page** links to wherever the job's editor
  now is. That is **Edit in Integrations** (the first connected source's
  panel) or **Edit in Settings**. A collection whose sources are all
  disconnected has no link, because nothing collects.

One derivation decides all of this: each job's declared `connections`
(`scripts/scheduled-jobs.mts`), read through `connectionCollections`,
`settingsCollections` and `scheduleHref` in `apps/tower/shared/scheduled-jobs.ts`.

## Flow gate

`setting-cadence` is now Integrations → **Manage** on Bing's row → the
archives' time → Saved. Before/after figures are in `apps/tower/ux-flows.json`
and in the bead's closing evidence. Captures are in
`docs/artifacts/schedule-on-connection-2026-09-24/`.
