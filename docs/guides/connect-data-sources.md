---
title: "Connect data sources"
description: "Connect traffic, search, product and revenue sources once, match them to your assets, and read what each status word means."
---

# Connect data sources

This page shows how to connect and test a data source and start collecting from it for the assets it covers. It also lists what each status on screen means.

A **data source** is a service that already holds numbers about your asset: Google Analytics for visitors, Search Console for search clicks, an ad network for revenue. You connect your account with each provider once, an **integration**, and NoticeOS then collects from it on a schedule, so the numbers arrive without manual work and appear on the asset's pages.

## Before you begin

- At least one asset added. See [Add your first asset](/guides/add-your-first-site).
- What the provider issued: **API key** (Bing), **API login** and **API password** (DataForSEO), **Personal API key** (PostHog), **Email** and **Password** (Mediavine), or a token per project (Microsoft Clarity). Google uses a sign-in instead of a key. See [Connect Google](/guides/connect-google).

### Two places to connect, one panel

- **Integrations** in the sidebar lists every source the product can collect, grouped as **Traffic & search**, **Revenue**, **Coordination** and **Other**. Each row shows the source's name, its one status and one button: **Connect**, **Manage**, or **Reconnect** when its key is failing.
- An asset's **Data sources** tab lists the same sources for that one asset, under **Data sources** and **More sources**, each row with its own **Connect**.

Both open the same panel. Opening it from an asset pre-selects that asset.

### Connected once, or per asset

Google, Bing Webmaster Tools, DataForSEO, PostHog and Mediavine use one credential for the whole workspace and then collect for every asset that matches. Connect them once on **Integrations**.

Microsoft Clarity issues a token per project, so its panel lists your assets with a **Paste token** field on each row. Pasting a token saves it. **Run now** fetches at once, and its label shows that it uses one of the day's calls; Clarity allows ten calls per project per day.

Discord and calendar feeds apply to the whole installation, not to one asset, so their panels have no asset list. Discord's panel shows **Posts a test message** before you press, because connecting sends a test message to check the webhook.

Uptime needs no connection: the product checks each asset's home page every hour, and the row shows **Up** or **Down**.

### What each source costs

Google, Bing, Clarity, PostHog, Mediavine, Discord and calendar feeds are free to read, within each provider's own limits.

DataForSEO is metered. Its panel shows the spend before you start, its row shows the account credit, and collection stops at the **Monthly data cap** in **Settings** > **General**. The product ships with a cap of $25 a month.

## Connect a source with a key

1. Open **Integrations** and select **Connect** on the row.
2. In the panel, paste what the provider issued. The panel links to the provider's own key page.
3. Select **Connect**. The panel shows **Checking** while it waits for the provider's response, then **Key accepted** (or **Signed in** for Mediavine). Nothing is stored before the provider responds.
4. Review the list of what the account has access to, matched to your assets by domain and already ticked. Anything that matches no asset is listed under **No matching asset**. Untick an asset to skip it; the row opens the **Not using** reasons.
5. Select **Start collecting**. For DataForSEO the button shows **Start weekly reports**, and the panel shows the cost first.

Each asset's row moves from **Collecting** to **Working** when its first result arrives. With one asset the panel shows **Open example.com**; otherwise it shows **Done**.

## Skip a source for one asset

1. On the asset's **Data sources** tab, open the row and select **Not using**.
2. Select **Don't use this product**, **Replaced by another tool**, **Not relevant for this asset**, or type **Your reason**. Your choice is saved at once, with **Undo** in the toast.

A skipped source is never requested or billed for that asset. **Use again** puts it back.

Some rows also have a **Mapping** or **Market** section: the Search Console site, the GA4 property, the PostHog project and its saved funnels, or DataForSEO's market. Each choice is saved on its own with **Undo** beside it.

## Change how often data is collected

A collection that uses a connection is scheduled on that connection's **Manage** panel.

1. Open **Integrations** and select **Manage** on the row.
2. On the job's row, select **Paused**, **Every few minutes**, **Hourly**, **Daily** or **Weekly**, then the time. The jobs are **Ad revenue** (Mediavine), **Traffic and search archives** (Google and Bing), **Product analytics archives** (PostHog), **Search rankings and backlinks** (DataForSEO, weekly) and **Clarity recordings summary**. Each choice is saved with **Undo** beside it.

Collections that use no connection, such as **Nightly reports** and **Live traffic and counters**, are scheduled on **Settings** > **Data collection**.

## Replace or disconnect

1. On **Integrations**, select **Manage** on the row.
2. Select **Replace API key** to test a new key before it is kept, or **Disconnect**, which shows one confirmation listing what stops, then deletes the secret permanently. Collected history is kept.

## Verify

The row's status shows the state of the connection:

| Status | Meaning |
|---|---|
| **Not connected** | Nothing saved for this source. |
| **Not checked** | A credential is saved but nobody has tested it. |
| **Checking** | The panel is waiting for the provider's response. |
| **Key accepted** / **Signed in** / **URL accepted** | The provider accepted what you gave it. Nothing collected yet. |
| **Collecting** | A first collection is running, or the asset's source is mapped and waits for the next scheduled run. The asset's Data sources row shows when that run starts. |
| **Working** | The latest attempt succeeded. |
| **Reconnecting** | Realtime traffic is retrying after a network error. |
| **Overdue** | A scheduled attempt is late while others still work. |
| **Failing** | The credential was rejected, or most assets failed their latest attempt. |
| **Not using** | You skipped it for this asset, with a reason. |
| **Unknown** | The latest monitoring data is out of date, so the row does not show the connection as working. |
| **Doesn't apply** | This source never applies to this asset. |

**Expires in 12d** or **Key expired** is shown beside a credential with a recorded expiry. Small chips beside a status count assets failing and reports missing.

Realtime network errors become a failure incident after three distinct failed
checks spanning at least two minutes. Earlier checks show **Reconnecting**.
A recovery before confirmation creates no failure or recovery entry in Live
feed. Access and setup errors appear immediately; overdue readings still show
**Overdue**.

## If it didn't work

- The key is cleared and the reason is shown under the field: the provider rejected the key. Check the key on the provider's own page and paste it again.
- The row shows **Failing** with a **Reconnect** button: the key was rejected or most assets failed their latest attempt. Select **Reconnect** and enter the key again.
- **Start collecting** does not run: the collection's job is **Paused**. Resume it on the **Manage** panel first.

More symptoms are in [Troubleshooting](/operate/troubleshooting). Every source, what it provides, its limits and how it fails is in [doc 11, Integrations & economics](../11-integrations.md); what each state means on an asset's row is at https://github.com/notice-cx/NoticeOS/blob/main/config/integrations.README.md.

## Next steps

- [Connect Google](/guides/connect-google)
- [Integrations](/tower/integrations)
- [Scheduled jobs](/operate/scheduled-jobs)
