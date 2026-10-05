# NoticeOS Workflows

## Product decision

Workflows are a primary operating surface in NoticeOS for intentional automations of operator work: creating reviews, delivering notifications and recording outcomes. They show whether the work ran and expose its next expected execution. Internal collection and maintenance belong in **System health → Background operations**. Place **Workflows immediately after Home** in the main navigation. Keep schedule editing inside each workflow, alongside its purpose and execution history.

Use a compact workflow inventory with aligned activity charts as the default view, a separate upcoming schedule view, and an execution inspector with a stage diagram and timing. This is a design recommendation based on the platform comparison below, not a claim that one universal industry standard exists. A month calendar alone is a poor fit for the current inventory: the task-board refresh runs every minute, several collectors run throughout the hour, and other workflows run daily or weekly. A calendar cell cannot communicate those differences without either hiding work or becoming illegible.

The product should answer four questions in order:

1. Does anything need my attention?
2. What does each workflow accomplish, and has it been running?
3. When will it run next?
4. What happened inside the run I am inspecting?

The implementation associated with this design is tracked by `ro-ky6w`. Evidence was checked on September 9, 2026. The comparison covers seven relevant platforms rather than claiming a market-share ranking. Official documentation and product release notes establish feature behavior; published product screenshots establish visual references. No paid customer workspace was used to independently validate performance or every advertised interaction.

## Platform comparison

| Platform | Documented operating model | Useful pattern for NoticeOS | Adaptation required |
| --- | --- | --- | --- |
| Trigger.dev | Task inventory with 24-hour activity charts; dedicated task overview; execution list; detailed traces; LLM usage inspector | Align activity history across workflows and put the workflow object ahead of its configuration | Use purpose-led names instead of developer identifiers; suppress LLM metrics until they exist |
| Inngest | Function runs and filters, followed by a timing waterfall and a contextual step inspector | Keep selected execution context visible while inspecting a failed step | Start with a smaller operator-oriented inspector; expose low-level transport details only when useful |
| LangSmith / Studio | Traces, runs and conversation threads; graph debugging; alternative message and technical detail views | Separate workflow structure from what one execution actually did | NoticeOS is initially an operations product, so do not make a chat transcript the primary interface |
| Langfuse | Typed observations, trace tree, timeline and agent graph; aggregate and expanded graph modes | Give steps stable identities and types; preserve repeated calls and nesting | Dynamic loops require a run-specific graph, not merely a static progress bar |
| Temporal | Searchable workflow execution inventory, chronological event history, grouped events, upcoming/recent scheduled executions | Distinguish execution state, schedule state and worker availability | Do not expose infrastructure terminology as the operator's primary vocabulary |
| Windmill | Scripts/flows have triggers; schedules have run history and operational controls; basic or cron scheduling | Treat a schedule as one way to start a workflow, with a preview before saving | Preserve NoticeOS's existing guarded configuration path and bounded catch-up behavior |
| n8n | Global and workflow-scoped execution lists; status filters; investigation and retry of prior executions | Provide a portfolio view and an object-specific execution view using the same records | Retry semantics require explicit execution support; a visual button must never promise a capability the runner lacks |

### Trigger.dev: operational density with contextual detail

The July 3, 2026 dashboard update describes a quieter sidebar, distinct scheduled/standard/agent task types, 24-hour activity charts and a dedicated overview for each task. Its published screenshots show compact aligned activity bars, with failures visible inside the same chart as successful work. The detail reference groups metrics above execution history and keeps task metadata beside that history.[^1]

The September 4 runs-list update adds configurable columns and URL-persisted layouts. Its practical lesson is that investigation state deserves a stable address. NoticeOS should preserve the selected workflow, run and status filter in the URL; it does not need a general column designer for nineteen built-in workflows.[^2]

The July 31 LLM observability release connects workload cost summaries to individual model calls. The call inspector shows provider/model, usage, cost, messages, tools and prompt version. Those are distinct facets of one execution, not a reason to create a separate “AI jobs” product silo.[^3]

