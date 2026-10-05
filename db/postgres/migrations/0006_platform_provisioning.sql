-- Platform provisioning (ro-ujb9.289.8.3.4.5), operator-only on existing stores.
-- No hosted route or service activation is performed by this migration.
-- Platform-only new-workspace preparation and first-owner activation.
-- Module must use released generic defaults and real executor custody/verification.
ALTER TABLE noticeos_identity.platform_enrollment ADD COLUMN activated_at timestamptz;
ALTER TABLE noticeos_identity.platform_enrollment
  ADD CONSTRAINT platform_enrollment_activation_verified
  CHECK (activated_at IS NULL OR verified_person_id IS NOT NULL);

-- Exact independently qualified maintained addMember grants, no protocol data.
GRANT USAGE ON SCHEMA noticeos_identity TO noticeos_platform;
GRANT SELECT ON noticeos_identity.auth_user, noticeos_identity.auth_organization TO noticeos_platform;
GRANT SELECT, INSERT ON noticeos_identity.auth_member TO noticeos_platform;

-- Shared envelope validation, not a canonical document registry. Only the
-- private released-default source determines expected keys/values.
CREATE FUNCTION noticeos_platform.validate_default_envelope(documents jsonb)
RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp
AS $$
DECLARE document jsonb; seen_keys text[] := '{}'; document_key text; body json;
BEGIN
  IF documents IS NULL OR pg_catalog.jsonb_typeof(documents)<>'array'
    OR pg_catalog.jsonb_array_length(documents) NOT BETWEEN 1 AND 64
    OR pg_catalog.octet_length(documents::text)>1048576 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Platform defaults refused';
  END IF;
  FOR document IN SELECT value FROM pg_catalog.jsonb_array_elements(documents) LOOP
    IF pg_catalog.jsonb_typeof(document)<>'object'
      OR NOT(document?'key' AND document?'file' AND document?'body')
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(document))<>3
      OR pg_catalog.jsonb_typeof(document->'key')<>'string'
      OR pg_catalog.jsonb_typeof(document->'file')<>'string'
      OR pg_catalog.jsonb_typeof(document->'body')<>'string' THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Platform defaults refused';
    END IF;
    document_key := document->>'key';
    IF document_key !~ '^[a-z0-9][a-z0-9-]*$'
      OR (document->>'file')<>('config/'||document_key||'.json')
      OR document_key=ANY(seen_keys) OR pg_catalog.octet_length(document->>'body')>262144 THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Platform defaults refused';
    END IF;
    seen_keys := pg_catalog.array_append(seen_keys,document_key);
    body := (document->>'body')::json;
    IF pg_catalog.json_typeof(body) NOT IN ('object','array') THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Platform defaults refused';
    END IF;
  END LOOP;
END
$$;
REVOKE ALL ON FUNCTION noticeos_platform.validate_default_envelope(jsonb) FROM PUBLIC;

-- Caller already holds canonical workspace FOR UPDATE with its exact RLS scope.
-- That lock blocks FK key-share needed for concurrent new document/audit rows.
-- Existing rows are held too, and completion rechecks the same captured release.
CREATE FUNCTION noticeos_platform.assert_initial_defaults(requested_workspace uuid,documents jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,pg_temp
AS $$
DECLARE document jsonb; stored noticeos.config_documents%ROWTYPE;
BEGIN
  PERFORM noticeos_platform.validate_default_envelope(documents);
  PERFORM 1 FROM noticeos.config_documents c WHERE c.workspace_id=requested_workspace ORDER BY c.document_key FOR UPDATE;
  PERFORM 1 FROM noticeos.config_changes c WHERE c.workspace_id=requested_workspace ORDER BY c.change_id FOR UPDATE;
  IF (SELECT pg_catalog.count(*) FROM noticeos.config_documents c WHERE c.workspace_id=requested_workspace)<>pg_catalog.jsonb_array_length(documents)
    OR (SELECT pg_catalog.count(*) FROM noticeos.config_changes c WHERE c.workspace_id=requested_workspace)<>pg_catalog.jsonb_array_length(documents) THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Platform defaults changed';
  END IF;
  FOR document IN SELECT value FROM pg_catalog.jsonb_array_elements(documents) LOOP
    SELECT c.* INTO stored FROM noticeos.config_documents c
      WHERE c.workspace_id=requested_workspace AND c.document_key=document->>'key';
    IF NOT FOUND OR stored.version<>1 OR stored.updated_by IS DISTINCT FROM 'platform-provisioning'
      OR stored.body::jsonb<>(document->>'body')::jsonb
      OR NOT EXISTS(SELECT 1 FROM noticeos.config_changes c WHERE c.workspace_id=requested_workspace
        AND c.document_key=stored.document_key AND c.version_before=0 AND c.version_after=1
        AND c.actor='platform-provisioning' AND c.reason='Initial product defaults' AND c.changed_at=stored.updated_at
        AND c.ops=pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('kind','document-seed','file',document->>'file'))) THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Platform defaults changed';
    END IF;
  END LOOP;
