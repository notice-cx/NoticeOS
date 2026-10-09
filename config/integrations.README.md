# `integrations.json` — the per-asset integration scope/setup register

> **Seed and export, not source of truth** (2026-09-05, D22 — epic `ro-syok`):
> `pnpm config:seed` loads this installation's copy (else this generic default)
> into the store's `config_documents` table, the running OS reads and saves it
> there, and `pnpm config:export` writes it to `installation/` so a diff stays
> the record. Until an install seeds, every read falls
> back to the copy compiled into the Workers and nothing here changes.

The saved inventory of, **per asset × per integration, whether that lane
applies and what setup/proof is known.** Current health for automated lanes is
observed from collector runs; it is not a switch in this file. This register is
the living form of the "inventory pending"
that [decisions.md](decisions.md) D5 (revenue plumbing) and D8 (analytics
inventory) point at, and the substrate [doc 14](../docs/14-design.md)
flow C (guided integration setup + validation probes) reads.

This register is config, not data. It changes in the store (D22), from a
site's Data sources tab or with `pnpm config:apply`, never from a cron or a
Tower health control; the installation folder's file is its export. The catalog
itself ships with the product (see
[Who edits the catalog](#who-edits-the-catalog-nobody-in-the-tower-2026-09-23-bead-ro-ujb99614)).

## The honesty definition of "live"

> **`live` means THE OS CAN CONSUME THE LANE end to end — not that the asset has
> the tag / link / App installed.**

A GA4 tag firing on the site, an unarchived provider script, or a live CJ program are
**not** `live` here if the OS's central pull/cron/ingest that would consume them
isn't built. Each lane's exact bar is its row in
[doc 11's catalog](../docs/11-integrations.md#the-catalog) (e.g. GA4 `live` =
"the central GA4 pull returns this asset's sessions/events on the Sense cron,"
not "the tag fires"). This is the whole point of the register:
an agent that plans from a lane it can't actually read is confabulating
([doc 11](../docs/11-integrations.md) opening).

A fresh clone's register names no site, so it has no lanes until one is added.
The Tower derives their current state from the latest attempt. The file records
reviewed enrollment/proof notes, but a stale file value cannot turn a fresh
success gray or keep an errored collector green.

## The five states (verbatim from [doc 11](../docs/11-integrations.md))

`live | degraded | needs-setup | skipped | not-applicable`

- **`live`** — the OS can consume the lane now (see the honesty definition and
  each lane's row in doc 11's catalog). For collector-backed lanes this renders only from
  a fresh successful run.
- **`degraded`** — a reduced-capability lane. For collector-backed lanes the
  Tower renders this from the latest error or stale run. Manual/legacy lanes
  may still record a known reduced posture in the file.
- **`needs-setup`** — relevant to this asset but not yet consumable by the OS
  (creds/cron/wiring missing, or blocked upstream on a provider approval).
- **`skipped`** — relevant but **operator-declined for now. REASON REQUIRED**
  in the `note` ([doc 11](../docs/11-integrations.md); [doc 14](../docs/14-design.md)
  flow A). Renders as a hollow notch. Distinct from `not-applicable`: you can
  only decline something that was on the table.
- **`not-applicable`** — the catalog says this lane never applies to this asset
  (doc 11). E.g. asset #0 (the OS itself) has no organic-search or revenue
  surface; a pre-launch node has nothing to measure until launch.

## Shape

```jsonc
{
  "readme": "config/integrations.README.md",
  "changesetRef": "config/changesets/README.md",  // how this file becomes editable — see below
  "version": 1,
  "updated": "YYYY-MM-DD",     // the day this file last changed — the write lane stamps it (bead `ro-auav`)
  "states": ["live", "degraded", "needs-setup", "skipped", "not-applicable"],

  "catalog": [                       // the per-asset-relevant subset of doc 11's table
    {
      "id": "ga4",                   // stable integration id (referenced by assets.<asset>.<id>)
      "label": "Google Analytics 4 (GA4 Data API)",
      "docRef": "docs/11-integrations.md#the-catalog",
      "scope": "property",           // where it can attach: "property" | "portfolio" | "both" — see below
      "layer": "provider",           // whose failure it reports: "os" | "provider" | "property" — see below
      "credential": "shared"         // credential scope: "shared" | "per-property" — see below
    }
    // …
  ],

  "assets": {
    "<asset-id>": {                  // MUST match a saved asset id
      "<integration-id>": {
        "status": "needs-setup",     // one of the five states
        "note": "one line: why skipped (REASON: … — written by the product from the reason chip), or what blocks it",  // optional: absent until there is something to say
        "ref": "lane pointer — placeholder/convention only, never an invented value",  // optional
        "since": "YYYY-MM-DD",       // when this status was recorded — the pipeline refreshes it whenever status changes (ro-t7fz)

        // The per-asset PROVIDER MAPPING (2026-09-05, bead `ro-vu8d.4`) — sparse:
        // only the lanes that have one carry any of these, and only once set.
        // Which lane holds which is declared in `LANE_MAPPING`, beside the
        // `asset-lane` register in scripts/config-registers.mjs.
        "propertyId": "313598867",         // ga4: the numeric id alone
        "siteUrl": "sc-domain:example.com", // gsc / bing-webmaster
        "locationCode": 2840,               // dataforseo
        "languageCode": "en",               // dataforseo
        "host": "us",                       // posthog: us | eu (bead ro-ghis.1)
        "projectId": "596607",              // posthog: digits only
        "funnels": [                        // posthog: optional; 2-10 steps each, at most 10
          { "id": "calculator", "name": "Calculator",
            "steps": [{ "event": "$pageview", "path": "/calculator" }, { "event": "form_start" }] }
        ]
      }
      // … one entry per catalog integration
    }
    // … one block per asset
  }
}
```

**Invariants** (all enforced by the validation below):

- Every `assets.<id>` key is an id in `noticeos.assets` —
  the same set, no more, no fewer (the OS's own asset #0 included).
- Every asset carries an entry for every catalog integration **that the `scope`
  rule does not already answer** *(sparse since 2026-08-04, bead `ro-9mx`)*. An
  omission on a lane that could apply is still the bug this file prevents; an
  omission on one the rule answers is the point — see **Scope** below.
- Every catalog row declares a `layer` — see **Layers** below. There is a
  default (`property`), but a lane that lands there by omission is claiming
  something about whose failure it reports, so the payload test requires the key.
- Every `status` is one of the five states.
- Every `skipped` entry states a reason in its `note`.
- A `note` is **one line** — at most 90 characters, declared as the
  `asset-lane` register's `maxLength` *(2026-09-23, bead `ro-ujb9.96.6.4`)*:
  why the source is skipped, or what blocks it. The Sources tab shows it whole,
  so it is a reason, never a log. Proof is the collectors' own stored runs;
  saved changes are recorded in `config_changes`, and exports provide file diffs.
- A `note` is **absent until there is something to say**, never blank
  *(2026-09-24, bead `ro-ujb9.96.7.22`)*: a site added in the Tower writes
  each source as `{ "status": "needs-setup", "since": … }`, the register
  refuses a blank note, and a first "Not using" writes its reason as a first
  write — its Undo takes the key off again.
- `ref` is always a placeholder, shape, or convention (`properties/XXXXXXXXX`,
  `sc-domain:<domain>`, `CJ SID = per-placement id`), **never an invented real
  id/secret**. Provider credentials are connected on **Integrations** and stored
  encrypted in the database. [Operations](../docs/06-operations.md#bootstrap-secrets-vs-integration-credentials)
  distinguishes them from bootstrap secrets. This register and its exports
  record **status and refs, never credentials.**

## Scope — the register stores obligations, not the whole grid

*(added 2026-08-04, bead `ro-9mx`.)*

Each catalog row declares **`scope`**, which side of the portfolio the lane can
attach to at all:

| `scope` | Means | Derived cells |
|---|---|---|
| `property` (default) | a content asset's own surface — organic search, analytics, an ad network | `not-applicable` on **asset #0**, which is the OS and has no such surface |
| `portfolio` | the OS's own lane, run once for everything (operator notifications) | `not-applicable` on **every content asset** |
| `both` | genuinely applies either side (`uptime`, `github-app`) | none — every cell is declared |

A cell the rule answers is **not written down**, and the Tower generates it —
state and sentence — at render time (`registerCell` in
`apps/tower/shared/integrations.ts`). That removed 15 cells whose notes were two
sentences restated fifteen times, and it means a **new asset arrives owing
decisions rather than paragraphs**: fill in the lanes it could actually use.

The rule **wins** over a declared cell, and a payload test asserts the file
carries none that it would derive — so the file can never end up claiming the
System has an organic-search surface. The 12 `not-applicable` cells that remain
are genuine per-asset decisions (Amazon off portfolio-wide, an ads-only
asset declining CJ, a pre-launch asset whose lanes start at launch) and
each states its own reason.

## Who edits the catalog: nobody in the Tower (2026-09-23, bead `ro-ujb9.96.14`)

The `catalog` half is the **product's own definition** of the data sources it
can collect, not a setting. From 2026-09-05 (bead `ro-x5gu.6`) `/settings`
showed it as an editable ten-column table with an Add; that section is gone,
and every field of the `data-source-catalog` register in
[`scripts/config-registers.mjs`](../scripts/config-registers.mjs) is
`readOnly`, so the write lane refuses an edit from any door. Each field,
decided:

| Field | Does an operator ever change it? | Why not |
|---|---|---|
| `id` | No | The join key every site entry in this file and every collector in `workers/ingest` names the source by. A row with no collector behind its id never collects. |
| `label` | No | The product's name for the source, shown on Integrations, Health and a site's Data sources tab. It names the collector, so it changes when the collector does. |
| `scope` | No | Whether the collector works for a site, for the OS, or both. Editing it hides or shows rows without changing what is collected. |
| `layer` | No | Whose failure a red cell reports (the OS, a provider, the site). It describes the collector's dependency and ordering on Health. |
| `credential` | No | Whether one credential serves several sites. It is a property of the provider's API. |
| `docRef` | No | The product doc section that explains the source. |

What an operator does set about data sources lives where the source is used:
a provider's credential on **Integrations**, a site's mapping and "Not using"
on that **site's Data sources tab**, and when each collection runs on
**Settings → Data collection**.

**A product update still reaches an existing installation.** The register
stays declared so a changeset can insert a new catalog row — with each site's
cell beside it, as `installation/changesets/0008_add-posthog-data-source.json`
did — or remove a retired one. Such a changeset is checked against the
declaration like any other insert.

**An incomplete register is still counted** (bead `ro-qodp`): the matrix
payload derives every site missing a cell for a catalog row
(`undeclaredLanes` in
[`apps/tower/shared/integrations.ts`](../apps/tower/shared/integrations.ts))
and a payload test holds this committed file to declaring them all. With no
Add on any screen, only a hand-written changeset can create that gap.

## Who edits an asset's own lanes (2026-09-05, bead `ro-vu8d.4`)

The `assets` half is a **second declared register** — `asset-lane`, keyed by
lane id under `/assets/<asset>` — and the Tower's surface for it is that
**asset's own Sources tab**, one section per lane card, under the verdict the
card already gives. It carries three things and nothing else:

- **The posture and its reason**, saved a cell at a time. Saving a new posture
  also dates the cell: `since` is declared as a `stamps` pair on the register
  (bead `ro-t7fz`, the same rule the roster's `enabled` carries), so it names
  the day the standing posture was taken, and a reason-only edit leaves it alone.
- **The setup steps**, derived on every read and never tickable. Two of the four
  are things the OS can see (is the mapping written down, has a run returned
  data); the other two say plainly that they are not, because the answer lives
  inside the provider's account.
- **The mapping fields** above — which GA4 property, which Search Console or
  Bing site, which DataForSEO scope, which PostHog region and project. Each is
  validated against the declaration before it is sent and again when it lands,
  so the rules this README states and the rules a save enforces are the same
  lines. PostHog's `funnels` is the one STRUCTURED field (field type
  `posthog-funnels`, bead `ro-ghis.1`): the whole list is one value, edited in
  its own editor on the PostHog row and judged by `posthogFunnelsRefusal` in
  `packages/contract/src/configuration.mts` — the same function the collector
  checks before it builds a query.
- **The posture**, and only the two states an operator genuinely decides:
  `needs-setup` and `skipped`. **This is still not a health toggle.** `live` and
  `degraded` are derived from collector evidence on every read (below) and
  `not-applicable` from the `scope` rule, so none of them is offered as a
  choice, and the state chip on the card stays the observed one whatever the
  file says.
- **How a decline is recorded — one press and a reason chip** *(operator
  decision 2026-09-23, answer A on bead `ro-ujb9.96.7.13`)*. "Not using" on the
  source's row opens three reasons in place — *Don't use this product*,
  *Replaced by another tool*, *Not relevant for this site* — or a line of the
  operator's own (at most 82 characters). The press IS the save: the reason
  and `status: skipped` land in one changeset, with Undo in the toast; "Use
  again" is one press back to `needs-setup`. **A reason is recorded every
  time, and nothing is preselected** — a reason the product picked would be a
  reason nobody gave. The operator never types or sees the `REASON:` prefix:
  the product writes it (`declineNote` in
  [`apps/tower/shared/lane-decline.ts`](../apps/tower/shared/lane-decline.ts)),
  so every `skipped` note still satisfies the `/reason/i` check at the bottom
  of this file, and the prefix is also what tells a decline reason left on a
  source in use again apart from a note saying what blocks it. It replaced a
  typed Reason plus a Posture select, each with its own Save (bead
  `ro-ujb9.96.6.4` had already written the prefix for the operator).
  **The connect panel declines the same way** *(bead `ro-ujb9.96.7.18`)*: a
  row the scheduled job collects anyway (Bing's domain match, a mapped site,
  a DataForSEO candidate) that the operator unticks shows the same chips and
  reads *Still collected* until one is picked; the pick is saved in the same
  Start press through the same ops and `PUT /api/config`, and no reason is
  ever picked for the operator. **Mediavine's settings save never declines**
  *(bead `ro-ujb9.96.7.21`)*: it starts a site's sync and saves the forecast
  calendar, and it refuses to switch a running sync off — that is the Ad
  revenue row's Not using, with its reason — so no `skipped` cell is written
  without one (`workers/ingest/test/mediavine.test.ts`).
- **What the collectors do with a decline** *(bead `ro-ujb9.96.7.18`)*: a
  `skipped` or `not-applicable` cell is not collected at all — no request, no
  attempt row, no spend. It is ONE rule for every provider, `laneDeclined` /
  `cellDeclined` in
  [`workers/ingest/src/lane-mapping.ts`](../workers/ingest/src/lane-mapping.ts),
  asked before a target is built by every collector: Google (GA4, Search
  Console, GA4 realtime, the nightly archive), Bing (15-minute collector and
  nightly archive, the domain-match fallback included), DataForSEO (the weekly
  sweep, its outage re-collection, the connect panel's Start), Clarity,
  PostHog and Mediavine's sync. A named `pnpm signals:collect` of a declined
  source is refused `422 declined`, and the integration health read shows it
  paused by the same rule. `workers/ingest/test/not-using.test.ts` proves a
  declined site is neither requested nor billed.

**What the collectors read is this file** *(2026-09-05, bead `ro-vu8d.16`)*. One
resolver — [`workers/ingest/src/lane-mapping.ts`](../workers/ingest/src/lane-mapping.ts)
— answers every lane's "which property is this asset", and it reads the mapping
fields above FIRST. Where an asset states nothing, the lane keeps exactly the
source it had before, which the Sources tab names per lane: GA4 and Search
Console fall back to the `GOOGLE_SIGNAL_ACCOUNTS` credential's own property map,
Bing to matching the asset's own domain against the sites the central account
lists as verified, DataForSEO to the US/English portfolio baseline (location
2840, language `en`). Each run records which of the two answered — the
`mappingSources` tally on its completion line — and the card prints the sentence
that is true of THAT asset rather than one sentence for both.

Two consequences worth stating plainly:

- **A sign-in is now enough for Google.** An install that connected with OAuth
  (`ro-vu8d.3`) and never pasted an account map collects whatever this register
  maps.
- **And the Google fallback lets go by itself** *(2026-09-05, bead `ro-90mr`)*.
  The credential blob held the same `ga4_property_id` / `gsc_site_url` a second
  time, which D21 and the one-representation rule refuse as a permanent state;
  it survived only so the change above could land with no operator step. It is
  now read **per lane, and only while at least one asset the blob names is
  unmapped** — once every one of them is mapped here, those two fields are not
  read at all and the blob is down to routing (which account authenticates which
  asset) plus each entry's `time_zone`. Nothing has to be migrated: the day it
  flips, the value that stops being read was already losing to this file. The
  Google card on `/integrations` prints which of the two states holds.
- **The timing is the next run once this install is seeded** *(2026-09-05, beads
  `ro-syok.7` and `ro-7xv2`)*. The ingest resolves this file store-first on every
  cron fire — one read per fire in `workers/ingest/src/config-store.ts`, handed
  to each collector by `dispatch.ts` — so a value saved on an asset's Sources tab
  is what the next collector run asks for, with no restart and no deploy. While
  an install has NOT seeded, both Workers read the copy compiled into them (the
  Tower through vite `define`, the ingest through a static import) and a
  hand-edited file still waits for a `pnpm os:up` restart or the next deploy;
  saving through the product puts the document in the store, and every run after
  that reads it. The Sources tab derives which of those two sentences it prints
  from the file's own entry in `GET /api/config`'s `sources`
  (`laneMappingTiming` in [`scripts/config-registers.mjs`](../scripts/config-registers.mjs)),
  so the promise cannot drift from the behaviour.

## Layers — whose failure a lane reports

*(added 2026-08-09, bead `ro-034`.)*

Each catalog row also declares **`layer`**, the tier that has to be working for
its cells to be working. The Tower's Health surface groups its rows by this, in
this order, because **a red row in one layer explains the red rows under it**:

| `layer` | Means | Example |
|---|---|---|
| `os` | this machine and its own connection to the internet | the derived `egress` lane — no cell in this file |
| `provider` | a third-party service, and the account the OS reads it with | `gsc`, `clarity`, `dataforseo`, `github-app` |
| `property` (default) | the asset's own plumbing has to reach the OS; no third party involved | `deploy-annotations`, and the derived `nightly-report` lane |

The layer exists because of what happened without it. On **2026-08-08** the
operator's home internet was down; every nightly lane runs from that machine, so
the OS fired roughly fifteen flags accusing six assets of being dark
(`workers/ingest/src/egress.ts` and `noticeos.egress_checks` carry
the full incident). The OS now decides fault before it attributes a failed fetch,
and this surface renders the same hierarchy: if the `os` row is red, nothing
below it was measured.

**`layer` is not `credential` restated.** They agree on eleven of the thirteen
lanes here and disagree on `clarity` and `posthog`, provider lanes that issue
one token or key per project. How many credentials a lane needs and whose failure
it reports are different facts, so both are declared rather than one derived from
the other.

## The catalog subset (why these, not the whole of doc 11)

The register tracks only **per-asset lanes** — the doc-11 rows whose setup and
health differ per asset. Portfolio-level rows are out of scope: model
providers / AI Gateway, Ahrefs, web
search, deep-research, Google Trends, Wayback, update trackers, marketplace
feeds, HN radar, news/RSS, shadcn MCP, and Cloudflare infra are all owned once
at the OS level, not configured per asset. `discord-webhooks`, `uptime`, and
`github-app` are included because they are **asset #0's** own integrations
(the OS is held to its own register — doc 06); for the content assets, `uptime`
and `github-app` apply per asset (`scope: "both"`), while operator-notification
`discord-webhooks` is asset #0's lane (`scope: "portfolio"`, so every asset's
`not-applicable` is derived rather than written).

`affiliate-cj` and `affiliate-amazon` are split because doc 11's single
"Affiliate networks (CJ live, Amazon off)" row carries two networks that run
*simultaneously with different postures* (on one site: CJ live-program, Amazon
declined). One status per lane can't express that; per-network entries can.
Mediavine uses `mediavineSiteId` and `mediavineEnabled` on the asset's
`ad-network` cell. Set them through Data sources; credentials remain in
Connected accounts. Stored collection evidence determines whether the source
is working. See [Mediavine revenue](../docs/11-integrations.md#mediavine-revenue).

Ad networks are **not** split — AdSense → Raptive/Mediavine is a sequential
migration (one network at a time), so `ad-network` is one lane with the current
network in the `note`.

**A row nothing connects yet is not offered** (bead `ro-ujb9.133`). The two
affiliate rows, `deploy-annotations` and `github-app` have no provider
card on Integrations (`laneProvider` in `apps/tower/shared/integrations.ts`
finds none). While such a cell is only `needs-setup`, the Tower lists no to-do
for it on System health, and a site's Data sources, its source marks and the
audit grid draw no row for it — unless something already arrived for it
(revenue added by hand). Once a cell is live, degraded or skipped it shows like
any other, and a row that gains a provider card is offered again by itself.
The file keeps every cell as written; only what the Tower renders changes.

**`uptime` needs no connection** (bead `ro-ujb9.165`): the OS checks each
site's home page itself every hour, and the cell reads that check — Up, Down or
Not checked — whatever the file declares, unless the file says `skipped` or
`not-applicable`. Until a site's first check it has no row, by the rule above.

## Credential scope: shared vs per-property (updated 2026-07-30)

Two different kinds of "needs setup" hide in one status, and the catalog now
distinguishes them per lane:

- **`credential: "shared"`** — a credential may serve more than one asset
  (Google signal service accounts, the DataForSEO login/password, the CJ PAT+CID, the
  GitHub App…). There may still be several credentials for blast-radius or
  ownership boundaries. The readable `GOOGLE_SIGNAL_ACCOUNTS` source, for
  example, stores each service-account key once and tags it with the assets
  it supports; local compilation extracts keys to per-account
  `GOOGLE_SERVICE_ACCOUNT_*` bindings and keeps routing separate. The
  per-asset cell then tracks **enrollment**, not a duplicated secret: what each
  asset still needs (GA4 Viewer / GSC Full-user grant, SIDs, App installation)
  is the Sources tab's *Provider-side permissions* step and the provider's own
  field links on `/integrations`. The Tower should make this leverage visible:
  a shared credential is one account task plus N small enrollments, not N
  duplicated secrets.
- **`credential: "per-property"`** — no portfolio credential exists (Clarity
  issues tokens per project; PostHog has one project and one read-only key per
  asset; deploy-annotations is wiring in each asset's own pipeline). Every cell
  really is its own setup task.

**No prose fields (2026-09-23, bead `ro-ujb9.96.6.1`).** The catalog used to
carry `liveMeans`, `credentialNote` and `perProperty` sentences per lane, and
the file carried `honestyRule` and `stateMeaning`; the Tower printed them as
paragraphs. They are gone from this generic default: a lane's facts render as
values (`apps/tower/shared/lane-facts.ts`), the rules live here and in doc 11,
and a lane's per-site setup is a step state on its Sources row. The catalog
register no longer declares the three lane fields (bead `ro-ujb9.96.6.20`), and
nothing renders them. An installation seeded before this drops all five keys
from its own store copy with a changeset of `file-json-delete` ops, one per
key, applied with `pnpm config:apply`: `RETIRED_KEYS` in
`scripts/config-documents.mjs` licenses exactly those deletes and nothing
else, so a retired paragraph can leave a store and never come back.

For local development, edit the formatted, gitignored
`workers/ingest/.dev.secrets.json`, not minified JSON inside `.dev.vars`.
`pnpm os:up` compiles the structured source to Wrangler's required dotenv
input before starting the Worker. Production continues to use encrypted
Cloudflare secret bindings; the file is local ergonomics only.

## How observed evidence interacts (health is not editable)

For GA4, GSC, and Bing Webmaster, the Tower loads the latest `signal_runs`
attempt. For DataForSEO it aggregates the newest attempt for each of the five
required `signal_dump_runs` report families. It derives state on every read:

- fresh success → **`live`**
- latest error or older than two expected cadences → **`degraded`**
- no attempt on record → **`needs-setup`**

Those rules apply even when the file still contains an older `live`,
`degraded`, or `needs-setup` value. Explicit `skipped` and `not-applicable`
remain file-owned scope decisions; evidence must not enroll a deliberately
excluded asset. Lanes without an automated health source still use the
file-backed status as their setup posture until a collector lands.

The split is deliberate: applicability and reviewed setup facts are versioned
config; health is live data. The Tower therefore has no HEALTH editor, and
never will: the Sources tab edits the scope decision and the mapping (above),
and the chip beside them keeps reporting what the collectors observed. A Save
from that tab writes the store like every other setting (D22).

## Validation

The register must satisfy the invariants above. The **missing-entry** one is
also a gate (`apps/tower/test/integrations-payload.test.ts`, bead `ro-qodp`), so
a lane added from `/settings` and given to nobody fails a test run and is named
on the page rather than waiting for someone to open this file. To check the
rest by hand, from the checkout, replace `example.com` with the OS site id:

```bash
node --input-type=module -e '
// The register this installation uses: its own export when it has one
// (`pnpm config:export` writes installation/, or NOTICEOS_INSTALLATION_DIR),
// otherwise the product default here in config/.
import fs from "node:fs";
import { readablePath } from "./scripts/installation.mjs";
const file=readablePath("integrations.json");
const j=JSON.parse(fs.readFileSync(file,"utf8"));
// The OS site (the `assets` row with is_os = 1), the one argument once the
// register holds sites. Which sites exist is for the store to say, not this
// file or the migrations: sites are added in the Tower.
const OS=process.argv[1];
if(Object.keys(j.assets).length&&!OS) throw new Error("pass the OS site id");
const SCOPE=Object.fromEntries(j.catalog.map(c=>[c.id,c.scope||"property"]));
const catIds=j.catalog.map(c=>c.id);
const STATES=["live","degraded","needs-setup","skipped","not-applicable"];
const LAYERS=["os","provider","property"];
const errs=[];
// Declared, never defaulted: a lane in a layer by omission still claims one.
for(const c of j.catalog) if(!LAYERS.includes(c.layer)) errs.push(`catalog ${c.id} bad/missing layer`);
for(const[a,lanes]of Object.entries(j.assets)){
  const isOs=a===OS;
  for(const c of catIds){
    // A cell the scope rule answers must be ABSENT; any other lane must be present.
    const ruled=(SCOPE[c]==="property"&&isOs)||(SCOPE[c]==="portfolio"&&!isOs);
    if(ruled&&(c in lanes)) errs.push(`${a}.${c} is derived — delete it`);
    if(!ruled&&!(c in lanes)) errs.push(`${a} missing ${c}`);
  }
  for(const[l,e]of Object.entries(lanes)){
    if(!STATES.includes(e.status)) errs.push(`${a}.${l} bad status`);
    if(e.status==="skipped"&&!/reason/i.test(e.note)) errs.push(`${a}.${l} skipped w/o reason`);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(e.since||"")) errs.push(`${a}.${l} bad since`);
  }
}
console.log(errs.length?errs:"OK", file);
' example.com
```

The command prints `OK` and the resolved absolute path: the generic default
on a fresh checkout, or the installation's export when present. Refresh that
export with `pnpm config:export` to check current saved settings. A fresh
checkout has no sites, so the OS site id may be left out.
