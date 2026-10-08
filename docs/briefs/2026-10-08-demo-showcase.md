# The demo as the product's showcase

Scenario version 4, 2026-10-08. It amends
[`2026-10-01-demo-portfolio.md`](2026-10-01-demo-portfolio.md), which still
holds every rule this brief does not change. The owner asked for the public
demo to be the source of the product's screenshots: every Wall widget showing
data, live user counters, workflow history and charts with visible shape. This
is a dated design record, not a task list.

## What the deployed v3 demo showed

A read of the public demo's own API on 2026-10-08 found:

| Surface | v3 state | Cause |
|---|---|---|
| Wall site rows | A dash for live users | The seeded integrations roster declared no source, so GA4 read `not-applicable` |
| Wall revenue | The ledger figure and "Connect a daily revenue source." | The pace, month chart and yesterday read only ad-network daily estimates; v3 seeded none |
| Workflows | No workflow at all | The hosted reader shows scheduler lanes and manual runs; the demo had neither |
| Needs you, feed | Usually empty; a few lines a day | The one seeded alert recovered on the first simulated day; collection ran once a day |
| Desk charts | Weekly traffic between 1,100 and 1,800 as a flat band | `HeroChart` drew every positive line from zero |

## Changes

**Charts.** `HeroChart` fits a labelled floor below a line whose lowest value is
at least half its highest ([doc 21](../21-surface-design.md)). Bars and steps
stay zero-based. This applies to every installation.

**A fourth fictional site.** Weeknight Pantry (`weeknightpantry.example`, `wp`)
is an ad-supported recipe site: about 5,000–7,000 sessions a day, busiest at
weekends, peaking in late November, with `recipe_saves` as its tracked action.
A 2026-10-08 web search found no site of that exact name. As in the original
brief, that is not trademark clearance. Its synthetic ad-network estimates are
sessions × an invented revenue per 1,000 sessions (higher before the holidays,
lower in January). That income follows traffic, unlike the software sites'
recorded subscription and licensing income, which still never does. Each month
is paid on the sixth of the second month after it, as a reconciled `ads` entry
that replaces that month's estimates. This reverses the original brief's "no
Mediavine site, run or daily ad record" for this one site only. The product's
only daily revenue source is the ad network, and its pace, month chart and
yesterday need one. It has its own task project, so the hub has five.

**Live sources.** Setup declares GA4 and Search Console live for every site, and
the ad network for Weeknight Pantry. Nothing else is claimed.

**The hosted scheduler runs the demo's lanes.** The demo composes the ordinary
hosted scheduler with three lanes under the release's job identities:

- `counters` (every 15 minutes) writes today's provisional counts through the
  ordinary signal writer. Each count is the finished day's count × the share of
  the day already counted. A report the scenario keeps missing is recorded as a
  failure, never a partial value.
- `mediavine` (at 10, 30 and 50 minutes past the hour) writes yesterday's
  estimate once the network's morning report is due, as the real collector
  does. Earlier passes are skipped.
- `beads-snapshot` refreshes the task board from the real task service every
  five minutes.

Their executions are the Workflows page's history. If the simulator stops, the
ordinary freshness rules show it.

**Incidents.** Light Brief's exports and Weeknight Pantry's recipe saves dip on
recurring cycles (4 days every 19, and 4 every 13). Pinwell keeps its original
cycle. The ordinary alert rules find each dip and close it on recovery. The
young site still has none.

**Countdown.** It now targets a review 75 days after the cutoff, so it counts
down for most of a demo's life.

## Not changed

The software sites' anchors, both stories, the missing report, the young site,
the read-only boundary and the synthetic labels are unchanged. Meetings stay off
the demo Wall: the calendar read remains disabled for demo visitors.

## Deployment

The generator refuses a stored scenario of another version, so a v3 demo cannot
run this release's image. Use a fresh setup with a new Compose project and
volumes ([deploy/demo/README.md](../../deploy/demo/README.md)). Nothing of a
synthetic demo is worth migrating.
