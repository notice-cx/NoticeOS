---
title: "Glossary"
description: "The words you meet on NoticeOS screens and in these docs, each in a sentence or two."
---

# Glossary

This page defines the words used on NoticeOS screens and in these docs, so other pages do not have to define them again.

**Agent**
: An AI coding agent, such as Claude Code, connected to your installation. It reads and works the same tasks you see and reads site reports; approving work stays with you. See [Connect an agent](/guides/connect-an-agent).

**Alert**
: A record that a number on a site is unlikely to be normal, with the evidence attached. Every alert has a severity and a kind. See [Alerts](/concepts/alerts).

**Anomaly**
: An alert kind: a number moved in a way it should not have. Most alerts are anomalies.

**Archived site**
: A site taken out of collection and off the Tower's pages, with its history and domain kept. A site is never deleted; restoring it returns it to the state it had when it was archived.

**Automation enabled / Monitor only**
: The Automation setting on a site's Settings tab. Monitor only marks the site as observed only, with no automation on it.

**Baseline**
: The days before a change that an outcome check compares against, or the recent average an alert rule tests today's count against.

**Bet**
: An outcome check, as the business pages label it: a change and the number it is expected to move, tracked until its verdict is recorded.

**Bootstrap secret**
: One of the few secrets that start an installation, kept in its secrets file rather than entered in the product. Every other credential is connected on Integrations. See [Secrets and credentials](/operate/secrets-and-credentials).

**Change**
: An event you log on a site's Activity tab: a deploy, a config change, an incident, a model change, an autonomy change, or something external like a search engine update. Changes are what outcome checks attach to.

**Checkout**
: A copy of a code repository on your machine, made with `git clone`. You need NoticeOS's own checkout only to install from source or work on NoticeOS; a site's checkout is where people and agents work on that site's code.

**Cohort**
: A group of comparable pages treated as one unit so a change to the group can be compared with a group like it. NoticeOS does not assign cohorts today.

**Connect (an agent)**
: The page where you allow an AI agent to read tasks and site reports and to work tasks in your workspaces. Your own role still limits it.

**Could not be measured**
: An outcome check verdict: the data was not enough to reach a result. It never means the change did nothing.

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
: The first page: what needs your attention today, across every site.

**Improvement confirmed**
: An outcome check verdict: the improvement threshold was met. It raises an opportunity alert.

**Installation**
: One running copy of NoticeOS, on your machine or server, with its own data and settings. Setup makes a new one; nothing is shared between two installations.

**Installation folder**
: The folder setup makes for an installation, `~/noticeos` by default. It holds the installation's settings, its secrets and its launcher.

**Integration**
: A connected provider account, managed on the Integrations page. Credentials are entered there, not in files.

**Kind**
: The second label on an alert: anomaly, opportunity or milestone.

**Launcher**
: The `noticeos` command in the installation folder, such as `~/noticeos/noticeos status`. It runs status, logs, apply, update and the rest without a checkout; from a checkout the same commands are `pnpm os:status` and so on.

**Ledger**
: The record of money: revenue and cost rows per site per month. A row never changes; a correction is a new row that replaces it. Shown on the Money page.

**Lifecycle stage**
: A site's stage: Pre-launch, Onboarding, Baselining or Live, or Retired once archived. Set on the site's Settings tab; no alerts are raised for a pre-launch site and no money is spent on it.

**MCP**
: The Model Context Protocol, an open standard that lets an AI agent use a service's tools. The Tower serves NoticeOS's tools at `/api/mcp`.

**Measurement window**
: The baseline days plus the check days of an outcome check. The surfaces it measures should stay unchanged while it is open.

**Milestone**
: An alert kind for a number reaching a set level. Always info severity, never urgent.

**Money**
: The page that shows the ledger month by month, with Net P&L. Also a site's own Money tab.

**Month to date**
: The current month on the Money page, whose figures are not final yet.

**Net P&L**
: Revenue minus cost for a site or the portfolio in a month. It is a monthly result, not a return on investment.

