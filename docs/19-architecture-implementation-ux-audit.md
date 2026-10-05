# 19 — Architecture, implementation, and UX audit

**Reviewed:** 2026-07-30
**Scope:** the ReindexOS repository at the working-tree state reviewed on this
date. This is a code-and-doc audit, not evidence that any remote Worker, D1
database, asset endpoint, or third-party integration is live.

**2026-09-24:** every finding carries one status line — **shipped** (commit or
code path), **tracked** (open bead) or **superseded** (decision) — and keeps
its number, because other documents and code cite "doc 19 finding N". The
narrative behind a shipped finding lives in git history and the closed beads
(`bd list -l doc-19 --all`).

## Executive finding

The Phase-0 core is real and sensibly bounded: one D1 store, one shared pulse
contract, one ingest Worker, and one read-mostly Tower with a narrow,
operator-only alert-lifecycle write. The strongest parts are
the explicit honesty rules, forbidden write surface, append-only intent,
centralized volume-aware flag rules, and shared Wall/desk components.

The main risk is not too little architecture. It is that the implementation
occasionally overstates what the data proves while the design corpus describes
several future phases as if they were one coherent current product. The next
work should harden ledger and measurement integrity, simplify configuration
and integrations, and make the Tower diagnostic before expanding the loop.

## Verified repository state

The state this audit reviewed is the working tree at `3fc0d3fa` (2026-07-30).
The dated current state is `AGENTS.md` § STATE and is not repeated here.

Phase 0 has **not** exited on repository evidence: the repo does not contain
proof of two assets completing 14 clean consecutive days or a full reconciled
calendar month of revenue and cost.

## P0 — integrity and truthful-state defects

These should be fixed before treating the ledger or Tower as decision-grade.

### 1. Revenue ingestion is append-only but not idempotent or reconcilable

`POST /api/revenue` inserts every accepted row with no source record ID or
uniqueness guard. Re-uploading the same CSV therefore duplicates money. The
public input deliberately excludes `supersedes_id`, so replacing an estimate
with a reconciled row requires manual SQL even though ordinary rollups depend
on that link.

**Status: shipped** — beads `ro-dql`, `ro-k5s`, `ro-wtt` (migrations 0018,
0020); [`workers/ingest/src/routes/revenue.ts`](../workers/ingest/src/routes/revenue.ts).

### 2. Same-day pulse retries delete operator learning

Pulse retry upserts the daily row and deletes every flag derived from that
pulse before recreating them. If an operator has dispositioned one of those
flags, its ID, disposition, and resolution history disappear. That contradicts
the append-only and false-positive-learning model.

**Status: shipped for flags** ([`workers/ingest/src/db.ts`](../workers/ingest/src/db.ts)
re-derives only untouched flags); **tracked** for the in-place pulse row —
revisions land with the Postgres store, epic `ro-ujb9.76`
([`db/postgres/migrations/0001_baseline.sql`](../db/postgres/migrations/0001_baseline.sql)).

### 3. The optimizer can still influence its baseline

Prometheus pulls correctly derive `avg7d` from central history, but
envelope-format pulls and pushed envelopes treat the asset-provided `avg7d` as
authoritative. Central rules then evaluate that value. An asset-side change can
therefore move the ruler even though the measurement channel is meant to be
outside optimizer write scope.

**Status: shipped** — `d9440d47`; [`workers/ingest/src/db.ts`](../workers/ingest/src/db.ts)
evaluates against stored history, never the source `avg7d`.

### 3a. Alert lifecycle was not operable

The store already had disposition/resolution columns, but the Tower exposed no
way to close an event. Open historical warnings therefore colored a property
indefinitely even when the operator had already understood them.

**Status: shipped** — `d9440d47`;
[`apps/tower/worker/flag-actions.ts`](../apps/tower/worker/flag-actions.ts),
[`apps/tower/src/components/FlagActions.tsx`](../apps/tower/src/components/FlagActions.tsx).

### 3b. Operator decisions evaporated

Everything the operator *decided* on a property page was thrown away. The
query-decision table's only action was Copy Markdown to the clipboard, with no
record anywhere: after a reload, every row returned identical, so a query the
operator had already dispatched work for competed for attention exactly as
loudly as one nobody had ever read. Findings were worse than absent — their
mark/dismiss state was written to `localStorage` under
`reindex-os:property-findings:<asset>`, so the property looked different on the
desk than on the TV or a phone, and clearing browser data silently erased it.
Both are the same defect: the OS observed providers meticulously and observed
its own operator not at all.

