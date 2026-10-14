-- One revenue ledger for every source. A revenue source is shared vocabulary,
-- like an integration: its name, the provider whose connection reports it,
-- its revenue family and the clock its days are counted on. Every collector
-- writes what its source reported into revenue_observations, a day's total or
-- one sale per row, and financial_ledger reads a month from it the same way
-- for every source. Adding a source is an INSERT here, shipped with the
-- collector that speaks to it.

CREATE TABLE noticeos_ref.revenue_sources (
  source             text PRIMARY KEY CHECK (source ~ '^[a-z0-9][a-z0-9-]*$'),
  -- The connected provider that reports it, as integration_connections names it.
  provider           text NOT NULL CHECK (provider ~ '^[a-z0-9][a-z0-9-]*$'),
  family             text NOT NULL CHECK (family IN ('ads','affiliate','subs','licensing')),
  display_name       text NOT NULL CHECK (length(display_name) >= 1),
  -- The day a figure is reported for is a day on this clock: its zone, the
  -- name people read for it, and the minute after midnight there from which
  -- yesterday's report is complete. A fact about the source, never the
  -- installation's clock.
  time_zone          text NOT NULL CHECK (length(time_zone) >= 1),
  time_zone_label    text NOT NULL CHECK (length(time_zone_label) >= 1),
  ready_after_minute integer NOT NULL CHECK (ready_after_minute BETWEEN 0 AND 1439)
);

INSERT INTO noticeos_ref.revenue_sources (source, provider, family, display_name, time_zone, time_zone_label, ready_after_minute) VALUES
  ('mediavine-journey', 'mediavine', 'ads', 'Mediavine Journey ad revenue', 'America/Los_Angeles', 'Pacific', 370),
  ('mediavine', 'mediavine', 'ads', 'Mediavine ad revenue', 'America/Los_Angeles', 'Pacific', 370);

-- A figure a source reported for a site: the account's total for a day, or
-- one sale or refund on that day. A source that reports a figure again writes
-- a new row; the newest per (site, source, account, day, item) is current
-- (current_revenue). Rows are history: never changed, never removed.
CREATE TABLE noticeos.revenue_observations (
  workspace_id       uuid NOT NULL REFERENCES noticeos.workspaces,
  observation_id     bigint GENERATED ALWAYS AS IDENTITY,
  observation_number bigint NOT NULL CHECK (observation_number >= 1), -- what readers show; see "Numbers a workspace hands out"
  asset_id           text NOT NULL,
  source             text NOT NULL REFERENCES noticeos_ref.revenue_sources,
  -- Where the source earned it, by the source's own id: a Mediavine site, an
  -- app, a storefront.
  account_ref        text NOT NULL CHECK (account_ref <> ''),
  -- The day it is reported for, on the source's clock.
  revenue_date       date NOT NULL,
  -- One sale or refund, by the source's own id; NULL is the account's total
  -- for the day.
  item_ref           text CHECK (item_ref <> ''),
  amount_minor       bigint NOT NULL,
  currency           char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- The collection that reported it, by the collector's own run id.
  run_ref            text NOT NULL CHECK (run_ref <> ''),
  recorded_at        timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, observation_id),
  UNIQUE (workspace_id, observation_number),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES noticeos.assets
);
CREATE INDEX revenue_observations_latest ON noticeos.revenue_observations
  (workspace_id, asset_id, source, account_ref, revenue_date, item_ref, observation_id);
CREATE INDEX revenue_observations_recorded ON noticeos.revenue_observations (workspace_id, asset_id, recorded_at);

ALTER TABLE noticeos.revenue_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE noticeos.revenue_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON noticeos.revenue_observations
  USING (workspace_id = noticeos.current_workspace_id())
  WITH CHECK (workspace_id = noticeos.current_workspace_id());
CREATE TRIGGER number_in_workspace BEFORE INSERT ON noticeos.revenue_observations
  FOR EACH ROW EXECUTE FUNCTION noticeos.number_in_workspace('observation_number');

