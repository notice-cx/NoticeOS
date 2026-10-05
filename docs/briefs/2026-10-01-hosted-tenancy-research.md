# Hosted NoticeOS tenancy, authentication and demo research

Research for `ro-ujb9.289.5`, retrieved **2026-10-01**. NoticeOS source baseline:
`e2393a239024ac305385da6358b29c9e6bc54535`. This is a dated comparison and proposed
design, not evidence that hosted tenancy or a public demo has shipped. The
implementation contract remains tracked by `ro-ujb9.289.1`.

## Recommendation

Build the demo as an ordinary NoticeOS workspace with an explicitly restricted
public reader and a separate simulator identity. Use the same release, APIs,
Postgres rules, task model and scheduled processing as customer workspaces.
Simulate the external assets and provider responses at their input boundaries;
let normal application processing produce the visible results.

Use **Workspace** as the customer boundary. A person can belong to several
workspaces with different permissions; assets and task projects belong inside a
workspace. An organization layer above workspaces is not justified by the
current NoticeOS requirements. Preserve D27's shared Postgres design and D32's
Beads/Dolt work authority. A login component can establish identity, but
NoticeOS must own the authorization of its data, tasks and actions.

These are recommendations from the comparison below. The owner has already
chosen a live demo tenant, anonymous read-only exploration and simulator-created
activity. Static hosting and visitor-editable demo workspaces are not competing
options in this research.

## Evidence method

The comparison selects established projects for relevant mechanisms, rather than
claiming an objective ranking of the best SaaS products. Official documentation
establishes supported behavior and edition boundaries. Pinned source establishes
specific mechanisms at that revision. Source review is not a security audit or
proof of the operator's deployed configuration. Development branches are named
as such, not presented as stable releases.

No competitor account was created, no demo was mutated, and no private service
was inspected. A public demo URL alone does not establish its database topology,
reset schedule, background simulation or separation from paying customers.
Where the cited material does not establish those facts, they remain unknown.

| Project | Most useful precedent for NoticeOS | Limit on the comparison |
|---|---|---|
| Grafana | Server-bound anonymous organization; simulated inputs through normal features | Ordinary Viewer can still query data sources; public dashboards use a narrower policy. |
| Langfuse | Live shared example project; separate project membership and API authority | Inspected whole-demo route requires sign-in; finer project roles are commercial. |
| Documenso | Explicit session lifecycle and team-scoped API identity | Its demo is a staging account environment; organization SSO differs from instance OIDC. |
| PostHog | Tenant-aware query/cache enforcement and real demo generation | Hobby self-hosting does not offer every hosted tenancy/permission capability. |
| Plane | Normal sample projects; workspace-owned exports and membership checks | Commercial 2026 custom roles exceed the community permission model. |
| Twenty | Workspace-aware queue execution, workload budgets and explicit deployment mode | Its workspace records use separate schemas; development seeds do not prove public-demo operation. |
| Zulip | Mature organization separation and persisted ownership for background work | Its Cloud demo is a writable temporary organization, not our shared reader model. |

Each row is developed with primary-source links below. There is no single
database layout or public-demo policy shared by all seven projects.

## Grafana

