# 27 — Codebase health

*This doc describes why NoticeOS measures each asset's code, which measures it
keeps, how the alert rules read them and how a measurement reaches the store.
The operator's guide is [Measure your codebase](guides/measure-your-codebase.md);
the envelope is in [doc 02](02-signal-contract.md#codebase-report).*

## Why measure the code

Many assets in a portfolio are built quickly, often with AI coding tools, by
people who then have to keep them running. The cost of that upkeep is in the
code: every copy of a component is fixed separately, every unused file is still
read, built and updated, and a function with many branches breaks in one place
when it is changed in another. None of this shows in traffic or revenue until a
change takes a week instead of an hour.

The asset's **Codebase** tab records the code's size and four of its costs over
time, beside the asset's visitors, so a change in the code can be read next to a
change in use. Under them it shows three checks the asset's own workflow runs:
whether the build passed, whether the tests passed and how many packages have a
known vulnerability. It records counts and passes. It gives no score and no
grade.

## The measures, and why these

One report holds up to twenty-three measures (`CODEBASE_MEASURES` in
`packages/contract/src/codebase-measures.ts`, which also holds the label and
the one-sentence meaning the Tower shows for each). The tab leads with five
counted from the files, then a row of three checks the sender passes in.

| Figure on the tab | Measures | Tool |
|---|---|---|
| **Lines of code** | `code_lines`, with `comment_lines`, `files` and `languages` | scc |
| **Repeated code** | `duplication_percent`, with `duplicated_lines` and `duplicate_blocks` | jscpd |
| **Unused code** | `unused_files` + `unused_exports` + `unused_dependencies`, whichever were measured | jscpd `--dead-code` |
| **Hard-to-change functions** | `complex_functions` (cyclomatic complexity above 15), with `functions`, `max_function_complexity` and `mean_function_complexity` | lizard |
| **Test coverage by size** | `test_ratio` = `test_lines` ÷ `code_lines` | scc |

The report also counts the last 30 days of change from git (`commits_30d`,
`files_touched_30d`, `large_commits_30d`, the last being commits that touched
20 files or more) and the packages a project installs by name
(`dependencies_direct`).

These were chosen because each one:

- **is counted from the files alone**, by a widely used tool, without
  installing, building or running the project. A measure that needs the code to
  run, such as test coverage by executed lines, would need the project's own
  toolchain and secrets, and would run code the installation did not write.
- **matches a cost an operator recognises** in plain words: more to read,
  copies to fix separately, files kept for nothing, functions that break when
  touched, tests that catch mistakes.
- **reads the same on any asset** where its tool applies. Lint warnings depend
  on each repository's own configuration and cannot be compared across assets;
  a combined maintainability score hides which of its parts moved.

Tests are measured apart from the code: `code_lines` excludes test files, so a
week of new tests does not read as growth, and `test_ratio` can exceed 1.

### The three checks the sender passes in

| Figure on the tab | Measure | Unit | Where it comes from |
|---|---|---|---|
| **Build** | `build_passed` | `pass`: 1 passed, 0 failed | the outcome of the workflow's build step |
| **Tests** | `tests_passed` | `pass`: 1 passed, 0 failed | the outcome of the workflow's test step |
| **Vulnerable packages** | `vulnerable_dependencies` | `count` | the count from the workflow's package audit, such as `npm audit` |

These are the exception to the first reason above: a build, a test run and an audit
need the project's own toolchain, so the image never runs them. The sender runs
them in its own workflow and passes each result to the image, as the action's
`build-passed`, `tests-passed` and `vulnerable-dependencies` inputs or as
`--measure key=value` on `measure.mjs` and `pnpm os:codebase-report`. A step
that was skipped or cancelled sends nothing, and its figure is unmeasured. A
pass has no size to compare with a month before, so the tab shows the latest
result as **Passed** or **Failed**, with how many of the last 30 days' reports
passed, such as "4 of 5 reports passed in 30 days".

## Beside the visitors

The sentence at the top of the tab sets the code's change over 30 days next to
the asset's visitors over the same days, from the visitor series the asset's
**Overview** reads: "The code grew 12% in 30 days while visitors grew 3%." The
chart's **Visitors** button draws the visitors under the lines of code, with the
same deploy marks on both.

The sentence states two changes and claims no cause. Code growth with no growth
in use is a cost with no visible return, which is the reason to show them
together; whether one caused the other is outside what this view measures
([doc 03](03-attribution.md)).

## Absent means unmeasured

Every measure in the envelope is optional. A measure a tool did not produce is
left out, never written as 0: jscpd's unused-code check covers JavaScript,
TypeScript and Python only, unused packages are not measured by any tool in the
image, a shallow checkout has no 30-day history, and the three checks are
absent unless the sender passes them in. The report lists each
absent measure under `unmeasured` with the sentence the Tower shows beside
**Not measured**.

The rule holds at every step:

- The contract accepts a report with any measure missing
  (`packages/contract/src/codebase.ts`).
- A rule whose input is absent does not run, and so neither raises nor resolves
  an alert.
- The Tower reads a stored measure only when it is a number the contract accepts
  for that key (`apps/tower/worker/codebase-history.ts`); anything else is
  unmeasured.
- **Unused code** adds only the parts that were measured, and shows
  **Not measured** when none was.
- A findings list a tool did not produce is left out of the envelope, which
  differs from an empty list: the tab shows "Not measured" for the first and
  "Nothing unused found." for the second.

## Tool versions and the pinned image

The measurement runs in one image, `deploy/codebase-report`, which pins scc,
jscpd and lizard by version and SHA-256 digest; the release workflow publishes
it as `ghcr.io/notice-cx/noticeos-codebase-report`. A new tool version can count
the same code differently, so:

- a tool version changes only in a commit that changes the Dockerfile;
- every report records the versions that produced it under `tools`, with the
  image digest when the run knew it;
- the Tower's chart marks each report whose versions differ from the report
  before it with **Measuring tools updated**, and a step on that day is read as
  the tools, not the code.

## The comparison and the rules

A change "in 30 days" compares the latest report with the asset's report
nearest 30 days earlier, between 28 and 45 days earlier, the older of two at the
same distance. Outside that span there is no comparison, and the tab shows "No
report from a month before yet". `pickComparisonReport` makes that choice for
both the alert rules and the Tower's figures, so an alert and the figure beside
it compare the same two reports.

Five rules run on every accepted report, in the same transaction that stores it
(`workers/ingest/src/codebase.ts`), with the thresholds in
`config/constants.json` under `codebase_rules`, store first:

| Rule | Severity, kind | Fires when (default) | Alert |
|---|---|---|---|
| `codebase-growth` | warn, anomaly | lines of code grew at least 25% **and** at least 500 lines since the comparison report | "The code grew 31% in 30 days (38,100 → 49,900 lines)." |
| `codebase-duplication` | warn, opportunity | at least 8% of the code is repeated | "8.4% of the code is repeated." |
| `codebase-unused` | info, opportunity | unused files plus unused packages reach 10 | "14 files and 3 packages are not used." |
| `codebase-complexity` | info, opportunity | at least 5 more hard-to-change functions than the comparison report | "7 more functions became hard to change in 30 days." |
| `codebase-vulnerabilities` | info, opportunity | at least 1 package has a known vulnerability, as the sender's audit counted | "3 packages have a known vulnerability." |

- Growth needs both conditions: on a small repository a few added lines are a
  large percent, and on a large one a routine month is many lines.
- Repetition, unused code and vulnerable packages are levels, read from the
  latest report alone; growth and complexity are changes and need a comparison
  report, so a newly measured asset raises neither for its first four weeks.
- Unused shared pieces (`unused_exports`) are on the **Unused code** figure and
  in its findings, and are not counted by the rule.
- A vulnerable-packages threshold below 1 reads as 1, so a report with no
  vulnerable package never raises the alert.
- Growth is of kind anomaly: it records a change larger than its thresholds.
  The other four are of kind opportunity: each names work that would lower
  the cost of later changes or remove a known flaw.

Each rule first resolves its own open alert for the asset, then raises a new one
if it fires, so an asset holds at most one open alert per rule and the next report
closes an alert that no longer holds. Each alert stores the numbers it used,
both reports and the thresholds in `rule_inputs`, so a false alarm can be traced
and a threshold changed on evidence. The thresholds are measurement rules: an
operator changes them in the constants document, and nothing changes them
automatically.

## What is not stored

A report never carries source text. Findings are repository-relative paths,
line numbers and function names; a path is at most 512 characters, relative,
with no `..` segment, backslash or control character. Every list is bounded
(20 repeated blocks of at most 10 files, 20 functions, 50 unused items, 10
largest files, 12 languages) and the body is at most 256 KiB.

Findings name where to look and hold none of the code itself. Keeping code
out of the store means a report from a private repository puts no source in the
installation's database, its backups or the demo, and a report's size stays
bounded however large the repository is.

## Three ways to send a report

The same image produces the same envelope in each case; only the way it
reaches the store differs. Each sends it to `POST /api/codebase-report` with the
asset's token from `ASSET_TOKENS`, the same token and route checks as the nightly
report ([doc 11](11-integrations.md#credential-naming--the-asset_token-convention)).

| Way | Runs where | How it reaches the store |
|---|---|---|
| GitHub Action (`.github/actions/codebase-report`) | the asset's repository, on push to `main`, weekly and on demand | posts to the installation's ingest address when both the address and the token are set as repository secrets; otherwise keeps the report as a workflow artifact |
| `pnpm os:codebase-report` (`scripts/codebase-report.mjs`) | the computer that runs the installation | runs the image through the installation's Docker in the app container's network and posts to the ingest on that container's loopback |
| Central pull | the installation, on a schedule | not built |

The Tower does not receive reports at its own address. A standalone installation
receives `POST /api/pulse` and `POST /api/codebase-report` only on the app
container's loopback, so a GitHub Action can reach it only when the installation
publishes an ingest address of its own; otherwise the local command sends the
report. The setup on the tab therefore reads the address from a repository secret
instead of printing the Tower's address.

## Central pull

The third way is named on the tab as **Central pull · coming later** and is not
built. It would have the installation fetch each connected repository and run
the same image on a schedule, so no workflow file and no token sit in the
repository. It needs read access to the repository's contents through the
installation's GitHub connection and a scheduled job that runs the image; the
envelope, the route, the store and the tab stay as they are.

## Where it lives

| Part | Path |
|---|---|
| Envelope and limits | `packages/contract/src/codebase.ts` |
| Measures, labels, comparison, rules | `packages/contract/src/codebase-measures.ts` |
| Measurement image | `deploy/codebase-report/` |
| GitHub Action | `.github/actions/codebase-report/` |
| Local command | `scripts/codebase-report.mjs` (`--measure` passes the three checks to the image) |
| Route, store write, rules | `workers/ingest/src/routes/codebase-report.ts`, `workers/ingest/src/codebase.ts` |
| Table and current view | `db/postgres/migrations/0016_codebase_reports.sql` (`noticeos.codebase_reports`, `noticeos.current_codebase_reports`) |
| Tower read and tab | `apps/tower/worker/codebase-history.ts`, `apps/tower/src/routes/asset-detail/CodebaseTab.tsx`, `apps/tower/src/routes/asset-detail/codebase-measures.ts` |
| Thresholds | `config/constants.json` `codebase_rules` ([README](../config/constants.README.md)) |
