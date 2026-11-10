---
title: "Tasks"
description: "The Ntasks web app inside the Tower: the board, each task's page and your decisions, as the person signed in to Ntasks."
---

# Tasks

A **task** is one piece of work, for an asset or for the **System** (this installation's own NoticeOS), with its status, owner, blockers and the evidence it was closed with. People and AI agents share the same tasks in [Ntasks](https://github.com/notice-cx/Ntasks), each asset in its own project. How tasks connect to changes and outcomes is in [Tasks and agents](/concepts/tasks-and-agents).

The **Tasks** page is the Ntasks web app itself, drawn inside the Tower from the published [`@notice-cx/ntasks-ui`](https://github.com/notice-cx/Ntasks/tree/main/packages/ui#readme) package. It reads and writes the installation's Ntasks as the person signed in to Ntasks in this browser, so every approval, answer and pick is recorded under that person's name.

## What you see

Every page of the Ntasks app sits under `/tasks`:

| Address | Shows |
|---|---|
| `/tasks` | The board: what waits for you first, then every task by status. `?view=waiting`, `?view=active`, `?project=<project>` and the other filters are part of the address. |
| `/tasks/<id>` | One task, such as `/tasks/ex-a1b2`: its description, a decision's options, Done when, links, activity and its facts. |
| `/tasks/focus` | Your decisions one at a time. |
| `/tasks/live` | Every task in progress, by its holder's last activity. |
| `/tasks/projects`, `/tasks/members`, `/tasks/settings` | The workspace's projects, members and settings. |

The Tower's sidebar stays beside the page. The Ntasks app's own navigation (Waiting for you, Live, Focus, each project and person, Projects, Members, Settings and the source-code link) opens from the **Sidebar** button at the start of each page's top bar. Ntasks's own README describes each page ([Pages](https://github.com/notice-cx/Ntasks/tree/main/packages/ui#pages)).

`/work` and `/tasks/all`, older addresses, open the board with the same query.

An asset's **Tasks** tab shows how many open tasks its project has and how many wait on you, with **Decide**, which opens the board on that project's waiting tasks, and **Open in Tasks**, which opens the board on that project.

## Signing in

The first time the page is opened in a browser it shows **Sign in to see your tasks**. **Sign in** opens Ntasks's approval page, which names the Tower and the person it acts as; **Allow** returns to the page you started from, signed in. The sign-in is kept in this browser until you sign out or revoke it in Ntasks. The Tower's server keeps the installation's own credential, which reads counts for Home, the Wall and each asset's Tasks tab and which Ntasks never lets decide ([Keep tasks in Ntasks](/guides/keep-tasks-in-ntasks)).

While no Tower client ID is saved, **Sign in** opens **Settings** > **Task projects**, where it is set.

## States

- While this installation has no task service connected, the page shows **Connect Ntasks** with a link to **Settings** > **Task projects**.
- When the connected Ntasks is older than the Tower's task pages need, the page shows one sentence in place of them: **This Ntasks is older than the Tower's task pages need; update it.** When it no longer answers the version the pages read, it shows **This Ntasks no longer answers the Tower's task pages; update NoticeOS.**
- A Tower with no Ntasks of its own shows **No task projects available**, with **Manage task projects →**.
- An asset with no project of its own shows **No task project for this asset** on its Tasks tab, with **Add a task project**.

## Related guides

- [Keep tasks in Ntasks](/guides/keep-tasks-in-ntasks)
- [Connect a task project](/guides/connect-a-task-project)
- [Tasks and agents](/concepts/tasks-and-agents)
- [Home](/tower/home)
- How work is filed, verified and closed, in [doc 05, Execution, autonomy & accountability](../05-execution-and-accountability.md)
