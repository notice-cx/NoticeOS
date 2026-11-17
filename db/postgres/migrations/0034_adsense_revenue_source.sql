-- Give the daily collector and manual estimates the same provider identity so
-- the ledger uses the more complete coverage and retains reconciled entries.
INSERT INTO noticeos_ref.revenue_sources (source, provider, family, display_name, time_zone, time_zone_label, ready_after_minute)
VALUES
  ('adsense', 'adsense', 'ads', 'Google AdSense', 'America/Los_Angeles', 'Pacific', 575),
  ('adsense-report', 'adsense', 'ads', 'Google AdSense import', 'America/Los_Angeles', 'Pacific', 575);
