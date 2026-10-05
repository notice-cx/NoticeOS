# Release and upgrade policy

Reviewed: 2026-10-04.

NoticeOS release evidence identifies the source commit, toolchain, schema and
the checks actually executed. A package version or successful build alone does
not establish a qualified release. Package metadata alone does not state a
support or upgrade guarantee.

## What can be installed today

The [source installation](../README.md#run-from-source) starts a new, empty
standalone installation with Postgres and a Dolt task hub. Existing
installations require their own configuration and maintenance procedures.
Standalone access relies on a trusted network or access layer; it is not a
public login-protected hosted product.

The [application container](../deploy/compose/README.md) starts an already
prepared installation. It does not initialize or migrate either database.
Its declared platform and fixture checks are evidence for those exact inputs,
not a promise that every host or architecture has been exercised.

Hosted identity, scoped browser/task APIs and journaled scheduling have local
disposable qualification. The
[operator runtime instructions](../scripts/README.md#hosted-runtime-composition-and-recovery)
name the implemented explicit compositions and their limits.

The [portable demo profile](../deploy/demo/README.md) packages the compiled app,
Postgres and Dolt for a Linux server or VM behind an HTTPS reverse proxy. It
creates one synthetic workspace in new, empty stores. Anonymous visitors have
read-only access; a separately admitted simulator updates that workspace.
It does not activate customer signup, mail delivery or provider integrations.
The gateway fixes the demo profile and public origin in private server
configuration; the checked-in general Worker profiles remain standalone.

This is a preview hosting profile, with pinned workerd/Miniflare runtime
dependencies. Qualify the exact image and platform, fresh setup, browser
requests, restart and restore before routing public traffic. The demo guide
provides a stopped-stack backup procedure; recurring hosted backups are tracked
in `ro-ujb9.256.23`. Local qualification does not establish a deployed domain or
production availability. Customer account hosting remains outside this release.

## Qualify a release candidate

Record an immutable source commit and verification receipts. Use the locked
dependency graph and the declared tool versions. All five
[CI gates](../CONTRIBUTING.md#run-focused-checks-then-the-release-gates) must pass;
the evidence must name skipped tests and separately qualified deployment paths.
Changes to database, task, backup or hosted behavior need the relevant
disposable integration and recovery proofs as well.

Describe compatibility against the installation's actual schema and runtime.
An additive migration still needs explicit verification of app versions eligible
for rollback. New hosted authorization behavior cannot be assumed to exist in
an older standalone release. A candidate handling non-USD ledger rows must also
qualify the exact rollback app against that state; a prior app that assumes USD
is not a compatible rollback merely because the schema is unchanged.

## Upgrade an existing installation

Before an upgrade, identify the running commit, pending frozen migrations and
the target release's instructions. Preserve a backup with a tested restore
path for the operational store, task hub and configured archives. Use the
[backup and restore procedure](../scripts/README.md#backups--restore) for the
installation's declared transport.

Applying schema changes to an existing installation is a separate operator
step. A restart, source merge or app deployment never applies migrations.
Follow [Postgres maintenance](../db/postgres/README.md#applying-it-to-an-installations-own-database)
for the exact target and approval. Do not edit applied migrations or adopt an
existing database through fresh-install setup.

The [local deployment adapter](../scripts/README.md#merging-is-not-deploying--pnpm-osdeploy)
switches runtime copies and checks migration compatibility. App rollback keeps
the updated database; it does not reverse a migration. Restore and database
engine upgrades have separate procedures and must not be inferred from an app
rollback command. The office Mac adapter is not a general hosted upgrade API.

Hosted activation additionally records the exact server profiles and origin,
identity/mail/edge bindings, scoped service grants and executable registries,
physical task allocations, private persistence and archive destinations. Qualify
remote PostgreSQL connectivity/TLS, task transport and backup/restore for that
same target before claiming support. The portable demo keeps PostgreSQL inside
its private Compose network and shares a network namespace for app-to-Dolt
loopback transport. It does not qualify remote database services. Customer
hosting and other transports need their own qualification; the office Mac
deployment adapter is not a remote release mechanism.

Retain occurrence journals across app changes and rollback. An uncertain
outside effect remains halted after restart; app rollback does not authorize
resetting a checkpoint, generating a new occurrence ID or replaying delivery.
A separately reviewed recovery plan must reconcile the exact destination and
journal evidence. See the
[recovery states](../scripts/README.md#journal-inspection-and-uncertain-effects).

## Publication and reporting

The license is [AGPL-3.0-only](../LICENSE), copyright 2026 Reindex Ventures LLC.
Preparing these materials does not publish a repository or activate a service.
The intended public repository is a new export without this private
repository's history or installation records. Its current files, defaults,
documentation, screenshots and dependency licenses still require review before
publication.

The [container source allowlist](../deploy/compose/README.md) excludes private
build inputs; it is not a complete public-repository export or a secret audit.
Private recovery archives and actual installation evidence stay private.

To prepare the reviewed public file set, use the
[committed-source exporter](../scripts/README.md#prepare-public-source).
It takes an immutable full commit hash and creates a new directory outside
the checkout, with a file manifest and no Git history. It does not publish,
sanitize content or qualify a release. Review that exact exported tree and
its nested public archive, scan for private data, and execute the release gates
before creating or publishing a history-free public repository.

No response-time or long-term maintenance commitment is established here.
Report vulnerabilities privately using the contact and instructions in the
[security policy](../SECURITY.md).
