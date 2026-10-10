---
title: "Budgets and the kill switch"
description: "The one spending cap NoticeOS enforces today, the alert thresholds to tune, and how to stop things when you need to."
---

# Budgets and the kill switch

This page gets you an honest picture of what NoticeOS caps, what it only reports, and what you stop by hand.

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
| Minimum daily volume to test | 3 | A series under this average is not tested at all, so quiet sites do not cry wolf |
| Low-volume window | 72 hours | How much history a low-volume test needs before it will speak |

Alerts are not enforcement. They tell you; they stop nothing.

## Spending on demand

Two actions spend money outside the schedule, and both say so first:

- **Start collecting** on a connection's panel runs a provider's first collection now. A metered step shows its price before you confirm.
- In the terminal, `pnpm signals:collect -- --asset example.com` collects one site now and prints what it cost. It goes through the same cap.

## The kill switch

NoticeOS does not have an automated kill switch yet: one rehearsed action that stops every cron, revokes repository access and freezes provider keys. NoticeOS does not execute changes on your sites in this release, so there is nothing of its own to kill. Any agent that acts on your sites is one you started, and you stop it where you started it.

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
| The whole installation | `pnpm os:stop` for the macOS service, `pnpm stack:stop` for a Compose stack, Ctrl-C for a `pnpm start` terminal |

Stopping the installation stops collection and notifications; it does not touch your sites or any external service.

## What NoticeOS will never do by itself

Some settings are yours alone, for good: authentication, billing, security headers, database migrations, consent surfaces, analytics pipelines, holdout assignments and the three alert thresholds. No automation inside NoticeOS changes them, and none can be promoted to.

Related: [Scheduled jobs](/operate/scheduled-jobs), [Settings](/tower/settings), [Tasks and agents](/concepts/tasks-and-agents). The full design, including the gateway, loop detectors and velocity breaker for the day NoticeOS makes its first model call, is on GitHub: https://github.com/notice-cx/NoticeOS/blob/main/docs/06-operations.md#budget-enforcement-hard-caps-alerts-are-not-enforcement.
