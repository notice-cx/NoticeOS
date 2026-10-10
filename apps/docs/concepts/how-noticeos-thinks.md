---
title: "How NoticeOS thinks"
description: "The five-step loop NoticeOS runs around your sites, what it refuses to touch on its own, and why an unknown number is never written down as zero."
---

# How NoticeOS thinks

This page gives you the mental model behind every screen, so the rest of the product reads as one idea instead of many features.

## One loop, five steps

NoticeOS is built to improve the return on a set of websites, and to need less of your attention for each kind of change as that kind proves itself. It does this by running one loop, over and over.

Take `example.com`, a recipe site that earns from ads.

1. **Observe.** Every night `example.com` sends NoticeOS a short report of what it could count on its own servers: recipes saved, newsletter sign-ups, comments. NoticeOS also pulls what the outside world knows about the site: Google Analytics, Search Console, Bing, ad revenue. All of it lands in one store, by site and by day.
2. **Attribute.** When something changes on the site, NoticeOS asks whether the numbers moved because of that change, or for some other reason. It only says "yes" when it can show it. Otherwise it says "could not be measured".
3. **Decide.** The things worth doing next are ranked by what they are likely to earn, in money, against what they cost, including your own time.
4. **Act.** A change gets built, checked by someone other than the builder, and shipped. Today you do the shipping. NoticeOS tracks the task, the change and the outcome check that follows.
5. **Learn.** The gap between what a change was expected to earn and what it did earn feeds the next decision. A site whose predictions keep coming true earns more freedom; one whose predictions miss earns more review.

The order matters. A tool that only observes and proposes never finds out whether its proposals worked. The loop closes only when the outcome goes back in.

The full design is in [doc 01, Architecture](https://github.com/notice-cx/NoticeOS/blob/main/docs/01-architecture.md) and the money model in [doc 00, Objective and ROI](https://github.com/notice-cx/NoticeOS/blob/main/docs/00-objective-and-roi.md).

## What you see of the loop

Each step has a home in the Control Tower.

- **Observe** is the **Sites** list, a site's **Overview**, **Growth** and **Search** tabs, and **Alerts**.
- **Attribute** is a site's **Activity** tab, where you log a change and register an outcome check against it.
- **Decide** and **Act** are **Tasks**: one shared board where you, your team and your AI agents see the same work.
- **Learn** is the verdict on each outcome check, posted back to the task that caused the change.
- **Money** is the ledger, the record everything else is measured against.

## The ledger

The ledger is the one place NoticeOS keeps money. It has two kinds of row: revenue and cost, per site, per month. Ad revenue arrives through a connected ad network; other revenue and your costs arrive as uploaded exports.

A row, once written, never changes. If an ad network restates July after the payout clears, NoticeOS writes a new row that replaces the old one and keeps both. What was believed at the time and what turned out to be true both stay visible.

**Money** shows this ledger month by month, as revenue and **Net P&L**. The current month is marked "Month to date" because it is still counting.

Traffic, rankings and sign-ups are not in the ledger. They are inputs that may lead to money. NoticeOS treats them as leads, not results, because the most visited page on `example.com` is not always the one that pays the hosting bill.

## Unknown is never zero

NoticeOS is strict about one thing: when it does not know a number, it says so instead of writing zero.

- A day Google has not finished counting is shown hollow and labelled as still counting. It is not an alert.
- A nightly report that did not arrive raises an error alert. The missing day stays blank; it is not a day with no sign-ups.
- A search query Google did not report for a day is a missing row, not a day with no clicks.
- A change whose effect cannot be told apart from noise is recorded as "could not be measured". It is never recorded as "worked" or "did nothing".

This is why some screens say "unknown" or "could not be measured" where another tool would show a confident figure. The confident figure would be invented, and a system that improves itself by chasing invented figures gets steadily worse while reporting success.

## What NoticeOS never touches on its own

Some parts of a site are off limits to automation, permanently. No amount of good track record promotes them. They are:

- sign-in and accounts
- billing
- security headers
- database migrations
- consent banners and privacy surfaces
- analytics and tracking code
- which pages are held out of experiments
- the thresholds the guardrails use

The last three are the ruler. If the system that is being measured could edit the ruler, it would eventually do so. So the ruler lives where nobody but you reaches it.

Today, in addition, no change to any site ships through NoticeOS without a person merging it. AI agents can read, file tasks and propose; the merge is yours. See [Tasks and agents](/concepts/tasks-and-agents).

## What this means for you

- Expect alerts to be rare and specific. Silence usually means nothing unusual happened, not that nothing is watched. See [Alerts](/concepts/alerts).
- Expect "could not be measured" to be a normal answer, especially on a smaller site. See [Attribution and measurement](/concepts/attribution-and-measurement).
- Expect the number at the top of the page to be money, and the traffic to sit underneath it.
- Expect to be the one who ships. NoticeOS prepares, tracks and checks; it does not merge.

## Related

- [Alerts](/concepts/alerts)
- [Attribution and measurement](/concepts/attribution-and-measurement)
- [Tasks and agents](/concepts/tasks-and-agents)
- [Money](/tower/financials)
