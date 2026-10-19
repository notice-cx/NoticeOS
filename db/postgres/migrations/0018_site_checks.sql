-- Two more daily readings in noticeos.hygiene_checks, one row per site per day
-- each:
--   security-headers — which of six response headers the site's home page
--     sends (Strict-Transport-Security, Content-Security-Policy,
--     X-Content-Type-Options, X-Frame-Options, Referrer-Policy,
--     Permissions-Policy), written by the nightly hygiene sweep
--     (workers/ingest/src/hygiene.ts). value_num is the count present.
--   crux-vitals — the site's origin-level page speed from the Chrome UX
--     Report API: the 75th percentile of LCP, INP and CLS for phones and
--     desktops, written by the daily page-speed job
--     (workers/ingest/src/crux.ts). value_num is the LCP p75 in ms on
--     phones, or on desktops where CrUX holds no phone data.
-- Reference rows only: no table, column or grant changes.

INSERT INTO noticeos_ref.check_kinds (check_id) VALUES
  ('security-headers'), ('crux-vitals');
