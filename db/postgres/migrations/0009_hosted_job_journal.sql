-- Workspace-owned scheduled work (ro-ujb9.289.10.3.2).
-- Additive; standalone job_runs/history and existing installations unchanged.
CREATE TABLE noticeos.hosted_job_occurrences (
  workspace_id uuid NOT NULL REFERENCES noticeos.workspaces(workspace_id),
  lane text NOT NULL CHECK (lane ~ '^[a-z][a-z0-9._-]{0,63}$'),
  occurrence text NOT NULL CHECK (occurrence ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'),
  service_id uuid NOT NULL,
  definition_hash text NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('running','retryable','succeeded','uncertain','blocked','exhausted')),
  attempt integer NOT NULL CHECK (attempt BETWEEN 0 AND 5),
  lease_id uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  effect_step text CHECK (effect_step ~ '^[a-z][a-z0-9._-]{0,63}$'),
  steps jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(steps)='object' AND octet_length(steps::text)<=1048576),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,lane,occurrence)
);
CREATE TABLE noticeos.hosted_job_attempts (
  workspace_id uuid NOT NULL,
  lane text NOT NULL,
  occurrence text NOT NULL,
  attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 5),
  lease_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('running','retryable','succeeded','uncertain','blocked','exhausted')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  PRIMARY KEY(workspace_id,lane,occurrence,attempt),
  FOREIGN KEY(workspace_id,lane,occurrence) REFERENCES noticeos.hosted_job_occurrences(workspace_id,lane,occurrence),
  CHECK ((state='running')=(finished_at IS NULL)),
  CHECK (finished_at IS NULL OR finished_at>=started_at)
);
CREATE INDEX hosted_job_recent_attempts ON noticeos.hosted_job_attempts(workspace_id,started_at DESC);

ALTER TABLE noticeos.hosted_job_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE noticeos.hosted_job_occurrences FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON noticeos.hosted_job_occurrences
  USING (workspace_id=noticeos.current_workspace_id()) WITH CHECK (workspace_id=noticeos.current_workspace_id());
ALTER TABLE noticeos.hosted_job_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE noticeos.hosted_job_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON noticeos.hosted_job_attempts
  USING (workspace_id=noticeos.current_workspace_id()) WITH CHECK (workspace_id=noticeos.current_workspace_id());
REVOKE ALL ON noticeos.hosted_job_occurrences,noticeos.hosted_job_attempts FROM PUBLIC;
GRANT SELECT,INSERT ON noticeos.hosted_job_occurrences,noticeos.hosted_job_attempts TO noticeos_app;
GRANT SELECT ON noticeos.hosted_job_occurrences,noticeos.hosted_job_attempts TO noticeos_maint;
GRANT UPDATE(state,attempt,lease_id,lease_expires_at,effect_step,steps,updated_at) ON noticeos.hosted_job_occurrences TO noticeos_app;
GRANT UPDATE(state,finished_at) ON noticeos.hosted_job_attempts TO noticeos_app;
