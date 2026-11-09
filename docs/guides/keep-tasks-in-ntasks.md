---
title: "Keep tasks in Ntasks"
description: "Connect an Ntasks task hub so the Tasks pages and the runner read and change tasks there, and connect agents to Ntasks directly."
---

# Keep tasks in Ntasks

[Ntasks](https://github.com/notice-cx/Ntasks) is a task hub that runs as a Cloudflare Worker. When an installation is connected to one, Ntasks holds its tasks. The installation reads and changes them there:

- the **Tasks** pages;
- the runner's task snapshot, which the Home and the TV dashboard show, and the reviews and comments the runner files.

Agents read and change the tasks through Ntasks's own MCP endpoint ([below](#agents)). Nothing reads or changes the local task database while Ntasks is connected. Ntasks is connected on standalone installations only.

## Before you begin

- The installation's tasks are in Ntasks: imported from the task database, or filed there.
- From Ntasks, a **service credential** made after the tasks are loaded, with access to each project this installation uses and the backup choice (`"backup": true`), which the nightly backup needs to read the whole store. Ntasks fixes a credential's projects and choices when it is made. A project the credential does not reach does not exist for this installation, and a site added later needs a new credential that also reaches its project.
- The address Ntasks answers at. HTTPS is required, except for a local address such as `http://host.docker.internal:8787`.

## Connect

1. In **Settings** > **Task projects**, choose **Connect** beside **Ntasks**.
2. Enter the **Ntasks address** and the **Service credential**, then choose **Connect**. The credential is kept only when Ntasks accepts it and it was made with the backup choice; without that choice the panel shows **Credential cannot read backups · Make one with "backup": true**. The panel then shows how many projects the credential reaches.
3. In **Projects**, each row's **Ntasks project** column shows the Ntasks project that holds that site's tasks. A site maps to the Ntasks project with the same task prefix. **No project with this prefix** means the credential reaches no project with that prefix: make a new credential in Ntasks that also reaches that project and replace the old one with **Manage**, or correct the row's **Task prefix**.

The credential is kept encrypted in the installation's store, like every other connection on **Integrations**, and only the ingest Worker opens it. **Manage** replaces or disconnects it. Disconnecting returns the installation to its local task database.

## Agents

While Ntasks holds the tasks, NoticeOS's MCP server (`pnpm os:mcp` and the Tower's `/api/mcp`) lists no task tools. Agents connect to Ntasks's MCP endpoint, the Ntasks address followed by `/api/mcp`, and use its task tools and its `get_task_guide`. For Claude Code:

```sh
claude mcp add --scope user --transport http ntasks https://ntasks.example.com/api/mcp
```

On first use, Ntasks asks a person to allow the agent. NoticeOS's server keeps its asset report, panel and journey tools; its instructions and its `get_task_guide` name the Ntasks endpoint, and a task tool an agent listed before the switch is refused with the same address. When Ntasks is disconnected, the task tools are listed again.

## Who Ntasks records

The Tower and the runner make their changes through the installation's one credential. Each request names who it is for, and Ntasks records the change as `service:<credential name>/<name>`: a change made on the Tower's pages is recorded as `service:noticeos/tower`. An agent connected to Ntasks is recorded under its own Ntasks sign-in.

## Decisions and approvals

Ntasks takes an answer, a choice, a dismissal, an approval or a dispute only from a person signed in to Ntasks, never from the installation's credential. While tasks live in Ntasks, each decision on the **Tasks** pages shows **Decide in Ntasks** in place of its buttons, and an approval that can be disputed shows **Dispute in Ntasks**. Each opens the task's page in Ntasks in a new tab. The decisions queue offers no **Select**, and on **All tasks** a task waiting on a person has no **Close as**. A decision sent from a page opened before the switch is refused with Ntasks's own sentence, which names where to answer it.

## While Ntasks does not answer

- The **Tasks** pages show the copy Ntasks last gave, with **Ntasks is not answering** and the time it was read. They offer no actions until it answers.
- A comment or a close that could not be sent keeps its text in its box. When Ntasks did not answer, the refusal ends with **Nothing was saved.** When Ntasks did not answer in time, it ends with **The change may have landed; reload before sending it again.** instead, because the change may have been saved.
- A change Ntasks answers but does not offer yet is refused with **Ntasks does not accept this change yet, so nothing was saved.**
- While the installation's ingest has not said where its tasks live, a change is refused and the runner files no task snapshot.
- The runner files no new task snapshot, so Home keeps the last one with the time it was taken.

The copies are kept under `.local/task-cache` in the installation's home folder.

## The nightly backup

While Ntasks is connected, the nightly backup and `pnpm os:backup` read Ntasks's whole store through its backup route and keep it in the backup set as `ntasks/backup.json`. The set's `RESTORE.md` and the backup report list the rows of each table. The local task database is not backed up.

The backup is incomplete, with its **Task hub** part failed, when:

- Ntasks does not answer;
- the credential was not made with the backup choice;
- Ntasks was written to during each of three reads of the store. Run `pnpm os:backup` again when agents are quiet.

The backup's line in the runner's log, and its record on the Tower, name the reason.

To restore, use an Ntasks checkout of the version the backup was taken from: `node tools/migrate/src/cli.ts restore --from ntasks/backup.json --store restored.sqlite` loads the file into a new store copy and compares the two.

## How the snapshot stays current

Once a minute the runner reads Ntasks's change feed from where it last stopped, at most 1,000 changes per minute. It rereads the boards of each project the feed names, and of any project whose boards are more than 15 minutes old, together with every task of that project carrying a handoff or panel-review label, closed at any time. The task snapshot is built from those reads, so a finding card shows its task and a site shows its panel triage. Where Ntasks does not answer the label read, the card shows the task as not asked.

While Ntasks is connected, the runner files panel reviews and outcome reviews in Ntasks and posts each outcome's result as a comment there, recorded as `service:<credential name>/os-up-panel-filer`, `/outcome-review-filer` and `/outcome-task-updates`. A panel review filed there carries its due date, so the connected Ntasks must take `dueAt` on a new task; one that does not refuses the filing, and the runner logs the refusal. The runner does not check task databases, which Ntasks does not have. While the installation's ingest has not said where its tasks live, the runner files nothing and results stay queued.
