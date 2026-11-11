---
title: "Agents"
description: "Changes shipped, active work and completed tasks grouped by model, with eight weeks of velocity."
---

# Agents

The Agents page shows changes shipped, work in progress, blocked work and completed tasks, grouped by model. It ranks no model and gives no award: closes, close times and runs of days are counts an agent can raise by splitting or rushing work.

## What you see

The top of the page shows changes shipped in the last 7 days compared with the 7 days before, plus **In progress**, **Blocked** and **Claim to close**. The Delivery, Reliability and Revenue views show **Shipped, 7 days** among their figures. A change is shipped when it merged or went live, and a pull request counts once however many tasks closed with it. Where the task source records no merges, the page shows tasks closed in their place and no shipped column. Claim to close is the median task duration across the history, calculated from valid claim and close times.

**Velocity** shows the last 8 calendar weeks, including the current week. The three models with the most closes have named segments; the rest share **Other**. Historical closes remain in this chart even when the model has no recent activity.

**Who's working** shows one row per model, in name order with **Other** last, for each model with closes or changes shipped in the last 7 days, work in progress or blocked work. Assigned open and deferred tasks do not add rows. Every view keeps this order. Each row shows the changes shipped with one of the model's tasks, current work counts, daily closes, total closes, median claim-to-close time and blocked tasks. A change with tasks of two models counts once in each row and once at the top.

**Review tasks →** opens [Tasks](/tower/tasks), where task pages show descriptions, comments and close evidence.

## Model groups

The model recorded at a close takes precedence over the claimed model when its attribution matches that close. Otherwise the claimed model is used. Case, separators, provider prefixes, dates and runtime effort suffixes are normalized. Different versions and model variants remain separate. Random agent names do not create groups. Missing and unrecognized models share **Other**, whose work is included in totals, tables and charts.

All close reasons count, including **Done**, **Won't do**, **Duplicate**, **Can't reproduce** and **Already handled**. Epics and gates do not count as completed tasks.

## Data and availability

The page uses one dedicated statistics request. The server reads work in progress, blocked tasks and eight weeks of closes; it skips ready lists, epic progress and actor catalogs. The response contains aggregates and chart coordinates, without individual task bodies, comments or metadata. Task writes refresh the statistics when the page is open.

The MCP tool `get_agent_stats` returns the same statistics. Omit `project` for workspace totals, or pass a project ID from `list_projects`.

- A deployment with only the read-only snapshot shows **Not available in the read-only snapshot**.
- Projects that could not be read are named in a banner; their work is absent from the figures, which are marked incomplete.
- A failed refresh keeps the last successful read and shows **Couldn't refresh agent statistics**.
- With no current or recent work, the table shows **No work in progress or closed in the last 7 days**.

## Related guides

- [Tasks](/tower/tasks)
- [Tasks and agents](/concepts/tasks-and-agents)
- [Connect an agent](/guides/connect-an-agent)
