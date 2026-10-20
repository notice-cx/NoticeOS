---
title: "Measure your codebase"
description: "Send a weekly measurement of a site's code to NoticeOS and read the Codebase tab: size, repeated code, unused code, hard-to-change functions and tests, beside the site's visitors."
---

# Measure your codebase

This page shows how to have NoticeOS measure a site's code each week and what the site's **Codebase** tab shows once it does. It is written for the person who runs the site, not only for the person who writes its code.

A product built quickly, often with AI coding tools, can grow faster than anyone reads it: the same component copied into several pages, old files nobody uses, functions that only get longer. The **Codebase** tab shows those trends over time, next to the site's visitors, so a change in the code can be compared with a change in use.

## What the Codebase tab shows

Open a site from **Sites**, then select **Codebase**, between **Search** and **Alerts**.

At the top is one sentence on how the code changed over the last 30 days, with the visitors over the same days when the site has a visitor count, for example "The code grew 12% in 30 days while visitors grew 3%." Under it are the line counts it compares, the date of the latest report and the commit it measured.

Then five figures. Each shows its value in the latest report, its change against the report nearest 30 days earlier, and its last 90 days as a small line. Hover over or tap the information icon (ⓘ) on a figure for a one-line explanation and the two reports its change compares.

| Figure | What it means |
|---|---|
| **Lines of code** | Lines that hold code, not counting blank lines, comments or tests. More code is more to read and fix. |
| **Repeated code** | The share of the code that appears in more than one place. Every copy has to be fixed separately. |
| **Unused code** | Files, shared pieces of code and packages that nothing uses. Each still has to be kept working. |
| **Hard-to-change functions** | Functions with so many branches that one change can break another. |
| **Test coverage by size** | Lines of tests for each line of code, shown as a multiple, such as **0.2×** the code. Tests catch mistakes before visitors do. |

Under them are three checks, shown when the site's own workflow ([Send build, test and package-audit results](#send-build-test-and-package-audit-results)) or the [local command](#from-the-computer-that-runs-noticeos) sends them:

| Figure | What it means |
|---|---|
| **Build** | **Passed** or **Failed**: whether the code built without errors in the latest report, and how many of the last 30 days' reports passed. |
| **Tests** | **Passed** or **Failed**: whether every test passed in the latest report, and how many of the last 30 days' reports passed. |
| **Vulnerable packages** | Outside packages with a publicly known security flaw, and the change against the report nearest 30 days earlier. |

Under the figures:

- A chart of lines of code over the last **30** or **90** days. Each deploy on the site's timeline (its **Activity** tab) is a mark on it, and a ◆ mark, **Measuring tools updated**, shows a day the measuring tools changed version. **Visitors** draws the site's visitors a day under it. Between two reports the line holds the earlier report's count.
- **Languages**: one bar split by each language's share of the code.
- **Findings** from the latest report, in four lists: **Repeated blocks** (the files that share a block, and its length in lines), **Hard-to-change functions** (the function, its file and its complexity, where above 15 is hard to change), **Unused** (files, shared pieces and packages) and **Vulnerable packages** (how many, when there are any). Each row has **Make a task**, which opens the task form with a title such as "Merge the repeated code in …" or "Fix 3 vulnerable packages in …" filled in.

The figures are counts of the code, not a grade. A site with 2% repeated code is not twice as healthy as one with 4%; what to watch is the direction over weeks, and a sudden step.

## Before you begin

You need three things. Whoever runs your NoticeOS installation has the last two.

- **The site id.** On the site's **Settings** tab, under **Identity**, it is the **Site id**, such as `example.com`.
- **The site's token.** Each site has one secret that the installation checks on every report the site sends; the nightly report and the codebase report use the same one. The installation keeps it in its bootstrap secrets as the site's entry in `ASSET_TOKENS` ([Secrets and credentials](/operate/secrets-and-credentials)). The Tower never shows its value.
- **For the GitHub Action only, the ingest address.** The address at which the installation receives reports, such as `https://ingest.example.com`. It is not the Tower's address. An installation that runs on one computer and is not reachable from the internet has no such address; use the local command instead.

## Send a report

The tab lists three ways under **GitHub Action**, **Local command** and **Central pull · coming later**. All of them run the same measurement: it reads the files and the git history, and never installs, builds or runs the code.

