# config/serp-panel.json — the tracked-query SERP panel (S1b)

> **Seed and export, not source of truth** (2026-09-05, D22 — epic `ro-syok`):
> `pnpm config:seed` loads this installation's copy (else this generic default)
> into the store's `config_documents` table, the running OS reads and saves it
> there, and `pnpm config:export` writes it to `installation/` so a diff stays
> the record. Until an install seeds, every read falls
> back to the copy compiled into the Workers and nothing here changes.

Which head terms the weekly DataForSEO lane pulls a **live Google result page**
for, per asset. This is the hand-picked panel [doc 08 §S1b](../docs/08-seo-geo-signals.md)
specifies: 10–25 terms whose exact SERP neighborhood and AI-Overview citation
state are worth paying to watch, next to the broad 200-row `ranked-keywords`
inventory that answers "what do we rank for at all".

This file is config, not data. The observed result pages live in the immutable
R2 archive with one `signal_dump_runs` manifest row per asset per run
(`integration = 'dataforseo'`, `report = 'serp-panel'`); this file owns only
*which* queries exist.

## Every collection is read (the review obligation)

A panel nobody triages is a bill with no reader — one site's went three-plus weeks
unread, which is what ended the honor system. **When a collection lands, the
NoticeOS runner files a review bead into that asset's own tracker**:
labelled `panel-review`, titled *"Triage the `<YYYY-MM-DD>` serp panel for
`<asset>`"*, due seven days later, carrying `noticeos_panel_asset` and
`noticeos_panel_date`. It is filed once per asset per panel day and re-derived
from the manifest rows above, so a runner that was down catches up and a runner
that already filed creates nothing.

