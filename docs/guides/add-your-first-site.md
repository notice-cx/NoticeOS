---
title: "Add your first site"
description: "Add a website to NoticeOS from Home in one step, and see what the product sets up for it."
---

# Add your first site

This page gets your first site into NoticeOS and leaves you on the screen where its data gets connected.

## Before you begin

- The site's domain, such as `example.com`. That is the only thing the product asks for.

## Add the site

1. Open **Home**. On a new installation, Home shows three steps: **Add your first site**, **Connect a source** and **See your first number**.
2. Select **Add your first site**. A small **Add a site** dialog opens over the page.
3. In the **Domain** field, type a plain domain, not a full address.
4. Read the line under the field. It shows the name the site will be saved under, marked **from the site** or **from the domain**.
5. If the site has not gone live yet, select **Not launched yet**.
6. Select **Add site**. The dialog closes and you land on the new site's **Data sources** tab.

::: tip
Home also offers your device's time zone in one press, as **Use \<zone>**. Every daily figure, including which day counts as "yesterday", is read in that zone. The zone changes any time under **Settings** > **General**.
:::

### Where the name comes from

NoticeOS reads the site's own home page and uses the title it finds there. If the site does not answer, or does not give a usable title, the name is made from the domain instead. Change the name later on the site's **Settings** tab, in the **Identity** card.

### What "Not launched yet" does

A site marked **Not launched yet** starts in a pre-launch stage. Paid collection skips it and the product does not expect a nightly report from it, so a site with nothing to measure raises no alarms and spends nothing. Change the stage later on the site's **Settings** tab under **Manual lifecycle stage**.

### What the site's Settings tab holds

Each site has its own **Settings** tab with these sections:

- **Identity** — the name, the domain and which legal entity owns the site.
- **Manual lifecycle stage** — where the site is in its life, including pre-launch.
- **Automation** — what the product may do for this site on its own.
- **Data collection** — the site's own nightly report: its endpoint, whether the fetch is enabled, and the last report received.
- **Alert rules in force** — which anomaly rules judge this site.
- **Tracked search terms** — the search queries the product watches for this site.

Portfolio-wide settings, such as the time zone and budgets, live on the main **Settings** page. See [Settings](/tower/settings). How a site is onboarded end to end is in [doc 09, Onboarding a site](../09-onboarding-a-site.md).

## Verify

- The site's **Data sources** tab lists every source the product can collect for it. Nothing is connected yet, so each row reads **Not connected**. The first one worth connecting carries the page's main **Connect** button.
- **Home** shows the site's health word **Setting up** until the first numbers arrive.
- After the first source is working, the site's **Overview** shows its first number.

## If it didn't work

- The dialog refuses the domain and shows an **Open example.com** link: the domain already exists, and the link opens the existing site.
- The dialog offers to restore the site: you archived it earlier, and it is restored rather than added twice.
- The name is marked **from the domain** when you expected the site's title: the site did not answer or gave no usable title. Change the name later in the **Identity** card.

More symptoms are in [Troubleshooting](/operate/troubleshooting).

## Next steps

- [Connect data sources](/guides/connect-data-sources)
- [Connect Google](/guides/connect-google)
- [Sites](/tower/sites)
