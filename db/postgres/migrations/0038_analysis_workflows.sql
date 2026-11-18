CREATE TABLE noticeos.analysis_workflows (
  workspace_id uuid NOT NULL REFERENCES noticeos.workspaces,
  workflow_id uuid NOT NULL,
  create_key text NOT NULL CHECK (create_key ~ '^[A-Za-z0-9._-]{8,128}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  template text NOT NULL CHECK (template IN ('weekly-search-review', 'seo-ai-visibility')),
  asset_ids text[] NOT NULL CHECK (cardinality(asset_ids) BETWEEN 1 AND 8),
  trigger_config jsonb NOT NULL CHECK (jsonb_typeof(trigger_config) = 'object'),
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, workflow_id),
  UNIQUE (workspace_id, create_key)
);

CREATE TABLE noticeos.analysis_workflow_runs (
  workspace_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  run_id uuid NOT NULL,
  request_key text NOT NULL CHECK (char_length(request_key) BETWEEN 8 AND 135),
  source text NOT NULL CHECK (source IN ('manual', 'weekly', 'retry')),
  retry_of uuid,
  scheduled_at timestamptz,
  input jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  result jsonb CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND result ? 'outcome'
    AND COALESCE(result->>'outcome', '') IN ('findings', 'no-action', 'insufficient-evidence', 'failed'))),
  completed_by uuid,
  completed_client_id text,
  completed_at timestamptz,
  PRIMARY KEY (workspace_id, workflow_id, run_id),
  UNIQUE (workspace_id, workflow_id, request_key),
  FOREIGN KEY (workspace_id, workflow_id) REFERENCES noticeos.analysis_workflows,
  FOREIGN KEY (workspace_id, workflow_id, retry_of) REFERENCES noticeos.analysis_workflow_runs,
  CHECK ((source = 'retry') = (retry_of IS NOT NULL)),
  CHECK ((source = 'weekly') = (scheduled_at IS NOT NULL)),
  CHECK ((result IS NULL AND completed_by IS NULL AND completed_client_id IS NULL AND completed_at IS NULL)
    OR (result IS NOT NULL AND completed_by IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX analysis_workflow_runs_history
  ON noticeos.analysis_workflow_runs (workspace_id, workflow_id, created_at DESC, run_id DESC);

ALTER TABLE noticeos.analysis_workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE noticeos.analysis_workflows FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON noticeos.analysis_workflows
  USING (workspace_id = noticeos.current_workspace_id()) WITH CHECK (workspace_id = noticeos.current_workspace_id());
REVOKE ALL ON noticeos.analysis_workflows FROM PUBLIC;
GRANT SELECT, INSERT ON noticeos.analysis_workflows TO noticeos_app;
GRANT UPDATE (enabled, version, updated_at) ON noticeos.analysis_workflows TO noticeos_app;

ALTER TABLE noticeos.analysis_workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE noticeos.analysis_workflow_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON noticeos.analysis_workflow_runs
  USING (workspace_id = noticeos.current_workspace_id()) WITH CHECK (workspace_id = noticeos.current_workspace_id());
REVOKE ALL ON noticeos.analysis_workflow_runs FROM PUBLIC;
GRANT SELECT, INSERT ON noticeos.analysis_workflow_runs TO noticeos_app;
GRANT UPDATE (result, completed_by, completed_client_id, completed_at) ON noticeos.analysis_workflow_runs TO noticeos_app;

CREATE FUNCTION noticeos.complete_analysis_workflow_run() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.result IS NOT NULL OR NEW.result IS NULL THEN
    RAISE EXCEPTION 'Analysis results can only be completed once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER complete_analysis_workflow_run BEFORE UPDATE ON noticeos.analysis_workflow_runs
  FOR EACH ROW EXECUTE FUNCTION noticeos.complete_analysis_workflow_run();

CREATE TABLE noticeos.analysis_workflow_assignments (
  workspace_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  run_id uuid NOT NULL,
  project_id uuid NOT NULL,
  assigned_by uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  delivery_started_at timestamptz,
  task_id text CHECK (task_id ~ '^[a-z0-9]+-[a-z0-9]+(\.[a-z0-9]+)*$' AND char_length(task_id) <= 128),
  linked_at timestamptz,
  PRIMARY KEY (workspace_id, workflow_id, run_id),
  UNIQUE (workspace_id, project_id, task_id),
  FOREIGN KEY (workspace_id, workflow_id, run_id) REFERENCES noticeos.analysis_workflow_runs,
  CHECK ((task_id IS NULL) = (linked_at IS NULL)),
  CHECK (delivery_started_at IS NULL OR delivery_started_at >= started_at),
  CHECK (linked_at IS NULL OR (delivery_started_at IS NOT NULL AND linked_at >= delivery_started_at))
);

ALTER TABLE noticeos.analysis_workflow_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE noticeos.analysis_workflow_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON noticeos.analysis_workflow_assignments
  USING (workspace_id = noticeos.current_workspace_id()) WITH CHECK (workspace_id = noticeos.current_workspace_id());
REVOKE ALL ON noticeos.analysis_workflow_assignments FROM PUBLIC;
GRANT SELECT, INSERT ON noticeos.analysis_workflow_assignments TO noticeos_app;
GRANT UPDATE (delivery_started_at, task_id, linked_at) ON noticeos.analysis_workflow_assignments TO noticeos_app;

CREATE FUNCTION noticeos.link_analysis_workflow_assignment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.delivery_started_at IS NULL AND NEW.delivery_started_at IS NOT NULL AND NEW.task_id IS NULL)
    OR (OLD.delivery_started_at IS NOT NULL AND NEW.delivery_started_at = OLD.delivery_started_at
        AND OLD.task_id IS NULL AND NEW.task_id IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Analysis assignment delivery and linking each happen once' USING ERRCODE = 'check_violation';
END $$;

CREATE TRIGGER link_analysis_workflow_assignment BEFORE UPDATE ON noticeos.analysis_workflow_assignments
  FOR EACH ROW EXECUTE FUNCTION noticeos.link_analysis_workflow_assignment();

GRANT SELECT ON noticeos.analysis_workflows, noticeos.analysis_workflow_runs,
  noticeos.analysis_workflow_assignments TO noticeos_maint;
