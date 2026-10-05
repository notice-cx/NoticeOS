# Inbox decisions on the row, and a task filed from a finding (2026-09-23, bead `ro-ujb9.96.7.11`)

What the operator does to answer the inbox and to turn a finding into a task,
and which products the design copies. The flow counts are measured by
`apps/tower/e2e/ux-flows.mjs` (the flow gate) and
`docs/artifacts/ux-audit-2026-09-23/walk.mjs` (the audit's walker); the targets
come from the flow audit
(report; private historical evidence, finding 10).

No mockup in `docs/artifacts/ux-audit-2026-09-23/mockup/` covers these two
flows (the mockups are the integration-setup screens), so the design follows
the prior art below and the audit's written target.

## The design

- **Waiting on you** (Tasks, and an asset's Tasks tab): each row carries its
  decision on the row itself. A gate shows **Approve**. An ask shows
  **Answer** and **Dismiss**. Answer opens a box under the row with the
  cursor in it; Enter sends, Shift+Enter is a new line, Esc closes it.
- **One press, then Undo.** The row leaves the list at once and a toast names
  the task with **Undo** for five seconds (⌘Z / Ctrl+Z also works). The task
  lane is called when the window closes. Approve, Answer and Dismiss all close
  the bead and none has an inverse the lane can run, so the answer is held
  rather than reversed. A page that closes inside the window sends what is
  waiting at once.
- **No second listing.** A task in Waiting on you is not listed again in All
  tasks on the same screen.
- **File task on a finding's row.** On the asset Overview's What matters and
  in All findings, File task sits on the row. It opens the composer filled
  from the finding's own fields: its title; what it measured (the primary
  figure and evidence rows, as labelled on the row); its window, sources and
  confidence; and a link to the asset page. The operator can edit any of it,
  then presses File task. Once filed, the row shows the task's badge instead.
- **New task on Tasks** opens the composer in place. The page no longer
  changes under it, and `?new=1` still opens it from a link.

## Prior art

Researched 2026-09-23 from each vendor's own documentation. Where a doc did
not say something, it is not claimed here.

- **Linear, Triage.** "Open the issue to review it and take one of the
  following issue actions: accept with `1`, mark as duplicate with `2`,
  decline with `3`, or snooze with `H`." Accept and Decline take an optional
  comment.
  - **Source:** https://linear.app/docs/triage
  - **Adopted:** one verb per decision, each one press. The optional note
    became optional altogether: the answer text is the note.
- **Linear, Inbox.** Actions work from the list without opening the item:
  "Select a notification and then use `U` to mark as read or unread", `H`
  snoozes, and `Backspace` deletes the selected notification.
  - **Source:** https://linear.app/docs/inbox
  - **Adopted:** the verbs sit on the list row. The row expands for evidence
    only.
- **GitHub, notifications inbox.** Triage from the inbox: "To save a
  notification, to the right of the notification, click" the bookmark.
  Done, Read, Unread and Unsubscribe work the same way from the list.
  - **Source:** https://docs.github.com/en/subscriptions-and-notifications/how-tos/viewing-and-triaging-notifications/managing-notifications-from-your-inbox
  - **Adopted:** the action sits at the right of the row. On a phone it moves
    to its own line under the title.
- **Gmail, Undo Send.** "Right after you send a message, you can retract it"
  with the Undo button, within a cancellation period of 5, 10, 20 or 30
  seconds.
  - **Source:** https://support.google.com/mail/answer/2819488
  - **Adopted:** a five-second window in which nothing is written. Undo inside
    it is exact because nothing has happened yet.
- **Nielsen Norman Group, confirmation dialogs.** "Do try your best to offer
  undo … in order to reduce anxiety and allow users to recover", and
  over-used confirmations stop being read.
  - **Source:** https://www.nngroup.com/articles/confirmation-dialog/
  - **Adopted:** Dismiss, a permanent decline, gets Undo rather than an "Are
    you sure?" step.
- **PagerDuty → Jira Cloud.** "The Incident Title will auto-populate the
  issue's title", and afterwards "the Jira issue link will display on the
  incident details page … as an external reference".
  - **Source:** https://support.pagerduty.com/main/docs/jira-cloud-user-guide
  - **Adopted:** File task opens prefilled from the finding. After filing,
    the finding's row shows the task's badge where File task was.
- **Sentry → Jira.** On an issue, "you'll find the Linked Issues section on
  the right hand panel. Here, you'll be able to create or link Jira issues."
  - **Source:** https://docs.sentry.io/organization/integrations/issue-tracking/jira/
  - **Adopted:** creating the task lives beside the thing it is about, never
    on a separate page.

## Measured

Rows in `docs/artifacts/ux-audit-2026-09-23/results.json` (`measuredFor:
ro-ujb9.96.7.11`) and budgets in `apps/tower/ux-flows.json`. Actions are
clicks + fields; the phone adds one click to open the menu.

| Flow | Before (desk / phone) | After (desk / phone) | Target |
|---|---|---|---|
| Answer the inbox: approve a gate, answer an ask | 9 / 10 actions, 2 screens, 1 page change | 5 / 6 actions (4 clicks + 1 field on a desk), 2 screens, 1 page change, 0 words, 0 empty steps | 4 clicks + 1 field |
| File a task from a finding | could not be walked: no finding in the fixture | 2 / 2 clicks, 1 screen, 0 page changes, 0 words | 2 clicks, 1 screen, 0 page changes |
| File a task from Tasks | 6 / 7 actions, 3 screens, 1 empty step | 4 / 5 actions, 2 screens, 0 empty steps | 0 empty steps |
