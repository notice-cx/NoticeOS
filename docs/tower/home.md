---
title: "Home"
description: "How the business is doing, what is broken and what needs your attention, drawn from your sites' data."
---

# Home

**Home** is the page the Tower opens on: one page that sums up every site, so you can tell in a minute whether anything needs your attention. New to the Tower? Start with [The Tower](/tower/).

Home shows three things, in this order: how the business is doing, what is broken, and what needs your attention.

## What you see

**The summary.** A small grey line shows the greeting, the window since 6 PM yesterday and how many things changed in it. Under it, one sentence sums up the page, such as **October is projected at $1,020, 9% under September. 2 things are broken.**

**Money.** The month so far is the largest number on the screen, marked **est.** while it is an estimate. Beside it, the month's days as bars, with a dashed line across them at the usual day. Under it, a bar shows the month so far, its projected total and last month's total, and **Where October came from** splits the month by site. Two figures are beside it: **Revenue, yesterday** and **Visitors, yesterday**, each with its change against the same day a week before and its recent days as bars. With no revenue source on any site, visitors come first and no money figure is drawn.

**Data sources.** One grid of every site and every data source, with a **System** row for the reports, scheduled runs, backups and data spend that keep NoticeOS running. A working source is a faint green tick; a failing one is solid red with how long it has been failing, and one failing for over a week has only a red outline, so new breakage stands out. Hatching means not connected. The **Backups** cell shows the age of the newest completed backup, such as **last good copy 12d ago**, or **no good copy yet**; it turns amber after one scheduled backup fails and red after two, dated from the first failure. The newest problem is named at the top of the grid.

**Problems.** The open problems the grid does not already show, ranked: what started since you last looked first, then what is still open, and anything open for over a week collapsed into one line. An alert that has a usual range shows the reading against it.

**Decide.** How many decisions are waiting for you, how old the oldest is, and how the waiting decisions split by age. Then the first four, each with its age drawn as a length and its buttons: **Approve** for an approval, **Answer** or **Dismiss** for a question. **Show N more** opens the rest in place; **All tasks →** opens the board.

**Sites.** One row per site, in your order: its status, people a day as a line with the latest day's count, yesterday's revenue with its change, and its share of the month. With one site, Home shows that site's own numbers and chart instead.

**The last 24 hours.** One row per site and one for the System, on a time axis that ends at **Now**. Open problems are bars from when they started; a problem older than the day starts at the left edge with its age written on it. Shipped changes, wins and recoveries are marks on their site's row. The shaded part is the time since 6 PM yesterday.

**Before any site exists**, Home shows three steps: **Add your first site**, **Connect a source** and **See your first number**. The current step is shown as a button, and each finished step is marked done. Home also shows **Use \<zone>**, which saves your device's time zone in one press.

## What you can do

- Open a site from its row in the grid, the sites list or the timeline.
- Open a problem from its row in **Problems**; **All alerts →** opens Alerts.
- **Approve**, **Answer** or **Dismiss** a decision from its row.
- Open Money from **Revenue, yesterday**, and the Sites page from **Visitors, yesterday** or **All sites →**.
- **Integrations →** opens the data sources' connections.
- **Add your first site**, on the first run, opens the **Add a site** dialog.
- **Use \<zone>** saves your device's time zone for every daily figure.

## States and labels

- A site's status is one of **Setting up**, **On track**, **Monitor only**, **At risk** and **Off track**. Only **At risk** and **Off track** are coloured.
- **est.** marks revenue as an estimate until it is reconciled.
- A missing figure is shown as a label, never drawn as zero: **not reported yet**, **no revenue**, **no visitors reported**.
- **Nothing is broken.** means there is no open problem anywhere. Monitoring is still running.
- Home's layout depends on its width: one column on a phone or a narrow window, two on a portrait monitor, the full layout on a wide screen.

## Related guides

- [Install in five minutes](/start/quickstart)
- [Add your first site](/guides/add-your-first-site)
- [Tasks](/tower/tasks) and [Sites](/tower/sites)
- The design in [doc 14, Design](../14-design.md#surfaces-as-built)
