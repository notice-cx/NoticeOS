---
title: "Money"
description: "The month's net, where revenue and cost come from, and the costs you declare."
---

# Money

Money answers one question: is this month earning, and where does the money come from and go. The sidebar calls it **Money**; its address is `/financials`.

## What you see

The page opens with its answer, **October net +$135 so far**, and three figures: **Revenue**, **Cost** and **Confirmed**. **Confirmed** is the part backed by a reconciled payment or receipt; the rest is estimated. A **Month to date** chip marks an open month. **Accounting period** picks another month.

Under the answer, the panels open one at a time:

- **Daily revenue** — the day line for the shown month, with partial days marked.
- **Month by month** — **Revenue**, **Cost**, **Net**, **Reconciled** and **Net to date** for every month, over a chart of revenue, cost and net.
- **Where the cost comes from** — each cost line with its **Type**, **Source** and **Amount**.
- **By site** — one row per site: **Revenue**, **Direct cost**, **Net**, with a small month-by-month net chart and the site's share of revenue. Overhead carried by the NoticeOS site is its own row, and the portfolio net is the sites' nets less that overhead.
- **Declared costs** — **Recurring costs** and **Domain orders**, the two tables you edit. Over them, **Declared, by site** shows each site's declared run rate per month.

Revenue is collected (Mediavine, daily) and stays an estimate until reconciled. Costs are the rows you declare plus metered spend the product records itself, such as DataForSEO reports. A booked month is never rewritten; a correction is a new row.

## What you can do

- **Accounting period** changes the month shown.
- **Add** and **Remove** act on whole rows in **Recurring costs** and **Domain orders**; every cell saves on its own with **Undo** beside it.
- **Connect a revenue source →**, before any money is recorded, opens Integrations.
- Each cost line names whether it was declared, imported or collected, so a figure's provenance is one read away.

## States and labels

- **Month to date** marks an open month.
- **Nothing recorded for** a month the ledger does not hold, with the months it has listed.
- **No money recorded yet** before any money is recorded.
- **Cost — none recorded** means no cost line exists for the month; it is not a zero cost.
- **Reconciled —** means nothing in that month has been matched to a receipt yet.
- A **No trend** dash on a site row names why the month-by-month chart cannot be drawn, usually because the months mix currencies or one month has no figure.
- A declared cost that has not been booked into the month yet shows in **Declared, by site** but not in **Direct cost**; the two differ until the month's cost import runs.

## Related guides

- [Record revenue and costs](/guides/record-revenue-and-costs)
- [Connect data sources](/guides/connect-data-sources)
- [How NoticeOS thinks](/concepts/how-noticeos-thinks)
- The ledger's rules in [doc 02, Signal contract](../02-signal-contract.md#revenue--cost-the-ledger-feeds--required); recurring costs and domain orders: https://github.com/notice-cx/NoticeOS/blob/main/config/recurring-costs.README.md, https://github.com/notice-cx/NoticeOS/blob/main/config/domain-costs.README.md
