# 01 — Architecture: a closed loop around a ledger

*A pipeline senses, proposes and acts, but nothing it does ever teaches it
anything. The objective ([doc 00](00-objective-and-roi.md)) requires a
**control loop**: the realized outcome of every action must flow back into the
policy that chose it.*

## The loop

### Product direction

NoticeOS is an **agentic operating system for a startup and its assets**. Its
value proposition combines health, traffic, revenue and expense monitoring with
projections, alerts, project/task management and a realtime TV view of the whole
business. Workflows are the visible execution layer joining those capabilities:
an operator can move from a signal to the work it triggered, inspect execution,
and return to the resulting business evidence.

This positioning extends the closed-loop architecture below. The standalone
installation, the invitation-only hosted workspaces and the public demo must
remain distinguishable in release claims; [AGENTS.md](../AGENTS.md) carries
dated implementation state.

### Workflows as the operating layer

A workflow has a stable identity, a purpose, a version and explicit stages.
Schedules are triggers of workflows. Individual runs record what happened;
step attempts provide timing and execution evidence. Later model calls, tool
calls, approvals and event triggers extend this model instead of creating a
separate agent product with disconnected history.

Workflows have a primary Control Tower destination. Home and the TV provide
the wider operating picture; workflow detail provides investigation and
configuration. Tasks represent intended work and ownership, execution records
represent what ran, and outcome evaluations represent the result. None can
substitute for the other. The [research and rendering contract](22-workflows-research-and-design.md)
documents this separation and the relevant platform precedents.

The moat hypothesis is a growing body of evidence linking decisions, work,
spend and measured results across assets, plus reusable workflows grounded in
that evidence. Validate it by improved calibration, lower operator effort and
better measured outcomes. Interface polish, provider integrations and model
access support the product; they do not by themselves prove a moat.

```
            ┌──────────────────────── LEARN ────────────────────────┐
            │  predicted-vs-realized calibration · reliability      │
            │  ledger · postmortems → context-pack rules            │
            ▼                                                       │
┌────────┐   ┌────────┐   ┌────────┐   ┌────────┐   ┌───────────┐  │
│ SENSE  │──►│ATTRIBUTE│─►│ DECIDE │──►│  ACT   │──►│  (ship)   │──┘
│ pulses │   │ realized│  │ scored │   │ build/ │   │ canary ·  │
│ signals│   │ Δ → ledger│ backlog │   │ verify │   │ watch ·   │
│ revenue│   │ honesty │  │ policy │   │ PR/merge│  │ rollback  │
└────────┘   └────────┘   └────────┘   └────────┘   └───────────┘
     ▲                                                    │
     └───────────────── ROI LEDGER (doc 00) ◄─────────────┘
          every stage reads it; Attribute and Act write it
```

| Stage | Owns | Spec |
|---|---|---|
| **Sense** | Asset pulses, centrally-pulled external signals, revenue & cost ingestion, deploy/model-version annotations | [doc 02](02-signal-contract.md) |
| **Attribute** | Turning shipped changes into *honest* realized-value entries: cohort tests, holdouts, unmeasured-by-design bookings | [doc 03](03-attribution.md) |
| **Decide** | The versioned scoring policy, portfolio allocation, kill criteria, context packs, Goodhart guards | [doc 04](04-decision-policy.md) |
| **Act** | Build → independent verify → ship under the autonomy ladder; evidence-based completion | [doc 05](05-execution-and-accountability.md) |
| **Learn** | Calibrating Decide's priors from Attribute's outcomes; the reliability ledger; incident → rule | [docs 04+05], surfaced in the Tower |

The **Control Tower** is the loop's instrument panel *and* the operator's
control surface ([doc 10](10-control-tower.md)): the Wall (TV mode) for
statuses and trends, the queue for reviewing/overriding planned work, the
registry for auditing/undoing shipped work, and the OS's own pulse
([doc 06](06-operations.md)). Operator actions there (vetoes, boosts, undos)
are Learn inputs, not side effects. Agent grounding — which third-party data
the loop may cite, at what cost — is cataloged in
[doc 11](11-integrations.md).

## Data flow

- **Asset pulse, push-to-central.** Each asset's worker pushes its nightly pulse
  (server-observable metrics only) to the central store. Assets never query
  external analytics about themselves; NoticeOS pulls GSC/GA4/SEO/revenue
  centrally and joins on asset id. Service bindings for occasional drill-downs.
- **Revenue & cost ingestion is a first-class Sense input**: ad network
  reports, affiliate exports, subscription MRR, plus the OS's own metered
  inference/API spend per run ([doc 06](06-operations.md)). Without this lane
  the loop optimizes proxies.
- **Provider detail is archived centrally, not re-exported by hand.** Daily
  GA4/GSC/BWT and weekly DataForSEO lanes preserve bounded provider responses
  in private R2 and index every attempt (plus metered cost) in the Postgres
  store. Live Tower aggregates remain separate; offline scripts flatten the
  immutable archive for page/query/rank/link/AI/funnel analysis. Assets still
  never query external analytics about themselves.
