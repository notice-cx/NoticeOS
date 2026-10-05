-- Deployment-owned workspace services (ro-ujb9.289.10.3.1).
-- No bearer values, user sessions, operational data or scheduler activation.
CREATE TABLE noticeos_platform.workspace_service_grants (
  service_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES noticeos.workspaces(workspace_id) ON DELETE RESTRICT,
  actions text[] NOT NULL CHECK (
    pg_catalog.array_ndims(actions)=1 AND pg_catalog.array_lower(actions,1)=1
    AND pg_catalog.cardinality(actions) BETWEEN 1 AND 32
    AND pg_catalog.array_position(actions,NULL) IS NULL),
  expires_at timestamptz NOT NULL CHECK (pg_catalog.isfinite(expires_at)),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  revoked_at timestamptz,
  CHECK (expires_at>created_at)
);
REVOKE ALL ON noticeos_platform.workspace_service_grants FROM PUBLIC;
GRANT SELECT,INSERT ON noticeos_platform.workspace_service_grants TO noticeos_platform;
GRANT UPDATE(actions,expires_at,revoked_at) ON noticeos_platform.workspace_service_grants TO noticeos_platform;

-- One exact lookup, not enumeration or permission policy. Canonical lifecycle
-- remains on workspaces; owner_lists_workspaces permits this owner-held read
-- without disabling FORCE RLS or expanding customer privileges.
CREATE FUNCTION noticeos_platform.resolve_workspace_service(requested_workspace uuid,requested_service uuid)
RETURNS TABLE(service_id uuid,workspace_id uuid,actions text[],expires_at timestamptz,status text)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $$
  SELECT g.service_id,g.workspace_id,g.actions,g.expires_at,w.status
  FROM noticeos_platform.workspace_service_grants g
  JOIN noticeos.workspaces w ON w.workspace_id=g.workspace_id
  WHERE g.workspace_id=requested_workspace AND g.service_id=requested_service
    AND g.revoked_at IS NULL AND g.expires_at>pg_catalog.clock_timestamp()
$$;
REVOKE ALL ON FUNCTION noticeos_platform.resolve_workspace_service(uuid,uuid) FROM PUBLIC;
GRANT USAGE ON SCHEMA noticeos_platform TO noticeos_service_grant;
GRANT EXECUTE ON FUNCTION noticeos_platform.resolve_workspace_service(uuid,uuid) TO noticeos_service_grant;
