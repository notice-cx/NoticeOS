# After a key is accepted: the account's sites, matched, and first data now (2026-09-23, bead `ro-ujb9.96.7.2`)

The connect panel's second screen. Once a provider accepts a key, the panel
lists what the account holds, matches each site to a portfolio asset by domain,
and one press — **Start collecting · N sites** — saves those matches and runs
the first collection at once. Mockup frames a3, a3-dataforseo, a4 and
d-matched in
`integration-setup-mockup.html` (private historical evidence);
captures in
`ux-zero-2026-09-23/site-discovery/` (private historical evidence).

## What the operator sees

- **Matched** — an asset whose own domain the account holds: ticked, with the
  site it will be collected from. A suggestion; nothing is written before Start.
- **Already mapped** — the site its Data sources row names: ticked.
- **Not in this account** — an asset the account lists nothing for: unticked,
  with the provider's own Add link (Add in Bing), or a picker of the account's
  unclaimed sites.
- **Not verified** — a site the provider lists but will not serve yet: listed,
  never ticked.
- **Not using · Doesn't apply · Pre-launch** — an asset the lane does not
  collect: listed with its reason as a chip.
- **No matching asset · N** — sites the account holds that no asset claims:
  listed under the rows, never dropped.
- **DataForSEO** (paid): each site with its market ("United States ·
  English"), the weekly cost from the OS's own cost records — or, before any
  cost is recorded, the most the budget gate lets one first run spend — and
  this month against the cap, all before the press.
- After Start, each collected site wears the connection model's status
  (`apps/tower/shared/connection-status.ts`): **Collecting** until its result
  is stored, then **Working** or **Failing**; or the refusal in words
  (Schedule paused, Already collecting).

## How it is built

- **One listing, nothing stored.** `GET /api/integrations/:provider/sites`
  (apps/tower/worker/site-discovery-route.ts) asks the ingest's
  `discoverSites` (workers/ingest/src/site-discovery.ts) — Bing's
  `GetUserSites`, or DataForSEO's own collector membership — and composes it
  with the assets table and the register. The panel reads it once per session.
- **One host rule.** `siteHost` (packages/contract/src/site-discovery.ts) is
  the rule the Bing collector has always used to match an unmapped asset
  (`normalizeBingHost`); a test pins the two equal, so the panel suggests
  exactly what the collector would pick.
- **The Data sources tab's own write.** Start builds `laneFieldOp` ops
  (apps/tower/shared/lane-mapping-ops.ts, moved out of LaneConfig.tsx so both
  surfaces share one function) and saves them through `PUT /api/config` with
  its `config_changes` audit row. No new write path, no migration.
- **The scheduled job's own step.** `POST /api/integrations/:provider/collect`
  calls the ingest's `collectNow`, which runs `runCollectNow`
  (workers/ingest/src/dispatch.ts): the step declared on the job
  (`collectNow` in scripts/scheduled-jobs.mts — Bing on `pull`, DataForSEO on
  `dataforseo`), the same `bingLane` / `searchLane` calls the cron makes, on the
  stored config, through each lane's egress gate, lease (DataForSEO's
  one-run-at-a-time lock) and budget gate. A paused job refuses before any
  provider call. Tests: workers/ingest/test/collect-now.test.ts.
- **Shapes for the next connections.** `DiscoveredSite.mapping` carries the
  register fields a site writes, so Google (`propertyId`, `siteUrl`), PostHog
  (`host`, `projectId`) and Mediavine (`mediavineSiteId`) plug into the same
  list, plan and press under `ro-ujb9.96.7.6`–`.8`; a provider adds one case to
  `discoverSites` and one `collectNow` step.

## Prior art

Researched 2026-09-23 from each vendor's own documentation.

