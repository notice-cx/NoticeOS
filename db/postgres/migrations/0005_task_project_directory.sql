-- Platform-owned task directory (ro-ujb9.289.10.2.2).
-- Facts only; this mapping is not admission or executor certification.
CREATE SCHEMA noticeos_platform;
REVOKE ALL ON SCHEMA noticeos_platform FROM PUBLIC;

CREATE TABLE noticeos_platform.task_project_directory (
  workspace_id uuid NOT NULL REFERENCES noticeos.workspaces(workspace_id) ON DELETE RESTRICT,
  project_id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  executor_ref uuid NOT NULL,
  credential_ref uuid NOT NULL,
  database_key text NOT NULL CHECK (database_key ~ '^n_[0-9a-f]{32}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  revoked_at timestamptz,
  PRIMARY KEY (workspace_id, project_id),
  UNIQUE (executor_ref, database_key),
  UNIQUE (credential_ref)
);
-- Database identity, credential reference and owner are immutable. A failed
-- or retired allocation remains recorded; a replacement receives new IDs.
REVOKE ALL ON noticeos_platform.task_project_directory FROM PUBLIC;
GRANT USAGE ON SCHEMA noticeos_platform TO noticeos_platform;
GRANT SELECT, INSERT ON noticeos_platform.task_project_directory TO noticeos_platform;
GRANT UPDATE (revoked_at) ON noticeos_platform.task_project_directory TO noticeos_platform;

-- This privileged directory is separate control-plane data. Customer roles
-- get no table or schema access. A fixed trusted resolver, following current
-- admission, may read exactly one requested mapping. This function supplies
-- facts, not authorization, credentials, a path, or task readiness.
CREATE FUNCTION noticeos_platform.resolve_task_project(requested_workspace uuid, requested_project uuid)
RETURNS TABLE(workspace_id uuid, project_id uuid, executor_ref uuid, credential_ref uuid, database_key text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT d.workspace_id,d.project_id,d.executor_ref,d.credential_ref,d.database_key
  FROM noticeos_platform.task_project_directory d
  WHERE d.workspace_id=requested_workspace AND d.project_id=requested_project AND d.revoked_at IS NULL
$$;
REVOKE ALL ON FUNCTION noticeos_platform.resolve_task_project(uuid,uuid) FROM PUBLIC;
GRANT USAGE ON SCHEMA noticeos_platform TO noticeos_task_directory;
GRANT EXECUTE ON FUNCTION noticeos_platform.resolve_task_project(uuid,uuid) TO noticeos_task_directory;
