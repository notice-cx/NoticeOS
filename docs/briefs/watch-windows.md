# Watch windows — a measurement shows its plan, its progress and its verdict

*Bead `ro-ujb9.96.6.6` (epic `ro-ujb9.96.6`), 2026-09-23. The outcome-check
composer on an asset's Activity tab printed its plan as sentences: a 26-word
summary under the form, a 20–34-word calibration paragraph in a tinted box, a
30-word scope paragraph, and refusals of up to 34 words. Doc 21 principle 3a: a
step that needs a paragraph is a step to redesign.*

A watch window is a measurement opened when a change ships: a baseline chosen
before the numbers exist, a threshold, three checks and a verdict. Experiment
platforms show exactly this every day, so the pattern is borrowed from them.

## Prior art

| Product | Source | Pattern adopted here |
|---|---|---|
| GrowthBook — Experiment Decision Framework | <https://docs.growthbook.io/app/experiment-decisions> | Decision criteria are **set before results are seen**, and a running experiment shows one badge — *Ship now*, *Roll back now*, *Ready for review*, or *~X days left*. The composer shows the pre-registered criteria as two labelled figures (**Win ▲ +8%**, **Loss ▼ −8%**) instead of "Up 8% is the win; down 8% is the loss", and a read watch shows its verdict as one chip. |
| Eppo — Progress bar | <https://docs.geteppo.com/experiment-analysis/reading-results/progress-bar/> | Progress is a **bar on the list row and the detail page**, with "ready for review" as a state, and the numbers behind it on hover rather than as prose. A running watch shows a segmented ring (checks read out of checks planned) beside its next check date; the "1 of 3 read" line is gone. |
| Statsig — Reading results | <https://docs.statsig.com/experiments/interpreting-results/read-results> | A metric result is a delta against a **zero line** with its interval, coloured only when it clears significance (green / red / grey). The composer shows the asset's normal noise as a bar against the threshold: the bar fills toward the threshold and turns amber when the threshold sits inside normal noise — the same "does this clear the noise" question, answered by a shape. |
| Linear — Project updates | <https://linear.app/docs/initiative-and-project-updates> | Health is **one indicator** (On track / At risk / Off track) with a target date; detail is behind it. Each calibration state is one chip (*Calibrated*, *Query calibrated*, *Changes not excluded*, *Not calibrated*, *Checking query history*, *Your number*); its evidence is a row of short labelled figures, not a sentence. |

## What the composer does now

- **Plan, not prose.** Under the fields: *Win ▲ +8%* and *Loss ▼ −8%* (the
  arrows flip for average position, where lower is better), and *Checks Sep 29 ·
  Oct 6* then *Verdict Oct 20*. The fields above already carry the series and the
  baseline dates, so the old summary sentence restated them.
- **Calibration as a chip and a noise bar.** The chip names where the threshold
  came from. When there is a floor, a bar shows normal noise against the
  threshold and three short facts: typical move, how many comparisons over which
  dates, and how many were skipped because they crossed a recorded change. An
  operator who types a threshold inside the noise sees the bar turn amber and an
  *Inside normal noise* chip.
- **Scope as a chip, with the fix as a button.** A check opened from a query row
  shows *Only “weekly meal plan”*. Switching to a number that cannot follow one
  query shows *Whole site* and a **Follow “weekly meal plan”** button that
  switches back, instead of a sentence telling the operator to do it.
- **Refusals are prevented, not explained.** Averages (click-through rate,
  average position) are disabled in the number picker unless the check was
  opened from a query; baseline dates cannot be picked after today; verdict
  horizons shorter than the baseline are disabled. The refusal line that remains
  is a guard of at most ten words.
- **Watches list.** A running watch shows a segmented ring (checks read) and its
  next check date. A read watch shows its verdict as one chip with a direction
  glyph (▲ improvement, ▼ decline, = no clear change, ? could not be measured),
  once, instead of a word appended to its title.
