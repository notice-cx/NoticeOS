# Session exploration reports

The asset's Journeys tab displays stored session paths separately from GA4 ordered-user funnels. It shows the percentage of eligible sessions reaching each section, sessions reaching two or more distinct sections, returns, recorded exits and weekly history. Section audiences overlap; the paths themselves are mutually exclusive. These counts are not GA4 active users, page views, ad impressions or revenue.

## Publisher contract

Include `sessionExploration` in the existing report envelope sent to `POST /api/pulse`, authenticated with the asset's existing report token, or returned by its existing envelope-format report endpoint. The existing ingest job validates and stores it with the report. Viewing Journeys reads stored reports and makes no provider request. No database migration is required.

Create or read an exploration journey through the existing journey API or MCP tools, and use its `id` and `version` in `journeyId` and `journeyVersion`. A report for an earlier saved version remains stored but is excluded from the current journey. `definitionId` is a separate publisher version: change it whenever session eligibility, classification, consent coverage or session rules change. Do not reuse a version for different measurement semantics.

For a new first-party definition, use `kind: "exploration"`, `source: "first-party"`
and `steps: []`. No GA4 event conditions are required. The journey service assigns
version 1 on creation; include `edit_token: null` and `dry_run: true` to prepare
the definition before saving it. Keep its status `planned` until collection is approved.
Set `reportingLagDays` to the publisher's declared delay: `2` means the latest
settled report date is two calendar days before today. The default is `1`.
The 7- and 28-day windows use that fixed cutoff, display their dates, and retain
overdue missing days as gaps. Complete compatible weekly history remains visible
when the current period is incomplete.

An asset with an existing metrics scrape can add a separate report endpoint
inside the same pull row:

```json
{
  "asset": "example.com",
  "url": "https://example.com/api/internal/metrics",
  "format": "prometheus",
  "enabled": true,
  "metrics": {"signups": {"counter": "profiles"}},
  "additionalEndpoints": [{
    "url": "https://example.com/api/internal/report",
    "format": "envelope",
    "enabled": false
  }]
}
```

The supplemental endpoint uses the same asset token. An envelope without
`sessionExploration` is valid before the publisher configures its journey.
Enable the endpoint only after approval for its first live read.

```json
{
  "asset": "example.com",
  "generatedAt": "2026-10-26T01:00:00Z",
  "capabilities": ["sessionExploration"],
  "metrics": {},
  "sessionExploration": [{
    "schemaVersion": 1,
    "source": "first-party",
    "journeyId": "explore",
    "journeyVersion": 1,
    "definitionId": "sections-v1",
    "date": "2026-10-25",
    "timeZone": "UTC",
    "sessionTimeoutMinutes": 30,
    "sessions": 100,
    "surfaces": [
      {"id": "articles", "label": "Articles"},
      {"id": "tools", "label": "Tools"}
    ],
    "paths": [
      {"surfaces": ["articles"], "sessions": 60, "ending": "exit"},
      {"surfaces": ["articles", "tools", "articles"], "sessions": 30, "ending": "exit"},
      {"surfaces": ["tools"], "sessions": 5, "ending": "continued"}
    ]
  }]
}
```

The example contains 100 eligible session starts. Thirty sessions reached two distinct sections and returned to Articles. Five continued beyond the reported prefix; their later destinations are unknown. Five sessions have no reported path. Neither group is counted as an exit. Report a zero-session day with `sessions: 0` and `paths: []`; omitting a day records missing coverage.

## Session and section rules

- Assign each eligible session to its start date in `timeZone`. End a session after the declared inactivity timeout. Count a session once in one path bucket for that day, including sessions crossing midnight. Publish after the day closes plus the timeout; if a session is still active, report its prefix with `ending: "unknown"` and later replace that day's histogram.
- Define stable, finite section categories such as Articles, Search and Tools. Count navigation between eligible sections in order. Collapse consecutive observations of the same section. Retain returns such as Articles → Tools → Articles. A second page inside Articles does not prove a second distinct section.
- `sessions` covers every eligible session start measured by this source, including sessions whose path is unavailable. Do not use an independent GA4 audience as this denominator. Exclude bots and internal traffic according to the publisher's declared eligibility rules; change `definitionId` when those rules change. The report does not support sampled or estimated counts.
- `exit` means the session ended at the last reported section. `continued` means further navigation is known but omitted from the bounded prefix. `unknown` means the terminal destination is not established. Never replace unknown destinations with exits.
- Send category IDs and labels with aggregated counts only. Do not send raw URLs, query strings, user IDs, session IDs or event payloads. Classification and session identity stay with the source.

A report supports at most 32 sections, 128 path buckets and eight section positions per path. An envelope supports at most eight reports, with unique journey/date pairs. IDs use letters, digits, dots, underscores and hyphens, up to 64 characters. Counts are whole numbers from zero through one billion; path buckets must be positive, unique by sequence and ending, refer to declared sections, and sum to no more than `sessions`. The publisher must combine identical paths before sending.

## Corrections and history

A new report for the same journey/date replaces that day's whole histogram. The newest received revision wins; retries never add sessions. Reports for other days or journeys and envelopes omitting exploration do not erase earlier histograms. A malformed latest historical report leaves that day unavailable rather than restoring stale counts.

The Tower reads up to 64 days of stored reports for current/prior 7- and 28-day periods and eight completed Monday–Sunday weeks. It combines matching publisher definitions and timeouts within a period. Daily paths use the selected display timezone; shifted boundaries and timezone-created gaps use estimated averages, with the number of estimated days displayed. Missing days, missing paths and truncated or unknown endings retain partial coverage; incompatible definitions make the period unavailable. Comparisons and history points require complete compatible periods. At most the 128 largest paths are displayed in a period; omitted paths remain part of the session denominator and reduce displayed coverage.

This contract enables local implementation and synthetic verification. Activating new capture, changing tracking or consent, enabling exports and reading provider accounts remain separate operator actions. Existing GA4 event/page totals cannot reconstruct same-session branches. The producer must supply actual session sequences before the view can display real paths.
