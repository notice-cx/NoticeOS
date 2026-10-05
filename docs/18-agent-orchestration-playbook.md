# 18 — Agent orchestration playbook (portfolio-wide)

How to launch a feature, refactor, or whole vertical on ANY property in
the portfolio using a lead session directing parallel Opus agents.
Distilled 2026-07-11 from one property's session that shipped a new
locale (22 pages + 1,072 translated recipe pages), a trust/accuracy
package, two product features, a nav redesign, and a four-phase
architecture refactor — ~40 independently-gated commits, zero lost
edits, zero force-pushes. The property-specific binding for that property
lives in its repo's docs/agent-orchestration.md; new properties should
add their own bindings section when they first use this.

## The shape

```
owner (directs, pushes, decides product)
  └─ session lead (one main conversation)
      ├─ workstream orchestrator agents (one per long track)
      │    └─ implementation forks (one-shot, isolated worktrees)
      ├─ specialist agents (feature / investigation, end-to-end)
      └─ recon agents (read-only, before anything edits)
```

**The lead is the only entity that lands code.** Agents build and verify;
the lead independently re-verifies and commits. The owner is the only
entity that pushes (push = deploy across the portfolio's CI convention).

## Ten rules

1. **Recon before briefs.** A read-only recon agent maps every
   integration point first; briefs cite its file:line findings, not
   memory. Budget it generously — every wrong guess it prevents costs a
   fork iteration later. (Recon key-name GUESSES still get re-verified by
   implementers against the actual source — two blocks shipped wrong
   guessed names that only component-level verification caught.)
2. **Explicit file ownership in every brief** — owns-list AND
   hands-off-list. Contested files get a negotiated split or strict
   sequencing. Ownership follows causation: who widens a type fills its
   consumers; who owns a file owns its live defects.
3. **Isolated worktrees + patch handback** for anything touching
   contested files. Fork edits, gates, and byte-diffs in its own
   `git worktree`; the lead lands via `git apply -3`. BASE CHECK FIRST:
   harness-created worktrees can branch from origin/<default> instead of
   local HEAD — with unpushed commits the fork builds on a stale base and
   its patch silently reverts main (one property, 2026-08-09: 3 of 4 batch
   agents spawned 20 commits stale). Lead verifies each worktree's HEAD
   right after spawn; every brief has the fork assert the expected base
   sha and `git reset --hard <sha>` before its first edit. Worktrees double as
   crash insurance — a dead fork's finished work is salvageable (a
   4-hour-stalled fork's block landed without re-running anything).
   Setup: symlink EVERY runtime env file the dev server needs, not just
   node_modules (one property: node_modules + .dev.vars + .env.local — the
   missing .env.local killed the Vite server at boot and silently failed
   every Playwright smoke in the worktree, 2026-07-11). Patch hygiene:
   `git rm --cached` the symlinks and any assets the lead already landed
   before exporting the diff — `git apply` aborts new-file hunks on the
   first conflict while modified-file hunks land, leaving a partial tree
   that looks applied.
4. **The race guard**: on any reassignment, the file's existing state
   wins. An agent finding a peer's finished work leaves it and reports.
   Deterministic under crossed messages.
5. **Schema-confirm pauses.** Orchestrators send the design (types,
   scope, expected-diff semantics) and WAIT before structural edits.
   Pause-and-ask thresholds: more than a handful of judgment-shaped
   findings → the enumerated list goes to the lead, who rules on
   evidence (git provenance, live-experiment exposure) and states the
   rationale so later evidence can overturn cleanly.
6. **Honest scope-outs are a feature.** A fork may decline a risky
   one-shot and return the turnkey classification/spec instead
   ("classification-first"). Every time this happened, the follow-up
   fork one-shotted it. Never let an agent push through a half-migration
   to look productive.
7. **Verification is layered and independent.**
   - The lead re-runs the property's full gate on every landing (it
     catches what agents' green runs miss — twice in one day).
   - Refactors carry a byte-diff invariant: EMPTY hash-normalized output
     diff, or an enumerated intended-change set where changed == intended
     EXACTLY.
   - Deletions require a deep-equal scaffold proving the replacement
     reproduces the legacy first (a scaffold caught 18 forgotten entries
     the plan had missed).
   - Gate and commit are never chained with `;`.
   - Executed gates outrank IDE diagnostics; behavioral checks outrank
     literal greps.
8. **Foreground builds inside forks** (background-wait orphans them) and
   a 30-minute silence nudge at every level of the tree.
9. **Every landed commit stays push-ready.** Known flakes get a named
   task + a re-run policy instead of ad-hoc debugging. Broken
   intermediates are fixed FORWARD, never amended.
10. **Protect live experiments.** Anything under active measurement
    (title surgeries, pricing probes, ranking watch lists) is immutable
    for its window, regardless of refactor aesthetics. The lead keeps
    the watch list and enforces it in rulings.

## Launch checklist (new feature/project on any property)

1. Lead writes the task board (phases, dependencies, owners).
2. Recon agent → integration-point map with file:line refs.
3. Briefs per agent: mission, owns/hands-off lists, honesty rails,
   gates to run, report format ("verbatim gate output"), no-commit rule.
4. Parallelize only file-disjoint tracks; sequence the rest.
5. Land → lead re-verifies → commit (agent credited in the message) →
   next directive in the same message as the landing confirmation.
6. Milestone commits, never a mega-commit; the property's owner can
   push at ANY point.
7. Close-out: memory/doc updates, obsolete rules deleted, follow-up
   tasks filed for everything deferred — as **beads** in the owning repo
   (`bd create`), never as a list inside a doc or a report
   ([AGENTS.md §Open work lives in beads](../AGENTS.md#open-work-lives-in-beads)).

## Property bindings

Each property defines: its gate command, its smoke suites (+ which need
sandbox off), its deploy trigger (usually push-to-main), forbidden
resources (e.g. the owner's dev-server port), and its commit-trailer
convention. Each keeps it in its own repo's docs/agent-orchestration.md.
Properties without a full gate yet should build one BEFORE their first
orchestrated project — the whole model rests on cheap, trustworthy,
independently-runnable verification.
