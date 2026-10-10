---
title: "Glossary"
description: "The words you meet on NoticeOS screens and in these docs, each in a sentence or two."
---

# Glossary

This page defines the words NoticeOS uses on screen and in these docs, so no page has to stop and explain them.

**Alert**
: NoticeOS saying a number on a site is unlikely to be normal, with the evidence attached. Every alert has a severity and a kind. See [Alerts](/concepts/alerts).

**Anomaly**
: An alert kind: a number went somewhere it should not have. Most alerts are anomalies.

**Archived site**
: A site taken out of collection and off the desk, with its history and domain kept. A site is never deleted; restoring it returns it to where it left off.

**Automation enabled / Monitor only**
: The Automation setting on a site's Settings tab. Monitor only marks the site as observed only, with no automation on it.

**Baseline**
: The days before a change that an outcome check compares against, or the recent average an alert rule tests today's count against.

**Change**
: An event you log on a site's Activity tab: a deploy, a config change, an incident, a model change, an autonomy change, or something external like a search engine update. Changes are what outcome checks attach to.

**Cohort**
: A group of comparable pages treated as one unit so a change to the group can be compared with a group like it. NoticeOS does not assign cohorts today.

**Connect (an agent)**
: The page where you allow an AI agent to read tasks and site reports and to work tasks in your workspaces. Your own role still limits it.

**Data source**
: Something NoticeOS collects about a site: Google Analytics, Search Console, Bing, an ad network, or the site's own nightly report. Listed on a site's Data sources tab.

**Decline confirmed**
: An outcome check verdict: the decline threshold was met. It raises a warning alert.

**Error / Warning / Info**
: The three alert severities. Error means broken or missing; warning means an unlikely move; info means worth knowing, nothing to do.

**Evidence**
: The numbers behind a figure or an alert, one click away. Also what closes a task: a commit, a test run, a URL, never prose alone.

**Gate**
: A hold on a task that keeps it out of the ready list until you resolve it. Approval is a gate you open.

**Holdout**
: A slice of a site you leave unchanged on purpose, to compare against. Which pages are held out is never changed by automation.

**Home**
: The first page: what needs you today, across every site.

**Improvement confirmed**
: An outcome check verdict: the improvement threshold was met. It raises an opportunity alert.

**Integration**
: A connected provider account, managed on the Integrations page. Credentials are entered there, not in files.

**Kind**
: The second label on an alert: anomaly, opportunity or milestone.

**Ledger**
: The record of money: revenue and cost rows per site per month. A row never changes; a correction is a new row that replaces it. Shown on the Money page.

**Measurement window**
: The baseline days plus the check days of an outcome check. The surfaces it measures should stay still while it is open.

**Milestone**
: An alert kind for a line crossed. Always info severity, never urgent.

**Money**
: The page that shows the ledger month by month, with Net P&L. Also a site's own Money tab.

**Month to date**
: The current month on the Money page, still counting.

**Net P&L**
: Revenue minus cost for a site or the portfolio in a month. It is a monthly result, not a return on investment.

**Nightly report**
: What a site sends NoticeOS once a day about what its own servers could count. A site never queries outside analytics about itself.

**No clear change**
: An outcome check verdict: neither threshold was met, or none was set. The numbers are shown.

**Opportunity**
: An alert kind for good news that may deserve action.

**Outcome check**
: A comparison you register before the numbers exist: a change, a metric, a scope, a baseline, check days and thresholds. NoticeOS reads it on the check days and closes it with a verdict. See [Attribution and measurement](/concepts/attribution-and-measurement).

**Owner**
: The person or agent a task is assigned to. An agent claims a task before starting it.

**Project**
: One site's task list, with its own short prefix on every task id. Added under Settings > Task projects.

**Could not be measured**
: An outcome check verdict: the data could not answer. It never means the change did nothing.

**Resolve**
: Marking an alert as fixed. The alert is settled.

**Scheduled job**
: Something NoticeOS runs on a timer: collecting reports, running outcome checks, filing review tasks. Shown on the Workflows page and under System health.

**Scope**
: What an outcome check measures: the whole site, one search query, or one page.

**Settled**
: An alert nothing will bring back: resolved, or marked read. A snoozed alert is not settled.

**Severity**
: The first label on an alert: error, warning or info.

**Site**
: One website in your portfolio. The word on screen is always Site; "property" is reserved for a provider's own object, such as a Google Analytics property.

**Snooze**
: Parking an alert until a date within 90 days. The same alert comes back on that date.

**Still counting**
: A day a data source has not finished reporting. Drawn hollow on charts and never tested for alerts.

**Task**
: A piece of work on the shared board, for a site or for NoticeOS itself, with status, owner, priority, blockers and the evidence that closed it. Closing a task records a decision, never a business result.

**Threshold**
: The percent change, in a stated direction, that an outcome check must clear to confirm an improvement or a decline.

**Tune**
: Changing one of the three alert settings from an alert, with a replay of what would have fired. A tuned alert stays open.

**Unmeasured**
: Shipped, with no value claimed, because the effect could not be told apart from noise. The normal state of most small changes.

**Verdict**
: The result an outcome check closes with: improvement confirmed, decline confirmed, no clear change, or could not be measured.

**Waiting on you**
: The section at the top of the Tasks page: tasks and gates that need a decision from you and nobody else.

**Wall**
: The TV view: statuses and trends for every site on one screen, meant to be glanced at across a room.

**Workflow**
: A named automation with a purpose, a schedule and a run history, shown on the Workflows page. Its runs record what happened; they are not business results.

**Workspace**
: The boundary that owns a portfolio's sites, evidence, connections and work. You may belong to several without sharing data between them.

## Related

- [How NoticeOS thinks](/concepts/how-noticeos-thinks)
- [Alerts](/concepts/alerts)
- [Attribution and measurement](/concepts/attribution-and-measurement)
- [Tasks and agents](/concepts/tasks-and-agents)
