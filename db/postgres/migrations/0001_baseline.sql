-- 0001_baseline.sql — the NoticeOS operational store on Postgres
-- (beads ro-ujb9.71 and ro-ujb9.76.2, epic ro-ujb9.76).
--
-- The first migration of the Postgres store D25 chose, built from the target
-- model the operator approved on 2026-09-24 (bead ro-ujb9.76.14; the eleven
-- choices are listed in db/postgres/README.md). The running OS still writes
-- D1 (db/migrations/, which this folder never touches). Applying this to any
-- database but a disposable development one is separately approved work: the
-- host (ro-ujb9.76.12) and the switch-over (ro-ujb9.76.10). README.md explains
-- the model and its constraint matrix; mapping.json maps every D1 table,
-- column and view onto it. Nothing here names an installation's own records:
-- a new install and the migrated private one run this same schema.
--
-- A migration holds plain SQL only: no transaction control and no psql
-- commands. The runner (scripts/postgres-migrate.mjs, development databases
-- only) applies every pending migration in one transaction as noticeos_owner,
-- after roles.sql.
--
-- Rules every table here follows (D25, D27):
--   - Every table carries workspace_id. It leads the primary key, every
--     unique key and every foreign key between workspace tables, so a row can
--     never reference another workspace's row.
--   - Row-level security is enabled AND forced on every table, keyed on the
--     per-transaction setting `noticeos.workspace_id` (SET LOCAL). No setting
--     means no rows and no writes.
--   - The application role owns nothing and cannot bypass row security; its
--     privileges are the revision rules in mapping.json, column by column.
--     The maintenance role (noticeos_maint) bypasses row security to work
--     across workspaces; it owns nothing, changes nothing, and may only
--     remove what a retention rule lets go (mapping.json `maintenance`).
--   - What a row may name — an integration, a metric, a check — is shared
--     reference data in schema noticeos_ref, not CHECK lists.
--   - A fact table refers to its parent by a bigint identity (run_seq,
--     object_seq, target_seq); a parent's text id stays a unique attribute
--     for lookups and imports.
--   - Those identities never leave the store. A row people or other systems
--     name carries a number of its own workspace (flag_number, …), counted
--     from 1 per workspace, and readers show that ("Numbers a workspace hands
--     out", below).
--   - History past its window leaves for the analytical store (D25), never
--     simply deleted: the store refuses a removal the export has not covered
--     (mapping.json `retention`).
--   - Instants are timestamptz; provider and reporting days are date; money is
--     bigint minor units with an explicit currency; metered provider prices are
--     exact decimals with an explicit known/unknown state.
--   - Evidence whose exact bytes matter (a report envelope, an insight payload,
--     a config document) is `json`, which keeps the text as received; data the
--     store queries is `jsonb`. A document its writer always builds as an
--     object or an array is checked to be one.
--   - A text identifier is never empty, and a NULL inside a unique key or a
--     link means one decided thing per column (mapping.json `nullIdentity`).
--
-- Requires PostgreSQL 15 or later (UNIQUE NULLS NOT DISTINCT, security_invoker
-- views).

CREATE SCHEMA noticeos;

-- The workspace the current transaction acts for. NULL when the transaction
-- named none, and then every policy below matches nothing.
CREATE FUNCTION noticeos.current_workspace_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT nullif(current_setting('noticeos.workspace_id', true), '')::uuid $$;

-- ─── Shared vocabulary: what a row may name ─────────────────────────────────
--
-- The integrations, metrics and checks a row may name are data: adding one is
-- an INSERT, shipped as a migration with the code that speaks to it (in the 38
-- D1 migrations the integration list was rewritten four times and the check
-- list twice). They are the same for every workspace, so they live in their
-- own schema with no workspace_id and no row security; the application reads
-- them and never writes them. Small closed sets that are product semantics
-- (severity, kind, status, outcome, booking state, unit) stay CHECKs.
CREATE SCHEMA noticeos_ref;

-- An integration: the value signal, archive and research rows store (ga4,
-- gsc, …) and the connected provider it belongs to (one Google connection
-- serves both ga4 and gsc; `provider` is what integration_connections names).
CREATE TABLE noticeos_ref.integrations (
  integration  text PRIMARY KEY CHECK (integration ~ '^[a-z0-9][a-z0-9-]*$'),
  provider     text NOT NULL CHECK (provider ~ '^[a-z0-9][a-z0-9-]*$'),
  display_name text NOT NULL CHECK (length(display_name) >= 1)
);

-- A daily metric an integration reports, and the unit of its values.
CREATE TABLE noticeos_ref.metric_kinds (
  integration text NOT NULL REFERENCES noticeos_ref.integrations,
  metric      text NOT NULL CHECK (metric ~ '^[a-z0-9_]+$'),
  unit        text NOT NULL CHECK (unit IN ('count','ratio','position')),
  PRIMARY KEY (integration, metric)
);

-- A check the nightly hygiene lane runs on a site.
CREATE TABLE noticeos_ref.check_kinds (
  check_id text PRIMARY KEY CHECK (check_id ~ '^[a-z0-9][a-z0-9-]*$')
);

INSERT INTO noticeos_ref.integrations (integration, provider, display_name) VALUES
  ('ga4', 'google', 'Google Analytics 4'),
  ('gsc', 'google', 'Google Search Console'),
  ('bing-webmaster', 'bing-webmaster', 'Bing Webmaster Tools'),
  ('dataforseo', 'dataforseo', 'DataForSEO'),
  ('clarity', 'clarity', 'Microsoft Clarity'),
  ('posthog', 'posthog', 'PostHog');

INSERT INTO noticeos_ref.metric_kinds (integration, metric, unit) VALUES
  ('ga4', 'sessions', 'count'), ('ga4', 'active_users', 'count'),
  ('ga4', 'page_views', 'count'), ('ga4', 'event_count', 'count'),
  ('gsc', 'clicks', 'count'), ('gsc', 'impressions', 'count'),
  ('gsc', 'ctr', 'ratio'), ('gsc', 'position', 'position'),
  ('bing-webmaster', 'clicks', 'count'), ('bing-webmaster', 'impressions', 'count');

INSERT INTO noticeos_ref.check_kinds (check_id) VALUES
  ('html-depth'), ('robots-ai-access'), ('sitemap'), ('page-structure');

-- ─── Workspaces and sites ────────────────────────────────────────────────────

CREATE TABLE noticeos.workspaces (
  workspace_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE noticeos.assets (
  workspace_id uuid NOT NULL REFERENCES noticeos.workspaces,
  -- The legacy id, kept verbatim: URLs, config documents, task labels and
  -- pulses all name a site by it. Immutable, like today.
  asset_id     text NOT NULL CHECK (asset_id <> '' AND asset_id !~ '\s'),
  -- NULL: the site has no public domain (the OS's own asset).
  domain       text CHECK (domain IS NULL OR (domain <> '' AND domain !~ '\s')),
  display_name text NOT NULL CHECK (length(display_name) >= 1),
  status       text NOT NULL CHECK (status IN ('pre-launch','onboarding','baselining','live','retired')),
  sense_only   boolean NOT NULL DEFAULT true,
  is_os        boolean NOT NULL DEFAULT false,
  -- The site's place in the list of sites, 1 first: every list of sites is
  -- ordered by it (bead ro-ujb9.76.52). A new site takes the workspace's next
  -- place, at the end ("Numbers a workspace hands out", below); the importer
  -- brings the order D1 inserted its rows in; retiring a site keeps its
  -- place. Only a move changes one, dealing the places of the sites it spans
  -- out again.
  list_position bigint NOT NULL CHECK (list_position >= 1),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, asset_id),
  UNIQUE (workspace_id, list_position)
);
-- One OS asset per workspace (assets.is_os, db/README.md).
CREATE UNIQUE INDEX assets_one_os ON noticeos.assets (workspace_id) WHERE is_os;
-- One site per domain: by-domain discovery (a Mediavine or PostHog site
-- matched by its domain) must find exactly one.
CREATE UNIQUE INDEX assets_one_per_domain ON noticeos.assets (workspace_id, domain) WHERE domain IS NOT NULL;

-- ─── Site reports, alerts and the timeline ───────────────────────────────────

CREATE TABLE noticeos.pulses (
  workspace_id uuid NOT NULL REFERENCES noticeos.workspaces,
  pulse_id     bigint GENERATED ALWAYS AS IDENTITY,
  pulse_number bigint NOT NULL CHECK (pulse_number >= 1), -- what readers show; see "Numbers a workspace hands out"
  asset_id     text NOT NULL,
  pulse_date   date NOT NULL,
  -- A same-day retry appends revision n+1 instead of replacing the row
  -- (doc 19 finding 2's remaining step). The current report is the highest.
  revision     integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  generated_at timestamptz,
  received_at  timestamptz NOT NULL DEFAULT now(),
  capabilities jsonb CHECK (capabilities IS NULL OR jsonb_typeof(capabilities) = 'array'),
  -- The report as received: an object, validated by the pulse contract.
  envelope     json NOT NULL CHECK (json_typeof(envelope) = 'object'),
  PRIMARY KEY (workspace_id, pulse_id),
  UNIQUE (workspace_id, pulse_number),
  UNIQUE (workspace_id, asset_id, pulse_date, revision),
  UNIQUE (workspace_id, asset_id, pulse_id),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES noticeos.assets
);
CREATE INDEX pulses_received ON noticeos.pulses (workspace_id, asset_id, received_at);

-- Each site's report for each day: its newest revision. `day_number` is the
-- number the day's first revision took, and stays the report's number however
-- often the site sends that day again, as a D1 row kept its id through a
-- same-day upsert (ro-ujb9.76.5.2). Written as "no newer revision" rather than
-- DISTINCT ON so a reader's bound on received_at or pulse_date reaches the
-- indexes.
CREATE VIEW noticeos.current_pulses WITH (security_invoker = true) AS
SELECT p.*,
       (SELECT d.pulse_number FROM noticeos.pulses d
         WHERE d.workspace_id = p.workspace_id AND d.asset_id = p.asset_id
           AND d.pulse_date = p.pulse_date AND d.revision = 1) AS day_number
  FROM noticeos.pulses p
 WHERE NOT EXISTS (SELECT 1 FROM noticeos.pulses n
                    WHERE n.workspace_id = p.workspace_id AND n.asset_id = p.asset_id
                      AND n.pulse_date = p.pulse_date AND n.revision > p.revision);

CREATE TABLE noticeos.flags (
  workspace_id     uuid NOT NULL REFERENCES noticeos.workspaces,
  flag_id          bigint GENERATED ALWAYS AS IDENTITY,
  flag_number      bigint NOT NULL CHECK (flag_number >= 1), -- what readers show; see "Numbers a workspace hands out"
  asset_id         text NOT NULL,
  pulse_id         bigint,
  fired_at         timestamptz NOT NULL,
  severity         text NOT NULL CHECK (severity IN ('info','warn','error')),
  kind             text NOT NULL CHECK (kind IN ('anomaly','opportunity','milestone')),
  metric           text,
  message          text,
  rule_id          text NOT NULL CHECK (rule_id <> ''),
  -- Any JSON value: a legacy row may hold a non-object, which readers treat
  -- as absent (apps/tower/worker/flag-records.ts parseRuleInputs).
  rule_inputs      jsonb,
  disposition      text CHECK (disposition IN ('ack','snooze','tune','incident','hypothesis')),
  disposition_at   timestamptz,
  disposition_note text,
  snooze_until     timestamptz,
  ack_expiry       timestamptz,
  hypothesis_ref   text,
  incident_ref     text,
  resolved_at      timestamptz,
  -- The revision of the same day's report that replaced this alert: a
  -- same-day retry re-derives the alerts nobody had touched, and the ones it
  -- replaces stay in the store, out of every list, count and action (D1
  -- deleted them; ro-ujb9.76.5.2). Replaced is not resolved: nothing settled
  -- it, and a replaced alert never takes a disposition or a resolution.
  replaced_by_pulse_id bigint,
  CHECK (kind <> 'milestone' OR severity = 'info'),
  CHECK (replaced_by_pulse_id IS NULL
         OR (pulse_id IS NOT NULL AND replaced_by_pulse_id <> pulse_id
             AND disposition IS NULL AND resolved_at IS NULL)),
  PRIMARY KEY (workspace_id, flag_id),
  UNIQUE (workspace_id, flag_number),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES noticeos.assets,
  -- A flag exploded from a report belongs to that report's own site.
  FOREIGN KEY (workspace_id, asset_id, pulse_id) REFERENCES noticeos.pulses (workspace_id, asset_id, pulse_id),
  -- And the revision that replaced it is that site's report too.
  FOREIGN KEY (workspace_id, asset_id, replaced_by_pulse_id) REFERENCES noticeos.pulses (workspace_id, asset_id, pulse_id)
);
CREATE INDEX flags_open ON noticeos.flags (workspace_id, asset_id, fired_at) WHERE resolved_at IS NULL;
CREATE INDEX flags_rule ON noticeos.flags (workspace_id, rule_id);
CREATE INDEX flags_asset_fired ON noticeos.flags (workspace_id, asset_id, fired_at);
-- When each alert settled (`settledAtSql`, packages/contract/src/flag-open.ts,
-- D1's COALESCE(resolved_at, disposition_at, fired_at)): a CASE, because row
-- security holds a COALESCE condition back until after the workspace policy,
-- and a condition held back cannot bound an index (ro-ujb9.76.5.2).
CREATE INDEX flags_asset_settled ON noticeos.flags (workspace_id, asset_id,
  (CASE WHEN resolved_at IS NOT NULL THEN resolved_at WHEN disposition_at IS NOT NULL THEN disposition_at ELSE fired_at END));
-- A report's own alerts: what a same-day retry replaces and what it must not
-- raise twice.
CREATE INDEX flags_pulse ON noticeos.flags (workspace_id, pulse_id) WHERE pulse_id IS NOT NULL;

-- Each reading of a condition that is still open, appended instead of
-- rewriting the flag's first evidence (db/README.md "current deviations"); a
-- lane that keeps every night's record (the nightly pull) appends the first
-- reading too.
CREATE TABLE noticeos.flag_evidence (
  workspace_id uuid NOT NULL REFERENCES noticeos.workspaces,
  flag_id      bigint NOT NULL,
  observed_at  timestamptz NOT NULL,
  severity     text NOT NULL CHECK (severity IN ('info','warn','error')),
  message      text,
  rule_inputs  jsonb,
  PRIMARY KEY (workspace_id, flag_id, observed_at),
  FOREIGN KEY (workspace_id, flag_id) REFERENCES noticeos.flags
);

-- Every alert as the operator sees it (ro-ujb9.76.5.2): its severity, message
-- and inputs from its newest reading when it has one, else from the row
-- itself, since a lane that finds a condition still open appends a reading
-- rather than rewriting the row; and never an alert a same-day report retry
-- replaced. `pulse_day_number` is its report's `current_pulses.day_number`.
-- Every reader of alerts reads this; writers write `flags` and
-- `flag_evidence`.
CREATE VIEW noticeos.current_flags WITH (security_invoker = true) AS
SELECT f.workspace_id, f.flag_id, f.flag_number, f.asset_id, f.pulse_id,
       (SELECT d.pulse_number FROM noticeos.pulses p
          JOIN noticeos.pulses d
            ON d.workspace_id = p.workspace_id AND d.asset_id = p.asset_id
           AND d.pulse_date = p.pulse_date AND d.revision = 1
         WHERE p.workspace_id = f.workspace_id AND p.pulse_id = f.pulse_id) AS pulse_day_number,
       f.fired_at,
       coalesce(e.severity, f.severity) AS severity,
       f.kind, f.metric,
       CASE WHEN e.observed_at IS NULL THEN f.message ELSE e.message END AS message,
       f.rule_id,
       CASE WHEN e.observed_at IS NULL THEN f.rule_inputs ELSE e.rule_inputs END AS rule_inputs,
       f.disposition, f.disposition_at, f.disposition_note, f.snooze_until, f.ack_expiry,
       f.hypothesis_ref, f.incident_ref, f.resolved_at
  FROM noticeos.flags f
  LEFT JOIN LATERAL (
        SELECT x.observed_at, x.severity, x.message, x.rule_inputs
          FROM noticeos.flag_evidence x
         WHERE x.workspace_id = f.workspace_id AND x.flag_id = f.flag_id
         ORDER BY x.observed_at DESC
         LIMIT 1) e ON true
 WHERE f.replaced_by_pulse_id IS NULL;

CREATE TABLE noticeos.flag_tunes (
  workspace_id uuid NOT NULL REFERENCES noticeos.workspaces,
  tune_id      bigint GENERATED ALWAYS AS IDENTITY,
  flag_id      bigint NOT NULL,
  rule_id      text NOT NULL CHECK (rule_id <> ''),
  setting      text NOT NULL CHECK (setting <> ''),
  value_from   double precision NOT NULL CHECK (value_from NOT IN ('NaN', 'Infinity', '-Infinity')),
  value_to     double precision NOT NULL CHECK (value_to NOT IN ('NaN', 'Infinity', '-Infinity')),
  tuned_at     timestamptz NOT NULL,
  actor        text NOT NULL CHECK (actor <> ''),
  CHECK (value_from <> value_to),
  PRIMARY KEY (workspace_id, tune_id),
  FOREIGN KEY (workspace_id, flag_id) REFERENCES noticeos.flags
);
CREATE INDEX flag_tunes_rule_at ON noticeos.flag_tunes (workspace_id, rule_id, tuned_at DESC);
CREATE INDEX flag_tunes_flag ON noticeos.flag_tunes (workspace_id, flag_id, tuned_at DESC);

CREATE TABLE noticeos.annotations (
  workspace_id      uuid NOT NULL REFERENCES noticeos.workspaces,
  annotation_id     bigint GENERATED ALWAYS AS IDENTITY,
  annotation_number bigint NOT NULL CHECK (annotation_number >= 1), -- what readers show; see "Numbers a workspace hands out"
  asset_id          text NOT NULL,
  at                timestamptz NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('deploy','model-change','config','incident','autonomy-change','external')),
  ref               text,
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, annotation_id),
  UNIQUE (workspace_id, annotation_number),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES noticeos.assets
);
CREATE INDEX annotations_asset_at ON noticeos.annotations (workspace_id, asset_id, at);

CREATE TABLE noticeos.counter_readings (
  workspace_id uuid NOT NULL REFERENCES noticeos.workspaces,
  asset_id     text NOT NULL,
  metric       text NOT NULL CHECK (metric <> ''),
  value        bigint NOT NULL CHECK (value >= 0),
  observed_at  timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, asset_id, metric),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES noticeos.assets
);

-- ─── Measurement series, collection runs and changed values ─────────────────

-- One measured series: a site's metric from one provider resource under one
-- reporting-day definition (ro-ujb9.70). Rotating the credential keeps the
-- series; a new property or reporting zone is a new series.
CREATE TABLE noticeos.measurement_series (
  workspace_id uuid NOT NULL REFERENCES noticeos.workspaces,
  series_id    bigint GENERATED ALWAYS AS IDENTITY,
  asset_id     text NOT NULL,
  integration  text NOT NULL,
  property_ref text NOT NULL,
  -- NULL: the provider reports no zone. NULL matches only NULL (the unique
  -- key below), so it is one series, never a wildcard.
  time_zone    text CHECK (time_zone IS NULL OR time_zone <> ''),
  -- A metric the integration reports; its unit is the metric kind's.
  metric       text NOT NULL,
  PRIMARY KEY (workspace_id, series_id),
  UNIQUE NULLS NOT DISTINCT (workspace_id, asset_id, integration, property_ref, time_zone, metric),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES noticeos.assets,
  FOREIGN KEY (integration, metric) REFERENCES noticeos_ref.metric_kinds
);

CREATE TABLE noticeos.signal_runs (
  workspace_id      uuid NOT NULL REFERENCES noticeos.workspaces,
  run_seq           bigint GENERATED ALWAYS AS IDENTITY,
  -- The run's own id, kept for lookups and imports; observations use run_seq.
  run_id            text NOT NULL CHECK (run_id <> ''),
  asset_id          text NOT NULL,
  integration       text NOT NULL REFERENCES noticeos_ref.integrations,
  credential_ref    text NOT NULL,
  property_ref      text NOT NULL,
  time_zone         text CHECK (time_zone IS NULL OR time_zone <> ''),
  started_at        timestamptz NOT NULL,
  finished_at       timestamptz NOT NULL,
  status            text NOT NULL CHECK (status IN ('success','error')),
  window_start      date NOT NULL,
  window_end        date NOT NULL,
  data_state        text NOT NULL CHECK (data_state IN ('final','includes-provisional')),
  provisional_from  date,
  provider_rows     integer NOT NULL CHECK (provider_rows >= 0),
  observation_count integer NOT NULL CHECK (observation_count >= 0),
  error_code        text,
  error_message     text,
  CHECK ((status = 'success' AND error_code IS NULL AND error_message IS NULL)
      OR (status = 'error' AND error_message IS NOT NULL)),
  CHECK ((data_state = 'final' AND provisional_from IS NULL)
      OR (data_state = 'includes-provisional' AND provisional_from IS NOT NULL)),
  CHECK (window_start <= window_end),
  CHECK (finished_at >= started_at),
  -- The first provisional day never follows the window. It may precede its
  -- start: GA4 settles from window_end back (workers/ingest/src/google-signals.ts
  -- ga4ProvisionalFrom), whatever the window's length.
  CHECK (provisional_from IS NULL OR provisional_from <= window_end),
  PRIMARY KEY (workspace_id, run_seq),
  UNIQUE (workspace_id, run_id),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES noticeos.assets
);
CREATE INDEX signal_runs_latest ON noticeos.signal_runs (workspace_id, asset_id, integration, finished_at DESC);
CREATE INDEX signal_runs_window ON noticeos.signal_runs (workspace_id, asset_id, integration, window_end DESC);

CREATE TABLE noticeos.signal_observations (
  workspace_id   uuid NOT NULL REFERENCES noticeos.workspaces,
  observation_id bigint GENERATED ALWAYS AS IDENTITY,
  run_seq        bigint NOT NULL,
  series_id      bigint NOT NULL,
  observed_date  date NOT NULL,
  -- In the metric kind's unit. Finite only: a provider NaN is an import exception.
  value          double precision NOT NULL CHECK (value NOT IN ('NaN', 'Infinity', '-Infinity')),
  PRIMARY KEY (workspace_id, observation_id),
  -- Also the run/date read path; no second index over the same columns (ro-ujb9.73).
  UNIQUE (workspace_id, run_seq, series_id, observed_date),
  FOREIGN KEY (workspace_id, run_seq) REFERENCES noticeos.signal_runs,
  FOREIGN KEY (workspace_id, series_id) REFERENCES noticeos.measurement_series
);
CREATE INDEX signal_observations_series_date ON noticeos.signal_observations (workspace_id, series_id, observed_date);

-- An observation belongs to the series its own run measured: the same site,
-- provider, property and reporting zone, and a run that succeeded. Two
-- foreign keys prove each parent exists; only this proves they agree
-- (ro-ujb9.70, ro-ujb9.71).
CREATE FUNCTION noticeos.signal_observation_matches_run() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM noticeos.signal_runs r
      JOIN noticeos.measurement_series s
        ON s.workspace_id = r.workspace_id
       AND s.asset_id = r.asset_id
       AND s.integration = r.integration
       AND s.property_ref = r.property_ref
       AND s.time_zone IS NOT DISTINCT FROM r.time_zone
     WHERE r.workspace_id = NEW.workspace_id
       AND r.run_seq = NEW.run_seq
       AND r.status = 'success'
       AND s.series_id = NEW.series_id
  ) THEN
    RAISE EXCEPTION 'signal_observations: the series must be the one its successful run measured (site, provider, property and zone)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signal_observation_matches_run BEFORE INSERT OR UPDATE OF run_seq, series_id
  ON noticeos.signal_observations FOR EACH ROW EXECUTE FUNCTION noticeos.signal_observation_matches_run();

