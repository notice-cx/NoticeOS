# Codebase report GitHub Action

This action measures a repository's code and sends the result to a NoticeOS
installation, where the site's **Codebase** tab shows it: lines of code,
repeated code, unused code, hard-to-change functions, the size of the tests and
how much changed in the last 30 days. It reads the files and the git history
only; it does not install, build or run the repository's code.

[deploy/codebase-report/README.md](../../../deploy/codebase-report/README.md)
lists what each number counts and which files are left out.

## What you need

- **The site's id.** In the Tower, open the site's page, then **Settings**. The
  id is under **Identity**, for example `example.com`.
- **The site's token.** Each site has one secret that the installation checks
  on every report it receives. The Tower lists it as "Site token" and never
  shows its value; the person who runs the installation holds it, as the site's
  entry in `ASSET_TOKENS`, and gives it to you.
- **The ingest address.** The address at which the installation receives
  reports, for example `https://ingest.example.com`. The person who runs the
  installation gives it to you. Before the first report, the site's
  **Codebase** tab shows the workflow below with the site id and this address
  filled in. An installation that runs on one computer and is not reachable
  from the internet cannot receive reports from GitHub; leave the address and
  token out, and the report is kept as a file on the workflow run instead
  (see [Without an installation to send to](#without-an-installation-to-send-to)).

## Set it up

1. In the GitHub repository, open **Settings**, then **Secrets and variables**,
   then **Actions**.
2. Select **New repository secret**. Name it `NOTICEOS_ASSET_TOKEN` and paste
   the site's token. Save it.
3. Select **New repository secret** again. Name it `NOTICEOS_INGEST_URL` and
   paste the ingest address. Save it.
4. Add a file named `.github/workflows/codebase-report.yml` to the repository
   with this content, with `example.com` replaced by the site's id:

   ```yaml
   name: Codebase report
   on:
     push:
       branches: [main]
     schedule:
       - cron: '17 4 * * 1'
     workflow_dispatch:
   permissions:
     contents: read
   jobs:
     measure:
       runs-on: ubuntu-24.04
       steps:
         - uses: actions/checkout@v4
           with:
             fetch-depth: 0
         - uses: notice-cx/NoticeOS/.github/actions/codebase-report@main
           with:
             asset: example.com
             ingest-url: ${{ secrets.NOTICEOS_INGEST_URL }}
             token: ${{ secrets.NOTICEOS_ASSET_TOKEN }}
   ```

5. Commit the file to `main`. The repository's **Actions** tab lists the run.
   When it finishes, the site's **Codebase** tab shows the report.

The workflow runs on every push to `main`, every Monday at 04:17 UTC, and when
you select **Run workflow** on the **Actions** tab.

`fetch-depth: 0` checks out the whole history. Without it, the checkout holds
one commit, and the three change counts are left out of the report as "not
measured".

## Inputs

| Input | Required | What it sets |
|---|---|---|
| `asset` | yes | The site's id, as the Tower's site page shows it. |
| `ingest-url` | no | The installation's ingest address. |
| `token` | no | The site's token. Pass it from a secret, never as plain text in the file. |
| `paths` | no | Folders to measure, separated by commas, for a repository that holds more than one product, such as `apps/site`. Empty measures the whole repository. |
| `image-tag` | no | The tag of the published measurement image, `ghcr.io/notice-cx/noticeos-codebase-report`. Default `main`. |
| `image` | no | A whole image reference used instead of the published image, such as one built earlier in the same job. |

The action sends the report when both `ingest-url` and `token` are set. A
pull request from a fork runs without the repository's secrets, so its report
is kept as a file.

## Without an installation to send to

When `ingest-url` or `token` is empty, the report is uploaded as the workflow
artifact `noticeos-codebase-report`, kept for 30 days. Open the run on the
**Actions** tab and download it under **Artifacts**. On the computer that runs
the installation, `pnpm os:codebase-report -- --asset <id> --repo <folder>`
measures a checkout there and sends the report to that installation directly.

## Leave folders out

A file named `.noticeos-codebase.json` at the root of the repository adds
folders and files to leave out, and marks more files as tests:

```json
{ "exclude": ["legacy/", "src/generated"], "tests": ["qa/**"] }
```

## When it fails

- `The ingest refused the report (401)`: the token does not match the site id.
  Check the `asset` input against the id on the site's page, and the secret
  against the token the person who runs the installation gave you.
- `The ingest refused the report (422)`: the installation runs a version that
  does not accept this report. The person who runs the installation updates it
  with `pnpm os:update`.
- `manifest unknown` on the pull step: the `image-tag` input names a tag that
  was never published. Remove the input to use `main`.
