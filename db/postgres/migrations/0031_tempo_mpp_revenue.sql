INSERT INTO noticeos_ref.revenue_sources (source, provider, family, display_name, time_zone, time_zone_label, ready_after_minute)
VALUES ('tempo-mpp', 'tempo-mpp', 'licensing', 'Tempo MPP sales', 'UTC', 'UTC', 0);

CREATE UNIQUE INDEX revenue_observations_tempo_mpp_item
  ON noticeos.revenue_observations (workspace_id, item_ref) WHERE source = 'tempo-mpp';

CREATE TABLE noticeos.tempo_mpp_scans (
  workspace_id     uuid PRIMARY KEY REFERENCES noticeos.workspaces,
  scope            text NOT NULL CHECK (length(scope) > 0),
  next_block       bigint NOT NULL CHECK (next_block >= 0),
  completed_at     timestamptz,
  last_attempt_at  timestamptz NOT NULL,
  failed           boolean NOT NULL
);

CREATE TABLE noticeos.tempo_mpp_payments (
  workspace_id       uuid NOT NULL REFERENCES noticeos.workspaces,
  chain_id           integer NOT NULL CHECK (chain_id IN (4217, 42431)),
  transaction_hash   text NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  log_index          integer NOT NULL CHECK (log_index >= 0),
  asset_id           text NOT NULL,
  token              text NOT NULL CHECK (token ~ '^0x[0-9a-f]{40}$'),
  wallet             text NOT NULL CHECK (wallet ~ '^0x[0-9a-f]{40}$'),
  memo               text NOT NULL CHECK (memo ~ '^0x[0-9a-f]{64}$'),
  amount_base_units  numeric(78,0) NOT NULL CHECK (amount_base_units > 0),
  settled_at         timestamptz NOT NULL,
  observed_at        timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, chain_id, transaction_hash, log_index),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES noticeos.assets
);

CREATE INDEX tempo_mpp_payments_recent ON noticeos.tempo_mpp_payments (workspace_id, settled_at DESC, transaction_hash, log_index);

CREATE TABLE noticeos.tempo_mpp_sale_records (
  workspace_id       uuid NOT NULL REFERENCES noticeos.workspaces,
  asset_id           text NOT NULL,
  chain_id           integer NOT NULL CHECK (chain_id IN (4217, 42431)),
  transaction_hash   text NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  log_index          integer NOT NULL CHECK (log_index >= 0),
  amount_base_units  numeric(78,0) NOT NULL CHECK (amount_base_units > 0),
  product            text CHECK (length(product) BETWEEN 1 AND 120),
  recorded_at        timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, asset_id, chain_id, transaction_hash, log_index),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES noticeos.assets
);

ALTER TABLE noticeos.tempo_mpp_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE noticeos.tempo_mpp_scans FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON noticeos.tempo_mpp_scans
  USING (workspace_id = noticeos.current_workspace_id())
  WITH CHECK (workspace_id = noticeos.current_workspace_id());

ALTER TABLE noticeos.tempo_mpp_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE noticeos.tempo_mpp_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON noticeos.tempo_mpp_payments
  USING (workspace_id = noticeos.current_workspace_id())
  WITH CHECK (workspace_id = noticeos.current_workspace_id());

ALTER TABLE noticeos.tempo_mpp_sale_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE noticeos.tempo_mpp_sale_records FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON noticeos.tempo_mpp_sale_records
  USING (workspace_id = noticeos.current_workspace_id())
  WITH CHECK (workspace_id = noticeos.current_workspace_id());

GRANT SELECT, INSERT ON noticeos.tempo_mpp_scans TO noticeos_app;
GRANT UPDATE (scope, next_block, completed_at, last_attempt_at, failed) ON noticeos.tempo_mpp_scans TO noticeos_app;
GRANT SELECT, INSERT ON noticeos.tempo_mpp_payments, noticeos.tempo_mpp_sale_records TO noticeos_app;
GRANT SELECT ON noticeos.tempo_mpp_scans, noticeos.tempo_mpp_payments, noticeos.tempo_mpp_sale_records TO noticeos_maint;