-- ─── Raw archive: immutable objects and the runs that fetched them ──────────

-- One stored object in the raw archive (object storage). An unchanged run
-- points at an object an earlier run stored; the object is listed once.
CREATE TABLE noticeos.archive_objects (
  workspace_id    uuid NOT NULL REFERENCES noticeos.workspaces,
  object_seq      bigint GENERATED ALWAYS AS IDENTITY,
  -- The object's key in object storage, kept for lookups; runs use object_seq.
  object_key      text NOT NULL CHECK (object_key <> ''),
  content_sha256  text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  object_bytes    bigint NOT NULL CHECK (object_bytes >= 0),
  first_stored_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, object_seq),
  UNIQUE (workspace_id, object_key)
);

CREATE TABLE noticeos.archive_runs (
  workspace_id       uuid NOT NULL REFERENCES noticeos.workspaces,
  run_seq            bigint GENERATED ALWAYS AS IDENTITY,
  run_id             text NOT NULL CHECK (run_id <> ''),
  asset_id           text NOT NULL,
  integration        text NOT NULL REFERENCES noticeos_ref.integrations,
  report             text NOT NULL CHECK (report <> ''),
  credential_ref     text NOT NULL,
  property_ref       text NOT NULL,
  report_date        date NOT NULL,
  requested_at       timestamptz NOT NULL,
  finished_at        timestamptz NOT NULL,
  status             text NOT NULL CHECK (status IN ('success','unchanged','error')),
  data_state         text NOT NULL CHECK (data_state IN ('provider-final','revision-window','provider-snapshot')),
  schema_version     integer NOT NULL CHECK (schema_version >= 1),
  provider_rows      integer NOT NULL CHECK (provider_rows >= 0),
  request_count      integer NOT NULL CHECK (request_count >= 0),
  provider_truncated boolean NOT NULL,
  -- The stored object; NULL on a failed run, which stored nothing.
  object_seq         bigint,
  error_code         text,
  error_message      text,
  -- USD with six decimals: provider prices are fractions of a cent (ro-ujb9.75).
  -- numeric holds 'NaN' even at a declared precision, and 'NaN' >= 0 is true
  -- in Postgres, so NaN is refused by name (ro-ujb9.76.46).
  cost_usd           numeric(14,6) CHECK (cost_usd IS NULL OR (cost_usd <> 'NaN' AND cost_usd >= 0)),
  cost_state         text NOT NULL CHECK (cost_state IN ('reported','estimated','unknown')),
  CHECK ((cost_state = 'unknown') = (cost_usd IS NULL)),
  CHECK ((status IN ('success','unchanged') AND object_seq IS NOT NULL AND error_code IS NULL AND error_message IS NULL)
      OR (status = 'error' AND object_seq IS NULL AND error_code IS NOT NULL AND error_message IS NOT NULL)),
  PRIMARY KEY (workspace_id, run_seq),
  UNIQUE (workspace_id, run_id),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES noticeos.assets,
  FOREIGN KEY (workspace_id, object_seq) REFERENCES noticeos.archive_objects
);
CREATE INDEX archive_runs_latest ON noticeos.archive_runs (workspace_id, asset_id, integration, report, report_date, finished_at DESC);
CREATE INDEX archive_runs_finished ON noticeos.archive_runs (workspace_id, asset_id, integration, report, finished_at DESC);
CREATE INDEX archive_runs_object ON noticeos.archive_runs (workspace_id, object_seq) WHERE object_seq IS NOT NULL;
CREATE INDEX archive_runs_spend ON noticeos.archive_runs (workspace_id, integration, requested_at);

