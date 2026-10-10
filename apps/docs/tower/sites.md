---
title: "Sites"
description: "Which site needs you, and one site's own page: its verdict, its numbers and its tabs."
---

# Sites

Sites answers one question: which site needs me.

## What you see

**The Sites page** opens with its answer: **1 of 7 sites at risk**, naming the site, or the count of sites that are fine. **Add a site** sits in the header. **Filters & sort** holds a **Traffic period** range and a **Health** legend to filter by. The table has one row per site:

| Column | What it holds |
|---|---|
| **Site** | name and domain |
| **Health** | the one word: **Setting up**, **On track**, **Monitor only**, **At risk**, **Off track** |
| **Visitors** | today's live count, with a hover that explains it |
| **Visitors · 28d** | the period's visitors |
| **Net · October** | the month's money |
| **Tasks** | open work |

On a phone the table reflows into labelled cards.

**A site's page** has a header with the site's name, its domain as a link, and its verdict: the same health word, with a hover that counts its open alerts. Under the header are the tabs: **Overview**, **Growth**, **Money**, **Search**, **Alerts**, **Tasks**, **Activity**, **Data sources** and **Settings**. The tab is in the address, so a link lands on the right one.

**Overview** is the whole answer on the first screen: a row of figures for money, people, search and the site's one product figure, over one chart. Every shipped change is a labelled mark on that chart and every open outcome check is a shaded span, so cause and effect sit on one axis. Under the chart: **Bets** ranked by dollars, **Needs you**, **Search movers**, **What matters**, the site's totals row, and **Product use**. A provider's name appears only as a chart key beside its own line.

**The other tabs:**

- **Growth** and **Search**: the traffic and search series in detail, with product-use stages on Growth.
- **Money**: this site's ledger, as on the Money page.
- **Alerts** and **Tasks**: the site's slice of those boards.
- **Activity**: the timeline of changes, outcome checks and runs.
- **Data sources**: each source's status for this site, with **Connect**, **Not using** and the mapping fields.
- **Settings**: **Identity**, **Manual lifecycle stage**, **Automation**, **Data collection**, **Alert rules in force** and **Tracked search terms**.

## What you can do

- **Add a site** opens the same dialog Home uses.
- **Filters & sort** narrows the table by **Traffic period** and **Health**.
- A row opens the site's page; the domain link opens the site itself.
- Hover, focus or tap a mark on the Overview chart to read the change or outcome check behind it.
- On **Data sources**, **Connect** opens the connect panel and **Not using** records a reason for skipping a source.
- On **Settings**, the six cards hold everything that applies to this one site.

## States and labels

- A cell with no answer shows a dash whose hover names the reason.
- With no sites the page reads **No sites yet**.
- A site with no numbers yet opens on **Data sources** instead of an empty Overview.
- A **hollow point** is a day still being counted; it fills in once the day is complete.
- A **dashed line** is a projection or last week's comparison, never a measurement.
- A **bracketed day** on the axis is one the measurement cannot compare, such as a day a reporting time zone changed; its colour verdict is withdrawn.
- A **dash** in a figure is a named absence. Hover it for the reason.
- **unknown** means the data cannot say, which is different from a measured zero, which is drawn.

## Related guides

- [Add your first site](/guides/add-your-first-site)
- [Connect data sources](/guides/connect-data-sources)
- [Attribution and measurement](/concepts/attribution-and-measurement)
- The design on GitHub: https://github.com/notice-cx/NoticeOS/blob/main/docs/14-design.md#surfaces-as-built
