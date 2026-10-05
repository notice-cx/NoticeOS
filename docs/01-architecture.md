# 01 — Architecture: a closed loop around a ledger

*v2 (2026-07-03). v1 described three layers — observability → advisory →
builder. That is a pipeline: it senses, proposes, and acts, but nothing it does
ever teaches it anything. The objective ([doc 00](00-objective-and-roi.md))
requires a **control loop**: the realized outcome of every action must flow back
into the policy that chose it. v1's strongest parts (the access model, the
push-to-central pulse, compose-vs-build discipline) survive below; its silent
assumptions (stack uniformity, CI-green = safe, "~80% off-the-shelf") do not.*

## The loop

### Product direction

NoticeOS is an **agentic operating system for a startup and its assets**. Its
value proposition combines health, traffic, revenue and expense monitoring with
projections, alerts, project/task management and a realtime TV view of the whole
business. Workflows are the visible execution layer joining those capabilities:
an operator can move from a signal to the work it triggered, inspect execution,
and return to the resulting business evidence.

This positioning was established on September 9, 2026 (`ro-42w8`). It extends
the closed-loop architecture below. The current single-operator local pilot
and the future agentic SaaS product must remain distinguishable in release
claims; [AGENTS.md](../AGENTS.md) carries dated implementation state.

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

## Data flow (kept from v1, amended)

- **Asset pulse, push-to-central.** Each asset's worker pushes its nightly pulse
  (server-observable metrics only) to the central store. Assets never query
  external analytics about themselves; NoticeOS pulls GSC/GA4/SEO/revenue
  centrally and joins on asset id. Service bindings for occasional drill-downs.
- **Revenue & cost ingestion is a first-class Sense input** (new in v2): ad
  network reports, affiliate exports, subscription MRR, plus the OS's own
  metered inference/API spend per run ([doc 06](06-operations.md)). Without
  this lane the loop optimizes proxies — v1's defining defect.
- **Provider detail is archived centrally, not re-exported by hand.** Daily
  GA4/GSC/BWT and weekly DataForSEO lanes preserve bounded provider responses
  in private R2 and index every attempt (plus metered cost) in D1. Live Tower
  aggregates remain separate; offline scripts flatten the immutable archive
  for page/query/rank/link/AI/funnel analysis. Assets still never query
  external analytics about themselves.
- **Outbound: PRs via the NoticeOS GitHub App** (unchanged), now plus
  **flag/canary controls and revert automation** — Act needs the ability to
  un-ship as cheaply as it ships ([doc 05](05-execution-and-accountability.md)).
- **Beads defines the work model; Dolt is the central task authority**
  (amended 2026-09-30, [D32](../config/decisions.md)). They are required
  NoticeOS infrastructure for all work it coordinates: its own operations,
  managed assets/projects, and work originating in external tools. People and
  agents use the same model for task status, ownership, dependencies, approval
  gates and completion evidence. Future Jira or Linear integrations map work
  into this model; they do not replace the internal task authority. The hub
  must remain available across NoticeOS application restarts; its hosting and
  current setup are described in [doc 06](06-operations.md) and the
  [task-hub configuration](../config/beads.README.md).
  Operators manage tasks through the NoticeOS UI. A supported NoticeOS API
  will expose the same work model and actions to tools (`ro-ujb9.260`). The
  application runtime owns the Beads engine and `bd`; Dolt owns persistence
  in its separately restarted service. Hosted users need neither a CLI
  installation nor direct database access. Direct CLI access is a contributor
  and agent-harness adapter, not the operator-facing product contract.
  Planned skills and hooks will connect the operator's chosen agent tools to
  the same hub, so agents can file, claim and hand off work across tools and
  sessions for any managed asset. Each task keeps its identity, current state,
  dependencies and evidence. The hub owns open-work state; Markdown holds
  designs and supporting evidence. Installable agent packages are not yet
  implemented (`ro-ujb9.255`).
  The hub sits **beside** the ledger. A task is a commitment; a pulse is an
  observation. Nothing in the hub enters the pulse envelope or signal contract
  ([doc 02](02-signal-contract.md)), and task completion is never evidence of a
  business outcome. The attribution layer must never read from the hub: a
  system that counts its intentions as results grades itself on effort.

