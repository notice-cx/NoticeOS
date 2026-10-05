# Alert triage without paragraphs (bead `ro-ujb9.96.6.7`)

*2026-09-23.* The `/alerts` page, the asset Alerts tab, alert rows, their
evidence and the rule-tuning panel carried 62 strings over the Tower's text
budget (1,351 words), including two About panels whose job was to define the
words on the rows. The operator's rule for this surface: an alert leads with
plain "what happened + what to do", and its statistics go to the evidence
popover. This brief records how best-in-class alerting products present the
same four things, and which pattern the Tower adopted for each.

## Prior art

| Product | Source | What it does | Adopted here |
|---|---|---|---|
| Sentry — Issues | https://docs.sentry.io/product/issues/ · https://docs.sentry.io/product/issues/states-triage/ · https://docs.sentry.io/product/issues/issue-details/ | The list row is a level mark, the title, the project and first/last seen; status is a small closed set (New, Ongoing, Escalating, Regressed, Archived, Resolved). Event counts, affected users and the distribution graph live on the issue detail, not on the row. | The closed row stays mark · asset · headline · recurrence chip · age. The rule's numbers left the opened row for one Evidence panel. |
| PagerDuty — Incidents | https://support.pagerduty.com/main/docs/navigate-the-incidents-page · https://support.pagerduty.com/main/docs/edit-incidents | Rows carry title, service, urgency and status; state is colour-coded counts, not sentences. Acknowledge / Resolve / Snooze are one-click buttons; snooze offers presets (1h, 4h, 8h, 24h, Other) and the incident re-triggers when it ends. | Mark read / Snooze / Resolve stay single buttons inside the opened row with label-length hovers; snooze keeps its presets plus a date, each preset's hover is the date it lands on. |
| Linear — Triage | https://linear.app/docs/triage · https://linear.app/changelog/2023-01-31-issue-reminders | Accept / Decline / Snooze are single keystrokes; snooze is a preset picker ("tomorrow", "next week", a date) reused everywhere, with no explanatory copy. | No tooltip paragraphs on the verbs; the parked row shows a glyph + date chip ("quiet until Sep 25 · in 3d") with the exact instant on hover. |
| Datadog — Monitors | https://docs.datadoghq.com/monitors/status/status_page/ · https://docs.datadoghq.com/monitors/configuration/ · https://docs.datadoghq.com/monitors/manage/ | Status is a fixed enum (Alert, Warn, No Data, OK) where No Data is its own state, not the absence of OK. Tuning draws the threshold as a marker on the preview graph, and the evaluation graph shows how the monitor would have behaved historically. | Verification is a glyph + label (solid tick Confirmed, dashed ring Last known) whose reason is a code, not a sentence; the tune panel's 40% proposal line is a tick on the bar, the replay strip is the explanation of a threshold, and "no day could be judged" is a headline state rather than a zero. |
| Grafana — Alert state history | https://grafana.com/docs/grafana/latest/alerting/monitor-status/view-alert-state-history/ | Each transition row shows the prior state, the new state and the value that crossed the line, as data. | Evidence rows are label · value ("Arrived · 22 in 24h", "Chance if nothing changed · 0.2% · fires below 1%"), never a sentence restating its label. |
| incident.io — Alerts | https://docs.incident.io/on-call/escalation-statuses | The API tracks eight escalation states; the dashboard deliberately collapses them to fewer for humans. | The read model keeps 17 verification reason codes; the row shows five glyph states and the panel one short label per code. |

## What changed, per surface

- **Rows (`/alerts`, asset Alerts tab, history):** the opened row is one line
  of chips (Evidence, correlated change, notified, tuned) and the verbs. The
  caption states the verification once; its checks (first seen, last
  confirmed and by what, why) are rows in the Evidence panel with the rule's
  numbers and the rule id.
- **Evidence panel:** no explainer line under the heading; label/value rows.
- **Strip:** declared history gaps are states ("Condition history not
  recorded", "Nothing open"), not methodology.
- **About panels:** removed from both surfaces; each fact they defined is now
  on the element it described.
- **Tune panel:** scope is an "Applies to every asset" chip, the replay heading
  names its asset and metric, field hints say which way is quieter, the
  proposal line is a tick, and the methodology caveat is gone.