CREATE TABLE noticeos.research_log (
  workspace_id    uuid NOT NULL REFERENCES noticeos.workspaces,
  research_id     bigint GENERATED ALWAYS AS IDENTITY,
  research_number bigint NOT NULL CHECK (research_number >= 1), -- what readers show; see "Numbers a workspace hands out"
  -- NULL: research about no one site (a market scan).
  asset_id        text,
  provider        text NOT NULL REFERENCES noticeos_ref.integrations (integration),
  endpoint        text NOT NULL CHECK (endpoint <> ''),
  params_sha256   text NOT NULL CHECK (params_sha256 ~ '^[0-9a-f]{64}$'),
  question        text NOT NULL CHECK (question <> ''),
  cost_usd        numeric(14,6) CHECK (cost_usd IS NULL OR (cost_usd <> 'NaN' AND cost_usd >= 0)),
  cost_state      text NOT NULL CHECK (cost_state IN ('reported','estimated','unknown')),
  -- An archive or checkpoint key, or NULL: bought but not kept. No link: a
  -- checkpoint is not an archive object.
  object_key      text CHECK (object_key IS NULL OR object_key <> ''),
  actor           text NOT NULL CHECK (actor <> ''),
  bought_at       timestamptz NOT NULL,
  CHECK ((cost_state = 'unknown') = (cost_usd IS NULL)),
  PRIMARY KEY (workspace_id, research_id),
  UNIQUE (workspace_id, research_number),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES noticeos.assets
);
CREATE INDEX research_log_question ON noticeos.research_log (workspace_id, provider, endpoint, params_sha256, bought_at DESC);
CREATE INDEX research_log_spend ON noticeos.research_log (workspace_id, bought_at, asset_id);

CREATE TABLE noticeos.asset_insight_snapshots (
  workspace_id         uuid NOT NULL REFERENCES noticeos.workspaces,
  snapshot_id          text NOT NULL CHECK (snapshot_id <> ''),
  asset_id             text NOT NULL,
  generated_at         timestamptz NOT NULL,
  window_start         date,
  window_end           date,
  source_archive_count integer NOT NULL CHECK (source_archive_count >= 0),
  -- Hashes the payload text, which json keeps byte for byte.
  content_sha256       text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  payload              json NOT NULL CHECK (json_typeof(payload) = 'object'),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((window_start IS NULL AND window_end IS NULL)
      OR (window_start IS NOT NULL AND window_end IS NOT NULL AND window_start <= window_end)),
  PRIMARY KEY (workspace_id, snapshot_id),
  UNIQUE (workspace_id, asset_id, content_sha256),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES noticeos.assets
);
CREATE INDEX asset_insight_snapshots_latest ON noticeos.asset_insight_snapshots (workspace_id, asset_id, generated_at DESC, created_at DESC);

-- Postgres keeps each site's two newest snapshots; an older one moves to the
-- analytical store (Parquet read with DuckDB, ro-ujb9.67) and is never simply
-- deleted (operator choice 9, 2026-09-24; two, ro-ujb9.76.17, 2026-09-29). The
-- mover runs as noticeos_maint: it records the move here first, with where the
-- snapshot now lives; only then may the snapshot leave, and never while it is
-- one of its site's two newest.
CREATE TABLE noticeos.asset_insight_snapshot_moves (
  workspace_id   uuid NOT NULL REFERENCES noticeos.workspaces,
  snapshot_id    text NOT NULL CHECK (snapshot_id <> ''),
  asset_id       text NOT NULL,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  -- The analytical dataset object that now holds the snapshot.
  dataset_key    text NOT NULL CHECK (dataset_key <> ''),
  moved_at       timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, snapshot_id),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES noticeos.assets
);

-- Whether a snapshot is one of the two its site's readers show: newest
-- generated, then newest stored. The site page reads the newest; the Wall's
-- feed reports what the newest found that the one before did not
-- (apps/tower/worker/wall-feed.ts), so both stay.
CREATE FUNCTION noticeos.insight_snapshot_is_kept(ws uuid, asset text, snapshot text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT snapshot IN (
    SELECT s.snapshot_id FROM noticeos.asset_insight_snapshots s
     WHERE s.workspace_id = ws AND s.asset_id = asset
     ORDER BY s.generated_at DESC, s.created_at DESC, s.snapshot_id DESC
     LIMIT 2)
$$;

-- A move names a stored snapshot by its own site and hash, and never one of
-- the two newest.
CREATE FUNCTION noticeos.insight_snapshot_move_is_valid() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM noticeos.asset_insight_snapshots s
     WHERE s.workspace_id = NEW.workspace_id AND s.snapshot_id = NEW.snapshot_id
       AND s.asset_id = NEW.asset_id AND s.content_sha256 = NEW.content_sha256
  ) THEN
    RAISE EXCEPTION 'asset_insight_snapshot_moves: no stored snapshot with this id, site and hash'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF noticeos.insight_snapshot_is_kept(NEW.workspace_id, NEW.asset_id, NEW.snapshot_id) THEN
    RAISE EXCEPTION 'asset_insight_snapshot_moves: a site''s two newest snapshots stay in the store'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER insight_snapshot_move_is_valid BEFORE INSERT ON noticeos.asset_insight_snapshot_moves
  FOR EACH ROW EXECUTE FUNCTION noticeos.insight_snapshot_move_is_valid();

-- A snapshot leaves only once its move is recorded, and never while it is one
-- of the two newest.
CREATE FUNCTION noticeos.insight_snapshot_leaves_only_when_moved() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF noticeos.insight_snapshot_is_kept(OLD.workspace_id, OLD.asset_id, OLD.snapshot_id) THEN
    RAISE EXCEPTION 'asset_insight_snapshots: a site''s two newest snapshots stay in the store'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM noticeos.asset_insight_snapshot_moves m
     WHERE m.workspace_id = OLD.workspace_id AND m.snapshot_id = OLD.snapshot_id
       AND m.content_sha256 = OLD.content_sha256
  ) THEN
    RAISE EXCEPTION 'asset_insight_snapshots: record the move to the analytical store before removing a snapshot'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER insight_snapshot_leaves_only_when_moved BEFORE DELETE ON noticeos.asset_insight_snapshots
  FOR EACH ROW EXECUTE FUNCTION noticeos.insight_snapshot_leaves_only_when_moved();