This is a doc 00 problem before it is a UX problem. The predicted-vs-realized
gap is the product, and the Learn loop cannot grade a judgement the store never
saw. Every decision lost here was a free training label.

**Status: shipped** — `ea79bbad`, migrations 0013 and 0021, beads `ro-5e8.3`,
`ro-5e8.4`; [`apps/tower/worker/decision-actions.ts`](../apps/tower/worker/decision-actions.ts)
(`marked` / `dismissed` only; a query row shows its bead, not a self-report).

### 3c. The OS paid for data it never showed anyone

Four separate collectors were writing rows with **zero readers in the Tower**,
which is the same defect four times: the OS was buying evidence and then not
looking at it.

**Status: shipped** — `3fc218f0`; spend attributed per asset in `e63035c`
(bead `ro-ukus`, [`packages/contract/src/metered-spend.ts`](../packages/contract/src/metered-spend.ts));
which DataForSEO families to collect at all is bead `ro-hiy`.

### 4. Estimated money is presented as booked P&L

The Wall waits until at least one reconciled row exists, but after that its
headline and trends sum all current rows, including estimates. One reconciled
row can therefore unlock a portfolio total mostly composed of estimates while
the empty-state copy says estimates do not count.

**Status: shipped** — beads `ro-qes`, `ro-uwo.2`, `ro-jk7`;
[`apps/tower/shared/wall.ts`](../apps/tower/shared/wall.ts) (`booked` and
`forecast` never share a number).

### 5. Freshness excludes properties that never reported

Both the hourly freshness check and the System summary start from the pulses
table. An expected live/onboarding property with zero pulses is invisible. The
Tower can consequently say “all fresh” while several portfolio properties
have never sent a report.

**Status: shipped** — beads `ro-8ov`, `ro-uwo.1`;
[`packages/contract/src/reporting.ts`](../packages/contract/src/reporting.ts).

### 6. Asset #0 asserts cron success without observing it

The nightly self-pulse always emits `cronRunSuccess = 1`; there is no cron-run
ledger behind the value. It also does not emit spend, running-agent, or queue
metrics that the System card anticipates.

