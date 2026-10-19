-- Stripe as a revenue source: what the subscriptions collector
-- (workers/ingest/src/stripe.ts) writes into noticeos.revenue_observations,
-- one row per site per day, the day's net charges less refunds from the
-- connected account's balance transactions, in minor units. Stripe stamps each
-- transaction with an instant, and the collector counts it on the UTC day it
-- falls in; a day is complete from 01:00 UTC.
-- Reference rows only: no table, column or grant changes.

INSERT INTO noticeos_ref.revenue_sources (source, provider, family, display_name, time_zone, time_zone_label, ready_after_minute) VALUES
  ('stripe', 'stripe', 'subs', 'Stripe subscriptions', 'UTC', 'UTC', 60);