### From GitHub, on every push

1. In the GitHub repository, open **Settings**, then **Secrets and variables**, then **Actions**.
2. Select **New repository secret**. Name it `NOTICEOS_ASSET_TOKEN` and paste the site's token.
3. Select **New repository secret** again. Name it `NOTICEOS_INGEST_URL` and paste the ingest address.
4. On the site's **Codebase** tab, select **GitHub Action** and copy the workflow file. It has the site id filled in. Save it in the repository as `.github/workflows/codebase-report.yml`:

   ```yaml
   name: Codebase report
   on:
     push:
       branches: [main]
     schedule:
       - cron: "17 4 * * 1"
     workflow_dispatch:
   permissions:
     contents: read
   jobs:
     codebase-report:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
           with:
             fetch-depth: 0
         - uses: notice-cx/NoticeOS/.github/actions/codebase-report@main
           with:
             asset: "example.com"
             ingest-url: ${{ secrets.NOTICEOS_INGEST_URL }}
             token: ${{ secrets.NOTICEOS_ASSET_TOKEN }}
   ```

5. Commit the file to `main`.

The workflow runs on every push to `main`, every Monday at 04:17 UTC, and when you select **Run workflow** on the repository's **Actions** tab. `fetch-depth: 0` checks out the whole history; without it the three counts of changes in the last 30 days are not measured. When either secret is missing, as on a pull request from a fork, the report is not sent: it is kept on the workflow run as the artifact `noticeos-codebase-report` for 30 days. The action's own page lists its other inputs: [the codebase report action](https://github.com/notice-cx/NoticeOS/tree/main/.github/actions/codebase-report).

### Send build, test and package-audit results

The measurement reads files and never builds the code, runs its tests or audits its packages, so **Build**, **Tests** and **Vulnerable packages** come from steps your workflow already runs. Each is optional; a result the workflow does not send shows as **Not measured**. Give each step an `id`, give the report step <span v-pre>`if: ${{ !cancelled() }}`</span> so it still runs after a failed build or test, and pass the action three inputs: `build-passed` and `tests-passed` take the step's outcome (`success` or `failure`), and `vulnerable-dependencies` takes a count, for example the number of entries under `vulnerabilities` in `npm audit --json`. A step that was skipped, such as the tests after a failed build, leaves its figure **Not measured**.

```yaml
      - run: npm ci
      - id: build
        run: npm run build
      - id: test
        run: npm test
      - id: audit
        if: ${{ !cancelled() }}
        run: |
          npm audit --json > audit.json || true
          echo "count=$(jq '.vulnerabilities | length' audit.json)" >> "$GITHUB_OUTPUT"
      - if: ${{ !cancelled() }}
        uses: notice-cx/NoticeOS/.github/actions/codebase-report@main
        with:
          asset: "example.com"
          ingest-url: ${{ secrets.NOTICEOS_INGEST_URL }}
          token: ${{ secrets.NOTICEOS_ASSET_TOKEN }}
          build-passed: ${{ steps.build.outcome }}
          tests-passed: ${{ steps.test.outcome }}
          vulnerable-dependencies: ${{ steps.audit.outputs.count }}
```

### From the computer that runs NoticeOS

1. Check that the installation is running: `pnpm os:status`.
2. In the NoticeOS folder, run, with the site id and the folder that holds the site's code:

   ```sh
   pnpm os:codebase-report -- --asset example.com --repo /path/to/your/code
   ```

The command reads the site's token from the installation's own secrets, so you do not type it. For a repository that holds more than one product, add `--paths apps/site` with the folders to measure, separated by commas. Run it again whenever you want a new report; a second report on the same day is kept as that day's newer version.

The command does not build the code, run its tests or audit its packages. To send those results, run the steps yourself first and add one `--measure` for each: `build_passed` and `tests_passed` take `success` or `failure`, and `vulnerable_dependencies` takes a count.

```sh
pnpm os:codebase-report -- --asset example.com --repo /path/to/your/code \
  --measure build_passed=success --measure tests_passed=failure --measure vulnerable_dependencies=3
```

### Central pull · coming later

The installation will fetch and measure each connected repository on a schedule, with no workflow file and no command. It is not built yet; the tab shows the choice greyed out.

## Leave folders out

The measurement already leaves out dependencies, build output, lockfiles, minified and generated files, documentation and images. To leave out more, or to mark more files as tests, add a file named `.noticeos-codebase.json` at the root of the repository:

```json
{ "exclude": ["legacy/", "src/generated"], "tests": ["qa/**"] }
```

- `exclude` lists folders and files to leave out of every measure.
- `tests` lists files to count as tests: they leave **Lines of code** and count toward **Test coverage by size**.
- A pattern without a slash matches a file or folder name anywhere; a pattern with a slash starts at the repository root. `*` matches within one folder and `**` across folders.

Any other key, or a value that is not a list, stops the measurement with a message. The full list of files left out by default is in [the measurement image's README](https://github.com/notice-cx/NoticeOS/tree/main/deploy/codebase-report#which-files-are-measured).

## "Not measured"

A figure that the report did not measure shows **Not measured** with the reason, such as "Unused code is checked in JavaScript, TypeScript and Python only." It is never shown as 0, and no alert reads it as 0. The common reasons:

- **Unused code** is checked only in JavaScript, TypeScript and Python. Unused packages are not measured yet, so **Unused code** counts files and shared pieces of code.
- The three counts of changes in the last 30 days need the whole history; a GitHub checkout without `fetch-depth: 0` has only the latest commit.
- **Build**, **Tests** and **Vulnerable packages** are measured only when the workflow's `build-passed`, `tests-passed` and `vulnerable-dependencies` inputs, or the local command's `--measure`, send them.
- A figure's change shows "No report from a month before yet" until there is a report 28 to 45 days older than the latest.

## Alerts

Each report is checked against five rules. An alert appears on **Alerts** and on the site's **Alerts** tab, and the next report closes it when the rule no longer holds.

| Alert | When | What to do |
|---|---|---|
| "The code grew 31% in 30 days (38,100 → 49,900 lines)." | Lines of code grew 25% or more and by 500 lines or more since the report nearest 30 days earlier. | Compare it with what shipped in those days. If the growth is larger than the features, open **Repeated blocks** first: copied code is the most common cause. |
| "8.4% of the code is repeated." | 8% or more of the code is repeated. | Use **Make a task** on the longest blocks in **Repeated blocks**, asking for one shared version used in every place. |
| "14 files are not used." | 10 or more unused files and packages. | Use **Make a task** on the rows in **Unused**; a file that only an old page used can usually go. Check first that nothing outside the repository loads it. |
| "7 more functions became hard to change in 30 days." | 5 or more functions became hard to change since the report nearest 30 days earlier. | Use **Make a task** on the functions with the highest complexity, asking for them to be split into smaller ones, with tests first. |
| "3 packages have a known vulnerability." | The workflow's audit counted 1 or more vulnerable packages. | Use **Make a task** under **Vulnerable packages**, asking for each to be updated to a release without the flaw (`npm audit fix` lists most of them). |

The growth and hard-to-change alerts need a report from 28 to 45 days earlier, so a newly measured site has neither for its first four weeks. The thresholds are under `codebase_rules` in the installation's constants ([`config/constants.README.md`](https://github.com/notice-cx/NoticeOS/blob/main/config/constants.README.md)); the Tower does not edit them.

## Verify

- The workflow run, or the command, ends with the report stored, and the site's **Codebase** tab shows the five figures instead of **The code has not been measured yet.**
- After a second report at least 28 days later, each figure shows its change.

## If it didn't work

- `The ingest refused the report (401)`: the token does not match the site id. Check the `asset` value against **Site id** on the site's **Settings** tab, and the token with whoever runs the installation.
- `The ingest refused the report (422)`: the installation does not accept this report's shape, usually because it runs an older version. Whoever runs it updates it with `pnpm os:update`.
- The workflow run succeeds but nothing arrives: one of the two secrets is missing, and the report was kept as the artifact `noticeos-codebase-report` on the run.
- The local command stops with `The app is not running`: start the installation, then run the command again.

Why NoticeOS measures these figures, and the rules behind them: [doc 27, Codebase health](../27-codebase-health.md). The report's exact shape: [doc 02, Signal contract](../02-signal-contract.md#codebase-report).

## Next steps

- [Sites](/tower/sites)
- [Alerts](/tower/alerts)
- [Send your own report](/guides/send-your-own-report)
