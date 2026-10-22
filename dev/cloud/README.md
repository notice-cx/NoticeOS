# Cloud development setup

These scripts prepare an isolated development host for the checked-out
NoticeOS revision. `deploy/compose/Dockerfile` builds the application image;
it does not configure an agent's development host.

## Supported host

The native-tool installer supports Debian 13 on Linux x86_64, running as the
non-root user who owns the checkout. It requires Bash, Python 3, npm, Git,
curl, tar, APT, dpkg, util-linux (`flock`), `ldd`, and `docker-init` or
`tini`. The first install copies PostgreSQL 18 out of its pinned image, so it
also needs the Docker CLI and the local Docker socket; `--task-store` needs
both again, with Docker Compose. The relocated PostgreSQL build uses the
Debian 13 system libraries. Other operating systems should use the source
prerequisites in [CONTRIBUTING.md](../../CONTRIBUTING.md).

Preparation and verification require at least 12 GiB free on the affected
storage before starting. Keep at least 8 GiB available during heavy work.
The host must permit subprocesses, loopback TCP, Unix sockets and owned
fixture cleanup. Docker fixtures use the local development daemon at
`/var/run/docker.sock`; the scripts clear remote endpoint selectors only for
those operations and retain Docker registry authentication.

## Prepare after checkout

From the repository root:

```sh
bash dev/cloud/install.sh
```

This installs relocated PostgreSQL 18, SQLite and a checksum-verified GitHub
CLI, then runs `prepare.sh` with the same arguments. PostgreSQL 18 is the only
supported major. PostgreSQL launchers select their own native libraries,
including in sanitized child environments. The PostgreSQL image digest and
GitHub CLI release are infrastructure pins in `install.sh`. Update them
deliberately when the supported native toolchain changes.

After changing revisions or dependency inputs, run:

```sh
bash dev/cloud/prepare.sh
```

By default preparation installs the pinned Node and pnpm and the frozen
dependencies, and nothing else: it downloads no browser, task tool or Docker
image. A session adds only what its tests start:

| Argument | Prepares | Downloads |
| --- | --- | --- |
| none | Node, pnpm and the frozen dependencies | only packages missing from the caches |
| `--browser` | the journeys' pinned Chromium, checked with `ldd` | Chromium when its Playwright version is not cached |
| `--with-deps` | `--browser`, plus Chromium's Linux libraries | system packages; Playwright may need administrator access |
| `--task-store` | the task and Dolt clients `deploy/compose/Dockerfile` pins, and the Dolt server image | both clients and the image when not cached |

`install.sh` and `codex/setup.sh` pass these arguments through. Provision the
browser's system packages during image preparation and omit `--with-deps`
when the image already has them. `--task-store` prepares the tools through
`scripts/task-store-test-tools.mjs`, which uses only synthetic test resources.

Preparation reads the exact Node version from CI and pnpm from
`package.json`, and checks the Node engine constraint. Unsupported pin formats
fail explicitly. The dependency key includes the lockfile, workspace
manifests, platform and toolchain. A changed key or failed pnpm preflight
triggers a separate `pnpm fetch` followed by an offline
`pnpm install --frozen-lockfile`. Valid modules are reused. The repository's
`verifyDepsBeforeRun: error` remains enabled.

The installed Playwright package selects Chromium through `journey:install`.
Its versioned cache is linked at the repository's `JOURNEY_BROWSERS` location
when no real cache directory already exists. Installation and execution use
that same location. Existing real browser-cache directories are retained. A
browser journey, flow walk or audit needs `--browser` once per checkout and
again after the pinned Playwright version changes.

## Caches

Each preparation step owns its folders below `NOTICEOS_CLOUD_CACHE`. After it
succeeds, it removes the download and staging files nothing reads again, and
keeps what a prepared checkout runs from and the versions earlier revisions
use.

| Folder | Owner | Kept | Removed after success |
| --- | --- | --- | --- |
| `tools/toolchains/<key>` | `prepare.sh` | one Node and pnpm per pin | npm's download cache, `npm/` |
| `pnpm-store` | `prepare.sh` | one content-addressed store for every revision; `node_modules` hard-links its files | the fetch staging folder, `fetch/`, and per-key stores of earlier setup versions, `pnpm/` |
| `browsers/playwright-<version>-<arch>` | `prepare.sh --browser` | one folder per Playwright version | nothing; Playwright removes its archives |
| `task-tools/<key>` | `prepare.sh --task-store` | the two verified binaries and `runtime.env`, one set per pin | the release archives; an attempt without `runtime.env` |
| `tools/postgres`, `tools/sqlite`, `tools/github-cli` | `install.sh` | the extracted tools | APT lists and packages, the CLI archive and checksums |

A `task-tools/<key>` set is keyed on the pinned clients and server image
(`node scripts/task-store-test-tools.mjs --key`), so an unrelated Dockerfile
change reuses it. Docker images belong to the daemon; preparation never
removes one.

## Run tests

One launcher activates the prepared tools for each command:

```sh
bash dev/cloud/test.sh pnpm --filter @noticeos/contract test
bash dev/cloud/test.sh pnpm test:scripts
bash dev/cloud/test.sh pnpm --filter @noticeos/tower run typecheck:journeys
bash dev/cloud/test.sh pnpm --filter @noticeos/tower run test:journeys --list
bash dev/cloud/test.sh --task-store pnpm test:task-store
```

