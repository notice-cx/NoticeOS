-- Realtime observations retain their provider read time and property identity.
-- Revisions are new readings; a later read may correct overlapping minutes.
CREATE TABLE noticeos.realtime_traffic_readings (
  workspace_id uuid NOT NULL REFERENCES noticeos.workspaces,
  asset_id text NOT NULL,
  property_ref text NOT NULL CHECK (property_ref <> ''),
  observed_at timestamptz NOT NULL,
  active_users_five_minutes bigint NOT NULL CHECK (active_users_five_minutes >= 0),
  active_users_thirty_minutes bigint NOT NULL CHECK (active_users_thirty_minutes >= 0),
  minutes jsonb CHECK (jsonb_typeof(minutes) = 'array' AND jsonb_array_length(minutes) = 30),
  quota jsonb CHECK (jsonb_typeof(quota) = 'object'),
  PRIMARY KEY (workspace_id, asset_id, property_ref, observed_at),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES noticeos.assets
);

ALTER TABLE noticeos.realtime_traffic_readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE noticeos.realtime_traffic_readings FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON noticeos.realtime_traffic_readings
  USING (workspace_id = noticeos.current_workspace_id())
  WITH CHECK (workspace_id = noticeos.current_workspace_id());
REVOKE ALL ON noticeos.realtime_traffic_readings FROM PUBLIC;
GRANT SELECT, INSERT ON noticeos.realtime_traffic_readings TO noticeos_app;
GRANT SELECT ON noticeos.realtime_traffic_readings TO noticeos_maint;
