---
title: "Settings"
description: "The portfolio-wide settings: the clock, the budgets, the alert rules, collection schedules, the TV, ownership and task projects."
---

# Settings

Settings answers one question: what does the whole installation run on, and where do I change it.

## What you see

A section list sits on the left and the page opens on **General**. Sites have their own Settings tab; this page is what applies to all of them.

### General

**Time zone.** Every daily figure is read in one zone, including which date is yesterday's revenue and which month is current. Your device's zone leads the list, marked **· this device**. The preview shows **Now**, **Yesterday's revenue** and **Current month** in the chosen zone.

**Monthly data cap** (USD per month · all sites) is the ceiling on metered collection. A meter shows **Spent in October** against it, and **Stops at the budget** says what happens at the top. It counts scheduled DataForSEO collection and one-off research on the same account. The product ships with $25.

**Value of your time** (USD per minute · prices review time in ROI), shown **Per hour** beside it, prices your review time when work is ranked by return.

### Alert rules

The three thresholds every site is judged by, marked **All sites**: **Anomaly sensitivity** (lower means fewer, surer alerts), **Minimum daily volume to test** (quieter metrics are tested over several days) and **Low-volume window** (hours pooled together for quieter metrics). A replay over the fields shows what each value would have fired on your own data. Under them, a record shows how often each rule has been tuned.

### Data collection

The schedules of the collections no connection feeds, one row each, such as **Nightly reports** and **Live traffic and counters**. A collection fed by a connection is scheduled on its **Manage** panel on **Integrations**.

Under the schedules sit the search panels' history window (**Each pass asks for**, **Cost per pass**) and freshness bar. **Nightly report pulls** lists each site whose report the product fetches.

### TV dashboard

**TV layout** with **Edit layout**, which opens the Wall editor. Under it, the countdown the top strip can show, with **Set a countdown** or its three fields.

### Ownership

**Legal entities**: one row per entity that owns sites (slug, name, form, jurisdiction), edited in place. **Sites by owner** lists what each entity owns. A site's owner is changed on its own Settings tab, in **Identity**.

### Task projects

The map from a site to the project its tasks live in: the **Task database** status, the **Projects** table (**Site**, **Prefix**, **Database**, and a **Found** column that marks a database that does not exist), the checklist an **Add** opens, and the **Task database server** line.

### Members

Shown only when this installation manages members: where people are invited to the workspace.

## What you can do

- **Time zone**: picking a zone saves it, with **Saved · Undo** beside the field.
- **Monthly data cap** and **Value of your time** keep an explicit **Save**; they never autosave.
- **Alert rules**: change the three thresholds after reading the replay.
- **Data collection**: each row is one pick (**Paused**, **Every few minutes**, **Hourly**, **Daily**, **Weekly**, then a time) saved with **Undo** beside it.
- **Edit layout** opens the Wall editor; **Set a countdown** adds the top strip's countdown.
- **Legal entities**: add, edit or remove an entity. Removing one moves its sites to the unowned line and deletes nothing else.
- **Task projects**: **Add** maps a site to a prefix and a database and opens the checklist.

## States and labels

- An unresolvable zone reads **Unknown zone · UTC used**.
- **not read yet** means the spend has not been read this session.
- Before any reports exist the alert-rules replay reads **No reports to replay yet**.
- The freshness bar reads **Fits the window** or **Outside the window**.
- **Nightly report pulls** shows each site as **Enabled** or **Paused**, or **None · sites send their own**.
- **No countdown set.** means the top strip shows none; **Saved countdown refused** names why a saved countdown cannot be drawn.
- Unclaimed sites are marked **No owner**.
- **Found** reads **Unknown** when no project could be read, rather than claiming every row is fine. On a hosted view the Task projects section reads **Read-only here**.
- When saves are paused the page says so once at the top and every field shows its lock.

## Related guides

- [Arrange the Wall](/guides/arrange-the-wall)
- [Connect a task project](/guides/connect-a-task-project)
- [Budgets and the kill switch](/operate/budgets-and-the-kill-switch)
- Which settings live in the product and which in files, on GitHub: https://github.com/notice-cx/NoticeOS/blob/main/docs/23-configuration-ownership.md