END
$$;
REVOKE ALL ON FUNCTION noticeos_platform.assert_initial_defaults(uuid,jsonb) FROM PUBLIC;

-- Defaults envelope is generated/validated by the private module from released
-- generic documents, never HTTP input or installation files. This function
-- offers only a new-workspace insert, not a general config updater.
CREATE FUNCTION noticeos_platform.prepare_workspace(
  requested_workspace uuid, requested_slug text, requested_display text,
  intended_email text, enrollment_expires timestamptz, released_documents jsonb
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $$
DECLARE prior_workspace text; enrollment_id uuid; document jsonb;
  document_key text; document_body json; at timestamptz := pg_catalog.clock_timestamp();
BEGIN
  prior_workspace := pg_catalog.current_setting('noticeos.workspace_id',true);
  IF requested_workspace IS NULL OR requested_slug IS NULL OR requested_display IS NULL
    OR intended_email IS NULL OR intended_email<>pg_catalog.lower(intended_email)
    OR pg_catalog.length(intended_email) NOT BETWEEN 3 AND 320
    OR enrollment_expires IS NULL OR enrollment_expires<=at OR enrollment_expires>at+interval '7 days'
    THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Platform preparation refused';
  END IF;
  PERFORM noticeos_platform.validate_default_envelope(released_documents);
  PERFORM pg_catalog.set_config('noticeos.workspace_id',requested_workspace::text,true);
  -- A collision refuses; an existing workspace is never adopted or overwritten.
  INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status)
    VALUES(requested_workspace,requested_slug,requested_display,'provisioning');
  INSERT INTO noticeos_identity.auth_organization(id,name,slug,created_at)
    VALUES(requested_workspace,'Workspace '||requested_workspace::text,'workspace-'||requested_workspace::text,at);
  INSERT INTO noticeos_identity.platform_enrollment(workspace_id,email,expires_at)
    VALUES(requested_workspace,intended_email,enrollment_expires) RETURNING id INTO enrollment_id;
  FOR document IN SELECT value FROM pg_catalog.jsonb_array_elements(released_documents) LOOP
    document_key := document->>'key';
    document_body := (document->>'body')::json;
    INSERT INTO noticeos.config_documents(workspace_id,document_key,body,version,updated_at,updated_by)
      VALUES(requested_workspace,document_key,document_body,1,at,'platform-provisioning');
    INSERT INTO noticeos.config_changes(workspace_id,document_key,ops,reason,actor,version_before,version_after,changed_at)
      VALUES(requested_workspace,document_key,
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('kind','document-seed','file',document->>'file')),
        'Initial product defaults','platform-provisioning',0,1,at);
  END LOOP;
  PERFORM pg_catalog.set_config('noticeos.workspace_id',coalesce(prior_workspace,''),true);
  RETURN enrollment_id;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('noticeos.workspace_id',coalesce(prior_workspace,''),true);
  RAISE;
