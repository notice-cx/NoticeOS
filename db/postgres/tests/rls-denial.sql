-- Cross-workspace denial proof (D27, bead ro-ujb9.76.2).
--
-- Preconditions: the migrations applied as noticeos_owner, then fixture.sql loaded
-- for workspace A (0000000a-…, site a.example) and workspace B (0000000b-…,
-- site b.example), so every table holds one workspace-A and one workspace-B
-- row at least. Run by the cluster superuser; each block switches to the role
-- it tests. Any failed assertion stops the script (ON_ERROR_STOP).

\set A '0000000a-0000-4000-8000-00000000000a'
\set B '0000000b-0000-4000-8000-00000000000b'

-- ─── 1. The application role is neither an owner nor able to bypass row security

DO $$
DECLARE r record; n int;
BEGIN
  SELECT rolsuper, rolbypassrls INTO r FROM pg_roles WHERE rolname = 'noticeos_app';
  ASSERT NOT r.rolsuper AND NOT r.rolbypassrls, 'noticeos_app must not be superuser or BYPASSRLS';
  SELECT rolsuper, rolbypassrls INTO r FROM pg_roles WHERE rolname = 'noticeos_owner';
  ASSERT NOT r.rolsuper AND NOT r.rolbypassrls, 'noticeos_owner must not be superuser or BYPASSRLS';
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'noticeos' AND pg_get_userbyid(c.relowner) = 'noticeos_app';
  ASSERT n = 0, 'noticeos_app owns no object';
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'noticeos' AND c.relkind = 'r'
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
  ASSERT n = 0, 'every table has row security enabled and forced';
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'noticeos' AND c.relkind = 'r'
     AND NOT EXISTS (SELECT 1 FROM pg_policies p
                      WHERE p.schemaname = 'noticeos' AND p.tablename = c.relname
                        AND p.policyname = 'workspace_isolation'
                        AND p.qual LIKE '%current_workspace_id()%'
                        AND p.with_check LIKE '%current_workspace_id()%');
  ASSERT n = 0, 'every table carries the workspace_isolation policy on reads and writes';
  -- The one other policy lets the owner read the list of workspaces, so that
  -- noticeos.only_workspace() can answer: no write, no other role, no other table.
  SELECT count(*) INTO n FROM pg_policies p
   WHERE p.schemaname IN ('noticeos', 'noticeos_ref') AND p.policyname <> 'workspace_isolation'
     AND NOT (p.tablename = 'workspaces' AND p.policyname = 'owner_lists_workspaces' AND p.cmd = 'SELECT'
              AND p.permissive = 'PERMISSIVE' AND p.roles = ARRAY['noticeos_owner']::name[]);
  ASSERT n = 0, 'the only other policy is the owner''s read-only list of workspaces';
  -- One function runs with its owner's rights: only_workspace, with its search
  -- path pinned, which the application may call and PUBLIC may not.
  SELECT count(*) INTO n FROM pg_proc f JOIN pg_namespace ns ON ns.oid = f.pronamespace
   WHERE ns.nspname IN ('noticeos', 'noticeos_ref') AND f.prosecdef
     AND NOT (f.proname = 'only_workspace' AND f.proconfig = ARRAY['search_path=pg_catalog, pg_temp']);
  ASSERT n = 0, 'only noticeos.only_workspace() runs with its owner''s rights, and its search path is pinned';
  ASSERT has_function_privilege('noticeos_app', 'noticeos.only_workspace()', 'EXECUTE')
     AND NOT has_function_privilege('noticeos_maint', 'noticeos.only_workspace()', 'EXECUTE'),
    'the application may ask for the only workspace, and no one else is granted it';
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'noticeos' AND c.relkind = 'v'
     AND NOT coalesce('security_invoker=true' = ANY (c.reloptions), false);
  ASSERT n = 0, 'every view runs with the caller''s rights, so row security applies through it';

  -- Tenant data lives in noticeos, every table of it keyed by workspace; the
  -- shared vocabulary lives in noticeos_ref and carries no workspace at all.
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'noticeos' AND c.relkind = 'r'
     AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped);
  ASSERT n = 0, 'every noticeos table carries workspace_id';
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'noticeos_ref' AND c.relkind = 'r'
     AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped);
  ASSERT n = 0, 'no noticeos_ref table carries tenant data';
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'noticeos_ref' AND c.relkind = 'r'
     AND (has_table_privilege('noticeos_app', c.oid, 'INSERT') OR has_table_privilege('noticeos_app', c.oid, 'UPDATE')
          OR has_table_privilege('noticeos_app', c.oid, 'DELETE') OR has_table_privilege('noticeos_maint', c.oid, 'INSERT')
          OR has_table_privilege('noticeos_maint', c.oid, 'UPDATE') OR has_table_privilege('noticeos_maint', c.oid, 'DELETE')
          OR NOT has_table_privilege('noticeos_app', c.oid, 'SELECT'));
  ASSERT n = 0, 'the shared vocabulary is read, never written, by the application and maintenance';

  -- The maintenance role spans workspaces, and nothing else can become it.
  SELECT rolsuper, rolbypassrls, rolcanlogin, rolcreaterole, rolcreatedb INTO r FROM pg_roles WHERE rolname = 'noticeos_maint';
  ASSERT r.rolbypassrls AND NOT r.rolsuper AND NOT r.rolcanlogin AND NOT r.rolcreaterole AND NOT r.rolcreatedb,
    'noticeos_maint bypasses row security, and holds no other power';
  ASSERT NOT pg_has_role('noticeos_app', 'noticeos_maint', 'MEMBER') AND NOT pg_has_role('noticeos_app', 'noticeos_maint', 'USAGE'),
    'the application can never act as noticeos_maint';
  ASSERT NOT pg_has_role('noticeos_owner', 'noticeos_maint', 'MEMBER'), 'the owner can never act as noticeos_maint';
  SELECT count(*) INTO n FROM pg_auth_members m
   WHERE m.roleid IN ('noticeos_maint'::regrole, 'noticeos_owner'::regrole)
      OR m.member IN ('noticeos_app'::regrole, 'noticeos_maint'::regrole, 'noticeos_owner'::regrole);
  ASSERT n = 0, 'no role is granted another: a login for maintenance is the operator''s step';
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname IN ('noticeos', 'noticeos_ref') AND pg_get_userbyid(c.relowner) IN ('noticeos_maint', 'noticeos_app');
  ASSERT n = 0, 'neither the application nor maintenance owns an object';
  ASSERT NOT has_schema_privilege('noticeos_maint', 'noticeos', 'CREATE')
     AND NOT has_schema_privilege('noticeos_maint', 'noticeos_ref', 'CREATE')
     AND NOT has_database_privilege('noticeos_maint', current_database(), 'CREATE'),
    'noticeos_maint cannot create anything';
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'noticeos' AND c.relkind = 'r' AND has_table_privilege('noticeos_maint', c.oid, 'UPDATE');
  ASSERT n = 0, 'noticeos_maint changes no row';
