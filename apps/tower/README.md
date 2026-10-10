# apps/tower — the Control Tower

The operator's control surface over the loop: the desk pages and the TV Wall.
One workspace holds two halves — a Vite + React + TypeScript SPA under `src/`,
and the API Worker under `worker/` that serves it `/api/*` over the central
Postgres store. Only `/api/*` and the two `/.well-known/oauth-*` prefixes
invoke the Worker (`run_worker_first` in `wrangler.jsonc`); every other path
is a static asset with SPA fallback.

This file keeps what the code cannot say on its own: the boundary between the
two halves and the ingest service, how a save travels, and how to run and
verify the workspace. For everything else the code is the fact:

- **Routes** are `src/App.tsx` (`deskRoutes` under the shell, `/wall` outside
  it, `/dev/kitchen-sink` only in dev).
- **Design** — tokens, severity colour, the Wall, the operator flows, the
  lexicon — is [docs/14-design.md](../../docs/14-design.md).
- **Components** are indexed in `src/components/registry.ts` and rendered in
  every state at `/dev/kitchen-sink`; check both before adding one.
- **Open work and known limitations** live in the task hub, never here.

## The boundary

Reads dominate. The Worker reads the store directly for the page payloads and
makes exactly two direct writes: an operator's disposition or resolution on an
existing alert (`PATCH /api/flags/:id`) and their decisions on one asset's
queries and findings (`/api/assets/:id/decisions`). Neither rewrites a row of
provider evidence.

Every other write is proxied over the private `INGEST` Service Binding to the
ingest Worker that owns the table: the timeline annotation, the pre-registered
outcome check, an asset's editable columns, the birth of an asset row, every
configuration save and every credential operation. None of them is a migration;
the schema stays operator-only (`AGENTS.md`).

Three reads take the same binding because the ingest holds what they need: the
live-visitors read (`/api/ga4/realtime`), the Wall's next meeting
(`/api/calendar/upcoming`) and the alert-rule replay (`/api/alerts/backtest`,
which needs the seasonal baselines the ingest assembles from its `pulses`
table).

**What the browser never receives.** This Worker holds no credentials
(`wrangler.jsonc` binds `POSTGRES` through Hyperdrive, `ASSETS` and `INGEST`,
nothing else). Google credentials, ICS feed URLs, provider secrets and the
operator bearer all stay inside the ingest; what crosses the binding back is a
payload, field names and metadata. A stored credential reads *set*, never its
value. Raw provider archive objects never enter the request path — the asset
page is a Postgres read model. A failed proxied read becomes a coded error with
an allowlisted reason, never a feed address or a raw diagnostic, and it cannot
delay or blank `/api/wall`.

**Same origin is the write boundary.** `worker/http.ts` (`crossOrigin`) and
`vite/lane.ts` refuse a cross-origin write on every mutating route; the hosted
profile adds workspace entry on top (`scripts/workspace-entry.mjs`). The Wall
is read-only and polls; the desk acts.

### Settings write in place

Settings live in the store once seeded; the compiled config documents in
`worker/compiled-config.ts` are the fallback under every stored document,
never the target of a write. `GET /api/config` says whether a save can land
(`writable`, the `reason` a disabled field shows, and per file whether the
value came from the store or the compiled copy). `PUT /api/config` carries a
changeset of ops; the Worker (`worker/config-route.ts`) applies it over the
`INGEST` binding, so a Save works in every deployment and the page an operator
opens to fix something cannot go blank because the store is empty.

Locally the dev server's write lane (`vite/config-write-lane.ts`,
`apply: "serve"`, compiled out of every build) answers the same path first: it
validates the same changeset `pnpm config:apply` applies (both run
`scripts/config-apply-core.mjs`), sends it to the store, exports the returned
documents to the installation folder (`scripts/installation.mts`), archives
the changeset and commits the changed files — only inside a git checkout, and
it never pushes. The allowlists mean an accepted request can only set a value
at named pointers in named files, or add or remove one asset-keyed entry in a
named container. Format and reasoning:
[`config/changesets/README.md`](../../config/changesets/README.md).

Which page payloads a save refreshes, and how long it waits, is declared once
in `src/hooks/config-backed-queries.ts`, shared by the two write hooks
(`useConfigSave` for a setting, `useCollectionSave` for a row). A store-backed
save refreshes immediately; a file-backed save waits for the local Worker to
restart, because the exported file is one Vite statically imports.

An asset's own columns — lifecycle stage, automation mode, display name — are
store writes on `PATCH /api/assets/:id`; creating one is `POST /api/assets`.
Nothing deletes an asset: the store is history, and the one exit is
`status = 'retired'`, which Archive writes. Adding a site uses both lanes, row
first: the row's `409` is the only authoritative duplicate check, and an
orphaned row is a leftover the operator can see and archive, whereas half a
config entry is not. The composition is `shared/asset-wizard.ts`.

