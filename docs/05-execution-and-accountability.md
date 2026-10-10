# 05 — Execution, autonomy & accountability

*"PRs are the output, humans merge" is safe, and routes every change through
the single operator, which is the bottleneck the system exists to remove; and
agents do not report their own work truthfully by default. So autonomy is a
per-class dial opened by evidence, and completion is something the system
proves, not something an agent claims.*

## Accountability: evidence-based completion (the trust substrate)

The threat model is not malice — it's the measured default: agents cut corners,
silently drop scope, and confidently report work they didn't do (frontier
agents game gameable tasks at 25–100% rates). An agent that never reports can
still have shipped excellent code, and a polished report can cover work that
was never done. **Report compliance and work quality are independent axes**,
so verification is unconditional in both directions: silence doesn't imply
bad work, and a confident report doesn't imply good work.

1. **Task contracts.** Every dispatch enumerates deliverables and acceptance
   checks. Completion is evaluated as a diff of delivered-vs-contracted;
   omissions are computed, not remembered, and become named delta tickets.
2. **Claims are artifacts.** A completion report is a claim set; every claim
   carries a machine-checkable pointer (commit hash, gate command, artifact
   path, URL). **Prose-only completion is rejected at intake** — "I did X"
   without a pointer doesn't parse. Gaslighting isn't punished; it's
   structurally worthless. For changes touching a user-facing surface,
   before/after screenshots (desktop + mobile) are mandatory claim
   artifacts, rendered in review ([doc 16](16-replacing-the-chat-workflow.md)
   § P).
