-- Synthetic fixture: one valid row in EVERY table of the baseline, written
-- the way today's writers write them, for the workspace named by the psql
-- variables :ws (uuid), :slug and :site. Run once per workspace, as
-- noticeos_owner. Synthetic values only (example.com-style names); nothing
-- here comes from a real store.
--
-- The denial proof (rls-denial.sql) loads it for two workspaces and checks
-- that neither can see, write or reference the other's rows in any table.

BEGIN;
SELECT set_config('noticeos.workspace_id', :'ws', true);

INSERT INTO noticeos.workspaces (workspace_id, slug, display_name)
VALUES (:'ws', :'slug', :'slug');

INSERT INTO noticeos.assets (workspace_id, asset_id, domain, display_name, status, sense_only, is_os)
VALUES (:'ws', :'site', :'site', :'site', 'live', true, false),
       (:'ws', :'slug' || '-os', NULL, 'NoticeOS', 'live', false, true);

INSERT INTO noticeos.pulses (workspace_id, asset_id, pulse_date, generated_at, envelope, capabilities)
VALUES (:'ws', :'site', '2026-09-01', '2026-09-01T23:00:00Z', '{"asset":"x","metrics":{}}', '["pageviews"]');

INSERT INTO noticeos.flags (workspace_id, asset_id, pulse_id, fired_at, severity, kind, metric, message, rule_id, rule_inputs)
SELECT :'ws', :'site', pulse_id, '2026-09-02T03:00:00Z', 'warn', 'anomaly', 'pageviews', 'fewer views', 'poisson-drop', '{"observed":1}'
  FROM noticeos.pulses WHERE asset_id = :'site';

INSERT INTO noticeos.flag_evidence (workspace_id, flag_id, observed_at, severity, message, rule_inputs)
SELECT :'ws', flag_id, '2026-09-03T03:00:00Z', 'warn', 'still fewer views', '{"observed":2}'
  FROM noticeos.flags WHERE asset_id = :'site';

INSERT INTO noticeos.flag_tunes (workspace_id, flag_id, rule_id, setting, value_from, value_to, tuned_at, actor)
SELECT :'ws', flag_id, 'poisson-drop', 'alpha', 0.01, 0.005, '2026-09-04T10:00:00Z', 'operator'
  FROM noticeos.flags WHERE asset_id = :'site';

INSERT INTO noticeos.annotations (workspace_id, asset_id, at, kind, ref, note)
VALUES (:'ws', :'site', '2026-09-01T12:00:00Z', 'deploy', 'abc1234', 'synthetic deploy');

INSERT INTO noticeos.workspace_mutation_audit (workspace_id,actor_kind,event,asset_id,subject)
VALUES (:'ws','unknown','annotation.create',:'site','{"annotationNumber":"1","kind":"deploy"}');

INSERT INTO noticeos.counter_readings (workspace_id, asset_id, metric, value, observed_at)
VALUES (:'ws', :'site', 'signups', 42, '2026-09-05T00:00:00Z');

INSERT INTO noticeos.measurement_series (workspace_id, asset_id, integration, property_ref, time_zone, metric)
VALUES (:'ws', :'site', 'ga4', 'properties/1', 'UTC', 'sessions');

INSERT INTO noticeos.signal_runs (workspace_id, run_id, asset_id, integration, credential_ref, property_ref, time_zone,
  started_at, finished_at, status, window_start, window_end, data_state, provisional_from, provider_rows, observation_count)
VALUES (:'ws', 'run-1', :'site', 'ga4', 'account-a', 'properties/1', 'UTC',
  '2026-09-05T00:00:00Z', '2026-09-05T00:00:05Z', 'success', '2026-08-08', '2026-09-04', 'final', NULL, 28, 1);

INSERT INTO noticeos.signal_observations (workspace_id, run_seq, series_id, observed_date, value)
SELECT :'ws', r.run_seq, s.series_id, '2026-09-04', 120
  FROM noticeos.signal_runs r, noticeos.measurement_series s
 WHERE r.run_id = 'run-1' AND s.asset_id = :'site';

