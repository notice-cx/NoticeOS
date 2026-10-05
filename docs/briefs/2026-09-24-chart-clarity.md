# Chart clarity: one key per mark, and the key is the toggle — bead `ro-ujb9.12`

## The problem

Measured on the journey fixture at `86e7fe50` (captures:
`docs/artifacts/chart-clarity-2026-09-24/before/`; historical reference excluded from public source):

- **Financials' first screen drew Net, Revenue and Cost as three grey
  sparklines.** The KPI strip's lines took the delta's tone, and on an open
  month there is no delta, so all three fell to muted grey — three
  near-identical lines above a chart that draws the same three series in
  cyan, violet and ink.
- **The legend was two rows that did not match the plot.** A static "7-day
  average" key was drawn 3 px wide in grey, while the average on the chart was
  2 px in the series' own colour; the faint daily line under it had no key at
  all. With two series the names moved into filled pills in the brand accent —
  blue labels beside a cyan and a violet line — which read as filters, not as a
  key.
- **The comparison line out-shouted the lead.** The Overview's "Same day last
  week" was a 2 px dotted line in `muted-foreground` (7.8:1 on the dark card)
  beside a 2 px lead in `foreground`: the same weight, near the same ink, and
  its weekly zig-zag was the loudest shape on the chart.
- **"Provisional" floated at the far end of the title row**, a dotted-underlined
  word with nothing tying it to the hollow point it explains. On a phone it
  took a row of its own under three 44 px pills.
- **Points were ellipses on a phone.** The plot stretches its x axis to its
  box; a `<circle>` drawn in it is a third as wide as it is tall at 390 px.

## Prior art

Stripe was named in the bead; its public documentation does not describe its
charts' visual encoding ([Dashboard basics](https://docs.stripe.com/dashboard/basics),
[Billing analytics](https://docs.stripe.com/billing/subscriptions/analytics)
describe metrics, not marks), so it is not cited as evidence here. Its balance
naming pattern is already recorded in [financials.md](financials.md#prior-art).

| Product | Source | What it does | Adopted |
|---|---|---|---|
| Plausible — main graph | <https://github.com/plausible/analytics/blob/master/assets/js/dashboard/stats/graph/main-graph.tsx> · <https://plausible.io/docs/compare-stats> | The selected period is a 2 px line in the product's indigo (`stroke-indigo-500`); the comparison period is a quiet low-contrast line in the same family (`rgb(45,46,76)` on dark); the unfinished bucket is dashed (`stroke-dasharray: 3,3`); only the main series gets the area wash. "The main chart shows both date ranges as separate lines so you can see trends side by side." | A **reference** series (`HeroSeries.reference`) is thinner (1.5 px), dotted and in quiet ink (`--spark`), never averaged and never washed, so the lead reads first. The quiet ink still clears 3:1 (Plausible's does not; ours must, below). |
| Grafana — legend | <https://grafana.com/docs/grafana/latest/panels-visualizations/configure-legend/> | "In the legend, click the label of the series you want to isolate." The legend is the series control; there is no second set of toggles. | The legend entry IS the toggle: each series is one keyed `aria-pressed` button, no separate pill row. A hidden series keeps its place, dimmed and struck through (a colourless cue beside `aria-pressed`). The last visible series cannot be hidden. |
| Datawrapper — line charts | <https://www.datawrapper.de/blog/line-charts> | "Use colors, line width and line dashes to make your most important values stick out. Grey is a great color to separate what's important in your chart from what's not important." | Three line weights, one table (`WEIGHT` in `HeroChart.tsx`): lead 2.5 px, reference 1.5 px, daily values under an average 1 px at half strength. Keys are drawn from the same table, so a key is never bolder or fainter than its line. |
| Linear — Insights | <https://linear.app/docs/insights> | "Segments are optional and use color to slice the data further"; "Hover over each bar to see data"; "Select full bars or segments to temporarily filter your view." Colour is identity, the selection is on the data itself. | Series ink is identity, never a verdict: Financials' KPI sparklines wear the same revenue cyan, cost violet and net ink as the lines under Month by month, and the delta chip beside each carries the verdict. |

## What was built

- **One key per drawn mark, in one row** (`HeroChart`). Each series is keyed by
  its lead line exactly as drawn — tone, pattern, weight. A trailing average
  gets two keys: the bold line is the average and the faint one is each day,
  both in the averaged series' ink. When one series is averaged its own entry
  names it ("Bing · 7-day average"), so the same glyph never appears twice. The
  hollow end point is keyed "○ Provisional", and that key is
  where the provisional explanation opens (hover, focus or tap).
- **The key is the toggle.** With more than one series each entry is a quiet
  `aria-pressed` button in ink, not an accent-filled pill; off is dimmed and
  struck through. The 44 px touch floor still holds on a phone.
- **A reference is quiet by construction.** `reference: true` replaces the old
  series-level `average: false`; the Overview's "Same day last week" passes it
  and nothing else.
- **Points stay round.** Isolated points, the provisional cap and the inspected
  point are `ChartDot` marks (a round-capped zero-length stroke), so they stay
  circles at any stretch.
- **Financials' strip wears series identity.** One `SERIES` definition in
  `FinancialsRoute.tsx` feeds both the KPI sparklines and the monthly chart.

## Contrast, both themes (WCAG 2.2, against `--card`)

Measured from `public/brand/notice.css` and `src/index.css` by
`apps/tower/test/chart-series-contrast.test.ts`, which fails if any series
tone drops under 3:1 (1.4.11) or a key's words under 4.5:1 (1.4.3).

| Ink | Dark card `#151a26` | Light card `#ffffff` |
|---|---|---|
| `foreground` (net, Google, GA4; key words) | 15.71 | 17.10 |
| `financial-revenue` | 10.50 | 5.14 |
| `financial-cost` | 7.90 | 6.45 |
| `search-bing` | 7.09 | 5.12 |
| `traffic` | 5.52 | 4.90 |
| `spark` (a reference line) | 5.18 | 4.84 |
| `muted-foreground` (method keys, axis labels) | 7.80 | 6.20 |
| daily values under an average, `foreground` at 50% | 4.81 | 3.31 |
| daily values under an average, `search-bing` at 50% | 2.74 | 2.14 |

The daily line under an average is texture, not the quantity: the average line
carries the series (every tone above 4.8:1) and each day's value is in the
readout and the View data table. Revenue, cost and net stay apart (OKLab ΔE
×100, normal / colour-blind): dark 18.9 / 10.4, 17.3 / 10.5, 23.4 / 23.5; light
19.5 / 11.8, 31.2 / 29.9, 31.1 / 29.1 — above the validator's 15 and 6, with
solid, dashed and dotted as the colourless second cue.
