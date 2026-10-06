# Index purposes

The committed migrations define the indexes; this document explains their
read or integrity purpose. It does not change the frozen schema. Constraint
indexes, including primary and unique keys, are listed in
[constraints.md](constraints.md); `pnpm postgres:consumers` reads the current
[SQL consumers](consumers.md) for each table directly from source.

Every primary key enforces row identity and supports incoming foreign-key
checks. Composite tenant keys start with `workspace_id`, which also supports
workspace-scoped access. A unique key enforces its declared business identity;
it should not receive another index over exactly the same ordered columns.
Foreign keys do not themselves create an index on their referencing columns.

The signal observation unique key is `(workspace_id, run_seq, series_id,
observed_date)`: it both refuses duplicate observations and supports the
foreign key to a run. `signal_observations_series_date` instead leads with the
measurement series, supporting its foreign key and the actual series/date
readers. The retired SQLite duplicate run/date index has no Postgres counterpart.
The measurement-series unique key supplies asset/provider/resource lookup;
the signal-run primary key supplies observation-to-run joins. The separate
unique `(workspace_id, run_id)` key supports external run identity.

## Explicit indexes

Paths below are repository-relative. A purpose is not evidence that every
query chooses that index or that its write cost has been measured.

| Index | Query or integrity purpose |
|---|---|
| `assets_one_os` | Enforces one OS asset per workspace (`workers/ingest/src/os-asset.ts`). |
| `assets_one_per_domain` | Enforces one asset per non-null domain in a workspace (`workers/ingest/src/asset-registry.ts`). |
| `pulses_received` | Asset receipt-time history for the `current_pulses` view and `apps/tower/worker/pulse-history.ts`. |
| `flags_open` | Unresolved asset flags used by `workers/ingest/src/alert-store.ts` and the `current_flags` view. |
| `flags_rule` | Rule-scoped alert lookup (`workers/ingest/src/rule-backtest.ts`). Rule identifiers are text, not foreign keys. |
| `flags_asset_fired` | Asset alert history ordered by firing time (`apps/tower/worker/alert-history.ts`). |
| `flags_asset_settled` | Asset history ordered by effective settled time (`apps/tower/worker/alert-history.ts`). |
| `flags_pulse` | Non-null pulse references and their foreign-key checks; evidence join in `apps/tower/worker/flag-evidence.ts`. |
| `flag_tunes_rule_at` | Latest rule tuning (`apps/tower/worker/flag-tunes.ts`). |
| `flag_tunes_flag` | Flag-specific tuning (`apps/tower/worker/flag-tunes.ts`); flag foreign key. |
| `annotations_asset_at` | Asset/date history, reporting-clock changes and Watch change calendars (`apps/tower/worker/signal-trends.ts`, `asset-detail-payload.ts`). |
| `signal_runs_latest` | Latest successful asset/provider resource (`signal-trends.ts`, `workers/ingest/src/panel-source.ts`). |
| `signal_runs_window` | Asset/provider prefix access to reported windows. Current readers also use finish-time ordering; no incremental benefit from the trailing `window_end` column is claimed. |
| `signal_observations_series_date` | Selected measurement series and dates: collector comparison, Watch aggregation/calibration and panel/Tower trends. |
| `archive_runs_latest` | Latest revision of a provider report date (`workers/ingest/src/panel-source.ts`, `signal-dumps.ts`). |
| `archive_runs_finished` | Asset/provider/report completion history (`apps/tower/worker/integration-evidence.ts`). |
| `archive_runs_object` | Non-null archive-object foreign key and object/run ownership lookup (`workers/ingest/src/panel-source.ts`). |
| `archive_runs_spend` | Workspace/provider spend over requested dates (`workers/ingest/src/routes/provider-spend.ts`). |
| `research_log_question` | Recent answer for the exact provider/endpoint/parameter hash (`workers/ingest/src/research-log.ts`). |
| `research_log_spend` | Workspace/date/asset research spend (`packages/contract/src/metered-spend.ts`). |
| `asset_insight_snapshots_latest` | Latest two asset snapshots (`apps/tower/worker/asset-detail-payload.ts`) and retention-move guard. |
| `watch_windows_open` | Open registrations (`workers/ingest/src/watch-window-store.ts`). |
| `watch_windows_asset_ref` | Watches for an asset and originating reference (`apps/tower/worker/watch-window-reader.ts`). |
| `watch_windows_readback_pending` | Closed watches awaiting their readback (`workers/ingest/src/watch-readbacks.ts`). |
| `reclamation_targets_asset` | Asset targets ordered by status time (`apps/tower/worker/asset-detail-payload.ts`). |
| `reclamation_targets_open` | Open asset targets by tier/domain (`workers/ingest/src/reclamation-targets.ts`). |
| `item_dispositions_asset` | Latest asset decisions of a kind (`apps/tower/worker/decision-actions.ts`). |
| `ledger_entries_one_successor` | Enforces a single successor for a correction; supports the correction-chain foreign key. |
| `ledger_entries_one_per_change` | Enforces one realized outcome booking per non-null change reference. |
| `ledger_entries_asset_period` | Asset/kind/month ledger history (`apps/tower/worker/ledger-history.ts`) and the `financial_ledger` view. |
| `ledger_entries_family_period` | Workspace/kind/family/month financial reads (`apps/tower/worker/financials-payload.ts`). |
| `ledger_entries_ref` | Non-null originating change references in ledger reads; partial reference access in the `financial_ledger` view. |
| `mediavine_runs_asset` | Asset attempt history (`workers/ingest/src/integration-health-read.ts`). |
| `mediavine_daily_latest` | Latest revision per asset/provider site/report date in `mediavine_current_daily`. |
| `integration_capability_state_attention` | Workspace outcome lookup for attention reads (`workers/ingest/src/integration-health-read.ts`). |
| `integration_health_events_target` | Attempt history for a capability target; target foreign key. |
| `integration_health_events_recorded` | Workspace event feed ordered by recording time (`apps/tower/worker/wall-feed.ts`). |
| `config_changes_document` | Saved-document revision history (`workers/ingest/src/config-store.ts`). |
| `notifications_subject` | Delivery history for alert subjects (`workers/ingest/src/notifier.ts`, `apps/tower/worker/flag-scope.ts`). |
| `job_runs_started` | Recent workspace workflow history (`workers/ingest/src/job-runs.ts`). |
| `egress_checks_observed` | Latest workspace connectivity checks (`workers/ingest/src/db.ts`). |
| `task_snapshots_captured` | Latest task snapshot and retained history (`apps/tower/worker/beads-snapshot.ts`, `workers/ingest/src/beads-snapshots.ts`). |
| `task_daily_counts_day` | Daily workspace work counts (`apps/tower/worker/beads-daily.ts`). |
| `connection_daily_counts_day` | Daily workspace connection counts (`apps/tower/worker/connection-daily.ts`). |
| `alert_daily_counts_day` | Daily workspace alert counts (`workers/ingest/src/alert-daily.ts`). |
| `platform_enrollment_active_workspace_idx` | Enforces one non-revoked platform enrollment per workspace (migration `0004_email_code.sql`). |
| `hosted_job_recent_attempts` | Recent workspace journal attempts (`apps/tower/worker/hosted-workflow-read.ts`). |

## Plan evidence

`scripts/postgres-signal-plans.test.mjs` reads the four SQL statements from their
actual TypeScript declarations, seeds 14,600 observations (20 assets × 730 days),
and refreshes statistics as the disposable database owner. Queries execute as
the ordinary workspace-scoped application role and return the selected 28 days.
It checks the natural observation access path and separately disables sequential
scans to establish that the series and date bounds can be index conditions.
The forced-path result is not a latency or optimal-planner claim.

The existing `apps/tower/test/signal-trends.test.ts` covers Tower trend variants.
No indexes are added or removed by this qualification. Any future index change
needs representative analyzed read plans and measured write/storage costs,
followed by a new migration and the installation's maintenance approval.