END $$;

-- ─── 2. With workspace A named, no table shows a row of B, and every table shows A's

SET ROLE noticeos_app;
BEGIN;
SELECT set_config('noticeos.workspace_id', :'A', true);
DO $$
DECLARE t record; own bigint; foreign_rows bigint;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
            WHERE ns.nspname = 'noticeos' AND c.relkind IN ('r','v') ORDER BY c.relname
  LOOP
    EXECUTE format('SELECT count(*) FILTER (WHERE workspace_id = %L), count(*) FILTER (WHERE workspace_id <> %L) FROM noticeos.%I',
                   current_setting('noticeos.workspace_id'), current_setting('noticeos.workspace_id'), t.relname)
       INTO own, foreign_rows;
    ASSERT foreign_rows = 0, format('%s shows another workspace''s rows', t.relname);
    IF t.relname NOT IN ('current_pulses', 'financial_ledger', 'mediavine_current_daily') THEN
      ASSERT own >= 1, format('%s shows none of the workspace''s own rows — the fixture must fill every table', t.relname);
    END IF;
  END LOOP;
END $$;
COMMIT;

-- ─── 3. No workspace named: nothing is visible and nothing can be written

BEGIN;
DO $$
DECLARE t record; n bigint;
BEGIN
  -- Only the shared vocabulary reads without a workspace.
  SELECT count(*) INTO n FROM noticeos_ref.integrations;
  ASSERT n > 0, 'the shared vocabulary reads the same with no workspace named';
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
            WHERE ns.nspname = 'noticeos' AND c.relkind = 'r'
  LOOP
    EXECUTE format('SELECT count(*) FROM noticeos.%I', t.relname) INTO n;
    ASSERT n = 0, format('%s is visible with no workspace named', t.relname);
  END LOOP;
  -- With two workspaces, the store names no only workspace.
  ASSERT noticeos.only_workspace() IS NULL, 'with two workspaces the store named one of them';
  BEGIN
    INSERT INTO noticeos.annotations (workspace_id, asset_id, at, kind)
    VALUES ('0000000a-0000-4000-8000-00000000000a', 'a.example', now(), 'deploy');
    RAISE EXCEPTION 'an insert with no workspace named was accepted' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