The launcher never installs dependencies or tools. It requires an explicitly
prepared checkout, preserves pnpm's dependency checks, and supplies
`NOTICEOS_TEST_PNPM_EXECUTABLE`, PostgreSQL 18 on `PATH` and
`NOTICEOS_REQUIRE_POSTGRES=1`. `--task-store` adds the prepared task tools'
variables and stops when `prepare.sh --task-store` has not run for the
current pins. It sets `umask 022` in the test process tree, preserves
explicitly private file modes, and runs the command under a subreaper. Each
invocation has private HOME, XDG and TMPDIR directories outside every Git
ancestor. Runtime paths are printed and retained for inspection; remove only
resources whose processes have stopped.

One verification gate runs at a time across processes sharing the state directory,
with two unit/browser workers by default. `UNIT_TEST_WORKERS` and
`JOURNEY_WORKERS` override those counts. The lock prevents dependency refresh
under active tests, limits competing heavy workloads, and prevents Docker
bridge changes from interrupting Chromium loopback requests. Use this launcher
for concurrent agents sharing a checkout or cache; direct commands cannot
participate in its locking.

For an interactive Bash shell, activate without downloading anything:

```sh
. dev/cloud/activate.sh
```

## Storage and host configuration

Paths are configurable through non-secret runtime variables:

| Variable | Default |
| --- | --- |
| `NOTICEOS_REPO` | Checkout containing these scripts |
| `NOTICEOS_CLOUD_CACHE` | `${XDG_CACHE_HOME:-$HOME/.cache}/noticeos-cloud` |
| `NOTICEOS_CLOUD_TOOLS` | `$NOTICEOS_CLOUD_CACHE/tools` |
| `NOTICEOS_CLOUD_STATE` | `${XDG_STATE_HOME:-$HOME/.local/state}/noticeos-cloud` |
| `NOTICEOS_TEST_RUNTIME_ROOT` | `/var/tmp/noticeos-tests-<uid>` |

Use absolute paths and consistent settings during preparation, activation and execution.
`NOTICEOS_CLOUD_TOOLS` must contain no whitespace because repository fixtures
embed Node's absolute path in executable shebangs. Checkout paths may contain spaces. Shared
caches must use the same state directory for locking. Native tools and caches
must be writable by the task user. Do not place the runtime root inside a
checkout or below an ancestor containing `.git`, even an empty platform marker.
Some managed sandboxes make `/var/tmp` read-only and place `.git` markers above
all writable paths. Such hosts need a supported persistent writable location
outside those markers; changing the image does not grant sandbox access.
The launcher reports this restriction instead of weakening fixture guards.

Keep inherited outbound proxy, CA trust and injected credentials. Configure
blocked download destinations through the host's supported network settings;
do not disable TLS checks or bypass its proxy. Node-based fixture-tool downloads
use Node's environment-proxy support. Credentials, socket permissions and
persistent approval policy belong to the host configuration, outside this repo.

## Codex adapter

An optional image `install_script`, executed at the repository root, is:

```sh
bash dev/cloud/codex/setup.sh
```

Add `--browser` (or `--with-deps`) and `--task-store` when the environment's
tasks run browser or task-store suites, so the image holds those caches. The
adapter adds an owned Bash profile block pointing to this checkout's
activation script. It preserves other profile text and refuses symlinked or
unowned profiles. Default login shells then select the prepared toolchain.
Raw non-login shells may inherit the platform's original PATH; use the
launcher or explicitly source `activate.sh` in those contexts.

The corresponding task-start instructions should locate the actual checkout,
run `bash dev/cloud/prepare.sh` after checkout, with `--browser` or
`--task-store` for a task that runs those suites, and use the test launcher
above. Each cloud task is already isolated; use its checkout without
creating a Git worktree. Start disposable services with the repository's
existing test helpers when needed; processes from image preparation do not
survive a new task. Validate a newly started task after publishing an image.
Saving configuration alone does not publish or validate a new task.

Routine feature-branch commits, syncing main into a feature branch, feature
pushes, PR updates and reading CI follow [AGENTS.md](../../AGENTS.md#git-policy).
The adapter does not grant permissions. Merging a PR into main, protected
branch writes, deployments, production access, destructive remote changes and
existing-store migrations retain their approval boundaries. Use repository-scoped
runtime GitHub authentication; test Git transport and GitHub API access
separately. A failed `gh auth status` does not require an interactive login when
the platform's Git or API integration works. Enforce branch protection through
GitHub rulesets without agent bypass; broad shell or `git push` grants cannot
scope authorization to a feature branch.

## Rollback

Restore the previous cloud image/configuration through the host's review
process. To remove only this adapter's profile block:

```sh
python3 dev/cloud/codex/shell-hooks.py --remove
```

Revert the infrastructure commit to select an earlier setup version. Its
first preparation downloads its own dependency store again; the versioned
folders it runs from, including a `tools/postgres17` folder from an earlier
setup, stay in place. Retain runtime output and caches until their owners
confirm no process uses them. Test results, screenshots, logs and verification
receipts remain runtime or CI artifacts and are not committed.