INSERT INTO noticeos.archive_objects (workspace_id, object_key, content_sha256, object_bytes, first_stored_at)
VALUES (:'ws', 'raw/google/ga4/' || :'site' || '/pages/2026-09-04/a.json.gz', repeat('a', 64), 1024, '2026-09-05T00:00:10Z');

INSERT INTO noticeos.archive_runs (workspace_id, run_id, asset_id, integration, report, credential_ref, property_ref,
  report_date, requested_at, finished_at, status, data_state, schema_version, provider_rows, request_count,
  provider_truncated, object_seq, cost_usd, cost_state)
SELECT :'ws', 'dump-1', :'site', 'ga4', 'pages', 'account-a', 'properties/1', '2026-09-04',
  '2026-09-05T00:00:06Z', '2026-09-05T00:00:10Z', 'success', 'revision-window', 1, 10, 1, false,
  object_seq, 0, 'reported'
  FROM noticeos.archive_objects WHERE object_key = 'raw/google/ga4/' || :'site' || '/pages/2026-09-04/a.json.gz';

INSERT INTO noticeos.research_log (workspace_id, asset_id, provider, endpoint, params_sha256, question, cost_usd,
  cost_state, object_key, actor, bought_at)
VALUES (:'ws', :'site', 'dataforseo', 'serp/google/organic/live', repeat('b', 64), 'one synthetic question',
  0.002, 'reported', NULL, 'collector', '2026-09-05T12:00:00Z');

INSERT INTO noticeos.asset_insight_snapshots (workspace_id, snapshot_id, asset_id, generated_at, window_start,
  window_end, source_archive_count, content_sha256, payload)
VALUES (:'ws', 'snapshot-0', :'site', '2026-09-04T13:00:00Z', '2026-08-07', '2026-09-03', 3, repeat('8', 64),
  '{"items": [{"key": "k", "title": "first"}]}'),
       (:'ws', 'snapshot-1', :'site', '2026-09-05T13:00:00Z', '2026-08-08', '2026-09-04', 3, repeat('c', 64),
  '{"items": []}'),
       (:'ws', 'snapshot-2', :'site', '2026-09-06T13:00:00Z', '2026-08-09', '2026-09-05', 3, repeat('9', 64),
  '{"items": [{"key": "k", "title": "t"}]}');

-- The oldest snapshot's move to the analytical store is recorded (the mover's
-- job, as noticeos_maint; the fixture writes it as the owner); the row itself
-- may now leave (edge-cases.sql removes it). The two newest stay.
INSERT INTO noticeos.asset_insight_snapshot_moves (workspace_id, snapshot_id, asset_id, content_sha256, dataset_key, moved_at)
VALUES (:'ws', 'snapshot-0', :'site', repeat('8', 64), 'analytics/insight-snapshots/2026-09.parquet', '2026-09-07T00:00:00Z');

INSERT INTO noticeos.watch_windows (workspace_id, window_id, asset_id, ref_kind, ref, metric_integration, metric,
  registered_at, baseline_start, baseline_end, check_offsets)
VALUES (:'ws', 'watch-1', :'site', 'manual', 'synthetic change', 'gsc', 'clicks',
  '2026-09-01T00:00:00Z', '2026-08-04', '2026-08-31', '{7,14,28}');

INSERT INTO noticeos.watch_window_readings (workspace_id, window_id, offset_days, check_date, checked_at, final,
  baseline, post, delta_pct, pre_change_days)
VALUES (:'ws', 'watch-1', 7, '2026-09-08', '2026-09-08T03:30:00Z', false, '{"sum":100}', '{"sum":110}', 10, 0);

INSERT INTO noticeos.hygiene_checks (workspace_id, asset_id, check_id, observed_at, observed_on, status, value_num, detail)
VALUES (:'ws', :'site', 'html-depth', '2026-09-05T04:00:00Z', '2026-09-05', 'ok', 850, '{"status":200}');

INSERT INTO noticeos.reclamation_targets (workspace_id, asset_id, tier, segment, domain, referring_page, status)
VALUES (:'ws', :'site', 1, 'library', 'links.example', '', 'queued');

