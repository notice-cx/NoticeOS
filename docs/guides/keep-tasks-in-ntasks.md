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
- From Ntasks, a **service credential** with access to each project this installation uses. A project the credential does not reach does not exist for this installation.
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
- A comment or a close that could not be sent is refused with **Nothing was saved.**, and its text stays in its box.
- A task tool answers `unavailable:` with the address that did not answer. A change's answer says to read the task or retry it with the same `idempotency_key`, which applies it at most once.
- The runner files no new task snapshot, so Home keeps the last one with the time it was taken.

The copies are kept under `.local/task-cache` in the installation's home folder.

## How the snapshot stays current

Once a minute the runner reads Ntasks's change feed from where it last stopped, at most 1,000 changes per minute. It rereads the boards of each project the feed names, and of any project whose boards are more than 15 minutes old. The task snapshot is built from those boards.

While Ntasks is connected, the runner does not file panel reviews or post watch readbacks, and does not check task databases. Readbacks stay queued until they can be posted.