## Access & security model (kept from v1 — still correct)

- Own GitHub org, private repo; blast-radius isolation from public-facing orgs.
- Cloudflare Access fronts the Tower; app-level auth beneath.
- One fine-grained **GitHub App** (`contents:write` + `pull_requests:write` on
  asset repos only), never PATs. The App key is the crown jewel; rotation and
  break-glass are specified in [doc 06](06-operations.md) (v1 named the risk
  and stopped there).
- **Never auto-touch:** auth, billing, security headers, DB migrations, consent
  surfaces, analytics/tracking pipelines, holdout assignments, guardrail
  thresholds. The last three are new and non-negotiable: METR measured frontier
  agents gaming tasks at 25–100% rates when the harness allows it, and the
  reward-tampering literature is unambiguous that the *measurement channel*
  must live outside the optimizer's write scope. An agent that can edit the
  ruler will, eventually, edit the ruler.
  The owner's [fresh-install exception](../AGENTS.md#hard-invariants-non-negotiable--from-doc-01)
  permits only `pnpm start` to apply the frozen Postgres schema and bootstrap
  one workspace for a provably new, empty installation in its own Compose
  project; existing installations and production remain operator-only.
- **A one-action kill switch exists and is drilled** ([doc 06](06-operations.md)).

## Heterogeneity is the design point (replaces v1's uniformity assumption)

v1: "All assets are the same stack… that uniformity is what makes one contract
cover the portfolio." This died at asset #2 (the second site: no D1, no auth, different
metric set). v2 inverts it: **the contract is capability-agnostic**
([doc 02](02-signal-contract.md)) — assets declare what they can observe and
opt into metric families; storage (D1, Analytics Engine, R2 counts) is an
implementation detail. Stack uniformity remains a *cost optimization* for the
builder (shared patterns, one CI idiom) and a per-asset onboarding note — never
a load-bearing assumption.

## CI-green ≠ safe (named, because v1 assumed the opposite)

Every motivating failure in this repo's own history shipped through green CI:
the 88-word crawler-invisible home page, a flagship page at 0.66% CTR for a
quarter, an item corpus at 0.09% CTR, the Save-flow scare. CI gates "does it
build"; the failures that threaten ROI are *outcome* failures. Hence Act ends
with **post-ship outcome-watch and auto-rollback** wired to the pulse and the
served-layer guards — the safety net is downstream of merge, not upstream
([doc 05](05-execution-and-accountability.md)).

## Compose vs build (updated)

| Concern | Compose | Build (the novel glue) |
|---|---|---|
| Dashboard/charts | Grafana or bespoke React | Tower portfolio views, calibration curves, ledger P&L |
| Pulse/central store | CF Workers + D1/KV/Analytics Engine | The **signal contract** |
| SEO/traffic data | GSC/GA4 APIs + private R2 archive, DataForSEO, Ahrefs MCP | Revision-aware collection, analysis scripts, attribution discipline + honest booking |
| Build → PR | Claude Code / coding agents | Orchestration: contract → build → **independent verify** → ship |
| Budget enforcement | **Cloudflare AI Gateway / LiteLLM-class proxy** (hard caps, fallback-to-cheaper) | Per-change cost attribution to the ledger |
| Ship safety | Feature flags, canary patterns, revert automation | The autonomy ladder + outcome-watch rules |
| Agent context | AGENTS.md convention, MCP | Context-pack freshness + the reliability ledger |

The moat is unchanged in kind — contract, context, orchestration — but v2 is
honest that the hard 20% now includes attribution, calibration, and
accountability, which v1 didn't list at all. (v1's "~80% off-the-shelf" figure
was underived comfort; struck.)

## The OS is asset #0

NoticeOS emits the same pulse it demands: ingest freshness, cron success, spend
per stage, PR throughput, reliability-ledger stats, budget-cap events. A control
plane that watches everything except itself fails exactly like its assets do —
silently, for weeks. Spec in [doc 06](06-operations.md).
