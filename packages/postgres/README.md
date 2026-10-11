# Postgres helper

The one way the Workers and the scripts reach the Postgres operational store
([`db/postgres/`](../../db/postgres/README.md)). It opens every transaction as
the application role, `noticeos_app`, with one workspace named by `SET LOCAL`,
and reads and writes every value exactly. The rules are in the header of
[`src/store.mts`](src/store.mts).

Operational settings, evidence and readers use this helper: a Worker reaches
Postgres only through its `POSTGRES` Hyperdrive binding, one store per call;
a script writes the store through the ingest's operator-authed door and never
holds a database credential. The migration runner (`pnpm db:try-migrations`) keeps its own
administrative connection and never uses it.

## Using it

```ts
import { openStore } from '@noticeos/postgres';

const store = openStore(connectionString);
try {
  const workspaceId = await store.onlyWorkspace();
  const sites = await store.inWorkspace(
    workspaceId,
    (tx) => tx.query<{ asset_id: string; created_at: string }>(
      'SELECT asset_id, created_at FROM noticeos.assets WHERE status = $1 ORDER BY asset_id',
      ['live'],
    ),
    { readOnly: true },
  );
} finally {
  await store.close(); // in a Worker: ctx.waitUntil(store.close())
}
```

- `store.onlyWorkspace()` discovers the workspace for the standalone adapter.
  A standalone installation has exactly one, created by its
  bootstrap ([db/postgres, "Bootstrap"](../../db/postgres/README.md#applying-it-the-development-profile)),
  and the store names it (`noticeos.only_workspace()`), so no id is copied
  into a file or a binding. With none or several it throws
  `NoSingleWorkspace` before any transaction opens. An installation with
  several workspaces passes the server-authorized operation's id to
  `inWorkspace` instead. A UUID is an identifier, never authorization.
- **A call's store.** What a ported module works with is
  `openWorkspaceStore(connectionString)`: one per Worker call (request,
  scheduled run, RPC call) or script run, closed when it ends. It finds the
  workspace once, on its first unit of work, and runs each unit in a
  transaction of its own: `store.read(work)` READ ONLY, `store.write(work)`
  committed whole or not at all. `store.where` names host, port and database
  without the credential. A Worker's entry opens it with
  `withWorkspaceStore(env.POSTGRES, ctx, work)`, which closes it through
  `ctx.waitUntil` even when the work throws; with no binding, each unit of
  work refuses, naming why. The ingest wraps `fetch`, `scheduled` and each RPC
  method in `withCallStore` (`workers/ingest/src/call-store.ts`); the Tower
  runs its router inside `withWorkspaceStore` (`apps/tower/worker/index.ts`).
- **Hosted calls require prior authorization.** The server authenticates the
  principal and authorizes the operation before calling
  `withHostedWorkspaceStore({ transport, workspace }, ctx, work)`. `transport`
  is server-selected `{ kind: 'direct', connectionString }`; `workspace` is
  the authorized context's `{ workspaceId }`. Neither comes from untrusted
  request data. This helper validates their structure, not their authority.
  Missing or malformed inputs refuse before work or connection without
  echoing supplied values. It never calls `onlyWorkspace()`, reads an ambient
  URL or changes transport within a transaction. It uses the same `read`,
  `write` and `waitUntil` cleanup as the standalone adapter. See the
  [authorized execution contract](../../docs/23-configuration-ownership.md#authorized-execution-context-v1).
- A `timestamptz` comes back as Postgres writes it. `javascriptInstant(text)`
  turns it into the form `new Date().toISOString()` writes, where a response
  or a comparison expects that form.
- `tx.query` returns rows; `tx.execute` returns how many rows a write touched.
  One statement per call, `$1…$n` parameters.
- `tx.workspaceId` is the transaction's workspace, for a statement that writes
  `workspace_id`.
- An `int8` comes back as a `bigint`, which `JSON.stringify` refuses. Convert it
  where a response is built, or cast in SQL (`count(*)::int`).
- Scripts import `packages/postgres/src/store.mjs` by path, like the contract's
  generated modules. `pnpm generate` writes that file and its `.d.mts`
  from `store.mts`.

## What a Worker needs

The current standalone Workers carry a `POSTGRES` Hyperdrive binding and
`nodejs_compat` in their checked-in Wrangler configs. Local development connects
directly to the selected PostgreSQL server through that binding's local
connection string; test fixtures use disposable copies. The explicit hosted helper takes a direct transport instead
of impersonating a Hyperdrive binding. Node/container callers can use the same
direct driver; Workers support direct PostgreSQL TCP with node-postgres too.
[Cloudflare database connections](https://developers.cloudflare.com/workers/databases/connecting-to-databases/).
[`apps/tower/test/runner-door-e2e.test.ts`](../../apps/tower/test/runner-door-e2e.test.ts)
proves the stanza below in the dev server the local OS runs. The stanza each
Worker's `wrangler.jsonc` carries:

```jsonc
"compatibility_flags": ["nodejs_compat"],
"hyperdrive": [
  {
    "binding": "POSTGRES",
    // From `wrangler hyperdrive create … --caching-disabled`, logging in as noticeos_app.
    "id": "<hyperdrive id>"
  }
]
```

The standalone Worker opens a store per call with
`withWorkspaceStore(env.POSTGRES, ctx, work)`, which closes it with
`ctx.waitUntil(store.close())`. Workspace settings are transaction-local. Any
hosted Hyperdrive configuration must have SQL-result caching disabled on the
actual remote resource; the binding comment does not enforce that setting.
Cached reads can outlive writes, so they cannot establish current authorization
or read-after-write consistency. A cached read also does not include the
transaction's workspace setting in its query text, so the Hyperdrive
configuration for this store is created with `--caching-disabled`.

Direct PostgreSQL is the baseline hosted transport candidate because the
application uses advisory transaction locks. Cloudflare currently lists
advisory locks as unsupported by Hyperdrive without a transaction-lock
exception. Local native/workerd tests do not certify hosted transport:
Hyperdrive pooling and caching do not operate with `localConnectionString`.
[Supported features](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/),
[local development](https://developers.cloudflare.com/hyperdrive/configuration/local-development/).

Each call's pool remains bounded by `DEFAULT_MAX_CONNECTIONS` (five). Hosting
must also budget connections across simultaneous calls and replicas; this
per-call limit is not a deployment-wide cap. A Worker must not share a live
connection across invocations.

Locally, the binding's connection string must carry a password, even for a
development database that never asks for one: Miniflare refuses a string
without one. It comes from the environment,
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_POSTGRES`, never from a
checked-in `localConnectionString`, and ends in `?sslmode=disable` so workerd
connects straight to the server. A throwaway cluster in loopback mode
([`scripts/postgres-dev.mjs`](../../scripts/postgres-dev.mjs)) makes such a
string, with a password made at its start.

## What the proofs cover

Each suite runs on a throwaway cluster where one can start (required in CI);
the `scripts/` suites run in `pnpm test:scripts`. Each module's rules are in
the header of its source file under [`src/`](src/). These suites prove the
helper and its modules, not a deployed service's authentication or tenant
safety.

- [`postgres-store.test.mjs`](../../scripts/postgres-store.test.mjs): every
  transaction runs as `noticeos_app` in exactly one workspace, rolls back
  whole on failure, and leaves its connection naming no workspace.
- [`workers/ingest/test/postgres-store.test.ts`](../../workers/ingest/test/postgres-store.test.ts),
  [`apps/tower/test/postgres-store.test.ts`](../../apps/tower/test/postgres-store.test.ts)
  and [`apps/tower/test/runner-door-e2e.test.ts`](../../apps/tower/test/runner-door-e2e.test.ts):
  each Worker reaches the store through its binding and reads back what it
  wrote in one workspace.
- [`workspace-config-worker.test.mjs`](../../scripts/workspace-config-worker.test.mjs):
  hosted config reads recheck membership at the receiver, and a refusal never
  falls back to built-in settings.
- [`postgres-platform-provisioning.test.mjs`](../../scripts/postgres-platform-provisioning.test.mjs)
  (`./platform-provisioning`): a prepared workspace stays inactive until real
  task ownership is verified, then gains its first owner.
- [`postgres-browser-session.test.mjs`](../../scripts/postgres-browser-session.test.mjs)
  (`./browser-session`): a session's workspace choices are read fresh, and none
  is chosen for the person by default.
- [`postgres-membership.test.mjs`](../../scripts/postgres-membership.test.mjs)
  (`./membership`): invitations and member changes recheck authority in one
  transaction and never remove the last owner.
- [`postgres-integration-oauth.test.mjs`](../../scripts/postgres-integration-oauth.test.mjs)
  (`./integration-oauth-custody`): Google sign-in state is single-use and bound
  to one person, session and workspace.
- [`postgres-task-directory.test.mjs`](../../scripts/postgres-task-directory.test.mjs)
  (`./task-directory`): a task project resolves only to its current unrevoked
  mapping, separately in each workspace.
- [`postgres-service-grant.test.mjs`](../../scripts/postgres-service-grant.test.mjs)
  (`./service-grant`): a service reads only its own bound principal's current
  grants.
- [`postgres-mutation-audit.test.mjs`](../../scripts/postgres-mutation-audit.test.mjs)
  (`./mutation-audit`): an audit event commits with its write, and a failed
  audit rolls the write back.
- [`postgres-agent-sign-in.test.mjs`](../../scripts/postgres-agent-sign-in.test.mjs)
  (`./agent-sign-in`): an agent's token reaches a workspace only as far as its
  person's approval and role allow.
- [`postgres-task-receipts.test.mjs`](../../scripts/postgres-task-receipts.test.mjs)
  (`./task-receipts`): a retried task write binds to one request and runs once.
