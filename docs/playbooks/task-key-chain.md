---
id: task-key-chain
version: 2
origin: "the OS's own Tower query/finding handoffs + config/beads.json task hub (2026-08)"
status: active
---

# The task key chain

One key, carried unchanged from the finding that raised it to the verdict that
retires it. Without it a shipped change and the observation that provoked it
are two unrelated events in two different stores, and *"did that work?"* is
answerable only by someone who remembers.

## Use when

- A Tower finding or query decision is handed off to an agent to act on.
- Any work is filed that a later reading will need to price, grade, or retire.
- Someone asks whether a finding is done — and the honest answer depends on
  which link of the chain has actually closed.

## Preconditions

- The finding carries a **stable key**. A Tower query decision's key is the
  normalized query (`decisions.key` for kind `query`); a finding's key is its
  card key (`ExecutiveInsight.key`, `decisions.key` for kind `finding`). A
  surface that regenerates its keys each snapshot cannot use this method — fix
  the key first.
- The receiving repo is a **spoke on the task hub** with its own bead prefix
  ([`config/beads.json`](../../config/beads.json)). A repo that is not a spoke
  files nowhere.
- The rule or lane that produced the finding has an id worth joining on
  (`query-cannibalization`, `recover`, `search-opportunity`).

## Method

1. **The Tower writes the key into the handoff.** The copied Markdown carries a
   *File this task* section: a ready-to-run `bd create` whose labels are
   `noticeos-handoff`, `asset:<asset id>`, `rule:<rule id>`, `key:<slug>`, and
   whose `--metadata` carries `noticeos_key` / `noticeos_rule` / `noticeos_asset` /
   `noticeos_kind` verbatim.
2. **The agent files the bead in the property's own repo.** The prefix comes
   from the repo `bd` runs in — never from the handoff — so filing from the
   wrong directory files against the wrong property. `bd` prints the id
   (`mp-1w2`); that id is the chain's ref from here on.
3. **Every commit for the work names the bead id.** One string in the message
   is enough; it is what turns a diff into an answer to a question.
4. **The agent closes the bead with the decision and its evidence.** For
   completed implementation, name the commit. For declined or no-longer-needed
   work, record that decision and its basis. Closure alone does not prove a
   change was shipped or that the finding was resolved.
5. **An actual ship writes an annotation** on the property's timeline
   (`annotations.kind = 'deploy'`) whose `ref` is the **same bead id**, so
   Attribute ([doc 03](../03-attribution.md)) can see a cause on the timeline
   rather than an unexplained step.
6. **The outcome watch window is opened against the same ref**
   ([doc 05](../05-execution-and-accountability.md) *Ship safety*), sized to the
   change class — through first recrawl for anything search-facing.
7. **The verdict retires the finding, or does not.** A graded window writes back
   against the ref; only then does the originating finding stop being live.

## Decision rules

- If a handoff is executed but no bead is filed, the work is **untracked** —
  treat it as not done, whatever the diff says.
- If a bead's labels do not carry the rule id and the key, it is a task, not a
  link in this chain; nothing downstream can join it back.
- If the exact key contains a comma, read it from **metadata**, never from the
  `key:` label — `bd` splits label values on commas, so the label carries a
  slug and only `noticeos_key` is byte-exact.
- If a bead is closed, a **task decision was recorded**. Read that decision;
  it may be a decline. Do not infer shipment, mark the finding resolved, count
  an outcome, or retire the rule from task status alone.
- If a watch window's verdict is written against the ref, *then* the finding is
  retired — positively (kept) or negatively (reverted). A negative verdict is a
  closed loop too.
- If a bead id appears in a commit but on no annotation, Attribute is blind to
  it — the ship happened, the timeline does not know, and any later reading of
  that period is guessing.
- If the same rule id keeps producing beads that close with no measurable
  verdict, the **rule** is the thing to grade, not the work.

## Proof and abandonment

The chain works when, for a shipped-work bead id picked at random, a reader can recover:
the finding that raised it, the commit that shipped it, the annotation on the
timeline, and either a verdict or an honestly open window. Any link that cannot
be recovered is where the method is failing, and the fix belongs at that link.
For a declined task, the evidence is its recorded decision; do not fabricate a
commit, deployment annotation, or outcome window for work that never shipped.

Abandon a link rather than fake it. An annotation written for a ship that never
happened, or a verdict inferred from a chart rather than a window, is worse than
the missing link — it converts an unknown into a false known, which is exactly
what [doc 03](../03-attribution.md) exists to prevent.

## Calibration

- **Property-specific:** the bead prefix (for example `shop`, `blog`, `os`)
  and the repo directory, both in the saved task projects
  ([`config/beads.json`](../../config/beads.json) describes the shape).
- **Class-specific:** the watch-window length. Fast metrics 24–72h; SEO-facing
  changes run through first recrawl (doc 05).
- **Portfolio-fixed:** the `noticeos-handoff` source label and the
  `noticeos_*` metadata field names. Renaming either breaks every existing join —
  which is why the 2026-09-23 rename from `reindex-handoff` / `reindex_*` kept
  reading the old names beside the new ones
  (`packages/contract/src/task-metadata.mts`): beads filed before it still join.

