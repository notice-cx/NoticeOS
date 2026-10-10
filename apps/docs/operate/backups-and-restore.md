---
title: "Backups and restore"
description: "What the nightly backup captures, where it goes, how long it is kept, and how to rehearse a restore."
---

# Backups and restore

This page gets you a nightly backup to trust and a restore you have rehearsed before you need it.

## Before you begin

- An absolute offsite folder that a sync client (Google Drive, Dropbox, iCloud Drive, a mounted share) carries off the machine, with its parent already existing.
- The task database service running; task databases are backed up online.
- For a Compose stack, the separate backup worker from `deploy/compose/backup.compose.yaml`, with the same stages and retention. Its setup is on GitHub: https://github.com/notice-cx/NoticeOS/blob/main/deploy/compose/backup.README.md.

### What is backed up

One backup run captures every store of the installation into a dated folder, `.local/backups/<YYYY-MM-DD>/`:

| Part | What it holds |
| --- | --- |
| `postgres/noticeos.dump` | A `pg_dump` of the operational database, in custom format, mode 0600 |
| `r2/` | The raw provider archive: report files plus their index |
| `beads/` | Every task database, taken online from the running task service, with its permissions and recovery credentials under `beads/metadata/` |
| `assets/` and `cloudflare-d1/` | Production exports for sites you have explicitly approved |
| `RESTORE.md` | Generated instructions: what the set is, how each part went, how to restore it |
| `backup.json` | The completeness record, written last |

Each part is consistent on its own, not as one transaction across all of them. One part's failure never stops the others from being attempted, but only a complete set counts as a successful backup.

### When it runs

The macOS service takes a backup nightly at **04:00 UTC**. A `pnpm start` installation runs the backup job only once its own `installation/host-backup.json` (inside the start folder) names an offsite folder. Until then the job is listed but does not run.

## Set where it goes and how long it is kept

The backup settings are the installation's `installation/host-backup.json`. The product default names no offsite folder.

1. In `installation/host-backup.json`, set the offsite folder and the retention:

   ```json
   {
     "offsiteBackupDir": "/Users/you/Sync/Backups/noticeos",
     "retention": { "daily": 2, "weekly": 2 },
     "analyticalHistoryDirectory": null,
     "assetBackups": []
   }
   ```

2. Leave the service running. The file is read at every run; an edit applies at the next backup without a restart.

- `offsiteBackupDir` is the absolute folder the sync client carries off the machine. Each finished set is copied under `<offsiteBackupDir>/<date>/`. Its **parent must already exist**; a missing sync mount fails the run instead of creating a folder that only looks offsite. `null` means no offsite copy, and the record says so.
- `retention` keeps the latest `daily` complete sets and the first complete set of each of the latest `weekly` weeks, in both the local and offsite trees. Without it, sets older than 30 days are removed.

::: warning Retention waits for success
Old sets are removed only after every stage, including the offsite copy, succeeds. A failed run keeps everything it finds.
:::

## Change the time or run one now

1. Open **System health** > **Background operations** > **Backups** and select **Edit schedule** to change the time.
2. To run one now, in the checkout, run:

   ```sh
   pnpm os:backup
   ```

## Add site production exports

1. In `installation/host-backup.json`, list under `assetBackups` each repository whose own `backup:prod` script exports a production database into the set. Each entry pins the script's hash, so a changed script fails before it runs.
2. For Cloudflare D1 databases, open **Integrations** > **Cloudflare**, connect the account and select the databases there instead.

Adding a repository to Tasks never authorizes a production export; only this file or that page does. Review the impact on the live database before enabling either.

## Rehearse a restore

Restore into **isolated stores first**, never over the live ones.

1. In the dated folder, open `RESTORE.md`. It names each part and how it went.
2. **Postgres:** prepare the roles and an empty owner-owned database, then restore the dump into it **without** applying migrations first. The exact steps are on GitHub: https://github.com/notice-cx/NoticeOS/blob/main/db/postgres/host/README.md#backup-and-restore.
3. **Raw archive:** restore `r2/` as one complete tree.
4. **Task databases:** restore into a new, empty task service. The helper refuses to overwrite an existing service or volume. Steps: https://github.com/notice-cx/NoticeOS/blob/main/db/dolt/host/README.md#backup-and-recovery.
5. Check row counts, ledger totals and archive references before you point an app at the restored stores.

Replacing the live stores is a separate operator decision: stop the service first (`pnpm os:stop` or `pnpm stack:stop`), restore, then start it again. A restore does not run migrations and a migration does not restore; keep the two steps apart.

For a demo installation, the procedure is a stopped backup of its four volumes; see [Try the demo](/start/try-the-demo).

## Verify

- The dated folder holds `backup.json`, written last, and `RESTORE.md` says how each part went.
- The finished set is copied under `<offsiteBackupDir>/<date>/`.
- **System health** > **Background operations** shows the backup job's latest result.

A complete set does not prove the offsite copy is synchronized or restorable; a completed offsite handoff proves the local copy was made, not that the sync client finished uploading. Only your rehearsal proves a restore. A backup never deletes any source rows; completeness is never permission to prune the store.

## If it didn't work

- The backup failed on **Offsite handoff**: the folder in `host-backup.json` has no existing parent; usually the sync mount is missing. Fix the mount. The local set is kept.
- The backup failed on **Task hub**: the task database service was not running. Start it and run `pnpm os:backup`.
- A concurrent attempt fails before copying: a backup does not run while another is in progress. Wait for it to finish.

More symptoms are in [Troubleshooting](/operate/troubleshooting). The operation's full contract is on GitHub: https://github.com/notice-cx/NoticeOS/blob/main/scripts/README.md#backups--restore and https://github.com/notice-cx/NoticeOS/blob/main/config/host-backup.README.md.

## Next steps

- [Scheduled jobs](/operate/scheduled-jobs)
- [Daily operations](/operate/daily-operations)
- [Upgrade](/start/upgrade)
