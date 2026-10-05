# Home, the Wall and the chart components without explanatory text (2026-09-23)

*Public summary updated 2026-10-01: installation-specific identifiers are omitted or explicitly illustrative. The dated original is retained privately; measurements and vendor research are unchanged.*

Beads `ro-ujb9.96.6.12` (41 texts over the UX gate's budget), `ro-ujb9.96.6.15`
(KPI cells repeating what they show), `ro-yo4h` (a site card clipping its
totals label) and `ro-n5ya` (the Monthly net card clipping its comparison).
The flows: read a big number from across the room, read a chart without a
methodology paragraph, see that a live reading is out of date, and save a TV
layout. This brief records how comparable products do it and the pattern this
work adopts. The research was done on 2026-09-23 from the vendors' own docs.

## Prior art

- **Grafana — Stat panel.**
  - **Layout:** "the stat visualization automatically adjusts the layout
    depending on available width and height". With value and name, the two sit
    side by side "if space permits; otherwise, value renders underneath". The
    sparkline "is automatically hidden if the panel becomes too small". A
    missing value is a hyphen by default.
  - **Source:** https://grafana.com/docs/grafana/latest/panels-visualizations/visualizations/stat/
- **Grafana — panel status.** A panel keeps drawing its data. One icon in the
  panel header shows the highest-severity notice; hovering it lists the
  details.
  - **Source:** https://grafana.com/developers/plugin-tools/how-to-guides/panel-plugins/error-handling-for-panel-plugins
- **Grafana — saving a dashboard.** Save takes an "(Optional) … description of
  the changes". The version list shows it in a Notes column, and each version
  can be compared as a text diff.
  - **Sources:** https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/create-dashboard/ ·
    https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/manage-version-history/
- **Geckoboard — number widget.** One principal number with an optional label,
  and a secondary comparison drawn as "a red down arrow or green up arrow" with
  the value or percentage beside it. The comparison is its own compact line.
  - **Source:** https://support.geckoboard.com/en/articles/6055767-guide-to-the-number-visualization
- **Datadog — Query Value widget and TV mode.** The change indicator states
  its comparison period ("Previous Period", "Previous Day/Week/Month") inside
  the widget. The value is relative, absolute or both, and colour says whether
  the move is good. A timeseries can sit behind the number. TV mode fits every
  widget without scrolling and warns that shrinking type "can make some fonts
  smaller and difficult to read from a distance".
  - **Sources:** https://docs.datadoghq.com/dashboards/widgets/query_value/ ·
    https://docs.datadoghq.com/dashboards/guide/tv_mode/
- **Plausible — incomplete periods.** The main graph draws the current,
  unfinished day, week or month as a dotted segment. No sentence explains it.
  - **Source:** https://plausible.io/docs/guided-tour
- **GitHub Primer — blankslate.** A first-run or empty state has one primary
  line, optional secondary text that is "brief and non-redundant", and one
  primary action.
  - **Source:** https://primer.style/product/components/blankslate/guidelines/

## Adopted

- **Big-number cards never clip.** The Wall's Monthly net comparison gets its
  own line under the number, as Grafana does when the value and name do not fit
  side by side and as Geckoboard draws its secondary line: arrow, amount, and
  both months named. A test measures every Wall card for text cut off at the
  side, so `wall:fit`-style checks can no longer miss it.
- **A stale live reading is a state on the numbers, not a sentence beside
  them.** Following Grafana's panel status, the numbers stay visible but dimmed,
  and one warn glyph beside ACTIVE USERS names the state. Its words live in the
  glyph's hover and accessible name. The totals column keeps its width.
- **Charts key themselves.** The legend names the bold line (7-day average)
  and the faint line (reported values). A hollow endpoint marks the unfinished
  period, as Plausible's dotted segment does, and the hover readout gives each
  date's values and coverage. The methodology paragraphs are deleted, not moved.
- **A KPI cell is its label, value, delta and spark.** Nothing else appears
  under the number (Datadog's query value). A missing history stays
  machine-readable and in the cell's tooltip.
- **Save is one press, with an optional note.** This follows Grafana. With no
  note, the version is described by what changed, such as "Resized Alerts ·
  added Clock", so the history reads without anyone writing it.
- **First run is a blankslate.** One line says what the product is, then three
  numbered destinations with the first as the primary button. Each step is its
  title; the notes under them are deleted.
