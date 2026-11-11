---
title: "Connect a task project"
description: "Give an asset a task project in Ntasks, so its tasks show on the Tasks pages and in the task snapshot."
---

# Connect a task project

A task project holds one asset's tasks in [Ntasks](/guides/keep-tasks-in-ntasks). An asset maps to the Ntasks project with its task prefix. The **Tasks** pages, the runner's task snapshot and the reviews the runner files all use that mapping. A project needs no code checkout and no task files inside one.

A project has two names: the asset's asset id and its task prefix, such as `example.com` and `ex`. Every task id in the project starts with the prefix, such as `ex-1w2`.

## Before you begin

- Add the asset in NoticeOS. See [Add your first asset](/guides/add-your-first-site).
- Connect Ntasks in **Settings** > **Task projects**. See [Keep tasks in Ntasks](/guides/keep-tasks-in-ntasks).

A fresh installation includes the System's task project.

## Make the project in Ntasks

1. In Ntasks, make a project with the asset's task prefix.
2. In Ntasks, make a new service credential that reaches every project this installation uses, the new one included, with the backup choice. Ntasks fixes a credential's projects when it is made, so the credential the installation holds does not reach a project made after it.
3. In **Settings** > **Task projects**, choose **Manage** beside **Ntasks** and replace the credential with the new one.

## Save the project

In **Settings** > **Task projects**, add a row with the asset's asset id and task prefix. A prefix has two to eight lowercase letters, and no two projects share one. The **Database** field takes the prefix by default; Ntasks does not use it.

The row's **Ntasks project** column shows the Ntasks project with that prefix. **No project with this prefix** means the credential reaches no project with that prefix.

Settings saves the register in the configuration store. Exports are copies for backup and review; editing an exported file does not change the running connection.

## Optional project instructions

A checkout may contain an instruction pointer to the installation's MCP task guide. From a NoticeOS source checkout, preview it with:

```sh
pnpm project:prepare -- --repo /absolute/project-checkout --check
```

Review the proposed instructions, then use `--write` to apply them. The command writes a marked section in `AGENTS.md` and in `CLAUDE.md` when that file already exists. It preserves existing project instructions and stops on conflicting task rules or tracked task connection files.

Preparation contacts no provider or task service. It creates no task files or task-related ignore entries. The pointer uses the MCP guide and contains no dependency on the NoticeOS source checkout's location.

Add the project's goal, architecture, verification commands, protected operations and dated state following the [asset context mapping](../09-onboarding-a-site.md#agentsmd-mapping-before-a-builder-touches-the-asset). Commit instructions under that repository's own Git policy.

## Verify the connection

- On **Tasks**, select the project and read its tasks. A new project has no tasks.
- An agent connected to Ntasks's MCP endpoint lists the project with `list_projects`.
- The next task snapshot and review filing use the project. A review waits until its collection's required report families are published and references the published panel version.
- The project's checkout gains no task files.

Use isolated fixtures to test create, claim and close operations. Never file a test task on a live board to prove setup. Production reads and writes retain their existing approval requirements; connecting a project grants no deployment permission.

## If the project is not found

- **No project with this prefix**: make a new credential in Ntasks that also reaches the project and replace the old one with **Manage**, or correct the row's **Task prefix**.
- **Ntasks is not answering** on the **Tasks** pages: they show the copy Ntasks last gave; see [While Ntasks does not answer](/guides/keep-tasks-in-ntasks#while-ntasks-does-not-answer).

## Next steps

- [Connect an agent](/guides/connect-an-agent)
- [Tasks](/tower/tasks)
- [Tasks and agents](/concepts/tasks-and-agents)
