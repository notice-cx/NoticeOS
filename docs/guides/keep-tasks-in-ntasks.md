---
title: "Keep tasks in Ntasks"
description: "Connect an Ntasks task hub so the task tools, the Tasks pages and the runner read and change tasks there."
---

# Keep tasks in Ntasks

[Ntasks](https://github.com/notice-cx/Ntasks) is a task hub that runs as a Cloudflare Worker. When an installation is connected to one, Ntasks holds its tasks. The installation reads and changes them there:

- the task tools agents call through `pnpm os:mcp` or the Tower's `/api/mcp`;
- the **Tasks** pages;
- the runner's task snapshot, which the Home and the TV dashboard show.

Nothing reads or changes the local task database while Ntasks is connected. Ntasks is connected on standalone installations only.

## Before you begin

- The installation's tasks are in Ntasks: imported from the task database, or filed there.
- From Ntasks, a **service credential** with access to each project this installation uses, made with the backup choice (`"backup": true`) so the nightly backup can read the whole store. A project the credential does not reach does not exist for this installation.
- The address Ntasks answers at. HTTPS is required, except for a local address such as `http://host.docker.internal:8787`.

## Connect

1. In **Settings** > **Task projects**, choose **Connect** beside **Ntasks**.
2. Enter the **Ntasks address** and the **Service credential**, then choose **Connect**. Ntasks must accept the credential before it is kept. The panel then shows how many projects the credential reaches.
3. In **Projects**, each row's **Ntasks project** column shows the Ntasks project that holds that site's tasks. A site maps to the Ntasks project with the same task prefix. **No project with this prefix** means the credential reaches no project with that prefix: give the credential that project in Ntasks, or correct the row's **Task prefix**.

The credential is kept encrypted in the installation's store, like every other connection on **Integrations**, and only the ingest Worker opens it. **Manage** replaces or disconnects it. Disconnecting returns the installation to its local task database.

## Who Ntasks records

Every change goes through the installation's one credential. Each request names who it is for, and Ntasks records the change as `service:<credential name>/<name>`:

- an agent's change is recorded under the name the agent was started with, such as `service:noticeos/claude` for `pnpm os:mcp -- --actor claude`;
- a change made on the Tower's pages is recorded as `service:noticeos/tower`.

## While Ntasks does not answer

- The **Tasks** pages show the copy Ntasks last gave, with **Ntasks is not answering** and the time it was read. They offer no actions until it answers.
- A comment or a close that could not be sent keeps its text in its box. When Ntasks did not answer, the refusal ends with **Nothing was saved.** When Ntasks did not answer in time, it ends with **The change may have landed; reload before sending it again.** instead, because the change may have been saved.
- A change Ntasks answers but does not offer yet is refused with **Ntasks does not accept this change yet, so nothing was saved.**
- While the installation's ingest has not said where its tasks live, a change is refused and the runner files no task snapshot.
- A task tool answers `unavailable:` with the address that did not answer. A change's answer says to read the task, or to retry it with the same `idempotency_key`, which applies it at most once; `add_dependency`, `remove_dependency` and `request_human_approval` take no key, so their answer says to read the task before retrying.
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

While Ntasks is connected, the runner files panel reviews and outcome reviews in Ntasks and posts each outcome's result as a comment there, recorded as `service:<credential name>/os-up-panel-filer`, `/outcome-review-filer` and `/outcome-task-updates`. A panel review filed there has no due date, because Ntasks takes none on a new task. The runner does not check task databases, which Ntasks does not have. While the installation's ingest has not said where its tasks live, the runner files nothing and results stay queued.
