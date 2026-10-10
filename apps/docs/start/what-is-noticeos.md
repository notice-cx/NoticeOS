---
title: "What is NoticeOS"
description: "A self-hosted operating desk that shows traffic, revenue, costs, alerts and work for your websites and software products in one place."
---

# What is NoticeOS

This page tells you what NoticeOS does, who it is for, and what it does not do yet.

## One screen for your whole portfolio

NoticeOS is a self-hosted web app you run for your own websites and software products. You install it on your own machine or server, connect the services that already hold your data, and read everything from one desk.

It brings four things together:

- **What needs attention.** Collection failures, unusual traffic and missing evidence show up as alerts.
- **What earns.** Recorded revenue and costs sit side by side, with their dates and coverage kept visible.
- **What is moving.** Tasks carry owners, blockers, approvals and completion evidence across your projects.
- **What changed.** A shipped change keeps its follow-up evidence, so finishing work is never mistaken for a better outcome.

## The Tower and the Wall

The **Tower** is the web app you work in. Its pages are Home, Workflows, Sites, Alerts, Tasks, Money, System health, Integrations and Settings.

The **Wall** is the Tower's at-a-glance view, built for a TV or a second screen. It fits one 1920×1080 screen with nothing to scroll. Open it at `/wall` and lay it out at `/wall/edit`.

Both read the same data. The Tower is where you act; the Wall is where you glance.

## Unknown is never zero

NoticeOS never turns missing data into a zero.

When a collector fails, a provider is late, or a day is not yet final, the number stays **unknown** and the screen says so. A chart stops at the last reported hour instead of drawing a flat line at zero. A revenue estimate is labelled an estimate until it is reconciled.

For you this means two things. A zero on a card is a real zero that a source reported. And a gap on a card is a question to ask, not a loss to mourn. Open **System health** to see which collection fell behind and why.

## Who it is for

NoticeOS is for a founder or a small team running several websites or products who wants one honest desk instead of a tab per provider. It expects you to be comfortable with a terminal for installation and upkeep, and with a browser for everything else.

It is **not** a public hosted service. A standalone installation has no user login: anyone who can reach it can read and change its data. Keep it on a private network, behind a VPN, or behind an access proxy of your own.

## What you get today

- A **standalone installation** from source, with its own Postgres database and its own task database, started in one command. See [Install from source](/start/install-from-source).
- An **application container** for an installation you have already prepared. See [Run with Docker](/start/run-with-docker).
- A **public demo package** with synthetic sites and ongoing simulated activity, for a read-only preview on a Linux server. See [Try the demo](/start/try-the-demo).
- Provider credentials connected **in the product** on the Integrations page, encrypted in the store. See [Secrets and credentials](/operate/secrets-and-credentials).
- A **Tasks** page shared by people and agents, usable before you add your first site.

## What is not available yet

- NoticeOS does not offer **customer account hosting** or invitation-based onboarding in this preview release.
- NoticeOS does not have a supported **task API**, installable agent skills and hooks, or connections to tools such as Jira or Linear yet. Use the Tasks page.
- NoticeOS does not run **automated execution on your sites**. Agents that act on your sites are started and stopped by you, outside NoticeOS. See [Budgets and the kill switch](/operate/budgets-and-the-kill-switch).

## Where to go next

The first useful view is a site's Overview after one data source is connected. [Install in five minutes](/start/quickstart) takes you there; [Install from source](/start/install-from-source) explains what the start command creates.

For the design behind all of this, read the architecture note on GitHub: https://github.com/notice-cx/NoticeOS/blob/main/docs/01-architecture.md.
