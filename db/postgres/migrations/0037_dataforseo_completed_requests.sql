ALTER TABLE noticeos.dataforseo_request_charges ADD COLUMN provider_completed boolean NOT NULL DEFAULT false
  CHECK (NOT provider_completed OR provider_cost_usd IS NOT NULL);

-- An answered request must stay fenced while its archive is being written.
-- Its completion can be set only at the same time as its one cost settlement.
GRANT UPDATE (provider_completed) ON noticeos.dataforseo_request_charges TO noticeos_app;
DROP TRIGGER settle_dataforseo_request_charge ON noticeos.dataforseo_request_charges;
CREATE TRIGGER settle_dataforseo_request_charge BEFORE UPDATE OF provider_cost_usd, provider_completed
  ON noticeos.dataforseo_request_charges FOR EACH ROW EXECUTE FUNCTION noticeos.settle_dataforseo_request_charge();
CREATE INDEX dataforseo_request_charges_completed ON noticeos.dataforseo_request_charges (workspace_id, request_key)
  WHERE provider_completed;