COMMIT;

-- A malformed workspace id fails the query rather than matching anything.
BEGIN;
SELECT set_config('noticeos.workspace_id', 'not-a-uuid', true);
DO $$
BEGIN
  PERFORM count(*) FROM noticeos.assets;
  RAISE EXCEPTION 'a malformed workspace id was accepted' USING ERRCODE = 'ZT001';
EXCEPTION WHEN invalid_text_representation THEN NULL;
END $$;
COMMIT;
RESET ROLE;

-- ─── 4. With A named, B's rows cannot be written, changed, removed or referenced

-- B's own ids, read by the superuser (who is not subject to row security) and
-- handed to the blocks below as session settings.
SELECT set_config('noticeos_test.b_entry', entry_id::text, false)
  FROM noticeos.ledger_entries WHERE workspace_id = :'B' AND kind = 'revenue';
SELECT set_config('noticeos_test.b_change', entry_id::text, false)
  FROM noticeos.ledger_entries WHERE workspace_id = :'B' AND kind = 'change';
SELECT set_config('noticeos_test.b_flag', flag_id::text, false)
  FROM noticeos.flags WHERE workspace_id = :'B';

SET ROLE noticeos_app;
BEGIN;
SELECT set_config('noticeos.workspace_id', :'A', true);
DO $$
DECLARE n bigint;
BEGIN
  -- Writing a row stamped with B.
  BEGIN
    INSERT INTO noticeos.annotations (workspace_id, asset_id, at, kind)
    VALUES ('0000000b-0000-4000-8000-00000000000b', 'b.example', now(), 'deploy');
    RAISE EXCEPTION 'a row for workspace B was written from A' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, amount_minor, currency, booking_state)
    VALUES ('0000000b-0000-4000-8000-00000000000b', 'revenue', 'b.example', '2026-08-01', 'ads', 1, 'USD', 'estimated');
    RAISE EXCEPTION 'money was booked into workspace B from A' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN insufficient_privilege OR raise_exception THEN NULL;
  END;

  -- Referencing B's site from an A row: the composite key has no such parent.
  BEGIN
    INSERT INTO noticeos.annotations (workspace_id, asset_id, at, kind)
    VALUES ('0000000a-0000-4000-8000-00000000000a', 'b.example', now(), 'deploy');
    RAISE EXCEPTION 'an A row referenced a B site' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  -- Correcting B's ledger entry from A.
  BEGIN
    INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, amount_minor, currency,
      booking_state, supersedes_id)
    VALUES ('0000000a-0000-4000-8000-00000000000a', 'revenue', 'a.example', '2026-08-01', 'ads', 1, 'USD', 'reconciled',
            current_setting('noticeos_test.b_entry')::bigint);
    RAISE EXCEPTION 'an A correction superseded a B entry' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN foreign_key_violation OR raise_exception THEN NULL;
  END;
  -- Superseding B's change entry from A, under the change id both use.
  BEGIN
    INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, ref, supersedes_id)
    VALUES ('0000000a-0000-4000-8000-00000000000a', 'change', 'a.example', '2026-09-01', 'copy', 'change-1',
            current_setting('noticeos_test.b_change')::bigint);
    RAISE EXCEPTION 'an A entry superseded a B change' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN foreign_key_violation OR raise_exception THEN NULL;
  END;
  -- A tune filed against B's flag, on a table with no trigger: the composite
  -- foreign key alone refuses it.
  BEGIN
    INSERT INTO noticeos.flag_tunes (workspace_id, flag_id, rule_id, setting, value_from, value_to, tuned_at, actor)
    VALUES ('0000000a-0000-4000-8000-00000000000a', current_setting('noticeos_test.b_flag')::bigint,
            'poisson-drop', 'alpha', 0.01, 0.02, now(), 'operator');
    RAISE EXCEPTION 'an A tune referenced a B flag' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  -- Changing or removing B's rows touches nothing.
  UPDATE noticeos.flags SET resolved_at = now() WHERE workspace_id = '0000000b-0000-4000-8000-00000000000b';
  GET DIAGNOSTICS n = ROW_COUNT;
  ASSERT n = 0, 'an A transaction resolved a B flag';
  DELETE FROM noticeos.item_dispositions WHERE workspace_id = '0000000b-0000-4000-8000-00000000000b';
  GET DIAGNOSTICS n = ROW_COUNT;
  ASSERT n = 0, 'an A transaction removed a B row';

  -- Moving an A row into B: the application may not even name the column.
  BEGIN
    UPDATE noticeos.assets SET workspace_id = '0000000b-0000-4000-8000-00000000000b' WHERE asset_id = 'a.example';
    RAISE EXCEPTION 'the application moved a row between workspaces' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
