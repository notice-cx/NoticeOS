# The TV Wall, rethought (2026-09-23, bead `ro-i4gc`)

*Public summary updated 2026-10-01: installation-specific identifiers are omitted or explicitly illustrative. The dated original is retained privately; measurements and vendor research are unchanged.*

**Decided:** D28 in [`config/decisions.md`](../../config/decisions.md) —
business first, with a live feed. **Contract:** [doc 25](../25-the-wall.md).
**Reference render (synthetic fixture, Tower tokens):**
`wall-d28.html` (private historical evidence) and
`d28-*.png`; the explorations and today's Wall on the same fixture are listed in
the folder README (private historical evidence). The
operator's own canvas used live data and is not in the repository.

## Audit: today's Wall, element by element

Measured on the synthetic fixture at 1920 × 1080
(`today-measurements.json`; private historical evidence,
`today-six-1920.png`; private historical evidence).
"Elsewhere" names the desk page that already shows the fact.

| Element | Question it answers | Changes | Elsewhere | Cost | D28 |
|---|---|---|---|---|---|
| Brand, Home link | Where am I, how do I leave | never | every page | header row 24 px | keep, in the strip |
| Tasks legend | What do the ribbon glyphs mean | never | `/tasks` | header row | cut (ribbons go) |
| "Integrations: N need attention" | Is a feed broken | rarely | `/integrations`, `/health`, 8 icons per card | header row | merge: strip state + issue mark |
| "View refreshed" | Is the TV frozen | 60 s | — | header row | keep, quiet |
| Needs attention rail | Is anything on fire | on fire/resolve | Home, `/alerts` | 1065 × 197 px for **one** visible line; 5 of 6 hidden by rotation | replace: Needs you, top 3, static |
| Inbox chip "1 urgent · 4 need you" | How much waits on me | hourly | Home, `/tasks` | in the rail | keep as Needs you's count |
| Monthly net | How is the month going | daily | Home, `/financials` | ≈349 × 197 px, 7 % of the width | promote: revenue + pace + month chart, largest type |
| System card | Is the OS healthy | nightly | Home, `/health`, asset #0 | 470 × 197 px | cut to one strip state |
| Clock, Up next, Countdown | What time is it, what's next | seconds | Settings (countdown) | 154 px row, 14 % of the height | merge into a 60 px strip |
| Per card: 8 source icons | Are this site's feeds working | rarely | Integrations, Health, site header | 233 × 24 px × 6 cards | cut; issue mark only when broken |
| Per card: "Nightly Nh ago" | Did last night's report land | daily | site header, Home | shares the header's second line | only when late |
| Per card: yesterday's ad revenue | What did it earn | daily | Financials | 24–28 px | merge into the month money |
| Per card: all-time totals | How big is the product | slowly | site Overview | ≈76 px (one site) | cut (activity stock, doc 00) |
| Per card: live 30 min / 5 min | Is anyone on it now | 30 s | — | 84 px | keep 30 min only |
| Per card: today by hour + pace | Is today normal | hourly | Home table (number + pace) | 120 px | keep as a row sparkline + % |
| Per card: 30-day bars + 7d vs prior | Is it growing | daily | Home table spark, site Overview | 126–196 px | bars to the site page; line + weekly % stay |
| Per card: projected ad revenue | Is this site's month on track | daily | — | inside the bars block | keep as "$so far → $pace" |
| Per card: task ribbon, flag line, automation chip | Backlog, alerts, may the OS act | rarely | `/tasks`, `/alerts`, Settings | 54 px footer | cut; alerts reach Needs you |

Three views of active users took 330 of a 503 px card (66 %). A seventh full
site stacks column 5 to 1,012 px, **333 px past the bottom of the TV**
(`today-seven-1920.png`; private historical evidence).
D28 fits seven at full row height with 54 px to spare and eight at 68 px
(`d28-seven-1920.png`; private historical evidence,
`d28-eight-1920.png`; private historical evidence).

## Prior art

Researched 2026-09-23 from the vendors' own pages.

