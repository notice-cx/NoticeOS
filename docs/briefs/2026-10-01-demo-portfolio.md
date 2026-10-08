# A believable NoticeOS demo portfolio

*Scenario version 4 (2026-10-08) amends this brief: a fourth, ad-supported site,
live sources and the hosted scheduler's lanes. See
[`2026-10-08-demo-showcase.md`](2026-10-08-demo-showcase.md).*

Research and design for `ro-ujb9.256.1`, revised by `ro-ujb9.256.21` under
`ro-ujb9.256` on 2026-10-01. Scenario version 3 replaces the original publisher
portfolio with three fictional software businesses. This brief specifies the
scenario; separate qualification receipts prove implementation, not public deployment. Its readers are
the scenario implementer and independent verifier; it is a dated research
snapshot, superseded when a versioned scenario changes rather than maintained
as a task register.

## Experience

Use three fictional websites plus NoticeOS itself. Visitors can investigate
the same problem across Home, a site's detail, Alerts, Tasks, Financials,
Activity and the Wall. Use the ordinary application, Postgres store and Dolt
task hub from the same OSS-ready release; no separate dashboard or canned API
fork. The visitor experience is read-only exploration: working filters, charts,
task details, comments, dependencies and run details, with mutations visibly
disabled and refused at the request boundary. The approved hosted direction is
a shared synthetic tenant whose simulator changes data; visitors cannot write
portfolio state. This scenario revision supplies those fictional facts and
stories, not the tenancy implementation.

Show **“Demo · Synthetic data”** persistently, including the Wall, and
**“Read only”** beside unavailable changes. Describe observations as synthetic
in exported evidence too. **“Self-host NoticeOS”** leads to the supported setup
for the exact demo release. Do not offer hosted signup, pricing, a supported
agent API, or autonomous execution that the release does not provide.

## Portfolio and names

