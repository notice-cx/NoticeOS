# Database consumers of the Postgres store

Read the current inventory directly from source:

```sh
pnpm db:consumers
```

The command lists runtime and test files for every schema-qualified table or
view in [model.json](model.json). It reads local code and requires no database.
The full inventory is generated on demand. The alert-snapshot readers are listed below.

The reader uses SQL keyword matches; a comment that reads like SQL can appear.
Its exact-name and generated-file handling are covered by
[scripts/postgres-model.test.mjs](../../scripts/postgres-model.test.mjs).

<!-- alert-daily-consumers:start (generated from scripts/postgres-docs.mjs findConsumers) -->
## `noticeos.alert_daily_counts`

Runtime (2): `apps/tower/worker/alert-daily.ts`, `workers/ingest/src/alert-daily.ts`

Tests (4): `apps/tower/test/alert-daily.test.ts`, `apps/tower/test/wall-payload.test.ts`, `workers/ingest/test/alert-daily.test.ts`, `workers/ingest/test/pulse.test.ts`
<!-- alert-daily-consumers:end -->
