# 16 — Replacing the chat workflow

An operator's working week on a site includes questions, triage,
commissioned fixes and review. The recurring loop (docs 00–07) does not cover
that work. This doc records which parts of it the Tower supports today and which
are not built.

**What stays in chat:** design collaboration, discussions about taste and new
strategy. The Tower is for the recurring work; it is not a general chatbot.

## What is built

**File task.** Every handoff surface (findings, query decisions, page
decisions and alert rows) has a **File task** button beside its Markdown copy.
It opens a composer prefilled with the title, labels and `noticeos_*` metadata,
and files the task in the site's own task project through the `bd` commands the
local Tower runs for the operator. The copied Markdown contains the same task as
a `bd create` command that the receiving agent runs in that repository
([§Handoff metadata](../config/beads.README.md#handoff-metadata)). Work handed
off this way stays visible in the portfolio's task database while it is in
progress and is closed with a note, instead of existing only inside one chat
session. A task records intent and status; it is not a work order. A closed
task records that something shipped, not that it worked.

**New task.** The **Tasks** page has **New task** for a task that starts from
nothing on screen.

**The command palette.** ⌘K (Ctrl-K elsewhere) opens a palette that jumps to
a page, a site or a task id. It only navigates; it does not accept questions or
run commands ([doc 10](10-control-tower.md)).

## What is not built

- **L. Ask** (a console that takes a portfolio question and returns an answer from the store, with the rows it used): not built.
- **M. Investigations** (a bounded diagnostic run from a flag to a cause report): not built.
- **N. Commissions** (a one-off work order with a plan returned for approval, a review screen and cost against a change id): not built; File task covers only the brief.
- **O. Idea capture** (a one-sentence intake enriched into a scored card): not built.
- **P. Visual evidence** (before/after screenshots as required claim artifacts): not built.
- **Q. Directed research** (an operator-initiated, cited, dated research brief): not built.
- **R. Propagation** (a positive result on one site creating draft cards for the portfolio's other sites): not built.
