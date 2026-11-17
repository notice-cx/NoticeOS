-- Operator-only enrollment for the single, active workspace of a standalone store.
-- Applying the schema creates no enrollment, member, service grant or task mapping.
CREATE TABLE noticeos_platform.standalone_owner_handoffs (
  enrollment_id uuid PRIMARY KEY REFERENCES noticeos_identity.platform_enrollment(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL REFERENCES noticeos.workspaces(workspace_id) ON DELETE RESTRICT,
  ntasks_origin text NOT NULL,
  ntasks_workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  service_id uuid NOT NULL UNIQUE DEFAULT pg_catalog.gen_random_uuid(),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES noticeos_platform.task_project_directory(workspace_id, project_id) ON DELETE RESTRICT
);
REVOKE ALL ON noticeos_platform.standalone_owner_handoffs FROM PUBLIC;

CREATE FUNCTION noticeos_platform.prepare_standalone_owner(
  requested_workspace uuid, intended_email text, enrollment_expires timestamptz,
  requested_origin text, requested_ntasks_workspace uuid, requested_project uuid
) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $$
DECLARE at timestamptz := pg_catalog.clock_timestamp(); organization_exists boolean;
  prior_workspace text := pg_catalog.current_setting('noticeos.workspace_id',true);
  workspace_slug text; workspace_name text;
  enrollment noticeos_identity.platform_enrollment%ROWTYPE;
  handoff noticeos_platform.standalone_owner_handoffs%ROWTYPE;
  next_enrollment uuid;
BEGIN
  IF requested_workspace IS NULL OR requested_project IS NULL OR requested_ntasks_workspace IS NULL
    OR requested_origin IS NULL OR pg_catalog.length(requested_origin) NOT BETWEEN 8 AND 512
    OR intended_email IS NULL OR intended_email<>pg_catalog.lower(intended_email)
    OR pg_catalog.length(intended_email) NOT BETWEEN 3 AND 320
    OR enrollment_expires IS NULL OR enrollment_expires<=at OR enrollment_expires>at+interval '7 days' THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Standalone owner preparation refused';
  END IF;
  -- Serializes preparation before the organization exists.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('noticeos.standalone-owner:'||requested_workspace::text,0));
  PERFORM 1 FROM noticeos_identity.auth_organization o WHERE o.id=requested_workspace FOR UPDATE;
  organization_exists := FOUND;
  PERFORM pg_catalog.set_config('noticeos.workspace_id',requested_workspace::text,true);
  SELECT w.slug,w.display_name INTO workspace_slug,workspace_name FROM noticeos.workspaces w
    WHERE w.workspace_id=requested_workspace AND w.status='active' FOR UPDATE;
  IF NOT FOUND OR (SELECT pg_catalog.count(*) FROM noticeos.workspaces)<>1
    OR NOT EXISTS(SELECT 1 FROM noticeos.config_documents c WHERE c.workspace_id=requested_workspace)
    OR EXISTS(SELECT 1 FROM noticeos_identity.auth_member m WHERE m.organization_id=requested_workspace)
    OR EXISTS(SELECT 1 FROM noticeos_identity.auth_invitation i WHERE i.organization_id=requested_workspace)
    OR EXISTS(SELECT 1 FROM noticeos_platform.workspace_service_grants g WHERE g.workspace_id=requested_workspace) THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Standalone owner preparation refused';
  END IF;
  SELECT e.* INTO enrollment FROM noticeos_identity.platform_enrollment e
    WHERE e.workspace_id=requested_workspace AND e.revoked_at IS NULL FOR UPDATE;
  IF FOUND THEN
    SELECT h.* INTO handoff FROM noticeos_platform.standalone_owner_handoffs h WHERE h.enrollment_id=enrollment.id;
    IF NOT FOUND OR NOT organization_exists OR enrollment.activated_at IS NOT NULL OR enrollment.email<>intended_email
      OR handoff.ntasks_origin<>requested_origin OR handoff.ntasks_workspace_id<>requested_ntasks_workspace
      OR handoff.project_id<>requested_project OR NOT EXISTS(
        SELECT 1 FROM noticeos_platform.task_project_directory d WHERE d.workspace_id=requested_workspace
          AND d.project_id=requested_project AND d.revoked_at IS NULL) THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Standalone owner preparation refused';
    END IF;
    IF enrollment.expires_at>at THEN
      PERFORM pg_catalog.set_config('noticeos.workspace_id',coalesce(prior_workspace,''),true);
      RETURN enrollment.id;
    END IF;
    UPDATE noticeos_identity.platform_enrollment SET revoked_at=at WHERE id=enrollment.id;
  ELSE
    IF organization_exists OR EXISTS(SELECT 1 FROM noticeos_identity.platform_enrollment e WHERE e.workspace_id=requested_workspace)
      OR EXISTS(SELECT 1 FROM noticeos_platform.task_project_directory d WHERE d.workspace_id=requested_workspace) THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Standalone owner preparation refused';
    END IF;
    INSERT INTO noticeos_identity.auth_organization(id,name,slug,created_at)
      VALUES(requested_workspace,workspace_name,workspace_slug,at);
    INSERT INTO noticeos_platform.task_project_directory(workspace_id,project_id,executor_ref,credential_ref,database_key)
      VALUES(requested_workspace,requested_project,pg_catalog.gen_random_uuid(),pg_catalog.gen_random_uuid(),
        'n_'||pg_catalog.replace(pg_catalog.gen_random_uuid()::text,'-',''));
  END IF;
  INSERT INTO noticeos_identity.platform_enrollment(workspace_id,email,expires_at)
    VALUES(requested_workspace,intended_email,enrollment_expires) RETURNING id INTO next_enrollment;
  INSERT INTO noticeos_platform.standalone_owner_handoffs(enrollment_id,workspace_id,ntasks_origin,ntasks_workspace_id,project_id)
    VALUES(next_enrollment,requested_workspace,requested_origin,requested_ntasks_workspace,requested_project);
  PERFORM pg_catalog.set_config('noticeos.workspace_id',coalesce(prior_workspace,''),true);
  RETURN next_enrollment;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('noticeos.workspace_id',coalesce(prior_workspace,''),true);
  RAISE;
