# Postgres helper

The one way the Workers and the scripts reach the Postgres operational store
(bead `ro-ujb9.76.18`; the store is [`db/postgres/`](../../db/postgres/README.md)).
It opens every transaction as the application role, `noticeos_app`, with one
workspace named by `SET LOCAL`, and reads and writes every value exactly. The
rules, and why the driver is node-postgres, are in the header of
[`src/store.mts`](src/store.mts); the comparison with Postgres.js and the prior
art are in [the driver brief](../../docs/briefs/2026-09-24-postgres-driver.md).

Operational settings, evidence and readers use this helper, following
[the port pattern](../../docs/briefs/2026-09-29-postgres-port-pattern.md).
The migration runner (`pnpm postgres:dev`) keeps its own
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
  work refuses, naming why. How each Worker opens it per call is
  [the port pattern](../../docs/briefs/2026-09-29-postgres-port-pattern.md).
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
  or a comparison expects that form, as every instant D1 stored did.
- `tx.query` returns rows; `tx.execute` returns how many rows a write touched.
  One statement per call, `$1…$n` parameters.
- `tx.workspaceId` is the transaction's workspace, for a statement that writes
  `workspace_id`.
- An `int8` comes back as a `bigint`, which `JSON.stringify` refuses. Convert it
  where a response is built, or cast in SQL (`count(*)::int`).
