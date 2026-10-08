---
reviewed: 2026-10-01
status: accepted contract v1; local hosted composition implemented; remote activation unqualified
---

# 23 — Workspace ownership and authorized execution

**A workspace owns a portfolio and is the tenant isolation boundary.** People
may belong to several workspaces. Assets, evidence, integration connections,
tasks and workflow activity stay with their owning workspace in every request,
background job and export. A deployment can serve one workspace or many.

The owner approved this direction on 2026-10-01 after the
[comparative research](briefs/2026-10-01-hosted-tenancy-research.md), including
invitation-only customer onboarding and an open, read-only public demo. D39 in
the [decision register](../config/decisions.md) supersedes the old prohibition
on hosted accounts. D27's shared Postgres schema and D32's Beads/Dolt authority
remain. The [glossary](../CONTEXT.md) defines the product terms.

This is the accepted implementation contract, not evidence of hosted safety.
`ro-ujb9.289` carries implementation and verification; `ro-ujb9.256` carries the
demo. Those hub records are the work register. Existing deployments keep their
current access boundary until an explicitly approved activation.

## Research baseline and current source

The 2026-10-01 [source audit](briefs/2026-10-01-hosted-tenancy-research.md#noticeos-source-audit-at-the-research-baseline)
at `e2393a239024ac305385da6358b29c9e6bc54535` establishes the starting point:

- The [Postgres schema](../db/postgres/migrations/0001_baseline.sql) already has
  workspace-leading keys and relationships, forced row security, and a
  non-owner application role without row-security bypass. The
  [store](../packages/postgres/src/store.mts) sets workspace context per
  transaction. Retain this implementation.
- At that baseline, Tower and ingest discovered the installation's **only** workspace;
  discovering more than one fails. They did not authenticate customer membership.
  [Configuration caching](../workers/ingest/src/config-store.ts) already includes
  workspace identity. Configuration documents and credentials are workspace
  rows; credentials currently allow one record per provider per workspace.
- Native task consumers use saved logical project membership and a separate
  [host capability map](../scripts/task-project-config.mjs). Matching asset,
  prefix and database prevents arbitrary checkout selection, but the caller
  still needs a trusted workspace. Hosted task actions were not implemented at that baseline.
- Browser state, native job dispatch, some private caches and object paths
  assumed one installation at that baseline. Environment credential fallback
  was not yet restricted to an explicit standalone owner.
- The current [demo seeder](../scripts/demo-seed.mjs) writes real Postgres and
  Beads records in a fresh isolated installation. It is neither a hosted
  membership implementation nor an ongoing simulator.

Current source has explicit hosted/demo admission, invitation-only identity,
workspace-bound Tasks, scheduler journals/status and scoped archive readers.
The [operator runtime instructions](../scripts/README.md#hosted-runtime-composition-and-recovery)
map those compositions to their modules and disposable tests. These are local
implementation facts, not an activated public service or a qualified remote
network, delivery or recovery configuration.

The older 2026-09-09 audit (private historical evidence)
proved persistence of 13 configuration documents at that time. Its D1 and
global-key descriptions are historical, not the current ownership model.

## Identity, membership and roles

A person has one NoticeOS identity and zero or more workspace memberships.
External login identities use the provider's stable issuer and subject;
matching email strings alone cannot merge accounts. Provider-connection OAuth
is separate from signing in to NoticeOS. Authenticated sessions and identity
validation use a maintained authentication component or standard identity
provider; NoticeOS owns workspace membership and action authorization. The
component is selected through a bounded runtime and lifecycle proof, without
requiring a paid identity vendor or inventing password/session cryptography.

**Initial hosted sign-in uses an email one-time code** (owner-selected
2026-10-01, `ro-ujb9.289.8.3.4.1`). Invited people prove control of their email;
creating a new identity requires a valid invitation. Sign-in does not create a
workspace or grant membership. Codes and sessions use the maintained component,
with a replaceable mail delivery adapter and no mandatory identity vendor.
Google login and password login are not part of this initial experience. Local
implementation uses captured fixture mail; real sending and auth activation
remain separately approved operations.

The hosted Tower exposes only the three fixed email-code paths in
[`identity-protocol.mts`](../scripts/identity-protocol.mts), not the auth
library's general handler. Enrollment links contain a mailbox-bound enrollment
ID; the browser entry must remove that selector before requesting a code.
Sign-out checks the tab's captured session and revokes that server session. It
does not expire the shared browser cookie, because a delayed response could
otherwise erase a newer login from another tab. The revoked cookie grants no
access and a successful sign-in replaces it.

The current HTTP adapter requires a server-declared Cloudflare edge profile,
Cloudflare request metadata and a valid `CF-Connecting-IP`; it rejects Worker
subrequests and ignores arbitrary forwarded-address headers. This follows
[Cloudflare's documented header behavior](https://developers.cloudflare.com/fundamentals/reference/http-headers/).
A native host needs its own trusted-peer adapter; setting similarly named
request headers does not make it an edge. Delivery uses the configured
`NOTICEOS_IDENTITY_EMAIL` binding and server-selected sender after the code
transaction commits. No real sender or hosted auth profile is enabled by the
checked-in standalone configuration. The actual Tower proof in
[`workspace-auth-worker.test.mjs`](../scripts/workspace-auth-worker.test.mjs)
uses synthetic edge metadata and captured mail; it does not certify a deployed
proxy or live delivery.

Customer workspaces are **invitation-only initially**. Platform-authorized
provisioning creates a workspace and its first owner; an owner can invite people
to that workspace. An invitation has a workspace, intended recipient, role,
expiry and single-use acceptance. Signing in without an accepted invitation
does not create a customer workspace. The public demo requires no membership.

The hosted Tower's fixed membership route accepts owner commands and bounded
member or invitation listings. It checks the tab's captured session and current
owner authority under the membership transaction's locks. Recipient acceptance
uses a separate route: the stored invitation selects the workspace, and the
verified email, expiry and pending state must match. Both routes reject demo
and standalone requests. Invitation mail uses the same configured delivery
adapter after commit; delivery failure returns the saved invitation ID for
resending. Membership responses never replace session cookies.

| Authority | Allowed scope |
| --- | --- |
| Owner | Ordinary workspace operation plus membership and role administration. Cannot give away the last owner or administer another workspace. |
| Operator | Workspace evidence, assets, integrations, tasks, settings and ordinary workflow operation; no membership administration. |
| Viewer | Approved evidence, charts, task details and sanitized settings/provider summaries; no mutation, secret access or external execution. |
| Demo reader | An anonymous reader bound by the server to the configured demo workspace and the narrower public-demo policy below. |
| Workspace service principal | Explicit named actions for a particular job or integration; no implicit owner role. |
| Platform maintenance | Deployment provisioning, physical stores, backup and recovery. Not granted by owning a workspace. |

Roles map to named actions at one authorization boundary; handlers do not
independently reinterpret role strings. Protected operations in
[AGENTS.md](../AGENTS.md) remain operator-directed. A role, workflow or service
credential cannot promote auth, billing, migrations, consent, measurement
controls or other forbidden operations into agent autonomy. No billing,
custom-role editor or public customer signup is implied by this contract.

Product-use stages are presentation selections over already saved event
aggregates. Exact `product-use-stages` register operations use ordinary settings
admission, including a validated stages-only insert into an absent asset
holder. They do not change collection, conversion/value-event declarations or
measurement rules. Whole-holder replacement/deletion, ancestor writes and
neighboring measurement fields cannot use that exception.

`tasks.decide` records a human response, dismissal or human-gate approval. It is
limited to a current owner/operator person or an explicit standalone operator;
workspace services cannot receive it, even through an explicit grant. Viewers
and demo readers cannot decide. Ordinary task closure or removal of the human
marker cannot substitute for this action. Recording a decision may unblock
work; it does not execute or authorize a protected operation.

## Authorized execution context v1

Before resolving workspace data or execution capabilities, every HTTP, private
RPC, native task and scheduled-job entry establishes:

| Field | Meaning |
| --- | --- |
| `workspaceId` | The one workspace authorized for this operation. |
| `principalId`, `principalKind` | Authenticated person, workspace service, explicit standalone operator or demo reader. |
| Authorized action | A named operation checked against current membership/service authority and workspace state. |
| Request or run ID | Stable correlation for audit, retries and effect attribution; never an authorization credential. |
| Entry profile | Explicit hosted, standalone or public-demo admission; cannot be selected by an untrusted request field. |

Login, identity linking, invitation acceptance and platform provisioning are
separate identity/control-plane entries. Their narrow policies admit only the
identity or invitation operation in question, including a person with no
memberships. Login validates its protocol state before establishing a session;
linking and invitation acceptance validate the intended authenticated identity.
These entries may access their identity store, never inherit workspace-store,
task or provider capabilities merely because membership has not yet been created.

The server constructs this context. A URL, header, cookie selection or body may
request a workspace, but cannot grant it. Validate session signatures, expiry,
issuer/audience where applicable, current membership and workspace status before
building context. Auth/session queries require fresh authoritative reads;
membership revocation applies to new requests and to resumed execution. Browser
mutations also require the session mechanism's origin/CSRF protection.

Private Tower → ingest calls carry the bounded original request proof for a
fixed receiver method. The receiver reconstructs fresh admission; a live context
brand does not cross Worker realms. Service binding access alone is not
end-user authority. A network caller cannot submit
a serialized context or audit actor and have it trusted. Native middleware,
tool APIs and task subprocesses use the same authorization decision before
acquiring capabilities. Object ownership is checked within the context;
denials expose neither foreign data nor whether the requested object exists.

Context is immutable for the operation. Store transactions use its workspace;
repositories need not repeat identity discovery. Hosted entries fail closed
when context is absent; `onlyWorkspace()` is never their fallback. An explicit
standalone adapter may resolve the sole provisioned workspace and operator
behind the existing trusted access boundary. It must refuse ambiguous stores.

The shared implementation is
[`workspace-admission.mts`](../scripts/workspace-admission.mts). Its awaited
operation keeps an immutable context live only within its creating admission
module instance. Serialized, copied, escaped or differently authorized contexts
are refused. Composite reads keep the original semantic action while reading
required settings. Each entry fixes its profile and fresh authority reader on
the server; request data cannot select a profile or assert verified authority.
Stored reads, provider reads and effects are distinct named actions: a POST
backtest can read, while a GET provider call can spend or record. Demo read
admission is explicit per action; a future stored read is not automatically
public. Effectful browser admission checks exact trusted origin or positive
same-origin Fetch Metadata and the trusted request target; missing evidence
never becomes standalone or service admission. Protocol callbacks retain their
separate state/nonce obligations.

Canonical `workspaces.status` is `provisioning`, `active` or `suspended`.
Existing rows become active; future rows start provisioning. Platform setup
activates a hosted workspace only after provisioning, while fresh standalone
bootstrap explicitly creates active. Ordinary runtime roles cannot change this
state. Admission requires active and a current membership or scoped service
grant; organization metadata does not supply lifecycle. A narrow identity-only
function reads one canonical summary without operational table access. Old
standalone rollback compatibility does not imply old code enforces hosted
suspension.

The private [`service-grant.mts`](../packages/postgres/src/service-grant.mts)
reader binds one deployment-owned service and workspace before connecting.
`facts()` reloads current named actions, expiry/revocation and canonical lifecycle
in one observation through a separate function-only role. It accepts no caller
principal selector or bearer secret. Central admission validates those stored
names and rejects unknown, protected or membership grants entirely. The
[service reader qualification](../scripts/postgres-service-grant.test.mjs) uses
disposable native and Worker fixtures. Scheduler composition uses this reader;
remote provisioning or activation remains a separate operator step.

Queued work persists workspace, initiating principal, service identity, action
and payload/definition references. It does not persist a bearer token as lasting
permission. On dispatch and retry, reload authority and workspace state, then
resolve current capabilities. Revocation or suspension prevents new effects;
already completed external effects remain recorded. Long steps recheck before
each external effect. Approvals pin workspace, run, step, definition version,
approver and exact action/payload so changed work cannot borrow an old approval.

The native [`hosted-job-runner.mts`](../scripts/hosted-job-runner.mts) binds a
deployment-owned registry, workspace and service. PostgreSQL stores occurrence
and attempt identities, definition/input digests and projected workflow output;
raw inputs, errors and bearer credentials are not persisted. Database effects
commit with their checkpoints. Outside effects record their start first and
remain uncertain after interrupted execution or acknowledgement; retries never
silently repeat them. Each step obtains fresh central admission. Registered
adapters must honor cancellation and await cleanup. The
[hosted scheduler](../scripts/hosted-scheduler.mts) supplies workspace-owned
cron dispatch, and the Tower reads persisted attempts and scheduler status for
Workflows. The [scheduler qualification](../scripts/hosted-scheduler.test.mjs)
exercises the timer, journal and tenant read path. Publication refreshes within
15 seconds; a status older than 45 seconds is stale. A checked-in Worker cron
does not instantiate this native scheduler or enable a remote deployment.

## Ownership and storage

| Resource | Owner and boundary |
| --- | --- |
| Defaults | Versioned generic code; no installation's assets, paths, accounts or credentials. |
| People, login identities, sessions | Identity service; global identifiers do not permit enumerating people or memberships across workspaces. |
| Memberships and invitations | Workspace plus person or intended recipient; authorized membership operations. |
| Assets, ledger, signals, findings, decisions | Workspace-owned records, including authenticated actor and provenance where relevant. |
| Configuration and TV layout | Workspace; the existing document format remains behind the scoped store. Measurement protection is unchanged. |
| Integration connection | Workspace plus opaque connection identity and revision; provider/account labels do not grant ownership. Encrypted secrets remain server-only. |
| Task project and task history | Workspace owns the logical project; a trusted directory resolves approved Beads/Dolt capabilities. |
| Workflow definition, schedule, run, step, approval | Workspace; a run pins its definition and initiating principal across retries. Execution success is not business outcome. |
| Personal preference | Person; workspace-specific preferences additionally name workspace. Browser caches use the same ownership. |
| Device state and unsaved UI | Device/browser or memory: viewport, reduced motion, fullscreen, menus, drafts. Saved reporting timezone remains workspace data. |
| Objects, attachments, exports and tenant audit | Workspace plus object identity and authorized access; no raw host path accepted. |
| Host configuration and maintenance | Deployment adapter: ports, checkout paths, database provisioning, physical backup inventory and maintenance credentials. Never tenant-selectable capabilities. |

The current one-connection-per-provider schema remains the compatibility model.
Trusted context and cache interfaces carry an opaque connection identity/revision
without requiring a provider to be a globally unique key. Supporting multiple
connections for the same provider requires an explicit schema and product
change; this contract does not silently migrate credentials.

### Keys, caches and files

Workspace prefixes alone are not authorization, but every shared identifier
must preserve ownership:

| State | Required partition |
| --- | --- |
| SQL records, joins, uniqueness and foreign keys | Workspace + local record identity, enforced by composite keys and forced row security. |
| Credential/token/resource caches and refresh leases | Workspace + connection identity/revision + actual grant/scope where relevant. Rotation cannot reuse another grant's token. |
| Config/query cache | Workspace + data identity + authorization-relevant principal scope + backing store identity. Public reference data may be shared only when it contains no tenant inputs. |
| Job deduplication, overlap and retry IDs | Workspace + lane/run/step identity and the logical occurrence. Identical customer job names do not share locks. |
| Native files, logs, object keys and downloads | Workspace-owned namespace/manifest; authorization also checked when reading, signing a URL or exporting. Secrets stay redacted. |
| Browser query, preferences, pending writes and undo | Person/session generation + workspace + resource/action. |

Shared deployment diagnostics and physical backups may contain several
workspaces and are platform-only. A customer export or restore cannot inherit
that authority. Tenant restore preserves ownership, validates the destination
and cannot overwrite a different workspace through copied identifiers.

Signal archives and paid-request checkpoints use `workspaces/<workspace UUID>/`
keys. Archive reads also require the selected workspace's stored manifest.
Standalone installations can read legacy archives through that same manifest.
An old DataForSEO checkpoint is considered only when its namespaced counterpart
is absent and the database proves the selected workspace is its sole workspace;
invalid objects or failed reads never trigger that fallback. Hosted and demo
profiles never adopt unscoped checkpoints (`ro-ujb9.289.9.4`).

## Postgres, task execution and transport

**D27 chooses a shared Postgres database and schema.** Retain workspace-leading
keys, forced row security, the non-owner/no-bypass application role and
transaction-local context. Do not introduce per-customer schemas or databases
as an alternative. Identity/control-plane storage needs an explicit separately
reviewed schema and narrow access path; a global identity lookup is not a reason
to bypass row security on customer data.

The current hosted profile selects **direct PostgreSQL**, with no SQL-result
cache between the runtime and the workspace or identity store. The
[`postgres-hosted-transport.test.mjs`](../scripts/postgres-hosted-transport.test.mjs)
qualification uses generated low-privilege PostgreSQL with the native driver
and an ordinary Worker bundle. It checks concurrent identical-query workspace
reuse, rollback context reset, fresh signed-session and membership revocation,
read-after-write, and conflicting advisory locks released on commit or rollback.
This establishes local runtime compatibility, not a deployed endpoint, TLS,
capacity or remote network qualification; `ro-ujb9.289.7` retains that boundary.

The current source requires advisory transaction locks, which
[Hyperdrive does not support](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/).
Its default [query cache](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)
also cannot provide authoritative auth or read-after-write facts. Hyperdrive
is not the supported hosted profile. Do not split one transaction across
transports or remove concurrency guarantees to fit a proxy. Worker deployment
must satisfy the documented [outbound TCP restrictions](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/);
local loopback success does not prove remote connectivity. The explicit
standalone transport path remains separate and unchanged.

**Dolt remains the task authority, with `bd` the only write path.** Resolve
`(workspace, taskProject)` through a trusted directory to the allowed database,
restricted credential and executor/filesystem capability. Prefixes are unique
inside a workspace; physical database names are unique within their server and
are not derived from a tenant-supplied name without trusted provisioning.

A workspace never chooses a host, database, checkout path, executable, arbitrary
CLI arguments or raw volume. Provisioning, migration, backup and restore
authority stays with platform maintenance. Branches are not tenant secrecy
boundaries.

The approved UI/API-only hosted design uses **shared Dolt with separate project
databases and restricted credentials behind trusted, fixed-command NoticeOS
execution**. Tenants and agent harnesses use the authorized NoticeOS API; they
never receive Dolt credentials, SQL access or arbitrary Beads execution. The
server selects workspace credentials and checkout capabilities; command shapes
exclude arbitrary flags, files, configuration and branch operations.

The [remote panel review build contract](briefs/2026-10-05-remote-panel-review.md)
extends these boundaries to versioned evidence, remote agent admission and
retry-safe task operations. It is an implementation handoff, not evidence that
those additional capabilities or a public service have been qualified.
Retry-safe task writes, one MCP endpoint for every tool in every workspace a
person belongs to, and agent sign-in (OAuth 2.1 through the identity engine's
maintained provider) now exist locally ([scripts/README.md](../scripts/README.md#explicit-local-hosted-tasks-entry));
their activation and any public service remain unqualified.

The [Dolt 2.4.0 / Beads 1.3.1 qualification](../scripts/dolt-tenant-permissions-compose.test.mjs)
uses two generated databases with colliding task IDs. Restricted accounts
support ordinary task changes and bounded history, while tested foreign
database/revision access is denied. However, checkout permission also permits
own branch creation, and `LOAD_FILE` returns an owned server canary without a
`FILE` grant. Both databases share the server filesystem; SQL grants do not
isolate that filesystem. Raw Beads also reads and writes files with its process
permissions. That raw-credential proof supports the conditional placement contract, **not
executor certification**. The separate
[fixed executor proof](../scripts/hosted-task-executor-compose.test.mjs) and
[actual browser composition proof](../scripts/hosted-task-browser-native.test.mjs)
qualify the confined local path, not remote hosting or tenant SQL access. If
tenant-controlled SQL or execution is later requested, reconsider separate
per-workspace servers before accepting that broader capability.

## Public demo and simulator

The demo uses the same released application, Postgres schema, task service and
Beads model as an ordinary workspace. The public entry resolves a configured
demo workspace on the server and **always** grants demo-reader authority, even
when the browser also holds a customer session. A selector cannot turn it into
a customer request. The UI persistently identifies synthetic data.

Visitors may explore approved views, filters, charts, task details and sanitized
settings/provider summaries. They cannot edit settings/tasks, reveal secrets,
approve work, run arbitrary queries, trigger collection or perform outward
actions. Enforce capabilities at the service/executor boundary, not only in the
UI or by HTTP method: a POST may be a read; a GET may trigger an external call.
External realtime/calendar/discovery reads must use persisted synthetic evidence
or be unavailable, never silently contact a real provider.

A separate demo-bound service principal supplies simulated observations and
scenario task transitions through ordinary writers. Ordinary jobs and the
evaluator derive alerts, financial views and outcomes. The simulator cannot
access customer credentials, provision workspaces or invoke real deployment,
email or payment capabilities; provider/execution adapters enforce the same
restriction. Synthetic provenance survives exports. A simulated integration is
never evidence that real OAuth, billing or external delivery worked.

Use a versioned deterministic portfolio and idempotent dated events. Preserve
relationships among usage, revenue, costs, tasks and observed outcomes, including
missing data, failures and recoveries. No arbitrary periodic history deletion
or fabricated causal lift makes the display fresh. Reseeding is an explicit
versioned operation respecting append-only history. Apply finite query windows,
export size, concurrency and simulator work budgets before public exposure;
public demand cannot consume unbounded customer capacity. Existing collection
and publishing caps are not relaxed for the demo.

The native [demo runtime](../scripts/hosted-demo-runtime.mts) composes an
already seeded, explicitly bound workspace with the released ordinary input
writers, scoped task executor and journal. It does not provision or migrate.
Its one-minute timer has one in-flight tick and catches up at most seven owed
dates per tick, oldest first. A busy, blocked or uncertain occurrence stops that
batch; it cannot skip missing evidence to make the display look current.
`status()` reports activity failure rather than presenting a timer as healthy.
The runtime is a server-composition API, not a public route or a checked-in
remote simulator activation command. See the
[operator recovery boundary](../scripts/README.md#hosted-runtime-composition-and-recovery)
before restarting halted activity.

## Standalone compatibility and browser switching

A fresh standalone installation still starts without a hosted identity provider.
It uses the same schema and explicit single-workspace adapter behind its
documented access boundary. A hosted profile must be explicitly provisioned;
adding a second workspace cannot silently turn a standalone admin into an
all-workspace operator. Ordinary fresh workspaces start with empty assets,
connections and customer schedules plus generic defaults. Only the explicitly
selected demo workspace receives fictional content.

Legacy environment credentials belong only to the explicitly assigned
standalone workspace. Hosted requests/jobs cannot fall back to them after a
missing, revoked or unreadable connection. Missing configuration is unknown or
an explicit empty initial state, never the original operator's compiled files.
The bootstrap-secret distinction remains defined once in
[Operations](06-operations.md#bootstrap-secrets-vs-integration-credentials).

The credential resolver enforces that profile boundary, including legacy Google
service-account binding names. Captured credentials and health observations carry
the selected store's workspace and connection identities; another workspace or a
replaced connection cannot adopt their results. Hosted health revisions include
both identities. Standalone revisions retain their existing form so historical
monitoring evidence remains usable (`ro-ujb9.289.9.3`).

On logout or workspace switch, cancel outstanding operations, advance the
client session generation, clear/remount scoped queries and drafts, and discard
late responses. Pending writes and Undo keep their original workspace; a failed
Save cannot replay into the next one. Cancellation does not undo an already
committed write. Each tab keeps its own selected workspace; an auth library's
session-wide active-organization field cannot silently retarget another tab.
The server checks every write independently.

User preference caches include person identity and, where relevant, workspace.
Legacy unscoped browser preferences are not proof of ownership. Importing old
finding decisions requires an explicit legacy-owner destination, preview and
completion marker; a new customer on the same browser never inherits them.

## Rollout, approval and compatibility

The owner authorized local implementation of this design and tests on disposable
synthetic installations. This is an explicit task authorization, not a promotion
of auth or migrations into autonomous operations. Existing installations and
remote services keep their current behavior until a concrete release package
has passed isolation proof and the owner approves its activation scope.

Schema changes are append-only numbered migrations recorded in Postgres; never
edit the frozen baseline. Preserve compatibility with eligible app rollback
versions. An older single-workspace release must refuse a multi-workspace store,
not select an arbitrary customer. A release cannot advertise rollback to a
version incapable of serving its active hosted identities. The activation
package states compatible releases, legacy workspace assignment, schema/backfill
and credential transitions, recovery procedure and exact verification scope.
No migration, auth activation, public hosting or DNS change is authorized by
this document alone.

## Required isolation proof

Use **two ordinary synthetic workspaces plus the demo**, with overlapping asset
slugs, provider/account labels, document names, task prefixes and workflow names.
Include a multi-workspace person, a person belonging to only one workspace,
viewers, revoked memberships, separate service principals and anonymous readers.
Tests run through public APIs, private calls and background work, not just SQL.

| Exercise | Required evidence |
| --- | --- |
| Forge workspace/object/actor/context fields; replay expired sessions or keys | Refusal before effects; no foreign existence disclosure or forged audit actor. |
| Invite, accept twice, change role, revoke membership, remove last owner | Current authority enforced; single-use invitation; last-owner invariant; no uninvited workspace creation. |
| Cross-origin session mutation and forged private service context | CSRF/origin and internal authentication checks refuse before acquiring capabilities. |
| Interleave successful and failed transactions on reused pooled connections | Each operation sees only its workspace; state does not leak after commit/rollback. |
| Concurrent saves and warm cache reuse; failed reads; credential rotation | Ownership remains correct; stale save refuses atomically; no legacy or foreign fallback. |
| Retry jobs after revocation/suspension; collide names and occurrence times | Authority rechecked, effects refused when revoked, deduplication remains workspace-bound. |
| Execute foreign task projects, branches, database selectors or file paths | Task executor and Dolt grants deny access; bd is still the write path. |
| Switch/logout during reads, optimistic Saves and Undo; use two tabs | Late data/rollback cannot enter the new context; pending writes keep their owner. |
| Invoke demo mutations through HTTP, RPC, tasks and tool APIs, including GET side effects | Server refusal independent of UI and HTTP verb, including a signed-in customer visiting demo. |
| Run simulator beside customer activity; exceed public budgets | Only synthetic workspace inputs/tasks change; no real outward effect or unbounded shared work. |
| Read exports, objects, task history, logs and backup metadata | Access is workspace-bound; physical platform backups never become customer downloads. |
| Start fresh standalone; upgrade and exercise declared rollback versions | Existing simple install remains usable; migrations and compatible identity/store behavior have executable proof. |

Independent verification re-executes the relevant tests and records source,
fixture, runtime and schema versions. Native fixtures establish native behavior;
hosted proof names the actual supported transport and task executor. A green
demo does not substitute for tests of real provider OAuth or delivery.
