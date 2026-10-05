# Prior art for the Tower's main flows (2026-09-23, bead `ro-ujb9.93`)

How comparable products handle each flow the UX audit measured
(report; private historical evidence). One section per flow,
named by the walk id in
`walk.mjs` (private historical evidence), so a flow-budget or
UX-gate exception can cite `docs/briefs/2026-09-23-ux-prior-art.md#<flow>`.

Each product note says how many steps it takes to finish, how the product proves
the connection works, how it finds and maps resources, and how it shows status.
Every claim links to the vendor's own docs. The research was done on
2026-09-23 from those docs. Where a doc did not state something, this brief says
so instead of guessing. "Adopt" names the pattern each proposed flow follows,
and its target step count must match or beat the best product listed.

## connect-api-key

Connect a provider with one key for the whole workspace (Bing Webmaster Tools, DataForSEO).

- **Grafana (data source).**
  - **Steps:** Connections → pick the source → one screen (name, URL, auth) → **Save & test**.
  - **Proof:** Save & test saves the settings and runs the plugin's own health check. It passes only when both calls succeed, and the result shows on the same screen ("Successfully queried the Prometheus API").
  - **Mapping:** resources are picked later, in the query editor.
  - **Sources:** https://grafana.com/docs/grafana/latest/datasources/prometheus/configure/ · https://grafana.com/developers/plugin-tools/tutorials/build-a-data-source-backend-plugin
- **Zapier (app connections).**
  - **Steps:** one auth window per app.
  - **Proof:** Test connection is on demand.
  - **Status:** one icon per connection: green Active or red Expired, with **Reconnect** beside it. Reconnecting repairs every Zap that uses the connection.
  - **Source:** https://help.zapier.com/hc/en-us/articles/8496290788109-Manage-your-app-connections
- **Segment (destination).**
  - **Steps:** Add destination → tile → Configure → pick a source → connection settings (key) → enable. About four screens.
  - **Proof:** the setup doc states no automatic test. Data arrival is checked in separate Event Tester and Delivery tools.
  - **Source:** https://www.twilio.com/docs/segment/getting-started/05-data-to-destinations
- **Datadog (integration tile).**
  - **Steps:** one tile screen: enter a service name and key, then save.
  - **Proof:** no test is documented.
  - **Status:** the catalog shows Detected, Installed, Available or Missing Data (no metrics in 24 hours).
  - **Sources:** https://docs.datadoghq.com/integrations/pagerduty/ · https://docs.datadoghq.com/getting_started/integrations/
- **PostHog (Stripe source).**
  - **Steps:** New source → Stripe → paste a restricted key → Next.
  - **Guidance:** the exact read permissions the key needs are listed beside the paste field.
  - **Source:** https://posthog.com/docs/cdp/sources/stripe

