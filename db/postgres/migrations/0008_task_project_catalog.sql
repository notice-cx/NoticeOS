-- Workspace-owned browser project selectors (ro-ujb9.289.10.2.6).
-- Existing allocations stay unconfigured until trusted platform verification.
ALTER TABLE noticeos_platform.task_project_directory
  ADD COLUMN logical_key text CHECK (logical_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  ADD COLUMN display_name text CHECK (pg_catalog.length(display_name) BETWEEN 1 AND 80
    AND display_name=pg_catalog.btrim(display_name) AND display_name !~ '[[:cntrl:]]'),
  ADD COLUMN issue_prefix text CHECK (issue_prefix ~ '^[a-z0-9]{1,32}$'),
  ADD CONSTRAINT task_project_catalog_complete CHECK (
    (logical_key IS NULL AND display_name IS NULL AND issue_prefix IS NULL) OR
    (logical_key IS NOT NULL AND display_name IS NOT NULL AND issue_prefix IS NOT NULL)),
  ADD CONSTRAINT task_project_catalog_key UNIQUE(workspace_id,logical_key),
  ADD CONSTRAINT task_project_catalog_prefix UNIQUE(workspace_id,issue_prefix);

CREATE TABLE noticeos_platform.task_project_catalog_changes (
  change_id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  logical_key text NOT NULL,
  display_name text NOT NULL,
  issue_prefix text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  actor name NOT NULL DEFAULT session_user,
  FOREIGN KEY(workspace_id,project_id) REFERENCES noticeos_platform.task_project_directory(workspace_id,project_id)
);
REVOKE ALL ON noticeos_platform.task_project_catalog_changes FROM PUBLIC;
GRANT SELECT ON noticeos_platform.task_project_catalog_changes TO noticeos_platform;

-- Classification facts only. Current workspace admission precedes this read;
-- project execution separately reloads the exact physical directory mapping.
CREATE FUNCTION noticeos_platform.task_project_catalog(requested_workspace uuid)
RETURNS TABLE(project_id uuid,logical_key text,display_name text,issue_prefix text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp
AS $$
  SELECT d.project_id,d.logical_key,d.display_name,d.issue_prefix
  FROM noticeos_platform.task_project_directory d
  JOIN noticeos.workspaces w ON w.workspace_id=d.workspace_id
  WHERE d.workspace_id=requested_workspace AND d.revoked_at IS NULL
    AND d.logical_key IS NOT NULL AND w.status='active'
  ORDER BY d.logical_key
$$;
REVOKE ALL ON FUNCTION noticeos_platform.task_project_catalog(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION noticeos_platform.task_project_catalog(uuid) TO noticeos_task_directory;

-- Lock order shared with provisioning: organization -> workspace -> directory.
-- This is platform-only; returned mappings do not establish physical readiness.
CREATE FUNCTION noticeos_platform.lock_task_catalog(requested_workspace uuid,requested_project uuid)
RETURNS TABLE(workspace_id uuid,project_id uuid,executor_ref uuid,credential_ref uuid,database_key text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp
AS $$
DECLARE prior_workspace text; lifecycle text;
BEGIN
  prior_workspace := pg_catalog.current_setting('noticeos.workspace_id',true);
  PERFORM 1 FROM noticeos_identity.auth_organization o WHERE o.id=requested_workspace FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Task catalog refused'; END IF;
  PERFORM pg_catalog.set_config('noticeos.workspace_id',requested_workspace::text,true);
  SELECT w.status INTO lifecycle FROM noticeos.workspaces w WHERE w.workspace_id=requested_workspace FOR UPDATE;
  IF lifecycle IS NULL OR lifecycle NOT IN ('provisioning','active') THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Task catalog refused';
  END IF;
  RETURN QUERY SELECT d.workspace_id,d.project_id,d.executor_ref,d.credential_ref,d.database_key
    FROM noticeos_platform.task_project_directory d
    WHERE d.workspace_id=requested_workspace AND d.project_id=requested_project AND d.revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Task catalog refused'; END IF;
  PERFORM pg_catalog.set_config('noticeos.workspace_id',coalesce(prior_workspace,''),true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('noticeos.workspace_id',coalesce(prior_workspace,''),true);
  RAISE;
END
$$;
REVOKE ALL ON FUNCTION noticeos_platform.lock_task_catalog(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION noticeos_platform.lock_task_catalog(uuid,uuid) TO noticeos_platform;

-- The private platform module holds these locks through actual bounded physical
-- verification. Exact mapping equality prevents allocation drift adoption.
CREATE FUNCTION noticeos_platform.set_task_catalog(
  requested_workspace uuid,requested_project uuid,expected_executor uuid,
  expected_credential uuid,expected_database text,
  requested_key text,requested_display text,requested_prefix text
) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp
AS $$
DECLARE mapping noticeos_platform.task_project_directory%ROWTYPE;
BEGIN
  PERFORM noticeos_platform.lock_task_catalog(requested_workspace,requested_project);
  SELECT d.* INTO mapping FROM noticeos_platform.task_project_directory d
    WHERE d.workspace_id=requested_workspace AND d.project_id=requested_project;
  IF mapping.executor_ref IS DISTINCT FROM expected_executor
    OR mapping.credential_ref IS DISTINCT FROM expected_credential
    OR mapping.database_key IS DISTINCT FROM expected_database
    OR requested_key IS NULL OR requested_display IS NULL OR requested_prefix IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Task catalog refused';
  END IF;
  IF mapping.logical_key IS NOT NULL THEN
    IF mapping.logical_key IS DISTINCT FROM requested_key OR mapping.display_name IS DISTINCT FROM requested_display
      OR mapping.issue_prefix IS DISTINCT FROM requested_prefix THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Task catalog changed';
    END IF;
    RETURN;
  END IF;
  UPDATE noticeos_platform.task_project_directory d
    SET logical_key=requested_key,display_name=requested_display,issue_prefix=requested_prefix
    WHERE d.workspace_id=requested_workspace AND d.project_id=requested_project;
  INSERT INTO noticeos_platform.task_project_catalog_changes(workspace_id,project_id,logical_key,display_name,issue_prefix)
    VALUES(requested_workspace,requested_project,requested_key,requested_display,requested_prefix);
END
$$;
REVOKE ALL ON FUNCTION noticeos_platform.set_task_catalog(uuid,uuid,uuid,uuid,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION noticeos_platform.set_task_catalog(uuid,uuid,uuid,uuid,text,text,text,text) TO noticeos_platform;
