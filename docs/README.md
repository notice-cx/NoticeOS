# Design library

This folder is the documentation site. The guides, screens and operations
pages are for the person running NoticeOS; the numbered docs below are the
design library: why the product works the way it does. Build the site with
`pnpm --filter @noticeos/docs dev`. Start with [00](00-objective-and-roi.md)
(what the product is for) and [01](01-architecture.md) (how it is built).
`scripts/docs-index.test.mjs` fails when a numbered doc is missing here.

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
| [13 — Opportunity scouting](13-opportunity-scouting.md) | The outer loop: scout lanes, the news radar, the playbook |
| [14 — Design](14-design.md) | The Tower's stack, tokens, principles, surfaces, the Wall, operator flows, lexicon and components |
| [16 — Replacing the chat workflow](16-replacing-the-chat-workflow.md) | Which parts of an operator's week the Tower carries (File task, New task, the palette) and which are not built |
| [20 — Signal panels](20-signal-panels.md) | The read contract a site's own repository uses |
| [22 — Workflows](22-workflows-research-and-design.md) | Workflow operations, execution visibility, later LLM steps |
| [23 — Configuration ownership](23-configuration-ownership.md) | Where each setting lives, and what accounts would need |
| [24 — Integration monitoring](24-integration-monitoring.md) | How each data source's health is observed |
| [26 — Storage capacity](26-storage-capacity.md) | How big the store is, how fast it grows, and how that sizes the move to Postgres |

Numbers are stable, so a retired doc leaves a gap rather than renumbering the
rest; git history holds what a gap used to say.

The Notice identity (logo, palette, type) is in [brand](brand.md).

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

The dated repository state is in [`AGENTS.md`](../AGENTS.md) § STATE; what
is hosted, demoed or standalone is in the [release policy](reference/release-policy.md).
