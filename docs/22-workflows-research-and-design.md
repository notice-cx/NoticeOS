# NoticeOS Workflows

## Product decision

Workflows are a primary operating surface for intentional automations of
operator work: creating reviews, delivering notifications and recording
outcomes. They show whether the work ran and when it runs next. Internal
collection and maintenance belong in **System health → Background operations**.
**Workflows** sits immediately after **Home** in the main navigation. Schedule
editing stays inside each workflow, beside its purpose and execution history.

The default view is a compact inventory with aligned activity charts; a
separate schedule view shows what runs next; an execution inspector shows a
stage diagram and timing. A month calendar alone does not fit the inventory:
the task-board refresh runs every minute, several collectors run through the
hour, and other jobs run daily or weekly. A calendar cell cannot show those
differences without hiding work or becoming illegible.

The surface answers four questions in order:

1. Does anything need my attention?
2. What does each workflow accomplish, and has it been running?
3. When will it run next?
4. What happened inside the run I am inspecting?

Trigger.dev, Inngest, LangSmith, Langfuse, Temporal, Windmill and n8n were
studied from their public documentation. What NoticeOS took from them: aligned
activity history across workflows, a selected run that stays put while you
inspect a step, a graph that records what a run actually did rather than what
the definition allows, separate schedule and execution states, a schedule
treated as one trigger among several with a preview before saving, and one set
of execution records read at portfolio and workflow scope.

## Information architecture

**Home → Workflows → Sites → Alerts → Tasks** gives execution its own place
without replacing the portfolio overview. Workflows holds the operator
automations; Tasks remains the register of human and agent work. System health
owns collection, refreshes, backups, service checks and connection evidence.
Integrations manages provider access. The catalog in
[`scripts/scheduled-jobs.mjs`](../scripts/scheduled-jobs.mjs) gives each job a
`workflow` or `system` surface; both surfaces share the scheduler, trace,
output inspector and editor. Older workflow URLs redirect to the right surface
with the requested run intact.

At `/workflows` the first screen holds a one-line answer, filters and the
inventory. One row per workflow, consistent height, restrained borders; no
cards repeating "enabled", "scheduled" and "active".

| Column | Meaning |
| --- | --- |
| Workflow | Name, source and category |
| State | Failed, Running, Succeeded, Skipped, Paused, No runs or Unknown, each with its own glyph |
| Hourly activity | Aligned 24-hour history with red failures and neutral empty hours; the latest run's age beneath it opens that run |
| Next run | Runner-confirmed next execution in local time; pending or unavailable when confirmation is missing |

**Activity** and **Schedule** are route-backed views of the same inventory.
The schedule view has a shared time axis for the next 24 hours, one row per
workflow, and marks for the next executions. It is a forecast of the confirmed
schedule, not a promise of success: paused workflows have no marker, pending
changes are not drawn as armed, and future executions are never drawn as green
history.

The inventory sorts by **Latest run** by default, newest first, including runs
in progress; workflows without a recorded run come last. **Needs attention**,
**Next run** and **Name** are the other orders. Search matches purpose as well
as name: searching "robots" finds the job that checks search accessibility.
Purpose groups are Business signals, Site health, Notifications, Outcomes,
Tasks and System maintenance, each with its own state counts. The sort applies
within each group; **Group → None** restores the flat order. Sort, filters,
grouping and the selected run are URL state.

## Workflow detail and stage rendering

`/workflows/:id` opens the workflow's purpose and recent execution context. A
specific run has a stable `?run=` parameter, so a copied URL reopens that run.
Switching runs keeps the workflow in place.

The detail area shows a process diagram with readable stage names and explicit
connections. Parallel stages share a level; dependent stages sit later. Node
position is deterministic. Colour shows observed execution state, never
completion assumed from a node's place in the graph. Nodes are focusable
buttons; selecting one opens an inspector with its purpose, result and timing.
On a narrow screen the stages become a vertical list.

A short deterministic workflow has a small graph, and that is correct. No
decorative "AI" nodes, invented substeps or universal canvas. Where only
whole-job evidence exists, the page shows the definition and says the run has
no step details. Observations come from real execution boundaries.

The inspector leads with a concise outcome, not a raw payload: "Two properties
could not be collected" before any JSON. Raw inputs, credentials and provider
response bodies stay out of the trace. The inspector shows allowlisted counts,
metadata and per-site or per-project results as metric cards and tables, with
a collapsed captured-data view. Missing output reads as unavailable; zero is a
real recorded value.

A timing view shows start offsets and durations for real spans. Waiting,
execution and retries stay distinct where evidence supports them. While a
worker that reports stages only at the end is still running, the page says it
is awaiting stage results; it never animates an imagined sequence.

## State contract

| State | Visual treatment | Required evidence or condition |
| --- | --- | --- |
| Succeeded | Green check | Recorded successful execution; no recorded failed step |
| Failed | Red error glyph | Failed execution or recorded failed stage |
| Running | Neutral spinner | Current execution observation and a fresh runtime heartbeat |
| Skipped | Gray slash | Recorded execution declined or skipped work |
| Paused | Gray pause glyph | Confirmed disabled schedule; past failures stay in history |
| No runs | Gray hollow mark | Readable history holds no recorded execution |
| Unknown | Gray question mark with an explanation | History or runtime evidence is unavailable, stale or incomplete |
| Awaiting approval | Amber approval glyph | A persisted approval request; never a spinner or a failure |

A skip is neutral and labelled **Skipped**, never counted as success: the
operator needs to tell useful execution from work that did not run. Colour is
supplementary; every state has text and shape, and compact charts share a
legend. A chart with no observations keeps its empty geometry and says "No
recorded runs", never a fabricated zero-success rate. Successful execution
means the operation completed; search improvement, revenue lift and model
output quality need their own outcome evidence.