-- ─── Watches, checks and campaigns ──────────────────────────────────────────

CREATE TABLE noticeos.watch_windows (
  workspace_id       uuid NOT NULL REFERENCES noticeos.workspaces,
  window_id          text NOT NULL CHECK (window_id <> ''),
  asset_id           text NOT NULL,
  ref_kind           text NOT NULL CHECK (ref_kind IN ('annotation','decision','manual')),
  ref                text NOT NULL CHECK (ref <> ''),
  -- The watched series' vocabulary: a metric its integration reports.
  metric_integration text NOT NULL,
  metric             text NOT NULL,
  -- NULL: the whole site, the only scope v1 evaluates.
  scope              jsonb CHECK (scope IS NULL OR jsonb_typeof(scope) = 'object'),
  registered_at      timestamptz NOT NULL,
  baseline_start     date NOT NULL,
  baseline_end       date NOT NULL,
  check_offsets      integer[] NOT NULL CHECK (cardinality(check_offsets) >= 1 AND 0 < ALL (check_offsets)),
  -- NULL: no verdict was given, so the window can only close inconclusive.
  thresholds         jsonb CHECK (thresholds IS NULL OR jsonb_typeof(thresholds) = 'object'),
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  outcome            text CHECK (outcome IN ('ship_confirmed','kill_confirmed','inconclusive','unmeasurable')),
  last_checked_at    timestamptz,
  closed_at          timestamptz,
  note               text,
  outcome_note       text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  readback_bead      text,
  readback_posted_at timestamptz,
  CHECK (baseline_start <= baseline_end),
  CHECK (baseline_end <= (registered_at AT TIME ZONE 'UTC')::date),
  CHECK ((status = 'open' AND outcome IS NULL AND closed_at IS NULL)
      OR (status = 'closed' AND outcome IS NOT NULL AND closed_at IS NOT NULL)),
  PRIMARY KEY (workspace_id, window_id),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES noticeos.assets,
  FOREIGN KEY (metric_integration, metric) REFERENCES noticeos_ref.metric_kinds (integration, metric)
);
CREATE INDEX watch_windows_open ON noticeos.watch_windows (workspace_id, registered_at) WHERE status = 'open';
CREATE INDEX watch_windows_asset_ref ON noticeos.watch_windows (workspace_id, asset_id, ref_kind, ref);
CREATE INDEX watch_windows_readback_pending ON noticeos.watch_windows (workspace_id, closed_at)
  WHERE status = 'closed' AND readback_bead IS NOT NULL AND readback_posted_at IS NULL;

-- One evaluated offset of a watch. Appending a reading no longer rewrites a
-- growing JSON array on the window; the primary key is what stops a re-run
-- from reading the same offset twice.
CREATE TABLE noticeos.watch_window_readings (
  workspace_id    uuid NOT NULL REFERENCES noticeos.workspaces,
  window_id       text NOT NULL,
  offset_days     integer NOT NULL CHECK (offset_days > 0),
  check_date      date NOT NULL,
  checked_at      timestamptz NOT NULL,
  final           boolean NOT NULL,
  baseline        jsonb CHECK (baseline IS NULL OR jsonb_typeof(baseline) = 'object'),
  post            jsonb CHECK (post IS NULL OR jsonb_typeof(post) = 'object'),
  delta_pct       double precision CHECK (delta_pct IS NULL OR delta_pct NOT IN ('NaN', 'Infinity', '-Infinity')),
  pre_change_days integer NOT NULL CHECK (pre_change_days >= 0),
  PRIMARY KEY (workspace_id, window_id, offset_days),
  FOREIGN KEY (workspace_id, window_id) REFERENCES noticeos.watch_windows
);

CREATE TABLE noticeos.hygiene_checks (
  workspace_id   uuid NOT NULL REFERENCES noticeos.workspaces,
  reading_id     bigint GENERATED ALWAYS AS IDENTITY,
  reading_number bigint NOT NULL CHECK (reading_number >= 1), -- what readers show; see "Numbers a workspace hands out"
  asset_id       text NOT NULL,
  check_id       text NOT NULL REFERENCES noticeos_ref.check_kinds,
  observed_at    timestamptz NOT NULL,
  observed_on    date NOT NULL,
  status         text NOT NULL CHECK (status IN ('ok','warn','error','unreachable')),
  -- NULL: not measured. Never zero for a failed fetch.
  value_num      double precision CHECK (value_num IS NULL OR value_num NOT IN ('NaN', 'Infinity', '-Infinity')),
  -- What the check recorded, kept as it wrote it: the site's page lists the
  -- crawler map in the order the check wrote its keys, which jsonb would sort.
  detail         json NOT NULL DEFAULT '{}' CHECK (json_typeof(detail) = 'object'),
  CHECK (observed_on = (observed_at AT TIME ZONE 'UTC')::date),
  PRIMARY KEY (workspace_id, reading_id),
  UNIQUE (workspace_id, reading_number),
  UNIQUE (workspace_id, asset_id, check_id, observed_on),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES noticeos.assets
);

CREATE TABLE noticeos.reclamation_targets (
  workspace_id     uuid NOT NULL REFERENCES noticeos.workspaces,
  target_id        bigint GENERATED ALWAYS AS IDENTITY,
  target_number    bigint NOT NULL CHECK (target_number >= 1), -- what readers show; see "Numbers a workspace hands out"
  asset_id         text NOT NULL,
  tier             integer CHECK (tier IS NULL OR tier >= 1),
  segment          text,
  domain           text NOT NULL CHECK (length(domain) BETWEEN 1 AND 253),
  -- '' means "no specific page". NOT NULL, so the unique key below cannot be
  -- defeated by a NULL (ro-ujb9.71).
  referring_page   text NOT NULL DEFAULT '',
  links_to_dead    text,
  replace_with     text,
  contact          text,
  notes            text,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','opened','clicked','replied','won','skip','dead')),
  status_at        timestamptz,
  last_verified_at timestamptz,
  outcome_note     text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, target_id),
  UNIQUE (workspace_id, target_number),
  UNIQUE (workspace_id, asset_id, domain, referring_page),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES noticeos.assets
);
CREATE INDEX reclamation_targets_asset ON noticeos.reclamation_targets (workspace_id, asset_id, status_at DESC);
CREATE INDEX reclamation_targets_open ON noticeos.reclamation_targets (workspace_id, asset_id, tier, domain)
  WHERE status NOT IN ('won','skip','dead');

-- The operator's marked/dismissed choice on a query or finding: display state,
-- not a business decision (renamed from `decisions`).
CREATE TABLE noticeos.item_dispositions (
  workspace_id   uuid NOT NULL REFERENCES noticeos.workspaces,
  disposition_id bigint GENERATED ALWAYS AS IDENTITY,
  asset_id       text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('query','finding')),
  item_key       text NOT NULL CHECK (length(item_key) BETWEEN 1 AND 512),
  status         text NOT NULL CHECK (status IN ('marked','dismissed')),
  decided_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL,
  note           text CHECK (note IS NULL OR length(note) <= 2000),
  PRIMARY KEY (workspace_id, disposition_id),
  UNIQUE (workspace_id, asset_id, kind, item_key),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES noticeos.assets
);
CREATE INDEX item_dispositions_asset ON noticeos.item_dispositions (workspace_id, asset_id, kind, updated_at DESC);

-- ─── Money ──────────────────────────────────────────────────────────────────

-- The ledger (docs/00): one append-only record with three kinds (D36), each
-- entry naming its currency (D37). Revenue and cost are money: an amount in
-- integer minor units of that currency and a booking state. A change is a
-- shipped change, booked once, when it ships: its family is its change class
-- and `ref` its id, the one its hypothesis card, its registry row and the
-- costs spent on it share. It freezes the prediction it shipped with (D38) and
-- books no money: the revenue a change earns is already booked as revenue,
-- and its realized value comes only through docs/03's methods, with an
-- interval, as a later entry that supersedes it; that lane is not built. So
-- the financial view never counts it. Its kill criterion is its watch
-- window's (watch_windows.thresholds and check_offsets), not a column here.
CREATE TABLE noticeos.ledger_entries (
  workspace_id      uuid NOT NULL REFERENCES noticeos.workspaces,
  entry_id          bigint GENERATED ALWAYS AS IDENTITY,
  entry_number      bigint NOT NULL CHECK (entry_number >= 1), -- what readers show; see "Numbers a workspace hands out"
  kind              text NOT NULL CHECK (kind IN ('revenue','cost','change')),
  asset_id          text NOT NULL,
  -- The accounting month, stored as its first day; a change's is the month it shipped.
  period_month      date NOT NULL CHECK (period_month = date_trunc('month', period_month)::date),
  -- What kind of revenue, cost or change; a change's is its change class.
  family            text NOT NULL,
  -- Integer minor units of `currency`. Negative adjustments are legitimate.
  -- NULL, with the booking state, only on a change entry.
  amount_minor      bigint,
  -- A money entry's amount is in it; a change's prediction is.
  currency          char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  source            text,
  -- A pointer, no foreign key. A cost's names the change or run it was spent
  -- on; a change's is that change's own id.
  ref               text,
  booking_state     text CHECK (booking_state IN ('estimated','reconciled')),
  supersedes_id     bigint,
  note              text,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  -- NULL: booked by hand, with no export behind it. NULLs are distinct in the
  -- unique key below, so any number of hand-booked entries can exist.
  external_id       text CHECK (external_id IS NULL OR external_id <> ''),
  -- What the figure covers, as data rather than note wording (ro-ujb9.72).
  -- NULL on an entry whose source never said; coverage_complete NULL = unknown.
  coverage_start    date,
  coverage_end      date,
  coverage_complete boolean,
  -- The prediction a change shipped with (D38): what grading compares its
  -- realized value against, so it is never edited, and a correction of the
  -- change repeats it. Only a change carries one.
  -- Value per month, in integer minor units of `currency`; it may be negative.
  predicted_monthly_value_minor bigint,
  -- The chance it succeeds, from 0 to 1.
  predicted_success_chance      numeric CHECK (predicted_success_chance BETWEEN 0 AND 1),
  -- Its full cost (inference, operator minutes, spend), in integer minor units of `currency`.
  predicted_cost_minor          bigint CHECK (predicted_cost_minor >= 0),
  -- Days from shipping until a signal can be read.
  predicted_days_to_signal      integer CHECK (predicted_days_to_signal >= 1),
  CHECK ((kind = 'revenue' AND family IN ('ads','affiliate','subs','licensing'))
      OR (kind = 'cost' AND family IN ('inference','api','infra','operator','os-overhead'))
      OR (kind = 'change' AND family IN ('content-data','copy','template','feature','infra'))),
  -- Money names its amount and booking state, and predicts nothing.
  CHECK (kind = 'change' OR (amount_minor IS NOT NULL AND booking_state IS NOT NULL
                             AND predicted_monthly_value_minor IS NULL AND predicted_success_chance IS NULL
                             AND predicted_cost_minor IS NULL AND predicted_days_to_signal IS NULL)),
  -- A change names its change and the whole prediction it shipped with, and no money.
  CHECK (kind <> 'change' OR (ref IS NOT NULL
                              AND predicted_monthly_value_minor IS NOT NULL AND predicted_success_chance IS NOT NULL
                              AND predicted_cost_minor IS NOT NULL AND predicted_days_to_signal IS NOT NULL
                              AND amount_minor IS NULL AND booking_state IS NULL
                              AND coverage_start IS NULL AND coverage_end IS NULL AND coverage_complete IS NULL)),
  CHECK (coverage_start IS NULL OR coverage_end IS NULL OR coverage_start <= coverage_end),
  PRIMARY KEY (workspace_id, entry_id),
  UNIQUE (workspace_id, entry_number),
  UNIQUE (workspace_id, external_id),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES noticeos.assets,
  FOREIGN KEY (workspace_id, supersedes_id) REFERENCES noticeos.ledger_entries (workspace_id, entry_id)
);
-- One successor per entry: every correction chain is a single line (ro-ujb9.69).
CREATE UNIQUE INDEX ledger_entries_one_successor ON noticeos.ledger_entries (workspace_id, supersedes_id) WHERE supersedes_id IS NOT NULL;
-- A change is booked once: its later entries supersede its first, so one id
-- is one chain (docs/00 "one id").
CREATE UNIQUE INDEX ledger_entries_one_per_change ON noticeos.ledger_entries (workspace_id, ref)
  WHERE kind = 'change' AND supersedes_id IS NULL AND ref IS NOT NULL;