**Next up**
: The tasks on the Tasks page that are ready to work, with nothing blocking them. An agent asking for ready work gets the same list.

**Nightly report**
: The counts a site's own servers recorded, sent to NoticeOS once a day. A site never queries outside analytics about itself.

**No clear change**
: An outcome check verdict: neither threshold was met, or none was set. The numbers are shown.

**Opportunity**
: An alert kind for good news that may deserve action.

**Outcome check**
: A comparison you register before the numbers exist: a change, a metric, a scope, a baseline, check days and thresholds. NoticeOS reads it on the check days and closes it with a verdict. See [Attribution and measurement](/concepts/attribution-and-measurement).

**Overview**
: The first tab on a site's page: the site's main figures, a chart of the one you pick, its data sources and what needs your attention.

**Owner**
: The person or agent a task is assigned to. An agent claims a task before starting it.

**Portfolio**
: All the sites in one installation, taken together.

**Project**
: One site's task list, with its own short prefix on every task id. Added under Settings > Task projects.

**Resolve**
: Marking an alert as fixed. The alert is settled.

**Scheduled job**
: Something NoticeOS runs on a timer: collecting reports, running outcome checks, filing review tasks. Shown on the Workflows page and under System health.

**Scope**
: What an outcome check measures: the whole site, one search query, or one page.

**Settled**
: An alert that does not come back: resolved, or marked read. A snoozed alert is not settled.

**Severity**
: The first label on an alert: error, warning or info.

**Site**
: One website in your portfolio. The word on screen is always Site; "property" is reserved for a provider's own object, such as a Google Analytics property.

**Site status**
: The one status label a site shows: Setting up, On track, Monitor only, At risk or Off track. Home, Sites, the site's own page and the Wall all show the same label.

**Snooze**
: Hiding an alert from the open list until a date within 90 days. The same alert comes back on that date.

**Stack**
: The containers an installation runs as, under Docker Compose: the app (the Tower, the data receiver and the scheduler), Postgres for the store, Dolt for tasks, and an optional backup worker. See [Run with Docker](/start/run-with-docker).

**Still counting**
: A day a data source has not finished reporting. Drawn hollow on charts and never tested for alerts.

**Store**
: The installation's own database, in Postgres: every report, reading, ledger row and setting. It keeps history; nothing in it is truncated.

**System health**
: The page that shows whether NoticeOS itself is working: each source's collection, the scheduled jobs, expiring credentials and data spend.

**Task**
: A piece of work on the shared board, for a site or for NoticeOS itself, with status, owner, priority, blockers and the evidence that closed it. Closing a task records a decision, never a business result.

**Task database**
: The one database that holds every project's tasks, run by Dolt inside the stack. Its task model comes from Beads, and `bd` is its command-line tool.

**Threshold**
: The percent change, in a stated direction, that an outcome check must reach to confirm an improvement or a decline.

**Tower**
: NoticeOS's web app: the pages with the sidebar, and the Wall. See [The Tower](/tower/).

**Tune**
: Changing one of the three alert settings from an alert, with a replay of what would have fired. A tuned alert stays open.

**Unmeasured**
: Shipped, with no value claimed, because the effect could not be told apart from noise. The normal state of most small changes.

**Verdict**
: The result an outcome check closes with: improvement confirmed, decline confirmed, no clear change, or could not be measured.

**Wall**
: The TV view: statuses and trends for every site on one screen, meant to be read from across a room. The sidebar labels it **TV dashboard**.

**Workflow**
: A named automation with a purpose, a schedule and a run history, shown on the Workflows page. Its runs record what happened; they are not business results.

**Workspace**
: The boundary that contains a portfolio's sites, evidence, connections and work. You may belong to several without sharing data between them.

**Your decisions**
: The section at the top of the Tasks page: tasks and gates that need a decision from you and nobody else.

## Related

- [How NoticeOS works](/concepts/how-noticeos-thinks)
- [Alerts](/concepts/alerts)
- [Attribution and measurement](/concepts/attribution-and-measurement)
- [Tasks and agents](/concepts/tasks-and-agents)
