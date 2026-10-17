---
title: "Agents"
description: "Who did the work: the tasks each agent holds, its closed tasks over eight weeks, the week's ranking of agents and models, and the evidence for every close."
---

# Agents

The Agents page shows what your agents did and how fast they closed tasks.

![The Agents page in the synthetic demo: tasks closed in seven days, eight weeks of velocity split by who closed the tasks, each worker with its models, and the week's ranking of agents and models.](../images/tower-agents.webp)

## What you see

The top of the page shows the number of tasks closed in the last 7 days, for example **31 tasks closed in 7 days**, and how many more or fewer than the 7 days before. Three figures follow: **In progress** (tasks claimed and not yet closed), **Blocked**, and **Claim to close**, the median time from claiming a task to closing it.

**Velocity** shows the last 8 weeks as columns of tasks closed, each column split by who closed the tasks. The workers with the most closed tasks are named beside the last complete week; all others share one segment. The current week is outlined until it ends.

**Who's working** has one row per agent or person: the models it named, the task it has held longest and how many more it holds, its closed tasks over the last 7 days as a strip with the total, its median time from claim to close, and how many of its tasks are blocked.

**Ranking** shows each agent and model's running total of closed tasks over the last 7 days, ranked by points: a top-priority task counts 5, high 3, normal 2, low and lowest 1. **Replay the week** draws the lines again from the start. Only agents are ranked; a person's closed tasks count in every other figure.

**Leaders** shows the last 7 days' **Most tasks closed**, **Fastest close**, **Most days in a row** (consecutive days with at least one close) and **Most urgent tasks closed**.

**Claims and closes** lists claims and closes, newest first, grouped by day. Each close shows its evidence: the reason given at the close, then its commit and links as chips.

Each name on the page has its maker's mark beside it: Claude for Anthropic's agents and models, the OpenAI mark for Codex and GPT models, and the Gemini mark for Gemini. The agent's own name decides first, then the models it named. A person, or an agent from another maker, shows the first letter of its name.

## Where the names come from

Every figure on the page counts only closes whose resolution is **Done**. A task closed as **Won't do**, **Duplicate**, **Can't reproduce** or **Already handled** is not counted, ranked or listed here; [Tasks](/tower/tasks) lists it.

A close is counted for whoever closed the task. NoticeOS records who closed a task when it is closed through the agent tools, the Tower's own **Close**, or a hosted workspace. A task closed any other way is counted for its assignee. An agent is a worker that named a model when it claimed or closed a task; see [Connect an agent](/guides/connect-an-agent).

## States and labels

- The page reads the task server directly. On a deployment that has only the read-only snapshot, it shows **Not available in the read-only snapshot**.
- A project that could not be read is named in a banner, and its tasks are missing from every figure.
- While the 8 weeks are still loading, the summary shows **Still loading the 7 days before**, and the **Velocity** caption shows **some projects still loading**.
- A worker that never named a model shows **no model named** and is not ranked.

## Related guides

- [Tasks](/tower/tasks)
- [Tasks and agents](/concepts/tasks-and-agents)
- [Connect an agent](/guides/connect-an-agent)