INSERT INTO noticeos.item_dispositions (workspace_id, asset_id, kind, item_key, status, decided_at, updated_at)
VALUES (:'ws', :'site', 'query', 'synthetic query', 'marked', '2026-09-05T14:00:00Z', '2026-09-05T14:00:00Z');

INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, amount_minor, currency,
  source, booking_state, external_id)
VALUES (:'ws', 'revenue', :'site', '2026-08-01', 'ads', 12345, 'USD', 'csv', 'estimated', 'csv:1');

-- A shipped change: its class, its id and the prediction it shipped with, and
-- no money (D36, D38). Both workspaces use the id 'change-1'; a change id is
-- its own workspace's.
INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, ref, currency,
  predicted_monthly_value_minor, predicted_success_chance, predicted_cost_minor, predicted_days_to_signal, source, note)
VALUES (:'ws', 'change', :'site', '2026-09-01', 'copy', 'change-1', 'USD', 1500, 0.3, 2000, 28, 'operator',
  'synthetic shipped change');

INSERT INTO noticeos.mediavine_sites (workspace_id, site_id, asset_id) VALUES (:'ws', 'mv-' || :'slug', :'site');

INSERT INTO noticeos.mediavine_runs (workspace_id, run_id, asset_id, site_id, start_date, end_date, attempted_at, outcome)
VALUES (:'ws', 'mv-run-1', :'site', 'mv-' || :'slug', '2026-09-01', '2026-09-01', '2026-09-02T05:00:00Z', 'success');

INSERT INTO noticeos.mediavine_daily (workspace_id, run_seq, asset_id, site_id, report_date, amount_minor, currency, recorded_at)
SELECT :'ws', run_seq, :'site', 'mv-' || :'slug', '2026-09-01', 500, 'USD', '2026-09-02T05:00:00Z'
  FROM noticeos.mediavine_runs WHERE run_id = 'mv-run-1';

INSERT INTO noticeos.mediavine_state (workspace_id, asset_id, site_id, target_date, attempts)
VALUES (:'ws', :'site', 'mv-' || :'slug', '2026-09-02', 0);