CREATE VIEW noticeos.current_revenue WITH (security_invoker = true) AS
SELECT o.* FROM noticeos.revenue_observations o
 WHERE NOT EXISTS (
   SELECT 1 FROM noticeos.revenue_observations newer
    WHERE newer.workspace_id = o.workspace_id
      AND newer.asset_id = o.asset_id
      AND newer.source = o.source
      AND newer.account_ref = o.account_ref
      AND newer.revenue_date = o.revenue_date
      AND newer.item_ref IS NOT DISTINCT FROM o.item_ref
      AND newer.observation_id > o.observation_id);

-- Every Mediavine day already saved, workspace by workspace (row security
-- admits one at a time), in the order it was written so the newest stays
-- current. A day keeps the number readers were shown for it.
DO $$
DECLARE w uuid;
BEGIN
  FOR w IN SELECT workspace_id FROM noticeos.workspaces ORDER BY workspace_id LOOP
    PERFORM set_config('noticeos.workspace_id', w::text, true);
    INSERT INTO noticeos.revenue_observations (workspace_id, observation_number, asset_id, source, account_ref,
      revenue_date, amount_minor, currency, run_ref, recorded_at)
    SELECT d.workspace_id, d.daily_number, d.asset_id, 'mediavine-journey', d.site_id, d.report_date,
           d.amount_minor, d.currency, r.run_id, d.recorded_at
      FROM noticeos.mediavine_daily d
      JOIN noticeos.mediavine_runs r ON r.workspace_id = d.workspace_id AND r.run_seq = d.run_seq
     ORDER BY d.daily_id;
  END LOOP;
  PERFORM set_config('noticeos.workspace_id', '', true);
END $$;

-- A release that still writes mediavine_daily, running between this
-- migration and the update that replaces it, still reaches the ledger.
CREATE FUNCTION noticeos.mediavine_daily_reaches_revenue_ledger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO noticeos.revenue_observations (workspace_id, asset_id, source, account_ref, revenue_date,
    amount_minor, currency, run_ref, recorded_at)
  SELECT NEW.workspace_id, NEW.asset_id, 'mediavine-journey', NEW.site_id, NEW.report_date,
         NEW.amount_minor, NEW.currency, r.run_id, NEW.recorded_at
    FROM noticeos.mediavine_runs r
   WHERE r.workspace_id = NEW.workspace_id AND r.run_seq = NEW.run_seq;
  RETURN NULL;
END $$;
CREATE TRIGGER mediavine_daily_reaches_revenue_ledger AFTER INSERT ON noticeos.mediavine_daily
  FOR EACH ROW EXECUTE FUNCTION noticeos.mediavine_daily_reaches_revenue_ledger();

