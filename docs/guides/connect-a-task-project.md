---
title: "Connect a task project"
description: "Give a site's code repository its own task list on the shared board, so people and agents in that checkout work from the same tasks you see."
---

# Connect a task project

This page connects a site's code repository to the shared **Tasks** board, so people and agents working in that checkout read and update the tasks you see. Use it for a new project, or for an existing project whose checkout has moved.

## Before you begin

NoticeOS keeps one shared task database for the whole installation. Every project you connect gets its own list inside it, identified by a short prefix. Status, owners, blockers and approvals live in one place.

A new installation already includes a NoticeOS task project, so **Tasks** works before you add a website. See [Tasks](/tower/tasks) for the board itself.

You need:

- The site added in NoticeOS. See [Add your first site](/guides/add-your-first-site). Its site id, its task prefix and its task database are three different names; the examples below use `example.com`, `ex` and `ex_tasks`.
- A clean checkout of the project's code repository, on the machine that holds the task database, with no `.beads/` folder yet.
- The task tool `bd`, the native version named in [Install from source](/start/install-from-source). An agent's Docker `bd` wrapper cannot initialize a project.
- The task database answering: **Settings** > **Task projects** reads **Available**.

On a hosted installation the section carries a **Read-only here** chip and the list cannot be edited, because the commands have to run on the machine that holds the task database.

## Add the project in Settings

1. Open **Settings** and select **Task projects**.
2. Read the **Task database** line. It should say **Available** with a project count. **Unavailable** or **Stale** means the task database is not answering; fix that first.
3. In the **Projects** table, select **Add** and fill in three cells:
   - **Site**: the site from the list. Only sites with no project yet are offered.
   - **Prefix**: two to eight lowercase letters, such as `ex`. Every task id in the project starts with it. It must be unused.
   - **Database**: a name starting with a lowercase letter, using lowercase letters, digits or underscores, such as `ex_tasks`. It must be unused.
4. Save the row. It is saved at once, with **Undo**, and a checklist opens under the table, headed **example.com is mapped** with the number of steps left.

Saving the row only records the mapping. The database does not exist yet, the code repository does not know about it, and no agent has access. The checklist is how the product says so.

## Run the steps the product hands you

Each step has a title and a block to copy, labelled with where it goes.

1. **Initialize a new task database**: select **Copy**, then run the command in a terminal inside the project's checkout.
2. **Keep it on the shared database**: copy the two lines, shown as a diff, into `.beads/config.yaml` in the checkout. They stop the checkout from pushing its tasks anywhere else or importing stale copies. This step only appears when the first command does not already do it.
3. **Prepare project instructions**: select **Copy**, then run the command in a terminal inside the checkout.
4. **Link the checkout here**: copy the JSON entry into the installation's `task-host.json` under `repositories`, replacing `/path/to/checkout` with the real path.
5. Select **Done** to close the checklist.

### What initializing does

On a source installation the command runs the installation's own helper, `scripts/dolt-project.mjs`. It creates only the new database and connects the checkout to it. It keeps the repository's hooks and agent instructions, turns off automatic imports and Git operations, and refuses an existing database, a dirty checkout or an existing `.beads/` folder.

If it fails or you are unsure whether it finished, keep its files and the database as they are and recover deliberately. Do not retry with `bd init`. On an installation you did not just create, agree the exact new database with its owner before you run it.

### What the project instructions step does

**Prepare project instructions** writes a marked NoticeOS section into the project's `AGENTS.md`, and into `CLAUDE.md` when that file already exists. The section carries the [task rules](../../config/beads.README.md#the-spoke-stanza) an agent working in that repository follows, and links back to your NoticeOS checkout. It keeps the project's existing instructions, excludes `.beads/` and `.beads.gate.lock` from Git, and creates the private lock file. It refuses to replace conflicting task instructions, and it refuses when task connection files are already tracked; resolve either by hand.

It contacts no provider and no database. To see the proposed changes first, run it from the NoticeOS checkout with `--check`:

```sh
pnpm project:prepare -- --repo /absolute/project-checkout --check
```

