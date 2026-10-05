-- Maintained email-code protocol and platform enrollment (ro-ujb9.289.8.3.4.2).
-- Runtime login never creates an enrollment, workspace or membership. Existing
-- stores require operator maintenance; no auth activation occurs in migration.
CREATE TABLE noticeos_identity.auth_rate_limit (
  id uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY,
  key text NOT NULL UNIQUE,
  count integer NOT NULL,
  last_request bigint NOT NULL
);
GRANT SELECT, INSERT, UPDATE, DELETE ON noticeos_identity.auth_rate_limit TO noticeos_identity;

CREATE TABLE noticeos_identity.platform_enrollment (
  id uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES noticeos.workspaces(workspace_id) ON DELETE RESTRICT,
  email text NOT NULL CHECK (email=lower(email) AND length(email) BETWEEN 3 AND 320),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  verified_person_id uuid REFERENCES noticeos_identity.auth_user(id) ON DELETE RESTRICT,
  verified_at timestamptz,
  CONSTRAINT platform_enrollment_verification_pair CHECK ((verified_person_id IS NULL)=(verified_at IS NULL))
);
CREATE UNIQUE INDEX platform_enrollment_active_workspace_idx
  ON noticeos_identity.platform_enrollment(workspace_id)
  WHERE revoked_at IS NULL;
GRANT SELECT ON noticeos_identity.platform_enrollment TO noticeos_identity;
GRANT UPDATE (verified_person_id, verified_at) ON noticeos_identity.platform_enrollment TO noticeos_identity;

-- Login's transaction holds canonical lifecycle through code verification and
-- commit. Later control-plane mutations use organization -> workspace ->
-- invitation/enrollment ordering; login first locks rate bucket and mailbox.
-- No tenant schema privilege, enumeration or lifecycle update is granted.
CREATE FUNCTION noticeos_identity.lock_login_workspace(requested_workspace uuid)
RETURNS TABLE(status text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $$
DECLARE prior_workspace text;
BEGIN
  prior_workspace := pg_catalog.current_setting('noticeos.workspace_id', true);
  -- FORCE RLS also applies to the owner during row locking. Scope only this
  -- function's exact row and restore the caller's setting before returning.
  PERFORM pg_catalog.set_config('noticeos.workspace_id', requested_workspace::text, true);
  RETURN QUERY SELECT w.status FROM noticeos.workspaces w
    WHERE w.workspace_id=requested_workspace FOR SHARE;
  PERFORM pg_catalog.set_config('noticeos.workspace_id', coalesce(prior_workspace, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('noticeos.workspace_id', coalesce(prior_workspace, ''), true);
  RAISE;
END
$$;
REVOKE ALL ON FUNCTION noticeos_identity.lock_login_workspace(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION noticeos_identity.lock_login_workspace(uuid) TO noticeos_identity;
