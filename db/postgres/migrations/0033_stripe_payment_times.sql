ALTER TABLE noticeos.revenue_observations
  ADD COLUMN occurred_at timestamptz,
  ADD COLUMN covered_from timestamptz,
  ADD COLUMN covered_until timestamptz,
  ADD CONSTRAINT revenue_observation_collection_interval CHECK (
    (covered_from IS NULL AND covered_until IS NULL)
    OR (covered_from IS NOT NULL AND covered_until IS NOT NULL
      AND covered_from < covered_until AND occurred_at IS NULL AND amount_minor = 0)
  );

CREATE OR REPLACE VIEW noticeos.current_revenue WITH (security_invoker = true) AS
SELECT o.* FROM noticeos.revenue_observations o
 WHERE NOT EXISTS (
   SELECT 1 FROM noticeos.revenue_observations newer
    WHERE newer.workspace_id = o.workspace_id AND newer.asset_id = o.asset_id
      AND newer.source = o.source AND newer.account_ref = o.account_ref
      AND newer.revenue_date = o.revenue_date AND newer.item_ref IS NOT DISTINCT FROM o.item_ref
      AND newer.observation_id > o.observation_id);
