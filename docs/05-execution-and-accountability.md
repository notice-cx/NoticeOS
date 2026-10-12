# 05 — Execution, autonomy & accountability

*The rule "agents open PRs, humans merge them" is safe, but it routes every
change through the single operator, who is the bottleneck the system exists to
remove. Agents also do not report their own work accurately by default. So
autonomy is a per-class setting raised only on evidence, and completion is
proven by checks, not accepted from an agent's report.*

## Accountability: evidence-based completion

The threat model is not malice; it is the measured default behaviour: agents
cut corners, drop scope without saying so, and confidently report work they
did not do (frontier agents game gameable tasks at 25–100% rates). An agent
that never reports can still have shipped excellent code, and a polished
report can describe work that was never done. **Whether an agent reports and
how good its work is are independent**, so all work is verified: a missing
report does not mean bad work, and a confident report does not mean good
work.

1. **Task contracts.** Every dispatched task lists its deliverables and
   acceptance checks. Completion is evaluated as a diff of
   delivered-vs-contracted; omissions are computed, not recalled from memory,
   and each becomes a named delta ticket.
2. **Every claim points to an artifact.** A completion report is a claim set;
   every claim carries a machine-checkable pointer (commit hash, gate command,
   artifact path, URL). **Prose-only completion is rejected at intake** — "I
   did X" without a pointer is not accepted. A false claim is not punished; it
   has no effect, because a claim without a valid pointer counts for nothing.
   Screenshots as review artifacts are not built
   ([doc 16](16-replacing-the-chat-workflow.md#what-is-not-built)).
3. **Independent, change-scoped verification.** The verifier selects checks
   for changed logic and affected critical paths; a builder's own passing
   transcript is not accepted as evidence. One focused independent run
   supplies completion evidence. Reuse passing evidence when its tested code, tests, shared
   dependencies/configuration and runtime inputs are unchanged. After relevant
   changes or failures, rerun affected checks; broaden only for a concrete
   unresolved risk. Full repository gates run in CI rather than being repeated
   locally by default. Local verification
   targets at least 80% less execution time and CPU work than a full pass;
   record actual command time and never omit a critical check for the budget.
   The selection and compact evidence contract is in
   [CONTRIBUTING.md](../CONTRIBUTING.md#local-verification). Verification cost
   remains part of each change's fully-loaded cost.
4. **Separation of duties.** The builder, the verifier and the scorer are
   three different parties. The verifier is adversarial by construction,
   prefers mechanical checks (exit codes, greps, byte-diffs) over judgment, is
   never the model instance that authored the change, and — for rubric
   judgments — is periodically calibrated against operator-labeled anchors and
   stress-tested before its judgments are relied on.
5. **The reliability ledger.** Every falsified claim (caught by verifier,
   audit, or production) decrements a per-agent-class × per-change-class
   reliability score; every verified completion increments it. This score
   **directly controls promotion on the autonomy ladder** below. An accurate "I
   didn't finish X" costs nothing; a false "done" causes the fastest possible
   demotion. The scoring rewards accurate reports.
6. **Every deferral is recorded.** "Done" means the post-ship watch found no
   regression and the attribution entry exists, not that a PR was opened.
   Anything deferred must be filed as a task with an owner and a trigger; the
   Tower lists deferrals that have no owner as open debt. Work may be left
   undone on purpose, but that decision must always be recorded. The list of
   open work is the task database — `bd create` in the repo the work belongs
   to, `bd ready` to read it
   ([AGENTS.md § Open work lives in the task hub](../AGENTS.md#open-work-lives-in-the-task-hub)).
   A deferral written into a doc instead of a task is an unrecorded deferral.
7. **Random deep audits.** A sampled fraction of completions that passed
   verification gets full re-verification each cycle. Any discrepancy is an incident; every incident
   postmortem results in a rule in a context pack or a check in the verifier,
   so the fix covers the whole class of failure, not only the one case.

**Verifier verdicts (canonical enum) and dispositions:**

- `rejected-at-intake` — prose-only claims / missing pointers. The work is
  not examined; the task is returned to the queue for a re-dispatch decision.
- `verified` — all contracted deliverables present, all gates re-pass, all
  pointers resolve. The reliability score increases; the change proceeds per
  the asset×class tier.
- `verified-with-omissions` — a delivered subset; each gap becomes a named
  delta ticket in the task database (owner + trigger). A reported omission
  costs nothing.
- `falsified` — a claim contradicted by re-execution. The work is discarded
  (branch preserved for forensics, never retried without a record); a delta
  ticket puts the task back in the queue; the reliability score decreases per
  item 5. **Flake guard:** a gate result that contradicts a claim becomes
  `falsified` only after a second fresh re-execution gives the same result —
  a single flaky run is re-run, not penalised. The operator can reverse a
  reliability decrement afterwards with an annotation (a wrong falsification
  must be correctable).
  A pre-merge falsification is a **reliability event, not an incident**
  (incidents are for shipped harm) — but a second falsification from the
  same agent-class within 30 days is escalated to the operator digest.

## The autonomy ladder

Autonomy is a finite-state setting per **(asset × change-class)**, never one
global level. Promotion requires numeric evidence *and* recorded operator
authorization; demotion is automatic.

**Change classes — the canonical enum** (class-keyed tables, priors, and
this ladder all use exactly these five strings; docs 00 and 10 match):
`content-data` (structured data, tables, i18n values, titles/meta) ·
`copy` (editorial prose, headlines, microcopy — split from content-data
because its risk profile is brand/i18n, not mechanical correctness) ·
`template` (shared components, layout) · `feature` (new behavior) ·
`infra` (build, worker, config). `forbidden` (auth, billing, consent,
analytics, migrations, holdouts) is a **designation, not a ladder class** —
operator-only, forever, never promotable.

**Tiers**
- **T0 — propose.** Hypothesis cards only.
- **T1 — build.** Agent builds; verifier verifies; a PR is opened; operator
  merges.
- **T2 — auto-merge + outcome-watch.** Verified changes with passing checks
  merge and deploy without review; a per-class watch window (asset reports + served-layer
  guards + guarded bundles) auto-reverts on regression. The operator sees a
  digest, not a queue.
- **T3 — closed-loop.** Changes in the class go through Sense→…→Learn without
  per-change human review; the operator controls them through policy, budget,
  and the calibration report.

**Starting tiers:** a newly onboarded asset stays at T0 while its baseline is
collected, with one exemption: **onboarding runbooks** that the operator starts
(report endpoint, AGENTS.md) run at T1, because the operator merges those PRs
anyway. After baselining, every allowed (asset × class) starts at
**T1** — T0→T1 requires no evidence because at T1 the operator merges each
PR; evidence is required from T1→T2 onwards.

**Promotion criteria (defaults; tuned in config, never by impression):**
T1→T2: ≥20 consecutive verified merges in class, ≥90% accepted without
substantive rework, 0 incidents ≥ sev-2 attributable to the class in 8 weeks,
reliability score above threshold, class ledger-positive. T2→T3: ≥12 weeks at
T2, auto-revert exercised and proven, calibration error for the class within
bounds.

**Demotion — three triggers, three deliberately different scopes** (the
setting is per asset × class; the less certain the extent of the damage, the
wider the demotion):
- any **sev-1** → that change-class drops to T1 **portfolio-wide** pending
  postmortem (a shipped harm's cause may not be asset-local);
- any **falsified claim** → decrements the **agent-class** reliability score
  (see below) — which can bar that agent-class from dispatch — AND drops the
  (asset × class) where it happened to T1 if it was at a higher tier;
- **guarded-bundle divergence** → **freeze** on that (asset × class); the
  postmortem may widen it. Freeze is an extra state *on top of* the tier (any
  tier + `frozen`), lifted only when the postmortem is complete.

**Demotion resets the promotion counters** — streaks restart from zero; no
credit from before the demotion is kept.

**Agent-class, defined:** a (model × harness/prompt version) identity, e.g.
`opus-4.8/builder-v1` — the unit the reliability ledger scores. It is a
different axis from the (asset × change-class) tier: the tier sets how much
automation a class of change is allowed; the reliability score determines
which agent identities may be dispatched to do it.

The review SLA is the operator's side of the contract: T1 PRs are batched
into a weekly review block; the Tower tracks retained-improvement-per-review-
minute, the number this ladder is meant to improve.

## Ship safety: canary, watch, revert

- **Every T2+ change ships as an experiment**: cohort-scoped where the surface
  allows (page-cohort = canary + attribution in one), watch window sized to the
  class (fast metrics: 24–72h; SEO-facing: through first recrawl), auto-revert
  wired to the same guards the verifier checked — passing CI is explicitly not
  what makes a change safe ([doc 01](01-architecture.md)).
- **Revert is a standard, supported operation**: one commit, no custom manual repair —
  which constrains how the builder structures changes (small, revertible,
  flag-gated where cheap). The same mechanism runs the **operator's one-click
  Undo** in the Tower registry ([doc 10](10-control-tower.md)): confirmation +
  reason → revert → timeline annotation → ledger close-out → a strong negative
  Learn label. When later changes build on it and a clean revert is no longer
  possible, the registry shows that and offers revert-via-new-change; the UI
  never shows an undo as cleaner than it is.
- **Incident model.** Sev-1: user-facing breakage, compliance/consent
  regression, a change that switches revenue off (such as ads.txt removed),
  suspected tampering with a guard. Sev-2: outcome regression caught by the
  outcome watch. Sev-3: quality debt. Runbook: freeze class → revert →
  annotate timeline → postmortem → rule. Phase exits in
  [doc 07](07-roadmap.md) count sev-1/2 explicitly, so "no prod incidents" is
  a defined, countable claim.

### The task key chain

One key stays the same from the finding that created the work to the verdict that closes it; without it, a shipped change and the observation that led to it are two unrelated events in two stores. The key is the finding's own stable key — a query decision's normalized query, a finding card's `ExecutiveInsight.key`.

1. **The Tower writes the key into the handoff.** The copied Markdown ends in a ready-to-run `bd create` labelled `noticeos-handoff`, `asset:<id>`, `rule:<id>`, `key:<slug>`, with `noticeos_key`, `noticeos_rule`, `noticeos_asset` and `noticeos_kind` in `--metadata` verbatim. Only the metadata is byte-exact: `bd` splits label values on commas.
2. **The agent files the task in the asset's own repo.** The prefix comes from the repo `bd` runs in, never from the handoff. The runner's once-a-minute task snapshot copies the task's state back onto the finding card (`HandoffBeadBadge`, `packages/contract/src/task-snapshot.mts`).
3. **Every commit includes the task id.**
4. **The task closes with the decision and its evidence** — a commit for shipped work, the basis for a decline. Closure records a decision, never a measured outcome.
5. **Each ship records a timeline annotation** (`annotations.kind = 'deploy'`) whose `ref` is the same task id, so Attribution ([doc 03](03-attribution.md)) can link the change to its cause.
6. **The watch window opens against the same ref**, sized to the change class.
7. **The window's verdict closes the finding**, whether the change is kept or reverted.

Work without a task is untracked, whatever the diff contains. A task without the rule id and key is not linked to its finding. A task id that is in a commit but on no annotation gives Attribution nothing to link. Never fake a link: an annotation for a ship that never happened, or a verdict read off a chart instead of a window, replaces an unknown result with a false one. Nothing auto-reverts. Renaming `noticeos-handoff` or the `noticeos_*` fields breaks every existing join; readers also accept the older `reindex_*` names (`packages/contract/src/task-metadata.mts`).

## Model tiering: turn recurring work into tools

Model selection is a policy, not a per-task choice, and it follows one
rule: **the most capable models get the hardest problems, and for a recurring
problem their main output is a tool, not an answer.**

- **The tiers.** Frontier models: architecture and design, scoring-policy
  revisions, incident postmortems, high-stakes scout investigations,
  decisions with money at stake — and **tool authorship**. Mid-tier
  models: routine builds inside established patterns, verification runs,
  scouting investigations. Cheap/local models: skimming news and trends,
  classification against rubrics, and **interpreting the outputs of tools the
  frontier models wrote** — work that requires reading, not reasoning.
- **The tool rule.** Any task a model has performed repeatedly
  (default: 3×) is a candidate for a tool: the most capable model writes
  a deterministic script with a declared contract — inputs, outputs, and
  **escalation conditions** — and from then on the task costs a cron or a
  cheap-model invocation, not frontier reasoning. This gives three benefits:
  lower cost (order-of-magnitude per-token spreads between tiers),
  **reproducibility** (a deterministic core plus narrow interpretation is more
  reliable than re-deriving the analysis every run, and its behaviour does not
  change when a model version does, which protects both attribution and the
  reliability ledger), and auditability (tool outputs are exactly the
  machine-checkable evidence artifacts the accountability protocol requires).
- **Escalate instead of guessing.** A cheap model that gets an output outside
  the tool's contract passes it to a higher tier; every tool contract states
  this. Guessing past an ambiguous output is an accountability violation;
  escalation has no penalty.
- **The tool registry.** Tools are versioned in the OS repo with their
  contracts; the playbook ([doc 13](13-opportunity-scouting.md)) links to
  them, and a proven method ends up as a tool. The registry is how marginal
  cost falls over time: every quarter, more of the loop should run on tools +
  cheap interpretation, and the frontier budget should go increasingly to
  genuinely new problems. That ratio (frontier spend : tool-executed work) is a
  Tower metric; as it falls, the system's cost per unit of work falls with
  it.

## Runbooks: execution as reviewed procedure

This is how the tiering rule is applied in operation. An expensive model must
**never re-derive process mechanics** — how to call an API, where data lives, what
order steps go in. That knowledge is encoded once, as a **runbook**: a
versioned, descriptive procedure whose steps invoke tools from the registry,
with each step's model involvement declared up front:

```yaml
# Normative manifest fields — a builder implements exactly these:
id: serp-panel-weekly          # stable slug
version: 3                     # any edit increments; grants bind to (id, version)
change_class: content-data     # the canonical enum (ladder section above)
assets: [all]                  # or an explicit asset list
schedule: "0 6 * * 1"          # cron; absent → on-demand only
steps:                         # ordered; each step is exactly one verb
  - run: tools/serp-panel.mjs --all-assets --both-devices
    model: none                # none | cheap | mid | frontier — a FIELD, not a comment
  - run: tools/panel-diff.mjs --vs-4wk-median
    model: none
  - interpret: flag position drops per rubric R-12   # rubrics live in the rubric registry
    model: cheap
  - escalate-if: new domain at #1 on any money query
    model: frontier
    emits: flag                # what escalation produces: flag | card | operator-ping
permissions:                   # uniform grant grammar: <capability>:<scope>[:<limit>]
  - store:write
  - spend:dataforseo:$0.50
```

Approval state (who approved which version, when) is stored **in the Tower**
in the grants table — never in the file, or a builder could self-approve. A
rendered "approved v3 by operator" line in the library view is a display of that
record. **Repeated failures suspend a runbook**: 3 consecutive failed runs
auto-suspend a runbook's grants (the same suspended state as a manifest
deviation) pending operator review. Any *edit* removes the approval; a failure
streak suspends it only until the operator has reviewed the runbook.

- **Terminology, fixed:** a *tool* is a script (deterministic, contracted);
  a *runbook* is an executable procedure composing tools (this section); the
  *playbook* ([doc 13](13-opportunity-scouting.md)) is method knowledge —
  proven playbook entries become tools and runbooks.
- **Frontier models author and revise runbooks; they don't perform them.**
  Performing a runbook is cron + cheap-interpretation work. Frontier time is
  reserved for the `escalate-if` branches, new problems, and the next runbook.

### Permissions attach to runbooks, not to models

This permission model lets the operator review exactly what an autonomous run
may do:

- The operator **reviews a runbook like code** — steps, tools, rubrics,
  escalation branches, and its permission manifest (`git push`, merge, deploy,
  spend ceilings). Approval is per **runbook version**; any edit resets it to
  unapproved. Approval goes to a documented process the operator has
  actually read, never to steps a model improvises, however capable the model.
- **Capability grants are scoped to the manifest.** A runbook approved with
  `push:asset-x` can push to asset X when its steps and gates pass; an agent
  outside an approved runbook has no push path at all. The autonomy ladder's
  tiers thereby become concrete: **T2 for a change class = an approved
  runbook exists for that class and its watch/revert gates are proven** —
  promotion is based on a review of the runbook + its track record, not an
  impression of "the agent."
- Runbook runs are fully logged (steps, tool outputs, interpretations,
  escalations) — the evidence chain in the Tower registry, and the data the
  reliability ledger and random audits read.
- The Tower has a **runbook library**: versions, diffs since last
  approval, per-runbook track record, one-click approve/revoke
  ([doc 10](10-control-tower.md)).

## Cost discipline at the execution layer

Per-run and per-change budgets are **fail-closed runtime caps, on by default**
(documented agent cost overruns came from a limit that existed but was off by
default):
per-run USD + step caps, spend-velocity breaker, identical-call dedup,
recursion-depth caps, retry budgets at one layer, and an out-of-band kill that
cancels provider-side runs. Enforcement happens at the gateway
([doc 06](06-operations.md)); the ledger records cost-per-landed-change, and
Decide rejects work whose predicted cost exceeds its predicted value.
