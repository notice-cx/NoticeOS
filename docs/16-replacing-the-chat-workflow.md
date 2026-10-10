# 16 — Replacing the chat workflow

An operator's working week on a site runs through questions, triage,
commissioned fixes and review. The recurring loop (docs 00–07) does not absorb
that work. This doc records which parts of it the Tower carries today and which
are not built.

**What stays in chat:** design partnership, taste arguments and novel strategy.
The Tower is a cockpit for the recurring work, not a general chatbot.

## What is built

**File task.** Every handoff surface (findings, query decisions, page
decisions and alert rows) carries **File task** beside its Markdown copy. It
opens a composer already holding the title, labels and `noticeos_*` metadata,
and files the task through the Tower's local task lane in the site's own
project. The copied Markdown carries the same task as a `bd create` the
receiving agent runs in that repository
([§Handoff metadata](../config/beads.README.md#handoff-metadata)). Work handed
off this way stays visible on the portfolio's task hub while it is in flight
and closes with a note, instead of living inside one chat session. A task is
intent and status, not a work order: it states that something shipped, never
that it worked.

**New task.** The **Tasks** page has **New task** for a task that starts from
nothing on screen.

**The command palette.** ⌘K (Ctrl-K elsewhere) opens a palette that jumps to
a page, a site or a task id. It navigates; it does not answer questions or run
commands ([doc 10](10-control-tower.md)).

## What is not built

- **L. Ask** (a console that answers portfolio questions from the store, citing its rows): not built.
- **M. Investigations** (a bounded diagnostic run from a flag to a cause report): not built.
- **N. Commissions** (a one-off work order with plan-back, review screen and cost against a change id): not built; File task covers only the brief.
- **O. Idea capture** (a one-sentence intake enriched into a scored card): not built.
- **P. Visual evidence** (before/after screenshots as required claim artifacts): not built.
- **Q. Directed research** (an operator-initiated, cited, dated research brief): not built.
- **R. Propagation** (a positive read on one site drafting cards for its siblings): not built.
