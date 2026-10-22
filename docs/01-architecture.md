# 01 — Architecture: a closed loop around a ledger

*A pipeline collects data, proposes changes and applies them, but its results
never change how it selects the next change. The objective
([doc 00](00-objective-and-roi.md)) requires a **control loop**: the realized
outcome of every action must be fed back into the policy that selected it.*

## The loop

### Product direction

NoticeOS is an **agentic operating system for a startup and its assets**. Its
value proposition combines health, traffic, revenue and expense monitoring with
projections, alerts, project/task management and a realtime TV view of the whole
business. Workflows connect those capabilities and show what ran: an operator
can move from a signal to the work it triggered, inspect execution, and return
to the resulting business evidence.

This positioning extends the closed-loop architecture below. The standalone
installation, the invitation-only hosted workspaces and the public demo must
remain distinguishable in release claims; [AGENTS.md](../AGENTS.md) records the
dated implementation state.

### Workflows as the operating layer

A workflow has a stable identity, a purpose, a version and explicit stages.
Schedules are triggers of workflows. Individual runs record what happened;
step attempts provide timing and execution evidence. Later model calls, tool
calls, approvals and event triggers extend this model instead of creating a
separate agent product with disconnected history.

Workflows have their own primary page in the Control Tower. Home and the TV
show the wider business picture; the workflow detail page is for investigation
and configuration. Tasks represent intended work and ownership, execution records
represent what ran, and outcome evaluations represent the result. None can
substitute for the other. The [research and rendering contract](22-workflows-research-and-design.md)
documents this separation and the relevant platform precedents.

The hypothesis for a lasting competitive advantage is a growing body of
evidence linking decisions, work, spend and measured results across assets,
plus reusable workflows based on that evidence. Validate it by improved
calibration, lower operator effort and better measured outcomes. Interface
polish, provider integrations and model access support the product; they do
not by themselves create a lasting advantage.

```
            ┌──────────────────────── LEARN ────────────────────────┐
            │  predicted-vs-realized calibration · reliability      │
            │  ledger · postmortems → context-pack rules            │
            ▼                                                       │
┌────────┐   ┌────────┐   ┌────────┐   ┌────────┐   ┌───────────┐  │
│ SENSE  │──►│ATTRIBUTE│─►│ DECIDE │──►│  ACT   │──►│  (ship)   │──┘
│ reports│   │ realized│  │ scored │   │ build/ │   │ canary ·  │
│ signals│   │ Δ → ledger│ backlog │   │ verify │   │ watch ·   │
│ revenue│   │ booking │  │ policy │   │ PR/merge│  │ rollback  │
└────────┘   └────────┘   └────────┘   └────────┘   └───────────┘
     ▲                                                    │
     └───────────────── ROI LEDGER (doc 00) ◄─────────────┘
          every stage reads it; Attribute and Act write it
```

| Stage | Covers | Spec |
|---|---|---|
| **Sense** | Asset reports, centrally-pulled external signals, revenue & cost ingestion, deploy/model-version annotations | [doc 02](02-signal-contract.md) |
| **Attribute** | Turning shipped changes into realized-value entries limited to what was measured: cohort tests, holdouts, unmeasured-by-design bookings | [doc 03](03-attribution.md) |
| **Decide** | The versioned scoring policy, portfolio allocation, kill criteria, context packs, Goodhart guards (checks that a metric still tracks value once it becomes a target) | [doc 04](04-decision-policy.md) |
| **Act** | Build → independent verify → ship under the autonomy ladder; evidence-based completion | [doc 05](05-execution-and-accountability.md) |
| **Learn** | Calibrating Decide's priors from Attribute's outcomes; the reliability ledger; incident → rule | [docs 04+05], shown in the Tower |

The **Control Tower** shows the state of the loop *and* is where the operator
controls it ([doc 10](10-control-tower.md)): the Wall (TV mode) for
statuses and trends, the queue for reviewing/overriding planned work, the
registry for auditing/undoing shipped work, and NoticeOS's own report
([doc 06](06-operations.md)). Operator actions there (vetoes, boosts, undos)
are Learn inputs, not side effects. The third-party data that agents may
cite, and what it costs, is listed in [doc 11](11-integrations.md).

## Data flow

- **Asset reports go to the central store.** Each asset's worker pushes its
  nightly report (server-observable metrics only) to the central store. Assets
  never query external analytics about themselves; NoticeOS pulls
  GSC/GA4/SEO/revenue centrally and joins on asset id. Service bindings are
  used for occasional drill-downs.
- **Revenue & cost ingestion is a core Sense input**: ad network
  reports, affiliate exports, subscription MRR, plus the OS's own metered
  inference/API spend per run ([doc 06](06-operations.md)). Without this data
  the loop optimizes proxy metrics only.
- **Provider detail is archived centrally, not re-exported by hand.** Daily
  GA4/GSC/BWT and weekly DataForSEO collection jobs store bounded provider
  responses in private R2 and record every attempt (plus metered cost) in the
  Postgres store. Live Tower aggregates remain separate; offline scripts
  flatten the immutable archive for page/query/rank/link/AI/funnel analysis. Assets still
  never query external analytics about themselves.
- **Outbound: PRs via the NoticeOS GitHub App**, plus **flag/canary controls
  and revert automation** — the Act stage must be able to revert a change as
  cheaply as it ships one ([doc 05](05-execution-and-accountability.md)).
