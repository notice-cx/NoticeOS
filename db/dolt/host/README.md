# Installation-local Dolt task server

This is the authenticated task server for a **new** NoticeOS installation.
It does not migrate or adopt an existing task hub. Postgres remains the
measurement ledger; Beads tasks are the shared work model, not measured outcomes.

`compose.yaml` pins stable Dolt **2.4.0** by image-index digest, including
Linux amd64 and arm64. The application backend bundles Beads **1.3.1**;
operators manage work through NoticeOS. Host-side development helpers check
the same Beads version before creating a new task project. See the official
[Dolt 2.4.0 release](https://github.com/dolthub/dolt/releases/tag/v2.4.0) and
[Beads 1.3.1 release](https://github.com/gastownhall/beads/releases/tag/v1.3.1).
These were the latest stable releases verified on 2026-09-30. Pin changes
do not authorize upgrades of existing databases or their running services.

## Hosting and credentials

The Dolt definition is separate from [Postgres Compose](../../postgres/host/README.md).
Both use the explicit `noticeos-start-<installation-hash>` project. Dolt commands
name only this Compose file and its `dolt` service; they do not change Postgres's
definition or `postgres-data` volume. `dolt-data` persists database repositories,
SQL privileges, branch controls and server configuration across container replacement.
The service restarts independently of the OS runner and has an authenticated
`SELECT 1` health check. SQL events are disabled.

Only `127.0.0.1:<Tower port + 3>` is published. Container port 3306 is not an
operator endpoint. The helper refuses known default/managed ports and remote
Docker contexts before any project contact. Every resource call names the
declared project, service or volume; no Docker inventory search is performed.

`scripts/dolt-host.mjs` exposes read-only `preflightDolt`, fresh-only
`prepareFreshDolt`, and `readDoltProfile`. First setup generates separate random
owner and task-client passwords in installation-local `dolt/secrets/{root,noticeos}`,
and a `dolt/credentials` INI file, all mode 0600. The owner SQL user is
`noticeos_owner@localhost`; the Beads client is `noticeos@%`, with the database
creation privileges needed to initialize new task projects. Default root access
is removed before the listener opens. Passwords never enter command arguments
or command output.

The mode-0600 `dolt/profile.json` has exactly these non-secret fields:
`project`, `composeFile`, `secretsDir`, `credentialsFile`, and `port`.
Runtime profiles may declare an existing installation's named Compose project,
so Dolt and Postgres can appear in one stack. This does not move a running
service: consolidation requires separate maintenance, the existing volume
must be explicitly retained, and the host client and backups must use the
updated declaration. Fresh setup and both restore helpers accept only an
isolated generated project; they cannot initialize a shared stack. An operator
can still add a new task project to its declared hub, with an atomic empty
database reservation that refuses every existing database.
`doltEnvironment(profile, env)` removes inherited database credentials and Beads
selectors, sets an isolated client HOME and the exact `BEADS_CREDENTIALS_FILE`,
and disables Beads telemetry and automatic server startup. Docker's explicitly
selected local client configuration remains separate from Beads's HOME.

A native application can select an independent prepared task service with
`NOTICEOS_DOLT_HOME`: the absolute installation folder containing
`dolt/profile.json`. The shared [task client](../../../scripts/task-client.mts)
derives the runner and Tower's Beads commands and hub health checks from that
profile; the [backup pipeline](../../../scripts/host-backup.mjs) captures the
same declared service. Do not also set `NOTICEOS_TASK_CLIENT_PROFILE`: two
independent service declarations are refused. A missing or malformed selected
profile fails explicitly, including backups; it never selects the legacy hub.
Omitting the selector preserves the existing fresh-install and native behavior.

The fresh project helper injects the generated password into **one init child**
through its environment. Subsequent commands use the protected INI alone.
Never place a password in the saved project metadata, a setup command, or the
Tower's environment.

A repeated start requires the declared service and volume to exist. Missing
persistent data is an explicit recovery condition; ordinary startup never
regenerates credentials, adopts a volume, or initializes a replacement database.

## Backup and recovery

`backupDolt(profile, databases, outputDirectory)` in
[`scripts/dolt-backup.mjs`](../../../scripts/dolt-backup.mjs) takes online
`DOLT_BACKUP('sync-url', ...)` snapshots into a unique container-private staging
directory, then copies the completed snapshots to a new private host directory.
It never stops the task hub or copies live chunk files. Existing output is refused.
Each database snapshot includes branches, commits and uncommitted working sets;
different databases are captured **sequentially**, not as one atomic portfolio
snapshot. See [Dolt's backup guidance](https://www.dolthub.com/docs/sql-reference/server/backups/).

Non-versioned permissions and configuration need separate custody. The helper
captures `privileges.db`, optional `branch_control.db`, server/global config,
and each database's config and repository state before and after the snapshots.
The two generations must match byte for byte, including missing-versus-present
state. Pinned Dolt atomically replaces these files: the [privilege persister](https://github.com/dolthub/dolt/blob/v2.4.0/go/libraries/doltcore/sqle/mysql_file_handler/file_handler.go)
uses atomic writes, and [branch controls](https://github.com/dolthub/dolt/blob/v2.4.0/go/libraries/doltcore/branch_control/branch_control.go),
[repository state](https://github.com/dolthub/dolt/blob/v2.4.0/go/libraries/doltcore/env/repo_state.go)
and [configuration](https://github.com/dolthub/dolt/blob/v2.4.0/go/libraries/utils/config/file_config.go)
use the [filesystem's atomic WriteFile](https://github.com/dolthub/dolt/blob/v2.4.0/go/libraries/utils/filesys/localfs.go).
A concurrent metadata change refuses completion rather than publishing a partial set.

The backup also contains protected local credentials and its non-secret source
profile under `metadata/`. All files are mode 0600; keep the containing directory
private. `backup.json` records pinned format/version, database names, metadata
presence and every file's size/hash, and is written last. Failed staging cleanup
invalidates completion. The host backup pipeline publishes and prunes only after
this and its other stages succeed.

The [host claim](../../../scripts/backup-claim.mjs) records a verified kernel
process namespace before a backup writes or publishes anything. Only a dead
owner in that same namespace can be recovered automatically. Legacy, unknown
or foreign claims fail the recorded backup with an explicit recovery message
and remain untouched. Fence backup writers and prove the originating worker
or service has stopped before deliberately clearing that exact claim. Neither
its age nor a PID check from another container proves it safe to remove.

`restoreDolt(newProfile, backupDirectory)` verifies that complete inventory before
any Docker call. It then requires the exact destination service, volume and local
setup files to be absent. It restores each database with the pinned `dolt backup
restore` CLI, restores matching permissions/configuration and credentials, rewrites
the INI endpoint to the new port, and only then opens the listener. There is no
overwrite or `--force` path. A failed restore preserves the new resources for
explicit recovery; do not retry ordinary startup over partial data.

An operator can invoke these APIs from the repository root after approving the
exact source and destination. Declare `NOTICEOS_DOLT_HOME` and
`NOTICEOS_DOLT_BACKUP` as absolute owned paths, and list the configured databases:

```sh
node --input-type=module -e 'import {readDoltProfile} from "./scripts/dolt-host.mjs"; import {backupDolt} from "./scripts/dolt-backup.mjs"; const p=readDoltProfile(process.env.NOTICEOS_DOLT_HOME); if(!p) throw Error("No declared task profile"); await backupDolt(p,["noticeos_tasks"],process.env.NOTICEOS_DOLT_BACKUP);'
```

For recovery, create a new empty owned destination home, set its absolute path
in `NOTICEOS_DOLT_RESTORE_HOME`, and choose a free Tower base port in
`NOTICEOS_DOLT_RESTORE_PORT` (the helper derives the task port plus three):

```sh
node --input-type=module -e 'import {startDoltPlan} from "./scripts/dolt-host.mjs"; import {restoreDolt} from "./scripts/dolt-backup.mjs"; const p=startDoltPlan({root:process.cwd(),home:process.env.NOTICEOS_DOLT_RESTORE_HOME,port:Number(process.env.NOTICEOS_DOLT_RESTORE_PORT)}); await restoreDolt(p,process.env.NOTICEOS_DOLT_BACKUP);'
```

This restores **task databases and server authentication**, not an entire runnable
NoticeOS installation. Full recovery also needs Postgres and bootstrap secrets,
the installation's `beads.json`/`task-host.json`, `dolt/core.json`, and each task
repository's `.beads` project metadata. Restore or deliberately reconstruct those
identity links before starting the OS; copying a source profile alone does not
repair them. Configure a separate recovery spoke against the new endpoint and
confirm task IDs, history and authenticated reads/writes before any cutover.

## Existing-hub migration metadata

Existing hubs move through a separately approved migration
(`ro-ujb9.9.1`), not fresh setup. The source version, database identities,
permissions and spoke links must be known before selecting a capture or
cutover procedure. Do not manufacture a managed profile around the native
server, attach its data directory to Compose, or initialize imported projects.

[`dolt-migration-inspect.mjs`](../../../scripts/dolt-migration-inspect.mjs)
provides a bounded **filesystem-only** inventory. After approval for the exact
installation paths, run from the repository with explicit absolute paths:

```sh
node scripts/dolt-migration-inspect.mjs --repo-root /absolute/noticeos --installation /absolute/noticeos/installation --maps-only
```

This opens only `task-host.json`, `beads.json` and `dolt-server.yaml` in the
named installation directory. It selects the declared listener, account name,
configuration/data path names and asset/prefix/database/repository mapping;
it never opens the named data or configuration destinations. It reports the
exact candidate `.beads/metadata.json` and `.beads/config.yaml` paths without
opening or inspecting any spoke directory. The exported project membership is
explicitly **not verified against the live configuration store**.
Asset ids can include domain names. A relative exported `hub.dataDir` is
reported verbatim and resolved against `--repo-root`; neither path is opened.
Native server paths are also retained verbatim. Absolute server paths receive
a resolved pathname; relative server paths have a null resolution because
the service's working directory has not been established by this inventory.

For a separately approved inspection of those exact spoke files, replace
`--maps-only` with one `--spoke /absolute/checkout` argument per declared
physical project. The approved paths must match the complete host inventory
before any spoke read. Retired physical projects remain in the inventory.
Only server connection selectors, project identity and the three Beads safety
settings are emitted; `sync.remote` reports presence without its potentially
credential-bearing URL. Authentication files, task bodies and unknown fields
are never emitted. Omitted spoke selectors and project identity are null,
never filled from CLI defaults or inherited environment settings. Explicit
selector conflicts are refused. Missing/malformed files, mismatched declarations, oversized
files, symlinks and linked directory ancestors refuse with generic diagnostics.
Supported YAML uses block mappings and simple scalars; unsupported selected
syntax requires explicit review, never a guessed value.

The command has no default paths, service probes, SQL, Docker, credential lookup,
subprocesses or writes. Keep its metadata output private. Reading production
installation or spoke files still requires approval for that exact scope; this
command does not authorize it. SQL inventory, protected source snapshots and a
maintenance cutover each require their own explicit scope after the target is
established. `node --test scripts/dolt-migration-inspect.test.mjs` verifies the
scope and refusals using synthetic temporary files only, including a real CLI
run with poisoned inherited selectors and an unchanged filesystem receipt.

### One follow-up inventory batch

[`dolt-migration-inventory.mjs`](../../../scripts/dolt-migration-inventory.mjs)
consumes a protected JSON receipt from the approved maps-only read. It never
rereads the three installation declarations. Review the exact spoke filenames
and fixed query list first; `--describe` reads only the supplied receipt:

```sh
node scripts/dolt-migration-inventory.mjs --receipt /absolute/private/maps.json --describe
```

After approval of the named spoke files and SQL endpoint, one invocation reads
the exact `.beads/metadata.json` / `.beads/config.yaml` pair per declared project
and issues only metadata `SELECT` statements through an explicit local Dolt
client. Give that client its own empty working directory and HOME, mode 0700:

```sh
node scripts/dolt-migration-inventory.mjs --receipt /absolute/private/maps.json --dolt /absolute/bin/dolt --client-home /absolute/private/client
```

The selected endpoint and account come only from the receipt. The client uses
an explicit empty password; an authentication failure stops at the version
query and never discovers credentials or retries another account. Inherited
client, Beads, database and Docker settings are absent from its environment.
Client activity can create files only in its separately owned working folder.
Before any spoke or SQL access, the command requires this directory to be
empty, owned by the current user, private to that user and free of symlinks,
including its ancestors. It reads only directory entry names to establish
emptiness; it never opens ambient client configuration. `XDG_CONFIG_HOME` also
points into that directory. Every client process receives
`DOLT_DISABLE_EVENT_FLUSH=1`, the [Dolt client source's outbound telemetry control](https://github.com/dolthub/dolt/blob/v2.2.0/go/cmd/dolt/dolt.go#L187).
The [usage-event path](https://github.com/dolthub/dolt/blob/v2.2.0/go/cmd/dolt/dolt.go#L828)
allows local event files while preventing their upload.

The query list includes server version/current account, database names,
account names/hosts, structured privilege fields, declared databases' table,
column and index summaries, branch/tag heads, commit counts, working status
and branch permissions. Counts visit at most 64 ordinary base tables per
declared database; other databases contribute names and grant metadata only.
Schema defaults, comments, view definitions, authentication columns, task text,
commit messages and authors are never selected. No `SHOW GRANTS`, procedures,
snapshots, service changes or writes are issued.

The [version function](https://www.dolthub.com/docs/sql-reference/version-control/dolt-sql-functions/#dolt_version),
[system tables](https://www.dolthub.com/docs/sql-reference/version-control/dolt-system-tables/)
and [branch permission tables](https://www.dolthub.com/docs/sql-reference/server/branch-permissions/)
are documented Dolt interfaces. [Access management](https://www.dolthub.com/docs/sql-reference/server/access-management/)
documents the separate account/grant store. Unsupported metadata on an older
source version is reported as unavailable, with no guessed replacement.
The receipt distinguishes a completed batch from complete metadata; neither
is a consistent migration snapshot. Concurrent writers may change sequential
counts or heads. A cutover still needs its own quiescent final capture.

Each query has a 20-second timeout, a 4-MiB output limit and a 4096-row limit;
the entire SQL batch stops after five minutes. Tests never connect to an
installed source. `node --test scripts/dolt-migration-inventory.test.mjs`
uses synthetic files and a fake transport. The separately enabled
`NOTICEOS_TEST_DOLT_INVENTORY=1 NOTICEOS_TEST_DOLT_CLIENT=/absolute/bin/dolt node --test scripts/dolt-migration-inventory-compose.test.mjs`
owns a new Compose project/volume at loopback port 5343 and removes only its
own resources. It qualifies the query shape on pinned Dolt, not compatibility
with an uninspected native source version.

## Native capture and agent compatibility

[`dolt-migration.mjs`](../../../scripts/dolt-migration.mjs) takes one private,
owned plan file. `describe` reads that plan only:

```sh
node scripts/dolt-migration.mjs describe --plan /absolute/private/plan.json
```

The explicit `capture`, `verify` and `restore` operations use the same plan.
Capture requires the named Homebrew service stopped and unloaded, plus a
separately established fence on every writer. It never stops services or calls
SQL. The `noticeos-native-dolt-capture-v1` format retains the complete source
tree, including every database, branch, tag, committed/staged/working state,
permission store, empty directory and declared metadata file or absence.
Hashes cover every byte; the completion marker is written last. Restoring a
changed capture or an existing target is refused. The qualified pair is source
2.2.3 to target 2.4.0; original files and the capture remain unchanged while
new target credentials are installed offline. Beads schema migration and
connection changes are separate explicit maintenance operations. This avoids
the source 2.2.3 [`DOLT_BACKUP` working-set persistence](https://github.com/dolthub/dolt/blob/v2.2.3/go/libraries/doltcore/sqle/dprocedures/dolt_backup.go#L285).

For the verified Homebrew alias transition only, keep `capture.service.name`
as `dolt` and `capture.service.label` as `homebrew.mxcl.dolt`. Add
`capture.service.aliasTransition` with `stoppedLabel: "sh.brew.dolt"`,
`userId` equal to the operator's numeric UID, `originalPlistName` naming a
required `capture.files` entry, and `originalPlistSha256` containing its exact
SHA-256. That entry must be a private, owned saved plist outside the source
directory, with the original `Label`, and cannot be a symbolic or hard link.
`describe` exposes the additional
read commands. Capture requires the canonical service stopped and the original
label absent in both `gui` and `user` domains before and after copying; unrelated
errors are refused. Verification binds both proofs and the copied plist hash
to the plan. Other alias pairs are unsupported.

[`host-beads.mjs`](../../../scripts/host-beads.mjs) is an optional agent adapter
for the application's bundled Beads client. Its protected declaration pins a
local image ID, target network, credentials, allowed projects and fallback actor.
Explicit `--actor` and caller `BEADS_ACTOR` retain the caller's identity. It mounts
the selected project's `.beads` folder and shared `.beads.gate.lock`, works while
the application is stopped, and uses no host `bd` fallback:

```sh
node scripts/host-beads.mjs --plan /absolute/private/agent-client.json -- list --json
```

The host adapter forwards one explicit text input per command, up to 1 MiB:

| Command | Forwarded input flags |
| --- | --- |
| `comments add` | `--file`, `-f` |
| `comment` | `--file`, `--stdin` |
| `create`, `new`, `update` | `--body-file`, `--description-file`, `--design-file`, `--stdin` |

A file value of `-` reads piped stdin. Other paths resolve from the selected
spoke, including an explicit `-C` selection. Files must be readable regular
files without symbolic or hard links. Parent aliases such as `/tmp` are resolved
before checking the file. Missing,
oversized, conflicting or ambiguous input is refused before Docker contact.
Use `--flag=value` for other value options not recognized by the adapter;
unrecognized bare options cannot be combined with forwarded input. A real
`--` ends option handling in these recognized command contexts; consumed string
values remain literal. Other commands and unproven option syntax retain the
strict target-selector guard, including selector-shaped tokens after `--`.
No input is
read by default. Exact file bytes travel through stdin without additional
host mounts or content in argv/environment. The pinned Beads client retains
its own text handling, including `comment --stdin` newline trimming, and its
exit status and output.

`node scripts/host-beads.mjs prepare --plan /absolute/private/prepare.json`
creates a new private wrapper folder from an existing target profile. It never
replaces the user's host CLI or changes PATH. Those changes, and creation of
any missing project lock files, belong in the explicit maintenance plan.

## Disposable proof

`node --test scripts/dolt-host.test.mjs` uses process-boundary mocks and temporary
files. The opt-in integration test needs local Docker Compose, Beads 1.3.1, and
a host Dolt SQL client, with a sanitized tooling environment:

```sh
NOTICEOS_TEST_DOLT_COMPOSE=1 node --test scripts/dolt-host-compose.test.mjs
```

It uses only new temporary homes/projects and task ports 5343/5347. It checks
root/empty-password refusal from host and container, actual Beads records/events,
committed and working history, container replacement, complete online backup,
permissions/branch controls, and independent restore/read/write. Exact owned
containers and volumes are removed on exit; the existing hub is never contacted.

`NOTICEOS_TEST_DOLT_PRESERVATION=1 node --test scripts/dolt-migration-preservation-compose.test.mjs` additionally verifies
two databases, tags, committed history, and distinct staged/working changes
on every branch. It runs current-version recovery and a synthetic
2.2.3-to-2.4.0 restore, preserving SQL grants, branch rules and the source
rollback copy. The older source image opens only newly generated synthetic
data. This proof uses a separate source definition and a new target volume;
it never relabels an older backup as a current backup or relaxes the managed
restore version check. Current managed backups still require an exact matching
image/version marker. Existing-version migration and schema upgrades need
their own protected capture, reconciliation and approved cutover procedure.

`NOTICEOS_TEST_DOLT_COLD=1 node --test scripts/dolt-migration-cold-compose.test.mjs`
checks stopped-source capture and target-only authentication adaptation against
the shared Compose definition. `scripts/host-beads-compose.test.mjs`, enabled
with `NOTICEOS_TEST_HOST_BEADS=1` and explicit qualification image/binary paths,
proves bundled client task actions without an application service. Both use
generated data and their own disposable projects; neither contacts an installed
hub. Verification receipts (private historical evidence)
record exact commands and source hashes.

`NOTICEOS_TEST_BEADS_UPGRADE=1 node --test scripts/beads-upgrade-compose.test.mjs`
qualifies Beads 1.1.2/schema 53 to 1.3.1/schema 66 on generated tasks, using
explicit `NOTICEOS_TEST_BEADS_OLD_BIN`, `NOTICEOS_TEST_BEADS_NEW_BIN` and
immutable `NOTICEOS_TEST_BEADS_IMAGE` inputs. It uses ports 5363/5367 and
checks both no-remote and owned mock-remote targets. The remote-backed unforced
command must refuse with every table, root and history reference unchanged.
One designated `--sandbox migrate schema --force --json --actor <actor>` then
migrates the copied target; a reachable mock listener observes no migration or
push contacts, even with auto-push enabled. Source data remains unchanged.

`pnpm test:task-store` runs the hosted task store proofs (epic `ro-cvl9`): the
fixed executor's qualification, two executors racing one claim, and a create
and comment retried after a lost reply. On a Linux host with Docker,
`node scripts/task-store-test-tools.mjs --out <new folder>` prepares their
inputs: the task and Dolt clients `deploy/compose/Dockerfile` pins, verified
against its digests, the pinned server image and a new evidence folder. It
prints the variables to export. CI's `task-store` job runs both.

`NOTICEOS_TEST_KEEP_BEADS_EVIDENCE=1` retains complete redacted command results,
qualification and cleanup receipts in the reported private fixture directories.
Failed qualification retains its evidence; uncertain process or cleanup state
also preserves resources. A live schema upgrade requires separate approval for
the exact target, writer fence and single designated migrator. `--force` is an
explicit maintenance choice, never ordinary startup or automatic retry policy;
qualification does not authorize a remote push, pull or live migration.
