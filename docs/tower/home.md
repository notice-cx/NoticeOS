---
title: "Home"
description: "How the business is doing, what is broken and what needs your attention, drawn from your assets' data."
---

# Home

**Home** is the page the Tower opens on: one page that sums up every asset, so you can tell in a minute whether anything needs your attention. New to the Tower? Start with [The Tower](/tower/).


## What you see

**Executive briefing.** Home shows one full-width finding and its next action at a time. **Details** expands the supporting observation and reasoning. Up to three findings rotate every 7 seconds; vertical dots select a finding and pause rotation. Interaction, open Details and reduced-motion preferences pause automatic changes. Measurement periods appear naturally in the prose. The model reviews bounded summaries across finances, acquisition, product performance, delivery, measured outcomes and operational health. It can return no findings when the evidence adds no useful judgment.

**Refresh AI insights** requests a new briefing and animates while generation runs. Generation runs only on request. Saved insights persist in Postgres through restarts; reading Home never starts a model request. A failed refresh keeps the last useful findings visible with a warning and a link to the execution details. Outdated results are labelled. A disconnected model has a **Connect a model** link to Integrations.

**Money.** The month so far is the largest number on the screen, marked **est.** while it is an estimate. **Yesterday** shows the previous day's revenue with cents inside the same card, including how many assets reported when some are missing. Missing reports show **not reported yet**; reports on different clocks show **mixed report days · no total**. Beside the figures, the month's days appear as bars, with a dashed line at the usual day. Under them, a bar shows the month so far, its projected total and last month's total, and **Where October came from** splits the month by asset. **Visitors in the last 28 days** is a separate card. Its figure sums reported daily visitor counts over the 28 calendar days ending on the latest settled reading. Days still being counted are excluded; missing days remain gaps and incomplete coverage is labelled. The visitor and revenue bars are split by asset, with matching named colour legends and each asset's contribution on hover. Visitors shares a two-column group with Problems, Decisions and Agents. With no revenue source on any asset, this group comes first and no money figure is drawn.

**Problems.** A compact card shows the three highest-ranked issues, with errors before warnings and the newest first within each severity. Its header counts all broken and at-risk conditions, including source failures and backup failures. Titles use at most two lines; open a row for its details, or **All alerts →** for Alerts. Source failures open the asset's **Data sources** tab, and an overdue review opens its review task. Data source details remain on the asset pages and Integrations.

**Decisions.** A compact card shows how many decisions are waiting, the oldest known wait and the three most urgent requests. Approvals that hold work come first, then priority and age. Each title uses at most two lines and opens its task. Each decision is taken on its task's page in [Tasks](/tower/tasks). **All decisions →** and **View all N decisions →** open the Tasks board's **Waiting for you** view, `/tasks?view=waiting`.

**Agents.** A compact card shows **Closed in 7 days** and **In progress**, summed across the agents' task projects. Up to three named workers show their closes as bars beside their agent icons, with a link to the full Agents page. Claude uses a light spark on an orange tile. A worker counts as an agent only when it has named a model. Missing, partial or outdated activity is labelled rather than shown as a measured zero.

**Portfolio.** Immediately below the four-card overview there is one row per listed asset, in your order (set with **Arrange** on the Portfolio page): its status, people a day as a line with the latest day's count, yesterday's revenue with its change, and its share of the month. With one asset, Home shows that asset's own numbers and chart instead.

**Problems and activity · Last 24 hours.** One row per listed asset and one for the System, on a time axis that ends at **Now**. Open problems are bars from when they started; a problem older than the day starts at the left edge with its age written on it. Shipped changes, wins and recoveries are marks on their asset's row; a finished task's mark opens that task's page. The shaded part is the time since 6 PM yesterday.

**Listed assets.** An asset is listed while its **Home and Portfolio** switch is on. An asset with the switch off has no row in Asset health, Portfolio or the timeline; its problems are still counted in the summary and listed under **Problems**, and its money and visitors are still in the month's figures. An archived asset stays hidden until restored. See [Where each asset shows](/tower/sites#where-each-asset-shows).

**Until the first asset has its first number**, Home shows one sentence and three steps: **Add your first asset**, **Connect a source** and **See your first number**. The current step is shown as a button, and each finished step is marked done. Home also shows **Use \<zone>**, which saves your device's time zone in one press.

## What you can do

- Open an asset from Portfolio or the timeline.
- Open a problem from its row in **Problems**; **All alerts →** opens Alerts.
- Open a decision to read the full request and use its actions on Tasks.
- Open Money from **Yesterday** in the revenue card, and the Portfolio page from **Visitors in the last 28 days** or **All assets →**.
- In **Agents**, **Agents →** opens the Agents page.
- **Add your first asset**, on the first run, opens the **Add an asset** dialog.
- **Use \<zone>** saves your device's time zone for every daily figure.

## States and labels

- An asset's status is one of **On track**, **Monitor only**, **At risk**, **Off track** and **Retired**. Only **At risk** and **Off track** are coloured. An archived asset's problems and tasks are excluded from portfolio lists and counts.
- **est.** marks revenue as an estimate until it is reconciled.
- A missing figure is shown as a label, never drawn as zero: **not reported yet**, **no revenue**, **no visitors reported**.
- **Nothing is broken.** means there is no open problem anywhere. Monitoring is still running.
- Home's layout depends on its width: one column on a phone or a narrow window, two on a portrait monitor, the full layout on a wide screen.

## Related guides

- [Install in five minutes](/start/quickstart)
- [Add your first asset](/guides/add-your-first-site)
- [Tasks](/tower/tasks) and [Portfolio](/tower/sites)
- The design in [doc 14, Design](../14-design.md#surfaces-as-built)
