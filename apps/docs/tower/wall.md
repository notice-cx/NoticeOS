---
title: "TV dashboard"
description: "The Wall: the at-a-glance view for a television, a laptop or a phone, and what each tile means."
---

# TV dashboard

The Wall answers four questions in the order the eye takes them: is anything on fire, are we on track this month, which site needs me and how is each doing right now, and what happened since last night.

## What you see

The Wall is drawn from a layout you arrange on the desk. It has no navigation and no controls; the one quiet NoticeOS mark in the corner is the way back to the desk. The default layout has five tiles:

**Top strip.** The time, the next meeting from a connected calendar feed, and a countdown if one is set.

**Revenue this month.** The month's figure, its pace, and the month's line against last month's total. A dashed part of the line is a projection, never a measurement.

**Needs you.** Each problem as one sentence with its site. The same list, at a smaller size, is the issue mark beside a site's name.

**Sites.** One row per site, in the order you set. The columns are **Site**, live people right now, **Today vs Thursday** (today's hours against the same weekday last week, drawn solid against a dashed last week), **4 weeks** as a small trend, and the month's money. Counts are in **people**.

**Live feed.** What happened, newest on top, **since last night**, from stored events only: alerts, shipped changes, runs and reports. It never invents activity.

On a landscape laptop the television's layout is scaled by one number, with small type kept readable. A portrait tablet or a phone stacks the tiles in one column in a fixed order. The television is true black so unused pixels emit no light.

## What you can do

- Open the Wall from the **TV dashboard** entry at the bottom of the sidebar, or at `/wall`.
- Select the NoticeOS mark in the corner to return to the desk.
- Arrange the tiles, rows and site order from the desk at `/wall/edit`. See [Arrange the Wall](/guides/arrange-the-wall).

## States and labels

- **Calendar** in the top strip means no meeting is due; **Reconnecting** means the last calendar read failed. **Reconnecting** in the live feed means the last read failed.
- **Nothing needs you** means nothing is open; **Nothing broken** means the only problems are not urgent.
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
- The Wall's design and chart language, on GitHub: https://github.com/notice-cx/NoticeOS/blob/main/docs/14-design.md#the-wall
