# Connect a project to NoticeOS

This guide connects a website or software repository to your standalone
NoticeOS installation. It covers the asset in the product, its tasks on the
shared Dolt hub, repository access for people and agents, and its data sources.
Use it for a new project or an existing project whose checkout has moved.

The supported first-run path is [Run from source](../../README.md#run-from-source).
It provisions a new installation and its own task hub. The
[prepared application container](../../deploy/compose/README.md) consumes an
existing installation; adding container mounts and activating connections are
host-administrator actions. The [demo preview](../../deploy/demo/README.md)
uses synthetic assets and rejects real project or credential changes. Customer
account onboarding is outside this release.

## 1. Start your own installation

Install the prerequisites in the root README, then run these commands from
the NoticeOS source checkout:

```sh
pnpm install --frozen-lockfile
pnpm start
```

Open the address startup prints. The default installation folder is
`.local/start/` inside the NoticeOS checkout. A different `--dir` selects a
different installation; keep the chosen folder for the steps below.

The installation already has an internal NoticeOS task project. You do not
need the maintainers' task hub, credentials, databases or directory layout.
Reuse your installation's declared Dolt service when adding assets. Do not
run first-install setup against an existing store to adopt or migrate it.

## 2. Add the asset in the product

On **Home**, choose **Add your first site**; with existing sites, use **Add
site**. Give it a name and domain, and retain the asset id the product assigns.
Use that exact id for task membership and reports. For the examples below,
the asset id is `example.com`, its task prefix is `ex`, and its task database
is `ex_tasks`. These are three different identifiers.

Add or change installation settings in the Tower. The product's `config/`
files are generic defaults, and exported installation files are snapshots,
not the running settings.

## 3. Choose the task project you are connecting

Open **Settings → Task projects** and add the asset's prefix and database.
Choose an unused lowercase prefix of two to eight letters. Database names
start with a lowercase letter and use lowercase letters, digits or underscores.
Both must be unique in the saved project map. Existing projects keep their
established prefix, database and project identity.

Saving this row gives NoticeOS logical membership. It does not create a
database, grant access to a host directory, or configure an agent CLI.

### A new task database

Use the initialization command shown beside the saved project. On a fresh
Compose-backed source installation it calls `scripts/dolt-project.mjs`, using
the exact installation folder and checkout. An equivalent invocation from
the NoticeOS source checkout is:

```sh
node scripts/dolt-project.mjs --home /absolute/noticeos-installation --repo /absolute/project-checkout --prefix ex --database ex_tasks
```

The helper requires the pinned native Beads CLI named in
[source prerequisites](../../README.md#run-from-source), a running declared hub,
a clean Git checkout, no `.beads/` folder, and an absent database. It reserves
only the new database and initializes an external server-mode connection.
It preserves the repository's hooks and agent instructions, suppresses
automatic imports and Git operations, and refuses existing databases.
An agent's Docker `bd` wrapper is not a native initialization binary.

Review and authorize the exact new database before an agent runs this against
an existing installation. A failed or uncertain initialization needs explicit
recovery; preserve its files and database rather than retrying with `bd init`.
The helper does not migrate or merge existing task projects.

### An existing task database or relocated checkout

Do not run `bd init`. Establish the original service, database, prefix and
project identity. Restore only the project's connection metadata to its new
private `.beads/` folder and its safe `config.yaml`; never import an old JSONL
export or copy a local task database into it. Follow
[Moving a maintainer checkout](../../config/beads.README.md#moving-a-maintainer-checkout).

Moving a project between different task hubs is a separate migration with
capture and reconciliation, not repository setup. Preserve the old task
authority until that migration has its own evidence and approval.

## 4. Give NoticeOS and agents access to the checkout

There are separate access declarations. Complete the ones your installation uses:

| Declaration | What it enables | Where the owner sets it |
| --- | --- | --- |
| Asset, prefix and database | Which task project belongs to the asset | Tower: Settings → Task projects |
| Matching identifiers and repository path | Runner polling and local task actions in that checkout | Installation's protected `task-host.json` |
| Container mount for that repository | Makes the approved checkout visible inside the application | Prepared container's protected Compose configuration |
| Allowed checkout and task client | Agent CLI access to the existing hub | Native client environment or protected Docker agent plan |

For a source installation, add this entry to `repositories` in
`<installation-folder>/installation/task-host.json`, preserving existing entries:

```json
{
  "asset": "example.com",
  "prefix": "ex",
  "database": "ex_tasks",
  "repo": "/absolute/project-checkout"
}
```

The containing document is `{ "version": 1, "repositories": [...] }`.
Use the exact same three identifiers as the saved project. On a prepared
container, `repo` is the approved **container path**, such as `/spokes/example`,
and its private Compose configuration mounts the matching host checkout there.
The [host-link contract](../../config/task-host.README.md) and
[container guide](../../deploy/compose/README.md) own those details. Restarting
or changing an existing service requires its own scoped approval.

For a native CLI on a source installation, set the installation's credential
file before running task commands in the project checkout:

```sh
export BEADS_CREDENTIALS_FILE=/absolute/noticeos-installation/dolt/credentials
export BEADS_DOLT_AUTO_START=0
bd ready
bd list
```

The credential file stays private; do not paste its contents into source or a
terminal command. For a Docker agent adapter, use the
[bundled client declaration](../../db/dolt/host/README.md#native-capture-and-agent-compatibility)
and allow the exact host checkout in `spokes`. Preserve its accepted image,
network, credentials and other project paths. The adapter needs a private,
regular `.beads.gate.lock` file; the preparation command below creates it
when `.beads/` exists. Keep old wrapper binaries and recovery files while
active declarations still reference them.

## 5. Prepare the repository's working instructions

Run these from the NoticeOS source checkout:

```sh
pnpm project:prepare -- --repo /absolute/project-checkout --check
pnpm project:prepare -- --repo /absolute/project-checkout --write
```

The check reports proposed file changes without writing or contacting the
hub, a provider or NoticeOS. Explicit preparation:

- Creates or appends a marked NoticeOS section in `AGENTS.md`, preserving
  the project's existing instructions. An existing `CLAUDE.md` receives
  the same section; an absent one stays absent.
- Copies the [canonical task rules](../../config/beads.README.md#the-spoke-stanza)
  and links to this NoticeOS checkout's contract. Conflicting existing task
  instructions require manual review and are never replaced automatically.
- Excludes `.beads/` and `.beads.gate.lock` from Git. Already tracked task
  connection files cause a refusal; resolve that explicitly before preparing.
- Creates the private shared lock for an existing `.beads/` connection.
  It does not initialize or change that connection.

Review the resulting Git diff. Add the project's business goal, architecture,
verification commands, protected operations and dated `STATE` to its context
pack, following [the site context mapping](../09-onboarding-a-site.md#agentsmd-mapping-before-a-builder-touches-the-site).
Review current measurement windows: each active one is an open readback task
naming its surfaces, change and dates ([doc 03](../03-attribution.md)).
Commit the intended repository instructions under that project's
own Git policy; do not commit local connections or credentials.

When the NoticeOS source checkout moves, review the relative contract link in
the marked context section. Preparation refuses a changed block, so a moved
pointer cannot silently replace project rules.

## 6. Connect data sources and reports

Open the asset's **Data sources** page. Connect the providers it uses and match
the exact properties or sites to this asset. Credentials belong in NoticeOS
Integrations and are encrypted in its store. Refer to
[integration setup](../11-integrations.md) for provider-specific permissions.

For a product with server-observable activity, implement its report under
[the signal contract](../02-signal-contract.md) and the
[bootstrap credential boundary](../06-operations.md#bootstrap-secrets-vs-integration-credentials).
Keep external analytics collection central; an asset does not query providers
about itself. Adding instrumentation, report authentication or production
deployments requires explicit owner review. A task connection alone supplies
coordination, not traffic or revenue evidence.

Agent work remains manual in this release. This setup grants no automatic
deployment authority, and the future agent pause check is unavailable.

## 7. Verify the connection once

Before checking an existing production installation, obtain approval for the
exact reads and any task writes. Automated tests use disposable fixtures.

1. From the asset checkout, `bd ready` and `bd list` answer from the declared
   hub. For an established project, `bd show <known-id>` returns a known task
   with its original prefix. A new empty database may correctly return no tasks.
2. The Tower's **Tasks** page shows this project with the correct asset and
   a fresh successful snapshot. Resolve “needs local setup” against the host
   link and mounts; resolve CLI refusal against the agent declaration.
3. Claim genuine work with `bd update <id> --claim --actor <your-agent>`.
   Its recorded owner and project match what the Tower shows. Do not file
   synthetic test tasks in a live hub to prove setup.
4. The asset's **Overview** or **Data sources** shows the first real reading
   for its matched source. An absent reading stays pending or unknown, never zero.
5. The repository's instructions are committed; task
   connections and credentials are untracked. An existing project retains
   its previous task history, project identity and measurement windows.

For CLI errors, never start an alternate Dolt server, run `br`, or use
`bd dolt push/pull` as a repair. Follow the installation's declared service
and [recovery procedure](../../db/dolt/host/README.md#backup-and-recovery).
