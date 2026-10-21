---
title: "Home"
description: "How the business is doing, what is broken and what needs your attention, drawn from your sites' data."
---

# Home

**Home** is the page the Tower opens on: one page that sums up every site, so you can tell in a minute whether anything needs your attention. New to the Tower? Start with [The Tower](/tower/).

Home shows three things, in this order: how the business is doing, what is broken, and what needs your attention. Which parts of Home show them depends on your view; see [Your view](#your-view).


## What you see

**The summary.** A small grey line shows the greeting, the window since 6 PM yesterday and how many things changed in it. Under it, one sentence sums up the page, such as **October is projected at $1,020, 9% under September. 2 things are broken.**

In the **I run the business** view, the sentence starts with the sites' health once at least one site is measured: **All 3 sites are fine.**, or **2 of 3 sites are fine.** followed by the site that most needs a look and its first problem, such as **Example Shop: the home page did not load.** That part is red when a site is down and amber when a site is worth a look. The month's money follows, and the count of broken things is shown only when there is at least one.

**Money.** The month so far is the largest number on the screen, marked **est.** while it is an estimate (**so far** in the **I run the business** view). **Yesterday** shows the previous day's revenue with cents inside the same card, including how many sites reported when some are missing. Missing reports show **not reported yet**; reports on different clocks show **mixed report days · no total**. Beside the figures, the month's days appear as bars, with a dashed line at the usual day. Under them, a bar shows the month so far, its projected total and last month's total, and **Where October came from** splits the month by site. **Visitors in the last 28 days** is a separate card. Its figure sums reported daily visitor counts over the 28 calendar days ending on the latest settled reading. Days still being counted are excluded; missing days remain gaps and incomplete coverage is labelled. The visitor and revenue bars are split by site, with matching named colour legends and each site's contribution on hover. In the **Everything** view, Visitors shares a two-column group with Problems, Decisions and Agents. With no revenue source on any site, this group comes first and no money figure is drawn.

**Problems.** A compact card shows the three highest-ranked issues, with errors before warnings and the newest first within each severity. Its header counts all broken and at-risk conditions, including source failures and backup failures. Titles use at most two lines; open a row for its details, or **All alerts →** for Alerts. Source failures open the site's **Data sources** tab. Data source details remain on the site pages and Integrations.

**Decisions.** A compact card shows how many decisions are waiting, the oldest known wait and the three most urgent requests. Approvals that hold work come first, then priority and age. Each title uses at most two lines and opens its task. Full request details and **Approve**, **Answer** and **Close as** actions are on Tasks. **All tasks →** and **View all N decisions →** open the Tasks page's **All tasks** tab at `/tasks/all`.

**Agents.** A compact card shows **Closed in 7 days** and **In progress**, summed across the agents' task projects. Up to three named workers show their closes as bars beside their agent icons, with a link to the full Agents page. Claude uses a light spark on an orange tile. A worker counts as an agent only when it has named a model. Missing, partial or outdated activity is labelled rather than shown as a measured zero.

**Sites.** Immediately below the four-card overview in the **Everything** view, one row per listed site, in your order (set with **Arrange** on the Sites page): its status, people a day as a line with the latest day's count, yesterday's revenue with its change, and its share of the month. With one site, Home shows that site's own numbers and chart instead.

**Problems and activity · Last 24 hours.** One row per listed site and one for the System, on a time axis that ends at **Now**. Open problems are bars from when they started; a problem older than the day starts at the left edge with its age written on it. Shipped changes, wins and recoveries are marks on their site's row. The shaded part is the time since 6 PM yesterday.

**Site health.** One row per listed site, with five dots under **Up**, **Speed**, **Errors**, **Search** and **Code**, and the row's problems in words beside it, such as **The home page did not load · Slow for some visitors**, or **Fine**, or **Nothing measured yet**. A site whose nightly report is late shows **No report for 2 days** (or the hours, under two days) first, and is never **Fine**. On a phone the site's name takes its own line and the five dots share the width under the header. A dot is red when the site is down, amber when the fact is worth a look, grey when it is fine, and an empty dashed ring when it is not measured yet. The line under the grid names where the dots come from: the hourly home-page check, what visitors' browsers recorded, four weeks of visits from search and each site's code report. Each fact is described under [the site's **Health** tab](/tower/sites#the-health-tab).

**The agents · this week.** Three figures joined by **›**: **Building** (tasks in progress across the sites with a task project), **Finished** (tasks done so far this week) and **Proven to work** (sites whose newest measured change worked). **N being watched** beside the title counts the changes still being measured. Under the figures, up to three of the newest lines: a finished task with what it did, or a site's **Latest bet** with its result.

**Where visitors come from · 4 weeks.** Every listed site's visits by channel, added up by channel name, largest first, each as a bar and its percent of all visits; channels after the first five are added into **Other**. Beside it (under it on a phone), the funnel that loses the most people at one step, across the listed sites: the site and funnel name, every step as a bar with the step after the largest loss in amber, and a sentence naming the two steps, such as **120 people left between “Opened a recipe” and “Saved it”.** The part is as tall as its content.

**Worth a look.** Up to eight things the sites are missing, in this order: a site that earns nothing (**Example Shop earns nothing**), a site with no data feeds, a site with no task project, a site that sends no code report, then the opportunities the newest readings found, each with its site's name under it. Retired sites are left out, and a site not launched yet is not listed as earning nothing.

**Listed sites.** A site is listed while its **Home and Sites list** switch is on. A site with the switch off has no row in Site health, Sites or the timeline; its problems are still counted in the summary and listed under **Problems**, and its money and visitors are still in the month's figures. An archived site stays hidden until restored. See [Where each site shows](/tower/sites#where-each-site-shows).

**Until the first site has its first number**, Home shows one sentence and three steps: **Add your first site**, **Connect a source** and **See your first number**. The current step is shown as a button, and each finished step is marked done. Home also shows **Use \<zone>**, which saves your device's time zone in one press.

Above the steps, until you have chosen a view of your own, Home shows two questions in one box:

- **Which describes you?** lists the three views, **I run the business**, **I build the product** and **Everything**, each with one line under it. One press chooses the view and saves it.
- **What matters most?** then replaces it in the same box, with five picks: **Money**, **Visitors**, **Site health**, **The agents' work** and **Costs**. Any number can be picked; **Continue** saves them in the order picked and **Skip** saves none. Choosing **Everything** closes the box without this question.

![The first-run box on Home in a new installation with no site yet: Which describes you? with I run the business, I build the product and Everything, each with its line, above Step 1 Add your first site, Step 2 Connect a source and Step 3 See your first number.](../images/tower-first-run-view.webp)

The steps work before the questions are answered: a site can be added first, and until you answer, the pages use the workspace default view. The first answer on a new installation also becomes the workspace default, the view new people and the TV start from, when none is saved yet and settings can be saved.

## Your view

The view chosen on the first run, or later in [Settings → General → **Your view**](/tower/settings#general), decides which parts of Home are shown and in what order. The one-sentence summary at the top is shown in every view.

| View | Parts of Home, in order |
|---|---|
| **I run the business** | **Site health**, **Money**, **The agents · this week**, **Decisions** |
| **I build the product** | **Money**, **Where visitors come from · 4 weeks**, **Worth a look**, **Problems**, **Decisions**, **Sites** |
| **Everything** | **Money** including **Yesterday**, a 2×2 group (**Problems**, **Decisions**, **Agents**, **Visitors in the last 28 days**), **Sites**, **Problems and activity** |

In **I run the business**, Home opens on **Site health**, with the month's money and **Decisions** under it and **The agents · this week** further down:


In **I build the product**, Home opens on the month's money beside **Worth a look**, then **Where visitors come from · 4 weeks** beside **Problems**, with **Decisions** and **Sites** further down:


Each pick from **What matters most?** moves one part to the top, in the order picked: **Money** and **Costs** move **Money**, **Visitors** moves **Sites**, **Site health** moves **Site health** and **The agents' work** moves **The agents · this week**. A pick whose part the view does not show changes nothing: in the **Everything** view only **Money**, **Costs** and **Visitors** move a part. A part a view leaves out is still in the product: its page is in the sidebar of the **Everything** view and in Search (**⌘K**).

## What you can do

- Open a site from Site health, Sites or the timeline.
- Open a problem from its row in **Problems**; **All alerts →** opens Alerts.
- Open a decision to read the full request and use its actions on Tasks.
- Open Money from **Yesterday** in the revenue card, and the Sites page from **Visitors in the last 28 days** or **All sites →**.
- In **Site health**, open a site from its name; point at or focus a dot to show its word and its problem. The site's **Health** tab shows the readings behind each dot.
- In **Agents** or **The agents · this week**, **Agents →** opens the Agents page.
- In **Worth a look**, **Make a task** on a row opens the task form with the row's title filled in and the site's task project chosen when it has one.
- On the first run, press a view under **Which describes you?**, then pick under **What matters most?** and press **Continue** or **Skip**.
- **Add your first site**, on the first run, opens the **Add a site** dialog.
- **Use \<zone>** saves your device's time zone for every daily figure.

## States and labels

- A site's status is one of **On track**, **Monitor only**, **At risk**, **Off track** and **Retired**. Only **At risk** and **Off track** are coloured. An archived site's problems and tasks are excluded from portfolio lists and counts.
- **est.** marks revenue as an estimate until it is reconciled.
- A missing figure is shown as a label, never drawn as zero: **not reported yet**, **no revenue**, **no visitors reported**.
- **Nothing is broken.** means there is no open problem anywhere. Monitoring is still running.
- In **Site health**, a fact is red only when the site is **Down**. Amber words are **Not checked lately**, **Slow**, **Some** (errors), **Falling**, **Sitemap failing** and **Growing fast**. A fine fact is grey: **Up**, **Fast**, **OK**, **None**, **Few**, **Steady** or **Growing**. A dashed ring is **not measured yet**, **too few visits yet** or **too early to tell**. A retired site and one not launched yet have every fact **not measured yet**.
- In **The agents · this week**, a figure that cannot be counted shows **not counted yet**: **Building** until a site has a task project, **Finished** while any task project cannot report its week. A **Latest bet** reads **Worked**, **Did not help**, **Changed nothing** or **Could not be measured** once measured, and **We'll know in N days**, **We'll know soon** or **Still being watched** before.
- **Where visitors come from · 4 weeks** shows **Not joined yet** while no site sends visits by channel. Its funnel side shows **No funnel declared yet** when product analytics is read but no funnel is declared, and **Not joined yet** when no product analytics is read.
- **Worth a look** shows **Nothing is missing.** when it has no rows.
- Home's layout depends on its width: one column on a phone or a narrow window, two on a portrait monitor, the full layout on a wide screen.

## Related guides

- [Install in five minutes](/start/quickstart)
- [Add your first site](/guides/add-your-first-site)
- [Tasks](/tower/tasks) and [Sites](/tower/sites)
- The design in [doc 14, Design](../14-design.md#surfaces-as-built)
