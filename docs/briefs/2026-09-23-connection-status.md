# One status per connection (2026-09-23, bead `ro-ujb9.96.7.3`)

What a connection's status says, where it is shown, and what it deliberately
does not say. The model is `apps/tower/shared/connection-status.ts`; its
behaviour is pinned by `apps/tower/test/connection-status.test.ts`.

## The problem, measured

On 2026-09-23 `/integrations` showed Google, Bing, DataForSEO, Clarity and
PostHog as red "Failing" while 350 Google operations were healthy. Each row
took the worst of every stored attempt: report dates that failed during the
2026-09-14 outage and were never retried (the retry is `ro-aed0.7`), one Bing
site that was never verified (`ro-63na`), and a few incomplete reports. The
Google provider page said "Not connected" nine times for one connection, and
System health repeated each provider's name on every operation row. The flow
gate recorded 11 duplicate statuses and 17 ungrouped repeats across the
integration flows (`apps/tower/ux-flows.json`).

## The model

- **Connection status** — Not connected → (Checking, in the connect panel) →
  Key accepted → Collecting → Working | Failing, plus Overdue, Not using and
  Unknown. Working needs a stored successful attempt; a saved key nobody tested
  is Not checked; a monitoring read that is not current is Unknown.
- **Judged by the latest attempt.** Each kind of work (a capability, and for an
  archive one report family) is judged by its newest attempt. An older failure
  that a later success superseded is a missing report, never a status.
- **Site, then connection.** A site fails when its latest work fails. A
  connection fails when its credential is refused or most of its sites fail;
  otherwise one failing site is a fact on the connection ("1 site failing") and
  a status on the site's own row.
- **Facts, once, as chips**: sites failing, reports missing, reports
  incomplete. An incomplete report is a data fact, never a failed connection.

## Where it is shown

- `/integrations`: each provider row — status plus facts.
- A provider's page: the status in the header, then its **Sites**, each with
  its own status, a failing site's reason on the row, and what to do plus the
  operations and missing dates when opened.
- An asset's Data sources: each source reads its site's status for that
  provider (`laneStatus`), so it cannot disagree with the provider's page.
- System health: **Connections**, grouped by provider then site, Needs you by
  default; the register grid below reads the same words. Sources no provider
  collects (nightly report, uptime, revenue) stay in their own list.
- The asset header, Home's asset table and every Wall card *(bead
  `ro-ujb9.96.7.16`)*: one mark per source (`DataSourceIcons`), read by
  `sourceReadings` — `laneStatus` over the same credentials and monitoring
  items — so a mark never disagrees with its Data sources row. They used to
  read the latest 15-minute run, which called a source Working while its
  report archive was refused. The header's one-word verdict ("Receiving
  data") is gone; the marks are the header's statement. The Data sources tab's
  pip is the worst mark (Failing red, Overdue amber), and the setup
  checklist counts sources from the same statuses without listing them again.
  Pinned by `apps/tower/test/one-status-everywhere.test.tsx`, which renders one
  fixture on all five screens.

## Prior art

Researched 2026-09-23 from each vendor's own documentation.

- **Airbyte — connection status.** Connection: Healthy / Failed / Running /
  Paused / Queued; each stream beneath it: Synced / Syncing / Queued / Error /
  Action Required. Healthy is defined as *the most recent sync succeeded*, so
  old failures do not keep a connection red; per-stream status sits nested
  under the connection; re-collecting history ("Refresh stream") is a separate
  action, not part of the status.
  https://docs.airbyte.com/platform/cloud/managing-airbyte-cloud/review-connection-status
- **Fivetran — connection status.** One badge per connection (Active, Delayed,
  Broken, Incomplete, Paused), with setup state apart from sync state and an
  initial historical sync shown as its own marker rather than folded into
  Broken; per-table detail lives inside the connection.
  https://fivetran.com/docs/using-fivetran/fivetran-dashboard/connectors ·
  https://fivetran.com/docs/using-fivetran/fivetran-dashboard/connectors/status
- **Stripe — webhook endpoints.** The endpoint is enabled or disabled; each
  delivery is Delivered / Pending / Failed in a log under that one endpoint. An
  endpoint is disabled only after days of continuous failure, not because a
  delivery once failed.
  https://docs.stripe.com/webhooks
- **Datadog — integration tiles.** Installed / Detected / Available / Missing
  Data, where Missing Data means no metrics in the last 24 hours: a recency
  window, not a lifetime error count.
  https://docs.datadoghq.com/getting_started/integrations/
- **Segment — delivery overview** (search result only; the page did not load
  for the researcher): successfully delivered and failed counts per
  destination over a recent window, apart from whether the destination is on.
  https://segment.com/docs/connections/delivery-overview/

**Adopted:**
- Airbyte's rule: a connection is judged by its latest attempts, never by any
  failure ever recorded.
- Airbyte's and Fivetran's nesting: the connection's one status on its row, each
  site's status beneath it where it is fixed.
- Fivetran's and Segment's separation: missing or incomplete reports are a
  count beside the status, not a colour on it.
- Stripe's threshold: one site failing does not fail the connection; most of
  them, or a refused credential, does.
- Re-collecting missing dates stays a separate job (`ro-aed0.7`), as Airbyte
  keeps Refresh stream apart from its health badge.
