# 25 — The Wall: business first, with a live feed

*Decided 2026-09-23 ([D28](../config/decisions.md)), bead `ro-i4gc`; built under
epic `ro-trai`. Updated by the operator on 2026-09-30 for selectable pulse
totals, compact site health and a clearer header. This is the
contract the Wall is built against. [Doc 14](14-ui-standards.md) keeps the
tokens and the registry rule, [doc 21](21-surface-design.md) the desk (the Wall
is outside it), [doc 10](10-control-tower.md) the Wall's route and editor
mechanics. Where they disagree about what `/wall` shows, this one is the newer
decision. The reference render, drawn in the Tower's tokens from the synthetic
fixture, is
`artifacts/wall-rethink-2026-09-23/wall-d28.html` (private historical evidence)
(captures `d28-*.png` beside it); the audit, prior art and feed data inventory
are [`briefs/2026-09-23-wall-rethink.md`](briefs/2026-09-23-wall-rethink.md).*

## The four questions, in the order the eye takes them

1. **Is anything on fire?** — Needs you and the signal-bars health indicator
   beside each site name.
2. **Are we on track this month?** — the revenue figure, its pace and the month
   chart against last month's total.
3. **Which site needs me, and how is each one doing right now?** — one row per
   site.
4. **What just happened?** — the live feed.

Anything that answers none of these leaves the Wall for the desk page that owns
it (the cut list below). Nothing is deleted; each fact keeps one home.

## Regions

Every region is a widget in the Wall's layout document
([`scripts/wall-layout.mts`](../scripts/wall-layout.mts)). D28's arrangement is
`DEFAULT_WALL_LAYOUT` (bead `ro-trai.11`); the editor at `/wall/edit` can
reorder, resize or remove any of them. The feed runs the full height beside the
revenue band and the site rows, so the layout document gains one level of
nesting: a **column** slot that stacks rows inside a row (depth 1, validated
like any row). There is no header row: the strip is the top of the TV.

These five are the whole library. A layout saved before D28 names widgets this
Wall retired; it is drawn as the default — never refused, never blank — and the
editor says so once, as a warning chip beside Save.

A saved layout the Tower cannot read at all is drawn as the default too, and
the editor names it where "On the TV" would stand — "Saved layout refused", the
validator's sentence on hover — lists the versions saved with it that still
read, and lets Save (the default as drawn, or any arrangement) or Revert
replace it, guarded by the value the store holds (bead `ro-trai.45`). The
layout and the countdown are read apart (`readDashboardConfig` in
`apps/tower/shared/dashboard.ts`): a countdown the Tower cannot read leaves the
saved layout beside it standing, and is named once beside Save, "Saved
countdown refused", its form saving over the stored value.

```
row "strip"  auto  [ strip ]
row "body"   fill  [ column 3.1 ┌ row auto [ revenue 1.55 ][ needs 1 ] ┐ ][ feed 1 ]
                               └ row fill [ sites 1 ]                  ┘
```

| Widget | Shows | Hides when empty |
|---|---|---|
| `strip` | Brand · time and date · the next meeting today (or "No meetings today") · a prominent countdown | never |
| `revenue` | The month's revenue so far (the largest type on the screen, D13), "on pace for $X", the change against last month, yesterday's revenue and the days left ("yesterday $55.25 est. · 9 days left", § Revenue), and the month chart | shows "No revenue source" in one line, only when no site has a revenue source (§ Revenue) |
| `needs` | The top three things that need the operator, errors first then newest, each with site, one line and age; a meta line "3 of N · U urgent tasks" | a calm "Nothing needs you" line |
| `sites` | Each site’s name and compact health bars · live users over their minute pulse · today vs the same weekday last week · four-week trend · selected pulse totals beneath. Type and charts fill the available room (§ Density) | never; with no site yet, one calm line "No sites yet" in the Revenue region's shape, no headings over nothing (bead `ro-ujb9.132`) |
| `feed` | What just happened, newest on top (§ Feed) | "Nothing new since last night" |

### Strip

