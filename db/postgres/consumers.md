# Database consumers of the Postgres store

Read the current inventory directly from source:

```sh
pnpm postgres:consumers
```

The command lists runtime and test files for every schema-qualified table or
view in [model.json](model.json). It reads local code and requires no database.
The inventory is not committed, so changes to SQL need no documentation refresh.

The reader uses SQL keyword matches; a comment that reads like SQL can appear.
Its exact-name and generated-file handling are covered by
[scripts/postgres-model.test.mjs](../../scripts/postgres-model.test.mjs).