### Tasks are managed here

The task hub is a Dolt server on the operator's host, and `bd` is the only
client that speaks to it — a Worker has neither a route to that host nor a
process to spawn. So, as with config, a second dev-only lane
(`vite/task-lane.ts`, `apply: "serve"`) runs `bd` inside the repository this
host links for the request's project, joined from the saved task projects and
the installation's `task-host.json` (`scripts/task-project-config.mts`); a
stored value never grants filesystem access.

Three guards: same origin (`vite/lane.ts`); an allowlist of twelve `bd` verbs
(`ALLOWED_VERBS`) consulted before anything is spawned, so `delete`, `sql`,
`import` and the rest cannot be reached; and `--actor` on every write, set to
the checkout's `git user.name`, so the hub's audit says the operator did it.

A deployed Worker answers `GET /api/tasks/capabilities` with
`{ live: false, reason }` and `501` on every other task path, so the board
renders the once-a-minute `/api/work` snapshot with its actions disabled
rather than offering a claim that cannot land. `bd` in the repo where the work
happens remains the path an agent uses
([`config/beads.README.md`](../../config/beads.README.md)); this lane is the
operator's.

## API

The standalone switch is `worker/index.ts` (`route`), with the GET payload
dispatcher in `worker/stored-read-route.ts`. Paths that exist today:

**Page payloads (GET, store reads)**

- `/api/health` — `{ ok: true }`.
- `/api/wall` — the one payload the TV, Home and the assets index read
  (`shared/wall.ts`); `/api/wall/feed` is the live feed's own poll.
- `/api/settings` — every portfolio-wide knob, built from the resolved config.
- `/api/assets/:id` — one asset's read model; `?view=` returns one tab.
- `/api/financials?period=YYYY-MM` — one accounting period's ledger, with
  `periods[]` on every answer including the `400`/`404` ones.
- `/api/alerts/history` — settled alerts, offset-paged with a `total`.
- `/api/alerts/rules` — what each rule has cost over the last 90 days.
- `/api/integrations` — the lane matrix the Health page draws;
  `/api/integrations/health` — the connection strip's counts.
- `/api/task-source`, `/api/work` — the saved task source and the task snapshot.

**Proxied over the `INGEST` binding**

- `GET /api/ga4/realtime`, `GET /api/calendar/upcoming`, `POST /api/alerts/backtest`.
- `GET`/`PUT /api/config` — see Settings write in place.
- `POST /api/assets`; `PATCH /api/assets/:id` (any other verb but GET is
  `405`); `/api/assets/:id/order`, `/annotations`, `/watch-windows`,
  `/watch-query-history`.
- `GET /api/site-name` — the title a public page gives itself, for Add a site.
- `GET /api/integrations/providers`; per provider `PUT`/`DELETE …/credential`,
  `…/expiry`, `…/connect`, `…/site-token`, `…/test`, `…/sites`, `…/collect`;
  Mediavine's `…/mediavine/status`, `/settings`, `/sync`.
- Google sign-in: `GET /api/integrations/google/oauth/start` (302 to consent;
  refused unless same-origin), `…/oauth/callback` (302 back to
  `/integrations?google=<code>`, defended by a signed, expiring state the
  ingest verifies), `…/google/properties`. The authorization code never
  appears in a URL this Worker writes.

**Direct store writes**

- `PATCH /api/flags/:id`; `/api/assets/:id/decisions`.

**Agents**

- `POST /api/mcp` — see MCP below.

**Dev-server lanes only** (`vite/*`, `apply: "serve"`; absent from a build)

- `/api/tasks`, `/api/tasks/:id` and its actions, `/api/gates/:id/resolve`.
- `/api/scheduled-jobs`, `/api/workflows` (`scheduled-jobs-lane.ts`; the
  hosted profile answers them from `worker/hosted-workflow-read.ts`).
- `/api/integrations/import-env` — moves legacy env credentials into the
  store; a deployed Worker answers `importable: false`.
- `/api/runner/*` — the local runner's private lane into the ingest.

**Identity and hosting** (`fetch` in `worker/index.ts`, before the switch)

- `/api/auth/*` (email-code sign-in and the agent OAuth routes),
  `/api/session`, `/api/memberships`, `/api/invitations/accept`,
  `/api/demo/presentation`, and the Cloudflare D1 paths from the contract.
  Under the hosted and demo profiles only reviewed stored reads and
  configuration operations reach the switch; everything else is
  `403 workspace_entry_unavailable`.

## MCP — the OS read models, spoken to agents

