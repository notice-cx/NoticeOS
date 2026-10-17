---
title: "TV dashboard"
description: "The Wall: the summary view for a television, a laptop or a phone, and what each tile means."
---

# TV dashboard

The **Wall** is the Tower's TV view: one screen at `/wall`, made for a television or a second monitor across the room. The sidebar calls it **TV dashboard**. It shows the same data as the Tower's pages, large enough to read from a distance, and updates when that data changes, so it can stay on all day with nobody touching it.

The Wall shows: the live count at each step of the loop, what is broken and since when, how each site is doing right now, whether the month is on track, and the state of the work.

![The Wall on a TV, from the synthetic demo: the strip with the time and the next meeting, the loop's five steps with their counts, the last 24 hours of problems, one row per site, October's revenue and the live feed.](../images/wall-tv.webp)

## What you see

The Wall is drawn from a layout you arrange in the Tower. It has no navigation and no controls; the small grey NoticeOS mark in the corner links back to Home. The default layout has six tiles: the strip and the loop across the top, then **Last 24 hours** over **Sites** on the left, beside **Revenue this month** over **Work this week** on the right.

**Top strip.** The time, the next meeting from a connected calendar feed, and a countdown if one is set.

**The loop.** Sense, Attribute, Decide, Act and Learn across the screen, the five steps NoticeOS runs over and over ([How NoticeOS works](/concepts/how-noticeos-thinks)), each with its live count: the data sources working out of those you expect (and how many are failing), the decisions waiting for you, the work in progress, and the outcomes ready to read. A stage with no measurement yet shows **not measured yet** or **not read** instead of a number.

**Last 24 hours.** Each open problem as a bar on its site's row, from when it started to now, and what happened (shipped, resolved, money, wins) as marks on the same time axis. A problem older than the window is a bar clipped at the left with its age written on it. Backups that failed on two scheduled runs since the last good copy are one problem on the System row, **Backups failing · last good copy 12d ago** (or **no good copy yet**), which ends when a backup completes. The heading counts the errors and warnings, or shows **Nothing broken**; on a TV the tile draws the three worst lines and counts any other problems as **+2 more**. A dashed rule marks **Since last night**. The same problems, at a smaller size, are the issue mark beside a site's name.

**Sites.** One row per site, in the order you set. The columns are **Site**, live people right now, **Today vs Thursday** (today's hours against the same weekday last week, drawn solid against a dashed last week), **4 weeks** as a small trend, and the month's money. Counts are in **people**.

**Revenue this month.** The month's figure, its pace, and the month's line against last month's total. A dashed part of the line is a projection, never a measurement.

**Work this week.** What is waiting for you, what is in progress, done this week and blocked, then one row per project: what got done extends left, what is still open extends right. It shows counts only, never a task's text.

Three more tiles are available in the tile library: **Needs attention** (the top three problems, each as one sentence with its site), **Live feed** (what happened since last night, newest on top, from stored events only; a line names its site with the site's favicon; a line for a task an agent filed, claimed or closed shows the agent's logo, its name and its model, and a close shows its commit and links; a close is labelled **Task done**, or, when nothing shipped, with its resolution: **Won't do**, **Duplicate**, **Can't reproduce** or **Already handled**, in grey with a slashed circle; a **Chosen** line shows the person who picked one of a task's choices, the option and the task, as "Dana chose (b) Keep both on Pick the page") and **Agents** (each agent and the model it named, ranked by tasks closed as **Done** in the last 7 days, with how many tasks the agents hold now). Add them at `/wall/edit`.

![Rows of the live feed from the synthetic demo: codex and claude claim and close tasks, each line with the agent's logo and a claimed or closed badge, the site's icon and name, the model, and a close's commit and link.](../images/wall-feed.webp)

On a landscape laptop the television's layout is scaled by one factor, with small type kept readable. On a portrait tablet or a phone the tiles are stacked in one column in a fixed order. On a television the background is true black, so unused pixels emit no light.

## What you can do

- Open the Wall from the **TV dashboard** entry at the bottom of the sidebar, or at `/wall`.
- Select the NoticeOS mark in the corner to return to Home.
- Drag the widgets into place, stack and resize them, and set the site order in the Tower at `/wall/edit`. See [Arrange the Wall](/guides/arrange-the-wall).

## States and labels

- **Calendar** in the top strip means no meeting is due; **Reconnecting** means the last calendar read failed. **Reconnecting** beside **Last 24 hours** or in the live feed means the last read of what happened failed; the marks on screen are the last good ones.
- **Nothing broken** on **Last 24 hours** means no problem is open. On Needs attention, **Nothing needs attention** means nothing is open and **Nothing broken** means the only open items are tasks.
- **Tasks unknown** means no task count has been read yet. **3+** is a lower bound: not every project was counted. **stale** means the last task count is old, so a count of zero is shown as **stale** instead of 0.
- **Today / latest day** replaces **Today vs Thursday** when the site reports by day.
- **Refreshed 3 min ago · reconnecting** means a read failed; the Wall keeps the last good values and shows how old they are. It never clears the screen and never draws zero for a failed read.
- A **halo** on a point marks the current moment; a ring that slowly grows and fades, again and again, marks a series still being counted. Both stop when your device is set to reduce motion.
- **Hollow points** are days still being counted; plain dots are settled.
- A **dashed, low-contrast line** is the comparison; a dashed line in the series' own colour is a projection.
- The first and last date are shown beside each small chart. There are no legends.
- Each colour has one meaning: cyan is money, azure is people, red and amber are severity, green is a win. Nothing else is coloured. State is never shown by colour alone; every colour has a word or a symbol beside it.
- A figure the Wall cannot read is shown as a label, not a dash: a site with no live read shows a label in its cell, and a site still setting up shows no number instead of a zero.
- **DEV** in the caption means the app runs from a checkout in development mode.

## Related guides

- [Arrange the Wall](/guides/arrange-the-wall)
- [Settings](/tower/settings)
- [Home](/tower/home)
- The Wall's design and chart language, in [doc 14, Design](../14-design.md#the-wall)
