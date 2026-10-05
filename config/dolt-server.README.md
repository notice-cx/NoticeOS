# Dolt task-server configuration

Dolt hosts the authoritative Beads work model. Tasks and their history remain
separate from the Postgres measurement ledger; a completed task is not evidence
of a measured business outcome. The project/database mapping is described in
[beads.README.md](beads.README.md).

## New installations

The fresh-install path uses the pinned, authenticated Compose service in
[db/dolt/host](../db/dolt/host/README.md). It shares Postgres's explicit Compose
project while keeping a separate definition and persistent `dolt-data` volume.
Its only published address is `127.0.0.1` at the chosen Tower port plus three.
There is no implicit task-server port or global credential fallback.

The installation owns `dolt/profile.json`, generated private server secrets,
and the protected `dolt/credentials` Beads INI file. The profile declares paths
and a port, never passwords. Startup verifies the installed standalone Beads
CLI version before creating a fresh installation. Task bootstrap and ordinary
task commands use the declared server; they do not adopt an existing hub.

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
