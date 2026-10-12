---
title: "Tasks"
description: "The shared board of work across your projects: what is waiting for you, what is blocked, and how to file a task."
---

# Tasks

A **task** is one piece of work, for a site or for NoticeOS itself, with its status, owner, blockers and the evidence it was closed with. People and AI agents share the same tasks, each site in its own project. The **Tasks** page shows every project at once. How tasks connect to changes and outcomes is in [Tasks and agents](/concepts/tasks-and-agents).

The Tasks page shows how big the queue is, and which tasks in it cannot move forward without you.

## What you see

The page starts with a one-line summary: **No decisions for you**, or **3 decisions for you** with **1 needs your approval** and how many tasks are open under it. Three figures follow: **Urgent**, **Blocked** and **Closed this week**.

**Your decisions** is the queue: how many decisions are waiting, the oldest one's age, and one bar splitting them by age (under 7 days, 7–30, 30–60, over 60). Each decision is a row with its age drawn as a length and its buttons: **Approve** for a gate that blocks work until you approve it, **Answer** or **Dismiss** for a question. A row's caption names the project and, for a gate, **needs your approval**. Pressing the row opens its details in place. The queue ends with **That's everything waiting on you.**

**In and out** draws the last 14 days: tasks closed a day and tasks filed a day, each with a dashed line at its daily average, and one line stating whether more tasks were closed or filed over the days both were counted. Today is drawn hatched while it is still being counted.

**Work by project**, when the board shows more than one project, compares each project's week: done this week extending left, still open extending right, split into in progress, ready to start and blocked, with each project's high-priority count under its name.

**Epic** draws one epic's tasks as a graph: each task in its state (**Done**, **In progress**, **Ready**, **Waiting**, **Blocked**, **Needs attention**, **Parked**) and an arrow from each task to the task it blocks. An arrow from a blocked or parked task is drawn broken; an arrow from a decision of yours is labelled **needs attention**. The epic with the most blocked or parked tasks that block other tasks is shown first.

**Filters**: **Project** (**Every project** or one), **Status** (**Any status**, then **Open**, **In progress**, **Blocked**, **Parked**, **Closed this week**, each with its count), **Priority**, **Assignee** and a label. The filters narrow the list, not the charts above it.

**All tasks** is the table: **Id**, **Project**, **Age** and **State**. Each row opens its task page at `/tasks/<id>`, with the full description and the evidence attached when it was closed.

The board works on a new installation because it ships with its own NoticeOS project.

## What you can do

- **Approve** a gate from its row.
- **Answer** a question: the box opens on the row, you type **Your answer** and select **Send**. The answer text becomes the note.
- **Dismiss** a question you decline.
- Select a project's name in **Work by project** to narrow the list to it.
- Pick another epic from the list beside **Epic**; the choice is kept in the page's address. Select a task in the graph to open its page.
- **New task** opens the composer in place. It has fields for a **Title** (**What should be true when this is done**), a **Project**, a **Priority** and a **Type**, with optional **Parent epic**, **Labels**, a **Description** (**What, why with the numbers, where**) and **Done when** (**The proof that it is done**). **File task** files it.
- **File task** on a finding, from a site's Overview, opens the same composer prefilled from the finding; the finding then shows a link to the filed task.
- **Add a task project**, on a site's Tasks tab, opens **Settings** > **Task projects**.

## States and labels

- A figure shown as **—** means the board could not read that project; it is never a zero. The summary line then shows **Couldn't read your decisions**.
- A count shown as **12+** is a lower bound: the snapshot holds only the first items of each list.
- On a hosted view the board shows a **Read-only snapshot** banner: the rows are the last snapshot and the actions are off. **Filed a day** then shows **not in the saved snapshot**, and no epic graph is drawn, because the snapshot holds neither filing dates nor dependencies.
- A hatched day in **In and out** was not counted. It is never a zero.
- A site with no project of its own shows **No task project for this site** on its Tasks tab.

## Related guides

- [Connect a task project](/guides/connect-a-task-project)
- [Tasks and agents](/concepts/tasks-and-agents)
- [Home](/tower/home)
- How work is filed, verified and closed, in [doc 05, Execution, autonomy & accountability](../05-execution-and-accountability.md)