CREATE INDEX ledger_entries_asset_period ON noticeos.ledger_entries (workspace_id, asset_id, kind, period_month);
CREATE INDEX ledger_entries_family_period ON noticeos.ledger_entries (workspace_id, kind, family, period_month);
CREATE INDEX ledger_entries_ref ON noticeos.ledger_entries (workspace_id, ref) WHERE ref IS NOT NULL;

-- A correction replaces an earlier entry of the same site, month, kind, family
-- and currency (ports db/migrations/0036's insert trigger); a change entry's
-- correction names the same change and repeats its prediction, so no
-- correction can edit the prediction the change shipped with (D38).
CREATE FUNCTION noticeos.ledger_correction_matches_target() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.supersedes_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.supersedes_id >= NEW.entry_id THEN
    RAISE EXCEPTION 'ledger: supersedes_id must name an earlier entry';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM noticeos.ledger_entries t
     WHERE t.workspace_id = NEW.workspace_id
       AND t.entry_id = NEW.supersedes_id
       AND t.asset_id = NEW.asset_id
       AND t.period_month = NEW.period_month
       AND t.kind = NEW.kind
       AND t.family = NEW.family
       AND t.currency = NEW.currency
       AND (NEW.kind <> 'change' OR (t.ref = NEW.ref
            AND t.predicted_monthly_value_minor = NEW.predicted_monthly_value_minor
            AND t.predicted_success_chance = NEW.predicted_success_chance
            AND t.predicted_cost_minor = NEW.predicted_cost_minor
            AND t.predicted_days_to_signal = NEW.predicted_days_to_signal))
  ) THEN
    RAISE EXCEPTION 'ledger: a correction must have the same site, month, kind, family and currency as the entry it supersedes, and a change''s the same change and prediction';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_correction_matches_target BEFORE INSERT ON noticeos.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION noticeos.ledger_correction_matches_target();

-- A booked entry never changes and is never removed; a correction is a new
-- entry. The application role has no UPDATE or DELETE here either; this holds
-- the line for the owner too (0036's update triggers, made total).
CREATE FUNCTION noticeos.ledger_entries_are_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger: entries are immutable; book a correcting entry instead';
END $$;
CREATE TRIGGER ledger_entries_are_immutable BEFORE UPDATE OR DELETE ON noticeos.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION noticeos.ledger_entries_are_immutable();

CREATE TABLE noticeos.mediavine_sites (
  workspace_id uuid NOT NULL REFERENCES noticeos.workspaces,
  site_id      text NOT NULL,
  asset_id     text NOT NULL,
  PRIMARY KEY (workspace_id, site_id),
  UNIQUE (workspace_id, asset_id),
  UNIQUE (workspace_id, asset_id, site_id),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES noticeos.assets
);

CREATE TABLE noticeos.mediavine_runs (
  workspace_id     uuid NOT NULL REFERENCES noticeos.workspaces,
  run_seq          bigint GENERATED ALWAYS AS IDENTITY,
  -- The sync's own id, kept for lookups and imports; daily facts use run_seq.
  run_id           text NOT NULL CHECK (run_id <> ''),
  asset_id         text NOT NULL,
  site_id          text NOT NULL,
  start_date       date NOT NULL,
  end_date         date NOT NULL,
  attempted_at     timestamptz NOT NULL,
  outcome          text NOT NULL CHECK (outcome IN ('success','incomplete','failed')),
  message          text,
  summary_minor    bigint,
  daily_minor      bigint,
  difference_minor bigint,
  CHECK (start_date <= end_date),
  PRIMARY KEY (workspace_id, run_seq),
  UNIQUE (workspace_id, run_id),
  -- Redundant with the key above on purpose: it is what lets a daily fact
  -- name its run AND that run's site, so the two cannot disagree.
  UNIQUE (workspace_id, run_seq, asset_id, site_id),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES noticeos.assets
);
CREATE INDEX mediavine_runs_asset ON noticeos.mediavine_runs (workspace_id, asset_id, attempted_at);

CREATE TABLE noticeos.mediavine_daily (
  workspace_id uuid NOT NULL REFERENCES noticeos.workspaces,
  daily_id     bigint GENERATED ALWAYS AS IDENTITY,
  daily_number bigint NOT NULL CHECK (daily_number >= 1), -- what readers show; see "Numbers a workspace hands out"
  run_seq      bigint NOT NULL,
  asset_id     text NOT NULL,
  site_id      text NOT NULL,
  report_date  date NOT NULL,
  amount_minor bigint NOT NULL,
  currency     char(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  recorded_at  timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, daily_id),
  UNIQUE (workspace_id, daily_number),
  UNIQUE (workspace_id, run_seq, report_date),
  FOREIGN KEY (workspace_id, asset_id, site_id) REFERENCES noticeos.mediavine_sites (workspace_id, asset_id, site_id),
  -- A daily fact belongs to a run of its own site (ro-ujb9.71).
  FOREIGN KEY (workspace_id, run_seq, asset_id, site_id) REFERENCES noticeos.mediavine_runs (workspace_id, run_seq, asset_id, site_id)
);
CREATE INDEX mediavine_daily_latest ON noticeos.mediavine_daily (workspace_id, asset_id, site_id, report_date, daily_id);

CREATE TABLE noticeos.mediavine_state (
  workspace_id    uuid NOT NULL REFERENCES noticeos.workspaces,
  asset_id        text NOT NULL,
  site_id         text NOT NULL,
  target_date     date,
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz,
  last_error      text,
  auth_blocked    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (workspace_id, asset_id),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES noticeos.assets
);

CREATE VIEW noticeos.mediavine_current_daily WITH (security_invoker = true) AS
SELECT d.* FROM noticeos.mediavine_daily d
 WHERE NOT EXISTS (
   SELECT 1 FROM noticeos.mediavine_daily newer
    WHERE newer.workspace_id = d.workspace_id
      AND newer.asset_id = d.asset_id
      AND newer.site_id = d.site_id
      AND newer.report_date = d.report_date
      AND newer.daily_id > d.daily_id);

-- The ledger as financial readers see it: current money entries (a change
-- entry is not money, D36), with a month of Mediavine daily estimates standing
-- in for an imported estimate that covers less. Same rules as
-- db/migrations/0034's view, reading coverage from ledger_entries.coverage_end
-- instead of parsing the note (ro-ujb9.72).
-- Rebuildable: never imported, and its synthetic negative ids are never
-- booked as entries. entry_number is what readers show (see "Numbers a
-- workspace hands out"); a month of daily estimates shows minus its first
-- daily number, as D1 showed minus its first daily id.
CREATE VIEW noticeos.financial_ledger WITH (security_invoker = true) AS
WITH RECURSIVE mediavine_lineage (workspace_id, asset_id, period_month, entry_id) AS (
  SELECT workspace_id, asset_id, period_month, entry_id FROM noticeos.ledger_entries
   WHERE kind = 'revenue' AND family = 'ads' AND source IN ('mediavine-journey','mediavine')
  UNION
  SELECT origin.workspace_id, origin.asset_id, origin.period_month, l.entry_id
    FROM noticeos.ledger_entries l
    JOIN mediavine_lineage origin
      ON l.workspace_id = origin.workspace_id AND l.supersedes_id = origin.entry_id
), current_ledger AS (
  SELECT l.* FROM noticeos.ledger_entries l
   WHERE l.kind IN ('revenue','cost')
     AND NOT EXISTS (SELECT 1 FROM noticeos.ledger_entries s
                      WHERE s.workspace_id = l.workspace_id AND s.supersedes_id = l.entry_id)
), daily_months AS (
  SELECT workspace_id, asset_id, date_trunc('month', report_date)::date AS period_month,
         SUM(amount_minor)::bigint AS amount_minor, MIN(daily_id) AS first_id,
         MIN(daily_number) AS first_number, MIN(report_date) AS first_date, MAX(report_date) AS last_date,
         COUNT(*) AS days, MAX(recorded_at) AS recorded_at
    FROM noticeos.mediavine_current_daily
   GROUP BY workspace_id, asset_id, date_trunc('month', report_date)
), usable_months AS (
  SELECT d.* FROM daily_months d
   WHERE NOT EXISTS (
     SELECT 1 FROM current_ledger l
       JOIN mediavine_lineage origin ON origin.workspace_id = l.workspace_id AND origin.entry_id = l.entry_id
      WHERE origin.workspace_id = d.workspace_id AND origin.asset_id = d.asset_id
        AND origin.period_month = d.period_month AND l.booking_state = 'reconciled')
     AND NOT EXISTS (
     SELECT 1 FROM current_ledger l
      WHERE l.workspace_id = d.workspace_id AND l.asset_id = d.asset_id
        AND l.period_month = d.period_month AND l.kind = 'revenue' AND l.family = 'ads'
        AND l.source IN ('mediavine-journey','mediavine')
        AND (l.booking_state = 'reconciled'
             OR d.first_date <> d.period_month
             OR d.days <> extract(day FROM d.last_date)
             OR d.last_date < COALESCE(l.coverage_end, (d.period_month + interval '1 month' - interval '1 day')::date)))
)
SELECT l.workspace_id, l.entry_id, l.entry_number, l.kind, l.asset_id, l.period_month, l.family, l.amount_minor,
       l.currency, l.source, l.ref, l.booking_state, l.supersedes_id, l.note, l.recorded_at, l.external_id
  FROM current_ledger l
 WHERE NOT (l.kind = 'revenue' AND l.family = 'ads' AND l.booking_state = 'estimated'
            AND COALESCE(l.source, '') IN ('mediavine-journey','mediavine')
            AND EXISTS (SELECT 1 FROM usable_months d
                         WHERE d.workspace_id = l.workspace_id AND d.asset_id = l.asset_id
                           AND d.period_month = l.period_month))
UNION ALL
SELECT workspace_id, -first_id, -first_number, 'revenue', asset_id, period_month, 'ads', amount_minor,
       'USD'::char(3), 'mediavine-journey', NULL, 'estimated', NULL,
       'Mediavine daily estimates: ' || first_date || '..' || last_date || ' (' || days || ' days)',
       recorded_at, 'mediavine:daily/' || asset_id || '/' || to_char(period_month, 'YYYY-MM')
  FROM usable_months;

-- ─── Connections, settings and their history ─────────────────────────────────

-- A connected account at a provider. One per provider for now, as today (D21);
-- the connection, not the provider, is what a secret and a lease belong to.
-- Everything here is in the clear on purpose: a card whose bootstrap key is
-- gone still says whose account it is, when it expires, what it last proved,
-- and can be disconnected (workers/ingest/src/credentials.ts).
CREATE TABLE noticeos.integration_connections (
  workspace_id    uuid NOT NULL REFERENCES noticeos.workspaces,
  connection_id   uuid NOT NULL DEFAULT gen_random_uuid(),
  provider        text NOT NULL,
  scope           text NOT NULL CHECK (scope IN ('shared','per-asset')),
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  last_used_at    timestamptz,
  last_ok_at      timestamptz,
  last_error      text,
  -- Whose account a sign-in is, the scopes it granted and when (OAuth only).
  account         text,
  scopes          jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(scopes) = 'array'),
  connected_at    timestamptz,
  -- When the credential stops working, and who said so. 'operator' with no
  -- date is the operator's answer that it does not expire.
  expires_at      timestamptz,
  expiry_source   text CHECK (expiry_source IN ('flow','operator')),
  -- A prepaid account's credit in US dollars, exact to six decimals as
  -- provider prices are, only ever with the instant it was seen. numeric
  -- refuses infinity at this precision but holds NaN, which is no balance.
  balance_usd     numeric(14,6) CHECK (balance_usd <> 'NaN'),
  balance_seen_at timestamptz,
  PRIMARY KEY (workspace_id, connection_id),
  UNIQUE (workspace_id, provider),
  CHECK ((balance_usd IS NULL) = (balance_seen_at IS NULL))
);

-- The sealed secret of a connection. A rotation writes the next version and
-- removes the old one; a disconnect removes them all. Superseded ciphertext is
-- never kept (db/README.md `credentials`).
CREATE TABLE noticeos.connection_secrets (
  workspace_id   uuid NOT NULL REFERENCES noticeos.workspaces,
  connection_id  uuid NOT NULL,
  secret_version integer NOT NULL CHECK (secret_version >= 1),
  ciphertext     bytea NOT NULL,
  iv             bytea NOT NULL CHECK (octet_length(iv) = 12),
  key_version    integer NOT NULL CHECK (key_version >= 1),
  -- Field NAMES only, never values.
  field_names    jsonb NOT NULL CHECK (jsonb_typeof(field_names) = 'array'),
  -- The site ids a per-site key map holds a key for: ids only, never a key.
  asset_ids      jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(asset_ids) = 'array'),
  created_at     timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, connection_id, secret_version),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES noticeos.integration_connections ON DELETE CASCADE
);