3. **Independent, change-scoped verification.** The verifier selects checks
   for changed logic and affected critical paths; a builder's own passing
   transcript is inadmissible. One focused independent run supplies completion
   evidence. Reuse passing evidence when its tested code, tests, shared
   dependencies/configuration and runtime inputs are unchanged. After relevant
   changes or failures, rerun affected checks; broaden only for a concrete
   unresolved risk. Full repository gates run in CI rather than being repeated
   locally by default. Local verification
   targets at least 80% less execution time and CPU work than a full pass;
   record actual command time and never omit a critical check for the budget.
   The selection and compact evidence contract is in
   [CONTRIBUTING.md](../CONTRIBUTING.md#local-verification). Verification cost
   remains part of each change's fully-loaded cost.
4. **Separation of duties.** Builder ≠ verifier ≠ scorer. The verifier is
   adversarial by construction, prefers mechanical checks (exit codes, greps,
   byte-diffs) over judgment, is never the model instance that authored the
   change, and — for rubric judgments — is periodically calibrated against
   operator-labeled anchors and stress-tested before being load-bearing.
5. **The reliability ledger.** Every falsified claim (caught by verifier,
   audit, or production) decrements a per-agent-class × per-change-class trust
   score; every verified completion increments it. This score **directly gates
   the autonomy ladder** below. An honest "I didn't finish X" costs nothing;
   a confabulated "done" is the fastest possible demotion. The incentive
   gradient points at honesty.
6. **No silent deferral.** "Done" means post-ship watch is clean and the
   attribution entry exists — not "PR opened." Anything deferred must be parked
   in the WIP registry with an owner and a trigger; the Tower surfaces orphaned
   deferrals as first-class debt. The system may decide not to do something; it
   may not decide not to *mention* it. The **WIP registry** is the task hub —
   `bd create` in the owning repo, `bd ready` to read it
   ([AGENTS.md § Open work lives in the task hub](../AGENTS.md#open-work-lives-in-the-task-hub)).
   A deferral written into a doc instead of a task is a silent deferral.
7. **Random deep audits.** A sampled fraction of "green" completions gets full
   re-verification each cycle. Any discrepancy is an incident; every incident
   postmortem ends as a rule in a context pack or a check in the verifier —
   the failure class, not the instance, gets fixed.

**Verifier verdicts (canonical enum) and dispositions:**

- `rejected-at-intake` — prose-only claims / missing pointers. The work is
  not examined; the dispatch returns to the queue for a re-dispatch decision.
- `verified` — all contracted deliverables present, all gates re-pass, all
  pointers resolve. Reliability increments; proceeds per the asset×class tier.
- `verified-with-omissions` — a delivered subset; each gap becomes a named
  delta ticket in the WIP registry (owner + trigger). Honest omission costs
  nothing.
- `falsified` — a claim contradicted by re-execution. The work is discarded
  (branch preserved for forensics, never silently retried); a delta ticket
  carries the task back to the queue; reliability decrements per §5.
  **Flake guard:** a gate disagreement becomes `falsified` only after a
  second fresh re-execution disagrees the same way — single flaky runs are
  re-run, not punished. The operator can annotate-reverse a reliability
  decrement post-hoc (wrong falsifications must have recourse).
  A pre-merge falsification is a **reliability event, not an incident**
  (incidents are for shipped harm) — but a second falsification from the
  same agent-class within 30 days escalates to the operator digest.

## The autonomy ladder

Autonomy is a finite-state dial per **(asset × change-class)** — never global
trust. Promotion requires numeric evidence *and* recorded operator
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
- **T1 — build.** Agent builds; verifier verifies; PR opens; operator merges.
- **T2 — auto-merge + outcome-watch.** Verified-green changes merge and deploy
  without review; a per-class watch window (pulse + served-layer guards +
  guarded bundles) auto-reverts on regression. Operator sees a digest, not a
  queue.
- **T3 — closed-loop.** The class runs Sense→…→Learn without per-change human
  contact; operator governs by policy, budget, and the calibration report.

**Starting tiers:** a newly onboarded asset sits at T0 while baselining —
with one exemption: operator-invoked **onboarding runbooks**
(pulse endpoint, AGENTS.md) run at T1, since the operator is the merger by
construction. After baselining, every allowed (asset × class) starts at
**T1** — T0→T1 requires no earned evidence because T1's gate *is* the
operator merging each PR; the earning starts at T1→T2.

**Promotion criteria (defaults; tuned in config, never vibes):**
T1→T2: ≥20 consecutive verified merges in class, ≥90% accepted without
substantive rework, 0 incidents ≥ sev-2 attributable to the class in 8 weeks,
reliability score above threshold, class ledger-positive. T2→T3: ≥12 weeks at
T2, auto-revert exercised and proven, calibration error for the class within
bounds.

**Demotion — three triggers, three deliberately different scopes** (the dial
is per asset × class; demotions widen with blast-radius uncertainty):
- any **sev-1** → that change-class drops to T1 **portfolio-wide** pending
  postmortem (a shipped harm's cause may not be asset-local);
- any **falsified claim** → decrements the **agent-class** reliability score
  (see below) — which can bar that agent-class from dispatch — AND drops the
  (asset × class) where it happened to T1 if it sat higher;
- **guarded-bundle divergence** → **freeze** on that (asset × class); the
  postmortem may widen it. Freeze is an *overlay* on the tier (any tier +
  `frozen`), exited only by postmortem completion.

**Demotion resets the promotion counters** — streaks restart from zero; the
ladder has no memory of pre-demotion credit.

**Agent-class, defined:** a (model × harness/prompt version) identity, e.g.
`opus-4.8/builder-v1` — the unit the reliability ledger scores. It is a
different axis from the (asset × change-class) tier: the tier says how much
automation a class of change has earned; the reliability score says which
agent identities may be dispatched to do it.

Review SLA belongs to the operator side of the contract: T1 PRs are batched
into a weekly review block; the Tower tracks retained-improvement-per-review-
minute as the number this ladder exists to improve.

## Ship safety: canary, watch, revert

- **Every T2+ change ships as an experiment**: cohort-scoped where the surface
  allows (page-cohort = canary + attribution in one), watch window sized to the
  class (fast metrics: 24–72h; SEO-facing: through first recrawl), auto-revert
  wired to the same guards the verifier checked — CI-green is explicitly not
  the safety net ([doc 01](01-architecture.md)).
- **Revert is a first-class operation**: one commit, no bespoke surgery —
  which constrains how the builder structures changes (small, revertible,
  flag-gated where cheap). The same rails power the **operator's one-click
  Undo** in the Tower registry ([doc 10](10-control-tower.md)): confirmation +
  reason → revert → timeline annotation → ledger close-out → a strong negative
  Learn label. When later changes have stacked and clean revert has degraded,
  the registry says so and offers revert-via-new-change — the UI never
  pretends undo is cleaner than it is.
- **Incident model.** Sev-1: user-facing breakage, compliance/consent
  regression, revenue-off-switch class (ads.txt gone), guard-tamper suspicion.
  Sev-2: outcome regression caught by watch. Sev-3: quality debt. Runbook:
  freeze class → revert → annotate timeline → postmortem → rule. Phase exits in
  [doc 07](07-roadmap.md) count sev-1/2 explicitly — "no prod incidents" is
  now a defined, countable claim.

### The task key chain

One key travels unchanged from the finding that raised work to the verdict that retires it; without it a shipped change and the observation that provoked it are two unrelated events in two stores. The key is the finding's own stable key — a query decision's normalized query, a finding card's `ExecutiveInsight.key`.

1. **The Tower writes the key into the handoff.** The copied Markdown ends in a ready-to-run `bd create` labelled `noticeos-handoff`, `asset:<id>`, `rule:<id>`, `key:<slug>`, with `noticeos_key`, `noticeos_rule`, `noticeos_asset` and `noticeos_kind` in `--metadata` verbatim. Only the metadata is byte-exact: `bd` splits label values on commas.
2. **The agent files the task in the asset's own repo.** The prefix comes from the repo `bd` runs in, never from the handoff. The poller reads the task back onto the finding card (`HandoffBeadBadge`, `packages/contract/src/task-snapshot.mts`).
3. **Every commit names the task id.**
4. **The task closes with the decision and its evidence** — a commit for shipped work, the basis for a decline. Closure records a decision, never a measured outcome.
5. **A ship writes a timeline annotation** (`annotations.kind = 'deploy'`) whose `ref` is the same task id, so Attribution ([doc 03](03-attribution.md)) sees a cause.
6. **The watch window opens against the same ref**, sized to the change class.
7. **The window's verdict retires the finding**, kept or reverted.

No task means untracked work, whatever the diff says. A task without the rule id and key is work, not a link. A task id in a commit but on no annotation leaves Attribution blind. Never fake a link: an annotation for a ship that never happened, or a verdict read off a chart instead of a window, turns an unknown into a false known. Nothing auto-reverts. Renaming `noticeos-handoff` or the `noticeos_*` fields breaks every existing join; readers also accept the older `reindex_*` names (`packages/contract/src/task-metadata.mts`).

## Intelligence tiering: crystallize smarts into tools

Model selection is a policy, not a per-task whim, and it follows one
principle: **the most intelligent models get the hardest problems — and their
primary output for recurring problems is a tool, not an answer.**

- **The gradient.** Frontier models: architecture and design, scoring-policy
  revisions, incident postmortems, high-stakes scout investigations,
  judgment calls with money attached — and **tool authorship**. Mid-tier
  models: routine builds inside established patterns, verification runs,
  lane investigations. Cheap/local models: radar skims, classification
  against rubrics, and **interpreting the outputs of tools the frontier
  models wrote** — work that requires reading, not thinking.
- **The crystallization rule.** Any task a model has performed repeatedly
  (default: 3×) is a candidate for tool-ification: the smartest model writes
  a deterministic script with a declared contract — inputs, outputs, and
  **escalation conditions** — and from then on the task costs a cron or a
  cheap-model invocation, not frontier reasoning. This buys three things at
  once: cost (order-of-magnitude per-token spreads between tiers),
  **reproducibility** (a deterministic core plus narrow interpretation beats
  re-deriving the analysis every run — and doesn't change behavior when a
  model version does, which protects both attribution and the reliability
  ledger), and auditability (tool outputs are exactly the machine-checkable
  evidence artifacts the accountability protocol demands).
- **Escalate, don't improvise.** A cheap model hitting an output outside the
  tool's contract escalates up the gradient — stated plainly in every tool
  contract. Guessing past an ambiguous output is an accountability violation;
  escalation is free.
- **The tool registry.** Tools live versioned in the OS repo with their
  contracts; the playbook ([doc 13](13-opportunity-scouting.md)) references
  them — a proven method's mature form *is* a tool. The registry is where
  continuous learning compounds into falling marginal cost: every quarter,
  more of the loop should run on tools + cheap interpretation, and the
  frontier budget should concentrate further on the genuinely novel. That
  ratio (frontier spend : tool-executed work) is a Tower metric worth
  watching — it trends toward the system getting cheaper as it gets smarter.

## Runbooks: execution as reviewed procedure

The tiering principle's operational form. An expensive model must **never
re-derive process mechanics** — how to call an API, where data lives, what
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

Approval state (who approved which version, when) lives **Tower-side** in the
grants table — never in the file, or a builder could self-approve. A rendered
"approved v3 by operator" line in the library view is a display of that
record. **Failure streaks suspend**: 3 consecutive failed runs auto-suspend a
runbook's grants (the same suspended state as a manifest deviation) pending
operator review — approval survives *edits* never, and failure
streaks only until reviewed.

- **Terminology, fixed:** a *tool* is a script (deterministic, contracted);
  a *runbook* is an executable procedure composing tools (this section); the
  *playbook* ([doc 13](13-opportunity-scouting.md)) is method knowledge —
  playbook entries mature into tools and runbooks.
- **Frontier models author and revise runbooks; they don't perform them.**
  Performing a runbook is cron + cheap-interpretation work. Frontier time is
  reserved for the `escalate-if` branches, the novel, and the next runbook.

### Permissions attach to runbooks, not to models

This is the trust model that makes autonomy legible to the operator:

- The operator **reviews a runbook like code** — steps, tools, rubrics,
  escalation branches, and its permission manifest (`git push`, merge, deploy,
  spend ceilings). Approval is per **runbook version**; any edit resets it to
  unapproved. What earns trust is a documented process the operator has
  actually read — never a model's improvisation, however smart.
- **Capability grants are scoped to the manifest.** A runbook approved with
  `push:asset-x` can push to asset X when its steps and gates pass; an agent
  outside an approved runbook has no push path at all. The autonomy ladder's
  tiers thereby become concrete: **T2 for a change class = an approved
  runbook exists for that class and its watch/revert gates are proven** —
  promotion reviews the runbook + its track record, not a vibe about "the
  agent."
- Runbook runs are fully logged (steps, tool outputs, interpretations,
  escalations) — the evidence chain in the Tower registry, and the substrate
  the reliability ledger and random audits read.
- The Tower carries the **runbook library**: versions, diffs since last
  approval, per-runbook track record, one-click approve/revoke
  ([doc 10](10-control-tower.md)).

## Cost discipline at the execution layer

Per-run and per-change budgets are **fail-closed runtime caps, on by default**
(documented agent cost blowups trace to a limit that existed but defaulted
off):
per-run USD + step caps, spend-velocity breaker, identical-call dedup,
recursion-depth caps, retry budgets at one layer, and an out-of-band kill that
cancels provider-side runs. Enforcement lives at the gateway
([doc 06](06-operations.md)); the ledger records cost-per-landed-change, and
Decide refuses work whose predicted cost can't clear its predicted value.
