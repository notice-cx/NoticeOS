# Database recovery proofs

NoticeOS supports Postgres only. The normal browser journeys use isolated
Postgres databases and synthetic records.

`scripts/host-backup-postgres.test.mjs` seeds every operational table directly
on disposable Postgres, runs the real backup helper, restores into an empty
independent cluster, compares records and schema, resolves the copied R2
objects, and proves the restored application can read and write.

The D1 transition tools are not product commands or recurring tests; they
stay with the private installation's recovery archive, outside the public
release.

Routine backup recovery restores Postgres. Returning to a historical D1
snapshot after new Postgres writes requires a separately verified and approved
reverse transfer.
