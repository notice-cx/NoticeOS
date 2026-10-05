# `signal-panels.json` — which assets get a standing panel

> **Seed and export, not source of truth** (2026-09-05, D22 — epic `ro-syok`):
> `pnpm config:seed` loads this installation's copy (else this generic default)
> into the store's `config_documents` table, the running OS reads and saves it
> there, and `pnpm config:export` writes it to `installation/` so a diff stays
> the record. Until an install seeds, every read falls
> back to the copy compiled into the Workers and nothing here changes.

The roster of sites whose local signal panels are kept current on a standing
cadence, so a site's agent reads panels instead of re-pulling providers.

The roster the panel refresh walks. It answers exactly one question per asset:
**does this asset's local panel dir get kept current, and if not, why not?**
Enabled refreshes also publish their completed recommendations to Tower; the
advisory-only publication and failure contract lives in the
[standing refresh documentation](../scripts/README.md#the-standing-panel-refresh-signalsrefresh).

The panel dir itself, what a consumer reads from it, and the honesty rules that
govern it are **not** duplicated here — they are the read contract in
[doc 20](../docs/20-signal-panels.md), which is what an asset repo's stanza
points at. This file is the roster; that doc is the contract.

## Why a roster at all

The archives were always on a cron. The **flatten** was not: until 2026-08-03,
`.local/signal-dumps/analysis/<asset>/` held whatever an operator last ran
`pnpm signals:download && pnpm signals:analyze` for. One site's panel was a
single 2026-07-30 pull — and that four-day window still caught a
search-visibility collapse the asset repo could not see for itself, which is
the whole argument for putting the lane on a cadence rather than on somebody
remembering.

A cadence needs a list of what it walks. Turning "every asset" into that list
implicitly would be wrong twice: asset #0 has no search surface to panel, and an
asset whose collectors are not live yet would get an **empty** panel dir —
which is indistinguishable on disk from a collapsed one, the exact ambiguity
[doc 02](../docs/02-signal-contract.md) exists to prevent. So membership is
declared, with a reason, and a skipped asset says why it is skipped.

## Shape

```jsonc
{
  "readme": "config/signal-panels.README.md",
  "contractRef": "docs/20-signal-panels.md",   // what CONSUMERS read
  "version": 1,
  "updated": "YYYY-MM-DD",     // the day this file last changed — the write lane stamps it (bead `ro-auav`)

  "refresh": {
    "cadenceRef": "scripts/os-up.mjs CONFIG.panelRefreshCron",  // see below
    "windowDays": 35,              // how far back one pass asks the ingest for archives
    "freshnessMaxAgeDays": 7,      // the bar freshness.json grades each source against
    "providerCallsPerPass": 0,     // stated, because it is the load-bearing fact
    "providerCostUsdPerPass": 0    // see "Where the cadence lives"
  },

  "assets": {
    "<asset-id>": {                // MUST match a saved asset id
      "enabled": true,
      "reason": "live-lanes",      // live-lanes | no-lane-yet | not-applicable
      "task": "ro-2zk.2",          // optional: the task tracking an off row's enabling
      "since": "YYYY-MM-DD"
    }
    // … one entry per asset, including the disabled ones
  }
}
```

**Invariants:**

- Every asset id the store's `assets` rows hold (the seed migration's and
  every later migration's) has an entry — including the ones that are off. An asset
  missing from this file is an undocumented gap; an asset present with
  `enabled: false` is a decision.
- A disabled entry's `reason` says what would enable it — `no-lane-yet` turns on
  once one of its search sources is live (the Tower refuses it before then) —
  and its `task` names the task tracking that, if one exists. There is no
  free-text note *(2026-09-23, bead `ro-ujb9.96.6.17`)*: which sources are live
  and since when is the asset's own Sources tab, read from
  `config/integrations.json`, and a sentence here restated it. A stored row that
  still carries a legacy `note` keeps it on disk; nothing renders it, and a
  whole-row write drops it.
- `windowDays` is a performance bound, not a correctness one. History outside the
  window stays on disk and stays in the downloads manifest; the window only
  decides how far back one pass asks.
- `freshnessMaxAgeDays` is the bar a consumer reads against. Save it in
  **Settings → Data collection** and every asset's `freshness.json` uses the
  stored value on the next pass.

## Who writes the `assets` map (2026-09-04, bead `ro-sk7q`)

The active document lives in `config_documents`. Each panel refresh reads its
acknowledged version through the running ingest; editing this checkout export
does not change the next pass. A missing or unavailable stored document,
invalid roster structure, non-boolean enabled flag or invalid refresh number
stops the pass before archive work. Omitted refresh fields use the application
defaults. An empty or disabled roster refreshes nothing.

This file is a seed/export for review and recovery; use the
[configuration store commands](../scripts/README.md#the-config-store-configapply-configseed-configexport)
for that maintenance. Runtime fields are edited in the product through their
declared controls. A whole-document rewrite is not on `ALLOWED_FILES`;
the config write lane accepts these declared portions:

- **`refresh.windowDays` and `refresh.freshnessMaxAgeDays`** are declared
  **knobs** (`CONFIG_KNOBS`, [the changeset contract](changesets/README.md#the-knobs),
  bead `ro-x5gu.8`), each licensed at its own exact pointer and edited on
  `/settings`. Nothing else in `refresh` is: `cadenceRef`,
  `providerCallsPerPass` and `providerCostUsdPerPass` are facts about the lane
  rather than settings, and `/refresh` itself is refused.
- **The `/assets` map**, and only a whole row at a time
  (`ADDABLE_CONTAINERS`, one asset id per op) — or one declared field of one row,
  through the `signal-panels` register in `scripts/config-registers.mjs`. The
  three writers below.

- **The add-asset wizard writes a row on Create**, because the membership rule
  above is an *invariant* and not an opt-in: an asset with no row is an
  undocumented gap, and the validation below refuses a roster whose keys differ
  from `integrations.json`'s. The row it writes is always
  `enabled: false, reason: "no-lane-yet"` — no lane can be live at creation, and
  a refresh with none would write an empty panel dir.
- **The asset page's Delete removes it**, listed by name in the confirmation
  beside every other file the asset is in.
- **The asset's Growth tab changes it** *(2026-09-05, bead `ro-x5gu.4`)*. On
  `/assets/<id>/growth`, under the tracked-panel board, a **Panel refresh** row
  shows this asset's `enabled`, `reason`, `task` and `since` as editable fields —
  one changeset per field, guarded by that field's own previous value, with the
  Undo in the toast. It is deliberately a ONE-ROW surface: it never offers
  **Remove**, because a row leaves with its asset and only through Delete, and it
  offers **Add** only when the asset has no row at all, which repairs a gap
  rather than growing the roster. Turning a row **on** is now a click rather than
  a hand edit — but it is still a claim about the asset's lanes, which is the
  practical rule below. So the surface
  **refuses** the switch when no `gsc` / `ga4` / `bing-webmaster` lane is live,
  in this file's own words — the same sentence the validation below prints, and
  the same one `pnpm config:apply` answers with, because both read one rule
  (`liveSearchLaneRefusal` in
  [`scripts/config-registers.mjs`](../scripts/config-registers.mjs), declared on
  the register as `requiresLiveSearchLane`) *(2026-09-05, bead `ro-uko8`)*.
  Switching a row **off** is never refused: that is the decision this file is
  for. The surface also says the refresh itself costs nothing at any cadence.

  **Changing `enabled` moves `since` to that day** *(2026-09-05, bead
  `ro-6kd6`)*. `since` is *when the decision was taken*, and `enabled` is the
  decision — so editing them as two independent cells let a flipped row keep the
  previous decision's date, in the only audit trail this file carries for a
  roster change. The pair is declared on the register (`stamps` in
  [`scripts/config-registers.mjs`](../scripts/config-registers.mjs)) and applied
  by the write pipeline, so it holds for a click, for `pnpm config:apply` and
  for a deployed Save alike. It is still ONE changeset with one Undo, and
  undoing re-dates the row to the day of the undo — which is when the decision
  standing in it was taken. Editing `reason` or `task` moves nothing: those
  record the decision, they are not it.

## Where the cadence lives (not here)

`refresh.cadenceRef` points at the runner’s `CONFIG.panelRefreshCron`, defined in
`scripts/runner/config.mjs` and re-exported by `scripts/os-up.mjs`,
currently `10 13 * * *` (UTC). The cadence is a **runner** knob and sits with the
runner's other schedules — the beads poll, the panel-review filer, the nightly
backup — because it is the same kind of fact as those: when this process wakes
up. Declaring it twice would give it two truths.

Two consequences:

- **A cadence change arms on the operator's next `os:up` restart.** The runner
  reads its schedule once, at startup.
- The cadence was chosen for **freshness, not budget**. A refresh pass makes zero
  provider calls: it materializes the archives the `15 12 * * *` (GA4/GSC/BWT)
  and `45 12 * * 1` (DataForSEO) collectors already bought, reading them back
  through the running ingest Worker. So daily across the whole portfolio moves
  monthly data spend ([`constants.json`](constants.json)
  `monthly_caps.data_usd`, $25) by $0.00, at any cadence.
  13:10 UTC is simply "after both archive crons have landed" — the daily
  GA4/GSC/BWT lane fires at 12:15 and the weekly DataForSEO lane at 12:45.

**The file carries no description of itself** *(2026-09-24, bead
`ro-ujb9.96.6.16`)*: the first paragraph of this README and the cost sentence
above were once the top-level `purpose` and `refresh.costNote` strings, which no
screen drew. An installation seeded before then drops both from its store copy
with guarded `file-json-delete` ops (licensed by `RETIRED_KEYS` in
`scripts/config-documents.mjs`), applied with `pnpm config:apply`.

## How it relates to `integrations.json`

[`integrations.json`](integrations.json) is the per-asset × per-**provider-lane**
register: is GA4 consumable for this asset, is Bing, is DataForSEO. This file
is one level up from that — given those lanes, is the derived local panel kept
current. They move together but they are not the same statement, and merging them
would put a derived artifact in a catalog of external integrations.

The practical rule: **an asset is `enabled` here when at least one of its
`gsc` / `ga4` / `bing-webmaster` lanes is `live` there.** Anything less produces a
panel dir that cannot answer the question the contract promises.

## Validation

```bash
node -e '
const fs=require("fs");
const j=JSON.parse(fs.readFileSync("config/signal-panels.json","utf8"));
const ints=JSON.parse(fs.readFileSync("config/integrations.json","utf8"));
const errs=[];
const rosterIds=Object.keys(j.assets).sort();
const laneIds=Object.keys(ints.assets).sort();
if(rosterIds.join()!==laneIds.join()) errs.push("roster assets != integrations.json assets");
for(const[a,e]of Object.entries(j.assets)){
  if(typeof e.enabled!=="boolean") errs.push(`${a}: enabled must be boolean`);
  if(!["live-lanes","no-lane-yet","not-applicable"].includes(e.reason)) errs.push(`${a}: bad reason`);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(e.since||"")) errs.push(`${a}: bad since`);
  if("note" in e) errs.push(`${a}: note is retired — reason and task carry the decision`);
  if(e.task!==undefined && !/^[a-z]{2,8}-[a-z0-9]+(?:\.[0-9]+)*$/.test(e.task)) errs.push(`${a}: bad task`);
  const lanes=ints.assets[a]||{};
  const live=["gsc","ga4","bing-webmaster"].some((l)=>lanes[l]&&lanes[l].status==="live");
  if(e.enabled && !live) errs.push(`${a}: enabled but no live search source in integrations.json`);
}
if(!(j.refresh.freshnessMaxAgeDays>=1)) errs.push("freshnessMaxAgeDays must be >= 1");
if(!(j.refresh.windowDays>=j.refresh.freshnessMaxAgeDays)) errs.push("windowDays must cover the freshness bar");
if(j.refresh.providerCostUsdPerPass!==0) errs.push("a refresh pass must cost nothing");
console.log(errs.length?errs:"OK");
'
```

Expected output: `OK`.

## Running it

```bash
pnpm signals:refresh                       # every enabled asset
pnpm signals:refresh -- --asset example.com  # one asset, roster flag ignored
pnpm signals:refresh -- --all              # including the deliberately disabled
```

It needs a running `os:up` (every read goes through the ingest's loopback door at
`127.0.0.1:8791`) and `OPERATOR_TOKEN` in `workers/ingest/.dev.secrets.json`.
Implementation: [`scripts/signal-panels-refresh.mjs`](../scripts/signal-panels-refresh.mjs).
