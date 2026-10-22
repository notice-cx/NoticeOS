---
layout: home
title: NoticeOS documentation
description: Install, use and operate NoticeOS, a self-hosted app that shows traffic, revenue, costs, alerts and work for your websites and software products in one place.

hero:
  name: NoticeOS
  text: Your startup. In clear view.
  tagline: A self-hosted app that shows traffic, revenue, costs, alerts and work in one place, on your laptop, phone or TV.
  image:
    light: /notice-mark.svg
    dark: /notice-mark-light.svg
    alt: The Notice mark
  actions:
    - theme: brand
      text: Install in five minutes
      link: /start/quickstart
    - theme: alt
      text: What NoticeOS is
      link: /start/what-is-noticeos
    - theme: alt
      text: GitHub
      link: https://github.com/notice-cx/NoticeOS

features:
  - title: Know what needs attention
    details: Collection failures, unusual traffic and missing evidence are raised as alerts with a severity and a kind. Missing data stays unknown; it is never shown as zero.
    link: /tower/alerts
    linkText: Alerts
  - title: See what makes money
    details: Recorded revenue and costs side by side, with dates and coverage kept visible, per asset and for the whole portfolio.
    link: /tower/financials
    linkText: Money
  - title: Keep work moving
    details: One shared task board for you and your agents, with owners, blockers, approval gates and completion evidence across projects.
    link: /tower/tasks
    linkText: Tasks
  - title: Check what changed
    details: Shipping a change does not show that it worked. Open a measurement window, wait, and read what actually happened.
    link: /concepts/attribution-and-measurement
    linkText: Attribution
---

## How NoticeOS works

![Data sources on the left feed NoticeOS in the middle, which collects on a schedule, checks for unusual days, stores every row in Postgres and keeps one task database; the Tower, the Wall and coding agents read from it on the right.](./images/noticeos-how-it-works.svg)

Every reading is stored by asset and by day. A day a source has not reported stays unknown and is never counted as zero. [How NoticeOS works](/concepts/how-noticeos-thinks) describes the loop that uses these readings.