COMMIT;
RESET ROLE;

-- ─── 5. Forced row security holds for the owner too

SET ROLE noticeos_owner;
BEGIN;
SELECT set_config('noticeos.workspace_id', :'A', true);
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM noticeos.assets WHERE workspace_id = '0000000b-0000-4000-8000-00000000000b';
  ASSERT n = 0, 'the owner saw workspace B from A';
  BEGIN
    UPDATE noticeos.assets SET workspace_id = '0000000b-0000-4000-8000-00000000000b'
     WHERE asset_id = 'a.example' AND is_os = false;
    RAISE EXCEPTION 'the owner moved a row between workspaces' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN insufficient_privilege OR foreign_key_violation THEN NULL;
  END;
  -- The owner reads the list of workspaces (owner_lists_workspaces), and
  -- still changes or removes only the one it named.
  SELECT count(*) INTO n FROM noticeos.workspaces WHERE workspace_id = '0000000b-0000-4000-8000-00000000000b';
  ASSERT n = 1, 'the owner lists every workspace';
  UPDATE noticeos.workspaces SET display_name = 'renamed from A' WHERE workspace_id = '0000000b-0000-4000-8000-00000000000b';
  GET DIAGNOSTICS n = ROW_COUNT;
  ASSERT n = 0, 'the owner renamed workspace B from A';
  DELETE FROM noticeos.workspaces WHERE workspace_id = '0000000b-0000-4000-8000-00000000000b';
  GET DIAGNOSTICS n = ROW_COUNT;
  ASSERT n = 0, 'the owner removed workspace B from A';
END $$;
COMMIT;
RESET ROLE;

-- ─── 6. The application's privileges are the revision rules

SET ROLE noticeos_app;
BEGIN;
SELECT set_config('noticeos.workspace_id', :'A', true);
DO $$
BEGIN
  BEGIN
    UPDATE noticeos.ledger_entries SET amount_minor = 0;
    RAISE EXCEPTION 'the application rewrote booked money' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM noticeos.signal_observations;
    RAISE EXCEPTION 'the application removed an observation' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE noticeos.flags SET message = 'rewritten';
    RAISE EXCEPTION 'the application rewrote a flag''s first evidence' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE noticeos.pulses SET envelope = '{}';
    RAISE EXCEPTION 'the application rewrote a received report' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
COMMIT;
RESET ROLE;

SET ROLE noticeos_owner;
BEGIN;
SELECT set_config('noticeos.workspace_id', :'A', true);
DO $$
BEGIN
  UPDATE noticeos.ledger_entries SET note = 'edited';
  RAISE EXCEPTION 'the owner edited a booked entry' USING ERRCODE = 'ZT001';
EXCEPTION WHEN raise_exception THEN NULL;
END $$;
COMMIT;
RESET ROLE;