CREATE TABLE noticeos.integration_leases (
  workspace_id     uuid NOT NULL REFERENCES noticeos.workspaces,
  lease_key        text NOT NULL CHECK (lease_key <> ''),
  owner            text NOT NULL CHECK (owner <> ''),
  expires_at       timestamptz NOT NULL,
  cooldown_until   timestamptz,
  sites            jsonb,
  sites_checked_at timestamptz,
  auth_blocked     boolean NOT NULL DEFAULT false,
  last_error       text,
  PRIMARY KEY (workspace_id, lease_key)
);

-- What a monitored capability is about: one row per provider, connection
-- revision, capability, site, target and report family. State and events
-- refer to it by target_seq instead of repeating (and indexing) the seven
-- text columns on every row.
CREATE TABLE noticeos.capability_targets (
  workspace_id        uuid NOT NULL REFERENCES noticeos.workspaces,
  target_seq          bigint GENERATED ALWAYS AS IDENTITY,
  provider            text NOT NULL CHECK (provider <> ''),
  connection_revision text NOT NULL,
  capability          text NOT NULL CHECK (capability <> ''),
  -- NULL: the capability belongs to the account, not one site. One value in
  -- the unique key below, so the account's target is one row.
  asset_id            text,
  target_id           text NOT NULL,
  family              text NOT NULL DEFAULT '',
  PRIMARY KEY (workspace_id, target_seq),
  UNIQUE NULLS NOT DISTINCT (workspace_id, provider, connection_revision, capability, asset_id, target_id, family),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES noticeos.assets
);

-- The latest attempt's outcome per target, rewritten in place.
CREATE TABLE noticeos.integration_capability_state (
  workspace_id             uuid NOT NULL REFERENCES noticeos.workspaces,
  target_seq               bigint NOT NULL,
  attempt_id               text NOT NULL,
  started_at               timestamptz NOT NULL,
  finished_at              timestamptz NOT NULL CHECK (finished_at >= started_at),
  outcome                  text NOT NULL CHECK (outcome IN ('success','failure')),
  failure_kind             text CHECK (failure_kind IN ('access','rate-limit','budget','network','provider','invalid-report','incomplete-report','configuration','monitoring')),
  safe_code                text,
  next_attempt_at          timestamptz,
  last_success_started_at  timestamptz,
  last_success_finished_at timestamptz,
  evidence_source          text NOT NULL,
  evidence_id              text NOT NULL,
  CHECK ((outcome = 'success' AND failure_kind IS NULL AND safe_code IS NULL)
      OR (outcome = 'failure' AND failure_kind IS NOT NULL AND safe_code IS NOT NULL)),
  CHECK ((last_success_started_at IS NULL AND last_success_finished_at IS NULL)
      OR (last_success_started_at IS NOT NULL AND last_success_finished_at IS NOT NULL
          AND last_success_finished_at >= last_success_started_at)),
  PRIMARY KEY (workspace_id, target_seq),
  FOREIGN KEY (workspace_id, target_seq) REFERENCES noticeos.capability_targets
);
CREATE INDEX integration_capability_state_attention ON noticeos.integration_capability_state (workspace_id, outcome, finished_at);

CREATE TABLE noticeos.integration_health_events (
  workspace_id    uuid NOT NULL REFERENCES noticeos.workspaces,
  event_id        text NOT NULL CHECK (event_id <> ''),
  target_seq      bigint NOT NULL,
  attempt_id      text NOT NULL,
  started_at      timestamptz NOT NULL,
  recorded_at     timestamptz NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('failed','changed','recovered')),
  failure_kind    text CHECK (failure_kind IN ('access','rate-limit','budget','network','provider','invalid-report','incomplete-report','configuration','monitoring')),
  safe_code       text,
  evidence_source text NOT NULL,
  evidence_id     text NOT NULL,
  CHECK ((kind = 'recovered' AND failure_kind IS NULL AND safe_code IS NULL)
      OR (kind <> 'recovered' AND failure_kind IS NOT NULL AND safe_code IS NOT NULL)),
  PRIMARY KEY (workspace_id, event_id),
  FOREIGN KEY (workspace_id, target_seq) REFERENCES noticeos.capability_targets
);
CREATE INDEX integration_health_events_target ON noticeos.integration_health_events (workspace_id, target_seq, started_at);
-- The newest transitions first: the Wall's feed and the health read's recent
-- events (D1 read its newest rows by rowid, which Postgres does not keep).
CREATE INDEX integration_health_events_recorded ON noticeos.integration_health_events (workspace_id, recorded_at);

-- One settings document per concept ('tower', 'constants', ...), kept as the
-- exact text the export writes. An object, or a list for a register that is
-- one (config/pull.json).
CREATE TABLE noticeos.config_documents (
  workspace_id uuid NOT NULL REFERENCES noticeos.workspaces,
  document_key text NOT NULL CHECK (document_key ~ '^[a-z0-9][a-z0-9-]*$'),
  body         json NOT NULL CHECK (json_typeof(body) IN ('object', 'array')),
  version      integer NOT NULL CHECK (version >= 1),
  updated_at   timestamptz NOT NULL,
  updated_by   text,
  PRIMARY KEY (workspace_id, document_key)
);

-- No foreign key to the document: a change outlives a document dropped from
-- the register set.
CREATE TABLE noticeos.config_changes (
  workspace_id   uuid NOT NULL REFERENCES noticeos.workspaces,
  change_id      bigint GENERATED ALWAYS AS IDENTITY,
  change_number  bigint NOT NULL CHECK (change_number >= 1), -- what readers show; see "Numbers a workspace hands out"
  -- The same key grammar as config_documents; no link, see above.
  document_key   text NOT NULL CHECK (document_key ~ '^[a-z0-9][a-z0-9-]*$'),
  ops            jsonb NOT NULL CHECK (jsonb_typeof(ops) = 'array'),
  reason         text,
  actor          text NOT NULL CHECK (actor <> ''),
  version_before integer NOT NULL CHECK (version_before >= 0),
  version_after  integer NOT NULL CHECK (version_after > version_before),
  changed_at     timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, change_id),
  UNIQUE (workspace_id, change_number)
);
CREATE INDEX config_changes_document ON noticeos.config_changes (workspace_id, document_key, changed_at DESC);

CREATE TABLE noticeos.notifications (
  workspace_id    uuid NOT NULL REFERENCES noticeos.workspaces,
  notification_id bigint GENERATED ALWAYS AS IDENTITY,
  channel         text NOT NULL CHECK (channel <> ''),
  subject         text NOT NULL CHECK (subject IN ('alert','data-source')),
  subject_ref     text NOT NULL CHECK (subject_ref <> ''),
  -- '' for an alert, whose id is already one firing; for a data source, the
  -- failing call's time. Part of the dedupe key, so never NULL.
  occurrence      text NOT NULL,
  condition       text NOT NULL CHECK (condition <> ''),
  sent_at         timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, notification_id),
  UNIQUE (workspace_id, channel, subject, subject_ref, occurrence)
);
CREATE INDEX notifications_subject ON noticeos.notifications (workspace_id, subject, subject_ref);

-- ─── The installation's own machinery, per workspace ─────────────────────────

CREATE TABLE noticeos.job_runs (
  workspace_id   uuid NOT NULL REFERENCES noticeos.workspaces,
  job_run_id     bigint GENERATED ALWAYS AS IDENTITY,
  job_run_number bigint NOT NULL CHECK (job_run_number >= 1), -- what readers show; see "Numbers a workspace hands out"
  job            text NOT NULL CHECK (job <> ''),
  scheduled_at   timestamptz,
  started_at     timestamptz NOT NULL,
  finished_at    timestamptz NOT NULL,
  outcome        text NOT NULL CHECK (outcome IN ('ran','skipped','failed')),
  detail         text,
  recorded_at    timestamptz NOT NULL,
  CHECK (finished_at >= started_at),
  PRIMARY KEY (workspace_id, job_run_id),
  UNIQUE (workspace_id, job_run_number),
  UNIQUE (workspace_id, job, started_at)
);
CREATE INDEX job_runs_started ON noticeos.job_runs (workspace_id, started_at);

