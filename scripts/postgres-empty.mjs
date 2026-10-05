// A new installation has no user objects in any schema. The intended host
// profile's two extensions alone are allowed, including their dependencies.
// Pure read-only SQL: no startup, migration, driver or runtime imports.
export const EMPTY_INSTALLATION_SQL = `BEGIN READ ONLY;
WITH RECURSIVE profile_objects(classid, objid) AS (
  SELECT 'pg_extension'::regclass AS classid, oid AS objid FROM pg_extension WHERE extname IN ('plpgsql', 'pg_stat_statements')
  UNION
  SELECT d.classid, d.objid FROM pg_depend d JOIN profile_objects p ON d.refclassid = p.classid AND d.refobjid = p.objid
    WHERE d.deptype IN ('e', 'a', 'i')
)
SELECT NOT (
  EXISTS (SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('public', 'information_schema') AND left(nspname, 3) <> 'pg_')
  OR EXISTS (SELECT 1 FROM pg_extension WHERE extname NOT IN ('plpgsql', 'pg_stat_statements'))
  OR EXISTS (SELECT 1 FROM pg_depend d WHERE d.refclassid = 'pg_namespace'::regclass AND d.refobjid = 'public'::regnamespace
    AND NOT EXISTS (SELECT 1 FROM profile_objects p WHERE p.classid = d.classid AND p.objid = d.objid))
  OR EXISTS (SELECT 1 FROM pg_largeobject_metadata)
  OR EXISTS (SELECT 1 FROM pg_default_acl)
) AS empty;
COMMIT;`;