Review the diff, then add the project's own goal, architecture, verification commands, protected operations and dated state, following [the site context mapping](../09-onboarding-a-site.md#agentsmd-mapping-before-a-builder-touches-the-site). Commit the instructions under the project's own Git policy. Never commit `.beads/` or any credential.

If the NoticeOS checkout moves later, the link in the marked section goes stale. Preparation refuses a changed section, so fix the link by hand.

### Where the checkout link goes

On a source installation the file is `<installation-folder>/installation/task-host.json`, shaped `{ "version": 1, "repositories": [...] }`. Keep the existing entries and use exactly the three names you saved:

```json
{
  "asset": "example.com",
  "prefix": "ex",
  "database": "ex_tasks",
  "repo": "/absolute/project-checkout"
}
```

On the prepared container, `repo` is the container path, such as `/spokes/example`, and the container's own Compose configuration mounts the host checkout there. Changing mounts and restarting the container are host-administrator steps. The [host-link contract](../../config/task-host.README.md) and the [container guide](../../deploy/compose/README.md) hold the details.

This link is what lets the product read the checkout's tasks, run local task actions in it and keep them backed up.

## Work from the checkout

People and agents use `bd` in the project checkout. On a source installation, point it at the installation's credential file first:

```sh
export BEADS_CREDENTIALS_FILE=/absolute/noticeos-installation/dolt/credentials
export BEADS_DOLT_AUTO_START=0
bd ready
bd list
```

Keep the credential file private. Never paste its contents into source or a command.

An agent that runs `bd` through the Docker adapter needs the exact host checkout allowed in the adapter's `spokes` list; see the [bundled client declaration](../../db/dolt/host/README.md#native-capture-and-agent-compatibility). Keep its image, network, credentials and other project paths as they are.

Connecting a project gives people and agents a shared list. It grants no agent any right to deploy or change the site. In this release, agent work remains manual.

## A project that already has tasks

Do not run **Initialize a new task database** and do not run `bd init`. Find the project's original service, database, prefix and project identity, and save the row with those exact names. Restore only the connection settings into a new private `.beads/` folder and its `config.yaml`; never import an old JSONL export or copy a local task database into it. The steps are in [Moving a maintainer checkout](../../config/beads.README.md#moving-a-maintainer-checkout).

Moving a project between two different task hubs is a migration, not setup. Keep the old hub in charge until that migration has its own evidence and approval.

## Verify

- From the project checkout, `bd ready` and `bd list` run without error. A new project correctly returns no tasks; an existing one returns its known tasks with their original prefix.
- On **Tasks**, the **Project** filter lists the site, and its rows carry the prefix.
- On **Settings** > **Task projects**, the **Found** column stays blank for the row.
- In the project repository, the instructions are committed and `.beads/` is untracked.

To check an installation you did not just create, ask its owner first, and never file a test task in a live board to prove the setup.

## If it didn't work

- The **Task database** line reads **Unavailable** or **Stale**: the task database is not answering. Start it, then come back.
- The **Found** column shows a warning dot, with **example.com is not being backed up** under the table: no database by that name exists. Select **Edit name** to fix the cell, or copy the **Keep** command to create it.
- **Initialize a new task database** refuses: the database already exists, the checkout is dirty or it already has `.beads/`. Commit or stash, or follow [A project that already has tasks](#a-project-that-already-has-tasks).
- **Tasks** says **1 project could not be read** and names the site: point at the name to read the reason, then check the `task-host.json` entry and, on the container, its mount.
- `bd` refuses in the checkout: check the credential file, or the Docker adapter's `spokes` list.

Never start a second task database server, use `br`, or run `bd dolt push` or `bd dolt pull` as a repair. Follow the installation's [task database recovery](../../db/dolt/host/README.md#backup-and-recovery). More symptoms are in [Troubleshooting](/operate/troubleshooting).

## Next steps

- [Connect data sources](/guides/connect-data-sources)
- [Tasks](/tower/tasks)
- [Tasks and agents](/concepts/tasks-and-agents)