END
$$;
REVOKE ALL ON FUNCTION noticeos_platform.prepare_workspace(uuid,text,text,text,timestamptz,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION noticeos_platform.prepare_workspace(uuid,text,text,text,timestamptz,jsonb) TO noticeos_platform;

-- Holds org -> canonical workspace -> enrollment -> verified person -> exact
-- directory row in the caller's transaction. No rate/mailbox lock is acquired.
-- Returned facts do not assert physical database/schema/grant readiness.
CREATE FUNCTION noticeos_platform.lock_workspace_activation(
  requested_workspace uuid, requested_enrollment uuid, requested_project uuid, released_documents jsonb
) RETURNS TABLE(person_id uuid, project_id uuid, executor_ref uuid, credential_ref uuid, database_key text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $$
DECLARE prior_workspace text; lifecycle text;
  enrollment noticeos_identity.platform_enrollment%ROWTYPE;
  person noticeos_identity.auth_user%ROWTYPE;
  mapping noticeos_platform.task_project_directory%ROWTYPE;
BEGIN
  prior_workspace := pg_catalog.current_setting('noticeos.workspace_id',true);
  PERFORM 1 FROM noticeos_identity.auth_organization o WHERE o.id=requested_workspace FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Platform activation refused'; END IF;
  PERFORM pg_catalog.set_config('noticeos.workspace_id',requested_workspace::text,true);
  SELECT w.status INTO lifecycle FROM noticeos.workspaces w WHERE w.workspace_id=requested_workspace FOR UPDATE;
  IF lifecycle IS DISTINCT FROM 'provisioning' THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Platform activation refused';
  END IF;
  SELECT e.* INTO enrollment FROM noticeos_identity.platform_enrollment e
    WHERE e.id=requested_enrollment AND e.workspace_id=requested_workspace FOR UPDATE;
  IF NOT FOUND OR enrollment.revoked_at IS NOT NULL OR enrollment.activated_at IS NOT NULL
    OR enrollment.expires_at<=pg_catalog.clock_timestamp() OR enrollment.verified_person_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Platform activation refused';
  END IF;
  SELECT u.* INTO person FROM noticeos_identity.auth_user u WHERE u.id=enrollment.verified_person_id FOR SHARE;
  IF NOT FOUND OR NOT person.email_verified OR pg_catalog.lower(person.email)<>enrollment.email
    OR EXISTS(SELECT 1 FROM noticeos_identity.auth_member m WHERE m.organization_id=requested_workspace) THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Platform activation refused';
  END IF;
  SELECT d.* INTO mapping FROM noticeos_platform.task_project_directory d
    WHERE d.workspace_id=requested_workspace AND d.project_id=requested_project AND d.revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Platform task initialization refused'; END IF;
  PERFORM noticeos_platform.assert_initial_defaults(requested_workspace,released_documents);
  PERFORM pg_catalog.set_config('noticeos.workspace_id',coalesce(prior_workspace,''),true);
  RETURN QUERY SELECT person.id,mapping.project_id,mapping.executor_ref,mapping.credential_ref,mapping.database_key;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('noticeos.workspace_id',coalesce(prior_workspace,''),true);
  RAISE;
END
$$;
REVOKE ALL ON FUNCTION noticeos_platform.lock_workspace_activation(uuid,uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION noticeos_platform.lock_workspace_activation(uuid,uuid,uuid,jsonb) TO noticeos_platform;

-- Only the private composition calls this after real mapping-bound executor
-- verification + maintained addMember in the same still-open transaction.
-- SQL checks the current exact verified first owner, not a caller person/flag.
CREATE FUNCTION noticeos_platform.complete_workspace_activation(
  requested_workspace uuid, requested_enrollment uuid, requested_project uuid, released_documents jsonb
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $$
DECLARE prior_workspace text; lifecycle text;
  enrollment noticeos_identity.platform_enrollment%ROWTYPE;
  person noticeos_identity.auth_user%ROWTYPE;
BEGIN
  prior_workspace := pg_catalog.current_setting('noticeos.workspace_id',true);
  PERFORM 1 FROM noticeos_identity.auth_organization o WHERE o.id=requested_workspace FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Platform activation refused'; END IF;
  PERFORM pg_catalog.set_config('noticeos.workspace_id',requested_workspace::text,true);
  SELECT w.status INTO lifecycle FROM noticeos.workspaces w WHERE w.workspace_id=requested_workspace FOR UPDATE;
  SELECT e.* INTO enrollment FROM noticeos_identity.platform_enrollment e
    WHERE e.id=requested_enrollment AND e.workspace_id=requested_workspace FOR UPDATE;
  IF lifecycle IS DISTINCT FROM 'provisioning' OR NOT FOUND OR enrollment.revoked_at IS NOT NULL
    OR enrollment.activated_at IS NOT NULL OR enrollment.expires_at<=pg_catalog.clock_timestamp()
    OR enrollment.verified_person_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Platform activation refused';
  END IF;
  SELECT u.* INTO person FROM noticeos_identity.auth_user u WHERE u.id=enrollment.verified_person_id FOR SHARE;
  IF NOT FOUND OR NOT person.email_verified OR pg_catalog.lower(person.email)<>enrollment.email
    OR (SELECT pg_catalog.count(*) FROM noticeos_identity.auth_member m WHERE m.organization_id=requested_workspace)<>1
    OR NOT EXISTS(SELECT 1 FROM noticeos_identity.auth_member m WHERE m.organization_id=requested_workspace
      AND m.user_id=person.id AND m.role='owner') THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Platform first owner refused';
  END IF;
  PERFORM 1 FROM noticeos_platform.task_project_directory d
    WHERE d.workspace_id=requested_workspace AND d.project_id=requested_project AND d.revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Platform task initialization refused'; END IF;
  PERFORM noticeos_platform.assert_initial_defaults(requested_workspace,released_documents);
  UPDATE noticeos.workspaces w SET status='active' WHERE w.workspace_id=requested_workspace;
  UPDATE noticeos_identity.platform_enrollment e SET activated_at=pg_catalog.clock_timestamp() WHERE e.id=requested_enrollment;
  PERFORM pg_catalog.set_config('noticeos.workspace_id',coalesce(prior_workspace,''),true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('noticeos.workspace_id',coalesce(prior_workspace,''),true);
  RAISE;
END
$$;
REVOKE ALL ON FUNCTION noticeos_platform.complete_workspace_activation(uuid,uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION noticeos_platform.complete_workspace_activation(uuid,uuid,uuid,jsonb) TO noticeos_platform;
