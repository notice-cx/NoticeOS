---
title: "Tasks"
description: "The shared board of work across your projects: what waits on you, what is blocked, and how to file a task."
---

# Tasks

Tasks answers one question: how big is the queue, and what in it cannot move without me.

## What you see

The page opens with its answer: **Nothing waits on you**, or **3 decisions wait on you** with **1 needs your approval** and how many tasks are open under it. Three figures follow: **Urgent**, **Blocked** and **Closed this week**.

**Waiting on you** is the queue: how many decisions wait, the oldest one's age, and one bar splitting them by age (under 7 days, 7–30, 30–60, over 60). Each decision is a row with its age drawn as a length and its verb: **Approve** for a gate that holds work until you say yes, **Answer** or **Dismiss** for a question. A row's caption names the project and, for a gate, **needs your approval**. Pressing the row opens its details in place. The queue ends with **That's everything waiting on you.**

**In and out** draws the last 14 days: tasks closed a day and tasks filed a day, each with its daily average dashed across, and one line saying whether more was closed or filed over the days both were counted. Today is drawn hatched while it is still being counted.

**Work by project**, when the board shows more than one project, compares each project's week: done this week growing left, still open growing right, split into in progress, ready to start and blocked, with each project's high-priority count under its name.

**Epic** draws one epic's tasks as a graph: each task in its state (**Done**, **In progress**, **Ready**, **Waiting**, **Blocked**, **Needs you**, **Parked**) and an arrow from each task to the one it holds. An arrow from a blocked or parked task is drawn broken; an arrow from a decision of yours says **needs you**. The epic most stuck is shown first.

**Filters**: **Project** (**Every project** or one), **Status** (**Any status**, then **Open**, **In progress**, **Blocked**, **Parked**, **Closed this week**, each with its count), **Priority**, **Assignee** and a label. The filters narrow the list, not the pictures above it.

**All tasks** is the table: **Id**, **Project**, **Age** and **State**. Each row opens its task page at `/tasks/<id>`, with the full description and the evidence attached when it was closed.

The board works on a new installation because it ships with its own NoticeOS project.

## What you can do

- **Approve** a gate from its row.
- **Answer** a question: the box opens on the row, you type **Your answer** and select **Send**. The answer text becomes the note.
- **Dismiss** a question you decline.
- Select a project's name in **Work by project** to narrow the list to it.
- Pick another epic from the list beside **Epic**; the choice is kept in the page's address. Select a task in the graph to open its page.
- **New task** opens the composer in place. It asks for a **Title** (**What should be true when this is done**), a **Project**, a **Priority** and a **Type**, with optional **Parent epic**, **Labels**, a **Description** (**What, why with the numbers, where**) and **Done when** (**The proof that it is done**). **File task** files it.
- **File task** on a finding, from a site's Overview, opens the same composer prefilled from the finding; the finding then shows the link to the task it filed.
- **Add a task project**, on a site's Tasks tab, opens **Settings** > **Task projects**.

## States and labels

- A figure shown as **—** means the board could not read that project; it is never a zero. The answer line then reads **Couldn't read what waits on you**.
- A count shown as **12+** is bounded: the snapshot carries only the head of each list.
- On a hosted view the board carries a **Read-only snapshot** banner: the rows are the last snapshot and the actions are off. **Filed a day** then reads **not in the saved snapshot**, and no epic graph is drawn, because the snapshot carries neither filing dates nor dependencies.
- A hatched day in **In and out** was not counted. It is never a zero.
- A site with no project of its own shows **No task project for this site** on its Tasks tab.

## Related guides

- [Connect a task project](/guides/connect-a-task-project)
- [Tasks and agents](/concepts/tasks-and-agents)
- [Home](/tower/home)
- How work is filed, verified and closed, in [doc 05, Execution, autonomy & accountability](../05-execution-and-accountability.md)
