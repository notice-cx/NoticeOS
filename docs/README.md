# Design library

This folder is the documentation site. The guides, screens and operations
pages are for the person running NoticeOS; the numbered docs below are the
design library: why the product works the way it does. Build the site with
`pnpm --filter @noticeos/docs dev`. Start with [00](00-objective-and-roi.md)
(what the product is for) and [01](01-architecture.md) (how it is built).
`scripts/docs-index.test.mjs` fails when a numbered doc is missing here.

| Doc | What it covers |
|---|---|
| [00 — Objective & the ROI ledger](00-objective-and-roi.md) | What "better" means: ROI, the ledger, the booking rules, unit economics |
| [01 — Architecture](01-architecture.md) | The closed loop around the ledger, access and security, what passing CI does not show |
| [02 — Signal contract](02-signal-contract.md) | Reports, central signals, revenue and cost collection, volume-aware alerts, annotations |
| [03 — Attribution & evaluation](03-attribution.md) | Measurability tiers, cohort tests, holdouts, winner's-curse discipline |
| [04 — Decision policy & context](04-decision-policy.md) | The scoring function, allocation, Goodhart guards, context packs |
| [05 — Execution, autonomy & accountability](05-execution-and-accountability.md) | Evidence-based completion, the autonomy ladder, canary and revert, incidents |
| [06 — Operations & self-observability](06-operations.md) | How NoticeOS monitors itself, budget caps, the kill switch, secrets, vendor failure |
| [07 — Roadmap](07-roadmap.md) | Phases with numeric exit criteria and standing kill criteria |
| [08 — SEO/GEO signal reference](08-seo-geo-signals.md) | The search-signal families under the contract |
| [09 — Onboarding a site](09-onboarding-a-site.md) | What a new site's report counts, what its signal panel tracks, what a deploy could break |
| [10 — Control Tower UX](10-control-tower.md) | The Wall, the review queue, undo, phone mode |
| [11 — Integrations & economics](11-integrations.md) | Every data source: what it costs, its quotas, how it fails |
| [13 — Opportunity scouting](13-opportunity-scouting.md) | Finding new opportunities: scheduled scouting sweeps, news and trend intake, the playbook |
| [14 — Design](14-design.md) | The Tower's stack, tokens, principles, surfaces, the Wall, operator flows, lexicon and components |
| [16 — Replacing the chat workflow](16-replacing-the-chat-workflow.md) | Which parts of an operator's weekly work the Tower covers (File task, New task, the palette) and which are not built |
| [20 — Signal panels](20-signal-panels.md) | The read contract a site's own repository uses |
| [22 — Workflows](22-workflows-research-and-design.md) | Workflow operations, execution visibility, later LLM steps |
| [23 — Configuration ownership](23-configuration-ownership.md) | Where each setting lives, and what accounts would need |
| [24 — Integration monitoring](24-integration-monitoring.md) | How each data source's health is observed |
| [26 — Storage capacity](26-storage-capacity.md) | How big the store is, how fast it grows, and how that sizes the move to Postgres |

Doc numbers never change: a retired doc's number stays unused and the other
docs keep theirs. Git history contains the retired docs.

The Notice identity (logo, palette, type) is in [brand](brand.md).

## The design, in eight principles

1. **Measure success as ROI.** Optimize a signal (traffic, positions,
   engagement) only through a written causal path to a ledger family. Activity
   metrics, such as the number of changes shipped, never count as success.
2. **Improvement comes from calibration and scouting.** Calibration compares
   each change's predicted value with its realized value and adjusts the next
   estimates; opportunity scouting finds new opportunities and methods
   ([13](13-opportunity-scouting.md)).
3. **Grant autonomy per change class on evidence; revoke it automatically.** A
   change class is promoted when its numbers meet the criteria, and demoted
   after a single sev-1 incident or a single falsified claim.
4. **Verify every completion claim independently.** A task is complete only
   when re-executed checks pass and each claim points to an artifact; the
   builder, the verifier and the scorer are three different parties
   ([05](05-execution-and-accountability.md)).
5. **Constrain the optimizer instead of refining the proxy metric.** A metric
   that agents optimize directly stops tracking the goal (Goodhart's law), so
   hard invariants, guarded metric bundles and holdouts are kept outside what
   agents can change.
6. **Fail closed on money and access.** Budget caps stop spending at runtime
   instead of only raising an alert, and one rehearsed action stops the whole
   system.
7. **Keep agent context in each repository.** Each repository contains its own
   `AGENTS.md`, with freshness enforcement.
8. **Turn recurring work into deterministic tools.** When a task recurs, a
   capable model writes a deterministic tool for it, and cheaper models run
   that tool from then on ([05](05-execution-and-accountability.md)).

The dated repository state is in [`AGENTS.md`](../AGENTS.md) § STATE; what
is hosted, demoed or standalone is in the [release policy](reference/release-policy.md).