-- The ledger as financial readers see it: current money entries (a change
-- entry is not money), with a month of a source's daily figures standing in
-- for an imported estimate from the same provider and family that covers
-- less. A reconciled figure from that provider, or one that corrects its
-- estimate under any source, is never replaced. Rebuildable: never imported,
-- and its synthetic negative ids are never booked as entries. A month of daily
-- figures shows minus its first observation number.
CREATE OR REPLACE VIEW noticeos.financial_ledger WITH (security_invoker = true) AS
WITH RECURSIVE source_lineage (workspace_id, asset_id, period_month, provider, family, entry_id) AS (
  SELECT l.workspace_id, l.asset_id, l.period_month, s.provider, l.family, l.entry_id
    FROM noticeos.ledger_entries l
    JOIN noticeos_ref.revenue_sources s ON s.source = l.source AND s.family = l.family
   WHERE l.kind = 'revenue'
  UNION
  SELECT origin.workspace_id, origin.asset_id, origin.period_month, origin.provider, origin.family, l.entry_id
    FROM noticeos.ledger_entries l
    JOIN source_lineage origin
      ON l.workspace_id = origin.workspace_id AND l.supersedes_id = origin.entry_id
), current_ledger AS (
  SELECT l.* FROM noticeos.ledger_entries l
   WHERE l.kind IN ('revenue','cost')
     AND NOT EXISTS (SELECT 1 FROM noticeos.ledger_entries s
                      WHERE s.workspace_id = l.workspace_id AND s.supersedes_id = l.entry_id)
), daily_months AS (
  SELECT r.workspace_id, r.asset_id, r.source, s.provider, s.family, s.display_name, r.currency,
         date_trunc('month', r.revenue_date)::date AS period_month,
         SUM(r.amount_minor)::bigint AS amount_minor, MIN(r.observation_id) AS first_id,
         MIN(r.observation_number) AS first_number, MIN(r.revenue_date) AS first_date, MAX(r.revenue_date) AS last_date,
         COUNT(DISTINCT r.revenue_date) AS days, MAX(r.recorded_at) AS recorded_at
    FROM noticeos.current_revenue r
    JOIN noticeos_ref.revenue_sources s ON s.source = r.source
   GROUP BY r.workspace_id, r.asset_id, r.source, s.provider, s.family, s.display_name, r.currency,
            date_trunc('month', r.revenue_date)
), usable_months AS (
  SELECT d.* FROM daily_months d
   WHERE NOT EXISTS (
     SELECT 1 FROM current_ledger l
       JOIN source_lineage origin ON origin.workspace_id = l.workspace_id AND origin.entry_id = l.entry_id
      WHERE origin.workspace_id = d.workspace_id AND origin.asset_id = d.asset_id
        AND origin.period_month = d.period_month AND origin.provider = d.provider AND origin.family = d.family
        AND l.booking_state = 'reconciled')
     AND NOT EXISTS (
     SELECT 1 FROM current_ledger l
       JOIN noticeos_ref.revenue_sources s ON s.source = l.source AND s.family = l.family
      WHERE l.workspace_id = d.workspace_id AND l.asset_id = d.asset_id
        AND l.period_month = d.period_month AND l.kind = 'revenue'
        AND s.provider = d.provider AND s.family = d.family
        AND (l.booking_state = 'reconciled'
             OR d.first_date <> d.period_month
             OR d.days <> extract(day FROM d.last_date)
             OR d.last_date < COALESCE(l.coverage_end, (d.period_month + interval '1 month' - interval '1 day')::date)))
)
SELECT l.workspace_id, l.entry_id, l.entry_number, l.kind, l.asset_id, l.period_month, l.family, l.amount_minor,
       l.currency, l.source, l.ref, l.booking_state, l.supersedes_id, l.note, l.recorded_at, l.external_id
  FROM current_ledger l
 WHERE NOT (l.kind = 'revenue' AND l.booking_state = 'estimated'
            AND EXISTS (SELECT 1 FROM usable_months d
                          JOIN noticeos_ref.revenue_sources s ON s.provider = d.provider AND s.family = d.family
                         WHERE d.workspace_id = l.workspace_id AND d.asset_id = l.asset_id
                           AND d.period_month = l.period_month
                           AND s.source = l.source AND s.family = l.family))
UNION ALL
SELECT workspace_id, -first_id, -first_number, 'revenue', asset_id, period_month, family, amount_minor,
       currency, source, NULL, 'estimated', NULL,
       display_name || ': daily estimates ' || first_date || '..' || last_date || ' (' || days || ' days)',
       recorded_at, source || ':daily/' || asset_id || '/' || to_char(period_month, 'YYYY-MM')
  FROM usable_months;

REVOKE ALL ON noticeos_ref.revenue_sources, noticeos.revenue_observations, noticeos.current_revenue FROM PUBLIC;
GRANT SELECT ON noticeos_ref.revenue_sources TO noticeos_app, noticeos_maint;
GRANT SELECT, INSERT ON noticeos.revenue_observations TO noticeos_app;
GRANT SELECT ON noticeos.revenue_observations, noticeos.current_revenue TO noticeos_maint;
GRANT SELECT ON noticeos.current_revenue TO noticeos_app;