`POST /api/mcp` serves an MCP server over the same read models the Wall and
asset pages use, so an agent can answer what an asset earned, what its decision
lanes say, and whether a piece of search research has already been paid for.

```jsonc
// .mcp.json, or `claude mcp add --transport http noticeos http://127.0.0.1:5173/api/mcp`
{ "mcpServers": { "noticeos": { "type": "http",
                                "url": "http://127.0.0.1:5173/api/mcp" } } }
```

The transport (`scripts/mcp-protocol.mts`) is shared with the task endpoint
and speaks both protocol eras on one stateless POST: the self-describing
2026-07-28 revision and the `initialize` handshake of the three 2025 versions.
Bodies are JSON, at most 256 KiB; a browser `Origin` other than the Tower's own
is refused. The tools are declared once in `scripts/read-model-tools.mjs`:
`list_properties`, `property_report`, `research_lookup`.

Constraints, all load-bearing:

- **Read-only, enforced.** No tool reaches a write, and
  `test/mcp-route.test.ts` asserts the store is untouched after every tool
  has run. Collection stays behind `POST /api/signal-collect` on the ingest,
  where the lane lock and the budget gate live.
- **Honest nulls.** The tools pass the builders' output through rather than
  tidying it: unknown stays unknown, and booked and forecast are never summed.
- **One vocabulary.** Output uses the decision-lane words the operator reads.
- **No new queries.** Every tool composes an existing builder; a second query
  for the same question would be a second truth.

**Access boundary.** The standalone Tower serves every `/api/*` route
unauthenticated on the trusted LAN and deliberately holds no credentials, so a
key on this one door would be theatre; if the Tower's exposure changes it
changes for every route at once. Hosted, an agent signs in with OAuth: a
request with no credential gets a `401` naming where, the person allows the
agent once on the agent-access page, and each call names its workspace and
needs `evidence:read` (`scripts/agent-access.mjs`). Hosted authentication is
implemented locally under
[doc 23](../../docs/23-configuration-ownership.md) and is not an activated
public service; see the root [README](../../README.md#deployment-status).
`research_lookup` reads through the `INGEST` binding; the recording half
stays behind the operator bearer on the ingest's `POST /api/research-log`.

## Alert language — the store stays factual, the Tower translates

The ingest writes an alert the way a rule sees it: `message` states the
numbers and `rule_inputs` carries the exact inputs the rule tested. That pair
is the audit trail and this app never rewrites it. It is also useless as a
headline, so translation is a read-side concern in one pure function,
`translateAlert` in `shared/alert-language.ts`: what happened, in plain
language with the magnitude; what now, as a rule-specific hint plus the
correlated change inside the 48 hours before the alert fired; and the
statistics behind an evidence control. How sure is not in the sentence — the
severity mark beside it already carries that.

Every surface calls the same translator on the same fields, so no two screens
word one alert two ways. The payloads ship data, not prose: `ruleId`, the
parsed `ruleInputs`, `metric`, the raw `message` and `correlatedChanges[]`
(correlated server-side, where the annotations already are). An unknown
`rule_id` falls back to the stored message, so a new rule degrades to the old
rendering and never to a blank row.

Three lifecycle actions on an open alert, all preserving the evidence: **Mark
read** (`disposition=ack`; a later recurrence is a new event), **Resolve**
(`resolved_at`; the condition cleared) and **Snooze** (`disposition=snooze`
plus `snooze_until`; the same row returns on that date). "Open" is decided in
one place — `openFlagsSql` in `@noticeos/contract`, composed by
`worker/flag-scope.ts` — so the attention rail, the asset page, the lane read
and the write lane's eligibility check can never be on different books. The
snooze horizon (`SNOOZE_MAX_DAYS` in `shared/snooze.ts`) is checked in the
browser and again in the Worker; a snooze is never a silent hide, because the
Alerts page lists snoozed rows outside its filters; and Unsnooze moves
`snooze_until` to now rather than erasing the disposition, so it is also the
toast's Undo. All three act on the condition: a recurring rule's firings are
parked together.

## Local dev

Use the Node and pnpm versions declared in the root `package.json`. Install
from the repo root (`pnpm install`).

Start an isolated installation from the repo root with
`pnpm start -- --dir <throwaway-folder> --port <unused-port>`. It creates its
own Postgres service and keeps local state in that folder; the approved
fresh-install checks are in
[the start guide](../../scripts/README.md#a-new-installation-in-one-command-pnpm-start).
`pnpm seed:local -- --dir <folder>` fills an explicitly marked, empty
development database with invented records and refuses an installation's own
store ([dev fixtures](../../scripts/README.md#dev-fixtures-seedlocal)).

`pnpm --filter @noticeos/tower run dev` serves the SPA with the dev-only lanes
above; `build` and `preview` are the Vite commands.

### A local synthetic viewer

`scripts/demo-viewer.mjs` serves a completed synthetic generation through the
ordinary Tower readers. It requires the clean public source release the
generation recorded, matching evaluator inputs, healthy owned loopback
Postgres and Dolt resources and the same task CLI used to generate the task
history; it refuses ordinary installations and inherited installation
selectors. From that verified public checkout:

```sh
node scripts/demo-viewer.mjs --dir /absolute/synthetic-home --port 6360 --release <commit> --bd-bin /absolute/owned-bd
```

It starts only Vite and its local auxiliary ingest reader — no collectors,
task poller, backup or scheduler — binds `127.0.0.1` only, refuses a demo
build, and stops itself after twelve hours unless `--duration-ms` shortens
that. Stored reads are allowed and product mutations refused; each screen says
the data is synthetic and read-only. Private redacted logs and the stop receipt
stay under `<synthetic-home>/viewers/`. Public hosting is a separate approval
boundary.

### Rendered review

For repeatable rendered captures, start Firefox with Marionette on port 2828,
keep the Tower dev server running, and from the repo root:

```text
pnpm tower:viewport-audit -- --label home --path / --wait-ms 3000 --out docs/artifacts/viewport-audit
pnpm tower:viewport-audit -- --label wall --path /wall --wait-ms 3000 --out docs/artifacts/viewport-audit
pnpm tower:viewport-audit -- --label kitchen --path /dev/kitchen-sink --desktop-height 3000 --out docs/artifacts/viewport-audit
```

The committed `viewport-audit.html` frames a true CSS viewport from query
parameters; `scripts/tower-viewport-audit.mjs` drives the existing Firefox
session and writes desktop and mobile PNGs to `/private/tmp` by default.
`--out docs/artifacts/viewport-audit` keeps a review's captures together, but
that output is gitignored and disposable: never commit it or cite its path as
durable evidence. `--help` lists origin, port, dimensions and output options.

The synthetic Wall the journeys and captures draw is `e2e/wall-fixture.ts`,
on invented `.example` sites.

## Scripts / CI bar

Workspace scripts (`package.json`): `typecheck` runs three `tsc` projects —
`tsconfig.app.json` for the SPA under DOM, `tsconfig.worker.json` for the
Worker under workers-types, `e2e/tsconfig.json` for the journeys; `test` is
Vitest; `build` is `vite build`. The browser journeys, their harness check and
the UX flow walk run behind the root `pnpm test:journeys`
([`e2e/README.md`](e2e/README.md)); install the pinned Chromium once with
`pnpm --filter @noticeos/tower run journey:install`. Two root reports inform
copy and flow judgement and fail nothing: `pnpm ux:gate` lists the Tower's
long visible strings and `pnpm ux:flows` walks every declared flow (it fails
only when a flow cannot be walked). CI runs the gates in
[`AGENTS.md` § The CI bar](../../AGENTS.md#the-ci-bar).

Tests run reader SQL against real Postgres: `test/postgres-store.ts` opens
each test's isolated, migrated copy of a throwaway cluster as the application
role, and tests add their own sites and release their copies after each case.

No unit test reads the checkout's own `config/`: suites state synthetic
documents or use the frozen copies in `test/fixture-config/`, which
`vitest.config.ts` also hands any module that imports a repo config file. A
test importing one, or reading one with `node:fs`, is refused; the only
exceptions are the seed checks listed in
[`scripts/test-config-isolation.mts`](../../scripts/test-config-isolation.mts).
Nor does any test run a Worker on the checkout's `.dev.vars`:
`test/runner-door-e2e.test.ts` boots its dev server on Worker configs copied
into a folder with no secrets
([`scripts/worker-config-folder.mts`](../../scripts/worker-config-folder.mts))
and proves no provider reaches it from the environment.

The fetch switch has its own harness (`test/worker-fetch.test.ts`): real
`Request`s against the isolated store and a refusing `INGEST` double, pinning
which request gets which status and error code. That is why `worker/index.ts`
names its bindings through the structural `TowerEnv` rather than the ambient
`Env` — the app tsconfig excludes the generated `worker-configuration.d.ts`
on purpose, and `test/worker-globals.d.ts` supplies the names the deployment
`satisfies` still needs. Keep that test at the switch's altitude; payload
contents belong in the payload suites.

## Deploy notes

`wrangler.jsonc` binds `POSTGRES` through Hyperdrive. The application uses
`packages/postgres`; migrations are explicit operator work through
`pnpm postgres:migrate`, and neither Worker startup nor deployment applies
them. Remote resource provisioning and deployment require their own approval;
see [hosting and access](../../README.md#deployment-status) and the
[Postgres host profile](../../db/postgres/host/README.md).