Grafana separates dashboards, data sources, alerts and service accounts by
organization, while users can belong to multiple organizations. Authentication
providers and server configuration are shared deployment concerns. This is a
useful precedent for separating NoticeOS workspace ownership from the identity
of the person signing in. [Organization model](https://grafana.com/docs/grafana/latest/administration/organization-management/)

Anonymous access resolves to a configured organization and role. In stable
**v13.2.3**, commit `6193dc03311b631b9727b560d24369e683dc396e`, the authentication
client looks up that organization on the server, produces an anonymous identity
with its role, and rejects resolution for a different organization. That is a
concrete precedent for a server-bound demo reader. It is not a general bypass
of authorization. [Configuration](https://grafana.com/docs/grafana/latest/setup-grafana/configure-access/configure-authentication/anonymous-auth/),
[authentication source](https://github.com/grafana/grafana/blob/6193dc03311b631b9727b560d24369e683dc396e/pkg/services/anonymous/anonimpl/client.go#L41)

There are two materially different public-reading models. An ordinary Viewer
can query the organization's data sources, including queries absent from saved
dashboards. Externally shared dashboards are read-only and permit only stored
dashboard queries. NoticeOS should similarly define which operations public
visitors can invoke; a Viewer label or disabled editing button is insufficient.
[Security implications](https://grafana.com/docs/grafana/latest/setup-grafana/configure-security/),
[externally shared dashboards](https://grafana.com/docs/grafana/latest/visualizations/dashboards/share-dashboards-panels/shared-dashboards/)

Grafana's built-in TestData source supplies simulated data to ordinary panels,
transformations and alerting. Its scenarios include empty/error conditions and
predictable alert transitions. This supports the proposed NoticeOS input
simulator, but does not prove how Grafana Play is hosted or refreshed. Some
TestData annotations are browser-generated and unpersisted; NoticeOS's ongoing
operational demo needs persisted observations and actual processing instead.
[TestData](https://grafana.com/docs/grafana/latest/datasources/testdata/),
[scenarios](https://grafana.com/docs/grafana/latest/datasources/testdata/query-editor/),
[annotation limitation](https://grafana.com/docs/grafana/latest/datasources/testdata/annotations/)

Edition boundary: organization roles and generic OAuth are available in OSS;
SAML, team synchronization, custom RBAC and fine data-source permissions have
Enterprise/Cloud boundaries. Do not interpret every feature in the unified
documentation as a free self-hosted feature. [Authentication editions](https://grafana.com/docs/grafana/latest/setup-grafana/configure-access/configure-authentication/),
[permissions editions](https://grafana.com/docs/grafana/latest/administration/roles-and-permissions/)

## Langfuse

Current main, `9d168c646be62f497d3e03957d66cb09b60fd7eb`, separates people,
organization membership, projects and project API credentials. A protected
project procedure matches the requested project to the authenticated session's
memberships; a separate permission check determines whether its role can perform
the action. Verified API credentials supply the project identity. These are
distinct checks, not one global logged-in flag.
[Project authorization](https://github.com/langfuse/langfuse/blob/9d168c646be62f497d3e03957d66cb09b60fd7eb/web/src/server/api/trpc.ts#L317),
[action permissions](https://github.com/langfuse/langfuse/blob/9d168c646be62f497d3e03957d66cb09b60fd7eb/web/src/features/rbac/utils/checkProjectAccess.ts#L25),
[API credential scope](https://github.com/langfuse/langfuse/blob/9d168c646be62f497d3e03957d66cb09b60fd7eb/web/src/features/public-api/server/verifyProjectApiKeyAuth.ts#L12)

Its Auth.js implementation uses JWT sessions but reloads membership information
when constructing the session and checks an explicit session-expiration marker.
That is evidence against assuming that a valid long-lived token automatically
contains current permissions. Organization roles and generic self-hosted SSO
exist in the core; finer project-level RBAC, audit logs and management features
have commercial licensing requirements.
[Session source](https://github.com/langfuse/langfuse/blob/9d168c646be62f497d3e03957d66cb09b60fd7eb/web/src/server/auth.ts#L729),
[self-hosted authentication](https://langfuse.com/self-hosting/security/authentication-and-sso),
[edition boundary](https://langfuse.com/self-hosting/license-key)

The demo documentation describes a shared live example project, with demo apps
generating actual traces. However, the inspected `/demo` route redirects
anonymous users to sign-in, and signup grants Viewer membership in the configured
demo organization. Public trace/session access is a separate mechanism. Thus
the live-input approach is relevant to NoticeOS, while anonymous whole-project
access is not established by this code. Hosted configuration and reset cadence
remain unknown. [Demo documentation](https://langfuse.com/docs/demo),
[demo route](https://github.com/langfuse/langfuse/blob/9d168c646be62f497d3e03957d66cb09b60fd7eb/web/src/pages/demo/%5B%5B...path%5D%5D.tsx#L37),
[demo membership](https://github.com/langfuse/langfuse/blob/9d168c646be62f497d3e03957d66cb09b60fd7eb/web/src/features/auth/lib/createProjectMembershipsOnSignup.ts#L37)

## Documenso

Current main, `8a41a3bf618d9e46e2e1c0f437aa0488d91b85de`, authorizes team access
through organization/team membership. Browser requests combine the selected team
with authenticated membership. API middleware derives team identity from the
verified token. The token path has legacy owner mapping; NoticeOS should use an
explicit service identity for automation instead of making every integration
impersonate a workspace owner.
[Team lookup](https://github.com/documenso/documenso/blob/8a41a3bf618d9e46e2e1c0f437aa0488d91b85de/packages/lib/utils/teams.ts#L123),
[API middleware](https://github.com/documenso/documenso/blob/8a41a3bf618d9e46e2e1c0f437aa0488d91b85de/packages/trpc/server/trpc.ts#L85),
[token compatibility behavior](https://github.com/documenso/documenso/blob/8a41a3bf618d9e46e2e1c0f437aa0488d91b85de/packages/lib/server-only/public-api/get-api-token-by-token.ts#L21)

Unlike Langfuse's JWT session design, Documenso persists hashed random session
identifiers, checks expiry and revokes sessions through their records. Its
middleware also rejects disabled users. Both implementations make session
lifecycle explicit; neither design makes application membership checks
unnecessary. [Session implementation](https://github.com/documenso/documenso/blob/8a41a3bf618d9e46e2e1c0f437aa0488d91b85de/packages/auth/server/lib/session/session.ts#L28)

Community is AGPL. Basic instance-wide OIDC is available for self-hosting;
per-organization SSO is an Enterprise feature. The latter must not be reported
as a ban on all free SSO. Its documented demo uses a separate staging account
and test billing environment. That is a testing sandbox, not evidence of an
anonymous shared tenant or a particular reset schedule.
[Community edition](https://docs.documenso.com/docs/policies/community-edition),
[instance OIDC configuration](https://github.com/documenso/documenso/blob/8a41a3bf618d9e46e2e1c0f437aa0488d91b85de/packages/auth/server/config.ts#L39),
[organization SSO](https://docs.documenso.com/docs/users/organisations/single-sign-on),
[demo environment](https://docs.documenso.com/docs/developers/demo-environment)

## PostHog

Current master, `bd31a31576896f68770d9ebd1d75d0af0dd38f49`, has an
Organization → Project → Team/environment model, including compatibility names
from the older hierarchy. Its shared API machinery combines authentication,
membership, API scope and parent-filtered queries. This is evidence for layered
checks in those paths, not a claim that every endpoint uses them or that
Postgres RLS is universally present or absent.
[Current ownership model](https://github.com/PostHog/posthog/blob/bd31a31576896f68770d9ebd1d75d0af0dd38f49/posthog/models/project.py#L74),
[API authorization](https://github.com/PostHog/posthog/blob/bd31a31576896f68770d9ebd1d75d0af0dd38f49/posthog/api/routing.py#L254)

Its analytics query compiler adds tenant guards, and query-cache identity
includes the team and effective restrictions. This matters because a cached
result can otherwise bypass checks made only during query execution. Integration
records also belong to the team, with encrypted sensitive configuration.
NoticeOS should copy that ownership discipline, not PostHog's analytics stack.
[Query access design](https://github.com/PostHog/posthog/blob/bd31a31576896f68770d9ebd1d75d0af0dd38f49/posthog/hogql/ACCESS_CONTROL.md#L19),
[query guard](https://github.com/PostHog/posthog/blob/bd31a31576896f68770d9ebd1d75d0af0dd38f49/posthog/hogql/printer/clickhouse.py#L63),
[cache restrictions](https://github.com/PostHog/posthog/blob/bd31a31576896f68770d9ebd1d75d0af0dd38f49/posthog/hogql_queries/query_runner.py#L3100),
[tenant cache key](https://github.com/PostHog/posthog/blob/bd31a31576896f68770d9ebd1d75d0af0dd38f49/posthog/hogql_queries/query_runner.py#L3179),
[integration ownership](https://github.com/PostHog/posthog/blob/bd31a31576896f68770d9ebd1d75d0af0dd38f49/posthog/models/integration/model.py#L180)

Demo generation receives an explicit team and initiating user and runs through
the real data-generation machinery. A pre-generated mode copies synthetic
analytics into the target team and configures that project. This establishes a
model-backed demo mechanism, not anonymous access, a shared public demo's
topology, or its refresh schedule.
[Demo task](https://github.com/PostHog/posthog/blob/bd31a31576896f68770d9ebd1d75d0af0dd38f49/posthog/tasks/demo_create_data.py#L1),
[generation machinery](https://github.com/PostHog/posthog/blob/bd31a31576896f68770d9ebd1d75d0af0dd38f49/products/demo/backend/logic/matrix/manager.py#L157)

Edition and release limits are substantial: official documentation excludes
multiple organizations/projects from the OSS hobby deployment. Free and
pay-as-you-go plans have broad default access, Boost/Scale add configurable
access, and Enterprise adds role-based access. Its self-hosted server
documentation describes continuous master/latest-image deployment, not a
supported stable server release. A GitHub desktop release is not a server
version. Use its source as architectural evidence, not as a promise of a
turnkey free multi-tenant installation.
[Organization availability](https://github.com/PostHog/posthog.com/blob/a0881efede3e1434713807318edb4344543f6e75/contents/docs/settings/organizations.mdx#L16),
[access-control plans](https://github.com/PostHog/posthog.com/blob/a0881efede3e1434713807318edb4344543f6e75/contents/docs/settings/access-control.mdx#L269),
[self-hosted release model](https://github.com/PostHog/posthog.com/blob/a0881efede3e1434713807318edb4344543f6e75/contents/docs/self-host/index.mdx#L13)

## Plane

Plane's public workspace/project membership model is visible in stable
**v1.4.2**, `5f7d92784c403f76284f0f16718f320221dc7fec`, and current preview,
`c7a5afee6afd15f16038ebda1ec1489ebd8af67d`. Active membership and role checks
precede the view body; issue queries include workspace and project selectors.
The reviewed enforcement is application authorization and filtering. This
review does not establish database RLS coverage.
[Stable permission checks](https://github.com/makeplane/plane/blob/5f7d92784c403f76284f0f16718f320221dc7fec/apps/api/plane/app/permissions/base.py#L19),
[preview issue queries](https://github.com/makeplane/plane/blob/c7a5afee6afd15f16038ebda1ec1489ebd8af67d/apps/api/plane/app/views/issue/base.py#L218)

A useful background-work example is its export task: it receives workspace and
project IDs, checks the initiating user's active project membership and writes
under a workspace-owned object prefix. This is a concrete model for NoticeOS
exports; it does not prove every Plane task rechecks permissions. Its shared
cache utility includes the URL and normally the user, illustrating why cache
identity and authorization order both deserve review.
[Export task](https://github.com/makeplane/plane/blob/c7a5afee6afd15f16038ebda1ec1489ebd8af67d/apps/api/plane/bgtasks/export_task.py#L130),
[cache utility](https://github.com/makeplane/plane/blob/c7a5afee6afd15f16038ebda1ec1489ebd8af67d/apps/api/plane/utils/cache.py#L16)

New workspaces receive a sample project. Its background generator creates
ordinary projects, issues, memberships and related records inside the selected
workspace. This supports seeding meaningful product relationships rather than
canned screen responses. Public anonymous demo infrastructure and reset
behavior are not established by those sources.
[Sample project](https://docs.plane.so/workspaces/manage-workspaces),
[generator](https://github.com/makeplane/plane/blob/c7a5afee6afd15f16038ebda1ec1489ebd8af67d/apps/api/plane/bgtasks/dummy_data_task.py#L487)

Community has basic workspace/project roles. The richer 2026 custom-role and
permission-scheme system is Enterprise; a separate Workspace Admin role is
Business/Enterprise. Copying current commercial role names into a description
of the community release would be inaccurate.
[2026 permission release](https://plane.so/changelog/2026-04-25-custom-roles-granular-access-permissions-redesign)

## Twenty

Current main, `c7299510dab9fab5ca648bbd5b4e0daef5dba636` (2026-10-01), uses a
shared Postgres pool and derives a separate schema for workspace records. The
table-shape builder obtains the schema from the workspace ID and repository SQL
qualifies the table with that schema. This differs from NoticeOS's chosen
shared-schema/RLS model; it is not evidence that we need a new database server
for every customer or should replace our frozen schema.
[Pool](https://github.com/twentyhq/twenty/blob/c7299510dab9fab5ca648bbd5b4e0daef5dba636/packages/twenty-server/src/engine/twenty-orm/datasource/workspace-data-source.service.ts#L56),
[workspace table schema](https://github.com/twentyhq/twenty/blob/c7299510dab9fab5ca648bbd5b4e0daef5dba636/packages/twenty-server/src/engine/twenty-orm/table-shape/utils/build-workspace-table-shape.util.ts#L118),
[qualified SQL](https://github.com/twentyhq/twenty/blob/c7299510dab9fab5ca648bbd5b4e0daef5dba636/packages/twenty-server/src/engine/twenty-orm/repository/workspace-repository.ts#L798)

Workflow payloads carry a workspace ID. Queue dispatch establishes a job context
and the workflow handler enters the workspace ORM context with explicit system
authority. Enqueue locks and remaining-run budgets are workspace-specific.
These are useful patterns for NoticeOS jobs and public-demo resource limits.
They are not proof that Twenty rechecks every initiating user's membership on
every retry; trusted system work and delegated user work need distinct policies.
[Workflow handler](https://github.com/twentyhq/twenty/blob/c7299510dab9fab5ca648bbd5b4e0daef5dba636/packages/twenty-server/src/modules/workflow/workflow-runner/jobs/run-workflow.job.ts#L41),
[queue context](https://github.com/twentyhq/twenty/blob/c7299510dab9fab5ca648bbd5b4e0daef5dba636/packages/twenty-server/src/engine/core-modules/message-queue/message-queue.explorer.ts#L182),
[workspace budgets](https://github.com/twentyhq/twenty/blob/c7299510dab9fab5ca648bbd5b4e0daef5dba636/packages/twenty-server/src/modules/workflow/workflow-runner/workflow-run-queue/workspace-services/workflow-run-enqueue.workspace-service.ts#L33)

Self-hosting defaults to one workspace, with an explicit multi-workspace switch
and workspace subdomains. Its core is AGPL with listed exceptions and separately
marked Enterprise code; the inspected configuration and execution files are not
marked Enterprise. Its development seeder and local demo account do not establish
the hosted public demo's access policy, simulator authority, refresh schedule or
infrastructure. [Self-hosting modes](https://github.com/twentyhq/twenty/blob/c7299510dab9fab5ca648bbd5b4e0daef5dba636/packages/twenty-docs/developers/self-host/capabilities/setup.mdx#L80),
[license boundary](https://github.com/twentyhq/twenty/blob/c7299510dab9fab5ca648bbd5b4e0daef5dba636/LICENSE),
[development seeder](https://github.com/twentyhq/twenty/blob/c7299510dab9fab5ca648bbd5b4e0daef5dba636/packages/twenty-server/src/database/commands/data-seed-dev-workspace.command.ts#L16)

## Zulip

Current main, `9778ffc23c3e83e321152a48ab32c1426e1bd941` (committed 2026-09-30),
models organizations as separate realms within an instance. Separate hostnames
support simultaneous organization sessions. This is a mature precedent for
explicit tenant identity and browser separation; a hostname alone is not
authorization. [Realm model](https://github.com/zulip/zulip/blob/9778ffc23c3e83e321152a48ab32c1426e1bd941/docs/subsystems/realms.md#L1),
[multiple organizations](https://github.com/zulip/zulip/blob/9778ffc23c3e83e321152a48ab32c1426e1bd941/docs/production/multiple-organizations.md#L15)

Ordinary queue events publish after database commit. Its export worker reloads
the initiating user and derives the organization from persisted ownership;
outgoing-webhook work reloads the bot's services. For NoticeOS, the useful
lesson is to retain authoritative ownership across asynchronous execution and
avoid letting a job payload invent its own credentials. The reviewed slices do
not prove universal permission revalidation on every background job.
[Queue publication](https://github.com/zulip/zulip/blob/9778ffc23c3e83e321152a48ab32c1426e1bd941/zerver/lib/queue.py#L437),
[export worker](https://github.com/zulip/zulip/blob/9778ffc23c3e83e321152a48ab32c1426e1bd941/zerver/worker/deferred_work.py#L82),
[webhook worker](https://github.com/zulip/zulip/blob/9778ffc23c3e83e321152a48ab32c1426e1bd941/zerver/worker/outgoing_webhooks.py#L16)

Zulip's code is Apache-2.0. Its documented **Cloud** demo creates a temporary,
writable organization, allows invitations, expires after 30 days and can be
converted to a permanent organization. Some administrative actions require
verified email. This establishes a deliberate trial lifecycle, not a supported
self-hosted demo switch or the shared anonymous-reader design selected for
NoticeOS. [License](https://github.com/zulip/zulip/blob/9778ffc23c3e83e321152a48ab32c1426e1bd941/LICENSE),
[Cloud demo behavior](https://github.com/zulip/zulip/blob/9778ffc23c3e83e321152a48ab32c1426e1bd941/starlight_help/src/content/docs/demo-organizations.mdx#L26),
[expiry and conversion](https://github.com/zulip/zulip/blob/9778ffc23c3e83e321152a48ab32c1426e1bd941/starlight_help/src/content/include/_DemoOrgsConversion.mdx#L1)

## Authentication components and database safeguards

Supabase is useful here as a component reference, not evidence that its entire
hosted management plane is available as OSS. Its auth service issues and
validates identities; Postgres grants and row policies still determine data
access. Its elevated service role bypasses RLS. NoticeOS should retain the
existing non-owner, non-bypass application role even for background work, rather
than treating a server-side credential as permission to ignore tenant rules.
[Auth architecture](https://supabase.com/docs/guides/auth/architecture),
[RLS and privileged roles](https://supabase.com/docs/guides/database/postgres/row-level-security)

OpenID Connect defines issuer plus subject as the stable external identity,
rather than an email address. Recommended NoticeOS behavior: map that identity
to an internal person, then resolve current workspace membership separately.
A chosen workspace in a URL, cookie or header is a selector to authorize, not
proof of membership. [OIDC identity stability](https://openid.net/specs/openid-connect-core-1_0.html#ClaimStability)

Better Auth is a candidate for a focused compatibility evaluation, not a chosen
dependency. Its organization plugin offers memberships, invitations and roles;
its PostgreSQL adapter can use the existing `pg` driver and its schema generator
can emit SQL without requiring a Prisma or Drizzle migration. Documentation
also includes Workers integration. These capabilities do not prove compatibility
with NoticeOS's exact pooling, RLS, native runner and migration contracts.
Generated SQL must enter NoticeOS's reviewed, append-only migration process;
runtime automatic auth migrations would violate that process.
[Organization plugin](https://better-auth.com/docs/plugins/organization),
[PostgreSQL adapter](https://better-auth.com/docs/adapters/postgresql),
[schema generation](https://better-auth.com/docs/concepts/database),
[runtime integration](https://better-auth.com/docs/installation)

The alternative is a standards-based external identity provider, with NoticeOS
still owning sessions or validated identity context and workspace authorization.
It reduces local credential-management responsibility but adds an operator
dependency. The research does not justify requiring a paid identity service for
self-hosting or creating a bespoke password/session implementation. The choice
belongs after a small runtime and lifecycle proof, not before the ownership
contract.

## Proposed NoticeOS design

The following is design synthesis, not a claim that every compared project
implements it or that NoticeOS already does.

1. **One workspace boundary.** Workspace owns assets, financial and signal
   history, integrations, task projects, workflows and exported evidence.
   Person and sign-in identity are global; membership grants access within one
   workspace. Start with owner, operator and viewer roles, expressed as named
   actions so a role does not become a collection of scattered special cases.
   Platform maintenance is separate from workspace ownership. These roles do
   not promote auth, billing, security headers, migrations, consent or
   measurement controls into agent autonomy; the existing protected-operation
   rules still apply.
2. **One authorized execution context.** At every HTTP, private RPC, native task
   and scheduled-job entry, establish actor, workspace, permitted action and
   request/run identity before opening a store or resolving a task project.
   An explicit standalone adapter may resolve the sole workspace. Hosted mode
   must fail when tenant context is missing; it must never fall back to it.
3. **Ordinary public-reader policy.** The demo route resolves one configured
   demo workspace on the server. Anonymous visitors can explore the approved
   views, filters, charts, task details and sanitized settings/provider summaries.
   Settings or credential mutations, secret access, task edits, approvals,
   arbitrary queries, collection triggers and outward actions are refused by
   the service. Classify actions by effect, not HTTP verb: a POST can be a read
   and a GET can trigger work. The demo entry stays a reader even when visited
   by someone who also has an authenticated customer session.
4. **A bounded simulator identity.** The simulator can supply demo observations
   and perform scenario task transitions only in its own workspace. It has no
   customer credentials, no workspace-provisioning authority and no real
   deployment, email or payment capability. Ordinary jobs consume those inputs.
   Enforce external-effect restrictions in the execution/provider layer too.
5. **Persistent, coherent activity.** Reuse the versioned fictional portfolio
   and its deterministic seed. Extend its timeline through idempotent scheduled
   events, preserving relationships between traffic, revenue, tasks and outcomes.
   Include failures, missing reports and recoveries. Do not clear the demo every
   few hours merely to make it look fresh; deliberate reseeding must be versioned
   and preserve the product's history contract.
6. **Dolt is part of the boundary.** Resolve `(workspace, task project)` to an
   approved database and restricted credential. Never accept an arbitrary host,
   database, filesystem path or executable from a tenant request. Keep `bd` as
   the write path, behind the same task service used by the UI and future API.
   Platform backup/provisioning authority must not be available to ordinary jobs.
7. **Carry ownership beyond rows.** Cache keys, credentials, file/object paths,
   deduplication IDs, leases, retry payloads and logs need workspace ownership.
   A job must restore its authorized context when it executes, including after
   a retry or revocation. Scope browser state to the signed-in person and selected
   workspace, discarding late responses after switching either.
8. **Bound public workload.** Limit query windows, export size, concurrency and
   simulator work. A public reader cannot consume unlimited shared capacity.
   The demo is a useful continuous product exercise, but does not replace
   isolated tests or prove real OAuth, provider APIs, billing or delivery work.

Dolt supports SQL users/roles and separate server-authenticated branch controls.
Its branch documentation describes broad initial branch permissions, allows
branch reads regardless of branch write permissions, and warns that local
on-disk CLI access bypasses server branch controls. Branches must not serve as
tenant secrecy boundaries. Therefore database
grants alone are not evidence that the full `bd` command surface, branches,
backup and restore are safely confined. Qualify the exact operations and deny
raw volume access before choosing a shared executor; use tenant-specific
execution/filesystem capabilities where the existing host adapter carries wider
authority. This research does not choose a separate Dolt server per tenant.
[Dolt grants](https://www.dolthub.com/docs/concepts/dolt/sql/users-grants/),
[server access management](https://www.dolthub.com/docs/sql-reference/server/access-management/),
[branch permissions](https://www.dolthub.com/docs/sql-reference/server/branch-permissions/)

OWASP's multi-tenant guidance supports binding tenant context to authenticated
authority, scoping caches and storage, preserving context in background jobs,
and testing cross-tenant access explicitly. It also highlights resource
exhaustion as an isolation concern. These checks are a validation reference,
not evidence that the application has passed them.
[Multi-tenant security guidance](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html)

## NoticeOS source audit at the research baseline

The repository audit distinguishes existing safeguards from assumptions that
only hold for one installation. These are dated findings at the baseline above,
not a replacement work register. Source audit ownership and full evidence are
recorded on `ro-ujb9.289.2`, `.3` and `.4`.

| Area | Observed implementation and implication | Source |
|---|---|---|
| Postgres | Workspace-leading relationships, forced row security and a non-bypass application role already exist. The store sets transaction-local workspace context. Retain these safeguards. | [Schema](../../db/postgres/migrations/0001_baseline.sql), [roles](../../db/postgres/roles.sql), [store](../../packages/postgres/src/store.mts) |
| Request identity | Tower and ingest open the fixed installation store; private RPC has no trusted user/workspace context. Multiple workspaces fail single-workspace discovery, rather than gaining authorized routing. | [Tower entry](../../apps/tower/worker/index.ts), [ingest calls](../../workers/ingest/src/call-store.ts) |
| Configuration | The config cache already includes workspace identity. The D1/global-key current-state description in doc 23 is obsolete; a tenancy plan should not rebuild the existing cache separation. | [Config cache](../../workers/ingest/src/config-store.ts), [ownership design](../23-configuration-ownership.md) |
| Credentials and private caches | Credential resolution can fall back to installation environment bindings. Provider token/calendar/result caches do not consistently carry workspace and connection ownership. The Google token key uses refresh-token length rather than grant identity; equal-length distinct grants can collide. The concrete bug is `ro-ujb9.289.6`; no provider exploit was executed. | [Credential resolution](../../workers/ingest/src/credentials.ts), [Google cache identity](../../workers/ingest/src/google-auth.ts), [calendar](../../workers/ingest/src/calendar.ts) |
| Files and objects | Some raw-dump/checkpoint keys omit workspace. Workspace-scoped database rows cannot prevent collisions in a shared object bucket. | [Signal dumps](../../workers/ingest/src/signal-dumps.ts), [provider checkpoints](../../workers/ingest/src/dataforseo-dumps.ts) |
| Browser and integration OAuth | Query state and queued writes assume one installation. Provider-connection OAuth is not application login and does not establish a hosted user's workspace. | [Query client](../../apps/tower/src/main.tsx), [queued answers](../../apps/tower/src/lib/answer-queue.ts), [integration OAuth](../../workers/ingest/src/google-oauth.ts) |
| Tasks and jobs | Dolt startup grants the application access across databases. Native project maps, process/filesystem access, job overlap and workflow IDs are installation-scoped. Postgres job records already use transaction workspace; the missing ownership is earlier in dispatch and execution. | [Dolt bootstrap](../../db/dolt/host/start.sh), [task mapping](../../scripts/task-project-config.mjs), [job records](../../scripts/job-runs.mjs), [workflow history](../../scripts/workflow-history.mjs), [store writer](../../workers/ingest/src/job-runs.ts) |
| Current demo | Seeding uses real store writers, evaluator and `bd` task records in a positively identified fresh installation. The existing viewer policy is useful, but it is not yet a hosted membership model or ongoing simulator. | [Seeder](../../scripts/demo-seed.mjs), [evaluator](../../scripts/demo-evaluator.mjs), [reader policy](../../scripts/demo-viewer-policy.mts) |

Six small local adversarial checks of the native assumptions were independently
re-executed with the repository test-safety preload: **6 passed, 0 skipped**.
They reproduce shared-root workflow/job collisions and verify existing task-map
and demo-store boundaries using synthetic inputs and newly owned temporary
files. They do not establish hosted API, database or provider isolation. Full
fixture hashes and execution evidence are recorded on `ro-ujb9.289.4`.

Hosted transport is a separate qualification, tracked by `ro-ujb9.289.7`.
Cloudflare's current Hyperdrive documentation lists advisory locks and
undocumented session-state changes as unsupported, and describes query caching
as enabled by default. NoticeOS uses transaction-local workspace state and an
advisory transaction lock in integration health. Verify the exact supported
transport and cache settings before claiming hosted compatibility; native
Postgres proofs cannot establish them. No live Hyperdrive failure was observed.
[Supported features](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/),
[query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/),
[current lock use](../../workers/ingest/src/integration-health-store.ts)

## Proof required before hosted exposure

Use two ordinary synthetic workspaces plus the demo in the same test deployment.
Deliberately repeat asset slugs, provider account labels, connection names and
task prefixes across them. The test oracle is ownership and observed effects,
not merely an HTTP success code.

| Exercise | Required result |
|---|---|
| Change workspace, object or task project identifiers in a request | Membership and object ownership are checked; foreign data stays inaccessible. |
| Forge actor/context headers or use expired/revoked sessions and API keys | No caller-supplied field grants authority; invalid signatures, issuer/audience and browser-CSRF attempts fail before effects. |
| Interleave transactions on reused connections, including failed transactions | Workspace context never survives into another tenant's operation. |
| Reuse warmed provider/config/query caches across tenants | Results and credentials remain bound to the right workspace and grant. |
| Revoke membership or service authority, then retry queued work | Work follows the defined revocation policy; a stored payload cannot grant itself permission. |
| Switch workspace while requests, queued Saves or undo actions remain pending | Late results and writes cannot enter the new workspace; two tabs retain their own authorized selection through refresh. |
| Invoke every demo mutation through HTTP, RPC, tasks and tool APIs | Public reader is denied at the execution boundary, regardless of UI state or HTTP verb. |
| Run simulator and ordinary customer work concurrently | Only demo inputs/tasks change; no real external effect occurs. |
| Read exports, logs, task history, attachments and backup metadata | Tenant ownership remains intact outside normal database queries. |
| Exhaust public query or job budgets | Demo work is bounded without starving ordinary tenant activity. |
| Start a fresh standalone installation | The supported single-workspace path still works without a hosted account provider. |

This research makes no live migration, authentication activation or public
deployment claim. Those require concrete release evidence and the applicable
operator approval. Current work and acceptance remain in the beads hub, not in
a parallel checklist in this document.