- **Outbound: PRs via the NoticeOS GitHub App**, plus **flag/canary controls
  and revert automation** — Act needs the ability to un-ship as cheaply as it
  ships ([doc 05](05-execution-and-accountability.md)).
- **Beads defines the work model; Dolt is the central task authority.** They
  are required NoticeOS infrastructure for all work it coordinates: its own
  operations, managed assets/projects, and work originating in external tools.
  People and agents use the same model for task status, ownership,
  dependencies, approval gates and completion evidence. Future Jira or Linear
  integrations map work into this model; they do not replace the internal task
  authority. The hub must remain available across NoticeOS application
  restarts; its hosting and current setup are described in
  [doc 06](06-operations.md) and the
  [task-hub configuration](../config/beads.README.md).
  Operators manage tasks through the NoticeOS UI. A supported NoticeOS API
  will expose the same work model and actions to tools. The application
  runtime owns the Beads engine and `bd`; Dolt owns persistence in its
  separately restarted service. Hosted users need neither a CLI installation
  nor direct database access. Direct CLI access is a contributor and
  agent-harness adapter, not the operator-facing product contract. Planned
  skills and hooks will connect the operator's chosen agent tools to the same
  hub, so agents can file, claim and hand off work across tools and sessions
  for any managed asset. Each task keeps its identity, current state,
  dependencies and evidence. The hub owns open-work state; Markdown holds
  designs and supporting evidence. Installable agent packages are not yet
  implemented.
  The hub sits **beside** the ledger. A task is a commitment; a pulse is an
  observation. Nothing in the hub enters the pulse envelope or signal contract
  ([doc 02](02-signal-contract.md)), and task completion is never evidence of a
  business outcome. The attribution layer must never read from the hub: a
  system that counts its intentions as results grades itself on effort.

## Access & security model

- Own GitHub org, private repo; blast-radius isolation from public-facing orgs.
- Cloudflare Access fronts the Tower; app-level auth beneath.
- One fine-grained **GitHub App** (`contents:write` + `pull_requests:write` on
  asset repos only), never PATs. The App key is the crown jewel; rotation and
  break-glass are specified in [doc 06](06-operations.md).
- **Never auto-touch:** auth, billing, security headers, DB migrations, consent
  surfaces, analytics/tracking pipelines, holdout assignments, guardrail
  thresholds. The last three are the measurement channel and non-negotiable:
  METR measured frontier agents gaming tasks at 25–100% rates when the harness
  allows it, and the reward-tampering literature is unambiguous that the
  *measurement channel* must live outside the optimizer's write scope. An
  agent that can edit the ruler will, eventually, edit the ruler.
  The [fresh-install exception](../AGENTS.md#hard-invariants)
  permits only `pnpm start` to apply the frozen Postgres schema and bootstrap
  one workspace for a provably new, empty installation in its own Compose
  project; existing installations and production remain operator-only.
- **A one-action kill switch exists and is drilled** ([doc 06](06-operations.md)).

## Heterogeneity is the design point

Assets do not share a stack, an auth model or a metric set, so **the contract
is capability-agnostic** ([doc 02](02-signal-contract.md)): assets declare what
they can observe and opt into metric families; storage (D1, Analytics Engine,
R2 counts) is an implementation detail. Stack uniformity remains a *cost
optimization* for the builder (shared patterns, one CI idiom) and a per-asset
onboarding note — never a load-bearing assumption.

## CI-green ≠ safe

The failures that threaten ROI — a page the crawler cannot read, a flagship
page at a fraction of a percent CTR for a quarter, a save flow that loses work —
ship through green CI. CI gates "does it build"; the failures that threaten
ROI are *outcome* failures. Hence Act ends with **post-ship outcome-watch and
auto-rollback** wired to the pulse and the served-layer guards — the safety net
is downstream of merge, not upstream
([doc 05](05-execution-and-accountability.md)).

## Compose vs build

| Concern | Compose | Build (the novel glue) |
|---|---|---|
| Dashboard/charts | Grafana or bespoke React | Tower portfolio views, calibration curves, ledger P&L |
| Pulse/central store | the ingest Worker + Postgres 18 (`db/postgres/`, `packages/postgres/`), R2 for raw archives | The **signal contract** |
| SEO/traffic data | GSC/GA4 APIs + private R2 archive, DataForSEO, Ahrefs MCP | Revision-aware collection, analysis scripts, attribution discipline + honest booking |
| Build → PR | Claude Code / coding agents | Orchestration: contract → build → **independent verify** → ship |
| Budget enforcement | **Cloudflare AI Gateway / LiteLLM-class proxy** (hard caps, fallback-to-cheaper) | Per-change cost attribution to the ledger |
| Ship safety | Feature flags, canary patterns, revert automation | The autonomy ladder + outcome-watch rules |
| Agent context | AGENTS.md convention, MCP | Context-pack freshness + the reliability ledger |

The moat is contract, context and orchestration, and the hard part includes
attribution, calibration and accountability.

## The OS is asset #0

NoticeOS emits the same pulse it demands: ingest freshness, cron success, spend
per stage, PR throughput, reliability-ledger stats, budget-cap events. A control
plane that watches everything except itself fails exactly like its assets do —
silently, for weeks. Spec in [doc 06](06-operations.md).
