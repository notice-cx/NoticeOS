# The Postgres driver and the one transaction helper (2026-09-24, bead `ro-ujb9.76.18`)

**Decision: node-postgres (`pg`), pinned at 8.23.0, behind one helper,
[`packages/postgres/src/store.mts`](../../packages/postgres/src/store.mts).**
Every Worker and script transaction goes through it: it connects as
`noticeos_app`, names one workspace per transaction with `SET LOCAL`, and reads
and writes every value exactly. The research was done on 2026-09-24 from the
vendors' own docs and from the pinned packages. Where a doc did not say
something, this brief says so.

## What the helper needed from a driver

1. Runs in a Cloudflare Worker behind Hyperdrive, and in a Node script, from
   one module.
2. A statement is SQL text plus a list of parameters. That is the shape the D1
   code being ported already has (`prepare(sql).bind(...)`).
3. Result parsing can be replaced for one query, without a process-wide
   setting.
4. Transactions are explicit enough to set the workspace inside each one.

## The two candidates

| | node-postgres (`pg`) | Postgres.js (`postgres`) |
|---|---|---|
| Cloudflare's advice | "the recommended driver for connecting to your Postgres database from JavaScript or TypeScript Workers" | Supported |
| Hyperdrive minimum | 8.16.3 on its driver page (8.13.0 in the overview table) | 3.4.5 on its driver page (3.4.4 in the overview table) |
| Worker flag | `nodejs_compat` | `nodejs_compat` |
| Statement shape | `client.query(text, values)` | Tagged templates; text plus values is `sql.unsafe`, which turns prepared statements off by default |
| Replacing a parser | Per query: `{ types: { getTypeParser } }` | Per client: `types` with `from` OIDs |
| Transactions | Explicit `BEGIN`/`COMMIT`, which the helper sends | `sql.begin`, which rolls back on error |
| Hyperdrive options | New client per request | New client per request, `max: 5`, `fetch_types: false`, `prepare: true` |

Postgres.js would work. It lost on criterion 2: every ported statement would go
through `sql.unsafe`, or be rewritten as a template. It also needs
`prepare: true` for Hyperdrive to cache its prepared statements.
node-postgres takes the D1 shape as it is. Its per-query `types` hook puts every
exactness rule in one function. Kysely and Drizzle both run on node-postgres, so
a query builder can come later without changing the driver. Choosing an ORM is
outside D25.

## What the defaults would have lost

Read with the pinned `pg-types` 2.2.0, before the helper's own parser table:

| Postgres value | Default JavaScript value | Loss |
|---|---|---|
| `timestamptz` `2026-09-05 01:02:03.456789+00` | `Date` 2026-09-05T01:02:03.456Z | Microseconds |
| `date` `2026-09-05` | `Date` 2026-09-05T07:00:00Z, local midnight on this Mac | The day depends on the process's zone |
| `json` `{"a":9007199254740993}` | `{ a: 9007199254740992 }` | The number, and the bytes `json` keeps |
| `numeric[]` `{0.000625,1.1}` | `[0.000625, 1.1]` as floats | Decimal exactness |
| `int8`, `numeric` | Strings | None, but an `int8` string is easy to add as text |

node-postgres's own docs state the `Date` behavior: timestamps are parsed "into
an instance of a JavaScript `Date`" in "the local time of the node process".

The helper instead reads `int8` as `bigint`, `numeric` as the server's text,
`timestamptz` as ISO 8601 UTC with six fraction digits, `date` as `YYYY-MM-DD`,
`json` and `jsonb` as text, and `bytea` as bytes. The full table is in the
module's header.

## Naming the workspace in every transaction

- **Cloudflare Hyperdrive** pools in transaction mode: a client "communicates
  through a single connection for the duration of a transaction", and a
  connection returned to the pool is `RESET`, so `SET` "will not take effect on
  subsequent queries". Hyperdrive does not support SQL-level `PREPARE`,
  advisory locks, `LISTEN`/`NOTIFY`, or other per-session state.
- **AWS's row-level security guide** sets the tenant with a session-level
  `SET app.current_tenant`. It warns that session variables "may be
  incompatible with server-side connection pooling". It also warns that a table
  owner bypasses policies unless the table has `FORCE ROW LEVEL SECURITY` and
  the application connects as a non-owner.
- **Supabase** switches role and identity for each request with `set local role`
  and `set local request.jwt.claim.sub`, inside the transaction.

**Adopt:** the D27 model already forces row security on every table and gives
the application a non-owner role. The helper adds the pooling-safe half. It
sets the workspace with `set_config(…, true)` (`SET LOCAL`) in the same round
trip as `BEGIN`, and checks there that the connection is `noticeos_app`. The
proof shows that the same connection, after the transaction, names no workspace
and sees no rows. Unlike AWS's string concatenation, the workspace id is checked
against the UUID form before it is written into the statement.

## Hyperdrive query caching must be off for this store

Hyperdrive caches "eligible read-only query responses" for 60 seconds by
default. It does "not purge or invalidate cached read query results when your
application writes". It skips queries that call `STABLE` or `VOLATILE`
functions, but it judges only by the query's own text. The caching docs do not
say whether reads inside a transaction are exempt. A NoticeOS read filters by
its workspace through row security, not through its text. So a cached answer
to `SELECT … FROM noticeos.assets` would not depend on the workspace.
**The Hyperdrive configuration for this store is created with
`--caching-disabled`**. The host bead (`ro-ujb9.76.12`) records this.

## Sources

- https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/
- https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/node-postgres/
- https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/postgres-js/
- https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/
- https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/
- https://developers.cloudflare.com/hyperdrive/concepts/query-caching/
- https://developers.cloudflare.com/hyperdrive/configuration/query-caching/
- https://node-postgres.com/features/types
- https://github.com/porsager/postgres/blob/master/README.md
- https://aws.amazon.com/blogs/database/multi-tenant-data-isolation-with-postgresql-row-level-security/
- https://supabase.com/docs/guides/database/postgres/row-level-security
