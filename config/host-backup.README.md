# Host backup sources, destination and retention

`installation/host-backup.json` is this host's own backup setting;
`config/host-backup.json` is the product's default, read only when the
installation has none. Like the task repository links
([`task-host.README.md`](task-host.README.md)), it is read by Node services
only — the nightly backup in
[`scripts/host-backup.mjs`](../scripts/host-backup.mjs) — never seeded into
`config_documents`, exported from the store, or compiled into the deployed
Tower. The copy exists so a backup survives the host; the backup operation,
restore and the drill are in
[`scripts/README.md`](../scripts/README.md).

```json
{
  "offsiteBackupDir": "/Users/you/Sync/Backups/noticeos",
  "retention": { "daily": 2, "weekly": 2 },
  "analyticalHistoryDirectory": null,
  "assetBackups": []
}
```

The file is read at every backup, so an edit applies at the next run without
a restart. Unreadable or malformed settings fail by name; store snapshots are
still attempted, but a complete set is not published. A valid file with an
invalid offsite path fails only the handoff.

## Offsite copy

`offsiteBackupDir` is an absolute folder that a sync client (Google Drive,
Dropbox, iCloud Drive, a mounted network share) carries off the machine. After
each night's set is finished under `.local/backups/<date>/`, it is copied to
`<offsiteBackupDir>/<date>/`, and retention applies there too. `null` — the
default — takes no offsite copy, and the record says so
(`Offsite handoff: not_configured`). The folder's **parent must already
exist**: a missing sync mount fails the run rather than creating a local folder
that only looks offsite.

## Retention

`retention` keeps the latest `daily` complete dates and the first complete set
from each of the latest `weekly` UTC Monday weeks; a weekly anchor that is
also daily occupies one folder. Keeping the first set of each week preserves
an older recovery point while daily copies rotate. If missed days make the
prior week's anchor less than seven days old, an older anchor stays in that
slot until its replacement is at least seven days old. An absent retention
setting preserves the existing 30-day policy; invalid counts fail retention
rather than silently selecting a different policy.

Rotation covers the entire dated set — Postgres, R2, task hub, asset exports
and configured analytical history — and runs only after every configured
source, publication and offsite handoff succeeds; a failed run preserves older
copies. Additional dates stay when they hold table files that no normally
retained, verified set covers; damaged or incomplete history custody blocks
rotation. Unrecognized folders, future dates and manual folders are untouched.
New sets carry a `backup.json` completeness manifest; older sets are
identified by their generated `RESTORE.md`. The earliest count-only reports
omitted blob-copy failures, so they stay unverified and never qualify as
complete weekly anchors.

## Analytical history

`analyticalHistoryDirectory` declares a folder relative to the installation
directory (for example `"analytical-history"`); omitted or `null` means no
history source. Absolute paths, traversal and symlink components are refused.
A declared missing, empty, damaged or incomplete source fails the history
stage and prevents complete publication and rotation.

Capture pins every generation published at its start and every Parquet file
those manifests reference; changes or removals of captured references fail
verification. `history/` preserves the generation bytes, schemas, derivations,
row fingerprints and Parquet files, and `custody.json` records their hashes.
The same closure is verified after the offsite copy; a byte mismatch fails the
handoff and preserves the previous offsite set.

Restore the complete `history/` folder independently of the operational dump:
`verifyAnalyticalHistoryBackup` in `scripts/analytical-history-backup.mjs`
checks its manifest closure and every file before the DuckDB history readers
open it. Backup completeness alone is never permission to delete operational
rows; this backup path deletes no source.

## Asset production exports

For native Cloudflare D1 backups, connect the account and choose databases and
their assets in **Integrations → Cloudflare**; standalone and protected
Compose backups include those saved targets automatically. SQL is verified
and streamed into gzip under `cloudflare-d1/<account>/<database>/`, with
hashes and a REST import pointer in `receipt.json`. A missing bootstrap
credential, unavailable Worker, changed selection or failed target prevents
complete-set publication; only an explicitly disconnected account or empty
selection skips native capture. Setup, query-blocking impact and production
approval are in [doc 11](../docs/11-integrations.md#cloudflare-d1-backups).

`assetBackups` remains for legacy exporters: an explicit host inventory,
independent of task-project membership, defaulting to none — adding a
repository to the task hub does not authorize production database access. An
asset cannot be declared in both native D1 selections and this list. Each
entry has:

- `asset` — unique name used for `assets/<asset>/` inside the dated set.
- `repo` — checkout path, absolute or relative to the host checkout.
- `scriptSha256` — SHA-256 of the exact `scripts["backup:prod"]` string in the
  asset's `package.json`. A changed task fails before it runs; review the
  change before updating the fingerprint.
- `args` — explicit arguments appended to
  `npm --ignore-scripts run backup:prod --`. A reviewed Wrangler D1 export
  uses `["--skip-confirmation"]` for unattended execution.

The task must honor the absolute `BACKUP_OUTPUT_DIR` environment variable,
finish within 30 minutes and write nonempty `.sql` files directly into that
directory; the host supplies a private temporary folder per attempt and
streams the SQL through gzip into `assets/<asset>/<filename>.sql.gz`. A
nonzero exit, missing output, empty file, symlink or compression failure fails
that asset while other sources are still attempted. The asset's usual backup
folder is never scanned or cleaned.

Wrangler's remote export can make the database unavailable to serve queries
while exporting
([Cloudflare documentation](https://developers.cloudflare.com/d1/best-practices/import-export-data/)).
Review that impact, the exact production database, task, arguments,
destination, recurrence and deletion scope before enabling a source;
production activation requires the owner's explicit approval. Tests use
scratch repositories and never run an installed asset's task.
