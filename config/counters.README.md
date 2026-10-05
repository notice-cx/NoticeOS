# config/counters.json — the counters lane

> **Seed and export, not source of truth** (2026-09-05, D22 — epic `ro-syok`):
> `pnpm config:seed` loads this installation's copy (else this generic default)
> into the store's `config_documents` table, the running OS reads and saves it
> there, and `pnpm config:export` writes it to `installation/` so a diff stays
> the record. Until an install seeds, every read falls
> back to the copy compiled into the Workers and nothing here changes.

Which of an asset's own metrics get a big-number **total** on its asset card
(the portfolio home and the Wall).
This file is config, not data: the observed values live in the store's
`counter_readings` table (one current-state row per card — see `db/README.md`);
this file owns *which* counters exist, their group heading and labels.

## Field contract

- **How often the lane reads is not in this file.** It is the counters job's
  schedule (`scripts/scheduled-jobs.mts`, changed in Settings → Data
  collection), and the Tower ages each total against that schedule's longest
  wait between runs (amber past 2×). The `intervalMinutes` this file used to
  carry restated it and could disagree; it is retired (bead `ro-ujb9.222`), and
  a stored copy that still has it drops it with a `file-json-delete` changeset
  (`RETIRED_KEYS` in `scripts/config-documents.mts`).
- **`assets.<id>.source`** — where the fast lane reads totals. Omit it and the
  asset still gets its totals, filled from its **nightly report's own totals**
  instead (at nightly freshness, aged by the card's header badge). Currently one
  kind:
  - `kind: "prometheus"` — a Prometheus text endpoint exposing
    `d1_row_count{table="<counter>"}` samples, fetched with that asset's own
    `ASSET_TOKEN`, read from the ingest Worker's one `ASSET_TOKENS` map (same
    endpoint and same token as the nightly pull for Prometheus-shaped assets —
    an asset authorizes one caller shape, not one per lane). The convention:
    [docs/11 §Credential naming](../docs/11-integrations.md#credential-naming--the-asset_token-convention).
  - `enabled: false` pauses the fast lane; the totals stand, fed by the nightly
    report again.
- **`assets.<id>.heading`** — optional visible heading for the group. Defaults
  to `All-time totals`; use a more truthful grain when the values are not
  lifetime activity (a catalog, for example: `Current catalog`).
- **`assets.<id>.cards[]`** — rendered in order on the asset card:
  - `metric` — the **envelope metric name** (the asset's contracted
    vocabulary, e.g. `signups`), always required. This is the join key that
    makes the primitive format-agnostic: it is how a card falls back to the
    nightly report's `metrics[metric].total` when there is no fast lane.
  - `counter` — the source counter (the Prometheus `table` label, e.g.
    `profiles`). Required when `source.kind` is `"prometheus"`; ignored
    otherwise.
  - `label` — operator copy, rendered verbatim on the card ("Accounts", "Leads").

## Semantics worth knowing

- An asset with no entry here gets no totals row on its card at all — no
  heading, no placeholder.
- The heading describes the configured values as a group; it is not inferred
  from metric names.
- A card whose metric neither lane has a number for is skipped; a missing total
  is never drawn as 0.
- The fast lane is all-or-nothing per asset per run: one unreadable counter
  fails the whole asset's refresh and leaves every previous reading (value
  AND timestamp) untouched — a stale total must look stale, never half-fresh.
- The lane raises no alerts; the amber age badge on the totals row (past 2× the
  schedule's longest wait) is the failure signal, and it appears ONLY then — a fresh row is
  silent, and a nightly-fed total never badges, because the card's header badge
  already ages that lane. A persistent endpoint outage is still caught within 24h
  by the nightly pull's `asset-pull-failed` alert — same endpoint, same token.
- The **cards** are view-only in the Tower (structural config, like the pull
  metric map); an asset's whole entry is added from its Settings tab.
