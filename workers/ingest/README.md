# @noticeos/ingest

The pulse-ingest and ledger Worker, its collectors and its scheduled lanes
([signal contract](../../docs/02-signal-contract.md),
[self-observability](../../docs/06-operations.md)).

## Routes

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/pulse` | Bearer, per-asset (`env.ASSET_TOKENS`) | Ingest one asset pulse: validate the envelope, write the `(asset,date)` row, explode envelope flags, evaluate the central volume-aware rules. |
| `POST /api/revenue` | Bearer, operator (`env.OPERATOR_TOKEN`) | Ledger lane: accept CSV or JSON ledger rows, validate against the CHECK constraints, append-only insert keyed on a stable `external_id`, per-row results. Re-uploading the same export books the money once — see [Revenue idempotency](#revenue-idempotency--the-same-export-books-once). |
| `POST /api/annotations` | Bearer, operator | Timeline events: `{asset, kind, at?, ref?, note?}`. Backdating allowed, future `at` rejected; an identical `(asset, at, kind, ref)` re-post returns the existing row instead of duplicating it. |
| `POST /api/watch-windows` | Bearer, operator | Register a pre-registered outcome check — see [Watch windows](#watch-windows-pre-registered-outcome-checks). |
| `POST /api/reclamation-targets` | Bearer, operator | A link-outreach campaign's target list, from `pnpm reclamation:import` ([scripts/README](../../scripts/README.md#reclamation-importmjs--load-an-outreach-campaign-into-the-store)): `{asset, targets}`, stored in one transaction. Each page is inserted once, a status only moves forward and a verification stamp only moves forward, so importing the same list twice changes nothing. |
| `GET /api/reclamation-targets?asset=&open=1` | Bearer, operator | A site's open targets (not won, skipped or dead), in the order they were stored, for `pnpm reclamation:open-targets`, which writes the reclamation-match rule's input: `{ok, asset, targets: [{domain, referringPage, replaceWith, status}]}`. `422` for an unknown site; `409` when the site holds more than one list may carry (5,000), never a partial answer. |
| `POST /api/beads-snapshot` | Bearer, operator | One photograph of the beads task hub, filed once a minute by the local runner's poller and rendered by the Tower's read-only `/work` board. Keeps the newest row whole, older rows only what the Wall feed reads, and prunes past 2 days — see [Beads snapshots](#beads-snapshots-the-task-hub-photograph). |
| `POST /api/job-runs` | Bearer, operator | A batch of scheduled-lane firings from the local runner — the evidence asset #0's `cronRunSuccess` is derived from. Idempotent on `(job, startedAt)`, because a runner catching up after an outage re-sends what it cannot know the store already has — see [Job runs](#job-runs-proof-that-the-scheduled-lanes-fired). |
| `POST /api/insight-snapshot` | Bearer, operator | Publish one reviewed executive snapshot into `noticeos.asset_insight_snapshots` — what `pnpm signals:publish-insights` writes and the Tower's property page reads. Stored verbatim and content-addressed, so a re-publish is a `200 {created:false}` no-op — see [Insight snapshots](#insight-snapshots-the-executive-publish). |
| `POST /api/asset-state` | Bearer, operator | Set one sanctioned column of one asset row — `status` or `sense_only`, the only two db/README lets anything edit. The `store-asset-set` op of a changeset the operator applies with `pnpm config:apply` — see [Asset state](#asset-state-the-two-editable-columns). |
| `GET /api/asset-state` | Bearer, operator | Read-only: `?asset=` → those same two columns, which is what the changeset's `expect` guard compares against before anything is written. An asset the store does not have is `200 {known:false}`, not a 404. |
| `POST /api/signal-collect` | Bearer, operator | **Spends money.** Collect one property's DataForSEO families now — `{asset, families?}` — instead of waiting for the Monday sweep. Runs the same collector the cron runs, scoped: same cap gate, same retries, same manifest row. What `pnpm signals:collect` fires — see [On-demand collection](#on-demand-collection-a-baseline-on-the-day-the-bet-launches). |
| `GET /api/serp-panel-landings` | Bearer, operator | Read-only: which properties have a fresh weekly DataForSEO collection in the archive, newest per property inside a 21-day window, flagged with whether the S1b panel was one of its families. The local runner's panel-review filer acts on it — see [SERP panel landings](#serp-panel-landings-what-the-review-filer-reads). |
| `GET /api/panel-source` | Bearer, operator | Read-only: `?asset=&windowDays=` → the revision-resolved archive manifest **and** the normalized daily site-level series for one property. What the standing panel refresh runs on — see [Panel source](#panel-source-what-the-local-scripts-read). |
| `GET /api/signal-archives` | Bearer, operator | Read-only: `?asset=&from=&to=&integration=&report=` → the same revision-resolved manifest, filtered as an operator asks and unwindowed by default. What `pnpm signals:download` runs on — see [The hand downloader's manifest](#the-hand-downloaders-manifest). |
| `GET /api/panel-object` | Bearer, operator | Read-only: `?key=` → one archived provider response, gunzipped, as the JSON the flattener expects on disk. The key must appear in `signal_dump_runs`; nothing else in the bucket is reachable. |
| `GET /healthz` | none | Liveness. |

Several methods on the WorkerEntrypoint are not routes and carry no bearer,
because the private Service Binding that reaches them *is* the capability:
[`ga4Realtime()`](#ga4-realtime-rpc),
[`calendarUpcoming()`](#calendar-rpc-the-walls-next-meetings),
[`createAnnotation()`](#createannotation--the-same-write-over-a-service-binding),
[`createWatchWindow()`](#registering-one--post-apiwatch-windows), the five
credential methods — `listCredentialSummaries()`, `putCredential()`,
`deleteCredential()`, `probeCredential()` and `connectCredential()` (the
connect panel's save-and-test: the provider is asked first and the credential
is stored only if it accepts, `src/credential-connect.ts`) — and the three
Google sign-in methods — `beginGoogleOAuth()`, `completeGoogleOAuth()` and
`discoverGoogleProperties()`
([Credential store](#credential-store-one-key-every-provider)). All are callable
only by the Control Tower.

### Auth model

- **Pulse** — `env.ASSET_TOKENS` is a JSON map `{ "<asset-id>": "<token>" }` (a
  secret). The pushing asset's bearer token must match the token registered under
  the asset id in its own pulse body. Tokens are compared constant-time (SHA-256
  digests through `crypto.subtle.timingSafeEqual`). A body with no asset id, an
  unknown asset, or a mismatched token → `401`. This is the **only** per-asset
  token map: the same entry is presented outbound when the OS pulls that asset's
  self-report endpoint ([Auth — `env.ASSET_TOKENS`](#auth--envasset_tokens)).
  The naming scheme and why one token serves both directions is
  [docs/11 §Credential naming](../../docs/11-integrations.md#credential-naming--the-asset_token-convention).
- **Revenue, annotations, watch windows** — a single operator bearer token,
  `env.OPERATOR_TOKEN`.
- **Provider credentials** resolve **store-first, env-fallback**: a credential
  entered on the Tower's Integrations page has a connection in
  `noticeos.integration_connections` and an AES-GCM-encrypted secret version in
  `noticeos.connection_secrets` under the env secret `CREDENTIALS_KEY`
  ([Postgres model](../../db/postgres/README.md#the-decided-model)). The bindings
  below are the legacy fallback ([Credential store](#credential-store-one-key-every-provider)).
- **Calendars** — `env.CALENDAR_FEEDS` is a JSON map `{ "<label>": "<secret ICS
  url>" }`, or `{ "<label>": { "url": …, "color"?: …, "email"?: … } }` (a
  secret). Each URL is itself the credential — it reads the whole
  calendar for whoever holds it — so it never crosses to the Tower and never
  appears in a log line or an error, which name the label only
  ([Calendar RPC](#calendar-rpc-the-walls-next-meetings)).
- A provider credential lives in the **store**, entered on `/integrations`. The
  three bootstrap secrets above (`CREDENTIALS_KEY`, `OPERATOR_TOKEN`,
  `ASSET_TOKENS`) and any legacy provider binding live only in Cloudflare secrets
  (prod) or `.dev.vars` (local, gitignored) — never in `wrangler.jsonc` or
  source. Which is which, and why:
  [doc 06 § Bootstrap secrets vs. integration credentials](../../docs/06-operations.md#bootstrap-secrets-vs-integration-credentials).

### Status codes

`401` unauthorized · `400` unparseable body · `409` a concurrent revenue upload
lost the race to the ledger's unique index · `422` authenticated-but-invalid
envelope (pulse), no revenue row accepted at all, or a rejected field / unknown
asset (annotations, watch windows, asset state), or a rejected field (beads
snapshot), with per-issue / per-row detail ·
`201` pulse written, annotation created, watch registered, snapshot stored ·
`200` revenue processed (per-row results; partial success is a 200, and so is an
upload whose rows were all already imported), an idempotent annotation re-post
(the existing row, `created: false`), an asset-state column moved (a row that
already existed, so nothing was created), or a collection run and reported
(`/api/signal-collect` — what it attempted and what it cost, whether or not
every family landed).

`/api/signal-collect` adds two `422`s of its own before it spends anything:
`unknown_asset` for a property the collector does not sweep, with the reason,
and `family_unavailable` for a family that property is not due. It also answers
`409 collection_in_flight` — the collector runs one collection at a time, and the
body names the run that already holds the lane (start time, scope, how long it
has been going, when its lease expires). Nothing is asked of the provider and
nothing is billed on that path. PostHog families answer the same `409` per
asset: another run already holds that asset's PostHog lease.

The `422` issue shape — `{ path, code, message }` — is identical across every
lane. The pulse and revenue routes get it from the contract package's Zod
schemas; the annotation, watch, and beads-snapshot routes hand-roll the same
shape (`src/routes/validate.ts`), because zod is not a dependency of this Worker
and the operator-facing error body must not vary per route.

## Crons

| Cron | Handler | Behaviour |
|---|---|---|
| `0 * * * *` (hourly) | ingest-freshness | For every non-`pre-launch`/`retired` asset that owes a report, fire an `error` flag (`rule_id = ingest-freshness`) once its latest pulse is older than the contract's `REPORT_MAX_AGE_HOURS` — 48h, two missed nights. That constant, not a number of this Worker's, is also what the Tower counts a property stale at, so the flag and the Tower's coverage can never describe one property differently. A site that has never sent a report owes none and never fires it; its first report makes it expected. Never double-fires while an identical open flag exists; the flag auto-resolves when a pulse next arrives. |
| `30 2 * * *` (02:30 UTC) | pull adapter + Bing signals | Pull each enabled pull-mode asset's self-report endpoint (`config/pull.json`) through the pulse path, then collect daily Bing Webmaster clicks/impressions for every non-retired portfolio property verified under the central key. This includes Sense-only pre-launch properties; observation does not authorize publication or action. The jobs are failure-isolated. |
| `0 3 * * *` (03:00 UTC) | asset-#0 self-pulse | The OS writes its own pulse (`asset = <os-asset-id>`) with pulses received, ledger rows ingested, open flags, and `cronRunSuccess` — derived from the job-run record (`job_runs`). Three-valued: `1` while every lane's latest firing ran or stood down, `0` the moment one lane's latest firing failed *or* nothing has fired for a day (a dead runner stops writing, so stale evidence must not read as health), and absent — capability and metric both — while the record is empty, because nothing observed is not success. See [Job runs](#job-runs-proof-that-the-scheduled-lanes-fired). |
| `30 3 * * *` (03:30 UTC) | watch-window evaluation | Read out every open watch window whose next check has come due: record an interim reading, or close the window on its final offset with an outcome and a flag. Runs after the 02:30 signal pulls so a check due today reads today's data. See [Watch windows](#watch-windows-pre-registered-outcome-checks). |
| `0 4 * * *` (04:00 UTC) | tech/GEO hygiene guards | Fetch each eligible property's own home page, `robots.txt`, sitemap, and three sampled real pages, and flag a static-HTML depth collapse, an unreachable home page, a lost AI crawler, a page-level `noindex`/`nosnippet`, or a sitemap outage. Six plain HTTPS requests per property, no provider and no quota. See [Hygiene guards](#hygiene-guards-s5--the-served-layer). |
| `30 4 * * *` (04:30 UTC) | Microsoft Clarity export | One Data Export call per property that has a project token, archived verbatim: a trailing 72-hour, URL-split read of the behavior metrics (dead/rage clicks, quickbacks, script errors, scroll, engagement). Once a day on purpose — the provider allows 10 calls per project per day total, so every later read comes from the archive. A property with no token is skipped silently. See [Clarity](#clarity-behaviour-signals-10-calls-per-project-per-day). |
| `15 12 * * *` (12:15 UTC) | provider signal dumps | Archive eight completed-day GA4 families and ten GSC breakdowns for the previous four dates, plus the BWT report families a property is due — four daily provider series every day, and the two weekly top-query/top-page snapshots once a week each. Raw provider responses go to private/local R2; append-only attempt manifests go to Postgres. Before its own window it re-collects up to 100 earlier GA4 / Search Console dates an outage cost. The same tick runs the DataForSEO outage re-collection beside it: only the families an offline DataForSEO run skipped, as listed on the open `os-egress-down` flag — never one the provider refused or the cap stopped — under the same due check and monthly cap. It reads that one flag and does nothing else when no family is owed, and it honours a paused DataForSEO schedule. |
| `30 12 * * *` (12:30 UTC) | PostHog product analytics archive | Per launched asset with a PostHog key **and** a saved region + project: one project read (timezone), then six aggregated HogQL queries run one at a time: `web-daily` (28 days), `events`, `exceptions`, `rageclicks`, `web-vitals` (14 days) and `funnels` (7 days, only where funnels are declared). Each is stored in private/local R2 with one `signal_dump_runs` row (`integration = 'posthog'`). A 429 from PostHog's hourly query budget stops the run and lists the families it did not ask for; the next run asks them. No key, no mapping or an unmigrated store skips with a named reason, with no request and no row. One run per asset at a time: an asset another run holds (its `integration_leases` row `posthog:<asset>`, 30-minute expiry) is skipped as `in-flight`. An offline night writes no PostHog row, and the next run asks again, per family before its own window, up to six earlier window ends an outage cost ([the dates an outage cost](#the-dates-an-outage-cost)). See [docs/11 § PostHog](../../docs/11-integrations.md#posthog). |
| `45 12 * * 1` (Monday 12:45 UTC) | DataForSEO search intelligence | For every launched content property, archive ranked keywords, backlink stock + 90-day movement, and Google/ChatGPT mention metrics — plus, where `config/serp-panel.json` names tracked head terms, one live result page per term **per device** (phone and desktop) with its AI Overview citation state. Exact report cost is indexed; the portfolio data cap fails closed before a call. |
| `*/15 * * * *` (every 15 min) | counters + Google signals | Re-read property total cards and pull bounded 97-day GA4/GSC daily snapshots: 90 visible property-detail dates plus seven calculation-only dates. The two jobs run independently on the same tick. Counters upsert current state; Google runs/changed values append (see [Google signals](#google-signals-ga4--gsc)). Neither writes pulses or flags. |

The handler dispatches on the cron string verbatim: each expression is the
dispatch key of one job in `scripts/scheduled-jobs.mts`, `src/dispatch.ts`
`JOB_LANES` names that job's steps, and `test/crons.test.ts` pins
`wrangler.jsonc`, the jobs and the table to the same list. Any other expression
runs nothing and fails as `unknown_cron`.

## Collector config: the store first, the compiled copy behind it

Every config document a collector needs is resolved once per cron fire by
`readCollectorConfigs` in `src/config-store.ts` and handed to each job by
`src/dispatch.ts`. Six documents, one query of `noticeos.config_documents`, one
cache policy. Stored keys are file names without their directory or extension
(`config/pull.json` → `pull`); the API still names files, translated at the
store boundary.

| Document | Who reads it |
|---|---|
| `config/pull.json` | the nightly pull adapter's registry of self-report endpoints |
| `config/counters.json` | which totals each property's fast-lane cards show |
| `config/integrations.json` | the per-asset property/site/scope mapping every Google, Bing and DataForSEO job resolves through (`src/lane-mapping.ts`) |
| `config/ga4-custom-dimensions.json` | which GA4 event-parameter families the dumps ask for |
| `config/serp-panel.json` | the tracked head terms the weekly DataForSEO sweep pays for, and the panel roster the landings read grades a collection day against |
| `config/constants.json` | the central flag-rule defaults `writePulse` evaluates |

**`undefined` is the fallback rule, written once.** A document the store does not
hold — or holds in a shape its readers cannot index into — resolves to
`undefined`, which is what each job's own override option means: keep the copy
compiled into this Worker, byte for byte. A run on an install that has applied
the migration and not seeded is the run it was before, and no collector carries
a second copy of that rule.

**In the unit suite the compiled copy is a fixture.** `vitest.config.ts` answers
every import of a repo `config/*.json` — these fallbacks and the contract's
compiled clock — with the frozen document in `test/fixture-config/`, so an
operator saving a setting (which `pnpm config:export` writes back into
`config/`) cannot change a test result. A test importing the checkout's own file
is refused; only the seed checks in `test/config-seeds.test.ts` read it, as
listed in [`scripts/test-config-isolation.mts`](../../scripts/test-config-isolation.mts).
A new compiled config import needs its fixture copy, or every suite that loads
it fails.

**Constants are the one document read away from the cron seam**, in `src/db.ts`.
The flag defaults are not a collector's config: they are what `writePulse`
evaluates, and it has two entry points that are not a cron fire — an asset's
`POST /api/pulse`, and the nightly pull's own ingest. An explicit `RuleConfig`
still wins, so every suite states its own thresholds.

**Each run says which of the two it read.** `pull_complete`,
`counters_complete`, `bing_signals_complete`, `google_signals_complete`,
`signal_dumps_complete` and `dataforseo_dumps_complete` each carry a
`configSource` object naming only the files that job reads:

```jsonc
{ "event": "bing_signals_complete", "attempted": 6,
  "configSource": { "config/integrations.json": "store" } }
```

The word only — a config document holds property ids, tracked queries and
spend caps, and a log is the one place none of them belong. The field is absent
when the caller resolved nothing (every suite here states its own config), so a
run that read neither the store nor a file never claims on a log line that it
did.

A property id saved on an asset's Sources tab is what the **next** collection
run asks for, with no app restart and no update —
`test/config-reaches-collectors.test.ts` drives one Save through
`applyConfigOps` and two `runCron` fires in one isolate. The tab prints
whichever of the two timing sentences is true of this deployment, derived from
`config/integrations.json`'s entry in `GET /api/config`'s `sources`.

## Same-day re-push

The store is intended to be append-only ([db/README](../../db/README.md)).
Current code uses **replace-same-day**. A re-push for an existing `(asset, date)`
**upserts** the pulse row (envelope + extracted columns replaced) and **re-derives
its still-open, untouched flags**, so a retry or corrected late-evening push is
idempotent rather than duplicating the day. Dispositioned or resolved events
keep their IDs and evidence, and recalculation will not reopen an equivalent
event from that pulse. Replacing the pulse observation itself remains the one
documented append-only deviation; immutable pulse revisions are still the
longer-term store model.

## A snoozed condition survives the night

The Tower can park an alert until a date. Two of this lane's statements honour
that.

**The flag insert.** Every other lane's dedup asks "is there an unresolved flag
for this asset and rule", so a snoozed row already stops them re-firing. This
one is keyed on `pulse_id`, and a pulse is a new row every night, so it also
refuses to insert while an **active snooze** exists for the same
`(asset, rule_id, metric)` — the same scope the Tower's `applyFlagAction`
dispositions, so what goes quiet is exactly what the operator's row claimed to
stand for. The clock is this runtime's `receivedAt`, never the asset-supplied
`generatedAt`.

**The flow-anomaly resolution.** Each fresh metric reading closes the previous
`flow-poisson-low` / `flow-lowvol-window` alert before a current one is
inserted, so a recovered Saturday cannot leave a property yellow forever. That
close reaches a **snoozed** row as well — but *only when the metric did not
fire tonight*. A snooze says "ask me later", so a condition that genuinely
cleared has answered and must not come back on its date as a stale alarm; but
closing it while the condition is still true would clear the snooze and let the
insert above raise it again. `ack` and `resolve` remain untouchable — they are
the operator saying *done with this*, and a lane may not undo that.

## Revenue idempotency — the same export books once

Every row carries a stable **`external_id`, namespaced by its source**, under a
unique index, and an exact **`amount_minor`** in integer minor units of its
stated currency.

**Where the key comes from.** A source that issues its own record id supplies
`external_id`, and the stored key is `<source>:<external_id>` — so `SID-1` from
`cj-export` and `SID-1` from `raptive-report` are different rows. A hand-built
monthly export usually issues nothing, so the key falls back to the accounting
grain the row occupies:

```
<source|ref|operator>:auto/<kind>/<asset>/<period>/<family>/<booking_state>
```

The assumption worth stating plainly: **one figure per source, per property,
per month, per family, per booking state.** Two genuine payouts from one source
inside one month therefore need explicit `external_id` values — and the lane
refuses them rather than merging them (below), so the assumption fails loudly.

**What each replay does:**

| Replay | Result |
|---|---|
| Same key, same money | `ok: true, imported: false` with the existing row's id. Nothing is written; the total does not move. |
| Same key, different money, currency or replacement link | `conflicting_replay`. Refused, with the stored figure and the fix in the message. |
| Same key twice inside **one** upload | The second is `already_imported`; a doubled line in a file cannot double the money. |

A restated figure is **never** an in-place edit. Rows in this store are history
(db/README), and overwriting an estimate would erase the very number a
reconciliation is measured against — so the answer is a new reconciled row that
supersedes the old one.

**Reconciliation links by id, not by match.** `supersedes_external_id` names the
estimate's stable id; the route resolves it to `supersedes_id`. An unknown target
is `unknown_supersedes` (never a silently unlinked row), only a `reconciled` row
may supersede, and an estimate uploaded in the same batch as the row reconciling
it resolves correctly — the writes go out in two passes for exactly that case.

**A correction replaces one current entry of the same identity.** The target
must have the same asset, period, kind, family and currency
(`supersedes_mismatch` names the fields that differ) and must not already be
replaced (`already_superseded` names the entry that replaced it — supersede that
one instead). Two rows of one upload replacing the same entry are both
`duplicate_supersedes`. The insert itself re-checks the target, so of two
concurrent corrections exactly one is booked and the other gets a per-row
`already_superseded`. A replay under the same key must also match the stored
currency and replacement link, or it is `conflicting_replay`.

```bash
# a source with its own record ids
curl -sS -X POST http://localhost:8791/api/revenue \
  -H 'authorization: Bearer dev-operator-token' -H 'content-type: application/json' \
  -d '[{"kind":"revenue","asset":"example.com","period":"2026-06","family":"affiliate",
        "amount":40.00,"source":"cj-export","booking_state":"estimated","external_id":"SID-1"}]'

# reconciling June ads, pointing at the estimate by its stable id
curl -sS -X POST http://localhost:8791/api/revenue \
  -H 'authorization: Bearer dev-operator-token' -H 'content-type: application/json' \
  -d '[{"kind":"revenue","asset":"example.com","period":"2026-06","family":"ads",
        "amount":498.10,"source":"raptive-report","booking_state":"reconciled",
        "supersedes_external_id":"raptive-report:auto/revenue/example.com/2026-06/ads/estimated"}]'
```

`amount_minor` is the only money column the store has and the authority for
anything that must add up; every Tower read model adds it. The upload states
major currency units, and this route converts once on the way in rather than
storing the figure twice. `currency` is a supported uppercase currency code and
defaults to `USD`. Precision follows that currency: JPY has no decimal minor
units, USD/EUR have two and KWD has three. Unsupported codes are refused. A
correction retains the original row's currency; changing a currency under the
same external id is a conflict, not a conversion. A row naming no money is
refused, not booked as zero.

Tower figures add rows only within one currency. Pure non-USD figures retain
their currency; mixed totals, comparisons and chart axes are unavailable while
individual asset and ledger rows remain readable. There is no foreign-exchange
conversion. Recurring costs and Mediavine reporting remain explicitly USD.

`importLedgerRows(rows, store)` exposes this same ordinary row importer to a
server-bound writer; HTTP authentication and envelope parsing stay in the route.
The response body is `{ inserted, alreadyImported, failed, reviewRequired, results }` — a replay
is counted separately from a booking, so an operator can tell "nothing to do"
from "nothing happened".

## Central rule evaluation

On every pulse, the contract's volume-aware rules are evaluated centrally with
the **OS's** config (`config/constants.json` `flag_defaults`) and central
history. Every daily metric compares with the mean of its four matching prior
weekdays. At seasonal baseline ≥ 3/day it uses the single-day Poisson tail
(`flow-poisson-low`); below that, `flow-lowvol-window` compares a complete 72h
window with four equivalently aligned historical windows. Any missing cohort
keeps the rule unarmed; no code falls back to the envelope's `avg7d`. Each new
metric reading resolves the prior open central flow event before the current
one is evaluated, so recovered metrics stop contributing to property health.
Each fired flag stores `rule_id` + `rule_inputs` (including comparison dates)
for auditability.

## Annotations (the timeline writer)

`POST /api/annotations` is the production writer for the `annotations` table,
which the Tower's timeline, alert correlation and freshness read.

```jsonc
{ "asset": "example.com", "kind": "deploy",
  "at": "2026-07-12T18:04:00.000Z",     // optional, defaults to now
  "ref": "a1b2c3d",                     // optional: commit sha / config version / model+version
  "note": "July SEO batch — 240 recipe titles" }   // optional
```

- `kind` is the schema's own CHECK set: `deploy`, `model-change`, `config`,
  `incident`, `autonomy-change`, `external`.
- **Backdating is allowed and expected.** An event is annotated at the time it
  happened, not the time somebody remembered to record it. A *future* `at` is
  rejected (60s of clock skew tolerated): an event may not claim to have
  happened after outcomes already in the store.
- **Identity is `(asset, at, kind, ref)`.** An identical re-post returns the
  existing row with `created: false` and writes nothing — retries and replayed
  webhooks are safe. `note` is prose about the event, not part of what makes it
  a different event, so a reworded re-post does not create a second row.
- `ref` caps at 256 characters, `note` at 1000.

### `createAnnotation()` — the same write over a Service Binding

The Control Tower records timeline events too, and cannot hold the operator
bearer this route demands: it is served unauthenticated on the trusted LAN, so a
bearer there would put every operator-authed lane one LAN request away. It calls
`createAnnotation(input)` on the WorkerEntrypoint instead (beside
`ga4Realtime()`), over the private INGEST Service Binding — the binding is the
capability, and no credential crosses the boundary.

Both lanes run the same writer (`src/annotations.ts`), so the rules above are
the rules there: same kind vocabulary, same backdating rule, same
`(asset, at, kind, ref)` identity, same caps. Only the shape of the answer
differs — RPC returns plain data rather than a status code
(`packages/contract/src/create-annotation.ts`):

```ts
{ ok: true,  created: boolean, annotation: AnnotationRow }   // created:false = the re-post
{ ok: false, error: 'validation', issues: [{ path, code, message }] }
{ ok: false, error: 'unknown_asset', asset: string }
```

A rejected field and an unknown asset are **results**, not exceptions — they are
ordinary answers the caller renders. Only a store failure throws across the
binding.

## Watch windows (pre-registered outcome checks)

The first defense against self-deception is that the comparison is chosen
**before** the numbers exist ([attribution](../../docs/03-attribution.md)). A
watch window is that pre-registration made machine-checkable, and the 03:30
cron is what reads it back out.

### Registering one — `POST /api/watch-windows`

```jsonc
{
  "asset": "example.com",
  "ref_kind": "annotation",             // annotation | decision | manual
  "ref": "41",                          // the thing being watched (free text; annotation id, decision id, …)
  "metric_integration": "gsc",          // ga4 | gsc | bing-webmaster
  "metric": "clicks",                   // must exist in that integration's signal_observations vocabulary
  "registered_at": "2026-07-12T18:04:00.000Z",  // optional, defaults to now; backdating allowed
  "baseline_start": "2026-06-14",       // the PRE-change comparison window, inclusive
  "baseline_end": "2026-07-11",
  "check_offsets": [7, 14, 28],         // whole days after registered_at; the largest is the final check
  "thresholds": {                       // optional — see "no verdict without a predicate"
    "ship": { "direction": "up",   "min_delta_pct": 10 },
    "kill": { "direction": "down", "min_delta_pct": 10 }
  },
  "scope": { "query": "my plume" },  // optional; exact GSC query grain only
  "note": "July title batch"
}
```

Registration is rejected (`422`) when it could not be honestly evaluated later:
an unknown asset, a metric the collectors do not write, a `baseline_end` past
the registration date (a baseline that overlaps the change measures the change
against itself), or a final offset shorter than the baseline is long (the final
post window is baseline-length and ends on the check date, so a too-early final
check would reach back over the change).

`direction` is **literal on the metric's own value** — an improvement in average
GSC `position` is `down`.

The `10` above is an **example, not a norm**. The Tower's composer derives that
number from the property's own series: it makes this evaluator's exact
comparison (mean daily value over two adjacent windows of the baseline's
length) across the historical span the archives hold, and proposes the smallest
whole percent above the ninetieth percentile of those moves — stating the span,
the typical move, and the floor beside the field. `WATCH_MIN_WINDOW_COVERAGE`
(`@noticeos/contract`, pinned by a test against `MIN_WINDOW_COVERAGE` below) is
what keeps the two honest: a stretch this evaluator would close `unmeasurable`
is not one the calibration counts. The reader also queries the annotation
ledger over the full 180-day horizon (not the capped visible Timeline) and
excludes every comparison pair crossing a recorded deploy, config, model,
incident, autonomy, or external change. A payload without that complete
calendar is amber `HISTORICAL ONLY`, never presented as change-filtered.
Registering by hand? Open the composer on that property and read the sentence;
it is the only place the number is derived, because a recorded calibration goes
stale and a derived one cannot.

A query-scoped composer calibrates from that **same query's** provider-final
daily `gsc/query` R2 series, loaded on demand through the private
`watchQueryHistory(input)` Service Binding RPC. It never borrows the already
loaded site series. The visual state names the exact query, retained archive
span, typical absolute move, ninetieth-percentile floor, and number of
coverage-valid adjacent comparisons. Until two baseline-length windows each
meet `WATCH_MIN_WINDOW_COVERAGE`, it stays visibly `UNCALIBRATED` and keeps 10%
as a documented starting point rather than presenting it as measured. A query
absent from an archived day is still missing, not zero.

**The same registration over the Service Binding** — `createWatchWindow(input)`
on the WorkerEntrypoint, for the Tower's composer. Same writer, same rules,
same `{path, code, message}` issues; a rejected field and an unknown asset come
back as results rather than thrown errors. The Tower is served unauthenticated
on the trusted LAN and must never hold the operator bearer, so the binding is
its capability. The Tower's door deliberately does **not** offer
`registered_at`: backdated far enough, a window's final check has already
passed, and its verdict would be read out of numbers the operator had already
seen. It does offer the one scope the evaluator can answer — an exact GSC query
— and rejects every other selector rather than widening it.

### What the daily job does

For each open window it evaluates every offset that has come due and has not
been read yet (a window registered long ago catches up in one run). Each check
compares two windows of equal length — the registered baseline, and the
baseline-length window ending on the check date — using each window's mean
daily value, so provider lag costing a day or two does not break the
comparison. Count metrics also carry their window sum; rate metrics (`ctr`,
`position`) do not, because a summed CTR is not a number.

- A **non-final** offset appends an interim reading to `readings_json` and
  leaves the window open. An interim reading whose offset is shorter than the
  baseline necessarily reaches back over the change; `pre_change_days` records
  exactly how far, which is why an interim reading is never a verdict.
- The **final** offset closes the window with an `outcome` and files a flag.

### Outcomes, and the honesty rules behind them

| Outcome | When | Flag |
|---|---|---|
| `ship_confirmed` | the registered ship predicate matched | `info` / `opportunity` |
| `kill_confirmed` | the registered kill predicate matched | `warn` / `anomaly` |
| `inconclusive` | no threshold was registered, neither matched, or both matched | `info` / `anomaly` |
| `unmeasurable` | the comparison could not be made at all | `info` / `anomaly` |

- **No verdict without a predicate.** With `thresholds` absent the window can
  only ever close `inconclusive`, with the numbers shown. The OS never invents a
  verdict it was not given.
- **Query scope never widens itself.** A GSC window with
  `scope_json = {"query":"…"}` reads the provider-final, one-day `gsc/query`
  objects already retained in R2 and compares only that query's daily rows.
  Missing/suppressed query days stay missing and therefore count against the
  same coverage threshold. Any malformed or unsupported scope closes
  `unmeasurable` with a note; the site-wide number is never substituted.
- **Thin coverage closes `unmeasurable`, never `inconclusive`.** A window needs
  observations on at least 80% of its days (`MIN_WINDOW_COVERAGE`); a zero
  baseline, an empty window, or one that is mostly holes is reported as
  unmeasurable. "We could not measure this" and "we measured it and it did
  nothing" are different facts and the ledger keeps them apart.
- **One provider resource per comparison.** Each site-wide aggregate records the
  `property_ref`s its counted days were read from (`properties`). A baseline and
  post window read from different properties, or a window whose own days mix
  two, closes `unmeasurable` with a note naming them. Rotating the credential
  for the same property is not a switch and evaluates normally.

### Surfacing — no new UI

A closing window inserts a flag with `rule_id = watch-window-closed`, the
watched metric, a message carrying the numbers, and `rule_inputs` holding the
full baseline/post arithmetic, thresholds, and window id. It therefore appears
on the asset's existing alert surfaces with zero new Tower code, and stays
auditable the same way every other fired rule is.

`signal_observations` is append-only and a provider revision appends a new row
for the same `(date, metric)`, so each date resolves to its **latest** run's
value — a window read after a GSC revision sees the revised number.

## Beads snapshots (the task hub photograph)

`POST /api/beads-snapshot` is how the beads task hub becomes readable by a
Worker. The hub is one Dolt SQL server on the operator's machine
(`config/beads.README.md`); the Tower is a Worker with no MySQL client. So the
local runner's poller (`scripts/os-up.mjs`) shells `bd` once a minute per spoke
and files what it saw here, and the Tower's read-only `/work` board renders the
newest row.

**Tasks are coordination state, not signals.** Nothing on this lane enters the
pulse envelope or the signal contract, and the table carries no `assets`
foreign key — see below.

Body: `{capturedAt?, projects: [...]}`. `capturedAt` defaults to now and may be
backdated (a tick that queued behind a slow `bd` still reports when it looked);
a **future** `capturedAt` is rejected, because it would sit at the top of the
board forever and make a dead poller look fresh. Each project is
`{asset, prefix, ok, error?, counts: {open, ready, inProgress, blocked,
closedRecent}, ready: [...], inProgress: [...], recentlyClosed: [...]}`, plus an
optional `recentlyCreated: [...]` (newest-filed work, for the Wall feed's "New
task") and an optional `createdAt` on every item.

There is **no idempotent re-post**. Two snapshots a second apart are two
observations of a changing hub, not the same event recorded twice, so every POST
of a changed board appends a row (an unchanged one moves the newest row's
`captured_at` forward instead). History is bounded by what is read: the Tower
reads only the newest row, and the Wall feed replays the photographs back to
6 PM the day before for tasks closed and filed. So the row a newer one replaces
keeps only each project's counts and those two lists, and the write deletes
everything older than **2 days** and reports how many rows it dropped. It is a
cache of a state that already lives somewhere durable — the hub, which has its
own nightly Dolt backup. The row just written is never pruned by its own
insert, however backdated: a write is not reported as successful and then
silently undone.

Two things the validator deliberately does **not** do, for the same reason — a
snapshot is a cache of a third-party tracker's state, and a store that rejects
the portfolio's real shape is worse than one that records it:

- **No `assets` FK.** The annotation and revenue lanes check the asset id
  because those rows are evidence about a property. An asset id that has drifted
  out of `config/beads.json` should surface on the board as an unrecognized
  project, not cost the other projects their snapshot.
- **No status enum.** `bd` ships seven statuses and lets an operator add custom
  ones (`bd config set status.custom`); encoding that list here would turn a
  `bd` config change into a 422 on a lane that is only writing down what it saw.

What it *does* enforce is shape and size: types, bounded lists (≤64 projects,
≤50 items per list), and capped strings. Two consistency rules have teeth,
because both are ways a failure would quietly look healthy: a project with
`ok: false` may not also carry issues, and it must carry an `error`.

### `panelReview` — SERP-panel triage state

Each project may carry `panelReview`, the property's standing on reading its
last SERP panel ([docs/08 §S1b](../../docs/08-seo-geo-signals.md)): the open
`panel-review` task, or — when the triage is done — the most recently closed
one.

```jsonc
"panelReview": {
  "beadId": "nw-4q2",
  "panelDate": "2026-08-02",          // the collection's report_date
  "dueAt": "2026-08-09T00:00:00.000Z",
  "status": "open",                   // open | closed — never bd's vocabulary
  "closedAt": null                    // set only on a closed review
}
```

**Three-valued, and the two absences are different answers.** The key **absent**
means this poller did not look; **`null`** means it looked and the property has
no review task at all. Collapsing them would let "we never asked" render as
"nothing to triage". `status` is deliberately not `bd`'s: `in_progress`,
`blocked` and `deferred` are all ways of not having triaged the panel yet, and
a card asking "has this been read?" gets a two-valued answer. An **open** review
carrying a `closedAt` is rejected rather than stored — it is a contradiction,
not producer skew.

## Job runs (proof that the scheduled lanes fired)

`POST /api/job-runs` is how "did the crons run?" stops being a claim.

**One writer, and it is the runner.** `scripts/os-up.mjs` fires every lane on
this machine and records each firing to `.local/logs/job-runs.jsonl` first,
always — because it is the only witness to a lane that fires while this Worker
is down, and a record that needs the ingest up cannot testify about an ingest
that was not. This route is the mirror: disk first, ship when the door answers,
catch up afterwards. A second writer would be a second opinion about whether a
lane fired.

Body: `{runs: [{job, startedAt, ms, outcome, detail?, scheduledAt?}]}`, up to
**500** firings per POST. `job` is the lane verbatim (`backup`,
`beads-snapshot`, `cron 45 12 * * 1`) and is deliberately not an enum — the lane
list lives in the runner and changes with it. `outcome` **is** an enum
(`ran | skipped | failed`): that vocabulary is the OS's own, so a fourth value is
a producer bug, not a tracker somebody reconfigured. `ms` is the measured
duration and the store derives `finished_at` from it once, so it can never hold
two timestamps that disagree with the duration between them. `scheduledAt` is
null today: the runner fires on the tick.

**Idempotent on `(job, startedAt)`.** The runner cannot know which records got
through — a restart re-seeds its queue from the disk file — so re-posting is
the normal case. A duplicate is dropped and counted
(`{received, created, duplicate, stale, pruned}`), never a 422: a producer
punished for re-sending would learn to forget instead. One malformed firing does
fail the whole batch, because storing the readable half would leave the record
with holes nobody can see. A firing older than the **30-day** window is accepted
and not stored (`stale`) — inserting a row its own insert would sweep is a write
reported as successful and silently undone. The mirror cannot outlive the
record it mirrors, since the runner can only ship what its own 30-day file
still holds.

**What asset #0 makes of it** (`src/job-runs.ts` `cronRunSuccessValue`), three
states because two would lie:

| Record says | `cronRunSuccess` |
|---|---|
| Nothing at all — no rows | **absent**: the metric *and* its capability are omitted from the envelope. Nothing observed is not success, and `capabilities` means what the asset can actually observe. |
| Every lane's latest firing `ran` or `skipped`, something within a day | `1` |
| Any lane's latest firing `failed` | `0` — regardless of age: a failed lane stays failed until a later firing of that lane says otherwise. |
| Nothing has fired for 24h | `0` — the record only grows while the runner is alive, so a dead runner would otherwise freeze it on the last healthy row and report `1` forever. |

A `skipped` firing is **not** a failure. A poller standing down because this
Worker is restarting has not failed, and counting it as one would make every
restart a cron incident — but it is still recorded, because a lane that stood
down every tick for a week is a finding and looks identical to a healthy one in a
log.

## SERP panel landings (what the review filer reads)

`GET /api/serp-panel-landings` answers one question: **which properties have a
collection worth triaging?** It writes nothing.

```jsonc
{ "windowDays": 21,
  "landings": [
    { "asset": "example.com", "panelDate": "2026-08-03",
      "landedAt": "2026-08-03T12:45:00.000Z", "status": "success",
      "panel": false, "queries": null, "families": 5 },
    { "asset": "example.org", "panelDate": "2026-08-03",
      "landedAt": "2026-08-03T12:47:31.000Z", "status": "success",
      "panel": true, "queries": 6, "families": 6 }
  ] }
```

It reads the report runs (`noticeos.archive_runs`) the weekly collector already
writes (`integration = 'dataforseo'`, every report family), so nothing new is
recorded for this lane — and that is what makes the runner's filer idempotent:
it re-derives the same `(asset, panelDate)` pair every pass, with no cursor to
lose. Rows are grouped into one landing per (property, collection day) and ranked
by day, so a re-archive of an older collection cannot promote it. `error` rows
are excluded — nothing landed, and asking somebody to triage an empty archive
would be the OS inventing work; `unchanged` rows count, because the archive holds
that day's collection either way, and a day is only reported `unchanged` when
every family that landed was. The 21-day window is three weekly collections: wide
enough to catch up a runner that was down for a fortnight, narrow enough that a
collector broken for a month does not eventually hand somebody a stale result
page.

**The S1b panel is one family of the collection, not the question.** `panel`
says whether the tracked-query panel was among the families — the filer uses
it to word the task and to decide whether it is asking for the panel walk —
and `queries` sizes that panel, `null` when there was none. `families` is how
many report families landed that day. The `panelDate` field keeps the panel
vocabulary on purpose: the review task's metadata key is `noticeos_panel_date`
and that is a contract with the Tower's rendered marker, so one word for one
thing beats a wire field that disagrees with the metadata it becomes.

## Research log (never buy the same answer twice)

`POST /api/research-log/lookup` — has this exact question already been bought?
`POST /api/research-log` — record a paid provider call.

The weekly collector cannot buy the same answer twice: every family carries a
cadence and the freshness filter proves the last landing from durable manifests
before it spends. Ad-hoc research — the `dataforseo` skill's `.mjs` callers and
anything an agent runs in a session — spends from the same account, so the
question is recorded here.

The cap gate sums both the collector's manifests and this log for month-to-date
spend; rows the collector wrote for itself are excluded by `actor` so nothing
is billed twice. That arithmetic lives in `loadMeteredDataSpend`
(`packages/contract/src/metered-spend.ts`) and nowhere else: this gate and every
Control Tower spend meter — `/health`, `/settings`' budget meter, the DataForSEO
card's budget line, the Wall's daily pace — call the same body, so the number
that fails the portfolio closed is the number the operator is shown.

### Ask before you buy

```sh
curl -sS -X POST http://127.0.0.1:8787/api/research-log/lookup \
  -H "authorization: Bearer $OPERATOR_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"provider":"dataforseo",
       "endpoint":"dataforseo_labs/google/keyword_overview/live",
       "params":{"keywords":["dri calculator"],"location_code":2840}}'
# {"found":true,"windowDays":30,
#  "prior":{"asset":"example.com","ageDays":9,"costUsd":0.02,
#           "objectKey":"raw/dataforseo/…","actor":"claude-opus-5",
#           "boughtAt":"2026-09-15T10:00:00.000Z", …}}
```

**The lookup decides nothing.** It reports a prior purchase and its age; the
caller reuses or re-buys and says which out loud. A route that answered
"don't buy this" would be making a spending decision from behind a cache, and a
caller that silently skipped a call is indistinguishable from one that forgot to
make it.

`windowDays` defaults to 30 and is overridable per call — a live SERP changes
hourly and is stale at two days, whatever the default says.

### Record what you bought

```sh
curl -sS -X POST http://127.0.0.1:8787/api/research-log \
  -H "authorization: Bearer $OPERATOR_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"provider":"dataforseo",
       "endpoint":"dataforseo_labs/google/keyword_overview/live",
       "params":{"keywords":["dri calculator"],"location_code":2840},
       "question":"keyword overview, 1 term, US/en",
       "costUsd":0.02,"asset":"example.com","actor":"claude-opus-5"}'
# {"recorded":true}
```

`asset` is optional — portfolio-level research (a market scan, a competitor
nobody owns yet) has no property — but a value that is not a real asset id is a
422 rather than a ghost in every per-property read.

### The two rules the shape enforces

- **The grain is the question and it points at the answer.** `object_key` is an
  R2 key; no response body is ever stored. A log that carried results would be an
  unversioned cache competing with the immutable archive for the truth.
- **The hash is order-independent over keys and order-sensitive over arrays.**
  `{a,b}` and `{b,a}` are one question; `['volume,desc']` and `['volume,asc']`
  are two, and so are two keyword lists in different orders. A canonicaliser that
  sorted arrays would collide questions that genuinely differ and hand back the
  wrong answer.

## Panel source (what the local scripts read)

`GET /api/panel-source?asset=<id>&windowDays=<n>` and
`GET /api/panel-object?key=<objectKey>` exist so the standing panel refresh
(`scripts/signal-panels-refresh.mjs`, [doc 20](../../docs/20-signal-panels.md))
never has to open the central store itself.

```jsonc
{ "asset": "example.com", "from": "2026-06-29", "windowDays": 35,
  "manifest": [
    { "integration": "gsc", "report": "query", "reportDate": "2026-08-01",
      "finishedAt": "2026-08-02T12:15:00.000Z",
      "objectKey": "signals/…json.gz", "contentSha256": "…",
      "providerRows": 31, "providerTruncated": 0 }
  ],
  "trend": [
    { "date": "2026-08-01", "integration": "gsc", "metric": "clicks",
      "value": 12, "provisional": 0 }
  ] }
```

These Node callers use the ingest API for Postgres metadata and R2 objects.
Local R2 metadata belongs to one workerd runtime; starting another over the same
persistence directory is unsafe. `scripts/no-second-runtime.test.mjs` protects
that boundary.

Both halves are read-only and never call a provider: the archives were bought by
the `15 12 * * *` and `45 12 * * 1` collectors, so a refresh pass costs **$0.00**
against `monthly_caps.data_usd` no matter how often it runs.

`manifest` is the same revision resolver the downloader reads through — newest
surviving revision per `(integration, report, report_date)` — so two revisions of
one day can never both land on disk. `trend` is `signal_observations` joined to its run,
newest run per `(integration, date, metric)`, with `provisional=1` on any date at
or after the run's `provisional_from`: a day the provider had not finished
reporting is carried and marked, never dropped, because dropping it renders as a
cliff.

`panel-object` requires the key to appear in `noticeos.archive_objects`. That membership
check is the whole authorization model beyond the bearer — the caller may read
archives the OS collected and nothing else that happens to live in the bucket. A
manifest row whose object is gone answers `404` rather than an empty body: an
empty archive would flatten into a CSV that reads as a real zero.

### The hand downloader's manifest

`GET /api/signal-archives?asset=<id>[&from=&to=&integration=&report=]` is the
same resolver behind `pnpm signals:download`, and it is a separate route because
the two questions differ where it matters. The refresh asks *what landed inside
my window* and wants the trend series with it; an operator asks *give me GSC for
July*, names an explicit range **or none at all**, and never wants the series.
Folding them together would mean either a window imposed on the hand lane —
silently dropping the history it asked for — or a trend query computed over the
whole archive for a caller that throws it away.

```jsonc
{ "asset": "example.com",
  "filters": { "from": "2026-07-01", "to": null, "integration": "gsc", "report": null },
  "manifest": [ /* same rows as panel-source */ ] }
```

A malformed filter answers `400 invalid_filter` rather than being ignored: an
operator who mistyped `--from` must not be handed a wider answer than they asked
for and left to notice. The vocabulary is *not* pinned — `integration=llmwatch`
is a well-formed filter that matches nothing, which is the true answer.

## Insight snapshots (the executive publish)

`POST /api/insight-snapshot` (operator bearer) is how a reviewed
`executive.json` crosses into `noticeos.asset_insight_snapshots` — the
compact presentation boundary the Tower's property page reads. The caller is
`pnpm signals:publish-insights`, which writes through this route so that the
one runtime that owns the store does the write.

The body is the snapshot itself, and it is stored **verbatim**:

```bash
curl -sS -X POST http://127.0.0.1:8791/api/insight-snapshot \
  -H "authorization: Bearer $OPERATOR_TOKEN" \
  -H 'content-type: application/json' \
  --data-binary @.local/signal-dumps/analysis/example.com/executive.json
```

- **Content-addressed over the stored bytes.** `contentSha256` is the SHA-256 of
  the exact payload written, and `id` is `insight:<asset>:<first 24 hex>`. So an
  identical re-publish is provably the same row: `201 {created:true}` the first
  time, `200 {created:false, duplicate:true}` after. Normalizing the payload (the
  way the beads-snapshot lane deliberately does) would change the bytes the hash
  names, and the id would stop meaning *this exact analysis output*.
- **Validated, not interpreted.** `schemaVersion`, `asset`, a non-future
  `generatedAt`, the window pair (both bounds or neither, in order), a whole
  `sourceArchiveCount`, and a bounded `items` array — the shape the Tower's
  reader assumes and the constraints the table declares. The *findings* are the
  analyzer's business and are stored whole. An unknown asset is `422
  unknown_asset`, not a raw FK failure; a body past `INSIGHT_PAYLOAD_MAX_BYTES`
  is `400`.
- **`--remote` is refused.** The publisher reaches the installation's Postgres
  store through its ingest API (`--door`).

## Asset state (the two editable columns)

`GET /api/asset-state?asset=<id>` and `POST /api/asset-state` (operator bearer)
are how `pnpm config:apply` reaches the store. A changeset carries file edits —
that script's own business — and `store-asset-set` ops, which are these columns:

```bash
curl -sS http://127.0.0.1:8791/api/asset-state?asset=example.com \
  -H "authorization: Bearer $OPERATOR_TOKEN"
# {"asset":"example.com","known":true,
#  "columns":{"status":"onboarding","sense_only":0},"updatedAt":"…"}

curl -sS -X POST http://127.0.0.1:8791/api/asset-state \
  -H "authorization: Bearer $OPERATOR_TOKEN" -H 'content-type: application/json' \
  -d '{"asset":"example.com","column":"status","value":"baselining"}'
# {"updated":true,"asset":"example.com","column":"status","value":"baselining","updatedAt":"…"}
```

- **Two columns, two pinned statements.** `status` and `sense_only` are what
  [db/README](../../db/README.md) sanctions as mutable; the rest of an asset row
  is identity, a label, or entity metadata. The column name arrives in an
  untrusted body, so no SQL is built from it — each sanctioned column has its own
  literal statement, chosen by exact match. Anything else is `422` naming the two.
- **Values are checked against the table's own CHECKs**: `status` ∈ the
  lifecycle enum, `sense_only` ∈ {0,1}. An unknown asset is `422 unknown_asset`.
- **An unknown asset reads as `200 {known:false}`.** The read exists to answer
  the changeset's `expect` guard — *what is there now?* — and *nothing* is an
  answer to that. `config:apply` renders it `(absent)`, reports the op as a
  mismatch and tells the operator to re-stage; a 404 would abort the run with a
  transport error instead of the diff they can act on.
- **One op per request.** The CLI resolves every op against reality and refuses
  the whole changeset on any mismatch, then applies them one at a time. Batching
  here would move that all-or-nothing decision into this Worker, which cannot
  roll back the file edits in the same changeset.
- **`updated_at` is stamped by the runtime**, not the caller: it is metadata
  about when the store changed, and the store is here.
- **`--remote` is refused**, as the publish lane refuses it.

## Credential store (one key, every provider)

`src/credentials.ts` (the store + resolver) and `src/credential-probes.ts` (the
connection tests), over `noticeos.integration_connections` and
`noticeos.connection_secrets` ([Postgres model](../../db/postgres/README.md#the-decided-model)).
Save writes the next secret version and removes the previous version in the
same transaction; it never rewrites ciphertext in place. The connection's
public facts are columns, with field names and covered site ids on the secret
version ([model](../../db/postgres/model.json)).

A provider is connected in the product, and the environment holds only the
three bootstrap secrets
([doc 06](../../docs/06-operations.md#bootstrap-secrets-vs-integration-credentials));
the provider bindings that remain are the legacy fallback for installs that
have not moved, which is not deprecated and does not have to be.

**`CREDENTIALS_KEY` — the bootstrap secret this store needs.** 32 bytes, base64:
`openssl rand -base64 32`, then `.dev.vars` locally (or `.dev.secrets.json`,
which compiles to it) or `wrangler secret put CREDENTIALS_KEY` deployed.
Without it, credential *writes* and *reads of stored rows* refuse with a
sentence that names both — and the collectors keep running on the env bindings,
because an install mid-move must not go dark. Deleting a credential works
without the key on purpose: removing a secret you can no longer read is exactly
what a lost key calls for.

**Store first, env second, all or nothing.** A provider with a stored row is
served entirely from the store; one without falls back entirely to its bindings.
The two are never mixed — a stored DataForSEO login paired with an env password
would produce a 401 nobody could explain — and the write path refuses an
incomplete credential, so a stored row is complete by construction.

**What the run records.** `signal_runs.credential_ref` gains a `store:` prefix
when the product's credential served the pull (`store:BING_WEBMASTER_API_KEY`),
and keeps the bare binding name when the env did. So "the collectors are still
on `.dev.vars`" is a fact you read rather than one you assume.

**What stamps `last_used_at` / `last_ok_at` / `last_error`.** The scheduled
collectors (Google signals, Bing signals, the DataForSEO sweep) and the
connection test — once per run, about the credential rather than about coverage:
a service account that minted a token and returned rows for *anything* is a
working credential, and one property's failure is that property's story. The
polled display reads deliberately do not stamp: GA4 realtime runs every 30
seconds and the calendar every 60, and a status column is not worth two writes a
minute.

**The security boundary is a return type.** `listCredentialSummaries()` answers
field names, timestamps and the last verdict — never a value, for any provider,
`secret: true` or not. `putCredential()` answers a summary rather than an echo,
the Tower's `PUT` answers `204` with no body, and a probe's message is assembled
from counts. A test greps every response, every summary and every captured log
line for a fixture secret and fails if it appears
(`test/credentials.test.ts`).

**Crypto.** AES-GCM, 12 fresh random IV bytes on every write (reusing a nonce
under one key breaks GCM outright, which is why there is no patch-one-field
path — a change re-seals the whole fields object), and a `key_version` column
recording which generation of the bootstrap key sealed each secret version.

### Rotating `CREDENTIALS_KEY`

`pnpm creds:rotate-key` re-seals every stored credential under a new key, one
connection at a time, by replacing its secret version, and prints counts.

**It is a local-host operation, and only that.** The sweep runs inside the
ingest Worker, and the only way anything in this repo can ask it to run is the
loopback door the runner opens on `127.0.0.1:8791` inside the app container. A deployed ingest Worker
has that route too, and no operator-facing address for it: the Worker has no
listener of its own, and the Tower's proxy is compiled out of a production
build by `__RUNNER_LANE__`
([`apps/tower/shared/runner-lane.ts`](../../apps/tower/shared/runner-lane.ts)).
`--ingest <origin>` exists for one reason — pointing this client at a different
local door (a second checkout, a non-default port) — and it is not a remote
path: the token it presents comes from this machine's
`workers/ingest/.dev.secrets.json`, and there is nothing on the other end of a
public URL that would answer it.

**What a deployed install does instead: re-seed, not rotate.** Put the new
`CREDENTIALS_KEY` in with `wrangler secret put`, then open `/integrations` and
reconnect each provider from its source system. Every row sealed under the old
key becomes unreadable and is named as such rather than deleted, so the record
of what was connected survives; what you are re-entering is the secret itself.
Building a remote sweep means giving that route an address and an
authentication story of its own — a trust surface, therefore operator-only work
(auth is forbidden-class, `AGENTS.md`).

The runbook below is the local one.

**Two keys have to be readable at once**, and that window is the whole
operation: `CREDENTIALS_KEY` is the new one, `CREDENTIALS_KEY_PREVIOUS` is the
one the rows are currently sealed with. Every read tries the current key and
then the previous one, so nothing goes dark mid-sweep — a collector that
fires while half the table has moved resolves either half.

```sh
# 1. generate the new key
openssl rand -base64 32

# 2. in workers/ingest/.dev.secrets.json:
#      CREDENTIALS_KEY_PREVIOUS = the CURRENT value of CREDENTIALS_KEY
#      CREDENTIALS_KEY          = the new value
# 3. the Worker has to see both bindings
pnpm os:restart

# 4. the sweep
pnpm creds:rotate-key

# 5. remove CREDENTIALS_KEY_PREVIOUS, then
pnpm os:restart

# 6. press Test connection on each card at /integrations
```

Steps 2, 3 and 5 are the operator's: this repo never edits a secrets file it
was not asked to, and `os:restart` is operator-directed (`AGENTS.md`).

- **The sweep runs inside the Worker**, behind
  `POST /api/credentials/rotate-key` (operator-authed, and reachable only
  through the loopback ingest door). It is not a Node script over the same
  Postgres store, because such a script would have to decrypt in Node — a
  second place the plaintext exists, which is the one thing this store does not
  allow. `creds-rotate-key.mjs` sends a POST and prints what came back.
- **Atomic per connection, and resumable.** Each replacement is one transaction
  that inserts the next `secret_version` and removes the previous one, guarded
  on the version read still being current. A Save on the Integrations page
  mid-sweep loses no work (it is named in `contended`; run the command again).
  A pass that stops halfway leaves connections sealed under both keys, which
  the two-key read handles. A second run finishes at the key generation
  already chosen instead of increasing it again.
- **A row neither key can open is named, never dropped.** Its bytes and its
  version are left exactly as they were, and the operator reconnects that one
  provider from its source system. Deleting it would destroy the only record
  that the provider was ever connected.
- **It refuses without `CREDENTIALS_KEY_PREVIOUS`**, with the sentence that puts
  you in the window. A pass that "succeeded" by re-sealing everything under the
  key it was already using would be a command reporting work it did not do.
- **`updated_at` and the verdict columns do not move.** A rotation is not
  something the operator did to the credential, and a card reading *Stored 2
  minutes ago* for a secret nobody touched would be a lie. What the credential
  proved is still true; only the lock on the box changed.
- **The stamped version is the table's, not the build's.** After a rotation
  every later `putCredential` stamps the generation the table reached — otherwise
  the next Save would put the table straight back into the split state the
  rotation just resolved.

**Probes** run the cheapest authenticated read each provider offers, free where
there is a free tier, and persist nothing:

| Provider | Call |
|---|---|
| `google` | a read-only token per scope → Search Console `sites.list` → GA4 `properties/{id}/metadata`. No day of data, no reporting tokens spent. Identical for both ways in (see below); only the refusal's instruction differs |
| `google-oauth-app` | a shape check and no network call: no free Google call proves a client id and secret without a person walking a consent screen, so the honest verdict is *looks right, now sign in* rather than a green tick nobody earned |
| `bing-webmaster` | `GetUserSites` |
| `dataforseo` | `appendix/user_data`; free, and reports the credit remaining |
| `calendar` | one bounded GET per feed, reported **by label** — the url is the credential |

**Moving the operator's existing secrets:** *Import from this machine* on any
Legacy env card reads `.dev.secrets.json`, asks the running Tower for the
provider catalog, and PUTs each complete provider once. A provider missing a
required binding is skipped with its reason rather than half-imported. The
button is answered by a dev-server-only lane
(`apps/tower/vite/env-import-lane.ts`) that calls `importDevSecrets` in
process; there is no import command. A deployed Tower has no secrets file, so
it answers that path with `importable: false`.

**The migration is operator-only** (`AGENTS.md`), so this code runs before the
table exists. Every read degrades to "nothing stored"; a write answers
`store_unavailable` with the apply command, because a Save that silently did
nothing is the worst outcome available.

### Two ways in for Google

Google can be connected by **signing in** as well as by pasting a
service-account map, and both stay valid. This section is how the sign-in is
built; the operator's steps are the
[Connect Google](../../docs/guides/connect-google.md) guide, and its cost,
quota and failure modes are in
[doc 11](../../docs/11-integrations.md#connecting-google).

- **`google-auth.ts` is the one door.** `googleAccessToken(auth, scope, …)`
  either signs a JWT assertion (service account) or spends the refresh token
  (OAuth), and every collector — the daily pull, the realtime read, the archive
  lane, the probe — asks through it.
  - A service-account token is minted **per scope**; an OAuth token carries the
    whole granted scope set at once. Callers pass a scope either way and the
    difference stays in that module.
  - `refreshGoogleAccessToken` raises **`google_oauth_revoked`** on Google's
    `invalid_grant` rather than a generic HTTP failure, because "reconnect the
    card" and "check the property grant" are different instructions. The
    sentence that reaches `last_error` and the card is
    `GOOGLE_OAUTH_REVOKED_MESSAGE`, a constant, never text derived from a
    request that held a refresh token; `probeCredential` keeps it a refusal
    with a sign-in fix rather than rewording it as an unreachable network.
  - A provider 401 is retried **once** with a fresh token, and the fresh token
    is shared by the rest of that account's properties. A pull over a large
    portfolio can outlive an hour-long token; anything that answers 401 twice is
    a credential problem, and retrying again would be a burst against Google.
- **The round trip.** `GET /api/integrations/google/oauth/start` → 302 to
  Google · `GET /api/integrations/google/oauth/callback` → 302 back to
  `/integrations?connect=google&google=<result>`, the connect panel
  (`apps/tower/worker/integrations-oauth-route.ts`; a hosted build's start is a
  POST that answers the consent URL as JSON). The Tower carries an origin in
  and a redirect out: the authorization URL is built here (it needs the client
  id), the code is exchanged here (it needs the secret), and the refresh token
  is sealed into the store here. No token, secret or signing key crosses the
  Service Binding. A self-hosted install's `client_secret.json` is checked in
  the Tower (`apps/tower/shared/google-client-file.ts`: anything but a web
  client is refused, and a redirect list without this address is named) before
  its id and secret are stored as `google-oauth-app`.
- **The redirect URI is derived from the origin the browser is on**
  (`googleOAuthRedirectUri`, `packages/contract/src/google-oauth.ts`), never
  configured: a configured copy would be a second answer, and the one that lost
  would produce `redirect_uri_mismatch`. Google refuses plain http on any host
  but loopback, so `googleRedirectVerdict` answers `redirect_unusable` for a
  LAN address before Google can, and the panel offers `googleLoopbackOrigin`.
- **`google-oauth.ts` owns the flow** — the signed state, the authorization URL,
  the code exchange, the revoke, and the two free list calls behind
  `discoverGoogleProperties()`. The state is signed, not stored (a nonce table
  would be a migration): an HMAC over a nonce, a ten-minute expiry
  (`GOOGLE_OAUTH_STATE_TTL_MS`) and *the redirect URI it was minted for*, so a
  state minted at one origin cannot be replayed at another. It is keyed by an
  HKDF of `CREDENTIALS_KEY` (`credentialSigningKey`, domain-separated from the
  encryption key rather than reusing it). A state that does not check out never
  reaches Google's token endpoint.
- **Start refuses another page's navigation; the callback cannot.** Start
  answers 403 to a `cross-site` or `same-site` `sec-fetch-site` (login CSRF is
  how an attacker connects *their* Google account to somebody else's OS); the
  callback arrives from accounts.google.com and is defended by the state.
- **`access_type=offline` + `prompt=consent`**, together, are what guarantee a
  refresh token: Google issues one only on a fresh consent. A grant missing
  either read scope (`analytics.readonly`, `webmasters.readonly`) is refused as
  `scope_incomplete` and nothing is stored, because the consent screen lets an
  operator untick a box and a half-scoped credential would fail one lane a day
  later with a 403.
- **The seven-day assumption.** A Testing-mode consent screen expires every
  refresh token seven days after it is granted, and Google publishes no API that
  says whether a screen is published. The exchange therefore records
  `expires_at = connected_at + GOOGLE_TESTING_GRANT_DAYS` with
  `expiry_source = 'flow'` on `noticeos.integration_connections`; the
  operator's *it does not expire* sets `expiry_source = 'operator'`, and
  `carriedExpiry` (`credentials.ts`) keeps that answer through every later
  sign-in.
- **Discovery is a listing, not evidence.** `discoverGoogleSites`
  (`credential-probes.ts`) lists every GA4 property, matched to a host by its
  web data stream's default address (one free Admin API read for each of the
  first fifty), and every Search Console site; an unverified Search Console
  site is listed, never ticked. **Start** writes each site's own mapping, which
  one resolver reads (`lane-mapping.ts`), and runs the Google step for the
  named sites. A sign-in with nothing mapped collects nothing and logs
  `google_signals_no_properties_mapped` once per pull; how the older account
  map is shadowed by the mappings is under
  [Google signals](#google-signals-ga4--gsc).
- **The public facts.** The Google account, granted scopes and sign-in time
  are columns of `noticeos.integration_connections`; field names and covered
  site ids are on the current `noticeos.connection_secrets` version
  ([model](../../db/postgres/model.json)). In the clear, deliberately:
  `deleteCredential` and `listCredentialSummaries` both answer without the
  bootstrap key, so anything the card renders has to live outside the
  ciphertext or it disappears exactly when a rotated key makes it most needed.
- **`putCredential` replaces rather than merges**, with one narrow exception: a
  `managed` field (contract — today only the refresh token) survives a write
  that does not name it. No form can send one, so an input that omits it is not
  a statement that it should go — and without this, pasting a service-account
  map on a signed-in card would silently orphan a live grant at Google that
  this OS could no longer revoke.
- **`disconnectCredential` (credential-probes.ts) revokes, then deletes.** The
  order matters: once the row is gone there is no token left to revoke with.
  The revoke is best effort and never blocks the delete, so a revoke that fails
  leaves the grant for the operator to remove at Google. It lives
  beside the probes rather than in `credentials.ts` for the same reason the
  probes do — the store knows nothing about providers, and a Google client
  imported back into it would be an import cycle.

## On-demand collection (a baseline on the day the bet launches)

`POST /api/signal-collect` (operator bearer) collects **one** property's
DataForSEO families now, so a bet that launches on a Tuesday has a baseline on
Tuesday without running the whole Monday lane for every property.

```bash
curl -sS -X POST http://127.0.0.1:8791/api/signal-collect \
  -H "authorization: Bearer $OPERATOR_TOKEN" -H 'content-type: application/json' \
  -d '{"asset":"example.com","families":["serp-panel"]}'
# {"collected":true,"asset":"example.com","families":["serp-panel"],
#  "attempted":1,"succeeded":1,"unchanged":0,"failed":0,"costUsd":0.184,
#  "retried":[],"outcomes":[{"report":"serp-panel","reportDate":"2026-08-04",
#   "status":"success","providerRows":46,"objectKey":"raw/dataforseo/…",
#   "costUsd":0.184,"retries":0,"errorCode":null}]}
```

`pnpm signals:collect -- --asset example.com --families serp-panel` is the same call
with a summary — see [scripts/README](../../scripts/README.md#collect-one-property-now-signalscollect).

- **It is not a second collector.** The body becomes a scope and
  `runDataForSeoDumps` — the function the cron calls — does the work, with the
  same breadth-first plan list, the same per-family retry budget, and the same
  fail-closed `$0.25` reserve against `monthly_caps.data_usd`. A scope narrows
  the *plan* and nothing else, so an on-demand landing writes the manifest row,
  the R2 object and the recorded cost the Monday lane would have written for that
  property. The ingest suite pins that: same clock, same provider answers, the
  two rows are equal on every field and the archives are byte-identical. Nothing
  downstream — the panel-review filer, `signals:refresh`, the lane evidence, the
  review loop — needs to know which door a run came through.
- **It can only reach what the sweep reaches.** The asset is matched against the
  collector's own membership query (launched, non-OS, has a domain), with the id
  bound rather than interpolated. A property outside it is `422 unknown_asset`
  with the *reason* — not in the store, still pre-launch, the OS itself, no
  domain — because those are different mistakes.
- **A family a property does not own is `422`, never a silent skip.** `families`
  is validated against the collector's exported family list, and then against
  what that property is actually due. Asking for `serp-panel` for a property
  `config/serp-panel.json` does not name answers `422 family_unavailable`
  naming the file and listing what *is* available. The portfolio sweep is right
  to skip such a family quietly; a request somebody typed is not.
- **The cap outranks the request.** The gate reserves one report's worth before
  each family, so an on-demand run cannot be the hole in the monthly cap. A
  refusal is `200` with a `budget_exhausted` attempt row, exactly as the sweep
  records it.
- **`200`, not `201`.** What comes back is a report of a run — attempted,
  succeeded, unchanged, failed, `costUsd` to six decimals, `retried` — and it is
  the same report whether everything landed or the cap refused it all. A failed
  family is an outcome with a price, not a transport error; `signals:collect`
  exits non-zero on any of them.
- **Re-firing the same day is cheap but not free.** Identical content is stored
  as `unchanged` against the existing object, so the archive does not duplicate —
  but the provider calls were still made and still billed.
- **A panel takes minutes.** The tracked panel is one provider call per
  **(tracked query, device)**, so the request is held open for a few minutes.
  The term list is `config/serp-panel.json`; never divide this number to
  recover it. Narrow with `families` to pay for the one thing you came for.
- **One collection at a time, and the second one is refused, not queued.**
  Because a panel run holds the request open for minutes, a client that times
  out leaves the run going server-side with nothing on screen — and firing
  again is the honest reaction. Two runs would bill the same families twice:
  the archive dedupes identical content as `unchanged`, but every provider call
  is made and every manifest row carries its `provider_cost_usd`, and the cap
  gate reads month-to-date spend once per run so neither sees the other's
  reservations. So `runDataForSeoDumps` holds a lane — claimed before its first
  `await`, released in a `finally`, and covering the Monday cron, the runner's
  `runScheduled` RPC and this route alike, because it lives inside the collector
  rather than in any caller. A trigger that finds the lane busy spends nothing;
  the route turns that into `409 collection_in_flight` naming what is running.
  The lane cannot wedge shut: the marker is module state, so a restarted runtime
  starts with it empty, and a run that never returns holds it for at most a
  15-minute lease — the Monday cron runs next Monday whatever happened before it.
  It is not a distributed lock; it serializes because the ingest runs as one
  auxiliary Worker inside the Tower's single runtime. A deploy to Cloudflare
  proper would put `scheduled()` and `fetch()` in separate isolates and need a
  durable holder instead.
- **It arms on the app's next start** (`pnpm os:update`, or `pnpm os:restart`
  on live source), like every route change: the runtime
  loads the Worker at startup.

## Hygiene guards (S5 — the served layer)

[docs/08](../../docs/08-seo-geo-signals.md) §S5 guards what a crawler actually
*receives*, which no other lane can see: a home page serving a few dozen words
of static HTML with every dashboard green, AI-crawler access one `robots.txt`
line from being revoked, a sitemap outage that surfaces weeks later as a Search
Console notification. `src/hygiene.ts` runs the checks nightly at 04:00 UTC and
stores one row per `(asset, check, day)` in `hygiene_checks`.

**Who is swept:** every asset with a domain that is not `retired` and not asset
#0. Pre-launch properties are included — observing them is Sense, and a
pre-launch property is exactly where a robots block sits unnoticed. Asset #0 is
excluded because the OS cockpit has no crawl surface to guard, and including it
would mean a permanent "no sitemap" warn on the OS row.

**Cost:** six requests per property on a healthy night — three site-level
(`robots.txt`, the home page, the sitemap) and **three sampled real pages**.
`robots.txt` is fetched **once** and shared by the robots check and the sitemap's
URL resolution; the sitemap's URL list is handed to the page sample rather than
re-fetched. No check can disagree with another about what the property served.

### The four checks

| Check | What it stores | Flags (`warn`/`anomaly`) when |
|---|---|---|
| `html-depth` | words of visible text on `https://<domain>/` | today ≤ **50%** of the median of the last **14 healthy readings**, and at least **7** exist |
| `robots-ai-access` | resolved allow/deny per watched bot + a SHA-256 of the file, **plus the directives on three sampled pages** | a bot **allowed in the previous reading** becomes disallowed; `robots.txt` goes present → absent; or a sampled page that was clean in the previous reading now carries a closing directive |
| `sitemap` | `<loc>` count | unreachable, unparseable, or count ≤ **50%** of the last healthy count **when that count was ≥ 50 URLs** |
| `page-structure` | title / meta description / `<h1>` count / canonical on the **same three sampled pages**, and how many were read | a sampled page that was **structurally clean in the previous reading** now carries a fault |

**Five rules, three fetches.** Two checks answer two questions from one fetch, so
each carries two rule ids:

- `html-depth` → `hygiene-html-depth` (the page is thin) and
  `hygiene-home-unreachable` (the page is not there). Disjoint outcomes — depth
  needs a body it counted, reachability needs the absence of one — so a night can
  never produce both, and the depth rule keeps its single sanctioned trigger.
  Reachability needs no baseline, so unlike the depth flag it retracts the moment
  the page answers again, armed or not.
- `robots-ai-access` → `hygiene-robots-ai` (the site-level file) and
  `hygiene-page-directives` (`<meta name="robots">` and `X-Robots-Tag` on real
  pages). Two levels, two rules, because they are two different regressions with
  two different fixes: one is a `robots.txt` line, the other is a template. An
  operator should never have to read the message to learn which they have.

Rule ids: `hygiene-html-depth`, `hygiene-home-unreachable`, `hygiene-robots-ai`,
`hygiene-page-directives`, `hygiene-sitemap`. Watched bots: `GPTBot`,
`OAI-SearchBot`, `ChatGPT-User`, `ClaudeBot`, `anthropic-ai`, `PerplexityBot`,
`Google-Extended`, `Bingbot`.

### `page-structure` — a second question of the same bytes

Four structural facts per sampled page: is there a `<title>`, is there a meta
description, is there exactly one `<h1>`, and does the canonical point at this
page or **disclaim it** in favour of another.

**It fetches nothing.** `robots-ai-access` already reads a stable three-page
sample for its page-level directive rule; this check reads the same bytes a
second way, handed over in-process. A served page is one document — fetching it
twice would double every property's nightly requests to learn nothing, and the
two answers could then disagree about a page that changed between them. A test
pins that each sampled URL is fetched exactly once across both checks.

**Only transitions fire**, the same discipline the directive half is held to. A
page that has always shipped without a meta description is a standing editorial
decision to argue about at leisure; a page that had one last night and does not
tonight is a regression somebody shipped today. The first reading of a URL
establishes the baseline and can never flag — which is also what keeps this check
from opening a flag on every page of every property the night it landed.
Retraction needs **proof**: a page that 500s tonight is "we did not measure it",
never grounds for withdrawing an alert.

**`value_num` is how many pages were read** — the denominator behind every claim
the check makes. It is the one hygiene check that stores a real zero ("the roster
was empty"), told apart from null by the `unreachable` status beside it: a check
that measured nothing has not found nothing wrong.

**Why four faults and not twenty-five.** A site-audit tool ships a taxonomy; this
register records incidents. Each fault has a decision attached and no room to
be wrong: a missing title or description is a lost click with a written repair;
a missing or duplicated `h1` is a page that states no subject or several; a
canonical pointing elsewhere means the page cannot rank however good it is, and
it is the one most often shipped by accident — a template, a CMS default, a
copied `<head>`.

Deliberately **not** checked: title and description **length** (Google truncates
by pixel width and rewrites titles at will, so "your title is 61 characters" is
taste with no decision behind it, and a check that fires on taste is one the
operator learns to ignore), image alt text, heading-level skips, and thin content
on inner pages.

**What it does not claim.** A structural fault is not automatically an *act*: a
missing title on a page with impressions is worth a morning, the same fault on a
page nobody reaches is worth nothing. That triage needs traffic evidence, which
lives in the Tower's page decisions and not in this lane — so the check reports
the fault and stops short of ranking it.

**The fixtures.** `STRUCTURAL_FIXTURES` in `test/hygiene.test.ts`: every page
breaks **exactly one** rule, a test asserts each fixture produces exactly its
own fault, and a coverage test fails if a fault is added to the parser without
a page to prove it.

### The page sample (`hygiene-page-directives`)

A site-level file cannot show a `noindex` shipped by a template, and that is the
block a CMS, a staging flag, or a copy-paste actually produces. So the check also
reads **three real pages** per property per night.

**The roster is the sitemap** — no per-asset route list to add, and none to keep
true as a property's URLs move. **The sample is stable**: the three URLs whose
FNV-1a hash sorts first, so it is independent of sitemap order and survives pages
being added. "The first three `<loc>` entries" would be simpler and useless —
sitemaps are commonly `lastmod`-ordered, so the sample would be three different
URLs every night, every reading would be a first reading, and a first reading
never flags.

**Closing directives** (the ones that remove a page from the surfaces this
portfolio is graded on): `noindex`, `none`, `nosnippet`, `max-snippet:0`, `noai`,
`noimageai`. `nofollow`, `noarchive`, and a non-zero `max-snippet` are recorded
as evidence but are not a block — they change how a page is treated, not whether
it is there. Directives are agent-qualified when scoped (`googlebot:nosnippet`),
and the reading names them, so a flag says which line to go and delete.

It is a **sample and says so** (`pages_sampled` of `pages_available`): it can
prove the pages it read are clean; it never claims the property is. An empty
roster — no sitemap tonight — reads as `pages_sampled: 0`, never as a clean bill.

The sitemap URL comes from a `Sitemap:` line in `robots.txt` (the first absolute
one) and falls back to `/sitemap.xml`. A `<sitemapindex>` is followed **one level
deep, at most 10 children**; past that the stored count is an explicit floor
(`children_capped: true`), and since the cap is constant the collapse comparison
stays floor-to-floor.

### Honesty rules (each is test-pinned)

- **Never flag on sparse history.** The depth rule is unarmed below seven prior
  readings, no matter how empty the page is. A guard that cries on day two is a
  guard that gets muted before the day it matters.
- **The baseline is the last *healthy* readings, not the last readings.** A
  regression that persists must not become its own baseline: a fortnight of
  thin pages would otherwise drag the median down, stop matching the collapse
  test, and *resolve the flag describing it*. Same reason the sitemap compares
  against the last healthy count rather than yesterday's row. A standing
  regression therefore alerts until the bytes recover or an operator
  dispositions the flag — which is what disposition is for.
- **An unreachable page is not a zero-word page.** A failed fetch stores
  `value_num = NULL` and files **no** depth flag; that rule's only trigger is the
  median collapse. It files a `hygiene-home-unreachable` flag instead, naming the
  HTTP status or the transport error.
- **One failed GET is not an outage.** A home page that fails is asked once more
  45 seconds later, after every other site, with one wait for the whole run
  (`HOME_CONFIRM_WAIT_MS`, `confirmHomeFailures`). Only the second failure
  writes the failing reading (`failed_tries: 2`) and files the flag; a page
  that answers the retry is an ordinary reading carrying `failed_tries: 1`.
  Nothing is written in between.
- **A 200 we declined to read accuses nobody.** Past the 8 MB ceiling, or a
  content type we will not decode, the reading is `error` with
  `unsupported: true` and **no** flag: that is our limit, not the property's
  failure — the same posture the sitemap guard takes on a gzipped file.
- **A page we could not re-read is unknown, not clean.** `hygiene-page-directives`
  retracts only on proof: a URL the open flag names is cleared when it reads clean
  again, never because it left the sample or answered 500. Same reason a night
  that sampled nothing resolves nothing.
- **First reading never flags.** A property that has always blocked ClaudeBot is
  a standing configuration to argue about, not tonight's incident.
- **A gzipped sitemap records `error` and flags nothing.** We cannot read one, and
  we cannot tell a real outage from our own missing capability.
- **Ongoing ≠ repeated.** Flags follow `asset-pull-failed` exactly: the first
  night inserts, later nights **rewrite** the open flag's message and inputs
  (`occurrences`, `lastObservedAt`) while `fired_at` keeps dating the onset. A
  healthy reading resolves it.
- **Failure isolation is per check**, not just per property: a home page that
  times out must not cost that property its robots reading.
- **A fetch with no status at all might be ours.** Before a statusless failure
  becomes a flag, the sweep asks two reference sites whether the OS can reach the
  network — see [the egress gate](#egress-gate-before-accusing-anybody-of-being-dark).
  A real HTTP status never asks.

### What the robots parser does and does not catch

Hand-rolled, no dependencies, and deliberately a **site-level** detector.

- **Catches:** a named bot (or `*`) acquiring a blanket `Disallow: /`; a bot's
  group disappearing so it falls back to a blocking `*` group; `robots.txt`
  itself vanishing. `Disallow:` with an empty value is allow-all, and a group
  carrying both `Disallow: /` and `Allow: /` resolves to allowed (the documented
  equal-length tie-break).
- **Does not catch:** path-level rules (`Disallow: /recipes/` reads as allowed —
  the bot *is* still allowed the rest of the site), wildcard/`$` patterns,
  longest-match precedence inside a group, and `crawl-delay`. Agent matching is
  exact on the token, not the substring prefix real crawlers use — so a
  `Googlebot` group does not resolve `Google-Extended`. That is the conservative
  direction: it can miss a block, never invent one.
- **`<meta name="robots">` and `X-Robots-Tag` are a different rule**, not a gap in
  this one — see [the page sample](#the-page-sample-hygiene-page-directives)
  above. The header parser has one documented limit of its own: several
  `X-Robots-Tag` headers arrive already joined into one comma-separated string, so
  a bare directive following an `agent:`-scoped one is read as belonging to that
  agent. Conservative in the direction that matters — it can attribute a block too
  narrowly, never invent one.

The word count is likewise a string transform, not a parser: it strips comments,
`script`/`style`/`noscript`/`svg`/`template`/`head`, then tags, decodes the
entities that affect a count, and counts whitespace-separated tokens holding at
least one letter or digit. It does not execute JavaScript — that is the point,
since AI crawlers don't either — and it does not tell nav boilerplate from
article body. It catches collapse, not quality.

### Identification

Requests go out as
`NoticeOS-Hygiene/1.0 (+https://www.notice.cx; portfolio self-check)`.
The lane **never** sends a crawler's User-Agent. Reading a property's robots.txt
to see whether GPTBot is allowed is a different act from fetching a page *as*
GPTBot, and only the first is ours to do — so a property that serves different
HTML to crawlers than to us is outside what this check can see.

## Egress gate (before accusing anybody of being dark)

This OS runs local-first, so every nightly lane runs from one machine. When
that machine's own connection is down, every property looks unreachable at
once, and the OS would be reporting its own blindness as everybody else's
outage. `src/egress.ts` turns on one distinction:

> **Any HTTP status proves egress.** A 403, a 404, even a 500 means a packet left
> this machine, reached an origin, and came back — that failure is the
> property's, and the gate is never consulted about it. Only a fetch that came
> back with **no status at all** is ambiguous, and only that case pays for a
> question.

The question cannot be answered by reading the error: workerd wraps every
connection-level failure as `internal error; reference = 0123…`, the same
sentence for a dead uplink, a refused connection, and DNS that never resolved. So
the lanes ask two **reference sites** instead —
`https://www.cloudflare.com/cdn-cgi/trace` and
`https://www.google.com/generate_204`, two independent operators on purpose, 5s
each, under our own `NoticeOS-Egress/1.0` User-Agent. Egress is **up** the moment
either answers with any status; it is **down** only when every one of them fails
at the transport level, which is the same evidence the property fetch produced.

**What the gate changes, and what it deliberately does not:**

- **Readings still record.** A gated check writes its `hygiene_checks` row with
  `egress_down: true` in `detail_json`. Suppressing the flags is only half the
  job — a night the OS measured nothing must not look like a night it found
  nothing wrong.
- **Nothing is retracted either.** A gated check files no flag *and* resolves
  none: the same "we did not measure it" rule the page-directive guard already
  follows. A property flag that predates the outage is exactly where it was in
  the morning.
- **One flag, on the OS's own row.** `os-egress-down` (`warn`, `anomaly`) lands on
  asset #0 — read from `assets.is_os`, never hard-coded — with the message
  `OS egress down — N properties unmeasured`. It follows `asset-pull-failed`'s
  lifecycle: the first down run inserts, later ones **rewrite** message and
  `rule_inputs` (`beacons`, `unmeasuredAssets`, `lanes`, `failureCount`,
  `lastFailedAt`, `connectionBackAt`) while `fired_at` keeps dating the onset.
- **Every collector keeps its own entry on that one flag.** `lanes` holds, per
  collector (`pull`, `hygiene`, `google-signals`, `bing-signals`,
  `signal-dumps`, `dataforseo`, `posthog`), the properties its runs left
  unmeasured and have not measured since — down to the report family where the
  collector can name one. `N` in the message is the **union** across collectors,
  not whichever ran last. A collector's run replaces only its own entry (a scoped
  DataForSEO collection replaces only the slice it covered), and the write is a
  compare-and-swap on the stored inputs, so two collectors finishing on the same
  tick cannot overwrite each other. A beacon answering records
  `connectionBackAt` (the message becomes `OS connection back — N properties not
  yet re-checked`, and the Tower stops pointing at the router), but the flag
  **resolves** only when the connection is up **and** no collector is still owed
  a re-check. A flag carrying no `lanes` resolves on the first up verdict.
- **Nothing is probed on a healthy night.** The gate is lazy: no beacon is asked
  until a fetch has already come back empty-handed. The one exception is a run
  that ends owing the open flag something — its own entry to clear, or, while no
  collector has yet seen the connection come back, the up reading that closes the
  dark span. Recovery is the case where no property fails, so nothing would
  otherwise ask; once `connectionBackAt` is on record, a collector with no entry
  asks nothing.
- **One verdict per run, re-asked after 5 minutes.** Six properties failing six
  fetches each is 36 asks of one question. The window bounds the cost without
  freezing the answer, because an outage can begin in the middle of a sweep.
- **Every probe round is stored** in `egress_checks`, so a quiet night has a
  cause on the record and not merely fewer alerts. That fact reaches the
  operator through the flag; a health read over the table is not built.

Gated branches, and only these: `checkHtmlDepth`'s home-unreachable path,
`checkSitemap`'s parent-fetch failure, `checkRobotsAiAccess`'s
robots-vanished logic, and `pullOne`'s catch when the request reached the wire
without a status. A missing pull token is **not** gated — that failure never
touched the network, so it stays a configuration alert even mid-outage. Child
sitemaps are not gated either: to reach them the parent fetch had to succeed,
which is itself proof the OS could reach that origin moments earlier.

### …and the provider collectors

The provider collectors cannot read a status off their own fetch — it is
buried inside token mints, discovery calls and retry ladders — so each run
wraps its fetcher once (`watchTransport`) and asks afterwards whether an error
is exactly what that fetcher threw: the same `status === null` rule, read by
identity. Only such an error pays for the gate's (cached) question
(`egressExplains`). When the answer is *down*, the collection is
**unmeasured**: its outcome carries `egressDown: true` and
`errorCode: os_egress_down` and still counts in `failed` (nothing was
collected), but it writes **no** provider run row, **no** Health observation and
**no** credential stamp, and the run's one `os-egress-down` flag names the
property instead. Anything that came back with a status — a 401, a 503, a body
that would not parse — is the provider's answer and is recorded as such,
including a provider that never answers while the beacons do.

| Lane | Gated calls |
|---|---|
| `google-signals` | the token mint and every GA4 / Search Console collect call |
| `bing-signals` | the `GetUserSites` discovery call (one fact for the whole portfolio, which also keeps `bwt_site_unverified` unreachable on a night no site list arrived) and every per-site traffic call |
| `signal-dumps` | the Google token mint, every GA4 / Search Console archive call, the Bing discovery call and every Bing archive call. No manifest means the family stays due: only a `success`/`unchanged` row satisfies a cadence. The flag's `signal-dumps` entry names each GA4 / Search Console family down to its date (`ga4:events-28d:2026-09-13`), because the next run's window does not reach every date the dark one owed — see [the dates an outage cost](#the-dates-an-outage-cost) |
| `dataforseo-dumps` | every report call, asked **before** a status-less failure is granted a retry: a dead uplink spends no ladder. The family writes no manifest, stays due, and is named on the flag's `dataforseo` entry, so the next daily `15 12 * * *` tick re-collects exactly those families once the connection is back instead of leaving them for next Monday. One exception, for the money: a tracked panel whose first pages were already paid for when the uplink went writes its attempt with code `os_egress_down`, the OS's own sentence and the spend, and no Health observation, because the monthly meter sums manifests |
| `posthog-dumps` | the project read and every family query. A dead project read leaves every family of that asset unmeasured; an uplink that dies after it leaves the rest of that asset's windows unmeasured without sending them into the wall. No row, no Health observation, no credential stamp. The flag's `posthog` entry names each window down to its end (`posthog:events:2026-09-13`), which the next run asks for again — see [the dates an outage cost](#the-dates-an-outage-cost) |

### The dates an outage cost

A run asks for the last four completed dates, so the window's oldest date
falls out of it the next day, and `events-28d` (and a probing family) only
ever asks for its newest date. Without a second rule, a date an offline run
failed to collect would never be asked for again and would stay red on the
Integrations page while every later day collected normally. Two rules close
it, one per kind of provider:

- **GA4 and Search Console name a date, so the date is asked again.** Each
  `15 12 * * *` run first re-collects the earlier dates owed a re-collection:
  a date whose **latest** attempt failed for a network reason (the same
  `healthFailure` rule that shows it as `network` on the page), and a date the
  flag's `signal-dumps` entry names because the dead uplink wrote nothing for it.
  Only for a property and family the run still collects, on the same Google
  property, and never a date its own window asks for anyway. Oldest first, at
  most `ARCHIVE_RETRY_LIMIT` (100) a run — about one dark night's worth — so a
  week-long outage drains over several ticks. The pass runs before the window,
  so a family's newest manifest is still the run's own date. It asks nothing
  when the run has already seen the uplink down, and stops after the first ask
  that meets a dropped connection, leaving the rest owed. A date the provider
  answered with a refusal (a 403, a quota refusal, an unregistered dimension) is
  never asked again daily. The completion line carries `retried` and
  `retryNotAsked`; the flag closes only when every dated entry has been asked.
  Nor is a date the provider answered and this machine failed to save: a Postgres
  or R2 failure while archiving is `local_store_failed` on every archive lane,
  which the page files as NoticeOS's own fault (`monitoring`), never as the
  provider unreachable.
- **PostHog bounds every query to its window, so a window end is asked again
  too.** The `30 12 * * *` run owes a window end whose latest attempt failed for
  a network reason (`posthog_request_failed`, `posthog_timeout`) on the asset's
  current project, or that the flag's `posthog` entry names. Only for families
  the run collects and ends older than its own; oldest first, at most
  `POSTHOG_RETRY_LIMIT` (6, one night's worth) per asset per run, because each
  one re-reads its whole window against PostHog's hourly budget. Each family's
  owed windows go just before its own, so its newest row is still today's
  window. Never with an explicit `--start`/`--end`, never once the run has seen
  the uplink down, and it stops after one ask PostHog still drops. A 401/403 is
  PostHog's verdict on the key and is not asked again daily. A 5xx, a malformed
  answer (`posthog_invalid_response`) or a 429 is PostHog saying "not now": the
  window is asked once more, in the same bound and order, and the same kind of
  answer twice for one window is PostHog's settled answer and stays on the
  page. A re-ask PostHog's servers fail (5xx) ends the pass for the day like a
  dropped one, so the rest keep their one more ask. A 429 met during the pass
  still stops the whole run. The windows a 429 stopped the run before asking —
  the rest of that asset's families and every asset after it — have no row, so
  the refusal's own row is the marker: its `requested_at` names the stopped
  run, and the next run asks each family of an asset already collected by then
  for the window that run would have asked (in the project's timezone), unless
  some run has a row for it (`stoppedRuns`, `src/posthog-dumps.ts`).
- **Bing Webmaster, Clarity and DataForSEO only answer with their current
  state,** so a past date cannot be asked for again: today's answer would be
  filed under the old date (and Clarity would spend one of its ten daily calls
  doing it). There, the lane's next attempt at the same report is the answer:
  once the asset has a later attempt at that report on the same connection that
  did not fail at the network — a collected snapshot or the provider's own
  refusal, under any of the asset's targets (a night the site list never
  arrived files its failures under the bare domain) — the health read
  (`src/integration-health-read.ts`) stops counting the old network failure as
  current. A refusal is never retired this way.

`test/outage-recollection.test.ts` replays a dark night through the real lanes
and proves the next ticks leave no `network` item on Google, Bing, Clarity or
PostHog. On a live install, the next scheduled `15 12 * * *` and `30 12 * * *`
ticks do it; `pnpm os:run-job -- "15 12 * * *"` (and `"30 12 * * *"` for PostHog)
fires them early.

### …and the hours after it (ingest-freshness)

The gate only speaks for checks that ran *during* the outage. A pull-mode
property cannot report while the OS cannot reach it, and a push-mode one
cannot reach the OS either, so the silence is this house's, not theirs — and
the hourly **ingest-freshness** rule must not fire `no pulse in 48h` on it two
days later. The rule runs on one sentence: **staleness does not count hours the
OS itself was dark.** `runFreshnessCheck` (`src/db.ts`) reads `egress_checks`
over each stale property's own silence, subtracts the dark hours it finds, and
fires only if what is left still exceeds `REPORT_MAX_AGE_HOURS`. A flag that
does fire carries `osDarkHours` in its `rule_inputs` and says so in its message
(`… — the OS itself was offline 10h of these`), so the operator is never sent
to read a property's logs for hours in which nobody could have reported. What
the rule deliberately keeps: the property is still counted **stale** (the Tower
counts it stale at the same age off the same store), and a gated hour
**retracts nothing** that was already open. A site that never reported is not
a staleness fact either: it owes no report at all.

The dark hours are only ever the ones the store **evidences**, which keeps this
honest against the gate's laziness — a healthy night files no reading at all, and
must read as the OS being up, because that is what it was. So a dark span runs
from the first `up = 0` reading of a consecutive run of them to the **last**, and
stops: the hours between two down readings are credited (no up reading
contradicts them), the hours after the last one are not, and an isolated down
reading is a moment rather than a night. The one reading *before* the window is
read too, for its verdict alone — it is what says the OS was already dark when
the window opened, the shape of an outage that straddles a property's last
report. The span cannot creep past recovery either: `EgressGate.finalize` probes
once at the end of any run that owes an open `os-egress-down` flag its
retraction, so the first lane run after the uplink returns writes the up reading
that closes the span. Worst case, if a bridged span is wider than the outage
really was, a genuinely broken lane's flag arrives up to one `REPORT_MAX_AGE_HOURS`
late — the same bounded delay the rule already accepts — and it does arrive,
because dark hours stop accruing while the age keeps climbing. The read costs one
query, and only in an hour that has something stale to explain.

## Pull mode (local-first pull adapter)

NoticeOS runs **local-first**: the OS itself is not a public push target, so a
prod asset that cannot reach it to *push* its nightly pulse is **pulled** instead.
The `30 2 * * *` cron fetches each enabled pull-mode asset's own self-report
endpoint, turns the response into a signal-contract envelope, and writes it
through the **same** internal path as `POST /api/pulse`
(`ingestPulseEnvelope` → validate → upsert `(asset,date)` → explode flags →
central volume-aware rules → resolve freshness). A pulled asset is therefore held
to the identical contract and rules as a pushed one — pull vs. push is purely a
transport choice.

Two wire formats are supported, chosen per asset by `format`:

- **`prometheus`** — a Prometheus text scrape the adapter parses
  and **maps** into the envelope, computing `avg7d` from stored history.
- **`envelope`** — the endpoint already **speaks the contract** and
  returns the envelope verbatim; the adapter validates it and passes it straight
  through (no mapping, no history-derived `avg7d`).

### Config — `config/pull.json`

The saved pull configuration is an array of pull-mode assets. This file seeds
new installations; runtime settings live in the store:

```jsonc
[
  {
    "asset": "example.com",
    "url": "https://example.com/api/internal/metrics",
    "enabled": true,
    "format": "prometheus",
    "metrics": {                                  // envelope metric -> source counter
      "signups":      { "counter": "profiles" },
      "plansSaved":   { "counter": "saved_calculator_results" },
      "recipesSaved": { "counter": "saved_recipes" },
      "leads":        { "counter": "leads" },
      "feedback":     { "counter": "feedback" }
    }
  },
  {
    "asset": "example.org",
    "url": "https://example.org/api/admin/overview",
    "enabled": true,
    "format": "envelope"                          // body IS the envelope; no metric map
  }
]
```

The Worker resolves this document store-first each run and falls back to the
copy compiled into it (see
[Collector config](#collector-config-the-store-first-the-compiled-copy-behind-it)).
`format` selects the wire format.
For **`prometheus`**, `metrics` maps each envelope metric name to the source
counter (the Prometheus `table` label): per metric the adapter reads **`total`**
from `d1_row_count{table}` and **`last24h`** from
`d1_new_rows_count{table,window="24h"}`. For **`envelope`** there is no `metrics`
block — the response body already carries the full metric set.

### `avg7d` — diagnostic wire value, not the alert baseline

A Prometheus source reports point-in-time / daily counts, not 7-day baselines, so
for the **`prometheus`** format the adapter computes `avg7d` per metric as the
mean `last24h` of the **last 7 stored nightly reports** for that property (days
strictly before today). With no stored history yet a metric falls back to its
current `last24h`. This value remains useful in the report and Daily metrics
table, but it does not arm or drive the central anomaly rule.

The **`envelope`** format trusts the property-computed `avg7d` source-side and
stores it verbatim. Central rules ignore it and assemble their matching-weekday
baseline from stored `last24h` observations for every wire format, so the
property cannot influence the ruler.

### The `envelope` format — when the property already speaks the contract

Use `envelope` when the property's own endpoint returns the exact signal-contract
envelope (`{ asset, generatedAt, capabilities, metrics, flags }`). The adapter:

1. fetches the URL with the same `env.ASSET_TOKENS` bearer as any pull;
2. validates the body against the `PulseEnvelope` contract, and additionally
   **guards that `body.asset` equals the configured asset id** — a mismatch is a
   pull failure, never a silent cross-write into another property's row;
3. hands the validated body to the shared path unchanged: envelope `flags` still
   explode as `asset-declared`, and the central rules still re-run with OS config.

No `metrics` mapping and no history lookup happen for this format — the body is
the nightly report as-is. When the property later gains push, flip `enabled` to
`false` exactly as with any pull-mode property.

### Auth — `env.ASSET_TOKENS`

The pull presents the **same** per-asset token the push lane checks — there is
one map, not two. `env.ASSET_TOKENS` is a JSON map `{ "<asset-id>": "<token>" }`
(a secret); the cron sends `Authorization: Bearer <token>` when it fetches an
asset's URL, using the entry under that asset's id. The token for each asset
**must equal** the single `ASSET_TOKEN` secret on that asset's own worker.

Secrets live only in `.dev.vars` (local) or Cloudflare secrets (prod), never in
`config/pull.json` or source.

Why one token covers both directions, what a leak costs, and how to onboard or
rotate an asset:
[docs/11 §Credential naming — the `ASSET_TOKEN` convention](../../docs/11-integrations.md#credential-naming--the-asset_token-convention).
This section documents the mechanics only. Nothing reads a `PULL_TOKENS`
secret; if a deployed worker still carries one, delete it
(`wrangler secret delete PULL_TOKENS`).

### Failure alert — `asset-pull-failed`

Any pull failure (fetch error, non-200, an asset-id mismatch, or an
unmappable/invalid body) raises a `warn` alert on **that** property with
`rule_id = asset-pull-failed`, `pulse_id NULL`, and
`rule_inputs = { url, status, error, … }`. It does **not** double-fire while an
identical open alert exists (a persistent outage alerts once, not every night),
and it **auto-resolves** on the next successful pull. One property's failure is
caught and alerted in isolation — it never aborts the other properties' pulls.

**Every failed night keeps its own record.** A continuing outage refreshes the
open alert to tonight's cause, and each failure — the first included — also
appends its reading (`message`, `rule_inputs`) to `noticeos.flag_evidence` on
that alert, so N failed nights leave N rows. The Tower lists them on the site's
Data sources tab and in the alert's Evidence. On a store without the evidence
table the outcome says `evidence: 'not-migrated'` and the alert is refreshed
exactly as before.

**Surface the provider's own words.** When an `envelope` endpoint answers a
non-200 with its own `{ error, message }` body, the adapter renders that verbatim
into the alert message and `rule_inputs` — the operator sees the source's own
diagnosis, not a bare status:

| Response | Alert message |
|---|---|
| `401 { "error": "unauthorized" }` | `example.org pull failed: 401 unauthorized` |
| `503 { "error": "unconfigured", "message": "Overview unavailable: set CF_ACCOUNT_ID…" }` | `example.org pull failed: 503 unconfigured — Overview unavailable: set CF_ACCOUNT_ID…` |
| `502 { "error": "analytics_query_failed", "message": "Analytics Engine SQL API returned 422: …" }` | `example.org pull failed: 502 analytics_query_failed — Analytics Engine SQL API returned 422: …` |

`rule_inputs` additionally carries `providerError` and `providerMessage` for a
queryable audit trail. A non-200 with no JSON error body falls back to a
status-only message.

**One exception, and it is not the property's fault.** A pull that reached the
wire and came back with *no status* is checked against
[the egress gate](#egress-gate-before-accusing-anybody-of-being-dark) first: if
the OS's own connection is down, the outcome carries `egressDown: true`, no
`asset-pull-failed` flag is filed, and the run's single `os-egress-down` flag
speaks for it instead. Every status the endpoint actually returned — and a
missing pull token, which never left the machine — flags as usual.

### Flipping an asset from pull to push

When an asset gains the ability to push its own pulse (`POST /api/pulse`), set its
`config/pull.json` entry to `"enabled": false`. The pull cron then skips it and
the two lanes never collide; the asset's pushed pulses flow through the very same
`ingestPulseEnvelope` path the pull was using.

A machine-scrapable self-report endpoint must be gated on a **static** bearer
(`ASSET_TOKEN`). A route gated by a logged-in user's session token cannot be
pulled by a cron.

## Counters (the fast lane)

The nightly pull already carries every metric's all-time `total` — once a day.
The **counters** lane exists to make the two or three totals an operator watches
on a property page *fresh*: a `*/15 * * * *` cron re-reads them and upserts one
current-state row per card into `counter_readings`. It is a freshness upgrade to
a fact the OS already has, not a new signal.

### Config — `config/counters.json`

Which counters get a card, and their labels (full field contract in
[`config/counters.README.md`](../../config/counters.README.md)):

```jsonc
{
  "assets": {
    "example.com": {
      "source": { "kind": "prometheus", "url": "https://example.com/api/internal/metrics", "enabled": true },
      "cards": [
        { "metric": "signups", "counter": "profiles", "label": "Accounts" },
        { "metric": "leads",   "counter": "leads",    "label": "Leads" }
      ]
    },
    "example.org": {                             // no source: cards ride the nightly report
      "heading": "Current catalog",
      "cards": [
        { "metric": "catalogItems", "label": "Items rated" },
        { "metric": "catalogRestaurants", "label": "Restaurants" }
      ]
    }
  }
}
```

`metric` is the **envelope metric name**, not the source counter — that is what
makes the primitive format-agnostic: a property with no `source` still gets
cards, resolved Tower-side from its nightly report's own `metrics[metric].total`.
A property with `enabled: false` is the same case; the cards stand, just at
nightly freshness. Neither is fetched at all.

How often the lane runs is the counters job's schedule, and it is also what the
Tower ages the cards against (amber at 2× its longest wait between runs), so
there is no second copy of the cadence to keep equal.

### Auth — the same token as the pull

The scrape reuses `env.ASSET_TOKENS[<asset>]` and the same request shape as the
nightly pull (`fetchScrape` in `src/pull.ts`) — the same endpoint, the same
bearer, a different cadence. A property's worker never has to authorize a
second caller. A missing token is a clean per-property failure, not a throw,
and nothing is fetched.

### All-or-nothing per property, per run

Every card is resolved to a value **before anything is written**; the whole
property's readings then go in as one batch of upserts sharing one
`observed_at`. One unreadable counter fails that property's entire refresh — the
readable cards are *not* written on their own. A half-refreshed card set would
put two different moments under one age badge, and the badge is the only thing
telling the operator how old the numbers are. Properties are independent: one's
failure never touches another's readings.

### Failure semantics — no alert lane, and why

A failed scrape (non-200, a missing `d1_row_count` sample, a value that isn't a
row count) writes **nothing** and leaves the previous reading **entirely
untouched — value *and* `observed_at`**. It raises no flag.

- **Staleness is the signal.** Each card renders its own `observed_at` as an age
  badge that ambers at 2× the interval. The badge is derived from the clock, so
  it goes stale on its own — the OS is not asserting "this is fine" and then
  needing a second mechanism to retract it. Re-stamping `observed_at` on a
  failed read is the one unrecoverable lie here: a stale number wearing a fresh
  timestamp is undetectable. It is pinned by a test.
- **A real outage is still alerted.** The nightly pull hits the same endpoint
  with the same token and raises `asset-pull-failed` within 24h. There is no
  failure this lane could catch that that one misses — only 96 chances a day to
  say it again.

### It writes `counter_readings` and nothing else

Hard invariant, test-pinned: the lane never writes `pulses` and never writes
`flags`. The nightly report stays the single durable record of a day's numbers
(`counter_readings` is current state, not history —
[db/README](../../db/README.md)), and a 15-minute lane that could write pulses
would forge 96 nightly reports a day.

## Google signals (GA4 + GSC)

The same 15-minute tick runs the operator-owned central Google collectors in
`src/google-signals.ts`. It is intentionally not a render-time proxy: the Tower
reads Postgres only, so a slow or unavailable provider cannot make the dashboard slow.

`env.GOOGLE_SIGNAL_ACCOUNTS` is an account-centric routing secret:

```jsonc
{
  "example-signals": {
    "service_account_binding": "GOOGLE_SERVICE_ACCOUNT_EXAMPLE_SIGNALS",
    "properties": {
      "example.com": {
        "ga4_property_id": "<numeric property id>",
        "gsc_site_url": "sc-domain:example.com",
        "time_zone": "UTC"
      }
    }
  }
}
```

**`ga4_property_id` and `gsc_site_url` are the retiring half.** Each asset's own
entry in `config/integrations.json` holds the same two facts and wins, and
`parseGoogleTargets` reads the pair above per data source only while at least
one asset this secret names is unmapped there. Once all of them are mapped,
those two fields are not read at all: what the secret still has to carry is the
routing — which account authenticates which asset — plus each entry's
`time_zone`. `/integrations` prints which of the two states this install is in.
An account entry that names no service-account key authenticates with the
operator's sign-in instead, so an install can keep the map for its routing and
sign in for its auth.

The formatted local source keeps `service_account_b64` in that account entry;
the runner extracts it to the named per-account binding before Wrangler
starts. One account entry may name several properties. The Worker
decodes the resolved key only in memory, mints one token per account + read-only
scope, and reuses it across the mapped targets. The Postgres run record stores
`example-signals` as a safe `credential_ref`; it never stores the encoded JSON,
private key, assertion, or access token.

Both providers receive a bounded date-only 97-day request. The Tower renders
90 dates on property detail and retains the preceding seven out of view for
the first visible day's prior-week comparison and rolling-average context:

- GA4: `sessions`, `activeUsers`, `screenPageViews`, `eventCount`. Today's
  partial day **and yesterday** are marked provisional: a GA4 day stays
  provisional until it has been collected on day D+2 (`GA4_SETTLE_DAYS`),
  because the Data API states no finalization flag and a D+1 read can carry
  unattributed sessions a D+2 read corrects. "Today" uses the configured IANA
  `time_zone` because GA4 groups reporting dates by the property timezone; a
  property that names none falls back to the **configured OS clock**
  (`config/constants.json` `os_time_zone`, via `OS_TIME_ZONE`), not to a
  hardcoded zone — and the assumption is announced once per pull as
  `ga4_time_zone_assumed`, naming the zone and the properties it stood in for.
  Standard GA4 may revise recent processed values later; those revisions
  become new append-only observations.
- GSC: `clicks`, `impressions`, `ctr`, `position`, `dataState=all`. Today is
  always provisional and the API's documented PT date boundary is used;
  Google's `first_incomplete_date`, when returned earlier, expands the
  provisional tail. UTC rollover must never manufacture tomorrow as a
  zero-valued partial day.

Every attempt appends `signal_runs`; successes and errors are equally visible.
The first success appends the normalized daily values to
`signal_observations`. A later success appends only new/revised values, so the
15-minute cadence does not copy an unchanged 97-day snapshot 96 times a day.
Provider failures are isolated per account/scope/property and never erase the
last-good chart.

The longer horizon does not change quota consumption: it is still one request
per provider/property every 15 minutes. The asset-detail API renders up to all
90 dates; the compact Home/Wall read model applies its own 28-day slice.

At the current cadence each property makes 96 simple requests/day/provider.
That is far below GSC's 1,200 queries/min/site limit and GA4's standard
200,000 tokens/day + 40,000/hour budgets (most requests use fewer than ten
tokens). Source processing is slower than polling — standard GA4 intraday is
typically 2–6 hours, and GSC can lag — so multiple successful runs may correctly
contain zero changed observations.

### GA4 realtime RPC

The Tower's active-user glance is an on-demand path, not another scheduled
collector. `IngestWorker.ga4Realtime()` is callable only through Tower's private
Service Binding. It parses the same account-centric
`GOOGLE_SIGNAL_ACCOUNTS`, reuses each read-only Google access token for at most
50 minutes, and makes these bounded reads per configured property
(`src/ga4-realtime.ts`):

- two `runRealtimeReport` requests: one with the overlapping 0–29-minute and
  0–4-minute windows, and one grouped by `minutesAgo` over the last 30 minutes
  (the Wall's minute pulse, placed on the clock by `ga4MinuteBuckets`: a minute
  with no row is 0, a minute the reading did not cover is `null`). The pair is
  one reading, shared by every open display for one minute;
- one Core `runReport` grouped by `dateHour` over `yesterday…today` and
  `8daysAgo…6daysAgo`, cached for 15 minutes and re-bucketed from the property's
  reporting time zone into `OS_TIME_ZONE`, so every property's today-line
  shares one x-axis. Each row converts with the zone in effect on its own date,
  read from the `reporting-time-zone-changed` annotations, because GA4 does not
  reprocess history.

The method returns normalized values/error codes only; it never exposes a
credential, raw provider body, or access token.

This path writes no `signal_runs`, observations, Postgres rows, or R2 objects.
Realtime values are current display state and must not become anomaly evidence.
Account/property failures are isolated. An empty valid window report becomes
two legitimate zeroes; HTTP, timeout, authentication, and malformed-response
failures become null-valued errors so the UI cannot report a false zero. The
hourly response always preserves the prior day's 24-hour shape, but today
becomes null after the newest reported non-zero hour so provider-supplied future
zero rows cannot look like a forecast. The Tower polls every 30 seconds, stops
in a hidden tab, and keeps its last-good snapshot during a later failure.

Every provider request sets `returnPropertyQuota`, and each response's
`propertyQuota` is parsed onto the successful asset result as
`quota: { realtime, core }` — `tokensPerDay` and `tokensPerHour` per pool, the
two budgets that bound this poll rate. Realtime and Core requests draw on
**separate** GA4 budgets, so the two are reported separately and never summed.
A bucket the provider omits or reports unusably stays `null`; nothing is read
as a reassuring zero. The field is optional on the shared payload type and the
Tower may ignore it.

## GA4 quota — what the heavy lanes are spending

The Data API meters in **tokens per property**, per day and per hour — never in
requests, so "how many calls did we make" does not answer "how close are we to
the ceiling". `src/ga4-quota.ts` is the shared vocabulary; the realtime path
above, the 12:15 archive, and the 15-minute collector all use it.

Both heavy lanes send `returnPropertyQuota: true` — the archive runs 33 base
requests per property per day before pagination, the 15-minute lane adds 96
daily-series runs — so a ceiling hit in either is distinguishable from an
outage or a bad credential.

| Where the answer goes | Lane |
|---|---|
| `providerQuota` on the archived envelope in R2 | 12:15 signal dumps |
| A `ga4_quota` structured log line, every run | both |
| A `ga4-quota-pressure` flag on the property, while a bucket is under 20% | both |
| `error_code = ga4_quota_exhausted` on the manifest / run row | both |

- **The quota is lifted out of the archived response body**, into the envelope
  beside it. It is the one field this lane does not archive verbatim, and it has
  to be: `consumed` moves on every single call, so leaving it in the bytes would
  put it in the content hash and every GA4 archive would read as *changed*
  forever — silently retiring the unchanged-detection that keeps the R2 footprint
  honest. The archive is evidence about the property's data; what the call cost
  us is a different fact, and it travels beside it.
- **An exhausted budget is not a rate limit.** Both arrive as HTTP 429; only one
  needs an operator. `RESOURCE_EXHAUSTED` (or an explicit quota/token mention)
  earns `ga4_quota_exhausted`, everything else stays `ga4_http_429`. Being loud
  about the wrong one would train an operator to ignore the code.
- **The flag follows `asset-pull-failed`.** A budget thin since 09:00 is one
  problem, not the 96 the 15-minute lane would otherwise file: the first
  observation inserts, later ones rewrite the open flag so the message carries
  the *current* headroom, and a reading back over the line resolves it. A run
  that reported no usable quota resolves **nothing** — not asking is never
  evidence that the pressure lifted.

The 20% line is a working margin, not a cliff: at 15-minute cadence it leaves
roughly three hours of collection to act in. This module never sums buckets,
estimates a burn rate, or predicts exhaustion — it reports what the provider
said about the call we just made.

## Analysis-grade provider signal dumps

`src/signal-dumps.ts` is a separate daily lane for deep offline analysis. It
reuses the central Google account mapping and shared BWT client, but it never
writes chart observations and the Tower never reads its objects directly.

At 12:15 UTC it re-fetches the previous four completed dates:

- GSC Web Search: `page-query`, `page`, `query`, `country`, `device`,
  `page-country`, `page-device`, plus the two-step
  `search-appearance-pages` export required by Search Console. Image
  page×query and Discover page data are separate report families. All use
  `dataState=final`, 25k-row pages, and a 50k-row/report/day cap.
  `discover-page` runs in [probe mode](#probe-mode-for-an-always-empty-family).
- GA4: completed-day `pages-screens`, `landing-pages`,
  `traffic-acquisition`, `traffic-sources`, `events`, `page-events`,
  `js-errors`, and `landing-page-acquisition`, plus one `events-28d` rolling
  aggregate ending on the newest completed date. The rolling family is
  collected once per run, not four times across the revision window. All use
  25k-row pages and a 250k-row/report/day cap. `js-errors` runs in
  [probe mode](#probe-mode-for-an-always-empty-family) and needs
  [registered custom dimensions](#ga4-event-parameters-need-operator-registration).
- BWT: one provider snapshot each for `rank-traffic`, `queries`, `pages`,
  `crawl-stats`, `crawl-issues`, and `feeds`. The first verified-sites request
  is shared across the portfolio; each family then gets one bounded request per
  verified property. Query/page snapshots update weekly, while traffic and
  crawl history are daily provider series — so `queries` and `pages` are
  collected [on the provider's weekly cadence](#weekly-families-on-a-daily-cron)
  and the other four every day.

Every response is read through an 8 MiB byte guard. The complete archive is
capped at 32 MiB, gzip-compressed, and written through the `RAW_SIGNALS` R2
binding. The object contains the versioned envelope, exact request bodies, and
provider response pages; it does not contain request headers, JWTs, keys, or
access tokens. `noticeos.archive_runs` records every attempt. Provider-limit
truncation is explicit.

**The content hash dedupes a re-fetch of the same report date, and only that.**
`findPriorDump` matches on (asset, integration, report, `report_date`,
`content_sha256`), and the canonical bytes it hashes include `reportDate` — so a
second collection of one date writes an `unchanged` manifest row against the
object already stored, which is the case a re-run of `signals:collect` or a
revision window re-asking a GSC day actually produces. Two **consecutive** dates
carrying a byte-identical provider answer each write their own object: a shared
object's envelope would name the first date, `scripts/signal-panels-refresh.mjs`
writes it as `<report>/<report_date>.json`, and the flattener reads
`report_date` out of the content — so day two's rows would arrive stamped day
one. Only the small BWT snapshot families ever repeat across dates; the saving
would be negligible.

The base object layout is:

```text
raw/google/<ga4|gsc>/<asset>/<report>/<YYYY-MM-DD>/<run>-<hash>.json.gz
raw/microsoft/bing-webmaster/<asset>/<report>/<YYYY-MM-DD>/<run>-<hash>.json.gz
raw/dataforseo/dataforseo/<asset>/<report>/<YYYY-MM-DD>/<run>-<hash>.json.gz
```

### Probe mode for an always-empty family

A property that does not participate in a surface at all — a site Google has
never put in Discover — answers `discover-page` with an empty body on every one
of the four revision dates. Re-learning that same nothing four times a day,
forever, is the whole cost of the family.

A report spec can therefore set `probeWhenAlwaysEmpty`. Before requesting, the
collector reads that (asset, report)'s own report-run history:

| History for this (asset, report) | Dates requested |
|---|---|
| No completed run yet (first-ever run) | the full revision window |
| Completed runs exist, **all** with `provider_rows = 0` | the newest completed date only |
| **Any** completed run with `provider_rows > 0` | the full revision window |

Errors are not evidence of emptiness, so a failed attempt neither arms nor
disarms the probe. The narrowing is per property and per report, and it is not
a latch: one non-empty row anywhere in the history restores the full window, so
Discover switching on is visible the next day at the cost of one request.

Manifest semantics are unchanged — a probe run writes a report-run row
exactly like any other attempt. A narrowed window is a smaller request, never a
skipped one, so "we asked and there was nothing" stays distinguishable from "we
did not ask". `discover-page` and `js-errors` are opted in; the flag lives on
the shared report spec so another family that proves always-empty can join it
without new machinery.

### Weekly families on a daily cron

Microsoft rebuilds the BWT top-query and top-page reports **weekly** — they are
current top-result snapshots, not daily exports, which is also why the analyzer
reads only the latest downloaded snapshot and never sums repeated runs. Asking
daily would re-download the same snapshot six times out of seven.

A BWT report spec can set `cadenceDays`. Omitted means 1 — ask every day, because
the answer can differ every day. `queries` and `pages` set 7; `rank-traffic`,
`crawl-stats`, `crawl-issues`, and `feeds` stay daily because each is a genuine
daily provider series that gains a day of history every day.

Before the run calls anything, it asks each property's own report runs
history for the newest date each family has archived, and collects a family only
when that date is at least `cadenceDays` behind the date being collected. Three
properties are deliberate:

- **Measured from archives, not from the calendar.** No day-of-week anchor, so a
  run the OS missed does not push the family a further week out — the day after
  an outage it is overdue and collected.
- **A failure never satisfies a cadence.** Only `success`/`unchanged` rows count,
  so a weekly family whose fetch failed is due again tomorrow rather than waiting
  out a week on the strength of an error.
- **Not due means not asked, on every path.** The due set is computed once per
  property, before any manifest is written, and the credential-failure and
  unverified-site paths use the same set — so a family nobody was going to
  request never gets an error row invented for it.

**A skipped day writes nothing at all**, which is the one place this differs from
probe mode. `archive_runs.status` is a closed vocabulary of *attempts*
(`success`, `unchanged`, `error`) and a day we did not ask about is not an
attempt; recording one would need a new status and a migration to widen the CHECK.
The family simply keeps its last real manifest, so "we asked and it was the same"
still reads differently from "we did not ask", and the run log names the count as
`skippedNotDue` so a smaller `attempted` reads as the cadence working rather than
as lost coverage.

Lane health stays truthful because the Tower derives the BWT archive lane from
the newest manifest *across* its families
([`apps/tower/worker/integration-evidence.ts`](../../apps/tower/worker/integration-evidence.ts),
`aggregateArchiveRuns`): the four daily families carry the lane's `finishedAt`
and `report_date` to today, and the lane goes red only when some family's latest
manifest is an error — which a skip cannot produce. Note that the DataForSEO
roll-up right beside it does the opposite: `aggregateDataForSeoRuns` marks a lane
`dataforseo_incomplete` when a family's date lags the newest one, and that test
must never be copied onto BWT, where lagging by design is what a weekly family
does.

## Clarity: behaviour signals, 10 calls per project per day

`src/clarity-dumps.ts` runs at 04:30 UTC. Clarity's Data Export API is the
portfolio's hardest-capped provider — **10 calls per project per day**, a
trailing 72-hour window only, at most three dimensions, and 1,000 rows with no
pagination. Every design choice follows from that:

- **One call per property per day**, archived verbatim to R2 with a
  report-run row (`integration = 'clarity'`, `report = 'url-3d'`). Re-analysis
  reads the stored object; it must never cost one of the day's ten.
- **One dimension (URL).** A second split is a second call, so it is a separate
  budget decision, not a free addition.
- **A property with no token is skipped** — no call, no manifest row, no error.
  A daily error row for a property the operator deliberately has not set up is
  an alarm about a settled decision. The run log names the count as
  `skippedNoToken`, so an all-skipped run cannot read as "the lane ran clean".
- **A block sitting on the 1,000-row cap is marked `provider_truncated`.** There
  is no pagination to reach past it, so the count is a floor on the truth.

Failures are split by the operator action they need: `clarity_token_rejected`
(401/403 — the token), `clarity_daily_cap_reached` (402/429 — the ten are
spent), `clarity_invalid_response` (the call was spent and answered with nothing
recognizable — a failed observation, never a property with no behavior), and
`clarity_http_<status>` for everything else.

**Credentials.** The canonical slot is `CLARITY_TOKENS`, a JSON map of asset id
to project token, because Clarity issues a token **per project** and there is no
portfolio credential. `CLARITY_PROJECT_API_TOKEN` — a single flat token — is
accepted as a documented fallback bound to one asset; it should migrate to the
map when a second property gets a token. Where both name the same asset the
**map wins**, since it is the shape that can express the whole portfolio. Only
the slot name reaches Postgres; the token itself never enters report rows or R2.

`scripts/creds-check.mjs` applies the identical precedence, so
`pnpm creds:check --lane clarity` recognizes either shape (it stays
probe-on-request, because one probe burns 1 of the project's 10 daily calls).
Migrating from the flat token to the map is a rename, not a rewrite.

Sessions are sampled and `clarity.ms` is on adblock DNS lists (undercounts
~15–25%), so these are behavior **rankings**, not population counts.

### GA4 event parameters need operator registration

`js-errors` reads GA4 **event parameters** rather than built-in dimensions. It
asks for `customEvent:message` and `customEvent:source` next to the page,
filtered to `eventName = js_error`, because the count alone names the worst
page and nothing an engineer can act on.

The Data API cannot answer for a parameter until an operator registers it as a
custom dimension in GA4 admin (Admin → Custom definitions), and **GA4 backfills
nothing** — data begins accruing at registration, so dates before it stay
permanently unknown. Registration is operator work: the analytics pipeline is
`forbidden`-class (`AGENTS.md`), so this repo asks and never configures.

**Which properties are asked is config, not a guess.**
[`config/ga4-custom-dimensions.json`](../../config/ga4-custom-dimensions.json)
records where the operator has registered the parameters; a property it does not
cover is skipped entirely, exactly like a property with no SERP panel — no
request, no manifest row. That keeps a permanent, known gap from generating a
daily error row on every unregistered property.

The gate does not retire the unregistered state, because registration is
forward-only and the file is a hand-maintained claim about a system it cannot
inspect. Where the Data API does reject the field, the collector records that
rejection as its own manifest state:

| Manifest row | Means |
|---|---|
| `status = 'success'`, `provider_rows = 0` | the property genuinely threw no errors that day |
| `status = 'error'`, `error_code = 'ga4_custom_dimension_unregistered'` | nobody has registered the parameters; this family has never been answerable |
| `status = 'error'`, any other code | an ordinary provider/credential failure |

A generic `ga4_dump_http_400` would send an operator to check credentials, and
an empty success would state that the property throws no JavaScript errors —
the "absent means zero" reading the signal contract forbids. Every other GA4
rejection still flows through the normal error path.

GA4 objects are labeled `revision-window` because the Data API does not expose
a finalization flag. The label is the same for every day, so the flattener adds
the day's age where it matters: the three attribution families
(`traffic-acquisition`, `traffic-sources`, `landing-page-acquisition`) carry
`provisional=1` on a report day not yet confirmed by a collection on day D+2 —
read from the downloads `manifest.json`, whose newest run per day includes an
`unchanged` re-confirmation, and from the archive's own `collectedAt` without
one. GSC objects are `provider-final` because the request
explicitly asks for final data. BWT objects are `provider-snapshot`: repeated
weekly top-query/page rows are revisions of the same current snapshot, not
additive daily exports. DataForSEO uses the same label for weekly
rank/link/AI-provider snapshots. No label authorizes turning an absent row into
zero.

The archive is intentionally decision-oriented: page×query describes demand,
page×source/channel describes acquisition and known AI-assistant referrals,
page×event describes behavior, and BWT adds a second search-provider view plus
crawl/feed diagnostics. The rolling event report provides exact unique people
per action type; daily unique-user rows are never summed into a false
28-day count, and independent action totals are not treated as a cohort
conversion. Search-appearance discovery totals and its filtered page rows are
different grains; the analyzer labels them in `row_grain` so they cannot be
safely mistaken for additive rows.

Bing's separate AI Performance report is not exposed by any documented BWT API
method. Ordinary BWT impressions can include chat responses but do not identify
them, so the archive never labels them as AI citations.

`src/dataforseo-dumps.ts` runs separately on the Monday cron. It discovers
eligible canonical domains from Postgres and calls five bounded current endpoints:
`ranked-keywords` (top 200 rows in the site's saved market; United States · English
by default), `backlinks-summary`,
`backlinks-new-lost` (90 days grouped weekly), and LLM target metrics for
Google and ChatGPT. OS, pre-launch, and retired assets are skipped. Each report
is failure-isolated. Missing credentials, provider failure, incomplete
family evidence, staleness, and budget exhaustion drive the same
automatic integration-health state shown on every property surface.

The Monday cron is not the only way in. `POST /api/signal-collect` runs the same
function scoped to one property (and optionally a subset of its families), so a
property seeded on a Tuesday is baselined on Tuesday for its own price rather
than the portfolio's — see
[On-demand collection](#on-demand-collection-a-baseline-on-the-day-the-bet-launches).
There is deliberately no second collector: the scope narrows the sweep plan, and
every other decision stays where it was — including "one collection at a time",
which the collector enforces for both doors rather than either caller enforcing
it for itself.

### "Nothing for this target" is an answer, not a broken response

A task DataForSEO accepts, bills, and answers with an empty `result` array — its
`result_count` agreeing at zero, or absent — is archived as a **zero-row
collection**: `status = 'success'`, `provider_rows = 0`, the verbatim body in R2.
The provider has never crawled the target, so it holds no summary row for it;
that is the provider's answer and the lane is not red for a week over it.

A response that **contradicts itself** — an empty array under a `result_count`
claiming rows, or a `result` carrying a non-object — stays
`dataforseo_invalid_response`, because "we could not read the answer" and "the
answer was nothing" are different facts. That error message names what the
response actually carried (`result_count`, item count): a failed family writes
a manifest row and **no R2 object**, so the row is the entire evidence a later
reader gets.

### Retrying the provider — and the one 4xx that is retried

A family that fails on the Monday cron loses a week of evidence, so a failure
about the call is repeated: two waits, `[1s, 3s]`, and the ladder's length is the
budget. The budget is per **family**, not per request, so the tracked panel's
dozens of calls cannot multiply it into minutes of sleeping. A retry also
reserves its own $0.25 of the monthly cap before it is allowed to happen — a
repair may never be the call that crosses the cap.

What counts as "about the call": HTTP 5xx, DataForSEO's own 5xxxx envelope codes,
and a call that produced no response at all (dropped connection, our 130-second
timeout). Everything else is about what we asked for and fails immediately.

**429 is the exception.** Every other 4xx would fail identically on every
attempt; a rate limit is about *when* we asked — DataForSEO meters 2000
requests a minute — and the provider states when to come back. So a 429 is
retried on its own `Retry-After` (seconds or HTTP-date) rather than on the
ladder, with the ladder as the floor so `Retry-After: 0` cannot become a hot loop.
The wait is capped at **10 seconds**: past that the family fails with an honest
`dataforseo_http_429` and the next run collects it, because a sweep asleep inside
a ten-minute wait is a sweep that can outlive its own 15-minute lane lease.

### The free account read at the end of a sweep

A run that worked finishes with **one** `GET /v3/appendix/user_data` — the same
free call the *Test connection* probe makes, from the same function
(`src/dataforseo-balance.ts`) — and stamps the prepaid credit it reports beside
the credential, dated with the run's own instant. The credit is the number that
decides whether next Monday's sweep can run, so it should not move only when
somebody presses a button.

It is a deliberate exception to the two rules above, because it is free:

- **No spend, no cap.** It costs no money and no metered quota, so it is not
  weighed against `monthly_caps.data_usd` and its zero cost never reaches the
  run's `costUsd`.
- **Never retried.** The ladder exists so a family the OS planned and paid for is
  not lost to a blip; a courtesy read has nothing to lose, and asking twice for a
  figure nobody is waiting on is how a free call becomes a habit. Its own timeout
  is **10 seconds**, not the paid path's 130.
- **Never the sweep's failure.** A refusal, a timeout, a rejected login or a body
  with no figure all leave the run exactly as green as its reports made it, and
  the card keeps its last sighting *with its age*.
- **Only after a sweep that worked**, and only where a stored credential exists
  to stamp. A run that failed outright has just proved it cannot reach the
  provider; a run with nothing due never went near it.

`dataforseo_dumps_complete` carries `"accountCredit": "refreshed"` or
`"not refreshed"` — the word only, for the same reason `configSource` is the
word only: a balance is a fact about the operator's account and a rotated log
file is not where it belongs. The amount lives on the provider card, with its age.

### The tracked SERP panel (`serp-panel`, S1b)

A sixth family runs on the same cron, for the properties that have a panel in
`config/serp-panel.json` — see that file's README for the field contract and the
validation rules. Three properties of the design are worth reading here because
they are the only places this collector departs from "one family, one call":

- **One family, N calls, one archive.** The live/advanced SERP endpoint accepts
  exactly one task per request and the device is a property of the task, so a
  panel is one POST per **(tracked query, device)** — mobile and desktop. All of
  the responses land in a single R2 object under a single manifest row
  (`report = 'serp-panel'`, `request_count` = terms × devices), because a run is
  still one durable observation per (property, report): no second family for
  the on-demand route to know about, no second landing for the review filer, no
  manifest column. The device rides in the request body the archive stores
  verbatim, and the flattener reads it back into a `device` column. Two devices
  can never dedupe against each other either — the content hash that decides
  `success` vs `unchanged` compares whole archives, and both devices are pages
  of the same one.
- **Absence of config is not a failure.** A property with no panel is filtered
  out *before* the budget gate: it consumes no reserve and writes no attempt
  row. A **malformed** panel is the opposite — it fails that one property with
  `config_invalid` while every other property still collects.
- **A partial answer beats a discarded one.** One tracked query the provider
  accepts and cannot answer is archived with the rest (it was billed, and the
  analysis layer needs to see it as *unknown*); only a panel where every query
  failed is recorded as an error rather than an empty success. Transport
  failures still fail the whole family.

`provider_truncated` is set on every panel archive by design: it reads 20
results of a list that always continues past them.

Every metered result writes `provider_cost_usd` to the append-only manifest.
Before a call, the scheduler requires a conservative $0.25 of room under
`config/constants.json` → `monthly_caps.data_usd`; otherwise it writes a
`budget_exhausted` attempt without calling the provider. That reserve is per
report family, and the panel needs no special case in the gate — but it is the
reserve that sizes the panel rather than the other way round. A term costs two
calls, so the biggest panel that fits inside $0.25 is **31 terms** (62 calls,
$0.248), and `SERP_PANEL_QUERY_LIMIT` is computed from `MAX_REPORT_COST_USD`
rather than hand-set: adding a dimension halves it, and raising it means
raising the reserve. Those four numbers live in
`packages/contract/src/dataforseo.ts` and are re-exported here: the Tower's
Growth tab edits the panel and has to state what a term costs before an
operator adds one, so a second copy of the price would be a number the two
halves could disagree about. The enforcement is only here — the collector is
what refuses an oversized panel, and raising the reserve is argued in
`config/serp-panel.README.md`.

`pnpm signals:analyze-history -- --asset <id> --history <folder> --out <report link>`
writes `executive.json`: at most eight
deterministic, evidence-bearing findings (warning, recommendation, discovery,
or insight). After operator review,
`pnpm signals:publish-insights -- --asset <id> --file <report link>/executive.json`
content-addresses that compact
file and appends it to `noticeos.asset_insight_snapshots` through
[`POST /api/insight-snapshot`](#insight-snapshots-the-executive-publish), so the
one runtime that owns the store does the write; `--remote` is refused.
The Tower reads that snapshot, never the R2 objects or local CSVs. Missing rows remain unknown and no rule recommends deprecation from
absence alone.

## Bing Webmaster signals

The 02:30 UTC daily tick also runs `src/bing-signals.ts`. A single
`env.BING_WEBMASTER_API_KEY` belongs to the central Bing Webmaster account.
The collector calls `GetUserSites` once, intersects those verified hostnames
with launched portfolio assets in Postgres, then calls `GetRankAndTrafficStats` for each
eligible site. A site outside the portfolio, asset #0, a pre-launch property,
or a retired property is never queried.

Each attempt uses the same append-only `signal_runs` / changed-value
`signal_observations` store as Google. Bing's response supplies daily `clicks`
and `impressions` without accepting a requested date range. The collector keeps
actual dates inside the rolling 97-day retrieval horizon; the Tower exposes at
most 90 dates and uses up to seven earlier dates only as chart context. The
stored window ends on Bing's latest actual date. It never manufactures missing
dates or zeroes for the unreported provider-lag tail. Failures are isolated per
site, except a shared authentication/list-sites failure, which records a safe
error for each eligible target.

The lane is daily because Bing documents rank-and-traffic data as daily-updated.
The Tower treats a fresh success as live, an error or more than two missed daily
cadences as degraded, and no attempt as needs-setup.

## Calendar RPC (the Wall's next meetings)

`IngestWorker.calendarUpcoming()` is callable only through Tower's private
Service Binding. It returns the operator's next 48 hours as plain UTC instants
— `{ fetchedAt, feedsConfigured, feedsOk, calendars[], meetings[] }`, each
meeting carrying its calendar label, title, start, exclusive end, all-day flag,
and location.

`calendars[]` is every configured feed as `{ id, color, status }` in **config
order**, present whether or not that calendar answered and whether or not it has
an event today — a surface keys its identity color off this list, so it must not
depend on either. `color` is what the operator pinned, or `null` to leave the
choice to the surface.

`status` is how that feed fared in the round `fetchedAt` names, and `feedsOk` is
exactly the count of `ok`, so the two can never disagree:

| `status` | Codes behind it | What it asks |
|---|---|---|
| `ok` | — | Nothing; its meetings are in the list |
| `misconfigured` | `config_missing_url`, `invalid_url`, `unsupported_scheme` | The operator must edit the secret — and no request is made on its behalf |
| `unreachable` | `http_*`, `timeout`, `unreachable`, `not_calendar`, `too_large` | The round asked and no calendar came back |

The line between the two failures is **"could ingest tell without asking"**, not
"who has to act" — worth stating because a `403`, or an HTML sign-in page served
as `200`, most often means the secret link was **rotated** and needs replacing by
hand. Those are `unreachable` anyway, because only the round could discover them
and no code can distinguish a dead link from a calendar that is briefly refusing
us. So a surface should not render `unreachable` as purely transient; a
`misconfigured` feed, by contrast, can never recover on its own, while an
`unreachable` one may be `ok` on the next round (both are test-pinned).

`env.CALENDAR_FEEDS` is a JSON map `{ "<label>": <feed> }`, where a feed is
either the secret ICS url on its own or
`{ "url": …, "color"?: …, "email"?: … }` — a bare string is exactly `{ url }`,
and unknown keys are ignored. The color may use any CSS notation, but it is
validated against a conservative charset before it leaves here — `;` `{` `}` `<`
`>` and quotes are refused, which drops the swatch (logged
`config_unusable_color`) without dropping the calendar, because the meetings
matter more than the color and escaping is still the rendering surface's job.
`email` names whose calendar this is (see
[invitations](#only-what-the-operator-accepted)) and never leaves the Worker. The
label is the operator's own word for the calendar and is, with the color, the
only part of the entry that ever travels onward.

A named entry carrying no usable url is still **counted** in `feedsConfigured`,
and can never reach `feedsOk`. Dropping it would make a typo read as `1 of 1` —
identical to a calendar that was never configured, and therefore invisible
forever. Counted, it reads as one degraded feed of two, which is what the panel
renders coverage from. It keeps its slot and its color in `calendars[]` too, so
fixing a typo does not reshuffle every other calendar's identity.

**The URL is a credential**: Google's "secret address in iCal
format" reads the whole calendar for anyone holding it, with no account, and the
only revocation is resetting the private URL — which breaks every other copy at
the same time. So it lives here, like every other credential, and the Tower —
LAN-served and deliberately without a bearer — receives values only. A failing
feed is reported as `{"event":"calendar_feed_failed","calendar":"<label>","code":
"http_403"}` and nothing more; the error object a failed `fetch` produces is
never copied into ours, because workerd puts the request URL inside some
transport errors.

Like [`ga4Realtime()`](#ga4-realtime-rpc) this path writes **nothing** — no
`signal_runs`, no observation, no flag, no R2 object. A meeting that was on the
calendar this morning and is gone this afternoon is not an anomaly, and the store
must never be asked to remember it as one.

Feeds are fetched independently, one 10s-timeout request each, under
`NoticeOS-Calendar/1.0` with a contact URL. One feed failing costs its own
events and one point of `feedsOk` — never the other calendar's meetings. A `200`
that is not a calendar (the HTML sign-in page a rotated link serves) is a parse
failure, not a success: fetched is not parsed, and only parsed earns `feedsOk`.

**The five-minute cache caches the fetch, not the answer.** The Wall polls every
60s and these links are served out of Google's own cache with its own refresh
delay, so asking faster earns throttling rather than fresher data. The window is
recomputed from the cached events on every call, which is why a meeting that
ended two minutes ago leaves the list on the next poll, and why `fetchedAt` is
the age of the *bytes* — up to five minutes older than the request. That is the
field to render staleness from. The feed map is part of the cache key, so adding,
removing, or recoloring a calendar takes effect on the next poll rather than
waiting out the TTL.

### Only what the operator accepted

An invitation sitting unanswered in a calendar is not a plan. When this lane can
tell whose calendar a feed is, an event whose guest list carries the operator as
`DECLINED`, `TENTATIVE`, or `NEEDS-ACTION` is not reported — only what was
*actually accepted* shows, so a maybe hides too. An `ATTENDEE` line for the
operator with **no** `PARTSTAT` also hides, because RFC 5545's default for an
absent one is `NEEDS-ACTION`; that is the single branch where a provider quirk
could cost a real meeting, so it is pinned by its own test and is a one-line flip
in `selfPartStat`.

Nothing is filtered when there is no guest list (a solo focus block), when the
operator is not on it (somebody else's meeting on a shared calendar), or when
their identity is unknown. Filtering an event nobody invited them to would be
inventing an answer they never gave.

Identity comes from the `email` key when the operator sets one; otherwise it is
derived from the url, because Google's private address embeds the calendar id as
`/calendar/ical/<id>/private-<key>/basic.ics` and a person's primary calendar id
is their account address. The derivation's limits are deliberate: a secondary,
shared, holiday, or resource calendar has a synthetic id
(`…@group.calendar.google.com`), and a non-Google feed has no `/ical/<id>/`
segment at all. Both turn filtering **off** for that feed rather than guessing —
a wrong identity hides real meetings, which is worse than showing one invitation
too many.

Declining a single occurrence of a series arrives as an override `VEVENT` with
the operator `DECLINED`. It still suppresses the instance it replaces, so the
declined standup does not reappear at its original time as though it had never
been answered.

### Times, without a timezone database

Every instant comes out of `Intl`, which already ships the full IANA rules; there
is no timezone table in this Worker to go stale. A zone's offset is read back out
of the formatter (format the instant into the zone, then re-read those wall-clock
fields as if they were UTC — the difference is the offset), and a wall clock is
converted to an instant in **two passes**: the first pass gets an offset that is
wrong within an hour of a DST transition, the second re-asks at the instant the
first produced and gets the offset actually in force. That is what keeps a 09:30
meeting at 09:30 on both sides of a spring-forward instead of sliding an hour,
and it is pinned against both US transitions.

Recurrence iterates in the wall-clock domain for the same reason: dates step and
the time of day is carried, so a weekly slot survives a transition. An all-day
event's length is carried in whole days, so a Friday-to-Monday away weekend
crossing the fall-back stays three calendar days instead of ending at 23:00 on
the Sunday. All-day starts resolve to midnight in the feed's zone
(`X-WR-TIMEZONE`), not UTC — an all-day event is a claim about the operator's
calendar day. A floating time (no `Z`, no `TZID`) resolves the same way, falling
back to UTC when the feed declares no zone.

### The RRULE subset, and what degrades

The parser is hand-rolled with no dependencies, and its recurrence support is the
shapes a calendar full of *meetings* contains, not RFC 5545:

| Supported | Notes |
|---|---|
| `FREQ=DAILY` | `INTERVAL`, `COUNT`, `UNTIL`, and `BYDAY` read as a weekday filter (the "every weekday" rule some clients write as DAILY) |
| `FREQ=WEEKLY` | `BYDAY`, `INTERVAL`, `COUNT`, `UNTIL`, `WKST` |
| `FREQ=MONTHLY` | either `BYMONTHDAY` (positive, or counted from the month's end) **or** one ordinal `BYDAY` such as `2TU` / `-1FR` |
| `EXDATE` | any number of lines, with `TZID` or `VALUE=DATE` |
| `RECURRENCE-ID` | a second VEVENT sharing the UID replaces that instance — moved, retitled, or cancelled |
| `STATUS:CANCELLED` | skipped |

Anything else — `FREQ=YEARLY`, `BYSETPOS`, `BYMONTH`, `BYWEEKNO`, `BYYEARDAY`,
sub-day `BY*` parts, a MONTHLY `BYDAY` with no ordinal, a WEEKLY `BYDAY` with one
— **degrades to the series' base event and logs
`calendar_rrule_unsupported`**. It does not throw and it does not cost the feed
its `feedsOk`: an unsupported rule is a thin answer, not a broken feed, and one
annual reminder rendering once is better than a calendar row that goes blank.
`RANGE=THISANDFUTURE` on a `RECURRENCE-ID` is treated as a single-instance
override. An `EXDATE` whose value type disagrees with its series (a DATE
exclusion on a timed series) will not match.

Occurrence identity — what `EXDATE` and `RECURRENCE-ID` match on — is the UTC
**instant** for a timed event, because a feed may spell the same moment as a
`TZID` wall clock or as `…Z` and both name the same instance; an all-day
occurrence is keyed by its civil date instead.

Rule expansion is bounded on both sides: `[now-24h, now+48h]`, with the cursor
fast-forwarded to the window so a daily meeting running for years costs a
handful of steps rather than thousands. `COUNT` is the exception — the series
has to be walked from `DTSTART` to know where it stops — and the walk is capped.
Non-recurring events are *not* bounded behind `now`: they are a finite list, so a
week of leave that started on Saturday still reports as in progress on Monday.

The window is `[now, now+48h]` plus anything in progress, sorted by start then
title, capped at 20.

## Local development

The operational store is Postgres. Local R2 keeps its metadata and blobs in
the installation's `.wrangler/state` folder. Start a throwaway installation
with `pnpm start -- --dir <folder> --port <unused-port>` from the repo root;
its guarded setup is described in the [start guide](../../scripts/README.md#a-new-installation-in-one-command-pnpm-start).

For an explicitly configured development database, the isolated Worker command
is `pnpm --filter @noticeos/ingest dev`. It refuses while the ingest door is
held, so another runtime cannot share local R2 persistence. In the Docker
stack, ingest already runs as an auxiliary Worker inside the Tower's runtime
in the app container and is reached through the loopback door on port 8791
there.

### Try the endpoints on an explicitly selected development installation

Use the port and synthetic tokens belonging to that installation. The examples
below use the conventional ingest door; they must not be run against a live
installation without approval.

```bash
# healthz
curl -sS http://localhost:8791/healthz

# pulse (asset-authed)
curl -sS -X POST http://localhost:8791/api/pulse \
  -H 'authorization: Bearer dev-example-com-token' \
  -H 'content-type: application/json' \
  -d '{"asset":"example.com","generatedAt":"2026-07-05T02:00:00.000Z",
       "capabilities":["signups","plansSaved"],
       "metrics":{"signups":{"last24h":10,"avg7d":9.4,"total":4210},
                  "plansSaved":{"last24h":0,"avg7d":6.5,"total":1900}},
       "flags":[{"severity":"info","kind":"milestone","metric":"signups","msg":"4000 signups"}]}'

# revenue — JSON array (operator-authed)
curl -sS -X POST http://localhost:8791/api/revenue \
  -H 'authorization: Bearer dev-operator-token' \
  -H 'content-type: application/json' \
  -d '[{"kind":"revenue","asset":"example.com","period":"2026-06","family":"affiliate","amount":168.20,"source":"cj-export","booking_state":"estimated"}]'

# revenue — CSV export
curl -sS -X POST http://localhost:8791/api/revenue \
  -H 'authorization: Bearer dev-operator-token' \
  -H 'content-type: text/csv' \
  --data-binary $'kind,asset,period,family,amount,source,ref,booking_state,note\nrevenue,example.com,2026-06,ads,560.00,raptive-report,,estimated,June ads\ncost,<os-asset-id>,2026-06,inference,78.90,,os-overhead,estimated,'

# annotation — a backdated deploy (operator-authed)
curl -sS -X POST http://localhost:8791/api/annotations \
  -H 'authorization: Bearer dev-operator-token' \
  -H 'content-type: application/json' \
  -d '{"asset":"example.com","kind":"deploy","at":"2026-07-12T18:04:00.000Z",
       "ref":"a1b2c3d","note":"July SEO batch — 240 recipe titles"}'

# watch window — pre-register the check on that batch (operator-authed)
curl -sS -X POST http://localhost:8791/api/watch-windows \
  -H 'authorization: Bearer dev-operator-token' \
  -H 'content-type: application/json' \
  -d '{"asset":"example.com","ref_kind":"annotation","ref":"1",
       "metric_integration":"gsc","metric":"clicks",
       "registered_at":"2026-07-12T18:04:00.000Z",
       "baseline_start":"2026-06-14","baseline_end":"2026-07-11",
       "check_offsets":[7,14,28],
       "thresholds":{"ship":{"direction":"up","min_delta_pct":10},
                     "kill":{"direction":"down","min_delta_pct":10}},
       "note":"July title batch"}'
```

### Exercise the crons locally

Against a running ingest door these all work as written — the door
recognises `/__scheduled`, `/cdn-cgi/handler/scheduled` and its deprecated
`/cdn-cgi/mf/scheduled` spelling alike, and calls the same dispatch table the
deployed `scheduled()` handler uses (`src/dispatch.ts`). The `pnpm dev` line is
for running this Worker in isolation, with no other runtime holding the door —
and it refuses if one does.

```bash
pnpm dev -- --test-scheduled       # refuses while the door answers
curl 'http://localhost:8791/__scheduled?cron=0+*+*+*+*'    # ingest-freshness
curl 'http://localhost:8791/__scheduled?cron=30+2+*+*+*'   # pull adapter + Bing
curl 'http://localhost:8791/__scheduled?cron=0+3+*+*+*'    # asset-#0 self-pulse
curl 'http://localhost:8791/__scheduled?cron=30+3+*+*+*'   # watch-window evaluation
curl 'http://localhost:8791/__scheduled?cron=0+4+*+*+*'    # tech/GEO hygiene guards
curl 'http://localhost:8791/__scheduled?cron=30+4+*+*+*'   # Clarity export (1 of 10 daily calls)
curl 'http://localhost:8791/__scheduled?cron=15+12+*+*+*'  # GA4/GSC/BWT raw archives
curl 'http://localhost:8791/__scheduled?cron=45+12+*+*+1'  # DataForSEO (METERED — see below)
curl 'http://localhost:8791/__scheduled?cron=*/15+*+*+*+*'  # counters + GA4/GSC
```

(The quotes are load-bearing on that last one — unquoted, the shell globs the
`*`s before curl ever sees them.)

**Against the Docker stack, use `pnpm os:run-job` instead** — it is the
supported path and it targets the door the runner itself fires at, inside the
app container:

```bash
pnpm os:run-job -- "15 12 * * *"     # same lane, no hand-built URL
```

`__scheduled` is the older Wrangler alias; the current dev server answers at
`/cdn-cgi/handler/scheduled?cron=…`, which is what `os:run-job` builds. Note that
its HTTP client gives up after ~2 minutes while **the Worker keeps running** — a
timed-out tick is not a failed run. Check the report runs before re-firing,
or you will pay twice on a metered lane.

Every line above is free except the DataForSEO one, which **spends real money**
on every invocation: it is the only lane that calls a metered provider, and
triggering it by hand bills the same as the Monday cron. It fails closed under
`config/constants.json` `monthly_caps.data_usd`, so the cap is a backstop, not a
reason to run it casually. Run it by hand only when you intend to pay for a
fresh snapshot — for example after adding panel queries, rather than waiting
for Monday.

## Deploy

Both Workers bind `POSTGRES` through Hyperdrive. Provision the approved
Postgres and R2 resources, supply the bootstrap configuration described in
[operations](../../docs/06-operations.md#bootstrap-secrets-vs-integration-credentials),
and apply the frozen Postgres schema through the operator-only migration
command before deploying. Provider credentials are connected in the Tower.
Remote provisioning, migrations and deployment each require explicit approval.

## Gate commands

`pnpm typecheck` (tsc) · `pnpm test` (vitest + `@cloudflare/vitest-pool-workers`
against isolated real Postgres copies; one runtime per Vitest
worker is reused from file to file, and every file starts with fresh modules,
an emptied bucket and a store migrated from nothing — `test/clean-start.ts`;
work a test leaves running is refused the store once the test ends —
`test/store-fence.ts`; both proved by `test/isolation-probe.ts`; the Worker runs
on the bindings `vitest.config.ts` declares and never on the checkout's
`.dev.vars` — `scripts/worker-config-folder.mts`, proved by
`test/test-env.test.ts`) · `pnpm build`
(`wrangler deploy --dry-run`).
