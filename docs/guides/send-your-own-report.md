---
title: "Send your own report"
description: "Have a product report its own daily counts to NoticeOS, in the exact shape the product accepts, and see where they show up."
---

# Send your own report

This page shows how to make a product you run send its own daily counts to NoticeOS, so they are shown beside its traffic and revenue.

Most of the data NoticeOS has about an asset comes from data sources you connect on Integrations, such as Google Analytics. A **report** adds counts from your product's own servers, such as sign-ups, saved items, or rows in its database. Send a report once a day. NoticeOS shows the counts on the asset's page and can raise an alert when one moves unusually. Standalone installations can also fetch the report.

## Before you begin

- The asset added in NoticeOS. Its id is its domain as added in the product.
- In a local customer workspace, enable `siteReports` in the private customer configuration. The local runtime supplies the exact origin to both Workers. Once enabled, open the asset's **Settings** tab and choose **Create token** under **Daily reports**. Copy the token to your server when it appears. One token authorizes reports for one asset in one workspace. **Replace token** and **Revoke token** invalidate the previous token.
- In a standalone installation, the operator keeps the token map under `ASSET_TOKENS` in `workers/ingest/.dev.secrets.json`. The token authenticates a push and, when configured, NoticeOS presents it to the asset's metrics endpoint for a fetch. See [the bootstrap secrets](/operate/secrets-and-credentials#four-bootstrap-secrets-stay-in-the-environment).

### What belongs in a report

A report contains only what your product's own servers can count: requests at a route, rows in its database, objects in storage. Client-side analytics such as GA4 are not part of it. NoticeOS collects those centrally and joins them to the asset by its id; a product never queries an analytics provider about itself.

Each metric is one name with three numbers: how many in the last 24 hours, the average per day over the last 7 days, and the all-time total. A stock figure, such as how many items a catalogue holds, can be included in `metrics` for the totals row, but leave it out of `capabilities` so an unchanged catalogue is not counted as a day with no activity.

### The shape

```json
{
  "asset": "example.com",
  "generatedAt": "2026-10-10T02:00:00.000Z",
  "capabilities": ["signups", "plansSaved"],
  "metrics": {
    "signups":    { "last24h": 10, "avg7d": 9.4, "total": 4210 },
    "plansSaved": { "last24h": 0,  "avg7d": 6.5, "total": 1900 },
    "catalogItems": { "last24h": 0, "avg7d": 0, "total": 2402 }
  },
  "negativeByPage": [{ "page": "/calculator", "count": 3 }],
  "flags": [
    { "severity": "info", "kind": "milestone", "metric": "signups", "msg": "4000 signups" }
  ]
}
```

- `asset` is the asset's id, which is its domain as added in the product. It must match the token presented.
- `generatedAt` is a date-time with a time-zone offset.
- `capabilities` lists the metric names that count as activity.
- `metrics` maps each name to `last24h` (whole number), `avg7d` (number) and `total` (whole number), none negative.
- `negativeByPage` and `flags` are optional. A flag has a `severity` of `info`, `warn` or `error` and a `kind` of `anomaly`, `opportunity` or `milestone`; a milestone is always `info`.

## Push the report each night

1. In your product, build the report in the shape each night.
2. Send it to `POST /api/pulse` with the header `Authorization: Bearer <token>`. Use the configured local sender address or the standalone ingest origin.

A loopback-only Tower accepts the sender on the same machine. When the Tower uses a home-network hostname, a sender runs inside the app container, connects to `127.0.0.1:5173`, and supplies the configured Tower hostname and published port in the Host header.

## Fetch reports on a standalone installation

1. On the asset's **Settings** tab, open **Data collection**.
2. Set **Metrics endpoint** to the address where your product serves its metrics.
3. Under **Response format**, select **Nightly report envelope** when the address returns the report shape, or **Prometheus metrics page** when it exposes a metrics page that NoticeOS maps into it.
4. Check that **Nightly fetch** shows **Enabled**, not **Paused**.

The same panel shows **Report endpoint** and **Auth source** for push, **Schedule**, and **Last report** once one has arrived. The nightly fetch runs at 02:30 UTC; change it on **Settings** > **Data collection** under **Nightly reports**.

## Push by hand once

1. In a terminal with the report saved as `report.json`, replace `<origin>` with the configured address, such as `http://127.0.0.1:5173` for a local customer workspace or the ingest origin for a standalone installation.

   ```sh
   curl -sS -X POST '<origin>/api/pulse' \
     -H 'authorization: Bearer <token>' \
     -H 'content-type: application/json' \
     -d @report.json
   ```

## Verify

- The ingest returns `201` with `{ "ok": true }` when the report is stored.
- Use the original date to correct a report. Repeated submissions keep the same daily report number and add a revision. The current metrics use the latest revision, and the daily counter counts the date once.
- The asset's **Data sources** tab has a **Daily metrics** table: **Metric**, **Latest report · 24h** with its date, **Prior reports · avg / day**, and **History · daily counts** as a small chart. Before the first report it shows **Nothing yet — metrics appear with this asset's first nightly report.** Missing days are counted and shown, never drawn as zero.
- The asset's **Overview** can show a totals row from `total`, once you add the cards on the asset's **Settings** tab under **Card totals**.
- **Alerts** fire on a metric only after four matching prior weekdays exist, so NoticeOS raises no alerts on a new metric for at least 28 days. A metric averaging 4.6 or more a day is tested one day at a time and a quieter one over several days, up to 14; a count is flagged when it is improbable against that baseline. Thresholds are in **Settings** > **Alert rules**.

## If it didn't work

- The ingest returns `401` when the report's asset and current token fail to match. Use the exact asset id from NoticeOS and the current token issued for it.
- The ingest returns `422` with a list of issues: the shape is wrong. A rejected report stores nothing. Fix the listed fields and send it again.
- The report stops arriving: the product raises an alert when a nightly fetch fails, and marks the asset's report stale on the **Data sources** tab. See [Troubleshooting](/operate/troubleshooting).

The contract is in [doc 02, Signal contract](../02-signal-contract.md). Onboarding an asset, including counting without a database: [doc 09, Onboarding an asset](../09-onboarding-a-site.md). The four bootstrap secrets: [doc 06, Operations & self-observability](../06-operations.md#bootstrap-secrets-vs-integration-credentials).

## Next steps

- [Alerts](/tower/alerts)
- [Scheduled jobs](/operate/scheduled-jobs)
- [Portfolio](/tower/sites)
