---
title: "Connect a task project"
description: "Connect an asset's task database to MCP and the shared Tasks board without a code checkout."
---

# Connect a task project

A task project connects an asset to its tasks in the installation's shared Dolt server. MCP, the native **Tasks** board, saved task snapshots and automatic review filing use the same connection. A project does not need a local code repository or a `.beads/` folder in its checkout.

The connection has three names: the asset's asset id, the task prefix and the database name. For example, `example.com`, `ex` and `ex_tasks` are distinct names. Moving the asset's code or assigning the project to another asset does not copy its tasks. The MCP project id is derived from the database and stays the same when its asset changes.

## Before you begin

- Add the asset in NoticeOS. See [Add your first asset](/guides/add-your-first-site).
- Have the installation administrator identify the existing task database and its prefix. Initializing a new database remains a separate, explicitly authorized setup operation; saving a project never initializes or migrates it.
- Keep the installation's declared task service and credential file configured. The connection uses that service; workspace settings cannot select a server or credential file.

A fresh installation includes the System's task project. An existing project's database and prefix must remain unchanged. Do not run `bd init` against it, import a JSONL export or copy a local database to reconnect it.

## Save the project

In **Settings** > **Task projects**, add the asset's asset id, prefix and database. Prefixes contain two to eight lowercase letters. Database names start with a lowercase letter and contain lowercase letters, digits or underscores. Prefixes and databases must be unique.

Settings saves the canonical project register in the configuration store. Exports are copies for backup and review; editing an exported file does not change the running connection.

The installation administrator also records the exact same three names in `installation/task-host.json`, under `repositories`:

```json
{
  "version": 1,
  "repositories": [
    {
      "asset": "example.com",
      "prefix": "ex",
      "database": "ex_tasks"
    }
  ]
}
```

Keep the existing entries. No `repo` field is required. Existing entries may retain a checkout path as optional metadata; task commands do not execute there. A saved project with no matching host entry remains unavailable. Changing a saved database or prefix requires a matching host binding before commands can run.

Backups read the host inventory independently of workspace settings. Keep retired database entries until an explicit retention decision authorizes removal. See the [host connection contract](../../config/task-host.README.md).

## How the connection runs

NoticeOS generates private client settings under the installation's `task-projects/` folder. The settings select the registered database and prefix, use server mode, disable automatic startup, imports, exports and Git operations, and contain no credentials. The declared task client supplies the service endpoint and credential file. Legacy native installations retain their loopback service defaults.

MCP, native task actions, snapshots and the review filer resolve this same installation-owned directory. No project checkout receives task metadata. Different database, prefix or endpoint bindings use different directories, so a command already running cannot follow a newly saved connection. No database is created as part of resolution.

When code moves, keep using MCP with the same project id. No connection files need to move with the code, and no project repository needs to be mounted into the NoticeOS application for task access.

## Optional project instructions

A checkout may contain an instruction pointer to the installation's MCP task guide. From a NoticeOS source checkout, preview it with:

```sh
pnpm project:prepare -- --repo /absolute/project-checkout --check
```

Review the proposed instructions, then use `--write` to apply them. The command writes a marked section in `AGENTS.md` and in `CLAUDE.md` when that file already exists. It preserves existing project instructions and stops on conflicting task rules or tracked task connection files.

Preparation contacts no provider or database. It creates no `.beads/` directory, gate lock or task-related ignore entries. Existing task connection files and ignore rules remain unchanged. The pointer uses the MCP guide and contains no dependency on the NoticeOS source checkout's location.

Add the project's goal, architecture, verification commands, protected operations and dated state following the [asset context mapping](../09-onboarding-a-site.md#agentsmd-mapping-before-a-builder-touches-the-asset). Commit instructions under that repository's own Git policy.

## Verify the connection

- Through the installation's MCP server, call `get_task_guide`, then `list_projects`. The project should appear with its registered prefix and database-derived project id.
- On **Tasks**, select the project and read its tasks. An initialized empty database correctly has no tasks.
- The next saved snapshot and automatic review filing use that same connection. A review waits until its collection's required report families are published and references the published panel version.
- A project checkout remains free of new task metadata.

Use isolated fixtures to test create, claim and close operations. Never file a test task on a live board to prove setup. Production reads and writes retain their existing approval requirements; connecting a project grants no deployment permission.

## If the connection is unavailable

A missing or mismatched host binding reports that the project has no matching task connection. Check the asset id, prefix and database in the saved register and host inventory. An unavailable configuration store stops execution instead of substituting an exported roster.

A failed task client reports an error or timeout. Check the declared service and credentials through the installation's supported status and recovery commands. Do not edit generated task client selectors, initialize an existing database or start a second server as a repair. Follow [task database recovery](../../db/dolt/host/README.md#backup-and-recovery).

## Next steps

- [Connect an agent](/guides/connect-an-agent)
- [Tasks](/tower/tasks)
- [Tasks and agents](/concepts/tasks-and-agents)
