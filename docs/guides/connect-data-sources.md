---
title: "Connect data sources"
description: "Connect traffic, search, product and revenue sources once, match them to your sites, and read what each status word means."
---

# Connect data sources

This page gets a data source connected, tested and collecting for the sites it covers, and tells you what each status on screen means.

## Before you begin

- At least one site added. See [Add your first site](/guides/add-your-first-site).
- What the provider issued: **API key** (Bing), **API login** and **API password** (DataForSEO), **Personal API key** (PostHog), **Email** and **Password** (Mediavine), or a token per project (Microsoft Clarity). Google signs you in instead of taking a key. See [Connect Google](/guides/connect-google).

### Two doors, one panel

- **Integrations** in the sidebar lists every source the product can collect, grouped as **Traffic & search**, **Revenue**, **Coordination** and **Other**. Each row shows the source's name, its one status and one button: **Connect**, **Manage**, or **Reconnect** when its key is failing.
- A site's **Data sources** tab lists the same sources for that one site, under **Data sources** and **More sources**, each row with its own **Connect**.

Both open the same panel. Opening it from a site pre-selects that site.

### Connected once, or per site

Google, Bing Webmaster Tools, DataForSEO, PostHog and Mediavine take one credential for the whole workspace and then serve every site that matches. Connect them once on **Integrations**.

Microsoft Clarity issues a token per project, so its panel lists your sites with a **Paste token** field on each row. The paste is the save. **Run now** fetches at once and says what it spends; Clarity allows ten calls per project per day.

Discord and calendar feeds serve the installation, not a site, so no site list follows. Discord's panel says **Posts a test message** before you press, because that is how it proves the webhook.

Uptime needs no connection: the product checks each site's home page every hour, and the row reads **Up** or **Down**.

### What each source costs

Google, Bing, Clarity, PostHog, Mediavine, Discord and calendar feeds are free to read, within each provider's own limits.

DataForSEO is metered. Its panel shows the spend before you start, its row shows the account credit, and collection stops at the **Monthly data cap** in **Settings** > **General**. The product ships with a cap of $25 a month.

## Connect a source with a key

1. Open **Integrations** and select **Connect** on the row.
2. In the panel, paste what the provider issued. The panel links to the provider's own key page.
3. Select **Connect**. The panel shows **Checking** while the provider answers, then **Key accepted** (or **Signed in** for Mediavine). Nothing is stored ahead of the provider's answer.
4. Review the list of what the account can see, matched to your sites by domain and already ticked. Anything that matches no site is listed under **No matching site**. Untick a site to skip it; the row opens the **Not using** reasons.
5. Select **Start collecting**. DataForSEO reads **Start weekly reports** and states its spend first.

Each site's row moves from **Collecting** to **Working** as its first result lands. With one site the panel offers **Open example.com**; otherwise **Done**.

## Skip a source for one site

1. On the site's **Data sources** tab, open the row and select **Not using**.
2. Select **Don't use this product**, **Replaced by another tool**, **Not relevant for this site**, or type **Your reason**. The pick is the save, with **Undo** in the toast.

A skipped source is never requested or billed for that site. **Use again** puts it back.

Some rows also hold a **Mapping** or **Market** section: the Search Console site, the GA4 property, the PostHog project and its saved funnels, or DataForSEO's market. Each pick saves on its own with **Undo** beside it.

## Change how often data is collected

A collection fed by a connection is scheduled on that connection.

1. Open **Integrations** and select **Manage** on the row.
2. On the job's row, select **Paused**, **Every few minutes**, **Hourly**, **Daily** or **Weekly**, then the time. The jobs are **Ad revenue** (Mediavine), **Traffic and search archives** (Google and Bing), **Product analytics archives** (PostHog), **Search rankings and backlinks** (DataForSEO, weekly) and **Clarity recordings summary**. Each pick saves with **Undo** beside it.

Collections no connection feeds, such as **Nightly reports** and **Live traffic and counters**, are on **Settings** > **Data collection**.

## Replace or disconnect

1. On **Integrations**, select **Manage** on the row.
2. Select **Replace API key** to test a new key before it is kept, or **Disconnect**, which asks once, naming what stops, and deletes the secret for good. Collected history stays.

## Verify

The row's status tells you where the connection stands:

| Status | Meaning |
|---|---|
| **Not connected** | Nothing saved for this source. |
| **Not checked** | A credential is saved but nobody has tested it. |
| **Checking** | The panel is asking the provider now. |
| **Key accepted** / **Signed in** / **URL accepted** | The provider accepted what you gave it. Nothing collected yet. |
| **Collecting** | A first collection is running. |
| **Working** | The latest attempt succeeded. |
| **Overdue** | A scheduled attempt is late while others still work. |
| **Failing** | The credential was refused, or most sites failed their latest attempt. |
| **Not using** | You skipped it for this site, with a reason. |
| **Unknown** | The monitoring read is stale, so no claim is made. |
| **Doesn't apply** | This source never applies to this site. |

**Expires in 12d** or **Key expired** sits beside a credential with a recorded expiry. Small chips beside a status count sites failing and reports missing.

## If it didn't work

- The key is cleared and the refusal shown under the field: the provider refused it. Check the key on the provider's own page and paste it again.
- The row reads **Failing** with a **Reconnect** button: the key was refused or most sites failed their latest attempt. Select **Reconnect** and enter the key again.
- **Start collecting** is refused: the collection's job is **Paused**. Resume it on the **Manage** panel first.

More symptoms are in [Troubleshooting](/operate/troubleshooting). Every source, what it provides, its limits and how it fails is in [doc 11, Integrations & economics](../11-integrations.md); what each state means on a site's row is at https://github.com/notice-cx/NoticeOS/blob/main/config/integrations.README.md.

## Next steps

- [Connect Google](/guides/connect-google)
- [Integrations](/tower/integrations)
- [Scheduled jobs](/operate/scheduled-jobs)