INSERT INTO noticeos.integration_connections (workspace_id, connection_id, provider, scope, created_at, updated_at)
VALUES (:'ws', gen_random_uuid(), 'dataforseo', 'shared', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');

INSERT INTO noticeos.connection_secrets (workspace_id, connection_id, secret_version, ciphertext, iv, key_version,
  field_names, created_at)
SELECT :'ws', connection_id, 1, '\x00ff'::bytea, '\x000102030405060708090a0b'::bytea, 1, '["login","password"]',
       '2026-09-01T00:00:00Z'
  FROM noticeos.integration_connections WHERE provider = 'dataforseo';

INSERT INTO noticeos.integration_leases (workspace_id, lease_key, owner, expires_at)
VALUES (:'ws', 'posthog:' || :'site', 'runner-1', '2026-09-05T00:05:00Z');

INSERT INTO noticeos.capability_targets (workspace_id, provider, connection_revision, capability, asset_id, target_id, family)
VALUES (:'ws', 'google', 'rev-1', 'ga4-report', :'site', 'properties/1', '');

INSERT INTO noticeos.integration_capability_state (workspace_id, target_seq, attempt_id, started_at, finished_at,
  outcome, evidence_source, evidence_id)
SELECT :'ws', target_seq, 'attempt-1', '2026-09-05T00:00:00Z', '2026-09-05T00:00:05Z', 'success', 'signal_runs', 'run-1'
  FROM noticeos.capability_targets WHERE capability = 'ga4-report';

INSERT INTO noticeos.integration_health_events (workspace_id, event_id, target_seq, attempt_id, started_at, recorded_at,
  kind, failure_kind, safe_code, evidence_source, evidence_id)
SELECT :'ws', 'event-1', target_seq, 'attempt-0', '2026-09-04T00:00:00Z', '2026-09-04T00:00:05Z',
  'failed', 'network', 'timeout', 'signal_runs', 'run-0'
  FROM noticeos.capability_targets WHERE capability = 'ga4-report';

INSERT INTO noticeos.config_documents (workspace_id, document_key, body, version, updated_at, updated_by)
VALUES (:'ws', 'tower', E'{\n  "panels": []\n}\n', 1, '2026-09-01T00:00:00Z', 'config:seed');

INSERT INTO noticeos.config_changes (workspace_id, document_key, ops, reason, actor, version_before, version_after, changed_at)
VALUES (:'ws', 'tower', '[{"op":"replace","path":"/panels","value":[]}]', 'seed', 'config:seed', 0, 1, '2026-09-01T00:00:00Z');

INSERT INTO noticeos.notifications (workspace_id, channel, subject, subject_ref, occurrence, condition, sent_at)
VALUES (:'ws', 'discord', 'alert', '1', '', 'error-flag', '2026-09-02T03:01:00Z');

INSERT INTO noticeos.job_runs (workspace_id, job, started_at, finished_at, outcome, recorded_at)
VALUES (:'ws', 'backup', '2026-09-05T04:00:00Z', '2026-09-05T04:01:00Z', 'ran', '2026-09-05T04:01:01Z');

INSERT INTO noticeos.hosted_job_occurrences (workspace_id,lane,occurrence,service_id,
  definition_hash,input_hash,state,attempt,lease_id,lease_expires_at)
VALUES (:'ws','synthetic','same-occurrence',:'ws',repeat('a',64),repeat('b',64),
  'succeeded',1,gen_random_uuid(),'2026-09-05T04:02:00Z');
INSERT INTO noticeos.hosted_job_attempts (workspace_id,lane,occurrence,attempt,lease_id,state,started_at,finished_at)
SELECT workspace_id,lane,occurrence,attempt,lease_id,'succeeded','2026-09-05T04:00:00Z','2026-09-05T04:01:00Z'
  FROM noticeos.hosted_job_occurrences WHERE workspace_id=:'ws'::uuid;

INSERT INTO noticeos.hosted_scheduler_status(workspace_id,service_id,session_id,observed_at,running,payload)
VALUES(:'ws',:'ws',gen_random_uuid(),'2026-09-05T04:00:00Z',false,'{"jobs":[]}');

-- The analytical store holds this workspace's observations through mid-2024.
INSERT INTO noticeos.analytical_exports (workspace_id, table_name, exported_through, dataset_key, exported_at)
VALUES (:'ws', 'signal_observations', '2024-06-30', 'analytics/signal_observations/2024-h1.parquet', '2026-09-06T00:00:00Z');

INSERT INTO noticeos.egress_checks (workspace_id, observed_at, up, detail)
VALUES (:'ws', '2026-09-05T04:00:00Z', true, '{"beacons":[{"url":"https://beacon.example","status":204}]}');

INSERT INTO noticeos.task_snapshots (workspace_id, captured_at, payload)
VALUES (:'ws', '2026-09-05T10:00:00Z', '{"projects":[]}');

INSERT INTO noticeos.task_daily_counts (workspace_id, project, day, captured_at, waiting, urgent, open, in_progress, blocked, closed_ids)
VALUES (:'ws', :'slug', '2026-09-05', '2026-09-05T10:00:00Z', NULL, NULL, 3, 1, 0, '[]');

INSERT INTO noticeos.connection_daily_counts (workspace_id, source, day, observed_at, live, degraded, needs_setup,
  skipped, not_applicable, newest_evidence_at)
VALUES (:'ws', 'ga4', '2026-09-05', '2026-09-05T10:00:00Z', 1, 0, 0, 0, 0, '2026-09-05T00:00:05Z');

INSERT INTO noticeos.connection_status_daily_counts (workspace_id, day, observed_at, sites_failing, sites_overdue,
  reports_missing, sites_working)
VALUES (:'ws', '2026-09-05', '2026-09-05T10:00:00Z', 0, 0, 1, 1);

INSERT INTO noticeos.alert_daily_counts (workspace_id, asset_id, day, observed_at, open, errors, warnings, median_open_age_hours)
VALUES (:'ws', :'site', '2026-09-05', '2026-09-05T03:00:00Z', 1, 0, 1, 72),
       (:'ws', NULL, '2026-09-05', '2026-09-05T03:00:00Z', 1, 0, 1, 72);

COMMIT;