- **Beads defines the work model; Dolt stores the central task database.** They
  are required NoticeOS infrastructure for all work it coordinates: its own
  operations, managed assets/projects, and work originating in external tools.
  People and agents use the same model for task status, ownership,
  dependencies, approval gates and completion evidence. Future Jira or Linear
  integrations map work into this model; they do not replace the internal task
  database. The task database must stay available while the NoticeOS
  application restarts; its hosting and current setup are described in
  [doc 06](06-operations.md) and the
  [task database configuration](../config/beads.README.md).
  Operators manage tasks through the NoticeOS UI. A supported NoticeOS API
  will expose the same work model and actions to tools. The application
  runtime runs Beads and `bd`; Dolt stores the data in its own,
  separately restarted service. Hosted users need neither a CLI installation
  nor direct database access. Direct CLI access is a contributor and
  agent-harness adapter, not the operator-facing product contract. Planned
  skills and hooks will connect the operator's chosen agent tools to the same
  task database, so agents can file, claim and hand off work across tools and
  sessions for any managed asset. Each task keeps its identity, current state,
  dependencies and evidence. The task database is the record of open work;
  Markdown holds designs and supporting evidence. Installable agent packages
  are not yet implemented.
  The task database is **separate from** the ledger. A task records a
  commitment; a report records an observation. Nothing from the task database
  enters the report envelope (`PulseEnvelope`) or the signal contract
  ([doc 02](02-signal-contract.md)), and task completion is never evidence of a
  business outcome. The attribution layer must never read from the task
  database: counting planned or finished work as results would measure effort,
  not outcomes.

## Access & security model

- Own GitHub org, private repo, isolated from public-facing orgs to limit the
  damage of a compromise.
- Cloudflare Access sits in front of the Tower, with app-level auth behind it.
- One fine-grained **GitHub App** (`contents:write` + `pull_requests:write` on
  asset repos only), never PATs. The App key is the most sensitive secret; its
  rotation and emergency (break-glass) access are specified in
  [doc 06](06-operations.md).
- **Never changed automatically:** auth, billing, security headers, DB migrations, consent
  surfaces, analytics/tracking pipelines, holdout assignments, guardrail
  thresholds. The last three are the measurement channel and non-negotiable:
  METR measured frontier agents gaming tasks at 25–100% rates when the harness
  allows it, and the reward-tampering literature is unambiguous that the
  *measurement channel* must be outside the optimizer's write scope. An
  agent that can edit the measurements will eventually edit them.
  The [fresh-install exception](../AGENTS.md#hard-invariants)
  permits only `pnpm os:setup` to apply the frozen Postgres schema and bootstrap
  one workspace for a provably new, empty installation, with a new folder,
  Compose project and data volumes; existing installations and production
  remain operator-only.
- **A one-action kill switch exists and is practised in drills** ([doc 06](06-operations.md)).

## Heterogeneity is the design point

Assets do not share a stack, an auth model or a metric set, so **the contract
is capability-agnostic** ([doc 02](02-signal-contract.md)): assets declare what
they can measure and opt into metric families; storage (D1, Analytics Engine,
R2 counts) is an implementation detail. Stack uniformity remains a *cost
optimization* for the builder (shared patterns, one CI idiom) and a per-asset
onboarding note — never an assumption the design depends on.

## What passing CI does not catch

The failures that reduce ROI — a page the crawler cannot read, an asset's most
important page at a fraction of a percent CTR for a quarter, a save flow that loses work —
can all ship with CI passing. CI checks that the code builds and its tests
pass; the failures that reduce ROI are *outcome* failures. So the Act stage
ends with **post-ship outcome-watch and auto-rollback**, connected to the asset
reports and the served-layer guards: this protection runs after merge, not
before it ([doc 05](05-execution-and-accountability.md)).

## Compose vs build

| Concern | Compose | Build (new code that connects the parts) |
|---|---|---|
| Dashboard/charts | Grafana or bespoke React | Tower portfolio views, calibration curves, ledger P&L |
| Asset reports/central store | the ingest Worker + Postgres 18 (`db/postgres/`, `packages/postgres/`), R2 for raw archives | The **signal contract** |
| SEO/traffic data | GSC/GA4 APIs + private R2 archive, DataForSEO, Ahrefs MCP | Revision-aware collection, analysis scripts, attribution rules + booking rules |
| Build → PR | Claude Code / coding agents | Orchestration: contract → build → **independent verify** → ship |
| Budget enforcement | **Cloudflare AI Gateway / LiteLLM-class proxy** (hard caps, fallback-to-cheaper) | Per-change cost attribution to the ledger |
| Ship safety | Feature flags, canary patterns, revert automation | The autonomy ladder + outcome-watch rules |
| Agent context | AGENTS.md convention, MCP | Context-pack freshness + the reliability ledger |

The lasting advantage is in the contract, the context and the orchestration;
the hard parts include attribution, calibration and accountability.

## NoticeOS reports on itself

NoticeOS is one of its own assets and sends the same report it requires from
the others: ingest freshness, cron success, spend per stage, PR throughput,
reliability-ledger stats, budget-cap events. A control plane that monitors
everything except itself can fail the way its assets do: for weeks, with no
alert. The specification is in [doc 06](06-operations.md).
