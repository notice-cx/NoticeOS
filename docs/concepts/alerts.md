---
title: "Alerts"
description: "What an alert is, why NoticeOS raises so few, and what each button on an alert does."
---

# Alerts

This page tells you what an alert on the **Alerts** page means, when one fires, and what happens when you mark it read, snooze, resolve or tune it.

## What an alert is

An alert is NoticeOS saying: this number on this site is unlikely to be normal, and here is the evidence. Every alert names the site, the metric, what happened, and the rule and inputs that produced it. The evidence on any alert opens to the actual numbers.

On `example.com`, an alert might read: "Recipes saved: 0 in the last 24 hours (average 6.2 a day)". The evidence shows the week it was compared against and how unlikely a zero day was.

Alerts come from the nightly reports a site sends about itself, from the data sources NoticeOS collects centrally, and from NoticeOS watching its own collection. A nightly report that stops arriving is itself an alert.

## Severity and kind

Every alert carries two separate labels.

**Severity** says how urgent it is.

- **Error**: something is broken or missing. `example.com` has stopped sending its nightly report.
- **Warning**: a number moved in a way that is unlikely to be chance. Recipes saved dropped to zero against a baseline of six a day.
- **Info**: worth knowing, nothing to do. An outcome check closed with no clear change.

**Kind** says what sort of news it is.

- **Anomaly**: a number went somewhere it should not have. Most alerts are anomalies.
- **Opportunity**: good news that may deserve action. An outcome check that confirmed an improvement raises one.
- **Milestone**: a line crossed. A milestone is always info severity, so it is never urgent.

The two labels are kept separate so each one filters on its own. The **Open** list shows warnings and errors; the **History** tab holds everything, including info alerts.

## When an alert fires

NoticeOS does not use fixed thresholds like "warn when sign-ups drop 50%". On a small site a 50% drop happens on a quiet Tuesday. A stream of false alarms teaches you to ignore the page, which is worse than no page.

Instead, a count-type metric fires only when **both** of these are true:

1. **Today's count is unlikely given the recent past.** NoticeOS takes the recent daily average and asks how probable a day this low would be if nothing had changed. If that probability is under the sensitivity setting (1 in 100 by default), the day is unusual.
2. **There is enough volume to judge.** A metric that averages fewer than three a day is too quiet for a one-day test. For those, NoticeOS pools three days together and asks the same question about the pooled total. If there is not enough history to compare against yet, it stays quiet rather than guess.

So on `example.com`, recipes saved at 6.2 a day falling to 0 fires: a zero day there has a probability of about 1 in 500. Newsletter sign-ups at 1.5 a day falling to 0 does not fire on one day; it would need three days of nothing.

A day that a data source has not finished counting is never tested. Zero rows from a source that has not reported yet are not zeros.

The rule and its three settings are described for people in [doc 02, The signal contract](../02-signal-contract.md).

## The four actions on an alert

Each open alert has four actions. None of them deletes anything; the evidence stays.

- **Mark read**: "I have seen this". The alert leaves the open list. If the same condition fires again later, you get a new alert.
- **Snooze**: "not now". Pick a date within the next 90 days. The alert leaves the open list and sits under **Snoozed**, and the same alert, with the same evidence, comes back on that date. **Unsnooze** brings it back early.
- **Resolve**: "the underlying issue is fixed". The alert is finished.
- **Tune**: "this rule is too loud". Tune opens the three settings behind the rule, shows what each value would have fired on real past days, and saves your change. A tuned alert stays open, because tuning changed the rule, not the condition.

Beside the actions there is **File task**, which creates a task on the site's project with the alert attached, so the work and the alert stay linked. See [Tasks and agents](/concepts/tasks-and-agents).

Some conditions recur every day while they last, for example a nightly report that keeps failing. These show as one row, and acting on the row acts on the whole condition rather than one night of it.

## What "settled" means

An alert is **settled** when nothing will bring it back: you resolved it, or you marked it read. The Alerts page shows a count of alerts settled in the last seven days.

A snoozed alert is not settled. Nobody has decided anything about it yet; it is parked with a return date. A tuned alert is not settled either, because it is still open.

Settled alerts live in **History** with the decision you made and when.

## Recovery

When a number recovers on its own, the alert for it closes and the site stops showing the old warning. A decision you made is never reopened by the system. If the condition returns, that is a new alert.

## Three settings, on purpose

The whole rule is three numbers, visible under **Settings** and inside **Tune**:

- **Anomaly sensitivity**: lower means fewer, surer alerts.
- **Minimum daily volume to test**: under this, a metric is tested over several days.
- **Low-volume window**: how many hours are pooled for those quieter metrics.

There are no per-metric thresholds to maintain. If the page is too noisy, tune these three and look at the replay before you save.

## Related

- [Alerts](/tower/alerts), the screen
- [How NoticeOS thinks](/concepts/how-noticeos-thinks)
- [Send your own report](/guides/send-your-own-report)
- [Settings](/tower/settings)
