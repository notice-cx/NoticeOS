# Database recovery proofs

NoticeOS supports Postgres only. The normal browser journeys use isolated
Postgres databases and synthetic records.

`scripts/host-backup-postgres.test.mjs` seeds every operational table directly
on disposable Postgres, runs the real backup helper, restores into an empty
independent cluster, compares records and schema, resolves the copied R2
objects, and proves the restored application can read and write.

The one-time D1 transition rehearsal was completed before the cutover
(`ro-ujb9.76.9`, `ro-ujb9.76.10`). Its exact tools and proof remain in the
private frozen cutover source at release
`a85e82837411729bc15b5cf1c2feacc7de209083`. They are no longer product commands
or recurring tests. The archive is described by
`installation/recovery/d1-cutover/README.md` in the private installation;
it is not part of the public release.

Routine backup recovery restores Postgres. Returning to a historical D1
snapshot after new Postgres writes requires a separately verified and approved
reverse transfer.