- Four aligned widgets: brand/version, local time/date, meeting/status,
  and event/countdown. Brand, clock and meeting share main/supporting baselines;
  a quiet divider sits between each adjacent widget. One sans-serif family,
  tabular figures and shared type steps. The TV strip is at least 96 px high,
  or 104 px with the countdown, with 16 px of real padding around its groups.
  Scaled laptop headers can grow to keep supporting
  text at least 11 physical pixels. Portrait tablets place branding, clock
  and countdown together, with a full-width meeting row. Phones pair branding
  with the clock and give the meeting title its own line between the meeting
  times and status. Missing widgets leave no empty agenda block.
- The clock uses the locale's own format with no seconds. AM/PM is smaller
  and muted where the locale has one. The date sits below the time.
- The meeting title shares the clock's size; start time precedes it and
  relative time follows it, both at the title's size and muted on its baseline.
  AM/PM and H/M use the clock's smaller supporting step. Period spacing matches
  the clock; duration suffixes have their own smaller gap from the numerals.
  Up next or Now sits on the supporting row. A clear day reads
  "No meetings today" only follows a readable calendar. A pending first read
  says Loading events. Failed reads retain the last readable events with their
  age and say Retrying automatically. The first two failed attempts stay neutral;
  the third adds a Calendar alert to Needs you, with Integrations as the repair
  destination. Partial reads retain failed feeds' events and become a warning
  after three attempts; an unreadable calendar never reads as clear. Recovery
  clears the failure count and alert. An unconfigured calendar leaves the group out.
  Provider results are reused for five minutes; healthy browser reads poll each
  minute. Failures back off from 30 seconds to five minutes and honor the server's
  retry time. Focus/reconnect cannot bypass that time. The last readable snapshot
  survives same-tab reloads in session storage scoped to the verified browser owner.
- The countdown uses two aligned columns: emoji/event name above a plain
  large number and muted unit. The event name uses the intermediate type step;
  its emoji matches that size and appears only when set. Reaching the target has
  its own state; the last day switches
  to hours, then minutes.
  An unset countdown draws no block.
- Aggregate source and system badges are absent. Concrete OS, scheduled-job
  and data-spend problems join Needs you; asset and source problems remain
  there and in each site's health indicator.
- The brand is the TV's one link, Home (doc 14). Its logotype uses the
  brand type step, filling the main row. The source metadata is distributed
  across the brand group's width, with the monospace hash sharing the caption's
  baseline. DEV identifies mounted development; an asterisk marks local edits
  to that commit (bead `ro-trai.56`).
  The caption contributes its natural width on desktops, preserving the widget
  gap. On phones it can wrap within the brand's width instead of touching the
  clock date (bead `ro-trai.60`).
- If the Wall's own poll fails, keep the last values and show their age:
  "Refreshed 3m ago · reconnecting". Successful polls need no age caption.

### Revenue

