---
title: "Send your own report"
description: "Have a product report its own daily counts to NoticeOS, in the exact shape the product accepts, and see where they show up."
---

# Send your own report

This page gets a product you run reporting its own daily counts into NoticeOS, so they sit beside its traffic and revenue.

## Before you begin

- The site added in NoticeOS. Its id is its domain as added in the product.
- The site's token. Each site has one secret shared with the installation. It authenticates a push and it is what NoticeOS presents when it fetches. The installation holds the map of site id to token in its secrets file, `workers/ingest/.dev.secrets.json`, under `ASSET_TOKENS`. Whoever runs the installation sets it; it is one of the four bootstrap secrets that are never entered in the product. Your product holds its own copy and gates its metrics endpoint with it.

### What belongs in a report

A report carries only what your product's own servers can count: requests at a route, rows in its database, objects in storage. Client-side analytics such as GA4 are not part of it. NoticeOS collects those centrally and joins them to the site by its id; a product never queries an analytics provider about itself.

Each metric is one name with three numbers: how many in the last 24 hours, the average per day over the last 7 days, and the all-time total. A stock figure, such as how many items a catalogue holds, can ride along in `metrics` for the totals row, but leave it out of `capabilities` so an unchanged catalogue is not read as a day with no activity.

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

- `asset` is the site's id, which is its domain as added in the product. It must match the token presented.
- `generatedAt` is a date-time with a time-zone offset.
- `capabilities` lists the metric names the product treats as activity.
- `metrics` maps each name to `last24h` (whole number), `avg7d` (number) and `total` (whole number), none negative.
- `negativeByPage` and `flags` are optional. A flag has a `severity` of `info`, `warn` or `error` and a `kind` of `anomaly`, `opportunity` or `milestone`; a milestone is always `info`.

## Push the report each night

1. In your product, build the report in the shape each night.
2. Send it to the installation's ingest at `POST /api/pulse`, with the header `Authorization: Bearer <token>`.

## Have NoticeOS fetch it instead

1. On the site's **Settings** tab, open **Data collection**.
2. Set **Metrics endpoint** to the address your product answers at.
3. Under **Answers with**, select **Nightly report envelope** when the address returns the report shape, or **Prometheus metrics page** when it exposes a metrics page that NoticeOS maps into it.
4. Check that **Nightly fetch** reads **Enabled**, not **Paused**.

The same panel shows **Report endpoint** and **Auth source** for push, **Schedule**, and **Last report** once one has arrived. The nightly fetch runs at 02:30 UTC; change it on **Settings** > **Data collection** under **Nightly reports**.

## Push by hand once

1. In a terminal, with the report saved as `report.json`, run:

   ```sh
   curl -sS -X POST https://<your-installation>/api/pulse \
     -H 'authorization: Bearer <token>' \
     -H 'content-type: application/json' \
     -d @report.json
   ```

## Verify

- The ingest answers `201` with `{ "ok": true }` when the report is stored.
- The site's **Data sources** tab has a **Daily metrics** table: **Metric**, **Latest report · 24h** with its date, **Prior reports · avg / day**, and **History · daily counts** as a small chart. Before the first report it says **Nothing yet — metrics appear with this site's first nightly report.** Missing days are counted and shown, never drawn as zero.
- The site's **Overview** can show a totals row from `total`, once you add the cards on the site's **Settings** tab under **Card totals**.
- **Alerts** fire on a metric only after four matching prior weekdays exist, so a new metric is quiet for at least 28 days. A day is flagged when its count is improbable against that baseline and the baseline is at least three a day. Thresholds are in **Settings** > **Alert rules**.

## If it didn't work

- The ingest answers `401`: the token or the site id does not match. `asset` must equal the site's domain as added, and the token must be the one in `ASSET_TOKENS` for that site.
- The ingest answers `422` with a list of issues: the shape is wrong. A rejected report stores nothing. Fix the listed fields and send it again.
- The report stops arriving: the product raises an alert when a nightly fetch fails, and marks the site's report stale on the **Data sources** tab. See [Troubleshooting](/operate/troubleshooting).

The contract is in [doc 02, Signal contract](../02-signal-contract.md). Onboarding a site, including counting without a database: [doc 09, Onboarding a site](../09-onboarding-a-site.md). The four bootstrap secrets: [doc 06, Operations & self-observability](../06-operations.md#bootstrap-secrets-vs-integration-credentials).

## Next steps

- [Alerts](/tower/alerts)
- [Scheduled jobs](/operate/scheduled-jobs)
- [Sites](/tower/sites)
