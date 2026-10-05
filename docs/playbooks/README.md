# Playbooks — the method library

*The concrete form of [doc 13](../13-opportunity-scouting.md)'s playbook: "a
versioned library of **how** — proven methods with their evidence, cost
profiles, and applicability conditions… where continuous learning accumulates
as capital instead of evaporating at session end."*

## What a playbook is

**One method, versioned, citable.** A file here answers a single recurring
question ("how do we decide whether to enter a market?", "when do we stop
paying for a channel?") with steps a stranger can execute and decision rules
that resolve without judgment calls. It is not a strategy, not a target list,
and not a record of what one asset did.

Three properties are load-bearing:

- **Portfolio-generic.** The method transfers to any asset. Numbers that were
  true of one property live in *Origin evidence* or a calibration line, never
  in the decision rules. A rule reads `if the AI Overview owns the query, do
  not spend copy budget on it`, not `if it is /food-groups`.
- **Executable.** Decision rules are if-X-then-Y lines. A method whose rules
  can only be applied by someone who was in the room is not finished.
- **Cited, not retold.** An insight rule, a hypothesis card, a session, or a
  decision record names the playbook id instead of re-deriving the method.
  Re-derivation is the cost this library exists to remove.

A playbook's mature form is a **tool** — the crystallization rule in
[doc 05](../05-execution-and-accountability.md): method → documented playbook
entry → deterministic script a cheap model operates. Several entries here are
already partly crystallized into `scripts/signal-insights.mjs` rules; each
names which.

## Frontmatter contract

Every file opens with exactly these four fields:

```yaml
---
id: impression-harvest            # stable slug; equals the filename
version: 1                        # any substantive edit increments
origin: "example.com docs/impression-harvest-2026-07.md (2026)"
status: active                    # active | superseded | retired
---
```

- **`id`** is what everything else cites. It never changes; a method that
  changes enough to need a new id is a new playbook, and the old one goes
  `superseded` with a pointer.
- **`version`** increments on any edit that could change a decision. Anything
  that *followed* a playbook pins the version it followed
  (`impression-harvest@v1`) so a later reading knows which rules were in force.
- **`origin`** is provenance, not authority: the session and document the
  method was distilled from. A method with no origin is a proposal, not a
  playbook.
- **`status`**: `active` (use it), `superseded` (a newer id replaces it — say
  which), `retired` (measured and abandoned; the file stays, because a
  documented dead end is method capital — see
  [dead-ends-register](dead-ends-register.md)).

## Body contract

Required sections, in this order. Omit one only when it genuinely does not
apply, and say so.

| Section | Holds |
|---|---|
| **Use when** | The trigger. A reader should be able to tell in one line whether this is their situation. |
| **Preconditions** | Data, access, or assets the method needs. If a precondition is absent the method does not run — it is not run on worse inputs. |
| **Method** | Numbered steps, each one verb. |
| **Decision rules** | If-X-then-Y lines. The executable core. |
| **Proof and abandonment** | What counts as the method having worked, on what clock, and the threshold at which you stop. |
| **Calibration** | Which numbers are property-specific, and what the origin used. |
| **Origin evidence** | What actually happened, dated. Negative results included. |
| **Related** | Other playbook ids this composes with. |

**Cost** is its own line wherever the origin metered it — a method with a known
price is budgetable ([doc 13](../13-opportunity-scouting.md): scouting bills
itself).

## Index

| Playbook | Method | Origin |
|---|---|---|
| [impression-harvest](impression-harvest.md) | Convert already-earned impressions into clicks before building new inventory; diagnose the real query before touching copy | impression-harvest-2026-07 |
| [triangulate-before-acting](triangulate-before-acting.md) | Confirm a read in a second and third independent source before it becomes a build decision | growth-patterns |
| [serp-authority-gate](serp-authority-gate.md) | Decide rank-versus-cite from who holds the SERP; institution-locked results are a citation play, not a ranking one | market docs + growth-patterns |
| [market-go-no-go](market-go-no-go.md) | Whether to enter a market: demand filter, authority gate, revenue-per-visit economics, licensing cleanroom | market-india, seo-germany-dach, seo-korea |
| [serp-snippet-standard](serp-snippet-standard.md) | Write a title and description that kill the searcher's five hesitations, against the live SERP | editorial-copy skill |
| [serp-opportunity-execution](serp-opportunity-execution.md) | Execute a ranking/striking-distance card end to end: re-derive, pull the live SERP, gate on authority, ship the smallest correct action or a documented no-action | one site's audit + DRI/home session (2026-07-31) |
| [kill-thresholds](kill-thresholds.md) | Quantitative stop rules stated before spending, so retiring is arithmetic rather than argument | strategy-next-level, press/journalist playbooks |
| [freeze-register](freeze-register.md) | Surfaces inside a measurement window are immutable to refactors and aesthetics | agent-orchestration |
| [utm-taxonomy](utm-taxonomy.md) | Campaign-link grammar that keeps sends separable and out of Unassigned | utm-taxonomy |
| [reclamation-pipeline](reclamation-pipeline.md) | Turn a dead resource's inbound links into earned authority: score, verify, pitch, log | reclamation-targets, reclamation-roi-biglist |
| [release-cohort-attribution](release-cohort-attribution.md) | Ship in registered cohorts so a search-facing change can be read at all | strategy-next-level |
| [dead-ends-register](dead-ends-register.md) | Record measured-and-abandoned techniques so nobody buys them twice | seo-geo-plan-2026 |
| [task-key-chain](task-key-chain.md) | Carry one key from the finding through the filed task, the commit, the annotation, and the watch window, so "did that work?" has an answer | Tower handoffs + the beads task hub (2026-08) |

## What does not belong here

- **Asset facts and target lists.** A scored list of outreach domains is data;
  the scoring formula is the playbook.
- **Strategy verdicts.** "Focus on X this quarter" expires. The method that
  produced the verdict does not.
- **Anything unmeasured.** A technique someone likes is a hypothesis card
  ([doc 13](../13-opportunity-scouting.md)), not method capital. It earns a
  playbook after it has been run and its outcome graded — including when the
  outcome was zero.