**Adopt:**
- Grafana's one-press **save and test**.
- Zapier's one status per connection, with Reconnect beside it.
- PostHog's list of the permissions the key needs, beside the field instead of a paragraph.
- Ahrefs-style listing of the resources the key can see (see [connect-google-oauth](#connect-google-oauth)).

**Target:** 1 screen, 1 paste, 1 press to a verified connection. The walk measured 10 clicks, 7 screens and 2 empty steps for Bing.

## connect-google-oauth

Sign in with Google, then pick a GA4 property or a Search Console site.

- **Plausible Cloud (Search Console).**
  - **Steps:** Continue with Google → consent → pick the property from an auto-listed dropdown → Save.
  - **Proof:** none separate; a filled dropdown is the proof.
  - **Source:** https://plausible.io/docs/google-search-console-integration
- **Plausible Community Edition (self-hosted).**
  - **Steps:** about 11: the operator creates a Google Cloud project, consent screen and OAuth web client, sets two environment variables, and restarts the container.
  - **Guidance:** its guide adds the operator as a test user, which leaves the app in Testing mode.
  - **Source:** https://github.com/plausible/community-edition/wiki/google-integration
- **Matomo.**
  - **On-premise, 17 documented steps:** project → API → consent screen → publish → OAuth client → redirect URI → download the client JSON → upload it to Matomo → sign in → configure each site.
  - **Cloud:** one-click "Quick Connect with Google".
  - **Sources:** https://matomo.org/faq/reports/import-google-search-keywords-in-matomo/ · https://matomo.org/faq/search-engine-keywords-performance/import-google-search-keywords-to-matomo-cloud/
- **Looker Studio (GA4 connector).**
  - **Steps:** Authorize, then pick the account column, then the property column, then Connect. One screen.
  - **Mapping:** accounts and properties are listed automatically.
  - **Source:** https://docs.cloud.google.com/looker/docs/studio/connect-to-google-analytics
- **Ahrefs (Import from GSC).**
  - **Steps:** Google sign-in → every verified property listed with multi-select → Import. One sign-in adds many sites, and the sites arrive already verified.
  - **Source:** https://help.ahrefs.com/en/articles/1433362-how-to-add-a-project-in-your-dashboard
- **n8n self-hosted (bring your own OAuth client).**
  - **Steps:** five Google Cloud steps. The redirect URL is copied from n8n's own credential panel; paste the client ID and secret, then Sign in with Google.
  - **Source:** https://docs.n8n.io/integrations/builtin/credentials/google/oauth-single-service/
- **Supabase.**
  - **Guidance:** shows the callback URL on its own Google provider page.
  - **Source:** https://supabase.com/docs/guides/auth/social-login/auth-google
- **Google's own rules.** Refresh tokens from an External app left in Testing expire after 7 days. Each client gets 100 refresh tokens per Google account.
  - **Source:** https://developers.google.com/identity/protocols/oauth2

**Adopt:**
- **Hosted NoticeOS:**
  - Use a Notice-verified Google app, so there is no console work at all.
  - Continue with Google, then an auto-listed, domain-matched property per site, then one Start.
- **Self-hosted:**
  - Follow n8n and Supabase: show the redirect URI with a Copy button.
  - Follow Matomo: accept the downloaded client JSON as an alternative to two pastes.
  - Link straight into Google Cloud screens with the three APIs preselected.
  - Warn about Testing mode, which is a trust fact that stays.
- **Both:** after consent, follow Ahrefs: list everything the account can see and pre-tick the sites that match by domain.

**Target:**
- **Hosted:** 2 in-product clicks plus Google's consent.
- **Self-hosted:** 4 in-product actions plus about 12 console clicks guided by deep links. The Tower's own instructions imply about 33 clicks today.

## connect-per-asset-and-discovery

One account with many sites or projects, a key per project, and choosing which resource belongs to which site (PostHog, Clarity, Mediavine).

- **GitHub Apps.**
  - **Steps:** Install → choose the account → All repositories, or pick specific ones from an auto-listed multi-select → Install. The same choice is editable later under Configure.
  - **Source:** https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party
- **Vercel integrations.**
  - **Steps:** Install → All projects, or specific projects.
  - **Status:** permission changes raise an "action required" alert.
  - **Source:** https://vercel.com/docs/integrations/install-an-integration/manage-integrations-reference
- **Sentry ↔ Vercel.**
  - **Mapping:** link each Sentry project to a Vercel project. On save, Sentry writes the DSN and token variables into the Vercel project itself.
  - **Source:** https://docs.sentry.io/organization/integrations/deployment/vercel/
- **Cloudflare API tokens.**
  - **Mapping:** the token is scoped to specific zones when it is created.
  - **Proof:** a verify endpoint is offered right after creation.
  - **Source:** https://developers.cloudflare.com/fundamentals/api/get-started/create-token/
- **PostHog projects.** An organization holds many projects, each with its own token.
  - **Source:** https://posthog.com/docs/settings/projects
- **Databox (counter-example).**
  - **Mapping:** one Search Console site per data source; each further site is another pass through the flow.
  - **Source:** https://help.databox.com/integrate-google-search-console-with-databox

**Adopt:**
- **Discovery:** follow GitHub, Vercel and Ahrefs. One account connection lists every project or site it can see, matched to assets by domain and pre-ticked.
- **PostHog:** one personal key scoped to the chosen projects, not one key per asset, with the region detected from the key.
- **Clarity:** Microsoft issues export tokens per project, which is a provider fact. Keep one paste per asset, inline in that asset's row, saved on paste.

**Target:**
- **PostHog and Mediavine:** 3–4 actions, down from 20 and 16 measured.
- **Clarity:** 2 actions per asset.

## add-asset

Add a site end to end, to its first data.

- **Plausible.**
  - **Steps:** enter the domain → optional measurements → snippet → the dashboard opens immediately.
  - **Proof:** a background check shows whether the install works and when the first visit is counted, with Check again. The older "Waiting for first pageview" screen caused support threads.
  - **Sources:** https://plausible.io/docs/add-website · https://plausible.io/docs/troubleshoot-integration · https://github.com/plausible/analytics/discussions/728
- **Fathom.**
  - **Steps:** Add site → one name field → Create → embed code. About 2 screens.
  - **Source:** https://usefathom.com/docs/account/add-delete
- **PostHog onboarding.**
  - **Proof:** Continue stays disabled until the first event arrives.
  - **Guidance:** the reason had to move from a tooltip onto the page, and an endless wait was replaced with a clear "never sent an event" state.
  - **Sources:** https://github.com/PostHog/posthog/pull/99826 · https://github.com/PostHog/posthog/pull/95524
- **Vercel (import project).**
  - **Steps:** pick a repo → one configure screen → Deploy.
  - **Defaults:** framework and commands are detected and filled in automatically.
  - **Source:** https://vercel.com/docs/projects/managing-projects
- **Google Search Console.**
  - **Steps:** Domain property or URL-prefix property → verify.
  - **Proof:** data starts collecting when the property is added.
  - **Source:** https://support.google.com/webmasters/answer/34592

**Adopt:**
- Plausible's one input (the domain), then land on the asset at once with live checking, never a silent disabled Continue.
- Vercel's defaults for everything else.
- The asset's name and icon inferred from the site itself.

**Target:** 1 field, 2 clicks, 1 screen, 0 empty steps. The walk measured 8 actions, 7 screens and 3 empty steps.

## inbox-and-file-task

Answer an approval or inbox item, and file a task from a finding.

- **Linear Triage.**
  - **Steps:** one key or click per decision (Accept, Duplicate, Decline, Snooze), with an optional comment.
  - **Source:** https://linear.app/docs/triage
- **Linear Inbox.**
  - **Steps:** one-key actions (mark read, snooze, delete) with list navigation.
  - **Source:** https://linear.app/docs/inbox
- **GitHub pull-request review.**
  - **Steps:** Review changes → Approve (optional summary) → Submit. About 3 clicks.
  - **Source:** https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/approving-a-pull-request-with-required-reviews
- **PagerDuty → Jira.**
  - **Steps:** More → Create Jira Issue, with the title prefilled from the incident. The issue link then shows on the incident.
  - **Source:** https://support.pagerduty.com/main/docs/jira-cloud-user-guide
- **Datadog.**
  - **Steps:** a Create Jira Issue button on the incident, and create an issue from the Error Tracking panel.
  - **Source:** https://docs.datadoghq.com/incident_response/incident_management/setup_and_configuration/integrations/jira/

**Adopt:**
- **Inbox:** Linear's one action per decision, straight from the row without expanding it, with an optional note.
- **Filing:** PagerDuty's prefilled "Create task" from the finding, with the link shown on the finding afterwards.

**Target:**
- **Approve:** 1 click.
- **Answer:** 1 click, type, Enter.
- **File from a finding:** 2 clicks.

## settings-save-undo

Change a setting, with save and undo.

- **GitLab Pajamas (design system).**
  - **Save:** manual Save by default. Autosave only for a single low-risk field, and never for security or financial data.
  - **Feedback:** inline "Saving… → Saved".
  - **Undo:** persistent, inline beside the change, not only inside a toast.
  - **Source:** https://design.gitlab.com/patterns/saving-and-feedback/
- **Vercel project settings.**
  - **Save:** a Save per section. Some changes apply on the next deployment.
  - **Source:** https://vercel.com/docs/builds/configure-a-build
- **Figma.**
  - **Save:** autosave, with named versions and a restore that keeps both states.
  - **Source:** https://help.figma.com/hc/en-us/articles/360038006754-View-a-file-s-version-history
- **Gmail Undo Send.**
  - **Undo:** a toast with Undo, for 5–30 seconds.
  - **Source:** https://support.google.com/mail/answer/2819488

**Adopt:**
- **Pajamas:** autosave with inline "Saved · Undo" for low-risk single fields (time zone), and a section Save elsewhere.
- **Never autosave:** credentials and the measurement channel (guardrail thresholds stay operator-only; see AGENTS.md).

**Target:** 2 actions (open, change) plus an undo that stays next to the change.

## rotate-and-disconnect

Rotate or disconnect a key or connection.

- **Stripe.**
  - **Rotate:** Rotate key → choose when the old key expires (now, or up to 7 days) → the new key is shown once. Both keys work during the overlap, and per-key request logs show when the old one goes quiet.
  - **Source:** https://docs.stripe.com/keys
- **GitHub tokens.**
  - **Rotate:** an email before a token expires; Regenerate creates a copy with the same scopes.
  - **Source:** https://github.blog/changelog/2021-07-26-expiration-options-for-personal-access-tokens/
- **Vercel (graded friction).**
  - **Friction:** deleting a project needs the typed name plus a phrase. Pausing needs the typed name. Resuming needs no confirmation.
  - **Source:** https://vercel.com/docs/projects/managing-projects
- **Slack.**
  - **Disconnect:** Remove App → one confirm.
  - **Source:** https://slack.com/help/articles/360003125231-Remove-apps-and-custom-integrations-from-your-workspace
- **Zapier.**
  - **Rotate:** Reconnect re-authenticates in place and repairs every Zap that uses it.
  - **Disconnect:** Delete → one confirm.
  - **Source:** https://help.zapier.com/hc/en-us/articles/8496290788109-Manage-your-app-connections

**Adopt:**
- **Rotate:** Replace key on the connection itself. The old key keeps working until the new one passes its test, the Stripe-style overlap, so a typo never breaks collection.
- **Disconnect:** one confirmation that names what stops. It stays because it is irreversible: the secret is deleted, and Google's grant is revoked at Google.

**Target:**
- **Rotate:** 3 actions.
- **Disconnect:** 3 actions, 1 confirmation.

## arrange-wall

Arrange a dashboard.

- **PostHog dashboards.**
  - **Edit:** press E (or Edit layout) → drag → press E again to save, or Esc to discard.
  - **Source:** https://posthog.com/docs/product-analytics/dashboards
- **Grafana.**
  - **Edit:** Edit → drag or resize → Save, with an optional description.
  - **Versions:** every save is a version, and Restore makes a new one.
  - **Sources:** https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/create-dashboard/ · https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/manage-version-history/
- **Datadog.**
  - **Versions:** changes are tracked automatically, with a history you can preview and restore.
  - **Source:** https://docs.datadoghq.com/dashboards/guide/version_history/
- **Geckoboard.**
  - **Edit:** drag and resize directly. TV screens pick up the change on refresh.
  - **Source:** https://support.geckoboard.com/en/articles/6055766-arrange-widgets-on-a-dashboard

**Adopt:**
- Edit straight from the TV dashboard entry: move, then Save.
- The reason is optional, like Grafana's description.
- Versions replace the reason as the safety net.

**Target:** 3 actions. The walk measured 7 actions and 2 confirmations.

## guidance

General guidance behind the audit's rules.

- **Save and test in one press:** the canonical pattern. https://grafana.com/developers/plugin-tools/tutorials/build-a-data-source-backend-plugin
- **Wizard length:**
  - Wizards suit novices and irritate repeat users. https://www.nngroup.com/articles/wizards/
  - What matters is the number of fields, not steps; 8 fields is enough for a checkout. https://baymard.com/blog/checkout-flow-average-form-fields
- **One representation per state:**
  - Carbon: no status indicator where no action is needed, and at most 5–6 indicators on a screen. https://v10.carbondesignsystem.com/patterns/status-indicator-pattern/
  - NN/g: "Redundant messaging can be irritating for users." https://www.nngroup.com/articles/status-tracker-progress-update/
- **Grouping repeated subjects:**
  - Proximity shows membership. https://www.nngroup.com/articles/gestalt-proximity/
  - Gmail's conversation view is the product example. https://support.google.com/mail/answer/5900
