-- Processed minute reports backfill activity without inventing live counters.
CREATE TABLE noticeos.traffic_comparison_reports (
  workspace_id uuid NOT NULL REFERENCES noticeos.workspaces,
  asset_id text NOT NULL,
  property_ref text NOT NULL CHECK (property_ref <> ''),
  comparison_day date NOT NULL,
  time_zone text NOT NULL CHECK (time_zone <> ''),
  observed_at timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL,
  payload jsonb CHECK (jsonb_typeof(payload) = 'object'),
  error_code text,
  CHECK ((payload IS NOT NULL) <> (error_code IS NOT NULL)),
  PRIMARY KEY (workspace_id, asset_id, property_ref, comparison_day, time_zone, observed_at),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES noticeos.assets
);
ALTER TABLE noticeos.traffic_comparison_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE noticeos.traffic_comparison_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON noticeos.traffic_comparison_reports
  USING (workspace_id = noticeos.current_workspace_id())
  WITH CHECK (workspace_id = noticeos.current_workspace_id());
REVOKE ALL ON noticeos.traffic_comparison_reports FROM PUBLIC;
GRANT SELECT, INSERT ON noticeos.traffic_comparison_reports TO noticeos_app;
GRANT SELECT ON noticeos.traffic_comparison_reports TO noticeos_maint;