**Status: shipped** — beads `ro-ic5`, `ro-uwo.4`
([`db/migrations/0022_job_runs.sql`](https://github.com/reindex-os/reindex-os/blob/a85e82837411729bc15b5cf1c2feacc7de209083/db/migrations/0022_job_runs.sql));
spend is counted from the store (`ro-sq42`); no agent runtime or queue exists
to instrument ([doc 07](07-roadmap.md)).

## P1 — misleading or impractical UX

### 7. “ROI this month” is not ROI

The value is monthly net P&L in dollars. ROI is a return relative to an
investment and is dimensionless or percentage-valued. The architecture also
uses “ROI” for a dollar-valued contribution formula.

**Status: shipped** — `106761ff` (D28): the Wall names the month's revenue and
says *estimated* for a forecast
([`apps/tower/src/components/wall/RevenueHero.tsx`](../apps/tower/src/components/wall/RevenueHero.tsx));
[doc 00](00-objective-and-roi.md) defines value contribution and the ROI ratio.

### 8. The monthly delta compares unlike periods

The delta subtracts the previous full month from the current partial month.
Early in a month, an otherwise healthy portfolio will look sharply down.

**Status: shipped** — beads `ro-7yv`, `ro-y91`; superseded by D28's pace
against last month ([`apps/tower/src/lib/wall-revenue.ts`](../apps/tower/src/lib/wall-revenue.ts)).

### 9. Unknown spend is rendered as zero spend

The label correctly prints an em dash when spend is absent, but the meter
receives `0`. The visual therefore communicates “none used” for “not
instrumented.”

**Status: shipped** — beads `ro-kukv.3`, `ro-sq42`, `ro-ukus`;
[`packages/contract/src/metered-spend.ts`](../packages/contract/src/metered-spend.ts).

### 10. Dead drill-down links pretend evidence exists

Interactive numbers without implemented destinations render as `href="#"`.
They jump to the top of the page and violate the design claim that every
number links to evidence.

**Status: shipped** — every rendered `Drill` carries a route; the `href="#"`
branch remains only for the kitchen-sink demo
([`apps/tower/src/components/Drill.tsx`](../apps/tower/src/components/Drill.tsx)).

### 11. Asset detail leads with configuration, not diagnosis

The route formerly placed a large editable configuration surface and every
integration before metrics, alerts, P&L, and timeline. It asked the operator
to understand how the property was wired before answering “what needs
attention and why?”

**Status: shipped** — `14432656` (bead `ro-pbzu.4`; per-tab files
`ro-78qo.2`; tabs loaded on open `ro-ujb9.84`): the asset page is tabbed,
D17 ([doc 10](10-control-tower.md)).

### 11a. Tower surfaces required too much recall and read every state as work

The operator had to re-read a legend on every property, translate internal
terms (“lane,” “consume,” “degraded,” “needs setup,” “staged changes”), scan
large empty chart/accounting/attention regions, and remember where major
sections lived on a long property page. The integration matrix made a neutral
setup backlog visually compete with actual failures, and its desktop-shaped
grid was impractical on a phone. A developer component gallery also occupied
primary Home navigation.

This follows W3C COGA patterns for
[clear words](https://www.w3.org/WAI/WCAG2/supplemental/patterns/o3p01-clear-words/),
[clear controls](https://www.w3.org/WAI/WCAG2/supplemental/patterns/o1p05-clear-controls/),
[clear page structure](https://www.w3.org/WAI/WCAG2/supplemental/patterns/o2p03-page-structure/),
and [orientation](https://www.w3.org/WAI/WCAG2/supplemental/patterns/o1p04-clear-steps/).
The named operator's ADHD-C experience is direct product evidence and governs
the priority of these reductions.

**Status: shipped** — `669ea09e`; connection labels now come from
`INTEGRATION_HEALTH_LABELS`
([`packages/contract/src/integration-health.ts`](../packages/contract/src/integration-health.ts));
rebuilt under D17 and D24.

### 11b. Named destinations had no route to them

The surfaces added by 11a named places the operator could not reach. The
property header's source icons said "open Integrations" three times while no
link to `/integrations` existed anywhere on the page, and used a term no
navigation label uses. The sticky navigator omitted the flagship query-decision
section and Data sources. The hash whitelist behind inbound deep links excluded
`#product-use` and `#query-visibility`, so those links silently did nothing. A
not-set-up source stated "To finish here: …" with no pointer to the setup
steps. `/wall` had no exit. The countdown editor told the operator to apply
from "Staged changes" while the control is labelled "Review changes".

**Status: shipped** — `8078c59b`; superseded by the tabbed asset page
(finding 11) and the Wall's one link, Home (D28,
[`apps/tower/src/routes/WallRoute.tsx`](../apps/tower/src/routes/WallRoute.tsx)).

### 12. The integration matrix represents implementation shape, not operator work

The full property × lane matrix makes dozens of cells look independently
actionable even when one shared credential or account action unlocks many of
them. A 537-line register, 500-line payload builder, and two UI representations
support mostly “not applicable” or “needs setup” cells.

**Status: shipped** — `306b84c` (bead `ro-9mx`,
[`apps/tower/shared/integrations.ts`](../apps/tower/shared/integrations.ts));
**tracked**: the per-property test-gate coverage row, bead `ro-uwo.5`.

### 13. Uptime is degraded by unrelated pulse failures

The integration merge treats a nightly pulse/fetch flag as evidence that the
uptime-monitor lane is degraded. The lanes are independent: a reporting
endpoint can fail while a central uptime monitor remains healthy.

**Status: shipped** — `3fc218f0`, `5842b8eb`, `6b0e6fc2` (beads
`ro-ujb9.165`, `ro-ujb9.171`);
[`apps/tower/worker/integration-evidence.ts`](../apps/tower/worker/integration-evidence.ts).

### 14. Lifecycle and automation posture are conflated

Asset cards treat `sense_only` as “setup,” dimming a property that may be
correctly and healthily monitor-only. Lifecycle status and automation
authority answer different questions.

**Status: shipped** — the old cards left in `69b93e6a` (D28); the asset index
filters lifecycle and automation separately
([`apps/tower/src/routes/AssetsRoute.tsx`](../apps/tower/src/routes/AssetsRoute.tsx)).

### 15. Error handling is inconsistent

Asset detail has a useful failed-load state and retry. Desk and Wall fall back
to “Waiting for the store…” when there is no cached payload, hiding whether
the store is empty or the request failed.

**Practical replacement:** share one load-state component: loading, empty,
failed with retry, and last-good/reconnecting.

**Status: open in part** — a failed first read is one shared state,
[`ReadFailed`](../apps/tower/src/components/ReadFailed.tsx) (error dot, what
could not be loaded, the HTTP status, Try again), on Home, Sites, Alerts,
Integrations, the Wall and the asset page (bead `ro-ujb9.218`, 2026-09-24);
code loading has its own (`ro-82x`). The Tasks board still prints “Waiting for
the store…” for a failed read, tracked on `ro-ujb9.218`.

## P1 — redundancy and overengineering

### 16. Collection configuration is duplicated

`config/pull.json` and `config/counters.json` repeat one property's endpoint,
enabled state, and metric-to-counter mapping. Counter cadence is repeated in
JSON, a cron constant, Wrangler config, tests, and comments.

**Status: superseded by D22** — both are store-seeded documents edited on the
Sources tab ([`apps/tower/src/components/CollectionEditor.tsx`](../apps/tower/src/components/CollectionEditor.tsx));
the cadence is still pinned by test, not derived
([`config/counters.README.md`](../config/counters.README.md)).

### 17. Config schemas are copied rather than shared and validated

Ingest and Tower redefine config interfaces. Vite parses most JSON and asserts
`unknown[]`/`Record<string, unknown>` before injecting it into the Worker
bundle. Invalid configuration can pass build-time parsing but fail
semantically later.

**Status: superseded by D22** — settings read store-first
([`apps/tower/worker/config-source.ts`](../apps/tower/worker/config-source.ts))
and every write is validated by
[`packages/contract/src/configuration.mts`](../packages/contract/src/configuration.mts);
the compiled fallback in `apps/tower/vite.config.ts` is still cast.

### 18. The changeset cart is a high-friction pseudo-settings UI

The operator edits a control, stages it in browser local storage, exports or
copies JSON, switches to a terminal, runs `pnpm config:apply`, reviews the
result, and commits it. The UI looks like direct configuration but is really a
command generator. JSON-pointer, equality, and validation behavior is also
duplicated between client and CLI.

**Status: superseded by D18 and D22** — bead `ro-pbzu.5`, epic `ro-syok`;
[`scripts/config-apply-core.mjs`](../scripts/config-apply-core.mjs) is the one
apply path and a field shows Saved · Undo beside itself.

### 19. Property cards scatter time around an unlabelled, overbuilt chart

The rendered card put report age, calendar month, monthly-point count,
“last report,” and nightly-point count around a line with no visible dates.
It also drew separate net and activity chart regions even when monthly history
was one point, and repeated two large “NO DATA” boxes on properties that had
never reported. Each tiny chart additionally owned a `ResizeObserver`, React
width state, and a uPlot instance. This is more machinery and more temporal
language than the underlying Phase-0 data warrants.

**Status: shipped** — `1ca79d83`, bead `ro-5cr`; the card itself left with
the old Wall (`69b93e6a`, D28/D34), and the rules live in
[doc 14](14-ui-standards.md).

### 20. A custom popover duplicates Radix behavior incompletely

`EvidencePopover` manually portals, positions, dismisses, and labels a dialog.
It does not provide dialog focus management or return-focus behavior and closes
on any scroll.

**Practical replacement:** use the established Radix popover/dialog primitive
and keep only the evidence-specific content component.

**Status: shipped** — bead `ro-ujb9.219`: `EvidencePopover` is built on
`apps/tower/src/components/ui/popover.tsx` (shadcn's Radix popover), which
moves focus into the panel, gives it back to the trigger on Escape or a press
outside, and stays open on its trigger through a scroll
(`apps/tower/test/evidence-popover.test.tsx`).

### 21. The normative design surface is several phases ahead of the code

The repo has roughly 3,000 lines of design docs and detailed contracts for
queue, registry, runbooks, scouting, investigations, commissions, chat
replacement, agent orchestration, and later-phase UX. The thought is valuable,
but keeping speculative Phase 2–5 detail beside current rules makes the context
pack larger and makes future behavior look committed before Phase 0 data can
teach anything.

**Practical replacement:** keep hard invariants and data contracts normative.
Keep one dated current-state page (this audit plus doc 12), one roadmap with
numeric exits, and move later-phase product detail to clearly marked proposal
sections/RFCs. Promote a proposal into the normative pack only when its phase
starts or the current phase needs an interface from it.

**Status: tracked** — bead `ro-ujb9.23`; the dated current-state page is
`AGENTS.md` § STATE, the roadmap is [doc 07](07-roadmap.md).

## P2 — implementation quality and platform alignment

- **Read-model duplication:** Wall, asset detail, and integrations repeat
  parsing, numeric coercion, current-ledger predicates, and flag queries. Add a
  small repository/query layer or D1 views after the P0 integrity fixes; do not
  introduce an ORM. *Status: shipped in part — shared readers over
  [`apps/tower/worker/db.ts`](https://github.com/reindex-os/reindex-os/blob/32754bd4/apps/tower/worker/db.ts) (`32754bd4`); the
  rest moves with the Postgres store, D25, epic `ro-ujb9.76`.*
- **Large payload/route modules:** split by operator question and test the
  composed API contract. Route-level lazy loading would also address the
  current client-chunk warning. *Status: shipped — beads `ro-78qo.2`, `ro-82x`,
  `ro-ujb9.84`.*
- **Unknown cron behavior:** an unrecognized schedule runs every lane. Fail
  closed with a structured error instead; configuration drift should not cause
  surprise writes. *Status: shipped — bead `ro-ujb9.217`:
  [`workers/ingest/src/dispatch.ts`](../workers/ingest/src/dispatch.ts) runs
  only the jobs `scripts/scheduled-jobs.mts` lists and refuses any other
  expression as `unknown_cron`; `test/crons.test.ts` pins the list.*
- **Pull-failure history:** a continuing outage rewrites its open flag’s
  message and inputs. Model an incident’s current summary separately from
  append-only failure observations, or explicitly sanction that current-state
  mutation in the schema contract. *Status: built, both halves — bead
  `ro-ujb9.220`: every failed pull appends its reading to `flag_evidence`
  ([`db/migrations/0040_flag_evidence.sql`](https://github.com/reindex-os/reindex-os/blob/a85e82837411729bc15b5cf1c2feacc7de209083/db/migrations/0040_flag_evidence.sql);
  operator-applied, and until it is the lane refreshes the flag as before), and
  the open flag's summary refresh is sanctioned in
  [docs/02 §Central store](02-signal-contract.md#central-store) and
  [`db/README.md`](../db/README.md).*
- **Runtime boundary validation:** client API responses and build-injected
  config are type-cast, not runtime-validated. *Status: not adopted — the client
  ships no schema library (`ro-82x`); no decision recorded.*
- **Kitchen-sink drift:** *Status: shipped — every registry entry renders at
  `/dev/kitchen-sink`, and
  [`apps/tower/src/components/REGISTRY.md`](../apps/tower/src/components/REGISTRY.md)
  records the representative-only exceptions.*
- **Worker environment types:** ingest uses generated Worker types; Tower
  hand-writes `Env`. Generate both from Wrangler configuration. Cloudflare’s
  [current Workers guidance](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
  recommends generated binding types. *Status: shipped — both
  `worker-configuration.d.ts` are generated by `wrangler types`; `TowerEnv` is
  checked with `satisfies ExportedHandler<Env>`.*
- **Observability:** Wrangler enables observability, but scheduled lanes do not
  emit structured completion/failure logs and Tower catches API failures
  without server-side diagnostic context. Add structured lane/run logging
  compatible with
  [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
  before claiming asset-#0 self-observability. *Status: shipped —
  `dispatch.ts` logs a structured failure line per step and `job_runs` records
  every firing (finding 6).*

## UI standard corrections adopted by this audit

The governing UI docs now use these rules:

1. A state must be scannable and text-labeled; never rely on color alone.
2. Severity remains red/amber/slate. The milestone token stays reserved for
   milestone-kind outcomes. A distinct healthy token makes a currently
   reporting property with zero open error/warn green; unknown/no-report stays
   gray. The compact property-source inventory has one scoped connectivity vocabulary:
   working green + check, failing red + `!`, and unconfigured dashed gray.
3. Pills/chips are for exceptional compact status, not every boolean or enum.
4. A quantitative visual is rendered only when the quantity is known.
5. A link exists only when its destination exists.
6. The default asset view answers “what changed or needs attention?” before
   “how is this configured?”
7. Time belongs to the fact it qualifies; a primary trend prints its own
   dates instead of surrounding an unlabelled line with detached clocks.
8. One shared legend governs repeated compact charts; raw values remain
   inspectable while a contrasting complete seven-day average supplies
   glanceable direction.
9. Empty/healthy states are compressed, not given the same panel weight as
   open work. Visible labels use operator words; technical provenance stays
   behind disclosure.
10. Long pages expose stable section orientation, and mobile data-source
    health is grouped by property rather than reproducing a wide matrix.

## Verification and limitation

The gate commands this audit ran are the CI bar in `AGENTS.md`; their
2026-07-30 output is in git history. The durable proof is the repeatable
harness committed at `apps/tower/viewport-audit.html` and
`scripts/tower-viewport-audit.mjs` (`pnpm tower:viewport-audit`), plus the
layout tests. `--focus` makes long-page section captures repeatable without
hand-scrolling; generated output remains local and gitignored.
