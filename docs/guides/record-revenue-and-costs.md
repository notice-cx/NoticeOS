---
title: "Record revenue and costs"
description: "Where revenue is collected automatically, and how to declare the subscriptions and domain orders that no connected service reports."
---

# Record revenue and costs

This page shows how to make your money figures complete: revenue that is collected automatically, and costs you declare once so that they are booked every month.

NoticeOS keeps money in one **ledger**: revenue and cost rows per site, per month, which the **Money** page and each site's **Money** tab show. Revenue from a connected ad network is collected automatically. You declare costs that no service reports, such as a hosting plan or a domain order, here.

## Before you begin

- For ad revenue, Mediavine connected. See [Connect data sources](/guides/connect-data-sources).
- For a recurring cost, what the statement calls it, its monthly amount in USD and its first month.
- For a domain order, the registrar's receipt.

### Where revenue comes from

Ad revenue from Mediavine is collected automatically once Mediavine is connected. The sync runs daily at 6:10 a.m. Pacific and requests the previous day by its date. Missing days are retried, never recorded as zero. Figures are estimates until a payment is reconciled, and the site's **Data sources** tab shows **Reported through** with an **Estimates** chip.

Revenue from other networks has no connector yet. NoticeOS's data receiver has an import route for revenue rows, but it requires the installation's operator token, so only whoever runs the installation can use it.

### Where the tables are

Open **Money** in the sidebar. It starts with a one-line summary of the month, such as **October net +$135 so far**, and three figures: **Revenue**, **Cost** and **Confirmed**. A **Month to date** chip marks an open month. Use **Accounting period** to pick another month.

Under the summary, each panel opens when you select it: **Daily revenue**, **Month by month**, **Where the cost comes from**, **By site**, and **Declared costs**, which holds the two tables you edit. A site's own **Money** tab shows the same for one site. See [Money](/tower/financials).

### Currencies

Declared costs are entered in USD. Collected revenue is recorded in the currency the provider reported. NoticeOS does no exchange-rate conversion: figures in one currency are added, and a month with more than one currency shows each figure with its own currency code. The month-by-month trend is then left empty, because amounts in different currencies cannot be added.

## Add a recurring cost

A recurring cost is a fixed monthly subscription that no service reports to NoticeOS, such as hosting or a tool. Each row is booked for every month from its start month to its end month.

1. Open **Money** and open **Declared costs**.
2. In **Recurring costs**, select **Add**.
3. Fill in **Id** (lowercase with dashes, such as `claude-code`), **Label** (what the statement calls it), **Site** (the site the cost belongs to, or the System for anything shared), **Family** (`inference`, `api`, `infra`, `operator` or `os-overhead`), **USD / month**, **From** (the first month, as `YYYY-MM`) and, if it has ended, **To**. **Note** is optional and is copied onto each month.
4. Save the row. It saves with **Undo** beside it, and the month totals recompute.

Assign a subscription used by one site to that site. Assign shared tools and hosting to the System, so each site's margin includes only its own costs and shared overhead is not split between sites by estimate.

## Add a domain order

A domain order is a registration, renewal or transfer, recorded from the registrar's receipt. Each order is spread evenly over twelve months from its purchase month and is booked as an infrastructure cost on its site.

1. In **Declared costs**, go to **Domain orders** and select **Add**.
2. Fill in **Domain** (a name, not a URL), **Site**, **Order** (`registration`, `renewal` or `transfer`), **Paid (USD)** as charged, and **Paid on** (the receipt date).
3. Save the row.

Add renewals as new orders from their receipts; a registration price is not a renewal price.

## Change an amount

The monthly amount of a recurring cost cannot be changed once saved, because every month already booked used that amount. To change a price:

1. On the existing row, set **To** to its last month.
2. Select **Add** and enter a new row with a new **Id**, the new amount, and **From** set to the first month at the new price.

Other cells (label, site, note, dates) save in place. **Remove** deletes a row with **Undo**.

::: warning
Do not edit a past month's figure to "fix" history. A booked month is never changed: NoticeOS rejects a new booking of that month with a different figure as a conflicting replay.
:::

## Verify

- The row saves with **Undo** beside it and the month totals recompute.
- In **Domain orders**, the **Per month** column shows the amount booked each month for each order and the months it spans, and a **Renews** chip appears when a term is about to end. The table's header shows the number of orders, the cash paid, and how many orders are still being spread over the month shown.
- Under **Declared costs**, **Declared, by site** shows each site's declared run rate per month.

## If it didn't work

- NoticeOS rejects the row as a conflicting replay: a booked month is never rewritten. Set **To** on the old row and add a new one.
- A declared cost shows in **Declared, by site** but not in **Direct cost**: the two differ until the month's cost import runs.
- A site row shows a **No trend** dash: the months mix currencies or one month has no figure. See [Troubleshooting](/operate/troubleshooting).

Recurring costs, their fields and booking rules are on GitHub: https://github.com/notice-cx/NoticeOS/blob/main/config/recurring-costs.README.md; domain orders: https://github.com/notice-cx/NoticeOS/blob/main/config/domain-costs.README.md; Mediavine revenue, retries and reconciliation: [doc 11, Integrations & economics](../11-integrations.md#mediavine-revenue).

## Next steps

- [Money](/tower/financials)
- [Connect data sources](/guides/connect-data-sources)
- [How NoticeOS works](/concepts/how-noticeos-thinks)
