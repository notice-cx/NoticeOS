---
title: "Connect a task project"
description: "Give a site its own shared task list so people and agents work from one board, with the commands the product hands you."
---

# Connect a task project

This page gets a site's own task list onto the shared **Tasks** board and tells you what each step the product hands you does.

## Before you begin

NoticeOS keeps one shared task database for the whole installation. Every project you connect gets its own list inside it, identified by a short prefix. People and agents working in that project's code repository read and update the same tasks you see on the **Tasks** page, so status, owners, blockers and approvals live in one place.

A new installation already includes a NoticeOS task project, so **Tasks** works before you add a website. The board opens with its answer, **Nothing waits on you**, three figures (**Urgent**, **Blocked**, **Closed this week**), the filters **Project** and **Status**, and **New task**. See [Tasks](/tower/tasks) for the board itself.

You need:

- The site added in NoticeOS. See [Add your first site](/guides/add-your-first-site).
- A clean checkout of the project's code repository, on the machine that holds the task database.
- The task database answering: **Settings** > **Task projects** reads **Available**.

On a hosted installation the section carries a **Read-only here** chip and the list cannot be edited, because the commands have to run on the machine that holds the task database.

## Add the project in Settings

1. Open **Settings** and select **Task projects**.
2. Read the **Task database** line. It should say **Available** with a project count. **Unavailable** or **Stale** means the task database is not answering; fix that first.
3. In the **Projects** table, select **Add** and fill in three cells:
   - **Site**: the site from the list. Only sites with no project yet are offered.
   - **Prefix**: two to eight lowercase letters, such as `ex`. Every task id in the project starts with it.
   - **Database**: a name starting with a lowercase letter, using lowercase letters, digits or underscores, such as `ex_tasks`.
4. Save the row. It is saved at once, with **Undo**, and a checklist opens under the table, headed **example.com is mapped — four steps left**.

Saving the row only records the mapping. The database itself does not exist yet, and the code repository does not know about it. The checklist is how the product says so.

## Run the steps the product hands you

Each step has a title and a block to copy, labelled with where it goes.

1. **Initialize a new task database**: select **Copy**, then run the command in a terminal inside the project's checkout. It creates the project's list in the shared database and connects the checkout to it. It refuses an existing database and a dirty checkout.
2. **Keep it on the shared database**: copy the two lines, shown as a diff, into the file `.beads/config.yaml` in the checkout. They stop the checkout from pushing its tasks anywhere else or importing stale copies. This step is only shown when the first command did not already do it.
3. **Prepare project instructions**: select **Copy**, then run the command in a terminal inside the checkout.
4. **Link the checkout here**: copy the JSON entry into the installation's `task-host.json` file under `repositories`, replacing `/path/to/checkout` with the real path. This is what lets the product read that checkout's tasks and keep them backed up.
5. Select **Done** to close the checklist.

### What the project instructions step does

**Prepare project instructions** writes a marked NoticeOS section into the project's `AGENTS.md`, and into `CLAUDE.md` when that file already exists. The section carries the task rules an agent working in that repository must follow and links back to your NoticeOS checkout. It preserves the project's existing instructions, excludes the task connection files from Git, and refuses to replace conflicting task instructions, which you then review by hand.

It contacts no provider and no database. Review the resulting diff and commit the instructions under the project's own Git policy. Do not commit the task connection files or any credentials.

Connecting a project gives people and agents a shared list. It grants no agent any right to deploy or change the site. In this release, agent work remains manual.

## Verify

- From the project checkout, `bd ready` and `bd list` run without error. A new project correctly returns no tasks.
- On **Tasks**, the **Project** filter lists the site, and its rows carry the new prefix.
- On **Settings** > **Task projects**, the **Found** column stays blank for the row.

## If it didn't work

- The **Task database** line reads **Unavailable** or **Stale**: the task database is not answering. Start it, then come back.
- The **Found** column shows a warning dot, with **example.com is not being backed up** under the table: no database by that name exists. Select **Edit name** to fix the cell, or copy the **Keep** command to create it.
- **Initialize a new task database** refuses: the database already exists or the checkout is dirty. Commit or stash, then run it again.

More symptoms are in [Troubleshooting](/operate/troubleshooting). The full setup, including repository access and a relocated checkout, is in [Connect a project repository](connect-a-project.md); the task-project contract and conventions are at https://github.com/notice-cx/NoticeOS/blob/main/config/beads.README.md.

## Next steps

- [Tasks](/tower/tasks)
- [Tasks and agents](/concepts/tasks-and-agents)
- [Settings](/tower/settings)
