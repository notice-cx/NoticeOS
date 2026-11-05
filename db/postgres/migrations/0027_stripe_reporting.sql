-- Optional sale composition preserves the existing net-receipts ledger.
ALTER TABLE noticeos.revenue_observations ADD COLUMN sales_minor bigint;
ALTER TABLE noticeos.revenue_observations ADD COLUMN refunds_minor bigint;
ALTER TABLE noticeos.revenue_observations ADD COLUMN fees_minor bigint;
ALTER TABLE noticeos.revenue_observations ADD COLUMN payment_count integer;
ALTER TABLE noticeos.revenue_observations ADD COLUMN refund_count integer;
ALTER TABLE noticeos.revenue_observations ADD CONSTRAINT revenue_sales_breakdown CHECK (
  (sales_minor IS NULL AND refunds_minor IS NULL AND fees_minor IS NULL AND payment_count IS NULL AND refund_count IS NULL)
  OR (sales_minor IS NOT NULL AND refunds_minor IS NOT NULL AND fees_minor IS NOT NULL
      AND payment_count IS NOT NULL AND refund_count IS NOT NULL
      AND sales_minor >= 0 AND payment_count >= 0 AND refund_count >= 0
      AND amount_minor = sales_minor - refunds_minor - fees_minor)
);

CREATE OR REPLACE VIEW noticeos.current_revenue WITH (security_invoker = true) AS
SELECT o.* FROM noticeos.revenue_observations o
 WHERE NOT EXISTS (
   SELECT 1 FROM noticeos.revenue_observations newer
    WHERE newer.workspace_id = o.workspace_id AND newer.asset_id = o.asset_id
      AND newer.source = o.source AND newer.account_ref = o.account_ref
      AND newer.revenue_date = o.revenue_date AND newer.item_ref IS NOT DISTINCT FROM o.item_ref
      AND newer.observation_id > o.observation_id);

-- Observed subscription state; it is never backdated to a cash-receipt day.
CREATE TABLE noticeos.stripe_subscription_snapshots (
  workspace_id uuid NOT NULL REFERENCES noticeos.workspaces,
  snapshot_id bigint GENERATED ALWAYS AS IDENTITY,
  asset_id text NOT NULL,
  account_ref text NOT NULL CHECK (account_ref <> ''),
  observed_at timestamptz NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  PRIMARY KEY (workspace_id, snapshot_id),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES noticeos.assets
);
CREATE INDEX stripe_subscription_snapshots_latest ON noticeos.stripe_subscription_snapshots
  (workspace_id, asset_id, account_ref, observed_at DESC, snapshot_id DESC);
ALTER TABLE noticeos.stripe_subscription_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE noticeos.stripe_subscription_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON noticeos.stripe_subscription_snapshots
  USING (workspace_id = noticeos.current_workspace_id())
  WITH CHECK (workspace_id = noticeos.current_workspace_id());
REVOKE ALL ON noticeos.stripe_subscription_snapshots FROM PUBLIC;
GRANT SELECT, INSERT ON noticeos.stripe_subscription_snapshots TO noticeos_app;
GRANT SELECT ON noticeos.stripe_subscription_snapshots TO noticeos_maint;
