---
title: "Tasks"
description: "The shared board of work across your projects: what waits on you, what is blocked, and how to file a task."
---

# Tasks

Tasks answers one question: how big is the queue, and what in it cannot move without me.

## What you see

The page opens with its answer: **Nothing waits on you**, or **3 decisions wait on you** with **1 needs your approval** under it. Three figures follow: **Urgent**, **Blocked** and **Closed this week**.

**Waiting on you** lists each decision as a row with its verb: **Approve** for a gate that holds work until you say yes, **Answer** or **Dismiss** for a question. A row's caption names the project and, for a gate, **needs your approval**. The list ends with **That's everything waiting on you.**

**Filters**: **Project** (**Every project** or one), **Status** (**Any status**, then **Open**, **In progress**, **Blocked**, **Parked**, **Closed this week**, each with its count) and a label.

**All tasks** is the table: **Id**, **Project**, **Age** and **State**. Each row opens its task page at `/tasks/<id>`, with the full description and the evidence attached when it was closed.

The board works on a new installation because it ships with its own NoticeOS project.

## What you can do

- **Approve** a gate from its row.
- **Answer** a question: the box opens on the row, you type **Your answer** and select **Send**. The answer text becomes the note.
- **Dismiss** a question you decline.
- **New task** opens the composer in place. It asks for a **Title** (**What should be true when this is done**), a **Project**, a **Priority** and a **Type**, with optional **Parent epic**, **Labels**, a **Description** (**What, why with the numbers, where**) and **Done when** (**The proof that it is done**). **File task** files it.
- **File task** on a finding, from a site's Overview, opens the same composer prefilled from the finding; the finding then shows the link to the task it filed.
- **Add a task project**, on a site's Tasks tab, opens **Settings** > **Task projects**.

## States and labels

- A figure shown as **—** means the board could not read that project; it is never a zero. The answer line then reads **Couldn't read what waits on you**.
- A count shown as **12+** is bounded: the snapshot carries only the head of each list.
- On a hosted view the board carries a **Read-only snapshot** banner: the rows are the last snapshot and the actions are off.
- A site with no project of its own shows **No task project for this site** on its Tasks tab.

## Related guides

- [Connect a task project](/guides/connect-a-task-project)
- [Tasks and agents](/concepts/tasks-and-agents)
- [Home](/tower/home)
- How work is filed, verified and closed, on GitHub: https://github.com/notice-cx/NoticeOS/blob/main/docs/05-execution-and-accountability.md
