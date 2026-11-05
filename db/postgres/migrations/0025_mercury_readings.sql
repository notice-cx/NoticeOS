-- A complete bounded bank read is one observation, never a ledger booking.
-- Connection identity and edit time prevent a replacement key inheriting data.
CREATE TABLE noticeos.mercury_readings (
  workspace_id uuid NOT NULL REFERENCES noticeos.workspaces,
  reading_id uuid NOT NULL DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL,
  connection_updated_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  PRIMARY KEY (workspace_id, reading_id)
);
CREATE INDEX mercury_readings_latest ON noticeos.mercury_readings
  (workspace_id, connection_id, connection_updated_at, observed_at DESC, reading_id DESC);
ALTER TABLE noticeos.mercury_readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE noticeos.mercury_readings FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON noticeos.mercury_readings
  USING (workspace_id = noticeos.current_workspace_id())
  WITH CHECK (workspace_id = noticeos.current_workspace_id());
REVOKE ALL ON noticeos.mercury_readings FROM PUBLIC;
GRANT SELECT, INSERT ON noticeos.mercury_readings TO noticeos_app;
GRANT SELECT ON noticeos.mercury_readings TO noticeos_maint;