![Trigger.dev's published activity-chart reference](https://trigger.dev/changelog/dashboard-ui-updates/activity-charts.png)

*Official visual reference: Trigger.dev, July 3, 2026. Borrow the aligned history and clear failure segments; the promotional frame is not part of the proposed NoticeOS interface.*

### Inngest: timing and failure inspection

Inngest documents a split view: execution timing on the left and details of the selected run or step on the right. Its waterfall locates spans proportionally in time and distinguishes scheduling delay from execution. Success is green, failure red and cancellation gray. Separate retry spans preserve the history of failed attempts. Error details become the initial inspector tab for a failed step.[^4]

This directly supports a NoticeOS detail view that keeps the process visible while explaining one step. A horizontal stage diagram answers what the workflow does; a timing view answers where the time went. Neither should silently claim the other. Where timing is unavailable, show that absence instead of distributing an overall duration evenly across invented steps.

The platform's metrics documentation also treats function inventory and run-level investigation as related but separate views. NoticeOS should similarly avoid using the newest run as a substitute for a workflow's longer history.[^5]

### LangSmith: conversation context and execution evidence

LangSmith distinguishes projects, traces, individual runs and threads. A trace represents an operation composed of runs; threads connect multiple traces into a continuing conversation. That distinction matters for agentic NoticeOS workflows: one scheduled obligation, an individual execution, and a continuing agent conversation should not share one overloaded identifier.[^6]

The current trace viewer offers Messages, Turns and Details. Messages provides conversation orientation; Details exposes the selected operation's timing, errors and metadata without discarding its surrounding context. The Messages view is documented as beta and requires renderable message data; thread features require thread instrumentation.[^7]

Studio's graph mode exposes architecture, traversed nodes and intermediate state, while chat mode supports a simpler interaction. These serve different audiences.[^8] NoticeOS's operator needs execution and outcome first. A future message view should therefore be an optional inspection mode for workflows with model calls, rather than the default layout for backups and data collection.

### Langfuse: a graph must describe what actually happened

Langfuse's July 13, 2026 graph release distinguishes an aggregated graph from an expanded execution graph. Aggregation merges repeated step names and represents loops compactly; expansion preserves each individual call. The documented renderer keeps graph layout deterministic and preserves the viewport during navigation. The feature is described as beta.[^9]

This is a significant distinction for architecture. A workflow definition might contain one “Research evidence” stage, while a particular agent run might call retrieval five times, switch tools and ask for approval. Store those calls as separate attempts or child spans. A counter on a definition node can summarize them, but cannot replace their evidence.

Langfuse's tracing guidance recommends meaningful, stable observation names, correct nesting, and a separate generation record for each model invocation. Its type system distinguishes tools, retrieval, generations and evaluators.[^10][^11] NoticeOS should name a step by its business purpose and record its implementation details separately. “Draft change proposal” remains useful when the model changes; naming the step after a model would undermine that continuity.

### Temporal: distinguish schedule, execution and runtime

Temporal's maintained Web UI documentation describes a workflow execution table, preferred timestamp formats, several history representations, worker availability and a separate Schedules surface containing recent and upcoming runs. User metadata can provide summaries and human-readable execution details.[^12]

Its event-history update emphasizes current attempts, upcoming retries, filtering to pending/failed events, live updates and the ability to pause those updates while investigating.[^13] The NoticeOS adaptation is straightforward: keep the operator's selected historical run stable while polling, show runtime unavailability prominently, and distinguish “the schedule is enabled” from “the runner has confirmed it.” A saved schedule is not proof that a process is executing it.

### Windmill: triggers and understandable schedule controls

Windmill describes cron as one trigger among webhooks and other entry points. A schedule references a runnable script or flow, and its UI connects schedules to execution history. It supports both simplified scheduling and raw cron, along with error/recovery behavior and upcoming-run previews.[^14]

One relevant difference requires an explicit NoticeOS decision: Windmill documents dynamically skipped runs as successful with a skipped flag. NoticeOS should render a skip neutrally and label it **Skipped**. The operator specifically needs to distinguish useful execution from work that did not run. An intentionally paused workflow should likewise remain visible without being counted as a failure.

### n8n: one inventory, several investigation scopes

n8n's execution documentation describes a global execution view and project/workflow scopes, filters for failed/running/success/waiting, and retry choices using either the original or current workflow. That last distinction is important: “Retry” is ambiguous unless the product identifies which definition and inputs will run.[^15]

The current execution documentation supports this comparison. The assessment is limited to the documented execution experience; it does not claim a comprehensive hands-on assessment of n8n's editor or approval interface.

## Recommended information architecture

**Home → Workflows → Assets → Alerts → Tasks** gives execution appropriate presence without replacing the portfolio overview. Workflows explains intentional operator automations; Tasks remains the register of human and agent work. System health owns API collection, refreshes, backups, service checks and connection evidence. Integrations manages provider access and setup. The workflow catalog declares a `workflow` or `system` surface while both use the same scheduler, trace, output inspector and editor. Older workflow URLs redirect to the correct surface with the requested run intact.

At `/workflows`, the first screen contains a short operational summary, filters and the inventory. Use a clear heading, generous column alignment, restrained borders and consistent row height. Avoid nineteen large cards, each repeating “enabled,” “scheduled” and “active.” Those labels would consume space without answering nineteen distinct questions.

The inventory's core columns are:

| Column | Meaning |
| --- | --- |
| Workflow | Human name, one-sentence purpose, category |
| Current state | Failed, Running, Succeeded, Skipped, Paused, No runs, or Unknown, with a distinct glyph |
| Activity | Aligned, labeled 24-hour history with red failures and neutral missing periods |
| Latest run | Actual start time and execution result; opens that run |
| Next run | Runner-confirmed next execution; pending or unavailable when confirmation is missing |

The optional Needs attention order brings failures and uncertain operation forward, then currently executing workflows, then healthy and intentionally inactive ones. Filtering should be explicit and bookmarkable. Search should match purpose as well as name: an operator searching “robots” should discover the workflow that checks search accessibility.

Use **Overview** and **Schedule** as route-backed views of the same inventory. A schedule timeline has a shared horizontal time axis and one row per workflow, with next executions represented as marks. High-frequency schedules need aggregation so they do not dominate the page. Exact times are accessible on focus/tap. A nearby agenda should list the next execution per workflow, ensuring that minute-by-minute refreshes cannot push a weekly workflow out of view.

The schedule view is a forecast of the currently confirmed schedule, not a guarantee of future successful execution. Paused workflows have no next marker. Pending schedule changes are not drawn as if already armed. Never represent future executions as successful green history.

The inventory defaults to **Latest run**, newest first, including executions in
progress; workflows without a recorded run come last. Operators can choose
**Needs attention**, **Next run**, or **Name**. The selected order and filters
remain in the URL. Attention is still visible in the headline count and filter
without overriding the operator’s chosen chronology.

Purpose groups are Business signals, Site health, Outcomes, Tasks and System
maintenance. Each group shows its current state counts and a short explanation.
The chosen sort applies within each group; groups follow their first sorted
member. **Group → None** restores the flat global order. Both grouping and the
category filter are URL state.

## Workflow detail and stage rendering

`/workflows/:id` opens the workflow's purpose and recent execution context. A specific run has a stable query parameter so a bookmark or copied URL reopens that run after a refresh. The operator can switch runs without losing the workflow's identity or opening a new page hierarchy.

The main detail area shows a process diagram with readable stage names and explicit connections. Parallel stages occupy the same level; dependent stages occupy later levels. Node position is deterministic. Color indicates observed execution state, never assumed completion from the node's place in the graph. Nodes are keyboard-focusable buttons; selecting one opens a nearby inspector with its purpose, result and timing. On a narrow screen, stages become a vertical ordered presentation and the inspector follows the selection.

For a short deterministic workflow, the graph may be small. That is appropriate. Do not add decorative “AI” nodes, pretend substeps, or a universal twenty-node canvas to make execution look sophisticated. Where only whole-job evidence exists, display the definition and explicitly state that this historical execution has no step details. New observations must be produced at real execution boundaries.

The inspector should prefer a concise outcome over raw payloads. “Two properties could not be collected” is a better first explanation than a JSON object. Raw inputs, credentials and provider response bodies do not belong in an unrestricted operations trace. The current inspector captures allowlisted counts, metadata and per-asset/project results as metric cards and tables, with a collapsed captured-data view. Missing output is explicitly unavailable and zero remains a real recorded value. Future detailed artifacts require access control and deliberate redaction; a trace identifier can link to a protected artifact without duplicating it.

A separate timing view can show start offsets and durations for actual spans. Waiting, execution and retries should remain distinct when supported by evidence. If a worker returns stage information only after finishing, the interface must say it is awaiting stage results while that request is in progress. It must not animate an imagined sequence.

## State contract

| State | Visual treatment | Required evidence or condition |
| --- | --- | --- |
| Succeeded | Green check | Recorded successful execution; no recorded failed step |
| Failed | Red error glyph | Failed execution or recorded failed execution stage |
| Running | Neutral active/spinner glyph | Current execution observation and a fresh runtime heartbeat |
| Skipped | Gray slash | Recorded execution declined or skipped work |
| Paused | Gray pause glyph | Confirmed disabled schedule; historical failures remain visible in history |
| No runs | Gray hollow mark | Readable history contains no recorded execution |
| Unknown | Gray question mark plus explicit explanation | History/runtime evidence is unavailable, stale or incomplete |
| Awaiting approval | Amber approval glyph | Future explicit persisted approval request; not a spinner or failure |

Color is supplementary. Every state has text and shape, and compact charts share a legend. A chart with no observations retains empty geometry and says “No recorded runs”; it does not display a fabricated zero-success rate. Successful execution means the operation completed as recorded. Search improvement, revenue lift and LLM output quality require their own outcome evidence.

Current state and historical condition need separate semantics. A workflow may be paused now and have failed yesterday. A daily workflow can be healthy even if most hourly buckets are empty. A weekly workflow must not be described as broken because it had no run in the selected day. If schedule-relative lateness is introduced, derive it from an explicitly recorded obligation and effective schedule history, not from a guessed cadence or today's settings applied retrospectively.

A service outage is prominent once at page level. Retained history remains readable, but historical green marks must not imply that the runner is currently working. Configuration status similarly distinguishes saved changes from runner-confirmed changes. Pausing future work does not imply cancellation of a run already in progress.

## Schedule configuration

Provide Status and Frequency, with minute/hour/day/week controls appropriate to the selected frequency. Show the timezone next to the time, and show several upcoming timestamps before Save. Display all timestamps in the viewer’s local timezone with UTC references on hover. Existing schedules remain in UTC unless timing is explicitly edited. Timing edits save the viewer’s IANA timezone and follow its daylight-saving transitions; pausing alone preserves the existing cron and timezone. The editor previews local dates before Save, and the runner and bounded recovery use the same saved timezone.

Use the existing guarded save and Undo mechanism. Capture the prior schedule when editing begins, refuse a conflicting save, and keep the draft visible after a failure. Restoring a default removes that workflow's override without resetting unrelated workflows. Explain schedule effects where they matter: more frequent paid-provider collection can cost more; pausing backups stops future scheduled copies.

An arbitrary-command field is outside this product model. New executable workflows require a versioned definition with documented capability and ownership. A successful schedule edit cannot itself grant additional execution authority.

## Architecture for agentic execution

Keep five concepts separate:

| Concept | Responsibility |
| --- | --- |
| Workflow definition | Stable identity, version, purpose, stage definitions, dependency edges and execution adapter |
| Trigger | Why work starts: schedule now; event or manual trigger when supported |
| Workflow run | One observed execution, definition version, trigger context, start/end and overall execution result |
| Step attempt | One real invocation of a stage, its parent, timings, state and bounded result summary |
| Outcome evaluation | Whether the produced result met its business or quality objective |

The initial implementation should adapt the existing scheduler and execution records. It should not replace the runtime merely to draw a graph. A separate trace adapter can retain richer local stage observations without inserting synthetic step runs into the existing whole-job measurement table. Existing dispatch identities, collector behavior, catch-up limits and outcome rules remain intact.

Future LLM steps fit this same structure with a typed model-call detail: provider, requested/returned model, prompt version, input/output usage, cost and pricing provenance. Missing usage means unknown cost, not zero. Tool calls, retrieval, approvals and evaluation have their own step kinds and observed states. A run can link to a continuing conversation, parent workflow or task without confusing those identities.

OpenTelemetry's GenAI guidance provides a useful interoperability direction for model, usage and tool-call attributes, but the conventions remain actively developed and their documentation has moved between repositories. Treat the export mapping as a versioned adapter rather than making the product database depend on an unpinned external vocabulary.[^16]

Agent loops need attempt identity and parent relationships from the start. Definition nodes describe allowable structure; run spans describe the actual path. A failed tool attempt followed by success stays in the trace. An approval is a persisted waiting state with an owner and decision record. Reopening a browser cannot approve it, and a retry cannot silently repeat a protected side effect. These are architectural requirements for later agent execution, not capabilities claimed for the current scheduler.

Execution success also remains separate from evaluated correctness. A model may finish normally and propose a poor change. NoticeOS should attach the assessment to the output and its evidence, preserving the execution trace rather than recoloring history to match a later judgment. This aligns the workflow system with the OS's existing Sense → Attribute → Decide → Act → Learn loop.

## Rendering and acceptance

The visual target is a calm operations workspace: clear object names, aligned timelines, restrained navigation, and red used where evidence warrants attention. Green is scoped to successful execution. Use the existing design-system typography, panels, page header, tabs and tooltip behavior. New execution charts need their own registry entry because the existing annotation timeline and asset lifecycle stepper represent different data.

The implementation is acceptable when an operator can identify a failed workflow from the first viewport, explain its purpose without opening source code, open the failing run and stage, distinguish paused from unknown, and preview a schedule change before saving. Keyboard navigation, narrow layouts and stale data are part of that acceptance. A professional screenshot with fabricated healthy data does not establish operational correctness.

## Sources

[^1]: Trigger.dev, [Dashboard UI updates](https://trigger.dev/changelog/dashboard-ui-updates), July 3, 2026. Includes the published activity-chart and task-overview visual references.
[^2]: Trigger.dev, [Customize the runs list with columns and smart columns](https://trigger.dev/changelog/runs-columns), September 4, 2026.
[^3]: Trigger.dev, [LLM observability, built in](https://trigger.dev/changelog/llm-observability), July 31, 2026.
[^4]: Inngest, [Traces](https://www.inngest.com/docs/platform/monitor/traces), current documentation, accessed September 9, 2026.
[^5]: Inngest, [Observability and metrics](https://www.inngest.com/docs/platform/monitor/observability-metrics), current documentation, accessed September 9, 2026.
[^6]: LangChain, [Observability concepts](https://docs.langchain.com/langsmith/observability-concepts), current documentation, accessed September 9, 2026.
[^7]: LangChain, [View traces](https://docs.langchain.com/langsmith/view-traces), current documentation, accessed September 9, 2026. Messages view is labeled beta.
[^8]: LangChain, [LangSmith Studio](https://docs.langchain.com/langsmith/studio), current documentation, accessed September 9, 2026.
[^9]: Langfuse, [Graph View: Aggregated and Expanded modes](https://langfuse.com/changelog/2026-07-13-graph-view-modes), July 13, 2026; [Agent Graphs](https://langfuse.com/docs/observability/features/agent-graphs), last edited August 13, 2026.
[^10]: Langfuse, [What does a good trace look like?](https://langfuse.com/docs/observability/best-practices), current documentation, accessed September 9, 2026.
[^11]: Langfuse, [Observation Types](https://langfuse.com/docs/observability/features/observation-types), current documentation, accessed September 9, 2026.
[^12]: Temporal, [Temporal Web UI](https://github.com/temporalio/documentation/blob/main/docs/web-ui.mdx), maintained documentation source, accessed September 9, 2026.
[^13]: Temporal, [Updated Event History Timeline View is Now Available](https://temporal.io/changelog/updated-event-history-timeline-view-is-now-available), August 29, 2024; checked against the current Web UI documentation.
[^14]: Windmill, [Schedules](https://www.windmill.dev/docs/core_concepts/scheduling), current documentation, accessed September 9, 2026.
[^15]: n8n, [View all executions](https://docs.n8n.io/build/understand-workflows/understand-executions/view-all-executions), current documentation, accessed September 9, 2026.
[^16]: OpenTelemetry, [Inside the LLM Call: GenAI Observability with OpenTelemetry](https://opentelemetry.io/blog/2026/genai-observability/), 2026; [Gen AI attribute registry](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/), accessed September 9, 2026, with relocation/deprecation notices.


## Operations and integration boundaries — 2026-09-09

The five current operator automations cover notifications, outcome checks, search
review tasks, unpublished-change checks and outcome task updates. Fourteen
internal operations are discoverable in System health. These are built-in
capabilities; arbitrary custom and LLM workflows are not yet implemented
(`ro-uojt`). Scheduling alone does not decide which surface owns an operation:
its operator purpose does.

System health starts with observed scheduler, live-execution and history status,
then groups data connection issues into actions. Unknown is explicit when any
monitoring source is unavailable. Background operations provides hourly activity,
future schedule, filters and execution details; credential expiry, data costs
and the full source matrix are disclosed below the actionable overview.

This separation adapts Inngest's progression from function status and failing
functions to execution details, while retaining NoticeOS's distinct portfolio
connection evidence. It avoids inventing uptime or success-rate trends from
records that do not support them. [Inngest observability documentation](https://www.inngest.com/docs/platform/monitor/observability-metrics).

Integrations is the umbrella for provider accounts, keys, webhooks and their
settings. Windmill's distinction between integration definitions and configured
resources reinforces keeping provider discovery separate from connection
instances. NoticeOS should present this in operator language, with guided
connection, asset assignment and verification, rather than exposing resource
schemas. [Windmill integration documentation](https://www.windmill.dev/docs/integrations/integrations_on_windmill).


## Integration discovery and connection lifecycle

The Integrations redesign uses a searchable catalog with Traffic & search,
Revenue and Coordination categories. Each provider explains the outcome it
supports and displays its credential state, configured assets and last use.
Category, search and connection-state filters remain in the URL while opening
and returning from a provider. Names omit parenthetical implementation detail;
purposes explain the capabilities underneath.

The focused provider page has four sections: Connect, Choose assets, Verify and
Settings. This reuses the existing credential forms, Google sign-in, per-asset
configuration links, connection probes, expiry editor and deliberate disconnect
confirmation. Setup navigation indicates the current section, not a claim that
previous sections passed. Saving access, assigning an asset and observing a
successful collection are separate facts. Failures remain visible across steps.
No new provider calls happen merely by opening the page or moving between steps.

**Superseded for the catalog and for key-based providers (2026-09-22, bead
`ro-ujb9.96.7.1`, epic `ro-ujb9.96.7`).** The catalog is now one row per
provider, grouped by category, with one status and one action; search, filters
and purpose sentences are gone (the private historical audit in
`reports/2026-09-23-ux-flow-audit.html` measured them as reading without deciding). A provider that declares a connect
kind in the contract (`IntegrationConnect`: Bing Webmaster Tools and
DataForSEO today) connects in one panel over the list: the operator pastes the
key and presses Connect, the ingest asks the provider first and stores the key
only if it accepts (`POST /api/integrations/:provider/connect`), and the panel
shows Checking, then Key accepted or the provider's refusal. There is no Choose
assets step and no detour through the asset. The four-section page above
remains for managing a connected provider and for every provider whose own bead
under the epic has not moved it into the panel yet.

This design adapts the separation of catalog schema and configured resources in
[Windmill’s integration model](https://www.windmill.dev/docs/integrations/integrations_on_windmill),
and the test, reconnect and delete lifecycle documented in
[Zapier’s app connection management](https://help.zapier.com/hc/en-us/articles/8496290788109-Manage-your-app-connections).
Both were checked on September 9, 2026. The four-section onboarding sequence is
our product design, not a claim that either platform uses this exact layout.
