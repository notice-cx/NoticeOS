# Brief — each site's live users as a minute pulse (2026-09-23)

Bead: `ro-trai.27` (epic `ro-trai`). Decision: D34 in `config/decisions.md`
(operator, 2026-09-23), amending D28 — the 5-minute live count returns, as
the bright end of a pulse. Contract: [doc 25 § Site rows](../25-the-wall.md#site-rows).
Captures: `artifacts/wall-build-2026-09-23/pulse/` (private historical evidence).

The operator: "we need to bring back the 30-min and 5-min live user counts as
they show momentum. Right now we have one 'live' users number which is not
that clear as to what it means." Offered a speed-arrow chip, a two-bar
comparison and a minute pulse, the operator chose the pulse.

## Prior art

| Product | Source | What it does | What we adopted |
|---|---|---|---|
| Google Analytics 4 — Realtime | https://support.google.com/analytics/answer/9271392 | The Realtime overview's first card leads with active users in the last 30 minutes, with a bar a minute under it for those 30 minutes; active users in the last 5 minutes is reported beside it. | The whole shape: the 30-minute figure, a bar a minute under it, oldest on the left. The 5-minute window is the pulse's newest five bars, drawn bright, with their own count over them. |
| Google Analytics 4 — Data API realtime | https://developers.google.com/analytics/devguides/reporting/data/v1/realtime-basics · https://developers.google.com/analytics/devguides/reporting/data/v1/quotas | `runRealtimeReport` defaults to the last 30 minutes; the `minutesAgo` dimension ("00" the current minute) splits it by minute. Realtime requests draw on their own token budget: 200,000 tokens a property a day, 40,000 an hour, 14,000 per project per property per hour. | One extra realtime request per reading, grouped by `minutesAgo` with no range. Both realtime requests are one reading a minute (below). |
| Google Analytics (Universal) — Real-Time overview | Retired 2023; the report many operators learned on | "Right now: N active users", then page views per minute over 30 minutes and per second over 60 seconds, the newest bar at the right. | The per-minute strip read right to left as "now". Not the per-second strip: GA4 has no per-second data, and a TV three metres away gains nothing from it. |
| Plausible — realtime dashboard | https://plausible.io/docs/realtime-dashboard | "Current visitors" are the last 5 minutes; the realtime graph shows the previous 30 minutes; refreshed every 30 seconds. | The two windows answer different questions: 5 minutes is "right now", 30 minutes is "this half hour". Both stay, the shorter one inside the longer. |

## What the operator sees

- The figure is still the last 30 minutes, labelled once in the table's
  heading ("Live · 30 min") and beside the figure where there is no heading
  (a phone's stacked row, the one-site Today tile).
- Under it, 30 bars in the `traffic` colour. The newest five are bright; the
  25 before them are muted. Over the bright end is its own count
  ("88 · 5 min"). A bright end taller than the rest is a site picking up.
- A minute nobody was active is a tick on the floor. A minute the reading did
  not cover is empty, so an unread minute is never drawn as a quiet one.
- An old reading, or the last good one kept after a failed read, turns grey.
  A clock and the reading's age replace the 5-minute count, because that
  reading's last five minutes are over. With no reading, or no GA4, the cell
  shows a dash, never a zero.

## The quota decision

One realtime request costs a property about 46–49 tokens
(`ga4-recovery-2026-09-12.json`; private historical evidence).
The Wall is on all day, so the old single request every 30 seconds already
spent about 2,880 × 46 ≈ 132k of the 200k daily realtime budget. A second
request at the same cadence would take that to ~265k, and the live figure would
go dark every evening once the budget ran out.

So a reading is now **both requests together, once a minute**, shared by every
open screen through the ingest cache. That is 2 × 1,440 requests a property a
day, the same as the old 2,880. The pulse cannot show anything finer than a
minute anyway. The cost: the figure moves once a minute rather than twice. The
freshness budget (`LIVE_TRAFFIC_FRESH_MS`, 180 s) still covers the new worst
case of about 170 s.

The per-minute request's own token cost is measured, not assumed. Each reading
reports what both requests cost, summed (`quota.realtime` on
`/api/ga4/realtime`). The first live readback is bead `ro-trai.30`.
