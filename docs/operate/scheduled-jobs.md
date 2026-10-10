---
title: "Scheduled jobs"
description: "What NoticeOS collects and checks on a schedule, where you change those schedules, and what happens after downtime."
---

# Scheduled jobs

This page gets you the list of jobs an installation runs, how to change or pause each one, and what catch-up after downtime does and does not do.

## Before you begin

- A running installation: the macOS service, a Compose stack, or a `pnpm start` terminal.

### What runs, and when

Times are the product defaults, in UTC. Your installation shows the saved schedule and the next run beside each job.

| Job | Default | What it does |
| --- | --- | --- |
| Live traffic and counters | every 15 minutes | Refreshes the live Google Analytics and Search Console readings |
| Ad revenue | 10, 30 and 50 minutes past each hour | Checks for a new Mediavine revenue report when one is due |
| Data freshness checks | every hour | Flags a site whose report is late or whose connection stopped |
| Operator notifications | 5 past each hour | Sends what changed since its last run |
| Nightly reports | 02:30 | Collects the daily provider reports, including Bing Webmaster |
| NoticeOS report | 03:00 | The installation's own report about itself |
| Outcome checks | 03:30 | Reads the follow-up window of each shipped change |
| Search accessibility checks | 04:00 | Robots, sitemap and indexing checks |
| Backups | 04:00 | The nightly backup; see [Backups and restore](/operate/backups-and-restore) |
| Clarity recordings summary | 04:30 | Summarises Microsoft Clarity data |
| Traffic and search archives | 12:15 | Archives the day's Google Analytics, Search Console and Bing reports |
| Product analytics archives | 12:30 | Archives PostHog reports |
| Search rankings and backlinks | Mondays 12:45 | The weekly DataForSEO collection. This one spends money; see [Budgets](/operate/budgets-and-the-kill-switch) |
| Local research summaries | 13:10 | Refreshes each site's local research files and publishes the summary |
| Task board refresh | every minute | Photographs the task service for the Tasks page |
| Task service health | every 15 minutes | Checks the task service answers |
| Task project checks | 5 past each hour | Checks every declared task project still exists |
| Search review tasks | 25 past each hour | Files a review task when a new search collection lands |
| Unpublished commit checks | 40 past each hour | Files a task when a project's commits sit unpushed |
| Outcome task updates | 50 past each hour | Updates the tasks that track an outcome window |

A `pnpm start` installation runs every collection job, but of the host-side jobs only **Task board refresh** and **Backups**, and Backups only once an offsite folder is configured.

### Catch-up after downtime

While the service is down, a due job is skipped and recorded. At the next start the service runs **at most one** missed run per job, and only when the missed run is recent enough:

| Jobs | Caught up when the last due run is within |
| --- | --- |
| Live traffic and counters | 1 hour |
| Data freshness checks, Operator notifications | 2 hours |
| Daily collections, archives and backups | 36 hours |
| Ad revenue | 36 hours, and only if a report is actually due |
| Search rankings and backlinks (weekly) | 8 days |

The pass runs cheapest job first, so a reboot is not a burst of provider calls. It never replays every missed tick: one missed day of a 15-minute job is one refresh, not 96. A failed run still counts as a run, so catch-up never loops on a failure.

Some things are never caught up, by design: database migrations, restores, settings imports, deployments and any change to alert rules or measurement. Those are your explicit actions and stay that way.

## Change a schedule

1. Open **System health** > **Background operations** (`/health/operations`).
2. Select the job, then **Edit schedule**.
3. Change the frequency, local time or weekday, or set the job to **Paused**. The editor previews the next three runs and saves with Undo. **Restore default** removes your override.

A collection fed by a provider connection is changed with that connection: open **Integrations**, select the connection, and use its **Manage** panel. A collection no connection feeds is changed under **Settings** > **Data collection**.

The **Workflows** page (`/workflows`) lists the operator automations with their history; their schedules are edited the same way. Saved schedules survive restarts and deploys. A time you save uses your browser's time zone; the product default is UTC.

::: tip Pausing is a real stop
A paused job does not run on its schedule, is not caught up after downtime, and refuses **Start collecting** from a connection panel until you resume it.
:::

## Run one job by hand

1. On the macOS service, in the checkout, run the job with its schedule expression:

   ```sh
   pnpm os:cron -- "15 12 * * *"
   ```

A connection's **Start collecting** button runs that provider's first collection at once and previews the cost of a metered step first.

## Verify

- The job's row under **Background operations** shows the saved schedule and the next run.
- `pnpm os:doctor` shows the job records, including what the catch-up ran after a restart.
- `pnpm os:cron` prints the jobs it runs when you pass an expression.

## If it didn't work

- `pnpm os:cron` refuses the expression by name: no job runs on it. Use one of the expressions the command prints.
- **Start collecting** is refused from a connection panel: the job is **Paused**. Resume it under **Background operations** first.
- A provider job records **paused before the monthly data cap**: the metered spend would cross the cap. Raise it under **Settings** > **General** > **Budget**, or wait for next month. See [Troubleshooting](/operate/troubleshooting).

The runner's contract, including the port map and the exact recovery policy, is on GitHub: https://github.com/notice-cx/NoticeOS/blob/main/scripts/README.md#bounded-catch-up-after-downtime.

## Next steps

- [Backups and restore](/operate/backups-and-restore)
- [Budgets and the kill switch](/operate/budgets-and-the-kill-switch)
- [Settings](/tower/settings)
