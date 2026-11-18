---
title: "The Tower"
description: "What the Tower is, how to open it, and where to find each part of it."
---

# The Tower

This page introduces the Tower: what it is, how to open it, and where to find each part of it.

## What the Tower is

The **Tower** is NoticeOS's web app: the screens you open in a browser to see how your assets are doing and to act on them. Once an installation is running, it is at the address setup printed, `http://127.0.0.1:5173/` by default. It works on a laptop, a phone and a TV.

It has two parts:

- **The Tower's pages** are the pages with a sidebar, where you read, decide and change things.
- **The Wall** is the TV view at `/wall`: one screen with no controls, made to be read across a room. You arrange it from the Tower's pages. See [The Wall](/tower/wall).

Both show the same data from the same installation.

## The pages

Use the sidebar to open a portfolio-wide report. Choose an asset to see its reports. See [Find a report](/guides/choose-your-view).

On desktop, **Collapse sidebar** gives reports more room. Hover or focus an icon to see its name. **Expand sidebar** restores the asset list. The browser remembers the width for each person and workspace.

| Page | What it shows |
|---|---|
| [Home](/tower/home) | How the business is doing, what is broken and what needs your attention. The Tower opens here. |
| [Portfolio](/tower/sites) | Which assets need your attention. Each asset also has its own page. |
| [Money](/tower/financials) | The month's net, and where the money comes from and goes. |
| [Alerts](/tower/alerts) | What needs attention right now, and how serious it is. |
| [Tasks](/tower/tasks) | How big the work queue is, and which tasks in it are waiting for you. |
| [Workflows](/tower/workflows) | Analysis runbooks and their results. |
| [Agents](/tower/agents) | What your agents did and how fast they closed tasks. |
| [System health](/tower/health) | Whether NoticeOS itself is working: each source's collection, the scheduled jobs, expiring credentials and data spend. |
| [Integrations](/tower/integrations) | Which provider accounts are connected, and how to connect another. |
| [Settings](/tower/settings) | The settings that apply to the whole installation. |

At the bottom of the sidebar, **TV dashboard** opens the Wall, and the pencil beside it opens the Wall's layout editor. On a phone the sidebar is hidden behind the menu button. Press **⌘K** (**Ctrl+K**), or the sidebar's **Search**, to jump to any page, asset or task by name.

## An asset's own page

An **asset** is one website or product you added. Its name on Home or Portfolio opens its own page, with tabs: **Overview**, **Growth**, **Journeys**, **Money**, **Search**, **Codebase**, **Health**, **Alerts**, **Tasks**, **Activity**, **Data sources** and **Settings**. Most of what concerns one asset happens there: you connect its data on **Data sources**, log a change on **Activity** and rename it on **Settings**. See [Portfolio](/tower/sites).

## How to read a page

Every page starts with a one-line summary, such as **2 open alerts, both warnings**, and the detail follows. A few marks mean the same thing on every page:

- **unknown**, or a dash you can hover for the reason: there is not enough data for a figure. NoticeOS never shows a missing number as zero.
- A **hollow point**: a day still being counted.
- **est.**: an estimate not yet matched to a payment or receipt.
- A **dashed line**: a projection or a comparison, never a measurement.

The other pages in this section each describe one screen in the same three parts: **What you see**, **What you can do**, and **States and labels**, the words a screen shows when something is missing or not ready yet.

## Who can open it

A standalone installation has no sign-in: anyone who can reach the Tower's address can read and change everything in it. Keep it on a private network, behind a VPN, or behind an access proxy of your own.

In a customer workspace, open **Account** in the sidebar or the phone header. **Profile** shows your verified email, display name and current workspace role. Change **Display name** and select **Save name** to update it. The private backup preview displays your profile read-only. **Account** also contains **Switch workspace** and **Sign out**.

## Related

- [What is NoticeOS](/start/what-is-noticeos)
- [How NoticeOS works](/concepts/how-noticeos-thinks)
- [Glossary](/concepts/glossary)