CREATE TABLE noticeos.egress_checks (
  workspace_id    uuid NOT NULL REFERENCES noticeos.workspaces,
  egress_check_id bigint GENERATED ALWAYS AS IDENTITY,
  observed_at     timestamptz NOT NULL,
  up              boolean NOT NULL,
  detail          jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(detail) = 'object'),
  PRIMARY KEY (workspace_id, egress_check_id)
);
CREATE INDEX egress_checks_observed ON noticeos.egress_checks (workspace_id, observed_at);

-- ─── Task-source mirrors (the task hub stays the authority, D32) ────────────

CREATE TABLE noticeos.task_snapshots (
  workspace_id uuid NOT NULL REFERENCES noticeos.workspaces,
  snapshot_id  bigint GENERATED ALWAYS AS IDENTITY,
  captured_at  timestamptz NOT NULL,
  payload      jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  PRIMARY KEY (workspace_id, snapshot_id)
);
CREATE INDEX task_snapshots_captured ON noticeos.task_snapshots (workspace_id, captured_at DESC);

-- `project` is the task source's own project name; no foreign key, because a
-- task is coordination state and not a fact about a site (doc 01).
CREATE TABLE noticeos.task_daily_counts (
  workspace_id uuid NOT NULL REFERENCES noticeos.workspaces,
  project      text NOT NULL CHECK (project <> ''),
  day          date NOT NULL,
  captured_at  timestamptz NOT NULL,
  waiting      integer CHECK (waiting >= 0),
  urgent       integer CHECK (urgent >= 0),
  open         integer NOT NULL CHECK (open >= 0),
  in_progress  integer NOT NULL CHECK (in_progress >= 0),
  blocked      integer NOT NULL CHECK (blocked >= 0),
  closed_ids   jsonb CHECK (closed_ids IS NULL OR jsonb_typeof(closed_ids) = 'array'),
  PRIMARY KEY (workspace_id, project, day)
);
CREATE INDEX task_daily_counts_day ON noticeos.task_daily_counts (workspace_id, day);

-- ─── Dated summaries the Tower draws ────────────────────────────────────────

CREATE TABLE noticeos.connection_daily_counts (
  workspace_id       uuid NOT NULL REFERENCES noticeos.workspaces,
  source             text NOT NULL CHECK (source <> ''),
  day                date NOT NULL,
  observed_at        timestamptz NOT NULL,
  live               integer NOT NULL CHECK (live >= 0),
  degraded           integer NOT NULL CHECK (degraded >= 0),
  needs_setup        integer NOT NULL CHECK (needs_setup >= 0),
  skipped            integer NOT NULL CHECK (skipped >= 0),
  not_applicable     integer NOT NULL CHECK (not_applicable >= 0),
  newest_evidence_at timestamptz,
  PRIMARY KEY (workspace_id, source, day)
);
CREATE INDEX connection_daily_counts_day ON noticeos.connection_daily_counts (workspace_id, day);

-- System health's four connection counts, one row per day (D1 db/0039).
CREATE TABLE noticeos.connection_status_daily_counts (
  workspace_id    uuid NOT NULL REFERENCES noticeos.workspaces,
  day             date NOT NULL,
  observed_at     timestamptz NOT NULL,
  sites_failing   integer NOT NULL CHECK (sites_failing >= 0),
  sites_overdue   integer NOT NULL CHECK (sites_overdue >= 0),
  reports_missing integer NOT NULL CHECK (reports_missing >= 0),
  sites_working   integer NOT NULL CHECK (sites_working >= 0),
  PRIMARY KEY (workspace_id, day)
);

-- asset_id NULL is the whole-workspace row (the legacy '*').
CREATE TABLE noticeos.alert_daily_counts (
  workspace_id          uuid NOT NULL REFERENCES noticeos.workspaces,
  asset_id              text,
  day                   date NOT NULL,
  observed_at           timestamptz NOT NULL,
  open                  integer NOT NULL CHECK (open >= 0),
  errors                integer NOT NULL CHECK (errors >= 0),
  warnings              integer NOT NULL CHECK (warnings >= 0),
  -- NULL when nothing was open: the median of an empty set is not zero.
  median_open_age_hours double precision CHECK (median_open_age_hours IS NULL
                                                 OR (median_open_age_hours NOT IN ('NaN', 'Infinity', '-Infinity') AND median_open_age_hours >= 0)),
  CHECK (errors + warnings <= open),
  UNIQUE NULLS NOT DISTINCT (workspace_id, asset_id, day),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES noticeos.assets
);
CREATE INDEX alert_daily_counts_day ON noticeos.alert_daily_counts (workspace_id, day);

-- ─── Numbers a workspace hands out ─────────────────────────────────────────
--
-- The bigint identities above are the store's own keys: one sequence per
-- table, shared by every workspace, so a customer who saw alert 1000 and then
-- alert 1030 would learn that 29 alerts fired somewhere else (REVIEW.md
-- "Sequential ids leak activity across tenants", bead ro-ujb9.76.21). So each
-- table whose rows people and other systems name — in the API, the Wall's
-- feed, task-hub labels and the MCP answers — also carries a number of its own
-- workspace: flag_number, pulse_number, annotation_number, entry_number,
-- target_number, research_number, change_number, job_run_number,
-- reading_number and daily_number. Each counts 1, 2, 3 … within one
-- workspace, is unique there, and is never handed out twice. Readers show that
-- number and never the identity; links between rows keep using the identity.
--
-- One mechanism hands them all out: a counter row per workspace and number,
-- advanced by the trigger below inside the inserting transaction. The row lock
-- that takes holds a second writer of the same workspace's same number until
-- the first commits or rolls back, so two transactions never get one number,
-- and a rolled-back or refused insert gives its number back. Another
-- workspace's counter is another row: it neither waits nor counts. (A sequence
-- per workspace would be a schema object per customer, created at signup, and
-- would skip numbers on every rollback.)
--
-- The same counter hands a new site its place in the list of sites,
-- assets.list_position (bead ro-ujb9.76.52): the next place, at the end, and
-- two sites added at once never share one. A place, unlike a number, can
-- change later: a move deals the places of the sites it spans out again,
-- never a new one, so the counter still stands past every place.
CREATE TABLE noticeos.workspace_counters (
  workspace_id uuid NOT NULL REFERENCES noticeos.workspaces,
  -- The column it serves: flag_number, pulse_number, … and list_position.
  counter      text NOT NULL CHECK (counter ~ '^[a-z][a-z_]*_(number|position)$'),
  -- The last number handed out. It never moves back (the trigger below), so
  -- a number whose row left under retention is still never reused.
  last_number  bigint NOT NULL CHECK (last_number >= 1),
  PRIMARY KEY (workspace_id, counter)
);

-- TG_ARGV[0]: the number column. A row that arrives without a number gets the
-- workspace's next one. Only the owner may bring its own — the importer
-- keeping the ids a legacy single-workspace store handed out, so every link
-- and task label still resolves (mapping.json `conversions`) — and the
-- counter then moves past it, so nothing handed out later collides. An insert
-- that ON CONFLICT finds its row already there has still used a number: the
-- workspace's numbers may skip, never another workspace's way.
CREATE FUNCTION noticeos.number_in_workspace() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  brought  bigint;
  assigned bigint;
BEGIN
  EXECUTE format('SELECT ($1).%I', TG_ARGV[0]) INTO brought USING NEW;
  IF brought IS NOT NULL AND NOT pg_has_role('noticeos_owner', 'MEMBER') THEN
    RAISE EXCEPTION '%.%: the store hands out this number; only the importer brings its own', TG_TABLE_NAME, TG_ARGV[0]
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO noticeos.workspace_counters AS c (workspace_id, counter, last_number)
  VALUES (NEW.workspace_id, TG_ARGV[0], coalesce(brought, 1))
  ON CONFLICT (workspace_id, counter) DO UPDATE
     SET last_number = CASE WHEN brought IS NULL THEN c.last_number + 1 ELSE greatest(c.last_number, brought) END
  RETURNING c.last_number INTO assigned;
  IF brought IS NULL THEN
    NEW := jsonb_populate_record(NEW, jsonb_build_object(TG_ARGV[0], assigned));
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER number_in_workspace BEFORE INSERT ON noticeos.assets
  FOR EACH ROW EXECUTE FUNCTION noticeos.number_in_workspace('list_position');
CREATE TRIGGER number_in_workspace BEFORE INSERT ON noticeos.pulses
  FOR EACH ROW EXECUTE FUNCTION noticeos.number_in_workspace('pulse_number');
CREATE TRIGGER number_in_workspace BEFORE INSERT ON noticeos.flags
  FOR EACH ROW EXECUTE FUNCTION noticeos.number_in_workspace('flag_number');
CREATE TRIGGER number_in_workspace BEFORE INSERT ON noticeos.annotations
  FOR EACH ROW EXECUTE FUNCTION noticeos.number_in_workspace('annotation_number');
CREATE TRIGGER number_in_workspace BEFORE INSERT ON noticeos.research_log
  FOR EACH ROW EXECUTE FUNCTION noticeos.number_in_workspace('research_number');
CREATE TRIGGER number_in_workspace BEFORE INSERT ON noticeos.hygiene_checks
  FOR EACH ROW EXECUTE FUNCTION noticeos.number_in_workspace('reading_number');
CREATE TRIGGER number_in_workspace BEFORE INSERT ON noticeos.reclamation_targets
  FOR EACH ROW EXECUTE FUNCTION noticeos.number_in_workspace('target_number');
CREATE TRIGGER number_in_workspace BEFORE INSERT ON noticeos.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION noticeos.number_in_workspace('entry_number');
CREATE TRIGGER number_in_workspace BEFORE INSERT ON noticeos.mediavine_daily
  FOR EACH ROW EXECUTE FUNCTION noticeos.number_in_workspace('daily_number');
CREATE TRIGGER number_in_workspace BEFORE INSERT ON noticeos.config_changes
  FOR EACH ROW EXECUTE FUNCTION noticeos.number_in_workspace('change_number');
CREATE TRIGGER number_in_workspace BEFORE INSERT ON noticeos.job_runs
  FOR EACH ROW EXECUTE FUNCTION noticeos.number_in_workspace('job_run_number');

-- A counter never moves back, whoever writes it: a number once handed out is
-- never handed out again.
CREATE FUNCTION noticeos.workspace_counter_never_moves_back() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.last_number < OLD.last_number THEN
    RAISE EXCEPTION 'workspace_counters: % stands at %; a number once handed out is never handed out again',
      OLD.counter, OLD.last_number
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workspace_counter_never_moves_back BEFORE UPDATE ON noticeos.workspace_counters
  FOR EACH ROW EXECUTE FUNCTION noticeos.workspace_counter_never_moves_back();

