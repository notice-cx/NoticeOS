---
id: freeze-register
version: 3
origin: "one site's docs/agent-orchestration.md (2026); readback routing required after that site's 2026-08-05 panel triage"
status: active
---

# Freeze register

A surface inside a measurement window is **immutable** — to refactors, to
cleanups, to aesthetics, and to anyone who thinks they can improve it. The
register is the list of what is frozen, until when, and why.

## Use when

- Any change has shipped whose effect is being measured on a clock (a snippet
  surgery, a layout test, a pricing change, a title fix).
- Any refactor, migration, or cleanup pass is about to touch a broad set of
  surfaces.
- Any agent or contributor is briefed on work that overlaps a measured area.

## Preconditions

- A register that is readable *before* work starts — a list nobody consults is
  not a freeze.
- Each entry states the surface, the change under measurement, the window's
  start, its end date, and the **readback bead** that owns the result.

## Method

1. **Register at ship time, not at review time.** The change that starts a
   measurement window adds its own freeze entry in the same commit.
2. **State the window end as a date**, derived from the recheck schedule (the
   last recheck, typically D28).
3. **Name the readback bead.** Every entry carries the bead that will receive
   evidence during the window and own the scheduled reading at its end. The id
   must resolve when the freeze is registered; "review later" is not a route.
3b. **Declare the measurement in a form the OS can act on.** The entry's prose
   states the window; a machine-readable sidecar states the same thing as data —
   the readback bead, the ship day, the baseline, the check offsets, and one row
   per series being watched. A check in the spoke's own gate fails when an entry
   is active with nothing declared, so "shipped a measured change without saying
   how it will be read" is a build failure rather than a discovery six weeks
   later. Reference implementation: one site's
   `scripts/freeze-windows.json` + `scripts/freeze-sync.mjs` (`check:freeze-
   windows` in `verify`), which registers each declared series as a watch window
   in ingest and receives the verdict as a comment on the readback bead.
3c. **Say which half a person reads.** A window measured on rank, AI-Overview
   citations or Bing-AI share has no retained daily series, and a change to a URL
   that did not exist before its ship has no baseline to compare a percentage
   against. Those are declared as hand-read, by name. An entry that declares
   neither an automatic bet nor a hand read has not said how it will be read.
4. **Enumerate the frozen surfaces exactly** — file paths, routes, or copy keys.
   "The homepage area" is not a freeze; a named list is.
5. **Put the freeze in every brief** for overlapping work, alongside file
   ownership. An agent that was never told cannot comply.
6. **On collision, the freeze wins.** A refactor that cannot proceed without
   touching a frozen surface either waits, scopes around it, or brings an
   enumerated exception request to the owner. It does not decide for itself.
7. **Expire on the date.** A freeze with no end is a permanent no-go zone that
   the next contributor will simply break; expiry is what makes it credible.
8. **Record the reading before releasing.** The window closes with the recheck
   result written down — that is the point of having frozen it.

## Decision rules

- If a surface is inside its measurement window, it is immutable — **whatever
  the refactor's aesthetics say**.
- If a change would alter what a search engine or user sees on a frozen
  surface, it is a freeze violation even when the diff looks purely structural.
  Rendered output is the test, not intent.
- If a structural change must span frozen surfaces, prove it produces **no
  rendered change** — an empty normalized output diff — or enumerate every
  intended difference and have them reviewed one by one before landing. "The
  changed set must equal the intended set exactly" catches both regressions and
  silent omissions.
- If an exception is granted, the measurement window **restarts**; it does not
  continue. A window with an untracked change in it has already produced an
  unreadable result.
- If two contributors need a frozen file, sequence them. Do not negotiate a
  split inside a measurement window.
- If new search or performance evidence arrives for a frozen surface, annotate
  the entry's readback bead. Do not turn that evidence into competing copy work
  while the window is active.
- A freeze entry without a readback bead is incomplete, not permission to work.
  Repair the entry and route the evidence before forming a new verdict.
- If a freeze has expired but its recheck was never read, the finding is lost —
  count that as a failed experiment, not a free release.
- **Bet property-wide on sums, bet scoped on averages.** Clicks, impressions and
  sessions add up, so a property total answers the same question a page total
  does one level up. Average position and CTR are taken over whatever the
  property appeared for, so a change that wins by matching MORE searches drags
  them the wrong way — the new rows are the ones it ranks worst for. A window on
  an average is registered against the page or the query it is actually about,
  never against the property. Machine-enforced in ingest since ro-715c, which
  was opened by two deploys on one site that closed `kill_confirmed` on
  site-wide average position while both won 40–50% on clicks.
- If the entry's success criterion is an absolute floor ("~0 clicks/day → 15+/
  day") rather than a percentage, it cannot be a pre-registered predicate today:
  register the series without thresholds so the movement is reported, and read
  the floor by hand. A threshold invented to fit the shape of the tool is worse
  than no threshold at all.

## Proof and abandonment

Proof is negative: measurement windows that close with readable results, and
zero cases of "we cannot tell what happened because something else changed."
Track violations. A rising violation count means the register is not reaching
briefs — fix distribution, not the rule.

## Calibration

Window length follows whatever recheck schedule the change class uses (D7/D14/D28
for search-facing copy at the origin). Freeze scope should be the smallest set
that keeps the measurement clean — an over-broad freeze gets ignored, which is
worse than a narrow one that gets honored.

## Origin evidence (2026-07, one site)

Codified from a single day in which one session shipped a new locale (22 pages
plus 1,072 translated recipes), a trust package, two product features, a
navigation redesign and a four-phase architecture refactor — roughly 40 gated
commits through parallel agents — **with zero lost edits**. The rule is stated
flatly under the judgment protocol: *protect live experiments — anything on the
search watch list (recent title surgeries) is immutable during its measurement
window, whatever the refactor's aesthetics say.*

The neighboring mechanics that make it enforceable came from the same day, each
bought with a near-miss: explicit file ownership in every brief naming both what
an agent owns and what it must not touch; a deterministic race guard (when work
is reassigned, the file's existing state wins, and the agent that finds a peer's
finished block leaves it alone and reports); and byte-diff invariants for
refactors. The snippet standard carries the same rule from the copy side —
"watch-list titles frozen mid-measurement" sits in its list of rails.

## Related

- [impression-harvest](impression-harvest.md) — creates most freeze entries.
- [serp-snippet-standard](serp-snippet-standard.md) — carries the same rail.
- [release-cohort-attribution](release-cohort-attribution.md) — the freeze is
  what keeps a cohort clean.
