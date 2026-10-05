# Connecting the task source, Discord and calendar feeds in the panel (2026-09-23, beads `ro-ujb9.152`, `ro-ujb9.96.7.14`)

**Historical design:** D32 made Tasks core on 2026-09-30. The optional
Beads connection described below is superseded by automatic installation and
Settings → Task projects (`ro-ujb9.246.3`). The current open-core-Tasks walk
retains the historical flow id for measurement continuity; project host steps
still use the researched copyable-command pattern.

Beads, the first task source under the former D32 policy, used to connect on a second page: the
Integrations row's Connect went to Settings → Task projects, where a project row
was added and a terminal checklist followed. Every credential provider connects
in the connect panel over the Integrations list. This brief records how
comparable products connect a work tracker or a local project to a hosted
workspace, and what the panel adopts. Researched on 2026-09-23 from the
vendors' own docs.

## Prior art

- **Linear (GitHub integration).**
  - **Steps:** Settings → Integrations → GitHub → Enable, pick the organization,
    then All or Only select repositories.
  - **Status:** linked pull requests show on the issue, and an automation banner
    shows whether the sync is running or failing.
  - **Source:** https://linear.app/docs/github
- **Vercel (`vercel link`).**
  - **Steps:** the local directory is tied to a project by one command,
    `vercel link` (non-interactive with `--yes --project`).
  - **Pattern:** the hosted side names the project; the one thing only the
    machine can do is a single copyable command.
  - **Source:** https://vercel.com/docs/cli/link
- **Supabase (`supabase link`).**
  - **Steps:** `supabase link --project-ref <ref>` links the local project to
    the hosted one and checks its configuration.
  - **Source:** https://supabase.com/docs/reference/cli/supabase-link
- **Sentry (SDK setup).**
  - **Proof:** setup ends by verifying — throw a test error and look for it on
    the Issues page. The connection is proven by the first event arriving,
    not by a saved setting.
  - **Source:** https://docs.sentry.io/platforms/javascript/

**Adopt:**
- Linear's one place to connect, with the status on the connection itself.
- Vercel's and Supabase's host step as a command filled in with the project,
  with Copy — no paragraph explaining it.
- Sentry's proof by arrival: the row and the panel read Collecting once the
  project is saved, and Working only once the runner has read it.

**Target:** from Integrations, the row's Connect, the task prefix and Connect —
one panel, no page change — then the host steps with Copy, and Working in
place once the runner reads the project.

## connect-webhook-and-feeds

Discord and the calendar feeds (bead `ro-ujb9.96.7.14`) left their own
four-step page, which saved first and showed a green chip before any test.
Both are one secret URL (or a few named ones) proved by one call. Researched on
2026-09-23 from the vendors' own docs.

- **Grafana (contact point).**
  - **Proof:** a contact point has a **Test** button that opens a dialog and
    sends a test notification to the destination before anyone relies on it.
  - **Source:** https://grafana.com/docs/grafana/latest/alerting/configure-notifications/manage-contact-points/
- **Slack (incoming webhook).**
  - **Steps:** add a webhook to a channel, copy its unique URL.
  - **Proof:** Slack's own suggested test is a POST of a small message, then
    checking it appears in the channel — the delivery is the proof.
  - **Source:** https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks
- **Google Calendar (secret address in iCal format).**
  - **Steps:** Settings → the calendar → Integrate calendar → copy the secret
    address; Reset invalidates an old one.
  - **Pattern:** the address is the credential — nothing else is typed.
  - **Source:** https://support.google.com/calendar/answer/37648

**Adopt:**
- Grafana's and Slack's proof by delivery for a webhook: Connect posts one
  labelled test message and keeps the webhook only when Discord takes it — and,
  because it lands in the operator's channel, the panel says so beside the
  press.
- Google's secret address as the whole credential: one row per feed, a name
  and the pasted address, each feed read once before the map is kept.

**Target:** Integrations, the row's Connect, one paste, Connect — 4 actions,
one panel, 0 words, ending on the provider's answer.