What closing that bead requires — every row through the decision rules, every
surface checked against the asset's freeze register and surface-scoped ship
recency before a verdict, and every gap routed to a bead, existing work, its
active window's readback bead, or a named no-action rule — is
[serp-opportunity-execution §Panel review](../docs/playbooks/serp-opportunity-execution.md#panel-review),
followed by
[§Inventory pass](../docs/playbooks/serp-opportunity-execution.md#inventory-pass)
over the rest of that week's collection: the collection day is the anchor for the
review, not the whole of it. Adding an asset here therefore adds a weekly
obligation, not just a weekly cost.

**The trigger is the collection, not this file** (`ro-478`, 2026-08-03). An
asset with no entry here still buys five report families every Monday and gets
the same review bead — same label, same due date, same `noticeos_panel_asset` /
`noticeos_panel_date` — titled *"Triage the `<YYYY-MM-DD>` signal collection for
`<asset>`"* and scoped to the Inventory pass alone. So a panel is what adds the
panel *walk* to a review that would exist anyway, and the review is what proposes
new entries here. Only an asset that collects nothing owes nothing.

The hourly filer lives in `scripts/runner/panel-review.mjs`, reading
`GET /api/serp-panel-landings` on the ingest worker.

## Field contract

- **`assets.<id>.queries[]`** — the tracked terms, verbatim, as a searcher types
  them. Sent one per provider call **per device** (the live/advanced SERP
  endpoint accepts one task per request, and the device is a property of the
  task), all with the collector's fixed dimensions: United States
  (`location_code: 2840`), English, **phone and desktop**, with the asynchronous
  AI Overview requested so its presence and citations are readable.
- **An entry is a string, or an object carrying its cluster.** `"big mac
  calories"` and `{ "query": "big mac calories", "label": "Item head" }` are both
  valid, in any mix. `label` is the **bet the query measures** — the grouping a
  readout needs to answer "which bet is working" instead of showing twenty
  unrelated strings. It is optional per asset and per query, and a panel that
  labels nothing behaves in every respect as it
  did before the field existed. A label belongs to the term, so both of a term's
  device readings carry it, and it costs nothing — it is never transmitted.
- An asset with **no entry here is skipped silently** — no call, no manifest
  row, no attempt. Absence of a panel is not a failed collection, and doc 08's
  build order says to add a panel only where the broad inventory cannot answer
  the question.

## Validation (a bad panel is a loud error, not a quiet one)

Each rule below fails that **one asset's** panel for the run with a
`config_invalid` manifest row; every other asset still collects.

- **≤ 31 queries — and that number is derived, not chosen.** The budget gate
  reserves $0.25 for one report family before it calls, so the biggest legal
  panel is whatever $0.25 buys: 31 terms × 2 devices × ~$0.004 = $0.248. It was
  10–25 in doc 08, then a hand-set 40 on 2026-08-01 when the cluster-discovery
  rules earned tracked terms of their own (water intake, weight-loss percentage,
  ffmi); adding the phone on 2026-08-04 (`ro-o1n`) doubled what a term costs and
  therefore halved it. **Adding a device halves the ceiling; raising the ceiling
  means raising the reserve**, which is a decision about money and belongs in
  `workers/ingest/src/dataforseo-dumps.ts` next to the cap, not here. A panel
  past the ceiling is a config error,
  not a silently trimmed list: quietly dropping the tail would bill for a panel
  nobody asked for and answer a different question than the file states.
- **No empty `queries` array, no blank strings.** An empty panel is a mistake
  worth seeing; skipping it silently would make it indistinguishable from an
  asset that was deliberately never given one.
- **No duplicates** (compared case-insensitively, trimmed). Two spellings of one
  term is one SERP billed twice.
- **A `label`, if present, is a non-blank string of at most 60 characters.**
  Blank is not "no label" — omitting the field is; a cap of 60 keeps the field a
  group *name* rather than an explanation of the bet, which belongs where the
  decision lives. The limit is ours, not the provider's: the label is never
  transmitted (see below).
- **One cluster, one spelling** (compared case-insensitively, trimmed). Grouping
  is an exact match on the stored label, so "Item head" and "Item Head" would be
  two bets in the readout and one in the operator's head — the duplicate-query
  rule applied to the group name, and just as invisible once archived.
  *(2026-09-05, bead `ro-cnsj`.)* The Growth tab's Bet column **refuses** a label
  that differs from one this panel already spells only in case, before the edit
  becomes a request, and so does `pnpm config:apply` — one rule
  (`clusterSpellingRefusal`, declared on the register as `clusterField`) rather
  than a `config_invalid` manifest row next Monday. Joining a cluster with its
  exact spelling, and moving a term to a genuinely different bet, are both
  ordinary edits; only a second spelling of one cluster is refused.
  **And the spelling is one click away** *(2026-09-05, bead `ro-g318`)*: the Bet
  column offers the bets this panel already names as a picker, because a refusal
  an operator can only satisfy by retyping a string they cannot see is friction
  the list removes. It is a *picker*, not an allowlist — the field declares
  `candidates: 'suggest'`, so naming a bet nobody has used yet is accepted, which
  is a common and legitimate edit. The asset columns elsewhere declare nothing
  and stay closed, because an asset id the OS does not have is a typo rather than
  a new asset.

## Semantics worth knowing

- **Device is two dimensions: phone and desktop** (`ro-o1n`, the operator's
  "Yes" on 2026-08-04; doc 08 asked for the pair from the start). Every tracked
  term is read on both, because a phone result page is not a narrower desktop
  one — an AI Overview can consume the click on one surface and not the other.
  Most food/health search happens on a phone, so a desktop-only panel was
  answering *"is this click consumed?"* about the minority surface: the panel's
  own question, asked where the traffic is not. What that costs, and how it
  stays inside the gate, is under *Cost* below.
  - **The device is recorded with the observation, and no schema changed.**
    `device` is a documented field of the provider's task, so it rides in the
    request body the archive already stores verbatim; the flattener reads it
    back out into a `device` column in `dataforseo-serp-panel.csv`. No manifest
    column, no migration, and a page can never lose the device it was read on.
  - **Two devices never dedupe against each other.** Both are pages of ONE
    archive, and the content hash that decides `success` vs `unchanged`
    compares whole archives — so a device's page is never compared against
    another device's. Even identical result pages stay two rows, because the
    archived request bodies differ.
  - **The three-state AI Overview rule applies per device.** A term can be
    `aio_present = true` on the phone and `false` on the desktop; that is the
    finding, not a contradiction. Never sum or average the CSV across `device`
    — filter to one first.
  - **Rows collected before 2026-08-04 read `desktop`.** From the family's first
    collection until that day the collector had exactly one `device` literal in
    it, so every stored archive already carries `device: "desktop"` in its
    request body and nothing had to be inferred. Where a page carries no device
    at all — an archive assembled some other way — the flattener backfills
    `desktop` rather than leaving it empty, because it was **structurally** true
    rather than merely likely. (This is the opposite call from the panel's
    missing cluster labels, and for the opposite reason: a label was never sent,
    so inventing one would invent evidence. A device was sent every time.)
  - **The executive snapshot is still desktop-only, deliberately.** Its two panel
    readers — the AI-Overview evidence the query decisions join on, and the block
    the Tower's panel scoreboard renders — each reduce the panel to one
    observation per query and have no device dimension yet (`ro-14d.1`). They
    name the device they read in one place (`PANEL_SNAPSHOT_DEVICE`), rather than
    inheriting whichever row happened to come first or last: they break ties in
    opposite directions, so collection order could not have decided it for both.
    Desktop, because that is the surface their own prose already claims. A device
    dimension must not change what an existing rule means as a side effect of
    being collected.
- **The panel reads the top 20 results.** An asset holding position 30 records
  no rank rather than a rank of 30 — "not inside the tracked depth", never
  "not ranking".
- **A missing AI Overview and an unreadable one are different facts.** When the
  asynchronous overview fails to load, the archive says *unknown*; only a result
  page that parsed cleanly with no overview in it says *no*. The flattened
  `dataforseo-serp-panel.csv` keeps that distinction as empty-vs-`false`, and
  the query decisions treat unknown exactly like an untracked query.
- **Cost rides the existing gate — and the second device doubled it.** Each
  query is one metered call per device (~$0.004 each), so a 23-term panel is
  roughly $0.18/week and a 28-term panel $0.22/week. The collector reserves the
  same per-report amount ($0.25) as every other family before calling and fails
  closed under the portfolio `monthly_caps.data_usd` cap — there is still no
  panel-shaped exception in the gate, which is precisely why the query ceiling
  had to halve. Both devices' calls land on the **one** manifest row, so the
  Tower's month-to-date spend meter shows the real weekly bill without knowing
  the panel gained a dimension. The cluster label adds nothing to any of this: it
  is never transmitted, so it is the one panel field with no price.
- **The label is stored with the observation, not looked up** (`ro-282.2`). The
  collector writes it into the archived page envelope beside `path` and
  `attempts`, and the flattener reads it from there — it never opens this file.
  Two consequences, and both are the point: **renaming a cluster here relabels
  the collections that follow it and leaves every archived one alone** (a label
  read from today's config would silently retitle history and record nothing
  about the change), and **a query labelled today has empty `query_label` on
  every row collected before today**, because that is what was true.
- **The label is never sent to DataForSEO.** The request body is posted verbatim,
  so it carries only fields the provider documents; the label rides beside it in
  our own envelope. The provider's free-text `tag` (255 characters, echoed back)
  was the alternative and was rejected: it already carries `<asset>:<report>` as
  the archive's join key, and overloading it would make every reader parse a
  delimiter out of operator-written prose to send our internal taxonomy to a
  third party that has no use for it.
- Editing the panel changes what the asset is *measured on*. Terms come and
  go for real reasons (a bet was placed, a market was ruled out by
  [serp-authority-gate](../docs/playbooks/serp-authority-gate.md)); record the
  reason where the decision lives, not here.
- **The Tower edits this panel, on the asset's Growth tab** *(2026-09-05, bead
  `ro-x5gu.4`; it could only remove one with its asset before, `ro-sk7q`)*. The
  surface is `/assets/<id>/growth`, under the tracked-panel board that reads the
  same panel back: a **Tracked queries** table where a term is added, relabelled
  and removed one changeset at a time, each with the Undo in its toast. It is not
  a wholesale file write — this file is still off `ALLOWED_FILES`, so no
  `file-json-set` can reach `/refresh`-style structure or an undeclared key.
  Three declarations in `scripts/config-registers.mjs` license exactly what the
  tab does and nothing else: `serp-panel-queries` (the list at
  `/assets/{asset}/queries`, whose two fields are the `query` and its `label`),
  `serp-panel-assets` (the whole entry, opaque, one asset id per op) and the
  `ADDABLE_CONTAINERS` line both sit on.
  - **The first term files the entry; the last one out takes it away.** A JSON
    pointer never creates structure, so an asset absent from this file has no
    `queries` container to append to — the first Add writes the whole entry at
    `/assets/<id>` instead. The mirror matters more: removing the last term
    removes the entry rather than leaving `queries: []`, which the validation
    above refuses and which would be indistinguishable, to a reader, from an
    asset that deliberately buys nothing.
  - **The add-asset wizard still writes nothing here**, and that decision is what
    this surface implements rather than works around: a panel is a weekly bill
    plus a weekly review obligation, so the entry appears the first time an
    operator deliberately buys one and not a moment earlier.
  - **The spend is stated where the spend is decided.** The tab prints the
    panel's own weekly bill and its size against the query ceiling as a meter,
    directly above the Add control, and names the ONE guard that already
    exists — the portfolio's `monthly_caps.data_usd` on `/settings`, which the
    collector reserves against before every family and fails closed under. No
    second guard was invented for the Tower. The ceiling is refused *in the form*
    as well as by the collector, so a 32nd term cannot land here and fail the
    whole panel next Monday; the money facts behind both numbers moved to
    `packages/contract/src/dataforseo.ts` so the surface and the collector price
    a term identically (`workers/ingest/src/dataforseo-dumps.ts` re-exports them,
    and still owns the enforcement).
  - **The asset page's Delete still removes the entry with the asset**, listed by
    name in the confirmation beside every other file the asset is in. Before
    `ro-sk7q` a deleted asset left its panel behind naming an id the store no
    longer had, and the confirmation never mentioned the file.

## Seeds

A fresh clone tracks no terms: `assets` is empty until an operator buys a
site's first panel. Which terms an installation seeded, and why, is its own
history.
