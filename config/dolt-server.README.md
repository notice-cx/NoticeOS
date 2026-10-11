# Dolt task-server configuration

Dolt hosts the authoritative Beads work model. Tasks and their history remain
separate from the Postgres measurement ledger; a completed task is not evidence
of a measured business outcome. The project/database mapping is described in
[beads.README.md](beads.README.md).

## New installations

`pnpm os:setup` runs the pinned, authenticated Compose service of
[db/dolt/host](../db/dolt/host/README.md) as the stack's `dolt`, in the stack's
Compose project, with its own definition and `<project>_dolt-data` volume. The
app reaches it as `dolt:3306`; its only published address is `127.0.0.1:3306`
(the next free port if taken). There is no implicit task-server port or global
credential fallback.

The installation folder holds the server's generated passwords in
`dolt-secrets/`, and the task client's declaration and protected Beads
credentials in `state/` (`task-client.json`, `dolt/credentials`). A declaration
names paths and a port, never passwords. The app image bundles the pinned Beads
CLI. Task bootstrap and ordinary task commands use the declared server; they do
not adopt an existing hub.

The server's SQL listener runs independently of the OS runner. A runner restart
does not stop it. Online backups preserve declared databases, branch and working
history, privileges, branch controls, server configuration and local credentials.
The [hosting recovery procedure](../db/dolt/host/README.md#backup-and-recovery)
explains the database snapshot's boundary and the other files required for a
complete NoticeOS installation recovery.

## Existing installations

An installation may still declare an independently managed host server through
`installation/dolt-server.yaml`. That file is installation data, not a product
default. Its host-specific paths, listener and service management stay under the
operator's control. Fresh Compose setup never reads, mounts or replaces that
server's data, configuration or credentials.

Changing an existing hub, grants or service is a separate operator-authorized
cutover. Do not copy a host configuration into the new Compose volume or use
the fresh installer to adopt it. Tests use synthetic configurations and owned
temporary services; they never inspect the installed Homebrew configuration.
