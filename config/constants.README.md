# OS constants

`config/constants.json` is the handful of portfolio-wide numbers and names
the Workers import directly: the value in force, whose rationale lives in the
docs that name each key.

**Seed and export, not source of truth**: `pnpm config:seed` loads this
installation's copy (else this generic default) into the store's
`config_documents` table, the running OS reads and saves it there, and
`pnpm config:export` writes it to `installation/`. Until an install seeds,
every read falls back to the copy compiled into the Workers; a key a stored
copy lacks reads the same way, per key, and its first Save creates it. The
file is on the config write lane's allowlist
([`config/changesets/README.md`](changesets/README.md)), so `/settings` edits
most of it in place.

## Keys

| Key | What it is | Where it is read | Editable from `/settings` |
|---|---|---|---|
| `os_time_zone` | The operator's clock — the IANA zone intraday charts, revenue days and the open month are read in | both Workers, store first, on every request or run (`savedOsTimeZone` in `packages/contract/src/time-zone-setting.ts`) | yes, **General → Clock** |
| `schedules` | Optional local job schedule overrides, keyed by stable job id | the local scheduler (`scripts/scheduled-job-runner.mts`); see [scheduled job configuration](../scripts/README.md#scheduled-job-configuration) | from the Workflows page, **Edit schedule** |
| `operator_rate_usd_per_min` | What a minute of operator time costs the ledger | the Tower's settings and financials payloads | yes, **General → Budget** |
| `explore_sleeve` | Share of effort reserved for exploration | reference value; no code reads it | no |
| `monthly_caps.data_usd` | Hard monthly ceiling on metered data spend | the DataForSEO budget gate (`workers/ingest/src/dataforseo-dumps.ts`), fail-closed | yes, **General → Budget** |
| `flag_defaults.alpha` | Anomaly sensitivity: the Poisson tail probability an alert must beat | the flag rules (`packages/contract/src/rules.ts`) | yes, **Alert rules** |
| `flag_defaults.min_baseline_per_day` | Minimum daily volume before a series is tested at all | the flag rules | yes, **Alert rules** |
| `flag_defaults.low_volume_window_hours` | How much prior history the low-volume test needs | the flag rules | yes, **Alert rules** |
| `no_nightly_report` | Optional list of asset ids that send no nightly report, so none is owed: no freshness alert, outside the SYSTEM card's "N/M nightly reports fresh", a neutral "No report" on the card. Absent until the first asset declares | the ingest freshness cron and the Tower, store first, through `owesNightlyReport` in `packages/contract/src/reporting.ts` | yes, each asset's **Settings → Nightly report** |

`monthly_caps.inference_usd` no longer exists: no process in this repo calls a
model, so nothing could measure spend against it. A store seeded while it
existed still holds the key; every reader ignores it, and the copy loses it
only on a forced re-seed (`pnpm config:seed --force config/constants.json
--reason "…"`).

## `os_time_zone` — the operator's clock

An **IANA zone name** (`Area/City`, or `UTC`), not an abbreviation and not an
offset. The product default is `UTC`; each installation sets its own on
`/settings`, and until one is chosen Home's first-run card offers the
browser's zone in one press, with Undo. Every asset's provider reports in its
*own* reporting timezone — GA4 hands back `metadata.timeZone` on every run,
which decides only how GA4 buckets its own days. The ingest re-buckets those
intraday hours into this zone, which lets two assets in two zones share one
x-axis on the Wall, and it is the zone the axis caption names.

**The saved value is the one read.** Every reader resolves the zone store
first through `savedOsTimeZone`, with the compiled copy only as the fallback:
the Tower per request (the Settings clock, each card's "yesterday" revenue,
the revenue projection, the open month, the MCP read models) and the ingest
per run (the intraday re-bucketing, and the zone assumed for a GA4 property
that states none). No rebuild or restart is needed; the browser takes every
clock from the payload it is sent, and
`apps/tower/test/client-contract-imports.test.ts` holds it to loading no
`config/*.json` at all.

**It is validated, not trusted.** `packages/contract/src/time-zone-setting.ts`
asks `Intl.DateTimeFormat` whether the runtime knows the name. At build time a
zone it cannot resolve throws (`packages/contract/src/os-time-zone.ts` and the
Tower's Vite config check the compiled fallback). A stored value has no build
to fail, so an unusable one falls back to the compiled zone rather than moving
every boundary to UTC; the `/settings` field runs the same check before it
will save.

Changing it re-labels and re-buckets every intraday chart from the next ingest
run onward. **Rows already stored keep the bucketing they were written with** —
the OS does not rewrite history, the same way GA4 does not.