- Scripts import `packages/postgres/src/store.mjs` by path, like the contract's
  generated modules. `pnpm config:generate` writes that file and its `.d.mts`
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
transaction's workspace setting in its query text
([brief](../../docs/briefs/2026-09-24-postgres-driver.md#hyperdrive-query-caching-must-be-off-for-this-store)).

Direct PostgreSQL is the baseline hosted transport candidate because the
application uses advisory transaction locks. Cloudflare currently lists
advisory locks as unsupported by Hyperdrive without a transaction-lock
exception. Local native/workerd tests do not certify hosted transport:
Hyperdrive pooling and caching do not operate with `localConnectionString`.
Actual hosted qualification is tracked by `ro-ujb9.289.7`.
[Supported features](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/),
[local development](https://developers.cloudflare.com/hyperdrive/configuration/local-development/).

Each call's pool remains bounded by `DEFAULT_MAX_CONNECTIONS` (five). Hosting
must also budget connections across simultaneous calls and replicas; this
per-call limit is not a deployment-wide cap. A Worker must not share a live
connection across invocations.

Locally, the binding's connection string (Miniflare 4.20260701) must carry a
password, even for a development database that never asks for one: Miniflare
refuses a string without one. It comes from the environment,
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_POSTGRES`, never from a
checked-in `localConnectionString`, and ends in `?sslmode=disable` so workerd
connects straight to the server. A throwaway cluster in loopback mode
([`scripts/postgres-dev.mjs`](../../scripts/postgres-dev.mjs)) makes such a
string, with a password made at its start.

## What the proofs cover

The private `./platform-provisioning` module prepares a new canonical workspace,
its same-UUID identity anchor, one mailbox-bound enrollment and the full generic
default documents with seed audits. Preparation leaves the workspace inactive
and grants no membership. Its platform role has only the narrowly granted
functions and maintained first-owner `addMember` table privileges; it cannot
read sessions, accounts, codes or operational tables. Activation locks and
rechecks the current recipient, lifecycle, unrevoked task mapping and complete
unchanged default envelope, then awaits a fixed server-owned physical-task
verifier before creating the first owner and marking the workspace active.
Verification is not a caller readiness flag, and cancellation must finish its
owned cleanup before the transaction releases locks. This module exposes no
customer handler or live service. Disposable native and ordinary Worker proofs
verify actual initialized task ownership before activation; the Worker service
bridge is synthetic and does not qualify deployed service authentication.

The ordinary collector still compiles only its twelve generic defaults and
keeps `beads.json` outside its fallback. Provisioning's released envelope adds
the generic coordination document separately, from the same shared source for
the other values. Neither path reads installation files.

The `./browser-session` module reads the current signed session and that
person's workspace choices in one canonical membership snapshot. Choices use
UUID keyset pages of 100; an explicitly selected active workspace is checked
in the same snapshot even when it is outside the page. The API does not choose
the only membership or use the session's active-organization field. A verified
person without memberships receives an empty list. The Tower's `/api/session`
response is never cached; demo mode reads only its fixed public workspace and
does not inspect a customer cookie. Returned facts grant no authority to later
requests, which must perform their own fresh admission. The browser entry and
workspace-switching UI are separate from this server endpoint.

Ordinary hosted requests also carry the tab's captured `x-noticeos-session-id`.
Admission compares it with the freshly verified cookie session before opening
workspace capabilities. A cookie replaced in another tab therefore cannot run
an earlier tab's pending request as the new person. Google authorization start
checks the same binding inside state issuance; its callback uses the existing
single-use custody protocol. Demo and standalone requests carry no customer
session selector.

Tower's stored dashboard, financial, alert, work and Settings reads share one
payload dispatcher across standalone and hosted profiles. Hosted config RPCs
forward the original request and recheck membership at the receiver; refusal
cannot become a successful built-in-settings fallback. Synthetic A/B/demo
coverage runs through the actual Workers in
[`workspace-config-worker.test.mjs`](../../scripts/workspace-config-worker.test.mjs).

The `./membership` module exposes only explicit invitation and member commands.
Administration rechecks the signed session, membership and canonical lifecycle
inside one transaction; the server's central `memberships.manage` decision
authorizes the fixed action. Acceptance instead checks the verified recipient,
stored role and unexpired pending invitation. Organization then canonical
workspace locks serialize acceptance and last-owner changes. Invitation delivery
follows commit; a delivery failure reports the saved invitation ID for explicit
resend. The module exposes no raw organization handler, workspace provisioning,
HTTP/UI entry or configured sender. Native and ordinary Worker fixtures are in
[`postgres-membership.test.mjs`](../../scripts/postgres-membership.test.mjs).

Hosted Google integration state uses the maintained identity engine's public
`$context.internalAdapter.consumeVerificationValue` inside one identity
transaction. The fixed custody API binds an opaque state to the initiating
person, session, workspace and canonical callback. It reloads membership and
workspace lifecycle under the existing organization/workspace lock order;
shared admission decides the action. Consumption commits before any provider
exchange, including cancellation, and a failed exchange requires a new start.
The API exposes no generic verification reader or engine handler. Abandoned
Google integration records are retired only by platform housekeeping: one
identity-role transaction deletes at most 100 expired rows in the exact Google
namespace, using the database clock and skipping locked rows. Login and other
verification records are untouched. Each invocation awaits its pool teardown;
failures expose only a fixed diagnostic and the next scheduled invocation can
retry. The Ingest scheduled handler is an instance field, unavailable over RPC.
The hosted-only `7 * * * *` lane is a no-op in standalone/demo and is deliberately
absent from the checked-in standalone triggers. Publishing or enabling that
remote cron requires the operator's explicit approval. Standalone
keeps its legacy signed-state flow. See
[`integration-oauth-custody.mts`](src/integration-oauth-custody.mts) and
[`postgres-integration-oauth.test.mjs`](../../scripts/postgres-integration-oauth.test.mjs).
This local proof does not activate a hosted deployment or browser workspace
transport; those retain their separately tracked entry requirements.

[`scripts/postgres-store.test.mjs`](../../scripts/postgres-store.test.mjs) runs
in `pnpm test:scripts`, on a throwaway cluster where one can start (required in
CI). It proves every transaction runs as `noticeos_app` with its workspace set
LOCAL, that the same connection afterwards names no workspace, reads nothing and
writes nothing, that one workspace never sees another's rows, that values
round-trip exactly, that any failure rolls the whole transaction back, and that
a connection as any other role is refused before the work runs. On a cluster
of its own, a new installation: before its bootstrap the store names no
workspace, after it the bootstrap's, and once a second exists none again;
each refusal, and a malformed id, opens no transaction.
The same suite exercises explicit hosted A/B calls with identical queries and
failed writes in a multi-workspace fixture, and rejects malformed JavaScript
inputs before work. These prove the helper's workspace selection and cleanup,
not caller authentication or deployed tenant safety.

Inside the Workers themselves:
[`workers/ingest/test/postgres-store.test.ts`](../../workers/ingest/test/postgres-store.test.ts)
runs in workerd on the ingest suite's `POSTGRES` binding,
[`apps/tower/test/postgres-store.test.ts`](../../apps/tower/test/postgres-store.test.ts)
in the Tower suite, and
[`apps/tower/test/runner-door-e2e.test.ts`](../../apps/tower/test/runner-door-e2e.test.ts)
in both Workers inside the local OS's dev server. Each opens a transaction as
`noticeos_app` in the one workspace and reads back what it wrote.

The private `./task-directory` fact reader lazily opens its separate runtime
connection after explicit workspace/project UUID validation. It returns only
the current unrevoked mapping from `0005_task_project_directory.sql`; the same
logical project UUID may resolve differently in two workspaces. Stable vault
handles permit credential value rotation without changing database ownership.
Returned facts grant no admission, initialization or lasting execution authority.
The trusted executor owns current admission, credential lookup and effect-time
revalidation. Platform setup alone inserts directory ownership; the reader has
only function execution, and customers have neither table nor function access.
Native hosted mutations additionally use `withProjectMutation`: a fixed,
fail-busy transaction advisory lock for the selected workspace/project. Its
lease reads mapping facts on the held connection and remains open until the
executor's owned process/profile cleanup is awaited. Cancellation and known
connection loss refuse work. This direct-Postgres coordination is not a Dolt
transaction fence, a Hyperdrive qualification or authority over external writers.
Native and ordinary Worker checks are in
[`postgres-task-directory.test.mjs`](../../scripts/postgres-task-directory.test.mjs).

The private `./service-grant` reader binds a deployment-owned principal and
workspace at construction and lazily uses `noticeos_service_grant`. Each
`facts()` reads current named actions, expiry, revocation and canonical
workspace lifecycle from `0007_workspace_service_grants.sql`. It accepts no
request-selected principal, token or workspace, and stores no bearer secrets.
The server composes the callback into central service admission, which rejects
unknown, protected and membership grants before resolving capabilities. Facts
are not authority; queued work must repeat admission before effects. Platform
setup can register or narrow/revoke grants; the reader has only the exact
function privilege. This control-plane table is outside the operational model's
schema matrix. Native and ordinary Worker proof uses generated fixtures in
[`postgres-service-grant.test.mjs`](../../scripts/postgres-service-grant.test.mjs).
Scheduler dispatch and demo activation remain separate composition.

The `./mutation-audit` recorder appends asset, annotation, decision and flag
events inside the writer's existing transaction. Hosted receivers supply fresh
person/session facts after central admission; the recorder itself grants no
authority. Standalone writes record an explicit unknown actor, and historical
authors are never inferred. Subjects contain fixed identifiers and counts, not
column values, annotation references or notes. Flag rule/metric metadata remains
on the original flag and introduces no new input length limit. Actual no-ops
append nothing; a successful column write retains its existing timestamp effect
and records it. Any audit insert failure rolls back the effect. New writers
require `0011_workspace_mutation_audit.sql`; earlier code remains compatible
after that additive migration. Production receiver enablement is separate
(`ro-ujb9.289.8.3.3.13`), and no live migration or activation is implied.
Native and ordinary Worker fixtures are in
[`postgres-mutation-audit.test.mjs`](../../scripts/postgres-mutation-audit.test.mjs).

The `./agent-sign-in` module is agent sign-in's authorization server (epic
`ro-cvl9`): the identity engine's maintained OAuth 2.1 provider
(`@better-auth/oauth-provider` 1.7.7 with Better Auth's JWT plugin) behind fixed
routes only. It serves the MCP resource's protected-resource metadata, the
authorization-server metadata, authorize, token, dynamic registration, revoke
and the signing keys, plus the agent page's two calls. Approval checks that the
page's session header names the browser's own session, then records the
person's allow or deny through the library's consent step; it names no
workspace. The identity facts gain `agentToken`, which verifies an access token
against this deployment's key, issuer and the MCP resource, then requires a
live consent from its person to an enabled client, keeping only scopes both
granted; `agentWorkspaces`, the person's workspaces for `list_workspaces`; and
`agentAuthority`, which adds the person's membership and role in the one
workspace a call names. Each reads its facts in one observation. All require
`0014_agent_sign_in.sql`. Proofs are in
[`postgres-agent-sign-in.test.mjs`](../../scripts/postgres-agent-sign-in.test.mjs).

The `./task-receipts` module records retry-safe hosted task writes (epic
`ro-cvl9`) in `noticeos.task_operation_receipts`. One receipt binds an
idempotency key, scoped to the workspace, the admitted principal and the
operation, to its request's hash and a server operation identity; every state
change is a compare-and-set on the attempt number, so two callers cannot both
start one change. The caller authorizes first; the module grants nothing and
runs no task command. A receipt is kept seven days after its last attempt:
recording a change first removes the workspace's expired receipts, so a retry
that late runs as a new change, and a trigger refuses any earlier removal.
Writers require `0012_task_operation_receipts.sql` and
`0013_task_receipt_retention.sql`, both additive; no live migration or
activation is implied. Proofs are in
[`postgres-task-receipts.test.mjs`](../../scripts/postgres-task-receipts.test.mjs).
