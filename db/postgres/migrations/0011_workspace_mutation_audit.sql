-- Actor evidence for asset and finding mutations; no historical authors inferred.
CREATE TABLE noticeos.workspace_mutation_audit (
  workspace_id uuid NOT NULL REFERENCES noticeos.workspaces(workspace_id),
  mutation_id bigint GENERATED ALWAYS AS IDENTITY,
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  actor_kind text NOT NULL CHECK (actor_kind IN ('person','unknown')),
  actor_person_id uuid,
  actor_session_id uuid,
  event text NOT NULL CHECK (event IN (
    'asset.create','asset.column','asset.move',
    'decision.set','decision.clear','annotation.create',
    'flag.acknowledge','flag.resolve','flag.snooze','flag.unsnooze','flag.tune'
  )),
  asset_id text NOT NULL,
  subject jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(subject)='object' AND pg_catalog.octet_length(subject::text)<=8192),
  CHECK ((actor_kind='person' AND actor_person_id IS NOT NULL AND actor_session_id IS NOT NULL)
    OR (actor_kind='unknown' AND actor_person_id IS NULL AND actor_session_id IS NULL)),
  PRIMARY KEY (workspace_id, mutation_id),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES noticeos.assets(workspace_id, asset_id)
);
ALTER TABLE noticeos.workspace_mutation_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE noticeos.workspace_mutation_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON noticeos.workspace_mutation_audit
  USING (workspace_id=noticeos.current_workspace_id())
  WITH CHECK (workspace_id=noticeos.current_workspace_id());
REVOKE ALL ON noticeos.workspace_mutation_audit FROM PUBLIC;
GRANT SELECT,INSERT ON noticeos.workspace_mutation_audit TO noticeos_app;
GRANT SELECT ON noticeos.workspace_mutation_audit TO noticeos_maint;
CREATE FUNCTION noticeos.mutation_audit_is_immutable() RETURNS trigger
  LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'mutation audit: records are immutable';
END
$$;
REVOKE ALL ON FUNCTION noticeos.mutation_audit_is_immutable() FROM PUBLIC;
CREATE TRIGGER mutation_audit_is_immutable BEFORE UPDATE OR DELETE ON noticeos.workspace_mutation_audit
  FOR EACH ROW EXECUTE FUNCTION noticeos.mutation_audit_is_immutable();