**Glanceable and TV dashboards**

- **Geckoboard — TV dashboards.** "Lower information density, larger fonts and
  use high-contrast colors"; non-interactive; in the teardown, "people are
  better at comparing lengths than angles". *Adopted:* five regions, big type,
  no gauges. https://www.geckoboard.com/best-practice/tv-dashboards/ ·
  https://www.geckoboard.com/blog/data-visualization-for-tv-dashboards-a-teardown/
- **Grafana — Stat panel.** A value with a sparkline behind it; thresholds
  colour a value only when it crosses a limit; the sparkline "is automatically
  hidden if the panel becomes too small". *Adopted:* issue marks only past a
  threshold; row-sized sparklines.
  https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/visualizations/stat/
- **Datadog — TV mode.** Every widget visible "without requiring scrolling";
  design to the TV's aspect ratio. *Adopted:* one fixed 1920 × 1080 budget.
  https://docs.datadoghq.com/dashboards/guide/tv_mode/
- **Plausible — Realtime.** Current visitors are those of the last 5 minutes;
  the view "updated every 30 seconds". *Adopted:* one live number, a 30 s feed
  poll. https://plausible.io/docs/realtime-dashboard
- **Stephen Few — bullet graph; Edward Tufte — sparklines.** A measure against a
  comparative marker; a sparkline tied to "the number recorded at far right".
  *Adopted:* the month chart's last-month line; every sparkline has its number.
  https://en.wikipedia.org/wiki/Bullet_graph ·
  https://www.edwardtufte.com/notebook/sparkline-theory-and-practice-edward-tufte/
- **Atlassian Statuspage.** The top-level status is derived from components:
  "All Systems Operational" only when every component is. *Adopted:* the strip's
  one system state is the worst component.
  https://support.atlassian.com/statuspage/docs/top-level-status-and-incident-impact-calculations/

**Live activity feeds**