-- ─── History past its window moves to the analytical store ─────────────────
--
-- D25 makes Parquet read with DuckDB the home of history; the operational
-- store keeps what the Tower reads live (mapping.json `retention`). A history
-- row past its window leaves Postgres only after the analytical store holds
-- it: the export job (ro-ujb9.67, run as noticeos_maint) records, per
-- workspace and table, the last day its dataset covers, and the trigger below
-- refuses to remove a row inside its window or after that day. Its arguments
-- — the day column and the window — are the same ones mapping.json states;
-- scripts/postgres-model.test.mjs compares the two.
CREATE TABLE noticeos.analytical_exports (
  workspace_id     uuid NOT NULL REFERENCES noticeos.workspaces,
  table_name       text NOT NULL CHECK (table_name ~ '^[a-z_]+$'),
  -- Every row of the table dated on or before this day is in the dataset.
  exported_through date NOT NULL,
  dataset_key      text NOT NULL CHECK (dataset_key <> ''),
  exported_at      timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, table_name, exported_through)
);

-- TG_ARGV[0]: the column that dates a row (a date, or an instant read as its
-- UTC day); TG_ARGV[1]: the window the store keeps, as an interval.
CREATE FUNCTION noticeos.history_leaves_only_when_exported() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  stamp text := to_jsonb(OLD) ->> TG_ARGV[0];
  day   date := CASE WHEN length(stamp) = 10 THEN stamp::date
                     ELSE (stamp::timestamptz AT TIME ZONE 'UTC')::date END;
BEGIN
  IF day > (now() AT TIME ZONE 'UTC')::date - TG_ARGV[1]::interval THEN
    RAISE EXCEPTION '%: a row from % is inside the % the store keeps', TG_TABLE_NAME, day, TG_ARGV[1]
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM noticeos.analytical_exports e
     WHERE e.workspace_id = OLD.workspace_id AND e.table_name = TG_TABLE_NAME AND e.exported_through >= day
  ) THEN
    RAISE EXCEPTION '%: record the export that covers % before removing its rows', TG_TABLE_NAME, day
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER history_leaves_only_when_exported BEFORE DELETE ON noticeos.signal_observations
  FOR EACH ROW EXECUTE FUNCTION noticeos.history_leaves_only_when_exported('observed_date', '13 months');
CREATE TRIGGER history_leaves_only_when_exported BEFORE DELETE ON noticeos.signal_runs
  FOR EACH ROW EXECUTE FUNCTION noticeos.history_leaves_only_when_exported('finished_at', '13 months');
CREATE TRIGGER history_leaves_only_when_exported BEFORE DELETE ON noticeos.archive_runs
  FOR EACH ROW EXECUTE FUNCTION noticeos.history_leaves_only_when_exported('finished_at', '13 months');
CREATE TRIGGER history_leaves_only_when_exported BEFORE DELETE ON noticeos.archive_objects
  FOR EACH ROW EXECUTE FUNCTION noticeos.history_leaves_only_when_exported('first_stored_at', '13 months');
CREATE TRIGGER history_leaves_only_when_exported BEFORE DELETE ON noticeos.hygiene_checks
  FOR EACH ROW EXECUTE FUNCTION noticeos.history_leaves_only_when_exported('observed_on', '13 months');
CREATE TRIGGER history_leaves_only_when_exported BEFORE DELETE ON noticeos.egress_checks
  FOR EACH ROW EXECUTE FUNCTION noticeos.history_leaves_only_when_exported('observed_at', '13 months');

-- ─── Row security on every table ─────────────────────────────────────────────
--
-- One rule, applied to every table in the schema: a transaction sees and
-- writes only the workspace it named. FORCE makes the owner obey it too.
-- `workspaces` is keyed on its own id.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'noticeos' AND c.relkind = 'r'
  LOOP
    EXECUTE format('ALTER TABLE noticeos.%I ENABLE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('ALTER TABLE noticeos.%I FORCE ROW LEVEL SECURITY', t.relname);
    EXECUTE format(
      'CREATE POLICY workspace_isolation ON noticeos.%I
         USING (workspace_id = noticeos.current_workspace_id())
         WITH CHECK (workspace_id = noticeos.current_workspace_id())',
      t.relname);
  END LOOP;
END $$;

-- ─── The installation's only workspace ──────────────────────────────────────
--
-- A self-hosted installation has exactly one workspace, created once by its
-- bootstrap (D27). The Workers and scripts ask the store for it
-- (store.onlyWorkspace() in packages/postgres) rather than carry its id in a
-- file or a binding (D30). The application cannot list workspaces itself: a
-- transaction that names none sees none. So this function runs with its
-- owner's rights and answers one thing: the id while exactly one workspace
-- exists, NULL while there are none or several (a hosted installation names
-- each request's workspace). Forced row security binds its owner too, so the
-- owner reads the list through one read-only policy; it still changes only
-- the workspace its transaction names, and sees only that one's rows in every
-- other table.
CREATE POLICY owner_lists_workspaces ON noticeos.workspaces FOR SELECT TO noticeos_owner USING (true);

CREATE FUNCTION noticeos.only_workspace() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE WHEN count(*) = 1 THEN (array_agg(w.workspace_id))[1] END
    FROM (SELECT workspace_id FROM noticeos.workspaces LIMIT 2) w
$$;
REVOKE EXECUTE ON FUNCTION noticeos.only_workspace() FROM PUBLIC;

-- ─── What the application may do: mapping.json's revision rules ─────────────

GRANT USAGE ON SCHEMA noticeos, noticeos_ref TO noticeos_app;
GRANT EXECUTE ON FUNCTION noticeos.current_workspace_id() TO noticeos_app;
GRANT EXECUTE ON FUNCTION noticeos.only_workspace() TO noticeos_app;
GRANT SELECT ON ALL TABLES IN SCHEMA noticeos TO noticeos_app;
-- The shared vocabulary: read, never written, by the application.
GRANT SELECT ON ALL TABLES IN SCHEMA noticeos_ref TO noticeos_app;

-- Append-only: insert, never change, never remove.
GRANT INSERT ON
  noticeos.annotations, noticeos.archive_objects, noticeos.archive_runs,
  noticeos.asset_insight_snapshots, noticeos.capability_targets, noticeos.config_changes, noticeos.egress_checks,
  noticeos.flag_evidence, noticeos.flag_tunes, noticeos.integration_health_events,
  noticeos.ledger_entries, noticeos.measurement_series, noticeos.mediavine_daily,
  noticeos.mediavine_runs, noticeos.notifications, noticeos.pulses, noticeos.research_log,
  noticeos.signal_observations, noticeos.signal_runs, noticeos.watch_window_readings
TO noticeos_app;

-- Sanctioned mutations: named columns only (db/README.md, per table).
-- A site is never deleted by the application: history references it, and
-- "retired" is its only exit. Its place in the list moves with a move.
GRANT INSERT ON noticeos.assets TO noticeos_app;
GRANT UPDATE (status, sense_only, display_name, list_position, updated_at) ON noticeos.assets TO noticeos_app;
GRANT INSERT ON noticeos.flags TO noticeos_app;
GRANT UPDATE (disposition, disposition_at, disposition_note, snooze_until, ack_expiry,
              hypothesis_ref, incident_ref, resolved_at, replaced_by_pulse_id) ON noticeos.flags TO noticeos_app;
GRANT INSERT ON noticeos.watch_windows TO noticeos_app;
GRANT UPDATE (status, outcome, closed_at, outcome_note, last_checked_at, readback_bead,
              readback_posted_at) ON noticeos.watch_windows TO noticeos_app;
GRANT INSERT ON noticeos.reclamation_targets TO noticeos_app;
GRANT UPDATE (status, status_at, outcome_note, last_verified_at, updated_at)
  ON noticeos.reclamation_targets TO noticeos_app;
GRANT INSERT ON noticeos.hygiene_checks TO noticeos_app;
GRANT UPDATE (observed_at, status, value_num, detail) ON noticeos.hygiene_checks TO noticeos_app;
GRANT INSERT, DELETE ON noticeos.item_dispositions TO noticeos_app;
GRANT UPDATE (status, updated_at, note) ON noticeos.item_dispositions TO noticeos_app;
GRANT INSERT ON noticeos.config_documents TO noticeos_app;
GRANT UPDATE (body, version, updated_at, updated_by) ON noticeos.config_documents TO noticeos_app;
GRANT INSERT, DELETE ON noticeos.integration_connections TO noticeos_app;
GRANT UPDATE (scope, updated_at, last_used_at, last_ok_at, last_error, account, scopes, connected_at,
              expires_at, expiry_source, balance_usd, balance_seen_at)
  ON noticeos.integration_connections TO noticeos_app;
GRANT INSERT, DELETE ON noticeos.connection_secrets TO noticeos_app;
GRANT INSERT, DELETE ON noticeos.mediavine_sites TO noticeos_app;

-- Current state: one row per thing, rewritten in place.
GRANT INSERT, UPDATE ON noticeos.counter_readings, noticeos.integration_capability_state TO noticeos_app;
-- The numbering trigger runs with the inserting role's rights: it starts a
-- workspace's counter and advances it, and the counter never moves back.
GRANT INSERT ON noticeos.workspace_counters TO noticeos_app;
GRANT UPDATE (last_number) ON noticeos.workspace_counters TO noticeos_app;
GRANT INSERT, UPDATE, DELETE ON noticeos.integration_leases, noticeos.mediavine_state TO noticeos_app;

-- Caches and dated summaries: swept by their retention rule. A dated summary
-- is one row per day, upserted; a photograph is re-stamped while the board is
-- unchanged, and cut to what is still read once a newer one replaces it; a
-- firing record is written once.
GRANT INSERT, UPDATE, DELETE ON
  noticeos.task_daily_counts, noticeos.connection_daily_counts, noticeos.connection_status_daily_counts,
  noticeos.alert_daily_counts
TO noticeos_app;
GRANT INSERT, DELETE ON noticeos.task_snapshots, noticeos.job_runs TO noticeos_app;
GRANT UPDATE (captured_at, payload) ON noticeos.task_snapshots TO noticeos_app;

-- ─── What maintenance may do: mapping.json `maintenance` ────────────────────
--
-- noticeos_maint spans workspaces (row security does not bind it), so it gets
-- the least: it reads everything (the capacity readback, the importer's
-- pre-flight, the rehearsal's counts), removes only what a retention rule lets
-- go — and the triggers above still refuse history not yet exported and a
-- site's two newest insight snapshots — and records moves and exports. It updates
-- nothing, owns nothing and creates nothing. A job that works one workspace at
-- a time runs as noticeos_app and names it with SET LOCAL instead.
GRANT USAGE ON SCHEMA noticeos, noticeos_ref TO noticeos_maint;
GRANT SELECT ON ALL TABLES IN SCHEMA noticeos TO noticeos_maint;
GRANT SELECT ON ALL TABLES IN SCHEMA noticeos_ref TO noticeos_maint;
GRANT DELETE ON
  noticeos.signal_observations, noticeos.signal_runs, noticeos.archive_runs, noticeos.archive_objects,
  noticeos.hygiene_checks, noticeos.egress_checks, noticeos.asset_insight_snapshots, noticeos.job_runs,
  noticeos.task_snapshots, noticeos.task_daily_counts, noticeos.connection_daily_counts,
  noticeos.connection_status_daily_counts, noticeos.alert_daily_counts
TO noticeos_maint;
GRANT INSERT ON noticeos.analytical_exports, noticeos.asset_insight_snapshot_moves TO noticeos_maint;
