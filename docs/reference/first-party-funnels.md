# First-party funnel reports

The asset's Journeys tab shows an asset-reported funnel with the same step bars, 7- and 28-day periods, prior-period comparisons and weekly history as a GA4 funnel. The step counts come from the asset's own reports instead of GA4, so a funnel can end at an outcome GA4 does not receive, such as a payment the payment provider confirmed to the asset. An asset-reported funnel has no GA4 visitor baseline; its percentages use the entries at the first step.

## Defining the journey

Create the journey with `save_journey` or `PUT /api/assets/:asset/journeys/:id`, with `kind: "funnel"`, `source: "first-party"` and two to ten steps whose `alternatives` are empty:

```json
{
  "id": "contribution",
  "label": "Contribution offer to payment",
  "goal": "One-time contribution",
  "kind": "funnel",
  "source": "first-party",
  "status": "planned",
  "steps": [
    {"id": "offer", "label": "Offer seen", "alternatives": []},
    {"id": "checkout", "label": "Checkout opened", "alternatives": []},
    {"id": "paid", "label": "Paid", "alternatives": []}
  ]
}
```

The steps carry no GA4 event conditions or time limits; the asset applies its own rules. `reportingLagDays` (1 to 14, default 1) sets how many days before today the periods end. GA4 collection skips these journeys. The Tower's definition editor changes labels, the goal and the status; it does not add, remove or reorder steps, because the step IDs and their order match the asset's reports. A change to the step IDs, their order or `reportingLagDays` saves a new version, and reports naming an earlier version are excluded.

## Publisher contract

Include `firstPartyFunnels` in the existing report envelope sent to `POST /api/pulse` with the asset's report token, or returned by its envelope-format report endpoint (see [session exploration reports](session-exploration.md) for a supplemental endpoint). The ingest job validates and stores it with the report. Viewing Journeys reads stored reports and makes no request to the asset or a provider. No database migration is required.

```json
{
  "asset": "example.com",
  "generatedAt": "2026-11-10T01:00:00Z",
  "capabilities": ["firstPartyFunnels"],
  "metrics": {},
  "firstPartyFunnels": [{
    "schemaVersion": 1,
    "source": "first-party",
    "journeyId": "contribution",
    "journeyVersion": 1,
    "definitionId": "offers-v1",
    "date": "2026-11-09",
    "timeZone": "UTC",
    "unit": "offers",
    "steps": [
      {"id": "offer", "count": 120},
      {"id": "checkout", "count": 9},
      {"id": "paid", "count": 2}
    ]
  }]
}
```

`journeyId` and `journeyVersion` are the saved journey's `id` and `version`. `steps` lists every step of the saved journey, in its order, with the same IDs. `definitionId` is the publisher's own version: change it whenever eligibility, exclusions or counting rules change. `unit` is the plural noun the Tower shows beside every count, such as `offers` or `visits`.

## Counting rules

- Count each entity, such as an offer shown, a visit or an account, once, on the date in `timeZone` when it reached the first step.
- Count an entity at a later step only when it also reached every earlier step. A step's count is never larger than the count before it; the ingest job refuses an envelope holding a report that breaks this.
- Count an entity at a later step on its first-step date, even when it reached that step on a later day. A period's count is the sum of its daily counts, so this rule keeps every entity in one day.
- Report a day with no entries with every count at `0`. A day without a report records missing coverage.
- Send aggregated counts only. Do not send entity IDs, visitor or session IDs, URLs, payer details or amounts.

## Corrections and periods

- An outcome that arrives after its first-step date, such as a payment confirmed after midnight, changes that earlier day's counts. Resend the day: the newest received report for a journey and date replaces the earlier one, and retries never add counts. A report for a different version or with different step IDs also replaces the day, which then shows no counts until a report for the current version arrives.
- A period shows counts only when every day in it has a report and all of them share one `definitionId`, `unit` and `timeZone`. Otherwise the period shows no counts and the number of days reported.
- Periods use the asset's time zone from its newest report. The current 7- and 28-day periods end `reportingLagDays` days before today; the prior periods are the adjacent ones before them.
- Weekly history shows Monday–Sunday weeks, from the first week that holds a report, for up to 12 weeks before the current week.

A report holds two to ten steps; counts are whole numbers from zero through one billion; `unit` holds at most 32 characters. An envelope holds at most 64 reports with unique journey/date pairs, and each report's date must have ended in its time zone when the envelope was generated.
