---
title: "Add your first site"
description: "Add a website to NoticeOS from Home in one step, and see what the product sets up for it."
---

# Add your first site

This page shows how to add your first site to NoticeOS. You finish on the screen where you connect its data.

A **site** is one website or product you want NoticeOS to track: its visitors, search, money, alerts and work. You add it by its domain. Everything about it is then shown on the site's own page in the Tower, with a tab for each part: its data sources, its tasks, its settings and the rest.

## Before you begin

- The site's domain, such as `example.com`. It is the only thing you enter.

## Add the site

1. Open **Home**. On a new installation, Home shows three steps: **Add your first site**, **Connect a source** and **See your first number**.
2. Select **Add your first site**. A small **Add a site** dialog opens over the page.
3. In the **Domain** field, type a plain domain, not a full address.
4. Read the line under the field. It shows the name the site will be saved under, marked **from the site** or **from the domain**.
5. If the site has not gone live yet, select **Not launched yet**.
6. Select **Add site**. The dialog closes and the new site's **Data sources** tab opens.

::: tip
Home also shows a **Use \<zone>** button that sets your device's time zone in one press. Every daily figure, including which day counts as "yesterday", is calculated in that zone. You can change the zone at any time under **Settings** > **General**.
:::

### Where the name comes from

NoticeOS reads the site's own home page and uses the title it finds there. If the site does not respond, or its page has no usable title, the name is made from the domain instead. You can change the name later on the site's **Settings** tab, in the **Identity** card.

### What "Not launched yet" does

A site marked **Not launched yet** starts in a pre-launch stage. Paid collection and the nightly-report freshness check skip it, so NoticeOS raises no alerts and spends nothing on paid collection for a site with nothing to measure yet. Use **Begin monitoring** on the site's **Settings** tab under **Lifecycle** to release that hold.

### What the site's Settings tab holds

Each site has its own **Settings** tab with these sections:

- **Identity** — the name, the domain and which legal entity owns the site.
- **Lifecycle** — the site's stage, computed from collection history; **Begin monitoring** releases a pre-launch hold.
- **Automation** — what NoticeOS is allowed to do automatically for this site.
- **Data collection** — the site's own nightly report: its endpoint, whether the fetch is enabled, and the last report received.
- **Alert rules in force** — which anomaly rules apply to this site.
- **Tracked search terms** — the search queries NoticeOS tracks for this site.

Portfolio-wide settings, such as the time zone and budgets, are on the main **Settings** page. See [Settings](/tower/settings). How a site is onboarded end to end is in [doc 09, Onboarding a site](../09-onboarding-a-site.md).

## Verify

- The site's **Data sources** tab lists every source the product can collect for it. Nothing is connected yet, so each row shows **Not connected**. The first source in the list that is still unconnected has the page's main **Connect** button.
- **Home** shows the site's current health. Setup progress is on the site's **Sources** tab.
- After the first source is working, the site's **Overview** shows its first number.

## If it didn't work

- The dialog does not accept the domain and shows an **Open example.com** link: the domain already exists, and the link opens the existing site.
- The **Open example.com** link opens the site's **Restore** section: you archived the site earlier. Restore it there instead of adding it a second time.
- The name is marked **from the domain** when you expected the site's title: the site did not respond or its page had no usable title. You can change the name later in the **Identity** card.

More symptoms are in [Troubleshooting](/operate/troubleshooting).

## Next steps

- [Connect data sources](/guides/connect-data-sources)
- [Connect Google](/guides/connect-google)
- [Sites](/tower/sites)