END
$$;
REVOKE ALL ON FUNCTION noticeos_platform.prepare_standalone_owner(uuid,text,timestamptz,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION noticeos_platform.prepare_standalone_owner(uuid,text,timestamptz,text,uuid,uuid) TO noticeos_platform;

-- The email protocol already holds the organization, workspace and enrollment locks.
CREATE FUNCTION noticeos_identity.is_standalone_owner_enrollment(requested_workspace uuid,requested_enrollment uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp
AS $$
  SELECT EXISTS(SELECT 1 FROM noticeos_platform.standalone_owner_handoffs h
    JOIN noticeos_platform.task_project_directory d USING (workspace_id,project_id)
    JOIN noticeos_identity.platform_enrollment e ON e.id=h.enrollment_id AND e.workspace_id=h.workspace_id
    WHERE h.workspace_id=requested_workspace AND h.enrollment_id=requested_enrollment
      AND d.revoked_at IS NULL AND e.revoked_at IS NULL AND e.activated_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM noticeos_identity.auth_member m WHERE m.organization_id=h.workspace_id));
$$;
REVOKE ALL ON FUNCTION noticeos_identity.is_standalone_owner_enrollment(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION noticeos_identity.is_standalone_owner_enrollment(uuid,uuid) TO noticeos_identity;

CREATE FUNCTION noticeos_platform.lock_standalone_owner(
  requested_workspace uuid, requested_enrollment uuid, intended_email text, requested_origin text,
  requested_ntasks_workspace uuid, requested_project uuid
) RETURNS TABLE(person_id uuid,project_id uuid,executor_ref uuid,credential_ref uuid,database_key text,service_id uuid,completed boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp
AS $$
DECLARE enrollment noticeos_identity.platform_enrollment%ROWTYPE;
  prior_workspace text := pg_catalog.current_setting('noticeos.workspace_id',true);
  handoff noticeos_platform.standalone_owner_handoffs%ROWTYPE;
  mapping noticeos_platform.task_project_directory%ROWTYPE;
  expected_members integer;
BEGIN
  PERFORM 1 FROM noticeos_identity.auth_organization o WHERE o.id=requested_workspace FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Standalone owner activation refused'; END IF;
  PERFORM pg_catalog.set_config('noticeos.workspace_id',requested_workspace::text,true);
  PERFORM 1 FROM noticeos.workspaces w WHERE w.workspace_id=requested_workspace AND w.status='active' FOR UPDATE;
  IF NOT FOUND OR (SELECT pg_catalog.count(*) FROM noticeos.workspaces)<>1 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Standalone owner activation refused';
  END IF;
  SELECT e.* INTO enrollment FROM noticeos_identity.platform_enrollment e
    WHERE e.id=requested_enrollment AND e.workspace_id=requested_workspace AND e.email=intended_email AND e.revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND OR enrollment.verified_person_id IS NULL
    OR (enrollment.activated_at IS NULL AND enrollment.expires_at<=pg_catalog.clock_timestamp()) THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Standalone owner activation refused';
  END IF;
  SELECT h.* INTO handoff FROM noticeos_platform.standalone_owner_handoffs h WHERE h.enrollment_id=enrollment.id
    AND h.workspace_id=requested_workspace AND h.ntasks_origin=requested_origin
    AND h.ntasks_workspace_id=requested_ntasks_workspace AND h.project_id=requested_project;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Standalone owner activation refused'; END IF;
  PERFORM 1 FROM noticeos_identity.auth_user u WHERE u.id=enrollment.verified_person_id
    AND u.email_verified AND pg_catalog.lower(u.email)=enrollment.email FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Standalone owner activation refused'; END IF;
  SELECT d.* INTO mapping FROM noticeos_platform.task_project_directory d
    WHERE d.workspace_id=requested_workspace AND d.project_id=requested_project AND d.revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Standalone owner activation refused'; END IF;
  expected_members := CASE WHEN enrollment.activated_at IS NULL THEN 0 ELSE 1 END;
  IF (SELECT pg_catalog.count(*) FROM noticeos_identity.auth_member m WHERE m.organization_id=requested_workspace)<>expected_members
    OR (expected_members=0 AND EXISTS(SELECT 1 FROM noticeos_platform.workspace_service_grants g WHERE g.workspace_id=requested_workspace))
    OR (expected_members=1 AND (NOT EXISTS(SELECT 1 FROM noticeos_identity.auth_member m
      WHERE m.organization_id=requested_workspace AND m.user_id=enrollment.verified_person_id AND m.role='owner')
      OR NOT EXISTS(SELECT 1 FROM noticeos_platform.workspace_service_grants g WHERE g.service_id=handoff.service_id
        AND g.workspace_id=requested_workspace AND g.actions=ARRAY['workflows.run']::text[]
        AND g.revoked_at IS NULL AND g.expires_at>pg_catalog.clock_timestamp()))) THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Standalone owner activation refused';
  END IF;
  RETURN QUERY SELECT enrollment.verified_person_id,mapping.project_id,mapping.executor_ref,mapping.credential_ref,
    mapping.database_key,handoff.service_id,enrollment.activated_at IS NOT NULL;
  PERFORM pg_catalog.set_config('noticeos.workspace_id',coalesce(prior_workspace,''),true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('noticeos.workspace_id',coalesce(prior_workspace,''),true);
  RAISE;
END
$$;
REVOKE ALL ON FUNCTION noticeos_platform.lock_standalone_owner(uuid,uuid,text,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION noticeos_platform.lock_standalone_owner(uuid,uuid,text,text,uuid,uuid) TO noticeos_platform;

-- The private caller holds the locks above through project proof and maintained addMember.
CREATE FUNCTION noticeos_platform.complete_standalone_owner(requested_workspace uuid,requested_enrollment uuid)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp
AS $$
DECLARE enrollment noticeos_identity.platform_enrollment%ROWTYPE; allowed_service uuid;
  prior_workspace text := pg_catalog.current_setting('noticeos.workspace_id',true);
BEGIN
  PERFORM 1 FROM noticeos_identity.auth_organization o WHERE o.id=requested_workspace FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Standalone owner completion refused'; END IF;
  PERFORM pg_catalog.set_config('noticeos.workspace_id',requested_workspace::text,true);
  PERFORM 1 FROM noticeos.workspaces w WHERE w.workspace_id=requested_workspace AND w.status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Standalone owner completion refused'; END IF;
  SELECT e.* INTO enrollment FROM noticeos_identity.platform_enrollment e WHERE e.id=requested_enrollment
    AND e.workspace_id=requested_workspace AND e.revoked_at IS NULL AND e.activated_at IS NULL
    AND e.expires_at>pg_catalog.clock_timestamp() FOR UPDATE;
  IF NOT FOUND OR enrollment.verified_person_id IS NULL
    OR (SELECT pg_catalog.count(*) FROM noticeos_identity.auth_member m WHERE m.organization_id=requested_workspace)<>1
    OR NOT EXISTS(SELECT 1 FROM noticeos_identity.auth_member m JOIN noticeos_identity.auth_user u ON u.id=m.user_id
      WHERE m.organization_id=requested_workspace AND m.user_id=enrollment.verified_person_id AND m.role='owner'
        AND u.email_verified AND pg_catalog.lower(u.email)=enrollment.email) THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Standalone owner completion refused';
  END IF;
  SELECT h.service_id INTO allowed_service FROM noticeos_platform.standalone_owner_handoffs h
    JOIN noticeos_platform.task_project_directory d USING (workspace_id,project_id)
    WHERE h.enrollment_id=requested_enrollment AND h.workspace_id=requested_workspace AND d.revoked_at IS NULL FOR UPDATE OF d;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Standalone owner completion refused'; END IF;
  INSERT INTO noticeos_platform.workspace_service_grants(service_id,workspace_id,actions,expires_at)
    VALUES(allowed_service,requested_workspace,ARRAY['workflows.run'],pg_catalog.clock_timestamp()+interval '1 year');
  UPDATE noticeos_identity.platform_enrollment SET activated_at=pg_catalog.clock_timestamp() WHERE id=enrollment.id;
  PERFORM pg_catalog.set_config('noticeos.workspace_id',coalesce(prior_workspace,''),true);
  RETURN allowed_service;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('noticeos.workspace_id',coalesce(prior_workspace,''),true);
  RAISE;
END
$$;
REVOKE ALL ON FUNCTION noticeos_platform.complete_standalone_owner(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION noticeos_platform.complete_standalone_owner(uuid,uuid) TO noticeos_platform;
