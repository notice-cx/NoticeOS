# Tasks and workflows without explanatory text (2026-09-23, bead `ro-ujb9.96.6.11`)

The Tasks board, the task page, the task composer, the work panel and the
Workflows pages carried 44 strings over the Tower's text budget (875 words).
Each one was replaced by a state the screen already had, a default, or a
control. This brief records how comparable products show the same things
without prose, and which pattern each screen adopted. The inbox row actions
and filing from a finding are covered by
[`2026-09-23-ux-prior-art.md#inbox-and-file-task`](2026-09-23-ux-prior-art.md#inbox-and-file-task)
and bead `ro-ujb9.96.7.11`.

## Prior art

Researched 2026-09-23 from each vendor's own docs. Where a doc did not say
something, it is not claimed here.

- **Linear, editing issues.** "You can edit an issue title or description by
  clicking directly on the title or description and editing inline."
  - **Source:** https://linear.app/docs/editing-issues
  - **Adopted:** the task page's description and acceptance criteria are
    edited where they are read. An empty one is an **Add a description**
    button, replacing the sentence that quoted the `bd update --description`
    flag.
- **Linear, creating issues.** An issue needs only a title and a status; the
  other properties (team, priority, labels, project, parent) are set on the
  same screen and drafts are kept.
  - **Source:** https://linear.app/docs/creating-issues
  - **Adopted:** the composer opens on title, project and priority, and Enter
    files. The project is filled from the board filter, the asset tab or the
    handoff. Type, parent, labels, description and acceptance criteria wait
    under **More**. No field has a hint line.
- **GitHub Projects, table layout.** Group headers show "a count of items in
  the group or column". Sorting is shown on the view options, not explained.
  - **Source:** https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/customizing-the-table-layout
  - **Adopted:** the board header is a count (`29`, or `12 of 29` when
    filtered). The About that explained the ordering is gone.
- **Trigger.dev, runs.** Every run status has its own icon and colour:
  Completed is a green check, Failed a red X, Executing a blue spinner, Queued
  gray.
  - **Source:** https://trigger.dev/docs/runs
  - **Adopted:** the workflow legend (Succeeded, Failed, Skipped / no runs) is
    the whole key for the hourly bars. The tooltip paragraph explaining the
    bars was removed.
- **Inngest, function runs.** A run's details show a timeline of steps, and
  each step expands to its attempts and errors.
  - **Source:** https://www.inngest.com/docs/platform/monitor/inspecting-function-runs
  - **Adopted:** each stage card states its own evidence ("Not observed" when
    an older run recorded none). This replaced the paragraph above the diagram.
- **Vercel, cron jobs.** "Disabled cron jobs will still be listed", and logs
  open from the list.
  - **Source:** https://vercel.com/docs/cron-jobs/manage-cron-jobs
  - **Adopted:** a paused workflow is simply listed with its Paused state. The
    sentence "Paused workflows stay visible" is gone.
- **GitHub, archived repositories.** An archived repository becomes read-only:
  issues, pull requests, labels and comments can no longer be changed.
  - **Source:** https://docs.github.com/en/repositories/archiving-a-github-repository/archiving-repositories
  - **Adopted:** a deployment with no task database shows one **Read-only
    snapshot** banner plus the one thing to do. Its actions are disabled. The
    server answers with a state code (`read_only_deployment`) instead of a
    paragraph.

## What each screen shows instead of the text

| Screen | Removed | Shown instead |
|---|---|---|
| Tasks board | About (6 paragraphs); three banners that could all be open at once; "N observed · 1 project unavailable" under each of six tiles; label-filter tooltip; empty-state paragraphs | One Read-only snapshot banner. One "N projects could not be read" banner with the names and Retry. A spinner by the age badge while a local read loads. Lower-bound counts (`12+`). No label filter where rows carry no labels. Empty states link to the fix (Add a task project, Check the task board refresh). |
| Task page | Parked footnote, closing footnote, status-chip sentences, empty description/comment/activity hints, read-only paragraphs, not-found paragraph | Add/Edit description and acceptance criteria in place. "Parked until" field. Glyph + word chips. Read-only banner. "Not in the saved snapshot" with a link to that project's board. |
| Composer | Header paragraph, five hint lines, locked-label footnote, linked-metadata sentence | Title, then Enter. Project defaulted. More closed unless a handoff filled it. Lock glyph on locked labels. "Linked to a finding" chip. |
| Work panel | Four hover paragraphs | "Tasks unknown" with the Wall's `?` glyph. "Top or high priority" on the urgent chip. |
| Workflows | Timezone tooltip, activity tooltip, schedule instructions, footer instruction | "Times in <zone>", the legend, "Next 24 hours", "5 of 5 workflows". |
| Schedule editor | Repeated description, timezone paragraph, apply-delay sentence, failure paragraph | "Local time · PDT" on the field, "Next runs: …", and on a refused save "Not saved" with a **Reload saved schedule** button that keeps the edit. |
| Run stages | Older-run paragraph, captured-data disclaimer | "Not observed" on each stage; the Captured data disclosure alone. |