## Origin evidence

*2026-08-01 — links 1–4 are built and exercised; links 5–7 are not.*

- The Tower's two handoff surfaces emit the *File this task* section
  (`apps/tower/src/lib/task-handoff.ts`), verified end to end against `bd`
  1.1.2: a query containing `"`, backticks, `$(…)`, and a comma files one bead
  with four intact labels and a byte-exact `noticeos_key`, and
  `bd list --metadata-field 'noticeos_key=<exact>'` finds it.
- Steps 3–4 are **agent discipline, not automation.** Nothing in this repo
  writes a bead id into a commit message or closes a bead, and the handoff says
  so rather than implying a hook exists.
- *2026-08-03 — step 2 now reads back.* The finding that raised a bead shows it:
  the `os:up` poller runs one `bd list -l noticeos-handoff --status
  open,…,closed` per spoke, keeps `noticeos_key` / `noticeos_kind` /
  `noticeos_asset` off each bead's metadata, and files them in the same
  `beads_snapshots` row the /work board reads, so the property page can render
  a bead id and open/closed state on the finding card the handoff came from
  (`ro-248`). It is a filtered read, not a slice of the snapshot's queue lists:
  those are capped heads and the bead for a finding is routinely older than any
  of them reach. Two things it deliberately does not do — it never writes to
  the register (the analyzer auto-filing findings is `ro-0fz`, deferred), and a
  closed bead rendered as *shipped, not proven* at that time. That overclaim is
  corrected by the 2026-09-06 applicability review below.
- *2026-08-03 — the query row reads the same way* (`ro-5e8.3`). Its marker was
  the operator's `handed_off` decision, written the moment they COPIED the
  Markdown: a copy nobody ever ran marked the query as dealt with, and a bead
  filed by hand left it looking untouched. Both surfaces now render the same
  `HandoffBeadBadge` off the same `noticeos_key` join, the copy records nothing,
  and `decisions` shrinks to display state (`marked` / `dismissed`) — the
  `handed_off` value is no longer written or read. The store caught up on
  2026-08-04 (`ro-5e8.4`): `db/migrations/0021_decisions_retire_handed_off.sql`
  deleted the legacy rows and narrowed the CHECK, so the read filter is now belt
  to the constraint's braces rather than the only thing holding the line. A row
  carries ONE filing marker or none: the self-report and the bead are two answers
  to one question, and only the bead is about work.
- Steps 5–7 were **built but unjoined** *(corrected 2026-08-01: an earlier
  draft said the watch-window store did not exist — it does)*. `annotations.ref`
  (`db/migrations/0001_phase0.sql`) accepted a bead id, and the watch-window
  store, registration route, and daily verdict evaluator all landed 2026-07-31
  (`db/migrations/0012_watch_windows.sql`, `POST /api/watch-windows`, the 03:30
  sweep closing through flags). What did not exist was any code that WROTE a
  bead id into those refs, so both joins were an operator remembering to paste
  one.
- *2026-08-04 — steps 5 and 6 are joined* (`ro-4ko`). The Timeline composer asks
  **which task** and writes the chosen bead id into `annotations.ref`; the
  outcome-check composer takes its `ref` from the bead a query row or finding
  card was filed as, so a check opened from filed work is keyed to that work
  without anybody typing an id. The chooser is the property's own
  `beads_snapshots` read — the same slice the finding cards render — and its
  first, default option is **Not from a task**: most changes are not filed work,
  and a required field here would be answered with whatever sat at the top of
  the list. A change with no task sends `ref: null` rather than an empty string,
  because `ref` is part of the store's identity `(asset, at, kind, ref)`. The
  timeline then RENDERS the link: an event whose ref resolves to a bead in the
  snapshot draws the same `HandoffBeadBadge` the finding card carries, and an
  unresolved ref (a commit sha, a bead older than the snapshot) stays the plain
  mono string it always was.
- **Step 7 is still not automated, and closure still proves nothing.** Nothing
  auto-reverts. The verdict comes from the window's own final check, so anything
  claiming a measured outcome from a closed bead alone is still claiming
  something this system cannot produce.
- *2026-09-06 — task closure is no longer labelled shipment* (`ro-ujb9.30`).
  `HandoffBeadBadge` describes a recorded closure with an unverified outcome.
  Recommendation review matches exact task keys and dated changes, but neither
  a closed task nor a newer source report proves that saved advice is currently
  valid. Missing links and incomplete task snapshots remain unknown.

## Related

- [freeze-register](freeze-register.md) — the window this chain's step 6 opens
  is exactly what a freeze protects.
- [release-cohort-attribution](release-cohort-attribution.md) — how a change is
  shipped so its window can be read at all.
- [serp-opportunity-execution](serp-opportunity-execution.md) — the execution
  path a query-decision handoff most often enters.
- [kill-thresholds](kill-thresholds.md) — what a verdict is measured against
  when the answer is "stop".
