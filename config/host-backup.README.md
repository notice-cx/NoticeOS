# Host backup sources, destination and retention

`installation/host-backup.json` is this host's own backup setting;
`config/host-backup.json` is the product's default, read only when the
installation has none. Like the task repository links
([`task-host.README.md`](task-host.README.md)), it is read by Node services only
— the nightly backup in [`scripts/host-backup.mjs`](../scripts/host-backup.mjs) —
never seeded into `config_documents`, exported from the store, or compiled into
the deployed Tower.

Reader: the installation's backup operator. Update this document when source,
custody or restore interfaces change; retire it when this host adapter is removed.

```json
{
  "offsiteBackupDir": "/Users/you/Sync/Backups/noticeos",
  "retention": { "daily": 2, "weekly": 2 },
  "analyticalHistoryDirectory": null,
  "assetBackups": []
}
```

- **`offsiteBackupDir`** — an absolute folder that a sync client (Google Drive,
  Dropbox, iCloud Drive, a mounted network share) carries off the machine. After
  each night's set is finished under `.local/backups/<date>/`, it is copied to
  `<offsiteBackupDir>/<date>/`, and retention applies there too.
  `null` — the default — takes no offsite copy, and the backup's
  record says so (`Offsite handoff: not_configured`).
- The folder's **parent must already exist**. A sync mount that is missing
  fails the run rather than creating a local folder that only looks offsite.
- The file is read at every backup, so an edit applies at the next run without
  a restart. Unreadable or malformed settings fail by name. Store snapshots are
  still attempted, but unknown asset requirements prevent publication of a
  complete set. A valid settings file with an invalid offsite path fails only
  the handoff; a complete local set can still be published.

## Retention

`retention` keeps the latest `daily` complete dates and the first complete set
from each of the latest `weekly` UTC Monday weeks. With two of each, up to
four ordinary dated sets remain; a weekly anchor that is also daily occupies one folder.
Keeping the first set of each week preserves an older recovery point while
daily copies rotate. Missed days use the available successful copies. During
the initial week there cannot yet be a week-old copy. If missed days make the
prior week's anchor less than seven days old, an available older anchor stays
in that weekly slot until its replacement is at least seven days old.

Rotation covers the entire dated set: Postgres, R2, task hub, asset exports and
configured analytical history. Additional dates stay when they hold table files
that no normally retained, verified set covers. This also applies to the 30-day
policy and to replacing a same-day set. Disabling history or capturing a smaller
generation closure cannot remove its last verified backup. Damaged or incomplete
history custody blocks rotation; required coverage is derived from the existing
generation manifests once per candidate set.
It runs only after every configured source, publication and offsite handoff
succeeds. A failed run preserves older copies. Unrecognized folders, future
dates and manual folders are untouched. Existing generated `RESTORE.md` reports
identify legacy sets; new sets carry a `backup.json` completeness manifest.
Both earlier generated report formats are read regardless of the product name
in their title. Missing fields and unknown formats remain untouched; failed
stages and unequal copy counts never qualify as complete weekly anchors.
The earliest count-only reports omitted blob-copy failures. They remain
unverified and are preserved until an explicitly complete week-old set exists;
they never qualify as complete weekly anchors themselves.
An absent retention setting preserves the existing 30-day policy. Invalid
counts fail retention rather than silently selecting a different policy.

## Analytical history

`analyticalHistoryDirectory` declares a folder relative to the installation
directory, for example `"analytical-history"`. Omitted or `null` means no history
source. Native services and the container backup worker resolve it through the
same installation directory; the container's existing `/state` mount carries it.
Absolute paths, traversal and symlink components are refused. A declared missing,
empty, damaged or incomplete source fails the history stage and prevents complete
publication and rotation.

Capture pins every generation published at its start and every Parquet file
those manifests reference, including held-table datasets. A newer immutable
generation may appear during capture. Changes or removals of captured references
fail verification. `history/` preserves the generation bytes, schemas, derivations,
row fingerprints and Parquet files; `custody.json` records their existing hashes.
The same closure is verified after the offsite copy. A byte mismatch fails the
handoff and preserves the previous offsite set even if the local set was published.

Restore the complete `history/` folder independently of the operational dump.
`verifyAnalyticalHistoryBackup` in `scripts/analytical-history-backup.mjs` checks
its manifest closure and every file before the existing DuckDB history readers
open it. The generated `RESTORE.md` names this check. Held-table restore tests
recover rows and fingerprints after the original history folder is removed.
Backup completeness alone is never permission to delete operational rows:
deletion also needs the approved export and readback contract. This backup path
performs no operational or analytical source deletion.

## Asset production exports

`assetBackups` is an explicit host inventory, independent of task-project
membership. It defaults to none. Adding a repository to the task hub does not
authorize production database access. Each entry has:

- `asset`: unique name used for `assets/<asset>/` inside the dated set.
- `repo`: checkout path, absolute or relative to the host checkout.
- `scriptSha256`: SHA-256 of the exact `scripts["backup:prod"]` string in the
  asset's `package.json`. A changed task fails before it runs; review the change
  before approving and updating the fingerprint.
- `args`: explicit arguments appended to `npm --ignore-scripts run backup:prod --`.
  A reviewed Wrangler D1 export uses `["--skip-confirmation"]` for unattended
  execution. Npm pre/post lifecycle hooks are disabled.

The task must honor the absolute `BACKUP_OUTPUT_DIR` environment variable,
finish within 30 minutes and write nonempty `.sql` files directly into that
directory. The host supplies a separate private temporary folder per attempt.
A nonzero exit, missing output, empty file, symlink or compression failure
fails that asset while other sources are still attempted. SQL is streamed
through gzip into `assets/<asset>/<filename>.sql.gz`; the temporary folder is
then removed, including failed partial exports. The asset's usual backup folder
is never scanned or cleaned, so concurrent manual exports remain untouched.
Raw SQL needs temporary disk space during export but does not accumulate nightly.

Wrangler exports plain SQL; a `.gz` filename alone does not compress it.
Its remote export can make the database unavailable to serve queries while
exporting ([Cloudflare documentation](https://developers.cloudflare.com/d1/best-practices/import-export-data/)).
Review that impact, the exact production database, task, arguments, destination,
recurrence and deletion scope before enabling a source. Production activation
requires the owner's explicit approval under the repository's production rule.
Tests use scratch repositories and never run an installed asset's task.

Decision D10 in [`decisions.md`](decisions.md) is why the copy exists; the
backup operation, restore and the drill are in
[`scripts/README.md`](../scripts/README.md).
