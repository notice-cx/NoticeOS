---
title: "TV dashboard"
description: "The Wall: the at-a-glance view for a television, a laptop or a phone, and what each tile means."
---

# TV dashboard

The **Wall** is the Tower's TV view: one screen at `/wall`, made for a television or a second monitor across the room. The sidebar calls it **TV dashboard**. It shows the same data as the desk, large enough to read from a distance, and refreshes itself every minute, so it can stay on all day with nobody touching it.

The Wall answers, at a glance: where the business is in its loop, what is broken and since when, how each site is doing right now, whether the month is on track, and what the work looks like.

## What you see

The Wall is drawn from a layout you arrange on the desk. It has no navigation and no controls; the one quiet NoticeOS mark in the corner is the way back to the desk. The default layout has six tiles: the strip and the loop across the top, then **Last 24 hours** over **Sites** on the left, beside **Revenue this month** over **Work this week** on the right.

**Top strip.** The time, the next meeting from a connected calendar feed, and a countdown if one is set.

**The loop.** Sense, Attribute, Decide, Act and Learn across the screen, the five steps NoticeOS runs over and over ([How NoticeOS thinks](/concepts/how-noticeos-thinks)), each with its live count: the data sources working out of those you expect (and how many are failing), what is waiting on you, the work in progress, and the outcomes ready to read. A stage nothing measures yet says so (**not measured yet**, **not read**) instead of showing a number.

**Last 24 hours.** Each open problem as a bar on its site's row, from when it started to now, and what happened (shipped, resolved, money, wins) as marks on the same time axis. A problem older than the window is a bar clipped at the left with its age written on it. The heading counts the errors and warnings, or says **Nothing broken**; the TV draws the three worst lines and counts any other problems as **+2 more**. A dashed rule marks **Since last night**. The same problems, at a smaller size, are the issue mark beside a site's name.

**Sites.** One row per site, in the order you set. The columns are **Site**, live people right now, **Today vs Thursday** (today's hours against the same weekday last week, drawn solid against a dashed last week), **4 weeks** as a small trend, and the month's money. Counts are in **people**.

**Revenue this month.** The month's figure, its pace, and the month's line against last month's total. A dashed part of the line is a projection, never a measurement.

**Work this week.** What is waiting on you, what is in progress, done this week and blocked, then one row per project: what got done grows left, what is still open grows right. It shows counts only, never a task's own words.

Two more tiles stay in the library for a Wall that wants them: **Needs you** (the top three problems, each as one sentence with its site) and **Live feed** (what happened since last night, newest on top, from stored events only). Add them at `/wall/edit`.

On a landscape laptop the television's layout is scaled by one number, with small type kept readable. A portrait tablet or a phone stacks the tiles in one column in a fixed order. The television is true black so unused pixels emit no light.

## What you can do

- Open the Wall from the **TV dashboard** entry at the bottom of the sidebar, or at `/wall`.
- Select the NoticeOS mark in the corner to return to the desk.
- Drag the widgets into place, stack and resize them, and set the site order from the desk at `/wall/edit`. See [Arrange the Wall](/guides/arrange-the-wall).

## States and labels

- **Calendar** in the top strip means no meeting is due; **Reconnecting** means the last calendar read failed. **Reconnecting** beside **Last 24 hours** or in the live feed means the last read of what happened failed; the marks on screen are the last good ones.
- **Nothing broken** on **Last 24 hours** means no problem is open. On Needs you, **Nothing needs you** means nothing is open and **Nothing broken** means the only open items are tasks.
- **Tasks unknown** means no task count has been read yet. **3+** is a lower bound: not every project was counted. **stale** means the last task count is old, so a zero is not shown as calm.
- **Today / latest day** replaces **Today vs Thursday** when the site reports by day.
- **Refreshed 3 min ago · reconnecting** means a read failed; the Wall keeps the last good values and says how old they are. It never blanks and never draws zero for a failed poll.
- A **halo** on a point marks now; a slow breathing glow marks a series still being counted. Both stop when your device asks for reduced motion.
- **Hollow points** are days still being counted; plain dots are settled.
- A **ghost line** (dashed, low contrast) is the comparison; a dashed line in the series' own colour is a projection.
- The first and last date sit beside each small chart. There are no legends.
- Colour is meaning: cyan is money, azure is people, red and amber are severity, green is a win. Nothing else is coloured. State is never colour alone; a word or a glyph rides beside every tone.
- A figure the Wall cannot read is named, not dashed: a site with no live read says so in its cell, and a site still setting up has no number rather than a zero.
- **DEV** in the caption means the app is following a checkout in development mode.

## Related guides

- [Arrange the Wall](/guides/arrange-the-wall)
- [Settings](/tower/settings)
- [Home](/tower/home)
- The Wall's design and chart language, in [doc 14, Design](../14-design.md#the-wall)