| Product | New items | Grouping | Volume | Adopted |
|---|---|---|---|---|
| [Vercel Activity Log](https://vercel.com/docs/activity-log) | chronological list; each entry is who, event type and time, "hover over the time to reveal the exact timestamp" | none; filter by type, date, project | a closed catalog of event types, one sentence each | the closed vocabulary; one sentence per event; clock times (no hover on a TV) |
| [Linear issue activity](https://linear.app/changelog/2025-04-03-collapsed-issue-history) | newest in context | "group similar consecutive events and collapse older activity" | — | fold consecutive same-kind events within 15 minutes |
| [Stripe Workbench events](https://docs.stripe.com/workbench/overview) | does **not** refresh itself: "Click Refresh events to fetch the latest events" | none; each event links to its object | filters by type and resource | the opposite on a TV (it polls); name the object (site) on every line |
| [GitHub organization dashboard](https://docs.github.com/en/organizations/collaborating-with-groups-in-organizations/about-your-organization-dashboard) | a feed of what members did (branches, pushes, reviews) | the page does not document grouping | — | events are things someone or something *did*, named by the verb |
| [Datadog Live Tail](https://docs.datadoghq.com/logs/explorer/live_tail/) / [Events Explorer](https://docs.datadoghq.com/events/explorer/) | streams in near real time | Explorer "no longer groups events by the aggregation_key" | Live Tail output "is sampled when too many logs … are flowing in" | never sample a feed that carries failures; fold bursts deterministically instead |

None of these pages specifies arrival animation or highlight timing; doc 25's
240 ms slide and two-minute fading tint are this project's own, with reduced
motion honoured.

## Feed data inventory

This is the audit's 2026-09-23 inventory of the former D1 schema, not the current
Postgres table inventory. Its numbered `db/migrations/` sources are retired
and retained in private history. Current tables are defined by the
[Postgres baseline](../../db/postgres/migrations/0001_baseline.sql) and its
append-only migrations; the [consumer inventory](../../db/postgres/consumers.md)
locates their current readers and writers.

At that audit date every proposed feed event already had a row somewhere;
only two needed a new read, and **none needed a migration**.

| Event | Source | Time column | Needs |
|---|---|---|---|
| Task done | `beads_snapshots.payload` (0017): each project's `recentlyClosed[]`, about five per project, poller every minute, 7-day retention | `recentlyClosed[].closedAt` | nothing new |
| New task | same payload; `WorkItem` has no `createdAt` ([`shared/work.ts`](../../apps/tower/shared/work.ts)) | — | **new read:** the poller sends `createdAt` and a short `recentlyCreated` list; the ingest validator ([`beads-snapshots.ts`](../../workers/ingest/src/beads-snapshots.ts)) accepts them. JSON text, no migration |
| Alert fired / resolved | `flags` (0001) | `fired_at`; `resolved_at`, `disposition_at` | nothing new; headline from `translateAlert` |
| Source failed / back | `integration_health_events` (0035) | `recorded_at`, `kind` failed · changed · recovered | nothing new |
| Collected | `signal_runs` (0006), `signal_dump_runs` (0037, incl. PostHog, Clarity, DataForSEO), `mediavine_runs` (0034), `hygiene_checks` (0026) | `finished_at`, `finished_at`, `attempted_at`, `observed_at` | nothing new; fold per provider per run |
| Scheduled job failed | `job_runs` (0022) | `finished_at`, `outcome` | nothing new; failures and skips only |
| Revenue reported | `mediavine_current_daily` view over `mediavine_daily` (0034) | `recorded_at`, `report_date`, `amount_minor` | nothing new |
| Revenue or cost booked | `ledger` (0020) | `recorded_at`, `kind`, `booking_state` | nothing new |
| Cost | `signal_dump_runs.provider_cost_usd` (0011); `research_log.cost_usd` (0025) | `finished_at`; `bought_at` | nothing new |
| Insights refreshed | `property_insight_snapshots` (0008) | `generated_at` | nothing new; "new finding" is a diff of an asset's last two snapshots, computed at read time |
| Nightly report | `pulses` (0001) | `received_at` | nothing new; fold per night |
| Site deploy or change | `annotations` (0001) | `at`, `kind` | nothing new |
| OS deploy | `.local/logs/deploys.jsonl`, written by `record()` in [`scripts/os-deploy.mjs`](../../scripts/os-deploy.mjs) | `at` | **new read:** a host file the Tower's Worker cannot see; the runner forwards each new line as an asset-#0 annotation, or a local lane reads it |
| Setting saved | `config_changes` (0029) | `changed_at`, `reason`, `actor` | nothing new |
| Bet closed | `watch_windows` (0012) | `closed_at`, `outcome` | nothing new |

Left out on purpose: `counter_readings` (activity totals, doc 00) and
`notifications` (outbound copies of events already listed). The existing
indexes cover every per-source "newest since" read at today's volume
(`idx_flags_asset_fired`, `idx_signal_runs_latest`,
`idx_signal_dump_runs_finished`, `mediavine_runs_asset`,
`idx_job_runs_started_at`, `idx_property_insight_snapshots_latest`); a new
index would be a migration, which stays operator-only.

## Historical audit findings

The build was tracked by epic `ro-trai`. The following records preserve the
audit's findings, not their current status. The task hub holds current work
and completion evidence.

- `ro-trai.1` — the System state is amber by construction: the asset-#0 self-report
  ([`workers/ingest/src/db.ts`](../../workers/ingest/src/db.ts), the `metrics`
  object) never sends `agentsRunning` or `queueDepth`, and `missingSelfSignals`
  (`SystemBand.tsx`; retired source; retained in private history)
  treats their absence as a warning, so "Missing agents · queue" can never
  clear.
- `ro-trai.11` (in its acceptance) —
  [`materiality.ts`](../../apps/tower/shared/materiality.ts) still routes
  `outcome-watches` to a Wall property card (`ActiveWatchLine`), but the Wall
  card has not drawn the active bet since `3997151a` (2026-08-31). D28's cut
  list settles it; the fix rides the bead that removes the old card.
