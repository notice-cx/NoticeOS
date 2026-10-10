---
title: "Alerts"
description: "What fired, how serious it is, what kind of thing it is, and what you did about it."
---

# Alerts

Alerts answers one question: what needs attention right now, and how badly.

## What you see

The page opens with its answer and a severity dot: **2 open alerts, both warnings**, or **All clear.** Two tabs follow: **Open** and **History**. Open is the queue; History is everything settled.

**Filters** sit over the list: a site, a severity (**Any severity**, **Errors**, **Warnings**; History adds **Info**) and a kind (**Any kind**, **Anomalies**, **Opportunities**).

Each row says what happened and which way is good, in the verb, with the site, the age and a dot for severity. The statistics sit behind the evidence glyph. The list ends with **That's every open alert.** and how old the reading is. Under it, a **Snoozed** panel lists alerts you parked, each with when it comes back.

Every alert carries two separate facts. **Severity** is how urgent: **error**, **warn** or **info**; only these three wear the attention colours. **Kind** is what sort of thing it is: an **anomaly** (something moved when it should not have), an **opportunity** (something worth acting on) or a **milestone** (a win). A milestone is always info-severity, so it never appears in the Open queue; it shows on Home and in History. A green card is a win, not a verdict that all is well.

## What you can do

Actions sit on the row they act on:

- **Snooze** parks the alert until a date (**Snooze until date**). It comes back on its own.
- **Unsnooze**, in the Snoozed panel, brings a parked alert back early.
- **Resolve** closes it.
- **Mark read**, after opening the row for the evidence, acknowledges it without closing it.
- **Tune** adjusts the rule that fired it. Tuning opens the same three settings as **Settings** > **Alert rules** (**Anomaly sensitivity**, **Minimum daily volume to test** and **Low-volume window**), with a replay of what the new value would have fired.
- The filters narrow the list by site, severity and kind.

A metric is tested against the mean of its four matching prior weekdays, so a Saturday is compared with Saturdays. It fires only when the day's count is improbable against that baseline and the baseline is at least three a day. Quieter metrics are tested over a pooled window. A new metric stays silent until four matching weekdays exist, which takes at least 28 days. An alert that persists stays one alert; a new reading resolves the previous open alert for that metric before judging the new day.

## States and labels

- **All clear.** means no open alert.
- In History, a row's caption is its disposition: **Acknowledged**, **Snoozed**, or **Verdict recorded**. A settled alert with no recorded decision says **no decision recorded**.
- A row whose evidence could not be read says so in place.
- A comparison the data cannot support reads **not comparable** rather than showing a percentage without its colour.

## Related guides

- [Alerts](/concepts/alerts), the concept
- [Send your own report](/guides/send-your-own-report)
- [Settings](/tower/settings)
- Flags, severity and kind on GitHub: https://github.com/notice-cx/NoticeOS/blob/main/docs/02-signal-contract.md
