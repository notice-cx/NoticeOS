---
title: "Budgets and the kill switch"
description: "The one spending cap NoticeOS enforces today, the alert thresholds to tune, and how to stop things when you need to."
---

# Budgets and the kill switch

This page lists what NoticeOS caps, what it only reports, and what you stop by hand.

## What is enforced today

NoticeOS enforces **one hard cap**: the monthly metered data spend.

- The setting is **Monthly data cap**, under **Settings** > **General** > **Budget**. The product default is **$25** a month.
- Before every paid DataForSEO read, the amount is reserved against the cap. If the reservation would cross the cap, the read does not happen and the job records that it paused. The cap fails closed: an unreadable cap means no spend.
- The Budget section shows a meter of this month's metered spend against the cap, and what happens when it is reached.

Nothing else in NoticeOS spends money on your behalf. There is no model gateway and no inference cap, because no part of the product calls a language model. If you run an agent that does, its bill is outside NoticeOS.

## Other budget settings

Under **Settings** > **General** > **Budget** you also set the **operator rate**: what a minute of your time costs the ledger, in dollars per minute. The default is $2. It prices your own effort in the same currency as revenue and costs, so a change's full cost can be compared with its value.

Under **Settings** > **Alert rules** you tune when an anomaly is worth an alert:

| Setting | Default | What it means |
| --- | --- | --- |
| Anomaly sensitivity | 0.01 | How unlikely a reading must be, against its recent average, before it is flagged |
| Longest window | 14 days | The most days a quiet series is pooled over. Each series is tested over the fewest whole days in which a run of zeros could raise an alert, so low-volume assets do not raise false alarms; a series too quiet for this many days is not tested |

Alerts are not enforcement. They notify you; they stop nothing.

## Spending on demand

Two actions spend money outside the schedule, and both show the cost first:

- **Start collecting** on a connection's panel runs a provider's first collection now. A metered step shows its price before you confirm.
- In the terminal, `pnpm os:collect -- --asset example.com` (`noticeos collect --asset example.com` when NoticeOS runs from Docker alone) collects one asset now and prints what it cost. `--families` narrows it to the report families named. It goes through the same cap.

## The kill switch

NoticeOS does not have an automated kill switch yet: one rehearsed action that stops every cron, revokes repository access and freezes provider keys. NoticeOS does not execute changes on your assets in this release, so there is nothing of its own to stop. Any agent that acts on your assets is one you started, and you stop it where you started it.

The collection schedule controls are not an agent pause. Pausing a job stops data collection; it does not stop anything outside NoticeOS.

::: warning Do not mistake a schedule for a safety control
An external agent that misbehaves is stopped where it was started, before anyone looks at NoticeOS. The order matters.
:::

## What to stop, and where

| To stop | Do this |
| --- | --- |
| One job | **System health** > **Background operations** > the job > **Edit schedule** > **Paused** |
| One provider's spend | **Integrations** > the connection > **Disconnect**; or pause its job |
| All metered spend | Set the Monthly data cap to the amount already spent this month |
| The whole installation | `pnpm os:stop` |

Stopping the installation stops collection and notifications; it does not touch your assets or any external service.

## What NoticeOS will never do by itself

Some settings are permanently yours alone: authentication, billing, security headers, database migrations, consent surfaces, analytics pipelines, holdout assignments and the three alert thresholds. No automation inside NoticeOS changes them, and none can ever be made eligible for automation.

Related: [Scheduled jobs](/operate/scheduled-jobs), [Settings](/tower/settings), [Tasks and agents](/concepts/tasks-and-agents). The full design, including the gateway, loop detectors and velocity breaker for the day NoticeOS makes its first model call, is in [doc 06, Operations & self-observability](../06-operations.md#budget-enforcement-hard-caps-alerts-are-not-enforcement).
