---
title: "The Tower"
description: "What the Tower is, how to open it, and where each part of it lives."
---

# The Tower

This page introduces the Tower: what it is, how to open it, and where to find each part of it.

## What the Tower is

The **Tower** is NoticeOS's web app: the screens you open in a browser to see how your sites are doing and to act on them. Once an installation is running, it is at the address setup printed, `http://127.0.0.1:5173/` by default. It works on a laptop, a phone and a TV.

It has two faces:

- **The desk** is every page with a sidebar, where you read, decide and change things. When these docs say "the desk", they mean those pages rather than the TV.
- **The Wall** is the TV view at `/wall`: one screen with no controls, made to be read across a room. You arrange it from the desk. See [The Wall](/tower/wall).

Both show the same data from the same installation.

## The pages

The sidebar lists the pages in the order you are likely to need them.

| Page | What it answers |
|---|---|
| [Home](/tower/home) | How the business is doing, what is broken and what needs you. The Tower opens here. |
| **Workflows** | What NoticeOS runs on its own, on what schedule, and how each run went. |
| [Sites](/tower/sites) | Which site needs you. Each site also has its own page. |
| [Alerts](/tower/alerts) | What needs attention right now, and how badly. |
| [Tasks](/tower/tasks) | How big the work queue is, and what in it waits on you. |
| [Money](/tower/financials) | Whether the month is earning, and where the money comes from and goes. |
| **System health** | Whether NoticeOS itself is working: each source's collection, the scheduled jobs, expiring credentials and data spend. |
| [Integrations](/tower/integrations) | Which provider accounts are connected, and how to connect another. |
| [Settings](/tower/settings) | What applies to the whole installation. |

At the bottom of the sidebar, **TV dashboard** opens the Wall, and the pencil beside it opens the Wall's layout editor. On a phone the sidebar waits behind the menu button. Press **⌘K** (**Ctrl+K**), or the sidebar's **Search**, to jump to any page, site or task by name.

## A site's own page

A **site** is one website or product you added. Its name on Home or Sites opens its own page, with tabs: **Overview**, **Growth**, **Money**, **Search**, **Alerts**, **Tasks**, **Activity**, **Data sources** and **Settings**. Most of what concerns one site happens there: you connect its data on **Data sources**, log a change on **Activity** and rename it on **Settings**. See [Sites](/tower/sites).

## How a page reads

Every page opens with its answer in one sentence, such as **2 open alerts, both warnings**, and the detail follows. A few marks mean the same thing on every page:

- **unknown**, or a dash you can hover for the reason: the data cannot say. NoticeOS never shows a missing number as zero.
- A **hollow point**: a day still being counted.
- **est.**: an estimate that no payment or receipt has confirmed yet.
- A **dashed line**: a projection or a comparison, never a measurement.

The other pages in this section each describe one screen in the same three parts: **What you see**, **What you can do**, and **States and labels**, the words a screen shows when something is missing or not ready yet.

## Who can open it

A standalone installation has no sign-in: anyone who can reach the Tower's address can read and change everything in it. Keep it on a private network, behind a VPN, or behind an access proxy of your own.

## Related

- [What is NoticeOS](/start/what-is-noticeos)
- [How NoticeOS thinks](/concepts/how-noticeos-thinks)
- [Glossary](/concepts/glossary)
