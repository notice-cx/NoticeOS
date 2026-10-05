# One-shot copied-installation rehearsal

`rehearse-copy.mjs` is a manual operator procedure. Automated tests supply only
synthetic backups and keys. It never discovers a backup or starts the managed
service. Its real-data use requires explicit approval for the named resources.

The source is an already isolated directory containing the completed D1
snapshot and sibling `r2/` archive. Selecting and copying the newest complete
installation backup is a separate approved read. Backup stores were captured
in sequence, not at one shared instant; archive-reference reconciliation is
the proof of consistency used here. Task-hub backups are not needed: Dolt
remains unchanged, and imported task snapshots are intentionally rebuildable.

Use a clean checkout at the exact 40-character release hash. Supply a new
output directory outside both the checkout and source copy, a fixed as-of date,
and four distinct owned loopback ports. The explicitly approved key JSON file
is read solely to extract `CREDENTIALS_KEY`; no operator token or provider
fallback is used. The key travels to the owned child over private IPC.

```sh
node apps/tower/e2e/rehearse-copy.mjs \
  --copy /private/tmp/approved-rehearsal/copy \
  --output /private/tmp/approved-rehearsal/evidence \
  --key-json /explicitly/approved/bootstrap-secrets.json \
  --as-of 2026-09-30 --release <exact-40-character-commit> \
  --postgres-port 5352 --server-port 5353 \
  --restore-postgres-port 5354 --restore-server-port 5355
```

The command creates its private output folder with mode `0700`. It applies
the frozen schema and imports only into its new owned Compose target, then
repeats the import before application writes and proves zero additional rows.
First and repeated import/credential reports are preserved separately.
`--history` is always supplied: retained operational rows are published to
Parquet and reconciled through DuckDB and the export register. This does not
claim to recompute provider panels from the private raw archive.

The guarded browser reads Settings and Integrations, changes the operator rate
by one, and uses Undo. All prior configuration values and audit rows must
remain; exactly two new audit rows record the reversible exercise. Imported
records, task counts, active-watch evidence and archive references are compared
by count and row fingerprints. Saved credential counts, fields, key generation
and timestamps are compared; repeating the authenticated transfer changes no
sealed rows. No reconnect or provider request is allowed.

After these deliberate writes, the command retains `post-write.dump`, restores
it into a second independently owned empty Postgres 17 target, and compares
every application/reference/migration table and view. It verifies restored
settings, stops both owned targets, and proves the source copy's bytes are
unchanged. The dump remains in the private output directory after cleanup.

`rehearsal.json` records the exact release/profile, durations, source hashes,
evidence paths and verdict. `signal-order.json` lists historical figures whose
winner changes with timestamp ordering. Import review items and changed figures
still require operator acceptance before a live switch. A refusal records its
phase without printing private inputs. It does not claim readiness.

The rollback cutoff is conservative: before copied-target application writes,
the original D1 snapshot can resume unchanged. Once new target writes exist,
preserve and recover Postgres. Returning those writes to D1 requires a separate
verified reverse transfer and approval. A dump preserved on disk is not an
automatic authorization to restore it into a live database.

Synthetic proof, on a clean committed checkout:

```sh
NOTICEOS_TEST_REHEARSAL_RUN=1 node --import ./scripts/script-tests-setup.mjs --test scripts/rehearsal-run.test.mjs
```
