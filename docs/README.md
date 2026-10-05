# Docs

Start with [00](00-objective-and-roi.md) (what the product is for) and
[01](01-architecture.md) (how it is built). Every numbered doc is listed here;
`scripts/docs-index.test.mjs` fails when one is missing.

| Doc | What it answers |
|---|---|
| [00 — Objective & the ROI ledger](00-objective-and-roi.md) | What "better" means: ROI, the ledger, booking honesty, unit economics |
| [01 — Architecture](01-architecture.md) | The closed loop around the ledger, access and security, why CI-green is not safe |
| [02 — Signal contract](02-signal-contract.md) | Reports, central signals, revenue and cost lanes, volume-aware alerts, annotations |
| [03 — Attribution & evaluation](03-attribution.md) | Measurability tiers, cohort tests, holdouts, winner's-curse discipline |
| [04 — Decision policy & context](04-decision-policy.md) | The scoring function, allocation, Goodhart guards, context packs |
| [05 — Execution, autonomy & accountability](05-execution-and-accountability.md) | Evidence-based completion, the autonomy ladder, canary and revert, incidents |
| [06 — Operations & self-observability](06-operations.md) | The OS watching itself, budget caps, the kill switch, secrets, vendor failure |
| [07 — Roadmap](07-roadmap.md) | Phases with numeric exits and standing kill criteria |
| [08 — SEO/GEO signal reference](08-seo-geo-signals.md) | The search-signal families under the contract |
| [09 — Onboarding a site](09-onboarding-a-site.md) | What a new site's report counts, what its panel watches, what a deploy could break |
| [10 — Control Tower UX](10-control-tower.md) | The Wall, the review queue, undo, phone mode |
| [11 — Integrations & economics](11-integrations.md) | Every data source: what it costs, its quotas, how it fails |
| [12 — Implementation readiness](12-implementation-readiness.md) | The first sites scouted, build blocks, the first decision list |
| [13 — Opportunity scouting](13-opportunity-scouting.md) | The outer loop: scout lanes, the news radar, the playbook |
| [14 — UI implementation standards](14-ui-standards.md) | The Tower's stack, tokens, component discipline, charts |
| [15 — Operator flows](15-operator-flows.md) | Every journey end to end, and the polish principles |
| [16 — Replacing the chat workflow](16-replacing-the-chat-workflow.md) | Ask, investigations, commissions, idea capture |
| [17 — UI lexicon](17-ui-lexicon.md) | System term → the word a person reads |
| [18 — Agent orchestration playbook](18-agent-orchestration-playbook.md) | Bounded, evidence-bearing agent work (later phase) |
| [19 — Architecture, implementation & UX audit](19-architecture-implementation-ux-audit.md) | Verified current state, integrity risks, replacements |
| [20 — Signal panels](20-signal-panels.md) | The read contract a site's own repository uses |
| [21 — Surface design](21-surface-design.md) | How a desk page is composed, and its acceptance list |
| [22 — Workflows](22-workflows-research-and-design.md) | Workflow operations, execution visibility, later LLM steps |
| [23 — Configuration ownership](23-configuration-ownership.md) | Where each setting lives, and what accounts would need |
| [24 — Integration monitoring](24-integration-monitoring.md) | How each data source's health is observed |
| [25 — The Wall](25-the-wall.md) | The TV view: business first, with a live feed |
| [26 — Storage capacity](26-storage-capacity.md) | How big the store is, how fast it grows, and how that sizes the move to Postgres |

| Folder or file | What it holds |
|---|---|
| `artifacts/` (excluded from public source) | Historical captures and verification evidence referenced by dated documents |
| [`brand/`](brand/README.md) | The Notice identity: logo, palette, type |
| [`briefs/`](briefs/) | The brief and prior art behind a redesign |
| [`playbooks/`](playbooks/README.md) | Repeatable methods |
| `reports/` (excluded from public source) | Historical audits referenced by dated documents |
| [`runbooks/`](runbooks/) | Step-by-step operations |
| [`freeze-register.md`](freeze-register.md) | Surfaces inside a measurement window |

## The design, in eight principles

1. **ROI or it didn't happen.** Signals (traffic, positions, engagement) may be
   optimized only via a written causal path to a ledger family. Activity
   metrics (changes shipped) are never success metrics.
2. **Learning is the engine; improvement is the exhaust.** An inner loop
   (predicted-vs-realized calibration) and an outer loop (opportunity scouting
   and method acquisition, [13](13-opportunity-scouting.md)).
3. **Autonomy is earned per change class, revoked automatically.** Promotion by
   numbers, demotion by a single sev-1 or falsified claim.
4. **Trust nothing self-reported.** Completion is proven by re-executed checks
   and artifact-backed claims; builder ≠ verifier ≠ scorer
   ([05](05-execution-and-accountability.md)).
5. **Constrain the optimizer, don't tune the proxy.** Hard invariants, guarded
   metric bundles and holdouts stay outside the agents' reach.
6. **Fail closed on money and access.** Budget caps are runtime enforcement,
   not alerts; one rehearsed action kills the whole system.
7. **Context travels with the code.** Each repository carries its own
   `AGENTS.md`, with freshness enforcement.
8. **Crystallize intelligence into tools.** Anything recurring becomes a
   deterministic tool that cheaper models operate
   ([05](05-execution-and-accountability.md)).

Current scope is a single-operator local pilot; the dated state is in
[`AGENTS.md`](../AGENTS.md) and [19](19-architecture-implementation-ux-audit.md).
