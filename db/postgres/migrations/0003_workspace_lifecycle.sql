-- Canonical workspace admission lifecycle (ro-ujb9.289.8.3.2).
-- The constant initial default backfills existing rows without changing their
-- identity or relying on a cross-workspace UPDATE through forced row security.
ALTER TABLE noticeos.workspaces
  ADD COLUMN status text NOT NULL DEFAULT 'active'
    CONSTRAINT workspaces_status_check CHECK (status IN ('active', 'provisioning', 'suspended'));
ALTER TABLE noticeos.workspaces ALTER COLUMN status SET DEFAULT 'provisioning';

-- One canonical control-plane summary. No tenant rows, organization metadata,
-- enumeration or lifecycle writes escape this identity-only fact reader.
CREATE FUNCTION noticeos_identity.workspace_summary(requested_workspace uuid)
RETURNS TABLE(workspace_id uuid, display_name text, status text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT w.workspace_id, w.display_name, w.status
  FROM noticeos.workspaces w WHERE w.workspace_id = requested_workspace
$$;
REVOKE ALL ON FUNCTION noticeos_identity.workspace_summary(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION noticeos_identity.workspace_summary(uuid) TO noticeos_identity;
