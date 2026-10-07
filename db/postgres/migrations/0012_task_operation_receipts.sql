-- Retry-safe hosted task writes (epic ro-cvl9). Additive; nothing existing changes.
-- One row per (workspace, principal, operation, idempotency key): the request it
-- was bound to, the server's operation identity, and the recorded outcome. A
-- pending row is an attempt that may still be running; an interrupted row ended
-- with an unknown outcome and is reconciled against task evidence before any
-- retry repeats it.
CREATE TABLE noticeos.task_operation_receipts (
  workspace_id uuid NOT NULL REFERENCES noticeos.workspaces(workspace_id),
  principal_id text NOT NULL CHECK (principal_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'),
  operation text NOT NULL CHECK (operation IN ('create','update','comment','close')),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  project_id uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  operation_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','interrupted','succeeded')),
  attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 5),
  result jsonb CHECK (result IS NULL OR pg_catalog.octet_length(result::text) <= 65536),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  -- The current attempt's start; a retry of an interrupted attempt resets it.
  started_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  finished_at timestamptz,
  CHECK ((state='succeeded') = (result IS NOT NULL)),
  CHECK ((state='pending') = (finished_at IS NULL)),
  CHECK (finished_at IS NULL OR finished_at >= started_at),
  PRIMARY KEY (workspace_id, principal_id, operation, idempotency_key),
  UNIQUE (workspace_id, operation_id)
);
ALTER TABLE noticeos.task_operation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE noticeos.task_operation_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON noticeos.task_operation_receipts
  USING (workspace_id=noticeos.current_workspace_id())
  WITH CHECK (workspace_id=noticeos.current_workspace_id());
REVOKE ALL ON noticeos.task_operation_receipts FROM PUBLIC;
GRANT SELECT,INSERT ON noticeos.task_operation_receipts TO noticeos_app;
GRANT UPDATE(state,attempt,result,started_at,finished_at) ON noticeos.task_operation_receipts TO noticeos_app;
GRANT SELECT ON noticeos.task_operation_receipts TO noticeos_maint;
