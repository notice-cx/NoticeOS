---
title: "Record revenue and costs"
description: "Where revenue arrives on its own, and how to declare the subscriptions and domain orders the ledger cannot see."
---

# Record revenue and costs

This page gets your money picture complete: revenue collected automatically, and the costs you declare once so every month books them.

## Before you begin

- For ad revenue, Mediavine connected. See [Connect data sources](/guides/connect-data-sources).
- For a recurring cost, what the statement calls it, its monthly amount in USD and its first month.
- For a domain order, the registrar's receipt.

### Where revenue comes from

Ad revenue from Mediavine arrives on its own once Mediavine is connected. The sync runs daily at 6:10 a.m. Pacific and requests yesterday explicitly. Missing days are retried, never recorded as zero. Figures are estimates until a payment is reconciled, and the site's **Data sources** tab shows **Reported through** with an **Estimates** chip.

Revenue from other networks has no connector yet. The ingest has an operator-only import route for revenue rows; it needs the operator token, so it belongs to whoever runs the installation.

### Where the tables are

Open **Money** in the sidebar. It opens with the month's answer, such as **October net +$135 so far**, and three figures: **Revenue**, **Cost** and **Confirmed**. A **Month to date** chip marks an open month. Use **Accounting period** to pick another month.

Under the answer, each panel opens on demand: **Daily revenue**, **Month by month**, **Where the cost comes from**, **By site**, and **Declared costs**, which holds the two tables you edit. A site's own **Money** tab shows the same for one site. See [Money](/tower/financials).

### Currencies

Declared costs are entered in USD. Collected revenue carries the currency the provider reported. NoticeOS does no exchange-rate conversion: figures in one currency are added, and a month that mixes currencies shows each figure with its own code and leaves the month-by-month trend empty rather than add unlike amounts.

## Add a recurring cost

A recurring cost is a fixed monthly subscription the ledger cannot discover, such as hosting or a tool. Each row books every month from its start month to its end month.

1. Open **Money** and open **Declared costs**.
2. In **Recurring costs**, select **Add**.
3. Fill in **Id** (lowercase with dashes, such as `claude-code`), **Label** (what the statement calls it), **Site** (the site that carries it, or the NoticeOS site for anything shared), **Family** (`inference`, `api`, `infra`, `operator` or `os-overhead`), **USD / month**, **From** (the first month, as `YYYY-MM`) and, if it has ended, **To**. **Note** is optional and is copied onto each month.
4. Save the row. It saves with **Undo** beside it, and the month totals recompute.

Assign a subscription used by one site to that site. Assign shared tools and hosting to the NoticeOS site, so site margins stay honest and overhead is not spread by guesswork.

## Add a domain order

A domain order is a registration, renewal or transfer, recorded from the registrar's receipt. Each order is spread evenly over twelve months from its purchase month and books as an infrastructure cost on its site.

1. In **Declared costs**, go to **Domain orders** and select **Add**.
2. Fill in **Domain** (a name, not a URL), **Site**, **Order** (`registration`, `renewal` or `transfer`), **Paid (USD)** as charged, and **Paid on** (the receipt date).
3. Save the row.

Add renewals as new orders from their receipts; a registration price is not a renewal price.

## Change an amount

The monthly amount of a recurring cost is fixed once written, because every booked month was booked at it. To change a price:

1. On the existing row, set **To** to its last month.
2. Select **Add** and enter a new row with a new **Id**, the new amount, and **From** set to the first month at the new price.

Other cells (label, site, note, dates) save in place. **Remove** deletes a row with **Undo**.

::: warning
Do not edit a past month's figure to "fix" history. A booked month is history; the product refuses a conflicting replay.
:::

## Verify

- The row saves with **Undo** beside it and the month totals recompute.
- In **Domain orders**, the **Per month** column shows what each order books and the months it spans, and a **Renews** chip appears when a term is about to end. The table's header counts the orders, the cash paid, and how many are still spreading into the shown month.
- Under **Declared costs**, **Declared, by site** shows each site's declared run rate per month.

## If it didn't work

- The product refuses the row as a conflicting replay: a booked month is never rewritten. Set **To** on the old row and add a new one.
- A declared cost shows in **Declared, by site** but not in **Direct cost**: the two differ until the month's cost import runs.
- A site row shows a **No trend** dash: the months mix currencies or one month has no figure. See [Troubleshooting](/operate/troubleshooting).

Recurring costs, their fields and booking rules are on GitHub: https://github.com/notice-cx/NoticeOS/blob/main/config/recurring-costs.README.md; domain orders: https://github.com/notice-cx/NoticeOS/blob/main/config/domain-costs.README.md; Mediavine revenue, retries and reconciliation: https://github.com/notice-cx/NoticeOS/blob/main/docs/11-integrations.md#mediavine-revenue.

## Next steps

- [Money](/tower/financials)
- [Connect data sources](/guides/connect-data-sources)
- [How NoticeOS thinks](/concepts/how-noticeos-thinks)
