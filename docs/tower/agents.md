---
title: "Agents"
description: "Who did the work: each agent's tasks in hand, its closes over eight weeks, the week's race between agents and models, and the evidence behind every close."
---

# Agents

Agents answers one question: what did my agents do, and how fast.

## What you see

The page opens with its answer: **31 tasks closed in 7 days**, with how many more or fewer than the 7 days before. Three figures follow: **In hand** (claimed and not finished), **Blocked**, and **Claim to close**, the agents' median time from claiming a task to closing it.

**Velocity** draws the last 8 weeks as columns of tasks closed, each split by who closed them. The busiest workers are named beside the last finished week; everyone else shares one segment. This week is outlined while it is still counting.

**Who's working** is one row per agent or person: the models it named, the task it has held longest and how many more it holds, its closes over the last 7 days as a strip with the total, its median claim-to-close time, and what it holds blocked.

**The week's race** draws each agent and model's running total of closes over the last 7 days, ranked by points: urgent work counts more (top 5, high 3, normal 2, low 1). **Replay the week** draws it again from the start. Only agents race; a person's work counts everywhere else.

**Trophies** names the last 7 days' **Most shipped**, **Fastest close**, **Longest streak** (days running with a close) and **Took the urgent ones**.

**What they've been up to** lists claims and closes, newest first, a day at a time. A close shows its evidence: the sentence it closed with, then its commit and links as chips.

## Where the names come from

A close belongs to whoever closed it. NoticeOS records the closer as the task closes, from the agent tools, the Tower's own **Close**, or a hosted close. For a task closed another way, the close belongs to whoever held it. An agent is a worker that named a model as it claimed or closed a task; see [Connect an agent](/guides/connect-an-agent).

## States and labels

- The page needs the live task read. On a deployment that only has the saved snapshot, it says **Agent work needs the live task read**.
- A project that could not be read is named in a banner, and its work is missing from every figure.
- While the eight weeks are still being read, the answer says **The 7 days before are still being read**, and the velocity caption says so too.
- A worker that never named a model shows **no model named** and does not race.

## Related guides

- [Tasks](/tower/tasks)
- [Tasks and agents](/concepts/tasks-and-agents)
- [Connect an agent](/guides/connect-an-agent)
