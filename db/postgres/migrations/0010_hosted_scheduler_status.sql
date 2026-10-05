-- Workspace scheduler observations and exclusive timer ownership (ro-ujb9.289.10.3.3).
-- Occurrence execution remains fenced by the separate durable job journal.
CREATE TABLE noticeos.hosted_scheduler_status (
  workspace_id uuid PRIMARY KEY REFERENCES noticeos.workspaces(workspace_id),
  service_id uuid NOT NULL,
  session_id uuid NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  running boolean NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object' AND octet_length(payload::text)<=131072)
);
ALTER TABLE noticeos.hosted_scheduler_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE noticeos.hosted_scheduler_status FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON noticeos.hosted_scheduler_status
  USING(workspace_id=noticeos.current_workspace_id()) WITH CHECK(workspace_id=noticeos.current_workspace_id());
REVOKE ALL ON noticeos.hosted_scheduler_status FROM PUBLIC;
GRANT SELECT,INSERT ON noticeos.hosted_scheduler_status TO noticeos_app;
GRANT SELECT ON noticeos.hosted_scheduler_status TO noticeos_maint;
GRANT UPDATE(service_id,session_id,observed_at,running,payload) ON noticeos.hosted_scheduler_status TO noticeos_app;
