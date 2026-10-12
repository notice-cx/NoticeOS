---
title: "Alerts"
description: "What fired, how serious it is, what kind of thing it is, and what you did about it."
---

# Alerts

An **alert** is NoticeOS saying that a number on a site, or in NoticeOS's own collection, is unlikely to be normal, with the evidence attached. The **Alerts** page is where every open alert waits until it is fixed, snoozed or read. Why one fires is in [Alerts](/concepts/alerts).

Alerts answers one question: what needs attention right now, and how badly.

## What you see

The page opens with its answer and a severity dot: **2 open alerts, both warnings**, or **All clear.** Beside it, **Oldest** says how long the oldest open alert has been open and **Settled this week** counts what was resolved or acknowledged in the last seven days.

Under the answer, **Last 7 days** draws the same answer on a time axis that ends at **Now**: one row per site, every open alert a bar from when it was first seen to now, and what settled this week a quiet closed bar with a tick. A bar that started more than a week ago is cut at the left edge with its age on it (**since 37d**). The newest open error glows. Press an open bar to jump to its row below, opened; press a closed bar to see that site's settled alerts. Like the answer, the week is the whole portfolio's: the filters narrow the list, not the picture.

Two tabs follow: **Open** and **History**. Open is the queue; History is everything settled.

**Filters** sit over the list: a site, a severity (**Any severity**, **Errors**, **Warnings**; History adds **Info**) and a kind (**Any kind**, **Anomalies**, **Opportunities**). When a filter narrows the list, the list says how many of the open alerts it shows (**3 of 10 open**).

The Open list is one board, grouped by site, the site with the worst and newest alert first; each site's heading names it and counts its errors and warnings. Each row says what happened and which way is good, in the verb, with a shape for severity (a circle for an error, a triangle for a warning) and how long ago it was first seen. Where the rule that fired keeps a normal range, the row draws the reading against it: the usual range as a shaded band, the reading as a dot, **Below normal** or **Above normal** in words, and the figures under it (**19 in 24h**, **usual 41–77**). A metric's usual range is the counts its own rule would not have fired on; a late nightly report reads against the hours the rule allows; a GA4 quota against the share it fires below. A rule that keeps no range (a failed fetch, a sitemap check) draws none. The statistics sit behind **Evidence** in the opened row, and a condition read on several nights draws those nights as bars against its usual level.

Alerts open for over a week fold under **Open for over a week**, one line naming each and its site, so an old fault never sits as loud as a fresh one. When they are all that is open, they are listed under that heading, not folded.

The list ends with **That's every open alert.** and how old the reading is. Under it, a **Snoozed** panel lists alerts you parked, each with when it comes back.

History lists settled alerts, newest first, each with its site, what was decided (**Acknowledged**, **resolved 2d ago**) and how long it stayed open, 25 to a page with **Newer** and **Older**.

Every alert carries two separate facts. **Severity** is how urgent: **error**, **warn** or **info**; only these three wear the attention colours. **Kind** is what sort of thing it is: an **anomaly** (something moved when it should not have), an **opportunity** (something worth acting on) or a **milestone** (a win). A milestone is always info-severity, so it never appears in the Open queue; it shows on Home and in History. A green card is a win, not a verdict that all is well.

## What you can do

Actions sit on the row they act on. On a desk with a mouse, **Snooze** and **Resolve** appear at the end of a row when you point at it or move to it with the keyboard; on a phone or a touch screen they sit under each row.

- **Snooze** parks the alert for a few days or until a date (**Snooze until date**). It comes back on its own.
- **Unsnooze**, in the Snoozed panel, brings a parked alert back early.
- **Resolve** closes it.
- **Mark read**, after opening the row for the evidence, acknowledges it without closing it.
- **Tune** adjusts the rule that fired it. Tuning opens the same three settings as **Settings** > **Alert rules** (**Anomaly sensitivity**, **Minimum daily volume to test** and **Low-volume window**), with a replay of what the new value would have fired.
- **File task**, in the opened row, files a task about the condition; the alert stays open until the condition clears.
- **Open** the site, from the opened row or from the site's heading.
- The filters narrow the list by site, severity and kind.

A metric is tested against the mean of its four matching prior weekdays, so a Saturday is compared with Saturdays. It fires only when the day's count is improbable against that baseline and the baseline is at least three a day. Quieter metrics are tested over a pooled window. A new metric stays silent until four matching weekdays exist, which takes at least 28 days. An alert that persists stays one alert; a new reading resolves the previous open alert for that metric before judging the new day.

## States and labels

- **All clear.** means no open alert.
- **Confirmed 3h ago** means the alert's source checked it recently; **Last known** means nothing has re-checked it since, and it stays open until something does.
- In History, a row's caption is its disposition: **Acknowledged**, **Snoozed**, or **Verdict recorded**. A settled alert with no recorded decision says **no decision recorded**.
- A row whose evidence could not be read says so in place.
- A comparison the data cannot support reads **not comparable** rather than showing a percentage without its colour.

## Related guides

- [Alerts](/concepts/alerts), the concept
- [Send your own report](/guides/send-your-own-report)
- [Settings](/tower/settings)
- Flags, severity and kind in [doc 02, Signal contract](../02-signal-contract.md)
