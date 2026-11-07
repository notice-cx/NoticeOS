CREATE TABLE noticeos.portfolio_briefings (
  workspace_id uuid NOT NULL REFERENCES noticeos.workspaces,
  briefing_id bigint GENERATED ALWAYS AS IDENTITY,
  scope_sha256 text NOT NULL CHECK (scope_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  PRIMARY KEY (workspace_id, briefing_id)
);
CREATE INDEX portfolio_briefings_latest ON noticeos.portfolio_briefings
  (workspace_id, scope_sha256, briefing_id DESC);
ALTER TABLE noticeos.portfolio_briefings ENABLE ROW LEVEL SECURITY;
ALTER TABLE noticeos.portfolio_briefings FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON noticeos.portfolio_briefings
  USING (workspace_id = noticeos.current_workspace_id())
  WITH CHECK (workspace_id = noticeos.current_workspace_id());
REVOKE ALL ON noticeos.portfolio_briefings FROM PUBLIC;
GRANT SELECT, INSERT ON noticeos.portfolio_briefings TO noticeos_app;
GRANT SELECT ON noticeos.portfolio_briefings TO noticeos_maint;
