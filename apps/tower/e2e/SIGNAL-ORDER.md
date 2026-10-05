# Signal timestamp ordering audit

The D1-to-Postgres conversion compares timestamps as instants. D1 compared
their stored text. Mixed spellings can therefore select a different observation
even though the import preserves every observation and value.

Run this read-only audit on the explicitly approved isolated backup copy,
before opening its UI. The output directory must already exist and be private.
The report must be a new file; it is created with mode `0600`.

```sh
node apps/tower/e2e/rehearsal-signal-order.mjs --copy /private/tmp/approved-copy/store.sqlite --report /private/tmp/approved-copy/signal-order.json
```

The command uses the importer's snapshot reader and timestamp conversion. It
reads no credentials, discovers no backup, and updates no source row. Its JSON
report binds the results to the source bytes with SHA-256. Standard output
contains only counts; the private report contains every changed winner's site,
integration, metric, day, run and observation IDs, timestamps and before/after
values. Identity changes that keep the same value are counted separately.

`noncanonicalFinishedAt` counts **all** runs whose timestamps differ from the
collector's `YYYY-MM-DDTHH:mm:ss.SSSZ` spelling, including failed and unused
runs. Malformed timestamps refuse the audit. Only successful runs contribute
winning observations; ties use the full signed 64-bit observation ID.

The comparison covers all successful source `(asset, integration, metric,
date)` groups. It deliberately applies no chart window, current-property
selection or import retention filter. Thus it exposes historical winner changes
without claiming that every changed group is currently displayed in a chart.
This report does not replace the importer's reconciliation or authorize a
private backup read, source correction, or live migration.

The synthetic proof runs without Postgres or provider access:

```sh
node --test scripts/rehearsal-signal-order.test.mjs
```