Current state and past condition are separate. A workflow can be paused now and
have failed yesterday. A daily workflow is healthy with most hourly buckets
empty; a weekly one is not broken for having no run today. Lateness, if added,
comes from a recorded obligation and the schedule in force at the time, never
from a guessed cadence or today's settings applied backwards.

A service outage shows once, at page level. History stays readable, but past
green marks do not imply the runner works now. Saved changes and
runner-confirmed changes are distinct. Pausing future work does not cancel a
run in progress.

## Schedule configuration

The editor offers Status and Frequency, with minute, hour, day and week
controls for the chosen frequency, and shows several upcoming times before
**Save**. Times display in the viewer's time zone with a UTC reference on
hover. Existing schedules stay in UTC until their timing is edited; a timing
edit saves the viewer's IANA zone and follows its daylight-saving changes.
Pausing alone keeps the cron and zone. The runner and bounded catch-up use the
same saved zone.

Saving uses the guarded save and **Undo**: the editor captures the prior
schedule when editing starts, refuses a conflicting save and keeps the draft
after a failure. Restoring a default removes that workflow's override only.
The editor says what a change costs where it matters: more frequent paid
collection spends more; pausing backups stops future copies.

There is no arbitrary-command field. A new executable workflow needs a
versioned definition with stated capability and ownership. A schedule edit
never grants execution authority.

## Architecture for agentic execution

Five concepts stay separate:

| Concept | Responsibility |
| --- | --- |
| Workflow definition | Stable identity, version, purpose, stage definitions, dependency edges and execution adapter |
| Trigger | Why work starts: a schedule now; an event or manual trigger when supported |
| Workflow run | One observed execution: definition version, trigger context, start, end and overall result |
| Step attempt | One real invocation of a stage: its parent, timings, state and bounded result summary |
| Outcome evaluation | Whether the result met its business or quality objective |

The implementation adapts the existing scheduler and execution records; it does
not replace the runtime to draw a graph. A separate trace adapter keeps
richer stage observations without inserting synthetic step runs into the
whole-job measurement table. Dispatch identities, collector behaviour,
catch-up limits and outcome rules stay intact.

Model steps, when they exist, fit the same structure with a typed model-call
detail: provider, requested and returned model, prompt version, input and
output usage, cost and pricing provenance. Missing usage means unknown cost,
not zero. Tool calls, retrieval, approvals and evaluation are their own step
kinds. A run can link to a conversation, parent workflow or task without
sharing their identities. An export to OpenTelemetry's GenAI conventions, which
are still moving, is a versioned adapter; the store never depends on that
vocabulary.

Agent loops carry attempt identity and parent links from the start. Definition
nodes describe allowable structure; run spans describe the path taken. A failed
tool attempt followed by a success stays in the trace. An approval is a
persisted waiting state with an owner and a decision record; reopening a
browser cannot approve it, and a retry cannot silently repeat a protected side
effect. These are requirements for later agent execution, not capabilities of
the current scheduler.

Execution success stays separate from evaluated correctness. A model can finish
normally and propose a poor change. The assessment attaches to the output and
its evidence; history is never recoloured to match a later judgement. This is
the Sense → Attribute → Decide → Act → Learn loop applied to workflows.

## Rendering and acceptance

The target is a calm operations workspace: clear names, aligned timelines,
restrained navigation, red only where evidence warrants attention, green only
for successful execution. Pages use the design system's typography, panels,
page header, tabs and tooltips. Execution charts have their own registry
entries, because the annotation timeline and lifecycle stepper show different
data.

The surface is acceptable when an operator can spot a failed workflow in the
first viewport, explain its purpose without reading source, open the failing
run and stage, tell paused from unknown, and preview a schedule change before
saving, by keyboard, on a narrow screen and with stale data. A polished
screenshot of fabricated healthy data proves nothing.

## Operations and integration boundaries

Five operator automations cover notifications, outcome checks, search review
tasks, unpublished-change checks and outcome task updates. The other built-in
jobs are internal operations under System health. Arbitrary custom and model
workflows are not built. An operation's purpose for the operator, not the fact
that it is scheduled, decides which surface owns it.

System health starts with observed scheduler, live-execution and history
status, then groups connection issues into actions. Unknown is explicit when
any monitoring source is unavailable. **Background operations** has hourly
activity, the schedule, filters and execution details; credential expiry, data
costs and the full source matrix sit below the actionable overview. Nothing
invents an uptime or success-rate trend the records do not support.

Integrations is the home for provider accounts, keys, webhooks and their
settings. Provider discovery stays separate from configured connections, in
operator language: guided connection, site assignment and verification, never
a resource schema.

## Integration discovery and connection lifecycle

The **Integrations** catalog is one row per provider, grouped by category
(Traffic & search, Revenue, Coordination, Other), with one status and one
action. There is no search, filter or purpose sentence: those are read without
deciding anything. Names carry no parenthetical implementation detail.

A provider that declares a connect kind in the contract (`IntegrationConnect`)
connects in one panel over the list: you paste the key and press **Connect**;
the Tower's `POST /api/integrations/:provider/connect` asks the provider first
and stores the key only if it accepts; the panel shows checking, then the key
accepted or the provider's refusal. There is no asset-selection step and no
detour through a site.

A provider's own page remains for managing a connected provider and for every
provider not yet in the panel. It reuses the credential forms, Google sign-in,
per-site configuration links, connection probes, expiry editor and a deliberate
disconnect confirmation. Saving access, assigning a site and observing a
successful collection are separate facts. Failures stay visible across steps.
Opening the page or moving between steps makes no provider call.
