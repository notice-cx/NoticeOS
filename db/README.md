# Operational store: Postgres

Postgres is NoticeOS's only supported operational database. Both Workers use
the shared [`packages/postgres`](../packages/postgres/README.md) helper; there
is no D1 runtime or alternative ORM.

- [`postgres/README.md`](postgres/README.md): schema, record rules and operator commands.
- [`postgres/migrations/`](postgres/migrations/): append-only schema migrations.
- [`postgres/frozen-migrations.sha256`](postgres/frozen-migrations.sha256): immutable migration hashes.
- [`postgres/constraints.md`](postgres/constraints.md): generated constraints, keys and permissions.
- [`postgres/tables.json`](postgres/tables.json): table capacity and arrival-time catalog.
- [`postgres/host/README.md`](postgres/host/README.md): Docker Compose and fresh-install setup.

Existing installations apply migrations only through an explicitly approved
`pnpm postgres:migrate` operation. Managed startup and deployment check schema
compatibility without applying changes. The approved automatic setup exception
is limited to `pnpm start` creating a provably new, empty installation.

Settings and encrypted provider credentials live in Postgres. Raw provider
archives remain in R2; task coordination remains in the Beads/Dolt hub. See
[operations](../docs/06-operations.md) for backup and restore.

The private D1 transition completed on 2026-09-30 (`ro-ujb9.76.10`). Its old
schema, importer and rehearsals are frozen in the private recovery archive at
cutover release `a85e82837411729bc15b5cf1c2feacc7de209083`; they are not maintained
as a second product backend. Existing recovery data is preserved separately.
