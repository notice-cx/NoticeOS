CREATE TABLE noticeos.dataforseo_request_charges (
  workspace_id uuid NOT NULL REFERENCES noticeos.workspaces,
  asset_id text NOT NULL,
  attempt_id uuid NOT NULL,
  request_key text NOT NULL CHECK (request_key ~ '^[0-9a-f]{64}$'),
  reserved_at timestamptz NOT NULL,
  reserve_usd numeric(14,6) NOT NULL CHECK (reserve_usd > 0 AND reserve_usd <> 'NaN'),
  provider_cost_usd numeric(14,6) CHECK (provider_cost_usd >= 0 AND provider_cost_usd <> 'NaN'),
  PRIMARY KEY (workspace_id, attempt_id),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES noticeos.assets
);
CREATE INDEX dataforseo_request_charges_month ON noticeos.dataforseo_request_charges (workspace_id, reserved_at);
CREATE INDEX dataforseo_request_charges_unsettled ON noticeos.dataforseo_request_charges (workspace_id, request_key)
  WHERE provider_cost_usd IS NULL;

ALTER TABLE noticeos.dataforseo_request_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE noticeos.dataforseo_request_charges FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON noticeos.dataforseo_request_charges
  USING (workspace_id = noticeos.current_workspace_id()) WITH CHECK (workspace_id = noticeos.current_workspace_id());
REVOKE ALL ON noticeos.dataforseo_request_charges FROM PUBLIC;
GRANT SELECT, INSERT ON noticeos.dataforseo_request_charges TO noticeos_app;
GRANT UPDATE (provider_cost_usd) ON noticeos.dataforseo_request_charges TO noticeos_app;
GRANT SELECT ON noticeos.dataforseo_request_charges TO noticeos_maint;

CREATE FUNCTION noticeos.settle_dataforseo_request_charge() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.provider_cost_usd IS NOT NULL OR NEW.provider_cost_usd IS NULL THEN
    RAISE EXCEPTION 'DataForSEO attempt cost can only be established once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER settle_dataforseo_request_charge BEFORE UPDATE OF provider_cost_usd
  ON noticeos.dataforseo_request_charges FOR EACH ROW EXECUTE FUNCTION noticeos.settle_dataforseo_request_charge();

-- Preserve the exact cost shown on each archived report. The budget already
-- holds this share at the time its provider calls were made.
ALTER TABLE noticeos.archive_runs ADD COLUMN dataforseo_cost_accounted_usd numeric(14,6) NOT NULL DEFAULT 0
  CHECK (dataforseo_cost_accounted_usd <> 'NaN' AND dataforseo_cost_accounted_usd >= 0
    AND dataforseo_cost_accounted_usd <= coalesce(cost_usd, 0)
    AND (integration = 'dataforseo' OR dataforseo_cost_accounted_usd = 0));
