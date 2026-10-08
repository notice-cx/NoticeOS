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
hosted scheduler with four lanes under the release's job identities:

- `counters` (every 15 minutes) writes today's provisional counts through the
  ordinary signal writer. Each count is the finished day's count × the share of
  the day already counted. A report the scenario keeps missing is recorded as a
  failure, never a partial value.
- `mediavine` (at 10, 30 and 50 minutes past the hour) writes yesterday's
  estimate once the network's morning report is due, as the real collector
  does. Earlier passes are skipped.
- `beads-snapshot` refreshes the task board from the real task service every
  five minutes.
- `watch-windows` (daily at 03:30) runs the release's outcome check over the
  demo's own watch windows.

The first three are background operations, so their history is on System
health. The outcome check is the Workflows page's. As first deployed, the demo
ran only the first three, so Workflows had no rows. A hosted workspace whose
deployment registers no workflow now says so, rather than that filters hide
them. If the simulator stops, the ordinary freshness rules show it.

**Banner.** It reports the demo service's latest write: the last completed
simulated day, or a scheduled lane's later pass that wrote data. A freshly set
up demo therefore shows a time within 15 minutes, not "Generation time
unknown" until its first simulated day completes. "Scenario through" appears
once one has.

**Incidents.** Light Brief's exports and Weeknight Pantry's recipe saves dip on
recurring cycles (4 days every 19, and 4 every 13). Pinwell keeps its original
cycle. The ordinary alert rules find each dip and close it on recovery. The
young site still has none.

**Countdown.** It now targets a review 75 days after the cutoff, so it counts
down for most of a demo's life.

**Meetings.** The hosted demo server answers the Wall's meetings read, as it
answers the live traffic read, from `scripts/demo-calendar.mts`. That is one
"Work" feed with Mara's fixed weekly schedule in UTC. It runs from a European
morning to an American afternoon, so a visitor in either sees what is next. It
includes a Monday portfolio review, a weekday check-in, meetings about each
site, and one meeting on each weekend day. The
countdown's review appears on its day. It uses the ordinary read's 48-hour
window and cap, and is display data only: nothing is fetched or written. A
hosted demo visitor's browser now asks for it. The local demo viewer still
refuses this provider read, so its browser does not ask.

## Not changed

The software sites' anchors, both stories, the missing report, the young site,
the read-only boundary and the synthetic labels are unchanged.

## Deployment

The generator refuses a stored scenario of another version, so a v3 demo cannot
run this release's image. Use a fresh setup with a new Compose project and
volumes ([deploy/demo/README.md](../../deploy/demo/README.md)). Nothing of a
synthetic demo is worth migrating.
