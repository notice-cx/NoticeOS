# OS constants

> **Seed and export, not source of truth** (2026-09-05, D22 — epic `ro-syok`):
> `pnpm config:seed` loads this installation's copy (else this generic default)
> into the store's `config_documents` table, the running OS reads and saves it
> there, and `pnpm config:export` writes it to `installation/` so a diff stays
> the record. Until an install seeds, every read falls
> back to the copy compiled into the Workers and nothing here changes. A key a
> stored copy lacks (it was seeded before the key existed) reads the same way,
> per key, and its first Save creates it (bead `ro-dk4u`).

`config/constants.json` is the **machine-readable half of the decision
register**: the handful of portfolio-wide numbers and names the Workers import
directly, whose prose and rationale live in
[`config/decisions.md`](decisions.md). When a value here is mirrored by a
decision row (D6, D7), change both in the same commit — the register is the
reason, this file is the value in force.

It is on the config write lane's safety allowlist
([`config/changesets/README.md`](changesets/README.md)), so `/settings` edits
most of it in place with a Save (D18) rather than sending the operator to a
terminal.

## Keys

| Key | What it is | Where it is read | Editable from `/settings` |
|---|---|---|---|
| `os_time_zone` | The operator's clock — the IANA zone intraday charts, revenue days and the open month are read in | both Workers, store first, on every request or run (`savedOsTimeZone` in `packages/contract`) | yes, **Clock** |
| `schedules` | Optional local job schedule overrides, keyed by stable job id | local scheduler; see [scheduled job configuration](../scripts/README.md#scheduled-job-configuration) | yes, **Workflows → Edit schedule** |
| `operator_rate_usd_per_min` | What a minute of operator time costs the ledger (D7) | the financials payload | yes, **Budget** |
| `explore_sleeve` | Share of effort reserved for exploration (D7) | reference value; no code reads it yet | no |
| `monthly_caps.data_usd` | Hard monthly ceiling on metered data spend (D6) | the DataForSEO budget gate, fail-closed | yes, **Budget** |
| `flag_defaults.alpha` | Anomaly sensitivity: the Poisson tail probability an alert must beat | the ingest's flag rules | yes, **Alert rules** |
| `flag_defaults.min_baseline_per_day` | Minimum daily volume before a series is tested at all | the ingest's flag rules | yes, **Alert rules** |
| `flag_defaults.low_volume_window_hours` | How much prior history the low-volume test needs | the ingest's flag rules | yes, **Alert rules** |
| `no_nightly_report` | Optional list of asset ids that send no nightly report, so none is owed: no freshness alert, outside the SYSTEM card's "N/M nightly reports fresh", and a neutral "No report" on the card (bead `ro-ujb9.96.8`). Absent until the first asset declares | the ingest freshness cron and the Tower, store first, through `owesNightlyReport` in `packages/contract/src/reporting.ts` | yes, each asset's **Settings → Data collection → Nightly report** |

**`monthly_caps.inference_usd` is gone** (2026-09-05, D6 amended, bead
`ro-uj7x`). No process in this repo calls a model — every model call happens in
a Claude Code session billed outside the OS — so nothing could measure spend
against that ceiling, and `/settings` rendered it beside an empty meter reading
*not instrumented*. A number the page cannot back is worse than an absent one.
`monthly_caps.data_usd` is unchanged and still fails closed. The key comes back
the day the OS makes a model call of its own.

**An install seeded before that date still has the key in its store document.**
Nothing breaks — every reader takes `data_usd` and ignores what it does not
know — but the store copy loses the key only on a forced re-seed
(`pnpm config:seed --force config/constants.json --reason "…"`), and until then
`pnpm config:export` writes it back into the installation's copy.

## `os_time_zone` — the operator's clock

An **IANA zone name** (an `Area/City` name from the tz database, or `UTC`), not an
abbreviation and not an offset. The product default is `UTC`; each installation
sets its own on `/settings` → **Time & timezone**, and until one is chosen Home's
first-run card offers the browser's zone with one press (bead `ro-ujb9.134`,
[the brief](../docs/briefs/2026-09-23-first-run.md#the-clock)). Every asset's provider reports in its *own*
reporting timezone — GA4 hands back `metadata.timeZone` on every run, and that
decides only how GA4 buckets its own days. The ingest re-buckets those intraday
hours into this zone, which is what lets two assets in two zones share one
x-axis on the Wall, and it is the zone the axis caption names (by its abbreviation).

**The saved value is the one read** (bead `ro-ujb9.88`). A `/settings` save
lands in the config store (D22), and every reader resolves the zone store first
through `savedOsTimeZone` (`packages/contract/src/time-zone-setting.ts`), with
the copy compiled from this file only as the fallback: the Tower per request
(the Settings clock, each card's "yesterday" revenue, the revenue projection's
month and report cutoff, the Wall's and /financials' open month, the asset
page's daily revenue window, the MCP read models), and the ingest per run (the
intraday re-bucketing, which also names the zone on every realtime snapshot, and
the zone assumed for a GA4 property that states none). No rebuild or restart is
needed; the browser takes every clock from the payload it is sent, and
`apps/tower/test/client-contract-imports.test.ts` holds it to loading no
`config/*.json` at all.

**It is validated, not trusted.** `packages/contract/src/time-zone-setting.ts`
asks `Intl.DateTimeFormat` whether the runtime's timezone database knows the
name. At build time a zone it cannot resolve throws: `packages/contract/src/os-time-zone.ts`
and `apps/tower`'s Vite config make that call on the compiled fallback, so a bad
value fails the build. A stored value has no build to fail, so an unusable one
falls back to the compiled zone rather than moving every boundary to UTC. The
`/settings` field runs the same check before it will save.

Changing it re-labels and re-buckets every intraday chart from the next ingest
run onward. **Rows already stored keep the bucketing they were written with** —
the OS does not rewrite history, the same way GA4 does not.
