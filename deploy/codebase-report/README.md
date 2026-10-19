# Codebase report image

This folder builds the image that measures one repository and writes the
codebase report, the envelope `POST /api/codebase-report` accepts
(`CodebaseReport` in `packages/contract/src/codebase.ts`). The site's
**Codebase** tab in the Tower shows the stored reports.

Three commands run the same image:

| Where | Command |
|---|---|
| A GitHub repository | the composite action in [.github/actions/codebase-report](../../.github/actions/codebase-report/README.md) |
| The computer that runs the installation | `pnpm os:codebase-report -- --asset <id> --repo <folder>` |
| Any Docker host | `docker run` as below |

```sh
docker run --rm --read-only --tmpfs /tmp \
  --mount type=bind,source="$PWD",target=/repo,readonly \
  ghcr.io/notice-cx/noticeos-codebase-report:main --asset example.com > report.json
```

`measure.mjs` takes `--asset <id>` (required), `--repo <folder>` (default
`/repo`), `--paths a,b` (folders of a repository that holds more than one
product), `--ref <name>` (the branch name, for a checkout with no branch
checked out), `--out <file>`, `--post <ingest address>` and `--measure
key=value` (repeatable; see
[Build, test and package-audit results](#build-test-and-package-audit-results)).
Without `--out` or `--post` it writes the report to standard output. `--post` reads the site's
token from the environment variable `NOTICEOS_ASSET_TOKEN` and from nowhere
else, and accepts only an `https` address, or plain `http` on `localhost`.

## The run is static

The image reads files and git history. It does not install, build or run the
measured repository's code, and it runs no package manager. Git runs with the
repository's hooks, filesystem monitor and signature display turned off and
with `--no-ext-diff --no-textconv`, because each of those can start a program
the repository names. Python runs isolated (`-I`), so a file in the
repository cannot replace a module lizard imports.

## What it measures

| Measure | Tool | What it counts |
|---|---|---|
| `code_lines`, `comment_lines`, `files`, `languages` | scc | Code lines, comment-only lines, files and languages of the measured files that are not tests. |
| `test_lines` | scc | Code lines in test files. |
| `test_ratio` | scc | `test_lines` divided by `code_lines`, two decimals; above 1 when there are more test lines than code lines. |
| `duplicated_lines`, `duplication_percent`, `duplicate_blocks` | jscpd | Lines and blocks of code that appear in more than one place, and their share of all lines jscpd read, one decimal. Tests are not read. |
| `unused_files`, `unused_exports` | jscpd `--dead-code` | Files nothing imports and exports nothing uses, in JavaScript, TypeScript and Python. Tests are read, so code only a test imports counts as used, and nothing inside a test is counted. |
| `dependencies_direct` | `measure.mjs` | Distinct packages named in `dependencies`, `devDependencies` and `optionalDependencies` of each `package.json`, in `requirements*.txt`, in `go.mod` (not `// indirect`) and in `Cargo.toml`. Packages of the repository's own workspace are not counted. |
| `functions`, `complex_functions`, `max_function_complexity`, `mean_function_complexity` | lizard | Functions, functions with a cyclomatic complexity above 15, the highest complexity and the mean, one decimal. Tests are not read. A `.mts` or `.cts` file is read as TypeScript. |
| `commits_30d`, `files_touched_30d`, `large_commits_30d` | git | Commits of the last 30 days before the run, merges excluded, that touched a measured file; the distinct measured files they touched; and the commits that touched 20 or more measured files. |
| `build_passed`, `tests_passed` | the caller's CI, through `--measure` | 1 when the caller's build or test step passed, 0 when it failed. |
| `vulnerable_dependencies` | the caller's CI, through `--measure` | Packages with a known vulnerability, as the caller's audit step counted them. |

`unused_dependencies` is not measured: jscpd 5.4.0 has no check for unused
packages. Every report lists it under `unmeasured`.

The findings list paths, line numbers and function names, never source text:
the 20 longest repeated blocks, the 20 functions with the highest complexity
above 15, 50 unused files and exports (files first, the longest first), and the
10 files with the most code lines. `byLanguage` lists the 12 languages with
the most code lines.

## Build, test and package-audit results

The image does not build the code, run its tests or audit its packages, so
whether the build passed, whether the tests passed and how many packages have a
known vulnerability come from steps the caller's own CI job already runs. Each
is optional. The job passes each result as `--measure key=value`:
`build_passed` and `tests_passed` take `success` or `failure` (the values
GitHub Actions writes to `steps.<id>.outcome`; also `true`/`false` or `1`/`0`),
and `vulnerable_dependencies` takes a whole number of 0 or more, for example
the number of entries under `vulnerabilities` in `npm audit --json`. `skipped` or
`cancelled` leaves that measure out with the reason "The workflow step that
checks this was skipped or cancelled." Any other key or value stops the run
with a message. A result the job does not pass is left out of `measures`,
listed under `unmeasured`, and shown in the Tower as "Not measured". The
GitHub Action passes its `build-passed`, `tests-passed` and
`vulnerable-dependencies` inputs this way.

```sh
docker run --rm --read-only --tmpfs /tmp \
  --mount type=bind,source="$PWD",target=/repo,readonly \
  ghcr.io/notice-cx/noticeos-codebase-report:main --asset example.com \
  --measure build_passed=success --measure tests_passed=failure --measure vulnerable_dependencies=3 > report.json
```

## Which files are measured

The files git tracks (`git ls-files`), under `--paths` when it is set. Then
these are left out:

- Files under a folder named `node_modules`, `bower_components`, `vendor`,
  `dist`, `build`, `out`, `.next`, `.nuxt`, `.svelte-kit`, `.output`, `.turbo`,
  `.vercel`, `.wrangler`, `.cache`, `.parcel-cache`, `coverage`, `.nyc_output`,
  `__pycache__`, `.venv`, `venv`, `.tox`, `.mypy_cache` or `.pytest_cache`.
- Lockfiles: `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`,
  `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`, `deno.lock`, `Cargo.lock`,
  `Gemfile.lock`, `poetry.lock`, `Pipfile.lock`, `uv.lock`, `pdm.lock`,
  `composer.lock`, `go.sum`, `pubspec.lock`, `Podfile.lock`, `mix.lock`,
  `flake.lock`, `packages.lock.json`, `gradle.lockfile`.
- Minified files: names ending in `.min.js`, `-min.js`, `.min.css` and the like,
  source maps (`.map`), and JavaScript or CSS files over 2 KiB whose lines
  average more than 255 bytes.
- Generated files: a file whose first five lines hold a comment with
  `@generated`, `do not edit`, `<auto-generated`, `auto-generated` or
  `generated by`, `from`, `with` or `using`.
- Documentation and data tables: `.md`, `.markdown`, `.txt`, `.rst`, `.adoc`,
  `.asciidoc`, `.csv`, `.tsv`, and files named `LICENSE`, `COPYING`, `NOTICE`,
  `CHANGELOG`, `CHANGES`, `AUTHORS` or `CONTRIBUTORS`.
- Images, fonts, media, archives and compiled files (`.png`, `.svg`, `.woff2`,
  `.pdf`, `.zip`, `.wasm` and the like), and any file with a zero byte in its
  first 8 KiB.
- Symbolic links, and any path that resolves outside the repository.

A file is a test when a folder in its path is named `test`, `tests`, `spec`,
`specs`, `testing`, `testdata`, `e2e`, `fixture`, `fixtures`, `mock`, `mocks`,
`snapshots` or `cypress` (also with surrounding `__` or a `-` or `_` suffix,
such as `__tests__` or `test-fixtures`), or when its name matches
`*.test.*`, `*.spec.*`, `*.e2e.*`, `*.fixture.*`, `test-*.js` (and `.ts`,
`.mjs`, `.tsx` and the like), `test_*.py`, `*_test.go`, `*_test.py`,
`*_spec.rb`, `*Test.java` (and `.kt`, `.cs`, `.scala`, `.swift`) or
`conftest.py`.

A repository adds its own rules in `.noticeos-codebase.json` at its root:

```json
{ "exclude": ["legacy/", "src/generated"], "tests": ["qa/**"] }
```

`*` matches within one folder, `**` across folders, `{a,b}` either. A pattern
without a slash matches a file or folder name anywhere; a pattern with a slash
starts at the repository root. Either one also matches every file under a
folder it names. A key other than `exclude` and `tests`, or a value that is not
a list of patterns, stops the run with a message.

## Absent means unmeasured

A measure a tool did not produce is left out of `measures`, never written as
0, and its key is listed under `unmeasured` with the reason the Tower shows
beside "Not measured", for example "Unused code is checked in JavaScript,
TypeScript and Python only." A tool that fails leaves out only its own
measures. A build, test or package-audit result the caller did not pass is
listed with the reason that the image does not build, test or audit the code
and the workflow sent no result. A shallow checkout whose oldest commit is newer than 30 days leaves
out the three change counts; `actions/checkout` with `fetch-depth: 0` checks
out the whole history.

## Tool versions

| Tool | Version | Source |
|---|---|---|
| scc | 3.7.0 | GitHub release `boyter/scc` v3.7.0, checked against the release's `checksums.txt` |
| jscpd | 5.4.0 | npm packages `jscpd-linux-x64-gnu` and `jscpd-linux-arm64-gnu` 5.4.0 |
| lizard | 1.24.0 | PyPI wheel, with Pygments 2.21.0 and pathspec 1.1.1 |
| git, Python | Debian bookworm | the base image's packages |
| Node | 24.21.0 | the official Node image, pinned by digest |

The Dockerfile pins each download by version and SHA-256 digest. Every report
records the versions that produced it under `tools`, and the image digest when
the run knew it. A new tool version can change the numbers for the same code,
so a version changes only in a commit that changes the Dockerfile, and a step
in a chart that falls on a version change in `tools` comes from the tool, not
from the code.

## Files here

| File | What it is |
|---|---|
| `Dockerfile` | The image. `docker build deploy/codebase-report` builds it; the release workflow publishes it as `ghcr.io/notice-cx/noticeos-codebase-report`. |
| `measure.mjs` | The measurement, Node built-ins only. |
| `measure.test.mjs` | Its tests: the tool output parsers on fixed strings, the exclusion and test rules, the envelope's limits and path checks. `node --test deploy/codebase-report/measure.test.mjs` runs them; `pnpm test:scripts` runs them through `scripts/codebase-report.test.mjs`. |
| `sample/example.com.json` | A real report of this repository at one commit, with the site id `example.com`, for fixtures and the Tower's development. |