Names identify websites, not a new holding company. Use recognizable category
language rather than invented startup combinations. [GOV.UK's UI-writing
guidance](https://www.gov.uk/service-manual/design/writing-for-user-interfaces)
recommends intuitive names in users' language so people understand the purpose.
That is a useful design principle here, not evidence that these fictional names
have been tested with NoticeOS users. Use simple initials or existing icons;
no copied brand marks, celebrity names, slogans or visual identities.

| Software | Fictional purpose | State and story | Reserved identifier / task prefix |
|---|---|---|---|
| **Light Brief** | Draft structured briefs and export them | Established subscription product; a completed library-navigation repair has a recorded follow-up | `lightbrief.example` / `lb` |
| **Pinwell** | Save research sources and organize cited summaries | Established licensed product; source saving is currently broken while visits remain steady | `pinwell.example` / `pw` |
| **Fresh Rows** | Clean CSV files and validate their contents | Baselining; launched 24 days ago, collecting completed checks without reported income | `freshrows.example` / `fr` |
| **NoticeOS** | The operator's OS | Carries shared operating costs and its own tasks | The existing OS asset identity; a dedicated demo task project |

The fictional products have focused jobs rather than a generic “AI everything”
claim. These are scenario purposes, not working applications, supported provider
integrations or capabilities NoticeOS performs for them. Their supported custom
pulse metrics are `brief_exports`, `source_saves` and `completed_checks`:
last-day count, seven-day average and cumulative total. No LLM token, billing,
subscription-seat, MRR or churn metric is invented.

Screening on 2026-10-01 used quoted names and software/category queries.
Light Brief also appears as a [BoardBrain report label](https://boardbrain.com/sample-brief),
not a separate drafting app in the returned results. Fresh Rows occurs in
[Selextract's collection copy](https://www.selextract.com/); it is an ordinary
data phrase. Pinwell's returned results concerned an unrelated survey company
and a historical artist, with no research-software identity identified.
This limited screen is not trademark or legal clearance or global uniqueness.

The first selected research name, **Source Room**, was rejected after finding
an [existing AI/education software platform](https://sourceroom.ai/).
**Sidefolder** was rejected because [SideFolders](https://apps.apple.com/us/app/sidefolders/id422670449?mt=12)
is existing Mac software. **Pagekeep** was rejected because an
[existing bookmark/reading app](https://apps.apple.com/il/app/pagekeep/id6755833020)
uses it. Fictional brands use their own words, no copied product names, logos
or distinctive visual identity.

Use `.example` rather than registering or linking fictional live domains.
[RFC 2606](https://www.rfc-editor.org/rfc/rfc2606) reserves it for examples;
[IANA](https://www.iana.org/help/example-domains) also warns against depending
on operating HTTP services at example domains. Fictional site links therefore
remain text or lead to an explicitly local preview.

## Research translated into data rules

All sources below were retrieved 2026-10-01. Parameters and money amounts in
this brief are invented scenario choices, not industry benchmarks.

| Primary source | Established fact | Demo rule |
|---|---|---|
| [ONS synthetic-data policy](https://www.ons.gov.uk/aboutus/transparencyandgovernance/datastrategy/datapolicies/syntheticdatapolicy) | Synthetic records do not represent real people or businesses; purpose and production method determine usefulness. Random real rows are not synthetic. | Generate from a written scenario and deterministic seed. Never sample installation records, train on them, copy provider exports, or disguise real names. Publish the method and limits. |
| [Hyndman and Athanasopoulos, time-series decomposition](https://otexts.com/fpp3/decomposition.html) | Trend, seasonal patterns and remainder are distinct; daily data can have multiple seasonal components. | Combine gradual trend, weekday demand, annual demand, shared events and bounded noise. Do not draw unrelated random lines or uninterrupted exponential growth. |
| [EasySpecs on Product Hunt](https://www.producthunt.com/products/easyspecs-ai), [official introduction](https://www.easyspecs.ai/blog/introducing-easyspecs), [pricing](https://www.easyspecs.ai/pricing) | A 2026 launch turns code into reviewable specifications/documents; its official introduction is dated July 12, 2026 and it lists paid plans. These are maker claims, not measured product outcomes. | A focused brief-drafting/export business is relatable. Use independent recorded monthly subscription income, without copying the brand, its architecture or billing integration. |
| [Bookmarkify on Product Hunt](https://www.producthunt.com/products/bookmarkify-2?launch=bookmarkify-3), [official product](https://www.bookmarkify.io/), [pricing](https://www.bookmarkify.io/pricing) | Its 2026 launch listing and current product offer saved websites, organization/search and paid individual/team plans. | A saved-research business can have real save-action failures. Monthly licensing entries and pulse counts do not imply payment-provider, citation-verification or seat-count integration. |
| [OpenSheet on Product Hunt](https://www.producthunt.com/products/opensheet), [official product](https://opensheet.app/) | A 2026 launch presents browser tools for opening/querying/editing data files. The listing calls it free; no paid-price evidence is used here. | A young CSV cleanup/validation business has useful counts before monetization. Leave income absent; never infer paid demand from the example. |
| [Google: GA4 user metrics](https://support.google.com/analytics/answer/12253918?hl=en) | Active, new, returning and total users have different definitions. | Users, sessions, pageviews and events are distinct. Do not add daily unique-user counts and label the result monthly unique users. |
| [Google: Search Console performance](https://support.google.com/webmasters/answer/7576553?hl=en) | Clicks, impressions, CTR and position describe search-result performance. | Derive CTR from clicks/impressions at the same grain. Search clicks are not GA4 sessions; keep provider identity and reporting zone. |

## Generator and accounting contract

One manifest records release commit/image, schema versions, seed, scenario
version, cutoff instant, reference date, workspace, reporting zones and all
generated IDs. `D` means the cutoff's date in the saved workspace clock. Produce
400 synthetic daily facts through `D−1` for each mature product, only
`D−24…D−1` for Fresh Rows, 12 complete accounting
months for the mature products, and the current partial month. No history
before a website existed. The seed is keyed by asset, date and metric so adding
a metric cannot silently change another site's history.

Start with shared daily demand, each product's weekday pattern, gradual trend,
annual variation and dated events. Software use is lower on weekends; this is
a fictional audience assumption, not a market benchmark. Derive sessions,
pageviews, export/save/check events and search observations from those quantities.
Recorded monthly income is generated independently of traffic: exports and
visits cannot stand in for payment records.

An illustrative completed month before the repair baseline and young product's
launch has these USD anchors. Generate cents first and round at presentation.
Estimated entries are superseded by reconciled entries through the existing
booking model; the records do not establish payment dates or recurring contracts.

| Software | Sessions | Recorded income family | Reconciled income | Direct cost | Direct net |
|---|---:|---|---:|---:|---:|
| Light Brief | 66,000 | `subs` | $1,800 | $260 | $1,540 |
| Pinwell | 28,000 | `licensing` | $520 | $130 | $390 |

NoticeOS carries $210 shared overhead in that reference month, producing
$1,720 portfolio net. Fresh Rows has no prior-month figure before launch.
Its current month has $60 direct cost and no reported income. The mature
products have small current-month income receipts after a fictional first-day
01:00 UTC posting. They carry `coverage_start`, `coverage_end` and
`coverage_complete=false`, with `recorded_at` equal to the generation cutoff.
Before that posting, current income stays absent. Current operating costs are
recorded prepaid bills, not future cost estimates. Home, Wall and Financials
therefore state recorded current money without mixing estimates and receipts. One older month contains a corrected estimate; its previous entry
remains inspectable and is counted once.

No Mediavine site, run or daily ad record is seeded. There is no fabricated
subscription forecast from daily traffic: the ordinary daily-revenue projection
stays unavailable. Financials still reads recorded monthly subscription and
licensing income with explicit booking states. This scenario demonstrates
accounting coverage, not MRR, Stripe, churn, subscription contracts or causal ROI.

Keep genuine zero, missing day, failed collection, provisional value and absent
income distinct. One Pinwell GA4 report at `D−5` is deliberately absent from
stored observations; a later report resumes without backfilling it. Search and
custom pulse evidence remain separate. The generator can retain the underlying
synthetic fact to check consistency, but the ordinary traffic reader sees a gap.

Observation, collection, deployment, task and snapshot times never exceed the
cutoff. Today's optional partial values use elapsed time and remain provisional;
they cannot masquerade as a complete day. Exercise month boundaries too: on the
first day, the new month's absent reports do not become a month of zero earnings.

The workspace reporting clock and provider reporting zones are explicit. Do not
force different provider day boundaries into one series. GA4's newest values
retain the product's provisional state. Avoid timezone changes in this small
scenario. Traffic and accounting charts use the existing payload code. No product has
daily ad-income observations to support a traffic-based income forecast. Fresh
Rows has only 24 days and cannot supply a four-week seasonal baseline.

## Two linked stories and a quiet new site

**Recorded repair.** Light Brief's brief navigation broke at `D−60`.
The finding links to a task, investigation, review evidence and the synthetic
release annotation at `D−42`. Register the watch before that release, with a
28-day baseline `D−70…D−43` and follow-up `D−41…D−14`. The ordinary evaluator
calculates the recorded comparison and verdict from the seeded observations
and existing predicates. Preserve the original evidence, costs and task closure.
Higher observed use after the repair is not causal revenue attribution: no
control means no causal claim, and no realized-dollar booking lane is invented.

**Problem needing action.** Pinwell's source saves fall sharply at `D−2`, while
sessions stay near their normal weekday levels. Four matching
prior weekdays supply the existing volume-aware rule's baseline. The resulting
alert links to “Restore source saving”; it remains open while that task is in
progress. A separate human gate asks “Approve revised collection labels” and blocks
only its actual dependent task. Do not turn an unrelated human gate into a
blanket blocker or imply that creating a task resolved the alert.

**Early learning.** Fresh Rows has a small, growing usage series, setup work
and incomplete integration coverage. Its 24-day history has not armed a
four-week comparison rule. No fake low-volume alarm, historical profit,
completed watch or mature forecast fills those gaps.

Use 32 ordinary tasks across four real synthetic projects, four epic containers
and two human gates. Include completed, ready, in-progress, blocked and deferred
work; owners are the fictional operator **Mara** and roles **Builder** and
**Verifier**. Stable IDs connect comments, dependencies, handoff metadata,
annotations and evidence. Complete tasks only after their recorded acceptance;
never close an epic while required children remain open. Derive current board
counts from Beads and daily counts from the same dated task events. Epics,
deferred work, urgent work and operator requests follow the existing count rules.

Workflow records use existing definitions and stages: successful collection,
one failed collection followed by a recorded recovery, an outcome check, and
task-board refreshes. Historical success is not evidence that a provider was
contacted in the demo or that revenue improved. Show synthetic execution
provenance. No decorative AI agents, fabricated LLM traces or future scheduled
runs marked successful.

## Feasibility and qualification

The design consumes the current model; it requires no schema, booking-rule,
threshold, auth or security-header change. The seed and visitor boundary have separate source and qualification evidence;
this brief does not replace it.

| Source | Consequence for the same-release demo |
|---|---|
| [`0001_baseline.sql`](../../db/postgres/migrations/0001_baseline.sql), [`schema.ts`](../../packages/contract/src/schema.ts) | Seed a new isolated workspace and real relational history; run the schema constraints and pulse validators. Do not replace production APIs with fixture JSON. |
| [`financials.ts`](../../apps/tower/shared/financials.ts), [`daily-revenue.ts`](../../apps/tower/shared/daily-revenue.ts), [`revenue-projection.ts`](../../apps/tower/shared/revenue-projection.ts) | Asset direct costs and OS overhead differ; missing income is not zero; estimates, reconciliation and projections remain separate. |
| [`hosted-task-runtime.mts`](../../scripts/hosted-task-runtime.mts), [`hosted-task-executor.mts`](../../scripts/hosted-task-executor.mts), [`task-metadata.mts`](../../packages/contract/src/task-metadata.mts) | Hosted task reads and writes require the trusted Node task service and actual scoped Dolt projects. The browser and Worker cannot substitute a local fixture task writer. |
| [`work.ts`](../../apps/tower/shared/work.ts), [`watch-windows.ts`](../../apps/tower/shared/watch-windows.ts), [`03 — Attribution`](../03-attribution.md) | Task history supports 400 days; watch baselines are 28 days, final checks 28/56/90. A watch verdict does not book causal dollars. |
| [`workflow-definitions.mts`](../../scripts/workflow-definitions.mts), [`workflows.ts`](../../apps/tower/shared/workflows.ts), [`22 — Workflows`](../22-workflows-research-and-design.md) | Show implemented scheduled operations, retained execution evidence and freshness. Arbitrary agent/LLM workflows remain future capabilities. |
| [`fixtures.ts`](../../apps/tower/e2e/fixtures.ts), [`wall-fixture.ts`](../../apps/tower/e2e/wall-fixture.ts), [`journey-test.ts`](../../apps/tower/e2e/journey-test.ts) | Reuse validated shape examples and isolation principles, not their fake task writer or canned payloads as the public backend. |
| [`Prepared application container`](../../deploy/compose/README.md), [`Workspace ownership`](../23-configuration-ownership.md) | The container starts prepared state; fresh setup is separate. Select the explicit hosted or public-demo entry for shared hosting. Local qualification does not activate public exposure. |

Qualification starts from the exact public release and supported fresh setup
with a new Postgres/Dolt installation. The manifest and deterministic seed are
reviewable inputs; owned volumes, credentials and domains cannot select any
real installation. Provider collection, notifications, deployments and agents
have no external effects. Prove blocked egress with an owned reachable sentinel,
not just empty credentials or a disabled button. Reads and visitor filters use
ordinary APIs; direct mutation requests are refused too.

A seed run gives fresh synthetic observation times only for facts it actually
generated. Dates are coherently rebased together, never refreshed by relabeling
old rows as newly collected provider data. Any continued replay must record its
synthetic provenance and preserve historical events. A retained snapshot becomes
stale through the ordinary freshness rules if replay stops; health must not be
forged to hide that.

The persistent continuation uses [`demo-activity.mts`](../../scripts/demo-activity.mts)
with the original scenario manifest. It generates new dated inputs without
regenerating historical incidents or workspace identities. Its bounded formulas
preserve weekday demand, gradual growth, cumulative counters and seven-day
averages. A missing report remains absent; later reports include the asset's
continuing count. Periodic synthetic conversion incidents can recover, but the
generator emits no alert verdict or causal explanation.

Receipts start after the seed's cutoff day to avoid duplicating its partial
income. New monthly costs retain their prepaid-period coverage. The young
product still has no recorded income. A weekly fictional review has one stable
task key and dated create/start/complete intentions, with no claim of live
deployment. All inputs retain the original scenario hash and explicit synthetic
provenance. Each batch contains at most seven days; dates outside the fixed
100-year scenario horizon are refused. These pure inputs establish neither a
running simulator nor public hosting; the ordinary-writer composition is
tracked by `ro-ujb9.289.11.2`.

Independent browser acceptance follows both stories across desktop, mobile and
Wall using the same release, checks every cross-screen total and evidence link,
and runs two concurrent visitors plus refresh. Inspect missing/provisional data,
estimate correction, young-site gaps, blocked/ready tasks and closed-work versus
observed-outcome distinctions. The persistent synthetic label and read-only
state must remain visible; existing UX budgets and flow baselines stay intact.
The receipt names release/image, seed/manifest hash, date, environment and proof
commands. It proves this demo, not hosted production readiness or real ROI.