- **Ahrefs — Import from Google Search Console.** Connect Google, then "select
  all the websites that you wish to add as verified projects" and press Import;
  the projects are added and up to 16 months of data start importing. Ahrefs
  requires the project and the property to match exactly (a domain property
  covers every protocol and subdomain; a URL-prefix property only that prefix).
  https://help.ahrefs.com/en/articles/1433362-how-to-add-a-project-in-your-dashboard ·
  https://help.ahrefs.com/en/articles/9147867-troubleshooting-common-issues-with-gsc-data-in-ahrefs ·
  https://help.ahrefs.com/en/articles/5311821-how-do-i-see-my-google-search-console-performance-in-ahrefs
- **Sitebulb — audit settings.** "Will attempt to auto-select the right
  Property by matching up the start URL with the properties in the account",
  overridable by the user — the one vendor that documents pre-selecting by
  domain. https://support.sitebulb.com/en/articles/9844074-audit-settings
- **Vercel — Import Git Repository.** The connected Git account's repositories
  are listed with search; one Deploy press creates the project and starts the
  first deployment, whose status (pending, ready, error) is shown as it runs.
  https://vercel.com/docs/git ·
  https://vercel.com/changelog/git-repositories-can-now-be-searched-for-and-imported-easily ·
  https://vercel.com/docs/git/vercel-for-github
- **GitHub Apps — installation.** "All repositories" or "Only select
  repositories" from an auto-listed picker, editable later under Repository
  access. https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app ·
  https://docs.github.com/en/apps/using-github-apps/reviewing-and-modifying-installed-github-apps
- **Bing Webmaster Tools — import from Search Console.** Lists the verified
  sites with their role; selected sites are imported and verified; traffic can
  take up to 48 hours.
  https://blogs.bing.com/webmaster/september-2019/Import-sites-from-Search-Console-to-Bing-Webmaster-Tools
- **Plausible — Search Console integration and first data.** Continue with
  Google, pick the property from a select, Save; after adding a site the
  dashboard opens at once with a banner showing the installation check.
  https://plausible.io/docs/google-search-console-integration ·
  https://plausible.io/docs/troubleshoot-integration
- **Airbyte and Fivetran — first sync.** Airbyte's connection templates start
  the first sync on create by default (`sync_on_create`); Fivetran needs a
  separate "Start initial sync" press after Save & Test. Statuses read Running
  → Healthy / Failed (Airbyte) and Syncing → Active / Broken (Fivetran).
  https://docs.airbyte.com/cloud/managing-airbyte-cloud/review-connection-status ·
  https://fivetran.com/docs/getting-started/quickstart ·
  https://fivetran.com/docs/getting-started/fivetran-dashboard/connectors
- **Paid first runs.** None of the documented vendors shows a cost before a
  paid first sync: DataForSEO returns each task's cost after the call, and
  Fivetran estimates usage only after seven days. Semrush's API guide tells
  callers to "calculate the potential unit cost" before a request.
  https://dataforseo.com/help-center/how-to-track-api-usage-with-tag ·
  https://fivetran.com/docs/getting-started/free-trials/new-connector-free-use-period ·
  https://developer.semrush.com/api/v3/get-started/api-units-balance/
- **Stripe Connect** lists connected accounts with per-status counts; it has
  no account-to-site matching to adopt.
  https://docs.stripe.com/connect/dashboard/viewing-all-accounts

**Adopted:**

- Sitebulb's and Ahrefs' match: a site is suggested only when its host is the
  asset's own domain; a partial match is never ticked.
- Ahrefs' and Bing's list: every site the account holds is shown; the ones no
  asset claims are listed separately, unticked, rather than hidden.
- Vercel's one press and Airbyte's default: the confirm that saves the choice
  also starts the first collection — no second "start" press (Fivetran's).
- Airbyte's and Fivetran's statuses, in this OS's vocabulary: Collecting, then
  Working or Failing, per site, only from a stored result.
- Semrush's advice, and ahead of every documented vendor: a metered provider
  states its cost before the press, from the OS's own records and the budget
  gate's reserve.
- GitHub's editable-later choice: every mapping the press writes stays
  editable on the asset's Data sources tab, which writes the same field.
