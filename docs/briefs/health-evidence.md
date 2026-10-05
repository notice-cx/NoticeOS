# Health evidence as facts (2026-09-23, bead `ro-ujb9.96.6.2`)

The Health page's audit grid ("Every source, asset by asset") answers two
questions about each source: *why is this cell in this state* (the "Why this
state" panel on a cell) and *what is this source* (the row opened under its
name). Both answered in paragraphs: 38 sentences in
`apps/tower/worker/integration-evidence.ts`, from "The 15-minute GA4 collector
is running, but the nightly archive has stored no GA4 report for this asset in
the last 400 days — the deeper history behind the analysis is not
accumulating" to two doc-11 paragraphs ("Usage limits", "On failure") under
every opened source. The contract's monitor list carried the same kind of prose
(`cadence`, gap reasons) in a payload no screen read.

## What the operator sees now

- **Why this state** — one row per observation: what happened (the row's
  title, unchanged: "GA4 collector succeeded", "Nightly archive is stale"),
  when (its age), and the facts behind it as values:
  `1,840 daily rows · 2026-09-16 → 2026-09-22 · provisional from 2026-09-22`,
  `0 runs in 400 days`, `Due daily`, `Resumes 2026-10-01`,
  `Fetched nightly · https://…`, `$80.85 · latest 2026-08`. A working nightly
  report adds nothing: its chip says Working and its age says when.
- **An opened source** — a row of four facts before anything else:
  `COST Free · RUNS Every 15 min · LIMIT 1,200 queries/min · IF IT FAILS Keeps
  last data`. The cadence is `collectionCadenceHours`, the figure the lane's
  freshness is judged by, so it cannot disagree with the Overdue chip. The
  methodology behind each fact stays in docs/11-integrations.md's catalog.
- **Scheduled jobs with nothing recorded** — the summary's own warn question
  mark and headline ("Scheduled runs not yet recorded"), without the sentence
  that said unknown is not healthy.
- **A failing PostHog or Discord site** — its fix in eight words; the clause
  that restated the operation list below it is gone.

## Prior art

Researched 2026-09-23 from each vendor's own documentation.

- **Fivetran — connection Status tab.** Each sync event is a set of labelled
  fields — start time, end time, sync duration (extract / process / load) and
  loaded rows — not a narrative; failed syncs are red on the sync-history chart
  and open to "View error".
  https://fivetran.com/docs/using-fivetran/fivetran-dashboard/connectors/status
- **Airbyte — connection status and timeline.** A connection's state is a
  status word (Healthy, Failed, Running, Paused, Queued) beside "time since last
  record loaded" and a records-loaded graph; rate limits show as a countdown to
  the next attempt rather than an explanation; the actions ("Sync now",
  "Refresh stream") sit beside the state.
  https://docs.airbyte.com/platform/cloud/managing-airbyte-cloud/review-connection-status
- **Airbyte — sync schedules.** How often a connection runs is one label from
  a short vocabulary: "Every 15 minutes", "Every 24 hours", "Cron", "Manual".
  https://docs.airbyte.com/platform/using-airbyte/core-concepts/sync-schedules
- **Sentry — Crons job monitoring.** A monitor is a daily bar of successful,
  failed and missed check-ins plus a table of recent check-ins with their
  status; a missed run is a state on the timeline, not a paragraph.
  https://docs.sentry.io/product/monitors-and-alerts/monitors/crons/job-monitoring/
- **Datadog — integrations** (from `2026-09-23-connection-status.md`): "Missing
  Data" means no metrics in the last 24 hours — a recency window stated as a
  state.
  https://docs.datadoghq.com/getting_started/integrations/

**Adopted:**
- Fivetran's evidence shape: an observation is its outcome, its time and its
  counts and dates as values. Every "Why this state" row is title + age +
  `·`-separated facts; no row carries a sentence.
- Airbyte's schedule vocabulary: "Runs" reads `Every 15 min`, `Daily`,
  `Weekly`, or the event that runs it (`On deploy`, `On request`, `On alert`,
  `After a failed fetch`).
- Airbyte's countdown over explanation: a source stopped at the data cap says
  when it resumes (`Resumes 2026-10-01`), not why caps exist.
- Sentry's "missed is a state": an empty scheduled-job record wears the
  unknown glyph, and a stale report states only the cadence it missed
  (`Due daily`) beside its age.
