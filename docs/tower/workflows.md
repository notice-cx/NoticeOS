---
title: "Workflows"
description: "What NoticeOS runs on its own for your assets and your work, when each one runs next, and how its runs went."
---

# Workflows

A **workflow** is something NoticeOS does on its own, on a schedule or when an event occurs, for your assets and your work: reading outcome checks, updating the tasks that track them, filing review tasks, sending notifications. Each has a purpose, a trigger and a history of runs. The **Workflows** page lists them; the jobs that keep NoticeOS itself running, such as collection and backups, are on **System health** > **Background operations** instead.

The Workflows page shows whether anything NoticeOS runs on its own is failing, and when each one runs next.

## What you see

**The summary.** **1 of 5 workflows need attention** counts the ones that failed or whose state cannot be confirmed; otherwise **No workflows need attention**. The line under it counts every other state once, such as **3 succeeded · 1 paused**. The header shows which time zone every time on the page is in: **Times in** your browser's zone.

**Two tabs.** **Activity** (`/workflows`) shows the last 24 hours; **Schedule** (`/workflows/schedule`) shows the next 24.

**The list.** One row per workflow, grouped by category (**Outcomes**, **Tasks**, **Notifications** and the rest), each group heading counting its states:

| Column | What it holds |
|---|---|
| **Workflow** | its name, which opens its page |
| **State** | its latest state, such as **Succeeded**, **Failed** or **Paused** |
| **Hourly activity** | on **Activity**: the last 24 hours as one bar an hour, green when its runs succeeded, red when one failed and grey when they were skipped; a low line is an hour with no runs. Under it, how long ago the latest run started |
| **Now** to **+24h** | on **Schedule**: when it will run over the next 24 hours |
| **Next run / trigger** | when it runs next, or **On new alerts** for event-triggered delivery; its schedule or recovery cadence appears below |

A count under the list shows how many of the installed workflows are listed.

**A workflow's page.** Its name and state, then **Schedule · Local time**, **Next execution** and **Category**. **Execution stages** draws the steps of one run, with its state, start time, how long it took and whether you started it by hand (**Manual**); **Run** selects which run is shown. **Recent runs** lists the latest 10, each opening its stages.

## What you can do

- Search by name, and narrow the list by **State** (**Needs attention**, **Failed**, **Running**, **Succeeded**, **Inactive**) and by category.
- **Sort** by **Latest run**, **Needs attention**, **Next run** or **Name**; **Group** by **Category** or **None**. Every choice is in the page's address, so a link includes it.
- Select a workflow to open its page, or the age under its bar to open its latest run.
- **Edit schedule** on a workflow's page: turn it **Enabled** or **Paused** and pick **Every few minutes**, **Hourly**, **Daily** or **Weekly** with a time, then **Save schedule**. **Restore default** puts back the product's schedule. Pausing stops future runs and their catch-up after downtime.
- Pick a run under **Run**, or in **Recent runs**, to read what each stage did.

## States and labels

- **Succeeded**, **Failed**, **Running**, **Skipped** (it ran and had nothing to do), **Paused** (its schedule is off), **No runs** (it has never run) and **Awaiting approval**.
- **Unknown** means NoticeOS cannot confirm the state: the scheduler has not reported recently, or the run history could not be read. It counts as needing your attention, because NoticeOS never treats an unconfirmed state as fine.
- A banner over the list shows why a state is unconfirmed, such as **Live operation is unconfirmed. The scheduler has not reported recently.**, with **Check system health**.
- **Next run** shows **Unconfirmed** when the scheduler has not confirmed the schedule, **No upcoming run** when the workflow is paused, and **Saved change pending** when a schedule you saved has not reached the scheduler yet.
- **No workflows run here yet.** means none is installed; **No workflows match these filters.** means your filters hide them.
- **This run is not in the retained execution history.** means a link pointed to a run old enough to have been dropped from the page's history.

## Notification delivery

**Operator notifications** runs when an error alert opens or a data source changes
to failing. The standalone runner groups events for one second and delivers up
to ten per message. Repeated failed calls during one failure episode do not send
additional notifications; a success followed by a failure starts a new episode.

The workflow shows **On new alerts**, its recovery schedule, and **Event** or
**Recovery** on runs with observed trigger context. **Manage delivery** changes
the recovery schedule or pauses all delivery, including event-triggered sends.
The schedule view shows event-triggered delivery instead of timed execution bars.

Failed sends retry from persisted deadlines, starting after 30 seconds and
backing off to 15 minutes; a provider's retry delay can extend that to an hour.
A recovery check runs at five minutes past each hour by default, and startup and
listener reconnection recover missed events. The sender suppresses conditions
that have resolved, been acknowledged, been replaced, or recovered before sending.
Pending events expire after 24 hours. Only delivered events receive a notification
receipt; events beyond the message limit remain pending.

Delivery is at least once: if Discord accepts a message and the process stops
before its receipt commits, recovery may send it again. The queue and receipts
remain scoped to one workspace. The synthetic hosted demo runs recovery checks
without sending external notifications.

## Related guides

- [Scheduled jobs](/operate/scheduled-jobs), every job with its default time and its catch-up after downtime
- [System health](/tower/health), where the background operations run
- [Attribution and measurement](/concepts/attribution-and-measurement), for what the outcome checks read
- The design in [doc 22, Workflows](../22-workflows-research-and-design.md)