- Figure: the month's **revenue** so far (forecast rows lead, as
  `portfolioHeadline` rules today); net and cost live on `/financials`.
  Before the month has a ledger row it is the revenue sources' reported days,
  paced or still learning (bead `ro-trai.33`): a new installation's first three
  weeks show the money coming in, the projection's reason ("Learning from
  traffic and revenue · 12/21 days.") and yesterday under it. With no complete
  day reported yet there is no figure, only the reason and yesterday.
  "No revenue source" is only for a Wall where no site has one
  (`hasRevenueSource`, the site rows' own test).
- Pace: the sum of every site's `revenueProjection` that is `ready`, plus revenue
  no projection covers. "vs last month" compares the pace with last month's
  total and stays **neutral ink** — a projection is not a completed comparison
  (doc 14). It takes the trend colours only when it compares the month so far
  with the same days of last month.
- Yesterday (operator, 2026-09-23, bead `ro-trai.32`; it replaced "$Y a
  day", the month's daily average): each site's saved provider estimate for
  yesterday (`dailyRevenue`), summed over the sites with a revenue source — the
  sites whose row does not read "no revenue source" — by `yesterdayTotal` in
  `lib/wall-revenue.ts`. The figure in the foreground's weight, "yesterday"
  and "est." quiet around it, neutral ink (doc 14: provisional values stay
  neutral). **Missing is not zero:** a site whose report is not in is left out
  and counted ("yesterday $43.18 est. · 1 of 2 sites"); with none in, "yesterday
  not reported yet" and no number; a recorded $0 is "$0.00". It is asked again
  on the Wall's clock, so a held payload never shows the day before as
  yesterday. With no pace yet it stands under the projection's reason.
- Chart: cumulative revenue by day, solid through the last reported day, dashed
  to month end at the pace; last month's total as a dashed flat line labelled
  once; the day the month passed (or is on pace to pass) last month is marked
  and named. Revenue wears `financial-revenue` (series identity), never green.
  Drawn in the charts' one language (doc 14 § Charts, bead `ro-trai.19`): a
  smooth 4 px line over a wash of its colour that fades to a hairline floor
  and feathers out at today, today's point with a halo, the pace dashed in the
  same colour at reduced strength, last month's line a dashed hairline named
  once, top left above it, where the month's own line never is. The
  crossing's words take the first place clear of today's dot and halo, last
  month's label and the month's own lines (bead `ro-trai.35`,
  `crossingLabelPlace`): ending at their dot above the line on the TV; on a
  phone's narrow chart the same place on two lines; then below the line or on
  the dot's other side.

### Needs you

- Sources, all already material state
  ([`shared/materiality.ts`](../apps/tower/shared/materiality.ts)): open
  error/warn alerts (grouped rows stay grouped), failing sources, overdue
  nightly reports, overdue panel reviews, rollback failures, missing OS reports,
  failed or silent scheduled jobs, and data spending over its daily pace.
  These reuse the existing state rules; overlapping OS report issues merge.
  Ordering: errors,
  then warnings, newest first within each. Three rows; the rest is the count.
- Human gates appear as the meta count ("U urgent tasks"), not as rows.
- No rotation, no carousel: every row stays put until it resolves.

### Site rows

| Column | Rule |
|---|---|
| Site | Favicon, name and a small four-bar health indicator: four neutral bars for no open issue, two amber for warnings, one red for errors, empty for no data. Bar count and accessible text carry the state as well as color. Details live on the asset page. |
| Live · 30 min | **The minute pulse** (bead `ro-trai.27`; [D34](../config/decisions.md), the operator's 2026-09-23 amendment of D28 — the 5-minute count returns as the pulse's bright end, the Google Analytics realtime-card pattern, [`briefs/2026-09-23-live-pulse.md`](briefs/2026-09-23-live-pulse.md)). GA4 users in the last 30 minutes, one number in neutral ink that counts to each new reading in under a second (bead `ro-trai.19`; it simply appears under reduced motion); under it a bar a minute for those 30 minutes, oldest on the left, in the `traffic` identity colour — the newest five bright, the 25 before them muted, so momentum reads from the shape — and over the bright end that window's own count, "19 · 5 min", in the same colour. A minute nobody was active is a tick on the floor; a minute the reading did not cover is left empty, never drawn as a zero. The table's heading carries "30 min" once; a phone's stacked row and the one-site tile say "84 · 30 min" beside the figure. A read merely in progress elsewhere is no failure: the last reading stays as drawn (bead `ro-trai.40`). A reading older than 3 minutes, or the last good one kept after a failed read, drops the figure and the pulse to muted ink and puts a clock and the reading's age where the 5-minute count was; with no reading yet, or no GA4 on the site, a dash — never a zero. A roomier row stacks the count on its own line and draws the pulse taller; the one-site Today tile draws it widest. One reading a minute (both GA4 realtime requests together, doc 11 § GA4 realtime read path). |
| Today vs last *weekday* | Today by hour, solid, in the pace's tone over a light wash of it, over the same weekday last week, dashed and neutral; the hour still filling is the now point — a dot with a halo that breathes while the day is counted (still under reduced motion). The arrow and pace % ("↓10%") overlay the chart’s upper-right corner in smaller type, with the completed-hours cutoff ("to 6 AM") small and muted in the cell's bottom-right corner or the one-site tile's heading. The cutoff takes no chart width (bead `ro-trai.51`): completed hours only (`intradayUsersPace`), and **no % until those hours can carry a verdict** (bead `ro-trai.43`, `PACE_VERDICT_MINIMUM` in `lib/intraday-pace.ts`: at least 4 completed hours with processed data and 100 of last week's users in them) — before that the window alone, muted ("to 2 AM"), and no tone. GA4 processes hours 2–6 h behind the clock, so the now point breathes **at the clock** on the operator's zone: on today's line while its newest hour is the clock's, otherwise on the floor with today's line ending in a still dot where the data ends — the gap is the provider's lag. **The pace’s color follows its direction** (operator, 2026-09-30): positive is **green, ahead**; exact equality is **neutral, on pace**; negative through −40% is **amber, behind**; below −40% is **red, behind** — for the line, its wash, the now point and the %, in the rows and the one-site tile alike, and always beside the arrow and percentage, never color alone; the accessible description spells out ahead, behind or on pace. One derivation, `paceTone` in `components/DeltaChip.tsx`, colours every pace the Tower draws; the tokens are `pace-on` / `pace-behind` / `pace-far-behind` (doc 14). While the hours are merely being read elsewhere, the chart and the pace stay as last drawn until a new day or clock (`keepReadingsInProgress` in `hooks/useGa4Realtime.ts`, bead `ro-trai.40`). |
| 4 weeks | Daily active users over the last four finished weeks as one line in the `traffic` identity colour (doc 14; the daily bars move to the site page), over the four weeks before as the charts' comparison line — dashed, neutral, each day above the same weekday — with the first and last day at the chart's two ends, small and muted ("Aug 25 … Sep 21", a span, not a legend). The same two spans' change, "↑ 18% / vs prior 4 wk", sits immediately to the plot’s right in smaller type, aligned with its top edge and leaving recent days clear: the last 28 finished days' total against the 28 before (bead `ro-trai.26`, operator 2026-09-23). The dashed weeks and the % need all 56 days; with fewer, both are left out, never drawn as 0. Neutral when the 56 days span a reporting-timezone change. One derivation, `fourWeeks` in `lib/wall-sites.ts`. Today’s chart keeps no end ticks at row size. |

When current-day hourly observations are unavailable, the traffic cell shows the newest actual finished GA4 daily observation as **Latest day**, with its stored date; collection age appears when stale or unknown. Missing days remain absent; measured zero remains zero. The Live cell retains its own unknown or stale state. Same-tab reloads restore verified-owner readings while an hourly read is in progress, retaining their original observation dates. Refusals replace readings; a previous calendar day's hours or hours on a changed clock never read as Today. Site names wrap within their existing column, leaving favicon and health marks visible.

A second line shows selected asset-owned pulse totals, such as accounts and
leads, with the configured heading. The Wall editor lists each asset’s
available totals as checkboxes beside the existing asset filter. Choices
preview immediately and use the same Save, version history and Revert as the
layout. An absent choice uses configured defaults; an explicit empty list
hides all totals for that asset. Changing the asset filter preserves choices.

The shared counter resolver chooses the latest valid fast or nightly reading.
A measured zero stays zero; missing readings are omitted from the TV and say
"No reading" in the editor. Stale readings keep their number and AgeBadge.
The repeated month-revenue column is removed; the revenue hero owns the
portfolio total.

A site with no report and no data yet is one quiet row: "No data yet". A site that declared it sends no nightly report (D29) is never marked
for it.

The table's columns follow the site region's **own** width, not the Wall's
(bead `ro-trai.18`): ~1,380 px beside the feed on the TV (and on a laptop,
which draws the TV's layout scaled, § Laptop, tablet and phone), and under
64 rem on a portrait tablet or a phone, where each site is a card instead.

## Density

*Bead `ro-trai.13`.* How the site region is drawn depends on one number — how
many sites the Wall shows. Selected totals change how a row shares its room, without changing its tier or type scale. The
strip, revenue, Needs you and the feed are the same in every tier.

Selected totals show each metric's value and name without a group caption.
Individual labels come from the asset's Card totals setup; the Wall editor
selects which metrics appear.

| Sites | Tier | The site region |
|---|---|---|
| 1 | focus | The site’s name, health and selected pulse totals over up to three tiles (below) |
| 2–3 | comfortable | Rows share the full region height, respecting each row’s content minimum. Today’s pace overlays the upper-right corner; the smaller four-week comparison sits to its plot’s right, top-aligned. Charts share row height with selected totals. |
| 4 and more | compact | Today’s full-width chart carries its pace in the upper-right corner; the four-week comparison sits immediately to its plot’s right, top-aligned. Selected totals sit below the name in its cell, with less padding and more name-column width. Rows share available height, bounded by their content and a 56 px floor; rows with pulse totals may take more room. |

The thresholds are two constants beside `siteRowDensity` in
[`SiteRows.tsx`](../apps/tower/src/components/wall/SiteRows.tsx):
`FOCUS_SITES = 1` and `COMFORTABLE_MAX_SITES = 3`. Changing one changes this
table. Both row tiers fill the region. Names, numbers and labels grow with
the available height per asset within readable minimum and maximum sizes;
charts grow in both dimensions. Extra room increases readable content, rather
than only padding. Rows that exceed the region’s capacity scroll beneath the
headings.

**Focus tiles.** Each reads data every site already carries
([`lib/wall-sites.ts`](../apps/tower/src/lib/wall-sites.ts)); their widths
weigh 5 : 4 : 3.4 and the charts take the tile's remaining height.

| Tile | Shows | Read from |
|---|---|---|
| Today vs last *weekday* | Today by hour, solid in the pace's three-step tone (§ Site rows), over last week dashed; live users over their minute pulse ("84 · 30 min", "19 · 5 min"), today's users and the pace % | `/api/ga4/realtime` `hourlyActiveUsers` and `activeUsersByMinute`; today's users are the daily series' point for today, never a sum of hours (doc 14) |
| Visitors and money · *month* | The month's daily active users as `traffic` bars with rounded tops — the latest complete week, the one the weekly % compares, brighter; a day still being counted hatched — and each reported day's money as a `financial-revenue` line cased in black so it reads across the bars; revenue per 1,000 visitors on the newest day with both a report and a finished count; the weekly % | `activeUsers`; the revenue projection's running total, one step per reported day, and yesterday's saved estimate |
| Search clicks | The last four finished weeks over the four before, dashed (as a site row's line, `fourWeeks`), the first and last day, the latest day and the "vs prior 4 wk" % | `searchClicks`, Google and Bing read as one |

A tile whose data the site lacks is left out and the others take its width;
there is never an empty placeholder. With nothing to show in depth — a site
still waiting for its first report — the one site is its own row. The tiles
carry axis words (the first and last day; 12 AM · 12 PM · 11 PM) and no
legend.

## Feed

The feed is the Wall's one moving part: it makes the room feel live without
asking for a click. It is read-only on the TV (doc 14: one link, Home).

- **Vocabulary** (closed; each line is one sentence under the UX gate's 12
  words): task done · new task · alert · resolved · source failed · source back
  · collected · revenue · cost · insights · nightly report · deployed · setting
  saved. The line names the site when there is one. Sources and their timestamp
  columns are the brief's
  [feed data inventory](briefs/2026-09-23-wall-rethink.md#feed-data-inventory).
- **Window:** since 6 PM yesterday in the operator's time zone, newest first,
  at most 50 fetched; the column draws the whole rows that fit and nothing
  half-cut.
- **Arrival:** polled every 30 s. A new row slides in at the top (240 ms; none
  under reduced motion) and keeps a tint of its own tone that fades over two
  minutes. At most one arrival every 2 s; a burst queues.
- **Tasks:** each created or completed task keeps its own title, site and
  timestamp, once per event; adjacent tasks never fold into counts (bead
  `ro-trai.51`).
- **Grouping:** other consecutive foldable same-kind events within 15 minutes
  fold into one line with a count. Collections fold per provider per run
  ("Google · 5 sites, none failed"); revenue folds per report day. Failures never
  fold into successes and are never sampled away.
- **The OS's own deploys are one line** (bead `ro-trai.38`): every successful
  deploy of the OS's own row (`is_os`) since the window opened folds into one
  "Deployed · NoticeOS" line at the newest one's time — "5 times since last
  night", or the one deploy's own words. A failed deploy and a rollback keep
  their own lines; a site's own deploys keep theirs.
- **Aging:** rows older than 12 hours drop to muted ink. Times read as clock
  times ("12:24", "7:40p" for yesterday), never "5m ago" churn.
- **Tone** (tokens only, no new ones): task done, resolved, source back →
  `healthy` (recorded success, doc 14's workflow rule); alert → its severity;
  source failed → `error`; revenue → `financial-revenue`; cost →
  `financial-cost`; everything else neutral. The glyph carries the kind so
  colour is never alone.
- **Failure:** a feed read that fails keeps the last rows, dims the header's
  live dot to neutral and says "Reconnecting"; it never shows an empty feed as
  "nothing happened".

## Laptop, tablet and phone

*Beads `ro-trai.24`, `ro-trai.29`, `ro-trai.31`.* **One rule, by the screen's
shape, not by device** (operator, 2026-09-23: "we should reserve the current
laptop layout to tablets"). A **landscape screen at least 1024 px wide** — the
TV, a desk monitor, a laptop, a landscape tablet — draws the D28 arrangement
above, **scaled to fit**: the whole Wall zoomed by one number, the TV's 1920 ×
1080 box fitted into the screen (`min(width ÷ 1920, height ÷ 1080)`, never
above 1; `wallScreen` in `lib/wall-screen.ts`). A 13-inch MacBook Air's 1470 ×
830 is the TV at 77 %. The small type keeps a floor — 11 px for the axis words
and a list's label and meta, 12 for the headings, 13 for a list's line, 14 for
a site's name (`index.css` § THE TV LAYOUT, SCALED) — and the feed is its
share of the row between 21 and 30 rem, so a wider screen widens the site rows,
never the feed. Every box keeps its TV size in the Wall's own pixels, so the
floored words sit in the rows the budget counts; more site rows than the region
holds scroll inside it under their headings, and the Wall never falls back to
one column for them. Where the floored words need more width than the TV's
columns leave — a 1024-wide landscape tablet (bead `ro-trai.36`) — the site
table's two charts narrow to make it, keeping their shape: the health icon remains visible, "Today vs last Tue" takes two lines, and the four-week
dates are left out once the chart is narrower than they are. Only the scaled
layout does this; the TV itself is never scaled and never changes.

**Anything else — a portrait tablet, a phone — is one column of whole widgets,
full width**: the strip, revenue, the site rows, Needs you, the feed, each
type's `stackOrder` in `scripts/wall-layout.mts`, so any saved layout reads the
same way. The strip wraps (time and date first), each site is a card with both
charts across it and its live figure at the right edge, and the feed lists at
most the rows the TV shows, 12, newest first (`WALL_FEED_TV_ROWS`). The page
scrolls; nothing scrolls sideways.

`pnpm wall:fit -- --strict --viewports laptops` holds the scaled Wall to the TV's
own fit at 1280 × 720 up to 1920 × 1080; the journeys `the Wall on a laptop is
the TV's layout scaled…` (1470 × 830, 1024 × 768) and `the Wall reads on a
phone and a tablet…` (390, 430, 768) hold the two layouts. Captures:
`artifacts/wall-build-2026-09-23/laptop/` (historical reference excluded from public source).

## Type

Every size on the Wall is a token in
[`index.css`](../apps/tower/src/index.css), never a size a component picks.

- **Lists** (bead `ro-trai.23`). A row of Needs you and a row of the feed are
  the same three steps: its label (the site, or the event's kind and site)
  `text-wall-list-label`, its main line `text-wall-list-line`, its meta (the
  age, or the clock time) `text-wall-list-meta`. Neither list is louder than
  the other; Needs you shows urgency by weight and colour, never by size.
  At 1920 they are 14, 18 and 14 px.
- **Strip**: `text-wall-strip-time` for the clock, meeting title and times,
  and countdown value (36 px on TV); `text-wall-strip-label` for supporting
  words, clock periods and duration suffixes (14 px); `text-wall-strip` for
  the countdown's event name (20 px);
  `text-wall-strip-brand` for the logotype (40 px). All share the sans
  family and responsive steps for tablet and phone.
  Beneath the logo, muted small print identifies the served source commit and
  its commit date and time in the viewer's time zone. Images carry this metadata;
  local edits are labelled.
- **Site rows**: region-relative `wall-site-name`, `wall-site-live`,
  `wall-site-stat` and `wall-site-label` tokens grow with available height
  per asset. Bounds keep names and comparisons at 18–32 px, live counts at
  30–56 px and supporting labels at 16–22 px before screen scaling.

## Budget: 1920 × 1080

| Region | Size |
|---|---|
| Page inset | 24 px top and bottom, 32 px sides |
| Strip | 96 px minimum; 104 px with countdown. Includes 16 px vertical padding, then a 20 px gap |
| Body | The height left by the strip; main column beside the feed, 28 px apart |
| Revenue + Needs you | 336 px when filled, then a 20 px gap |
| Site rows | Headings and flexible rows with content floors, including selected pulse totals |

There is no reserved blank area after the last site. The fixture journeys
measure the occupied region, text bounds, chart sizes and whole feed rows
at TV, laptop and phone widths. Extra sites scroll inside their region once
content no longer fits; shrinking essential text is not the fallback.
The inset and gaps are shared tokens, so the editor preview uses the same
geometry as the TV. `wall:fit` measurements are run against the isolated
fixture server, never a live service by default.

## TV rules that do not change

True-black canvas; tabular numerals on every figure; type from the Wall ramp
plus the steps this layout adds as tokens (the revenue figure, 7.5 rem; the
strip's words and time and the countdown emoji — § Type); state never colour-only; material state inside the
fixed scan horizon (`materiality.ts`); last-good values with their age when a
poll fails; nothing on the TV needs a pointer; no chart legends or method
captions — "today solid, last week dashed" is this document's convention, stated
once here, and so is "a halo marks now; a breathing dot is still being
counted".

## What leaves the Wall, and where it lives

All of it left with the D28 default (bead `ro-trai.11`); the check per row,
with where the desk shows it, is
`artifacts/wall-build-2026-09-23/default/README.md` (private historical evidence).
The route's header row went too: its identity and Home link are the strip's,
its Tasks legend is the row below, its "Integrations: …" link is the strip's
specific Needs you rows and the site’s health indicator, and its refresh age is the strip's only when a
poll fails.

| Element | Home |
|---|---|
| Eight source icons per site | `/integrations`, `/health`, the site header and Sources tab; a failing one affects the site’s health indicator |
| Task-count strips and the Tasks legend | `/tasks` and the site's Tasks tab; urgent tasks stay as Needs you's count |
| "Automation enabled" / "Monitor only" | the site's Settings |
| All-time totals and catalog counts | the site’s Overview and, since 2026-09-30, its selected Wall totals |
| The 30-day daily bars and "7d avg line · week-ago ticks" | the site's Overview |
| "Nightly Nh ago" | shown only as "Report late" when overdue |
| The alert carousel and its progress pips | Needs you, static |
| The System card (spend meter, agents, queue, jobs) | `/health` and asset #0; concrete problems appear in Needs you |
| The 5-minute live count | returned 2026-09-23 as the minute pulse's bright end, "19 · 5 min" (D34 amending D28, bead `ro-trai.27`); the separate 5-minute tile stays gone |
| Chart legends and "Today reported through…" captions | gone |
| The large 7-segment clock and the countdown panel | the strip |
