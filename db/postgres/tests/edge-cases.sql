-- Edge cases, each with the outcome the model accepts: corrections, source
-- changes, money, change entries, NULL and
-- missing data, invalid imports, the writers' own mutations and snapshot
-- moves. Runs as the application role inside workspace A after fixture.sql,
-- and ROLLS BACK, so it leaves the fixture as it found it.

\set A '0000000a-0000-4000-8000-00000000000a'

SET ROLE noticeos_app;
BEGIN;
SELECT set_config('noticeos.workspace_id', :'A', true);

-- ─── Corrections (ledger) ───────────────────────────────────────────────────
DO $$
DECLARE estimate bigint; correction bigint; n bigint;
BEGIN
  INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, amount_minor, currency,
    source, booking_state, external_id)
  VALUES (noticeos.current_workspace_id(), 'revenue', 'a.example', '2026-07-01', 'ads', 1000, 'USD',
    'mediavine', 'estimated', 'edge:estimate')
  RETURNING entry_id INTO estimate;

  -- ACCEPTED: a correction of the same site, month, kind, family and currency.
  INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, amount_minor, currency,
    source, booking_state, supersedes_id, external_id)
  VALUES (noticeos.current_workspace_id(), 'revenue', 'a.example', '2026-07-01', 'ads', 950, 'USD',
    'mediavine', 'reconciled', estimate, 'edge:reconciled')
  RETURNING entry_id INTO correction;

  -- REFUSED: a second successor to the same entry (the chain would branch).
  BEGIN
    INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, amount_minor, currency,
      booking_state, supersedes_id)
    VALUES (noticeos.current_workspace_id(), 'revenue', 'a.example', '2026-07-01', 'ads', 900, 'USD', 'reconciled', estimate);
    RAISE EXCEPTION 'a second successor was accepted' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- REFUSED: a correction that moves money to another month.
  BEGIN
    INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, amount_minor, currency,
      booking_state, supersedes_id)
    VALUES (noticeos.current_workspace_id(), 'revenue', 'a.example', '2026-08-01', 'ads', 900, 'USD', 'reconciled', correction);
    RAISE EXCEPTION 'a cross-month correction was accepted' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  -- REFUSED: the same export booked twice under one external id.
  BEGIN
    INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, amount_minor, currency,
      booking_state, external_id)
    VALUES (noticeos.current_workspace_id(), 'revenue', 'a.example', '2026-07-01', 'ads', 1000, 'USD', 'estimated', 'edge:estimate');
    RAISE EXCEPTION 'a replayed external id booked twice' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- ACCEPTED: exactly one current entry for the chain, read the way readers read it.
  SELECT count(*) INTO n FROM noticeos.ledger_entries l
   WHERE l.asset_id = 'a.example' AND l.period_month = '2026-07-01'
     AND NOT EXISTS (SELECT 1 FROM noticeos.ledger_entries s
                      WHERE s.workspace_id = l.workspace_id AND s.supersedes_id = l.entry_id);
  ASSERT n = 1, 'one current entry per chain';
END $$;

-- ─── Money ───────────────────────────────────────────────────────────────────
DO $$
DECLARE total numeric;
BEGIN
  -- ACCEPTED: amounts beyond 2^53 stay exact (a JavaScript number would not).
  INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, amount_minor, currency, booking_state)
  VALUES (noticeos.current_workspace_id(), 'cost', 'a.example', '2026-06-01', 'infra', 9007199254740993, 'USD', 'reconciled'),
  -- ACCEPTED: a negative adjustment.
         (noticeos.current_workspace_id(), 'cost', 'a.example', '2026-06-01', 'infra', -2, 'USD', 'reconciled');
  SELECT sum(amount_minor) INTO total FROM noticeos.ledger_entries
   WHERE asset_id = 'a.example' AND period_month = '2026-06-01';
  ASSERT total = 9007199254740991, format('exact minor-unit sum, got %s', total);

  -- REFUSED: a currency that is not an upper-case ISO code; a month that is not a month.
  BEGIN
    INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, amount_minor, currency, booking_state)
    VALUES (noticeos.current_workspace_id(), 'cost', 'a.example', '2026-06-01', 'infra', 1, 'usd', 'reconciled');
    RAISE EXCEPTION 'a lower-case currency was accepted' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, amount_minor, currency, booking_state)
    VALUES (noticeos.current_workspace_id(), 'cost', 'a.example', '2026-06-15', 'infra', 1, 'USD', 'reconciled');
    RAISE EXCEPTION 'a mid-month period was accepted' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Provider cost. ACCEPTED: a price below a cent, exactly; an unknown price as NULL.
  INSERT INTO noticeos.research_log (workspace_id, asset_id, provider, endpoint, params_sha256, question, cost_usd,
    cost_state, actor, bought_at)
  VALUES (noticeos.current_workspace_id(), 'a.example', 'dataforseo', 'x', repeat('d', 64), 'priced', 0.000625, 'reported', 'collector', now()),
         (noticeos.current_workspace_id(), NULL, 'dataforseo', 'x', repeat('e', 64), 'unpriced', NULL, 'unknown', 'collector', now());
  SELECT sum(cost_usd) INTO total FROM noticeos.research_log WHERE endpoint = 'x';
  ASSERT total = 0.000625, 'the known subtotal excludes the unknown price instead of counting it as zero';
  -- REFUSED: "unknown" with a number, or "reported" with none.
  BEGIN
    INSERT INTO noticeos.research_log (workspace_id, provider, endpoint, params_sha256, question, cost_usd, cost_state, actor, bought_at)
    VALUES (noticeos.current_workspace_id(), 'dataforseo', 'x', repeat('f', 64), 'q', 0, 'unknown', 'collector', now());
    RAISE EXCEPTION 'an unknown price stored as zero' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- REFUSED: a price that is not a number, in both tables that keep one.
  -- numeric holds 'NaN' at any declared precision and
  -- 'NaN' >= 0 is true, so only the check's own NaN test stops it; an
  -- infinite price is past numeric(14,6) and refused by the type.
  BEGIN
    INSERT INTO noticeos.research_log (workspace_id, provider, endpoint, params_sha256, question, cost_usd, cost_state, actor, bought_at)
    VALUES (noticeos.current_workspace_id(), 'dataforseo', 'x', repeat('f', 64), 'q', 'NaN', 'reported', 'collector', now());
    RAISE EXCEPTION 'a NaN research cost was accepted' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO noticeos.research_log (workspace_id, provider, endpoint, params_sha256, question, cost_usd, cost_state, actor, bought_at)
    VALUES (noticeos.current_workspace_id(), 'dataforseo', 'x', repeat('f', 64), 'q', 'Infinity', 'reported', 'collector', now());
    RAISE EXCEPTION 'an infinite research cost was accepted' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN numeric_value_out_of_range THEN NULL;
  END;
  BEGIN
    INSERT INTO noticeos.archive_runs (workspace_id, run_id, asset_id, integration, report, credential_ref, property_ref,
      report_date, requested_at, finished_at, status, data_state, schema_version, provider_rows, request_count,
      provider_truncated, object_seq, cost_usd, cost_state)
    SELECT noticeos.current_workspace_id(), 'edge-nan-cost', 'a.example', 'ga4', 'pages', 'account-a', 'properties/1',
      '2026-09-04', now(), now(), 'success', 'revision-window', 1, 10, 1, false, object_seq, 'NaN', 'reported'
      FROM noticeos.archive_objects WHERE object_key = 'raw/google/ga4/a.example/pages/2026-09-04/a.json.gz';
    RAISE EXCEPTION 'a NaN archive run cost was accepted' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- ACCEPTED: the same run with a price, so the refusal above was the NaN's.
  INSERT INTO noticeos.archive_runs (workspace_id, run_id, asset_id, integration, report, credential_ref, property_ref,
    report_date, requested_at, finished_at, status, data_state, schema_version, provider_rows, request_count,
    provider_truncated, object_seq, cost_usd, cost_state)
  SELECT noticeos.current_workspace_id(), 'edge-nan-cost', 'a.example', 'ga4', 'pages', 'account-a', 'properties/1',
    '2026-09-04', now(), now(), 'success', 'revision-window', 1, 10, 1, false, object_seq, 0.000625, 'reported'
    FROM noticeos.archive_objects WHERE object_key = 'raw/google/ga4/a.example/pages/2026-09-04/a.json.gz';
  SELECT sum(cost_usd) INTO total FROM noticeos.archive_runs WHERE run_id = 'edge-nan-cost';
  ASSERT total = 0.000625, format('the priced control run was stored, got %s', total);
END $$;

-- The financial view: a full month of daily estimates stands in for an
-- imported estimate that covers less, and never for a reconciled month.
DO $$
DECLARE shown bigint; source_seen text;
BEGIN
  INSERT INTO noticeos.mediavine_runs (workspace_id, run_id, asset_id, site_id, start_date, end_date, attempted_at, outcome)
  VALUES (noticeos.current_workspace_id(), 'mv-june', 'a.example', 'mv-a', '2026-06-01', '2026-06-30', now(), 'success');
  INSERT INTO noticeos.mediavine_daily (workspace_id, run_seq, asset_id, site_id, report_date, amount_minor, recorded_at)
  SELECT noticeos.current_workspace_id(), r.run_seq, 'a.example', 'mv-a', d::date, 100, now()
    FROM noticeos.mediavine_runs r, generate_series('2026-06-01'::date, '2026-06-30'::date, interval '1 day') AS d
   WHERE r.run_id = 'mv-june';
  -- An imported estimate that covered only the first 20 days.
  INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, amount_minor, currency,
    source, booking_state, coverage_start, coverage_end, coverage_complete)
  VALUES (noticeos.current_workspace_id(), 'revenue', 'a.example', '2026-06-01', 'ads', 1800, 'USD',
    'mediavine', 'estimated', '2026-06-01', '2026-06-20', false);
  SELECT amount_minor, source INTO shown, source_seen FROM noticeos.financial_ledger
   WHERE asset_id = 'a.example' AND period_month = '2026-06-01' AND kind = 'revenue';
  ASSERT shown = 3000 AND source_seen = 'mediavine-journey',
    format('30 daily estimates replace a 20-day import, got %s from %s', shown, source_seen);
END $$;

-- ─── financial_ledger: one case per branch of its WHERE ─────────────────────
-- Each condition that decides what a month shows has its own case, one month
-- each, on one site; the outcomes match workers/ingest/test/mediavine.test.ts
-- "daily accounting". `shows` is what readers see for a month: total, row
-- count and the sources shown, in order.
CREATE FUNCTION pg_temp.fl_month(month date) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(sum(amount_minor), 0) || ' in ' || count(*) || ': ' || coalesce(string_agg(coalesce(source, '-'), ',' ORDER BY source), '')
    FROM noticeos.financial_ledger
   WHERE asset_id = 'ledger.example' AND period_month = month AND kind = 'revenue'
$$;
-- A Mediavine run of one site's days `first`..`last` at `amount` each (bar the `gap` day).
CREATE FUNCTION pg_temp.fl_days(run text, first date, last date, amount bigint, gap date DEFAULT NULL) RETURNS void LANGUAGE sql AS $$
  INSERT INTO noticeos.mediavine_runs (workspace_id, run_id, asset_id, site_id, start_date, end_date, attempted_at, outcome)
  VALUES (noticeos.current_workspace_id(), run, 'ledger.example', 'mv-ledger', first, last, now(), 'success');
  INSERT INTO noticeos.mediavine_daily (workspace_id, run_seq, asset_id, site_id, report_date, amount_minor, recorded_at)
  SELECT noticeos.current_workspace_id(), r.run_seq, 'ledger.example', 'mv-ledger', d::date, amount, now()
    FROM noticeos.mediavine_runs r, generate_series(first, last, interval '1 day') AS d
   WHERE r.run_id = run AND d::date IS DISTINCT FROM gap;
$$;
-- One ledger entry for the site; returns its id.
CREATE FUNCTION pg_temp.fl_book(month date, family text, amount bigint, source text, state text,
                                covers_to date DEFAULT NULL, supersedes bigint DEFAULT NULL) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, amount_minor, currency,
    source, booking_state, supersedes_id, coverage_start, coverage_end)
  VALUES (noticeos.current_workspace_id(), 'revenue', 'ledger.example', month, family, amount, 'USD',
    source, state, supersedes, CASE WHEN covers_to IS NOT NULL THEN month END, covers_to)
  RETURNING entry_id
$$;

DO $$
DECLARE shown text; estimate bigint; synthetic record;
BEGIN
  INSERT INTO noticeos.assets (workspace_id, asset_id, domain, display_name, status)
  VALUES (noticeos.current_workspace_id(), 'ledger.example', 'ledger.example', 'ledger', 'live');
  INSERT INTO noticeos.mediavine_sites (workspace_id, site_id, asset_id)
  VALUES (noticeos.current_workspace_id(), 'mv-ledger', 'ledger.example');

  -- ACCEPTED: nothing booked, so the daily month shows as one synthetic
  -- estimate, with a negative id and its own external id.
  PERFORM pg_temp.fl_days('fl-jan', '2025-01-01', '2025-01-31', 100);
  shown := pg_temp.fl_month('2025-01-01');
  ASSERT shown = '3100 in 1: mediavine-journey', format('a daily month alone: %s', shown);
  SELECT entry_id, entry_number, external_id, booking_state INTO synthetic FROM noticeos.financial_ledger
   WHERE asset_id = 'ledger.example' AND period_month = '2025-01-01';
  ASSERT synthetic.entry_id < 0 AND synthetic.external_id = 'mediavine:daily/ledger.example/2025-01'
     AND synthetic.booking_state = 'estimated', format('the synthetic row: %s', synthetic);
  -- Readers show its number: minus the month's first daily number.
  ASSERT synthetic.entry_number = -(SELECT min(daily_number) FROM noticeos.mediavine_daily
                                     WHERE asset_id = 'ledger.example' AND report_date BETWEEN '2025-01-01' AND '2025-01-31'),
    format('the synthetic row''s number: %s', synthetic.entry_number);

  -- An import of unknown coverage gives way only to a month that runs to its
  -- last day (d.last_date < the month's end).
  PERFORM pg_temp.fl_book('2025-02-01', 'ads', 5000, 'mediavine', 'estimated');
  PERFORM pg_temp.fl_days('fl-feb', '2025-02-01', '2025-02-27', 100);
  shown := pg_temp.fl_month('2025-02-01');
  ASSERT shown = '5000 in 1: mediavine', format('27 of 28 days against unknown coverage: %s', shown);
  PERFORM pg_temp.fl_days('fl-feb-last', '2025-02-28', '2025-02-28', 100);
  shown := pg_temp.fl_month('2025-02-01');
  ASSERT shown = '2800 in 1: mediavine-journey', format('the whole month against unknown coverage: %s', shown);

  -- An import that says what it covers gives way once the days reach its
  -- coverage end (coverage_end), not before.
  PERFORM pg_temp.fl_book('2025-03-01', 'ads', 900, 'mediavine', 'estimated', covers_to => '2025-03-10');
  PERFORM pg_temp.fl_days('fl-mar', '2025-03-01', '2025-03-09', 100);
  shown := pg_temp.fl_month('2025-03-01');
  ASSERT shown = '900 in 1: mediavine', format('days short of the import''s coverage: %s', shown);
  PERFORM pg_temp.fl_days('fl-mar-10', '2025-03-10', '2025-03-10', 100);
  shown := pg_temp.fl_month('2025-03-01');
  ASSERT shown = '1000 in 1: mediavine-journey', format('days through the import''s coverage: %s', shown);

  -- REFUSED to stand in: a month that does not start on the 1st
  -- (d.first_date <> d.period_month), even running past the coverage end.
  PERFORM pg_temp.fl_book('2025-04-01', 'ads', 700, 'mediavine', 'estimated', covers_to => '2025-04-05');
  PERFORM pg_temp.fl_days('fl-apr', '2025-04-02', '2025-04-30', 100);
  shown := pg_temp.fl_month('2025-04-01');
  ASSERT shown = '700 in 1: mediavine', format('a month missing its first day: %s', shown);

  -- REFUSED to stand in: a month with a missing day (d.days <> the last day's number).
  PERFORM pg_temp.fl_book('2025-05-01', 'ads', 700, 'mediavine', 'estimated', covers_to => '2025-05-05');
  PERFORM pg_temp.fl_days('fl-may', '2025-05-01', '2025-05-31', 100, gap => '2025-05-15');
  shown := pg_temp.fl_month('2025-05-01');
  ASSERT shown = '700 in 1: mediavine', format('a month with a hole: %s', shown);

  -- A reconciled Mediavine figure is authoritative (the lineage's reconciled
  -- entry, and booking_state = 'reconciled'), and revenue of another family
  -- with no source still counts.
  PERFORM pg_temp.fl_days('fl-jun', '2025-06-01', '2025-06-30', 100);
  PERFORM pg_temp.fl_book('2025-06-01', 'ads', 1200, 'mediavine-journey', 'reconciled');
  PERFORM pg_temp.fl_book('2025-06-01', 'affiliate', 99, NULL, 'estimated');
  shown := pg_temp.fl_month('2025-06-01');
  ASSERT shown = '1299 in 2: mediavine-journey,-', format('a reconciled month: %s', shown);

  -- A payment booked under another source still ends the daily stand-in when
  -- it corrects a Mediavine estimate (the recursive lineage), and the
  -- superseded estimate no longer shows (current_ledger).
  PERFORM pg_temp.fl_days('fl-jul', '2025-07-01', '2025-07-31', 100);
  estimate := pg_temp.fl_book('2025-07-01', 'ads', 1000, 'mediavine-journey', 'estimated');
  PERFORM pg_temp.fl_book('2025-07-01', 'ads', 1100, 'bank-payment', 'reconciled', supersedes => estimate);
  shown := pg_temp.fl_month('2025-07-01');
  ASSERT shown = '1100 in 1: bank-payment', format('a payment under another source: %s', shown);

  -- Only a Mediavine estimate gives way to the daily month: ad revenue from
  -- another source, or none, stays beside it (COALESCE(l.source, '')).
  PERFORM pg_temp.fl_days('fl-aug', '2025-08-01', '2025-08-31', 100);
  PERFORM pg_temp.fl_book('2025-08-01', 'ads', 1000, 'mediavine', 'estimated');
  PERFORM pg_temp.fl_book('2025-08-01', 'ads', 300, NULL, 'estimated');
  shown := pg_temp.fl_month('2025-08-01');
  ASSERT shown = '3400 in 2: mediavine-journey,-', format('a Mediavine estimate beside unrelated ad revenue: %s', shown);

  -- A day fetched again counts once, at its newest amount (mediavine_current_daily).
  PERFORM pg_temp.fl_days('fl-sep', '2025-09-01', '2025-09-30', 100);
  PERFORM pg_temp.fl_days('fl-sep-again', '2025-09-01', '2025-09-01', 250);
  shown := pg_temp.fl_month('2025-09-01');
  ASSERT shown = '3150 in 1: mediavine-journey', format('a re-fetched day: %s', shown);

  -- Kept a view, never materialized: readers always see the ledger as it is.
  ASSERT (SELECT relkind FROM pg_class WHERE oid = 'noticeos.financial_ledger'::regclass) = 'v',
    'financial_ledger is a plain view';

  -- Workspace B books a reconciled figure for its own ledger.example in January.
  PERFORM set_config('noticeos.workspace_id', '0000000b-0000-4000-8000-00000000000b', true);
  INSERT INTO noticeos.assets (workspace_id, asset_id, display_name, status)
  VALUES (noticeos.current_workspace_id(), 'ledger.example', 'ledger', 'live');
  PERFORM pg_temp.fl_book('2025-01-01', 'ads', 1200, 'mediavine', 'reconciled');
  PERFORM set_config('noticeos.workspace_id', '0000000a-0000-4000-8000-00000000000a', true);
END $$;

-- Maintenance reads every workspace at once, and each workspace's months
-- still come out as its own: every join in the view carries workspace_id.
SET LOCAL ROLE noticeos_maint;
DO $$
DECLARE shown text;
BEGIN
  SELECT string_agg(right(workspace_id::text, 1) || ':' || amount_minor || ' ' || source, ', ' ORDER BY workspace_id) INTO shown
    FROM noticeos.financial_ledger WHERE asset_id = 'ledger.example' AND period_month = '2025-01-01';
  ASSERT shown = 'a:3100 mediavine-journey, b:1200 mediavine',
    format('B''s reconciled January must not end A''s daily January: %s', shown);
END $$;
SET LOCAL ROLE noticeos_app;

-- ─── Change entries: the ledger's third kind ─────────────────────────────────
-- A change is booked once, when it ships: its site, the month it shipped, its
-- class, its id and the prediction it shipped with, in its currency. It
-- books no money, and the financial view never counts it. The fixture booked
-- 'change-1' (class copy) on a.example.
DO $$
DECLARE first_entry bigint; closed bigint; n bigint; money_before text; money_after text; bad record;
BEGIN
  SELECT string_agg(kind || ':' || amount_minor, ',' ORDER BY entry_id) INTO money_before FROM noticeos.financial_ledger;

  -- ACCEPTED: a change entry with its class, its id and its prediction (25.00
  -- a month at a 40% chance, for 9.00 all in, read after 28 days), and no money.
  INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, ref, currency,
    predicted_monthly_value_minor, predicted_success_chance, predicted_cost_minor, predicted_days_to_signal, source)
  VALUES (noticeos.current_workspace_id(), 'change', 'a.example', '2026-09-01', 'template', 'change-2', 'USD',
    2500, 0.4, 900, 28, 'operator')
  RETURNING entry_id INTO first_entry;
  -- ACCEPTED: a cost names the change it was spent on by the same id.
  INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, amount_minor, currency,
    ref, booking_state)
  VALUES (noticeos.current_workspace_id(), 'cost', 'a.example', '2026-09-01', 'inference', 240, 'USD', 'change-2', 'reconciled');

  -- REFUSED: a change entry without the prediction it shipped with, or missing
  -- any part of it; a chance outside 0 to 1 (NaN included), a negative cost, a
  -- signal on the day it ships.
  FOR bad IN SELECT * FROM (VALUES
      ('no prediction',         NULL::bigint, NULL::numeric, NULL::bigint, NULL::integer),
      ('no value per month',    NULL, 0.4, 900, 28),
      ('no chance of success',  2500, NULL, 900, 28),
      ('no full cost',          2500, 0.4, NULL, 28),
      ('no time to signal',     2500, 0.4, 900, NULL),
      ('a chance above 1',      2500, 1.2, 900, 28),
      ('a chance that is NaN',  2500, 'NaN', 900, 28),
      ('a negative cost',       2500, 0.4, -1, 28),
      ('a signal on ship day',  2500, 0.4, 900, 0)) AS t(what, value_minor, chance, cost_minor, days)
  LOOP
    BEGIN
      INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, ref, currency,
        predicted_monthly_value_minor, predicted_success_chance, predicted_cost_minor, predicted_days_to_signal)
      VALUES (noticeos.current_workspace_id(), 'change', 'a.example', '2026-09-01', 'copy', 'change-3', 'USD',
        bad.value_minor, bad.chance, bad.cost_minor, bad.days);
      RAISE EXCEPTION 'a change entry was booked with %', bad.what USING ERRCODE = 'ZT001';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  -- REFUSED: revenue or cost carrying any part of a prediction: only a change predicts.
  FOR bad IN SELECT * FROM (VALUES
      ('revenue', 'ads', 2500::bigint, NULL::numeric, NULL::bigint, NULL::integer),
      ('revenue', 'ads', NULL, 0.4, NULL, NULL),
      ('cost',    'api', NULL, NULL, 900, NULL),
      ('cost',    'api', NULL, NULL, NULL, 28)) AS t(kind, family, value_minor, chance, cost_minor, days)
  LOOP
    BEGIN
      INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, amount_minor, currency,
        booking_state, predicted_monthly_value_minor, predicted_success_chance, predicted_cost_minor, predicted_days_to_signal)
      VALUES (noticeos.current_workspace_id(), bad.kind, 'a.example', '2026-09-01', bad.family, 100, 'USD',
        'estimated', bad.value_minor, bad.chance, bad.cost_minor, bad.days);
      RAISE EXCEPTION '% was booked with a prediction', bad.kind USING ERRCODE = 'ZT001';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;

  -- REFUSED: a change entry that names money: an amount, a booking state or a coverage.
  BEGIN
    INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, ref, currency,
      predicted_monthly_value_minor, predicted_success_chance, predicted_cost_minor, predicted_days_to_signal, amount_minor)
    VALUES (noticeos.current_workspace_id(), 'change', 'a.example', '2026-09-01', 'copy', 'change-3', 'USD',
      2500, 0.4, 900, 28, 500);
    RAISE EXCEPTION 'a change entry booked an amount' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, ref, currency,
      predicted_monthly_value_minor, predicted_success_chance, predicted_cost_minor, predicted_days_to_signal, booking_state)
    VALUES (noticeos.current_workspace_id(), 'change', 'a.example', '2026-09-01', 'copy', 'change-3', 'USD',
      2500, 0.4, 900, 28, 'estimated');
    RAISE EXCEPTION 'a change entry named a booking state' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, ref, currency,
      predicted_monthly_value_minor, predicted_success_chance, predicted_cost_minor, predicted_days_to_signal, coverage_end)
    VALUES (noticeos.current_workspace_id(), 'change', 'a.example', '2026-09-01', 'copy', 'change-3', 'USD',
      2500, 0.4, 900, 28, '2026-09-30');
    RAISE EXCEPTION 'a change entry named a coverage' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- REFUSED: a change entry with no currency to state its prediction in.
  BEGIN
    INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, ref,
      predicted_monthly_value_minor, predicted_success_chance, predicted_cost_minor, predicted_days_to_signal)
    VALUES (noticeos.current_workspace_id(), 'change', 'a.example', '2026-09-01', 'copy', 'change-3', 2500, 0.4, 900, 28);
    RAISE EXCEPTION 'a change entry stated its prediction in no currency' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;
  -- REFUSED: a change entry that names no change.
  BEGIN
    INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, currency,
      predicted_monthly_value_minor, predicted_success_chance, predicted_cost_minor, predicted_days_to_signal)
    VALUES (noticeos.current_workspace_id(), 'change', 'a.example', '2026-09-01', 'copy', 'USD', 2500, 0.4, 900, 28);
    RAISE EXCEPTION 'a change entry named no change' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- REFUSED: a change under a money family; money under a change class.
  BEGIN
    INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, ref, currency,
      predicted_monthly_value_minor, predicted_success_chance, predicted_cost_minor, predicted_days_to_signal)
    VALUES (noticeos.current_workspace_id(), 'change', 'a.example', '2026-09-01', 'ads', 'change-3', 'USD', 2500, 0.4, 900, 28);
    RAISE EXCEPTION 'a change was booked as ad revenue''s family' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, amount_minor, currency, booking_state)
    VALUES (noticeos.current_workspace_id(), 'cost', 'a.example', '2026-09-01', 'copy', 1, 'USD', 'reconciled');
    RAISE EXCEPTION 'a cost was booked under a change class' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- REFUSED: money with no amount, currency or booking state (revenue and cost as before).
  BEGIN
    INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, currency, booking_state)
    VALUES (noticeos.current_workspace_id(), 'revenue', 'a.example', '2026-09-01', 'ads', 'USD', 'estimated');
    RAISE EXCEPTION 'revenue was booked with no amount' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, amount_minor, booking_state)
    VALUES (noticeos.current_workspace_id(), 'cost', 'a.example', '2026-09-01', 'api', 1, 'reconciled');
    RAISE EXCEPTION 'a cost was booked with no currency' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, amount_minor, currency)
    VALUES (noticeos.current_workspace_id(), 'cost', 'a.example', '2026-09-01', 'api', 1, 'USD');
    RAISE EXCEPTION 'a cost was booked with no booking state' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- REFUSED: the same change booked a second time.
  BEGIN
    INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, ref, currency,
      predicted_monthly_value_minor, predicted_success_chance, predicted_cost_minor, predicted_days_to_signal)
    VALUES (noticeos.current_workspace_id(), 'change', 'a.example', '2026-09-01', 'template', 'change-2', 'USD', 2500, 0.4, 900, 28);
    RAISE EXCEPTION 'one change was booked twice' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- ACCEPTED: a correction of a change entry is a new entry of the same site,
  -- month, class and change, repeating its prediction, that supersedes it
  -- (here, the change's revert).
  INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, ref, currency,
    predicted_monthly_value_minor, predicted_success_chance, predicted_cost_minor, predicted_days_to_signal, supersedes_id, note)
  VALUES (noticeos.current_workspace_id(), 'change', 'a.example', '2026-09-01', 'template', 'change-2', 'USD',
    2500, 0.4, 900, 28, first_entry, 'reverted')
  RETURNING entry_id INTO closed;
  -- REFUSED: a correction that names another change, another class or another
  -- month, or that states another prediction: no correction edits the
  -- prediction a change shipped with.
  FOR bad IN SELECT * FROM (VALUES
      ('moved to another change',       'change-1', 'template', '2026-09-01'::date, 2500::bigint, 0.4::numeric, 900::bigint, 28),
      ('re-classed a change',           'change-2', 'feature',  '2026-09-01', 2500, 0.4, 900, 28),
      ('moved a change to another month', 'change-2', 'template', '2026-10-01', 2500, 0.4, 900, 28),
      ('raised the predicted value',    'change-2', 'template', '2026-09-01', 5000, 0.4, 900, 28),
      ('raised the chance of success',  'change-2', 'template', '2026-09-01', 2500, 0.9, 900, 28),
      ('lowered the full cost',         'change-2', 'template', '2026-09-01', 2500, 0.4, 100, 28),
      ('moved the time to signal',      'change-2', 'template', '2026-09-01', 2500, 0.4, 900, 14))
    AS t(what, ref, family, period_month, value_minor, chance, cost_minor, days)
  LOOP
    BEGIN
      INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, ref, currency,
        predicted_monthly_value_minor, predicted_success_chance, predicted_cost_minor, predicted_days_to_signal, supersedes_id)
      VALUES (noticeos.current_workspace_id(), 'change', 'a.example', bad.period_month, bad.family, bad.ref, 'USD',
        bad.value_minor, bad.chance, bad.cost_minor, bad.days, closed);
      RAISE EXCEPTION 'a correction %', bad.what USING ERRCODE = 'ZT001';
    EXCEPTION WHEN raise_exception THEN NULL;
    END;
  END LOOP;
  -- REFUSED: a second successor to the same change entry.
  BEGIN
    INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, ref, currency,
      predicted_monthly_value_minor, predicted_success_chance, predicted_cost_minor, predicted_days_to_signal, supersedes_id)
    VALUES (noticeos.current_workspace_id(), 'change', 'a.example', '2026-09-01', 'template', 'change-2', 'USD',
      2500, 0.4, 900, 28, first_entry);
    RAISE EXCEPTION 'a change''s chain branched' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- REFUSED: the application rewriting a change entry: its class, or the prediction it shipped with.
  BEGIN
    UPDATE noticeos.ledger_entries SET family = 'feature' WHERE entry_id = first_entry;
    RAISE EXCEPTION 'the application re-classed a booked change' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE noticeos.ledger_entries SET predicted_success_chance = 0.9 WHERE entry_id = first_entry;
    RAISE EXCEPTION 'the application edited a shipped prediction' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- ACCEPTED: one current entry per change, read the way readers read it.
  SELECT count(*) INTO n FROM noticeos.ledger_entries l
   WHERE l.kind = 'change' AND l.ref = 'change-2'
     AND NOT EXISTS (SELECT 1 FROM noticeos.ledger_entries s
                      WHERE s.workspace_id = l.workspace_id AND s.supersedes_id = l.entry_id);
  ASSERT n = 1, 'one current entry per change';
  -- The financial view shows money only: no change entry, and the cost spent
  -- on the change beside the money it showed before.
  SELECT count(*) INTO n FROM noticeos.financial_ledger WHERE kind = 'change';
  ASSERT n = 0, 'the financial view never shows a change entry';
  SELECT string_agg(kind || ':' || amount_minor, ',' ORDER BY entry_id) INTO money_after FROM noticeos.financial_ledger;
  ASSERT money_after = money_before || ',cost:240', format('only the cost was added to the money: %s, then %s', money_before, money_after);
END $$;

-- REFUSED: the owner, who may update what the application may not, editing a
-- shipped prediction: the ledger's immutability trigger holds the line.
SET LOCAL ROLE noticeos_owner;
DO $$
BEGIN
  UPDATE noticeos.ledger_entries SET predicted_monthly_value_minor = 9999
   WHERE kind = 'change' AND ref = 'change-2' AND supersedes_id IS NULL;
  RAISE EXCEPTION 'the owner edited a shipped prediction' USING ERRCODE = 'ZT001';
EXCEPTION WHEN raise_exception THEN NULL;
END $$;
SET LOCAL ROLE noticeos_app;

-- ─── Source changes (series identity) ───────────────────────────────────────
DO $$
DECLARE old_series bigint; new_series bigint; zone_series bigint; n bigint;
BEGIN
  SELECT series_id INTO old_series FROM noticeos.measurement_series
   WHERE asset_id = 'a.example' AND property_ref = 'properties/1' AND metric = 'sessions';
  -- ACCEPTED: rotating the credential keeps the series; the same key is refused as a new one.
  BEGIN
    INSERT INTO noticeos.measurement_series (workspace_id, asset_id, integration, property_ref, time_zone, metric)
    VALUES (noticeos.current_workspace_id(), 'a.example', 'ga4', 'properties/1', 'UTC', 'sessions');
    RAISE EXCEPTION 'a credential rotation minted a second series' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- ACCEPTED: a new property is a new series, even when its first value equals the old one.
  INSERT INTO noticeos.measurement_series (workspace_id, asset_id, integration, property_ref, time_zone, metric)
  VALUES (noticeos.current_workspace_id(), 'a.example', 'ga4', 'properties/2', 'UTC', 'sessions')
  RETURNING series_id INTO new_series;
  -- ACCEPTED: a new reporting zone is a new series.
  INSERT INTO noticeos.measurement_series (workspace_id, asset_id, integration, property_ref, time_zone, metric)
  VALUES (noticeos.current_workspace_id(), 'a.example', 'ga4', 'properties/1', 'America/New_York', 'sessions')
  RETURNING series_id INTO zone_series;
  -- NULL zone matches only NULL: two NULL-zone series with one key are one series.
  INSERT INTO noticeos.measurement_series (workspace_id, asset_id, integration, property_ref, time_zone, metric)
  VALUES (noticeos.current_workspace_id(), 'a.example', 'bing-webmaster', 'site-1', NULL, 'clicks');
  BEGIN
    INSERT INTO noticeos.measurement_series (workspace_id, asset_id, integration, property_ref, time_zone, metric)
    VALUES (noticeos.current_workspace_id(), 'a.example', 'bing-webmaster', 'site-1', NULL, 'clicks');
    RAISE EXCEPTION 'a NULL zone was treated as distinct' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  INSERT INTO noticeos.signal_runs (workspace_id, run_id, asset_id, integration, credential_ref, property_ref, time_zone,
    started_at, finished_at, status, window_start, window_end, data_state, provider_rows, observation_count)
  VALUES (noticeos.current_workspace_id(), 'run-2', 'a.example', 'ga4', 'account-b', 'properties/2', 'UTC',
    now(), now(), 'success', '2026-08-08', '2026-09-04', 'final', 28, 1);
  -- The equal value 120 on the same day is recorded for the new series, not suppressed.
  INSERT INTO noticeos.signal_observations (workspace_id, run_seq, series_id, observed_date, value)
  SELECT noticeos.current_workspace_id(), run_seq, new_series, '2026-09-04', 120
    FROM noticeos.signal_runs WHERE run_id = 'run-2';
  SELECT count(*) INTO n FROM noticeos.signal_observations WHERE observed_date = '2026-09-04' AND value = 120;
  ASSERT n = 2, 'both series keep their own value for the day';
  ASSERT old_series <> new_series AND new_series <> zone_series, 'three distinct series';

  -- REFUSED: a metric the integration does not report, and an integration
  -- the shared vocabulary does not know (noticeos_ref).
  BEGIN
    INSERT INTO noticeos.measurement_series (workspace_id, asset_id, integration, property_ref, time_zone, metric)
    VALUES (noticeos.current_workspace_id(), 'a.example', 'gsc', 'sc-domain:a', NULL, 'sessions');
    RAISE EXCEPTION 'a metric Search Console does not report was accepted' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO noticeos.signal_runs (workspace_id, run_id, asset_id, integration, credential_ref, property_ref,
      started_at, finished_at, status, window_start, window_end, data_state, provider_rows, observation_count)
    VALUES (noticeos.current_workspace_id(), 'run-unknown', 'a.example', 'unknown-source', 'x', 'y',
      now(), now(), 'success', '2026-09-04', '2026-09-04', 'final', 0, 0);
    RAISE EXCEPTION 'an unknown integration was accepted' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  -- REFUSED: a watch on a metric its integration does not report; a check the
  -- hygiene lane does not run.
  BEGIN
    INSERT INTO noticeos.watch_windows (workspace_id, window_id, asset_id, ref_kind, ref, metric_integration, metric,
      registered_at, baseline_start, baseline_end, check_offsets)
    VALUES (noticeos.current_workspace_id(), 'watch-bad', 'a.example', 'manual', 'x', 'bing-webmaster', 'ctr',
      '2026-09-01T00:00:00Z', '2026-08-04', '2026-08-31', '{7}');
    RAISE EXCEPTION 'a watch on a metric Bing does not report was accepted' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO noticeos.hygiene_checks (workspace_id, asset_id, check_id, observed_at, observed_on, status)
    VALUES (noticeos.current_workspace_id(), 'a.example', 'no-such-check', '2026-09-06T04:00:00Z', '2026-09-06', 'ok');
    RAISE EXCEPTION 'an unknown check was accepted' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  -- REFUSED: the application adding to the shared vocabulary; that is a migration.
  BEGIN
    INSERT INTO noticeos_ref.integrations (integration, provider, display_name) VALUES ('plausible', 'plausible', 'Plausible');
    RAISE EXCEPTION 'the application added an integration' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- ─── A same-day report retry is a new revision, not an overwrite ────────────
DO $$
DECLARE current_revision integer;
BEGIN
  INSERT INTO noticeos.pulses (workspace_id, asset_id, pulse_date, revision, envelope)
  VALUES (noticeos.current_workspace_id(), 'a.example', '2026-09-01', 2, '{"asset":"x","metrics":{"retry":true}}');
  SELECT revision INTO current_revision FROM noticeos.current_pulses
   WHERE asset_id = 'a.example' AND pulse_date = '2026-09-01';
  ASSERT current_revision = 2, 'the newest revision is the current report';
  BEGIN
    INSERT INTO noticeos.pulses (workspace_id, asset_id, pulse_date, revision, envelope)
    VALUES (noticeos.current_workspace_id(), 'a.example', '2026-09-01', 2, '{}');
    RAISE EXCEPTION 'a revision number was reused' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- REFUSED: malformed JSON and an impossible date.
  BEGIN
    INSERT INTO noticeos.pulses (workspace_id, asset_id, pulse_date, envelope)
    VALUES (noticeos.current_workspace_id(), 'a.example', '2026-09-02', '{not json');
    RAISE EXCEPTION 'a malformed envelope was accepted' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN invalid_text_representation THEN NULL;
  END;
  BEGIN
    INSERT INTO noticeos.pulses (workspace_id, asset_id, pulse_date, envelope)
    VALUES (noticeos.current_workspace_id(), 'a.example', '2026-02-30', '{}');
    RAISE EXCEPTION 'an impossible date was accepted' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN NULL;
  END;
END $$;

-- ─── A retry replaces its earlier revision's untouched alerts ───────────────
DO $$
DECLARE first_rev bigint; second_rev bigint; touched bigint; untouched bigint; shown integer; day integer;
BEGIN
  INSERT INTO noticeos.pulses (workspace_id, asset_id, pulse_date, envelope)
  VALUES (noticeos.current_workspace_id(), 'a.example', '2026-09-03', '{}') RETURNING pulse_id INTO first_rev;
  INSERT INTO noticeos.pulses (workspace_id, asset_id, pulse_date, revision, envelope)
  VALUES (noticeos.current_workspace_id(), 'a.example', '2026-09-03', 2, '{}') RETURNING pulse_id INTO second_rev;
  INSERT INTO noticeos.flags (workspace_id, asset_id, pulse_id, fired_at, severity, kind, rule_id)
  VALUES (noticeos.current_workspace_id(), 'a.example', first_rev, now(), 'warn', 'anomaly', 'retry-untouched')
  RETURNING flag_id INTO untouched;
  INSERT INTO noticeos.flags (workspace_id, asset_id, pulse_id, fired_at, severity, kind, rule_id, disposition, disposition_at)
  VALUES (noticeos.current_workspace_id(), 'a.example', first_rev, now(), 'warn', 'anomaly', 'retry-touched', 'ack', now())
  RETURNING flag_id INTO touched;
  UPDATE noticeos.flags SET replaced_by_pulse_id = second_rev WHERE flag_id = untouched;
  SELECT count(*) INTO shown FROM noticeos.current_flags WHERE flag_id IN (touched, untouched);
  ASSERT shown = 1, 'a replaced alert is in no list; the one the operator touched stays';
  -- Both revisions are one report: the day's first revision numbers it.
  SELECT count(DISTINCT day_number) INTO day FROM noticeos.current_pulses
   WHERE asset_id = 'a.example' AND pulse_date = '2026-09-03';
  ASSERT day = 1, 'a day has one report';
  -- REFUSED: replacing an alert the operator touched, or resolving or
  -- dispositioning a replaced one. Replaced is not resolved.
  BEGIN
    UPDATE noticeos.flags SET replaced_by_pulse_id = second_rev WHERE flag_id = touched;
    RAISE EXCEPTION 'an alert the operator touched was replaced' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE noticeos.flags SET resolved_at = now() WHERE flag_id = untouched;
    RAISE EXCEPTION 'a replaced alert was resolved' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE noticeos.flags SET disposition = 'ack', disposition_at = now() WHERE flag_id = untouched;
    RAISE EXCEPTION 'a replaced alert was dispositioned' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- REFUSED: an alert replaced by its own report.
  BEGIN
    UPDATE noticeos.flags SET replaced_by_pulse_id = first_rev WHERE flag_id = untouched;
    RAISE EXCEPTION 'an alert was replaced by its own report' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- ─── An alert reads as its newest reading ───────────────────────────────────
DO $$
DECLARE held bigint; now_reads noticeos.current_flags%ROWTYPE; stored_message text;
BEGIN
  INSERT INTO noticeos.flags (workspace_id, asset_id, fired_at, severity, kind, message, rule_id, rule_inputs)
  VALUES (noticeos.current_workspace_id(), 'a.example', '2026-09-04T00:00:00Z', 'warn', 'anomaly', 'first night', 'still-open', '{"night": 1}')
  RETURNING flag_id INTO held;
  INSERT INTO noticeos.flag_evidence (workspace_id, flag_id, observed_at, severity, message, rule_inputs)
  VALUES (noticeos.current_workspace_id(), held, '2026-09-05T00:00:00Z', 'error', 'third night', '{"night": 3}'),
         (noticeos.current_workspace_id(), held, '2026-09-04T12:00:00Z', 'warn', 'second night', '{"night": 2}');
  SELECT * INTO now_reads FROM noticeos.current_flags WHERE flag_id = held;
  ASSERT now_reads.message = 'third night' AND now_reads.severity = 'error' AND now_reads.rule_inputs = '{"night": 3}',
    'an alert reads as its newest reading';
  ASSERT now_reads.fired_at = '2026-09-04T00:00:00Z', 'and still dates its first';
  SELECT message INTO stored_message FROM noticeos.flags WHERE flag_id = held;
  ASSERT stored_message = 'first night', 'the row keeps its first evidence';
END $$;

-- ─── Records that belong together stay together ─────────────────────────────
DO $$
DECLARE other_pulse bigint;
BEGIN
  INSERT INTO noticeos.assets (workspace_id, asset_id, display_name, status)
  VALUES (noticeos.current_workspace_id(), 'second.example', 'second', 'live');
  INSERT INTO noticeos.pulses (workspace_id, asset_id, pulse_date, envelope)
  VALUES (noticeos.current_workspace_id(), 'second.example', '2026-09-01', '{}')
  RETURNING pulse_id INTO other_pulse;
  -- REFUSED: a flag on one site citing another site's report.
  BEGIN
    INSERT INTO noticeos.flags (workspace_id, asset_id, pulse_id, fired_at, severity, kind, rule_id)
    VALUES (noticeos.current_workspace_id(), 'a.example', other_pulse, now(), 'warn', 'anomaly', 'r');
    RAISE EXCEPTION 'a flag cited another site''s report' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  -- REFUSED: a daily revenue fact filed under another site's run.
  INSERT INTO noticeos.mediavine_sites (workspace_id, site_id, asset_id)
  VALUES (noticeos.current_workspace_id(), 'mv-second', 'second.example');
  BEGIN
    INSERT INTO noticeos.mediavine_daily (workspace_id, run_seq, asset_id, site_id, report_date, amount_minor, recorded_at)
    SELECT noticeos.current_workspace_id(), run_seq, 'second.example', 'mv-second', '2026-09-02', 1, now()
      FROM noticeos.mediavine_runs WHERE run_id = 'mv-run-1';
    RAISE EXCEPTION 'a daily fact joined another site''s run' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  -- REFUSED: a second reclamation row for one page, and "no page" spelled NULL.
  BEGIN
    INSERT INTO noticeos.reclamation_targets (workspace_id, asset_id, domain, referring_page)
    VALUES (noticeos.current_workspace_id(), 'a.example', 'links.example', '');
    RAISE EXCEPTION 'one page was queued twice' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO noticeos.reclamation_targets (workspace_id, asset_id, domain, referring_page)
    VALUES (noticeos.current_workspace_id(), 'a.example', 'links.example', NULL);
    RAISE EXCEPTION 'a NULL page defeated the unique key' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;
END $$;

-- ─── NULL and missing data keep their meaning ───────────────────────────────
DO $$
BEGIN
  -- ACCEPTED: "not measured" is NULL, next to a real zero.
  INSERT INTO noticeos.hygiene_checks (workspace_id, asset_id, check_id, observed_at, observed_on, status, value_num)
  VALUES (noticeos.current_workspace_id(), 'a.example', 'sitemap', '2026-09-05T04:00:00Z', '2026-09-05', 'unreachable', NULL),
         (noticeos.current_workspace_id(), 'a.example', 'html-depth', '2026-09-06T04:00:00Z', '2026-09-06', 'error', 0);
  -- ACCEPTED: a quiet night — nothing open, no median.
  INSERT INTO noticeos.alert_daily_counts (workspace_id, asset_id, day, observed_at, open, errors, warnings, median_open_age_hours)
  VALUES (noticeos.current_workspace_id(), NULL, '2026-09-06', now(), 0, 0, 0, NULL);
  -- ACCEPTED: an inbox count nobody measured stays NULL.
  INSERT INTO noticeos.task_daily_counts (workspace_id, project, day, captured_at, waiting, urgent, open, in_progress, blocked, closed_ids)
  VALUES (noticeos.current_workspace_id(), 'a', '2026-09-06', now(), NULL, NULL, 0, 0, 0, NULL);
  -- REFUSED: a value that is not a number; a negative count; a split larger than the whole.
  BEGIN
    INSERT INTO noticeos.hygiene_checks (workspace_id, asset_id, check_id, observed_at, observed_on, status, value_num)
    VALUES (noticeos.current_workspace_id(), 'a.example', 'robots-ai-access', '2026-09-06T04:00:00Z', '2026-09-06', 'ok', 'NaN');
    RAISE EXCEPTION 'NaN stored as a reading' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO noticeos.alert_daily_counts (workspace_id, asset_id, day, observed_at, open, errors, warnings)
    VALUES (noticeos.current_workspace_id(), 'a.example', '2026-09-06', now(), -1, 0, 0);
    RAISE EXCEPTION 'a negative count was accepted' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO noticeos.alert_daily_counts (workspace_id, asset_id, day, observed_at, open, errors, warnings)
    VALUES (noticeos.current_workspace_id(), 'a.example', '2026-09-07', now(), 1, 1, 1);
    RAISE EXCEPTION 'more errors and warnings than open alerts' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- REFUSED: a median open age that is not a number or is infinite
  -- ('NaN' >= 0 and 'Infinity' >= 0 are both true in Postgres).
  BEGIN
    INSERT INTO noticeos.alert_daily_counts (workspace_id, asset_id, day, observed_at, open, errors, warnings, median_open_age_hours)
    VALUES (noticeos.current_workspace_id(), 'a.example', '2026-09-08', now(), 1, 0, 0, 'NaN');
    RAISE EXCEPTION 'a NaN median open age was accepted' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO noticeos.alert_daily_counts (workspace_id, asset_id, day, observed_at, open, errors, warnings, median_open_age_hours)
    VALUES (noticeos.current_workspace_id(), 'a.example', '2026-09-08', now(), 1, 0, 0, 'Infinity');
    RAISE EXCEPTION 'an infinite median open age was accepted' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- REFUSED: a hygiene reading dated to a day its own instant is not on.
  BEGIN
    INSERT INTO noticeos.hygiene_checks (workspace_id, asset_id, check_id, observed_at, observed_on, status)
    VALUES (noticeos.current_workspace_id(), 'a.example', 'page-structure', '2026-09-06T23:30:00Z', '2026-09-07', 'ok');
    RAISE EXCEPTION 'observed_on disagreed with observed_at' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- ─── A watch reads each offset once ──────────────────────────────────────────
DO $$
BEGIN
  BEGIN
    INSERT INTO noticeos.watch_window_readings (workspace_id, window_id, offset_days, check_date, checked_at, final, pre_change_days)
    VALUES (noticeos.current_workspace_id(), 'watch-1', 7, '2026-09-08', now(), false, 0);
    RAISE EXCEPTION 'an offset was read twice' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

-- ─── A lease has one holder at a time ───────────────────────────────────────
-- The Workers' take (workers/ingest/src/ga4-read-cache.ts, posthog-dumps.ts)
-- in Postgres: one statement inserts the lease or takes over an expired one,
-- and returns the row only to the taker (ON CONFLICT DO UPDATE is atomic).
DO $$
DECLARE taken text; n bigint;
BEGIN
  INSERT INTO noticeos.integration_leases AS l (workspace_id, lease_key, owner, expires_at)
  VALUES (noticeos.current_workspace_id(), 'ga4-read:a.example', 'runner-1', now() + interval '5 minutes')
  ON CONFLICT (workspace_id, lease_key) DO UPDATE SET owner = EXCLUDED.owner, expires_at = EXCLUDED.expires_at
   WHERE l.expires_at <= now()
  RETURNING owner INTO taken;
  ASSERT taken = 'runner-1', 'a free lease is taken';
  -- REFUSED: taking a held lease, or renewing someone else's.
  INSERT INTO noticeos.integration_leases AS l (workspace_id, lease_key, owner, expires_at)
  VALUES (noticeos.current_workspace_id(), 'ga4-read:a.example', 'runner-2', now() + interval '5 minutes')
  ON CONFLICT (workspace_id, lease_key) DO UPDATE SET owner = EXCLUDED.owner, expires_at = EXCLUDED.expires_at
   WHERE l.expires_at <= now()
  RETURNING owner INTO taken;
  ASSERT taken IS NULL, 'a held lease is not taken';
  UPDATE noticeos.integration_leases SET expires_at = now() + interval '10 minutes'
   WHERE lease_key = 'ga4-read:a.example' AND owner = 'runner-2';
  GET DIAGNOSTICS n = ROW_COUNT;
  ASSERT n = 0, 'only the holder renews';
  -- ACCEPTED: once the holder's time runs out, the next taker gets it.
  UPDATE noticeos.integration_leases SET expires_at = now() - interval '1 second'
   WHERE lease_key = 'ga4-read:a.example' AND owner = 'runner-1';
  INSERT INTO noticeos.integration_leases AS l (workspace_id, lease_key, owner, expires_at)
  VALUES (noticeos.current_workspace_id(), 'ga4-read:a.example', 'runner-2', now() + interval '5 minutes')
  ON CONFLICT (workspace_id, lease_key) DO UPDATE SET owner = EXCLUDED.owner, expires_at = EXCLUDED.expires_at
   WHERE l.expires_at <= now()
  RETURNING owner INTO taken;
  ASSERT taken = 'runner-2', 'an expired lease is taken over';
  DELETE FROM noticeos.integration_leases WHERE lease_key = 'ga4-read:a.example' AND owner = 'runner-1';
  GET DIAGNOSTICS n = ROW_COUNT;
  ASSERT n = 0, 'a former holder cannot release it';
END $$;

-- ─── Invalid imports are refused ────────────────────────────────────────────
DO $$
DECLARE other_series bigint; fixture_series bigint;
BEGIN
  -- REFUSED: a settings document that is not JSON, or neither an object nor
  -- a list. ACCEPTED: a list, the shape of a register that is one
  -- (config/pull.json).
  BEGIN
    INSERT INTO noticeos.config_documents (workspace_id, document_key, body, version, updated_at)
    VALUES (noticeos.current_workspace_id(), 'broken', '{', 1, now());
    RAISE EXCEPTION 'a malformed settings document was accepted' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN invalid_text_representation THEN NULL;
  END;
  BEGIN
    INSERT INTO noticeos.config_documents (workspace_id, document_key, body, version, updated_at)
    VALUES (noticeos.current_workspace_id(), 'scalar', '"text"', 1, now());
    RAISE EXCEPTION 'a settings document that is neither an object nor a list was accepted' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO noticeos.config_documents (workspace_id, document_key, body, version, updated_at)
  VALUES (noticeos.current_workspace_id(), 'listed', E'[\n  {\n    "asset": "a.example"\n  }\n]\n', 1, now());
  -- REFUSED: a change filed under a file path instead of its document key.
  BEGIN
    INSERT INTO noticeos.config_changes (workspace_id, document_key, ops, actor, version_before, version_after, changed_at)
    VALUES (noticeos.current_workspace_id(), 'config/tower.json', '[]', 'config:seed', 0, 1, now());
    RAISE EXCEPTION 'a file path was stored as a document key' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- REFUSED: a report envelope that is not an object.
  BEGIN
    INSERT INTO noticeos.pulses (workspace_id, asset_id, pulse_date, envelope)
    VALUES (noticeos.current_workspace_id(), 'a.example', '2026-09-03', '[]');
    RAISE EXCEPTION 'an envelope that is not an object was accepted' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- REFUSED: a lease flag that is not a boolean (the audit's auth_blocked = 7).
  BEGIN
    INSERT INTO noticeos.integration_leases (workspace_id, lease_key, owner, expires_at, auth_blocked)
    VALUES (noticeos.current_workspace_id(), 'audit', 'runner-1', now(), 7);
    RAISE EXCEPTION 'a lease flag of 7 was accepted' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN datatype_mismatch THEN NULL;
  END;
  -- REFUSED: an insight payload that is not an object; a hash that is not lower-case hex.
  BEGIN
    INSERT INTO noticeos.asset_insight_snapshots (workspace_id, snapshot_id, asset_id, generated_at,
      source_archive_count, content_sha256, payload)
    VALUES (noticeos.current_workspace_id(), 'listed', 'a.example', now(), 0, repeat('d', 64), '[]');
    RAISE EXCEPTION 'an insight payload that is not an object was accepted' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO noticeos.asset_insight_snapshots (workspace_id, snapshot_id, asset_id, generated_at,
      source_archive_count, content_sha256, payload)
    VALUES (noticeos.current_workspace_id(), 'shouting', 'a.example', now(), 0, repeat('D', 64), '{}');
    RAISE EXCEPTION 'an upper-case content hash was accepted' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- REFUSED: a collection window that ends before it starts, and a first
  -- provisional day after the window.
  BEGIN
    INSERT INTO noticeos.signal_runs (workspace_id, run_id, asset_id, integration, credential_ref, property_ref, time_zone,
      started_at, finished_at, status, window_start, window_end, data_state, provider_rows, observation_count)
    VALUES (noticeos.current_workspace_id(), 'run-backwards', 'a.example', 'ga4', 'account-a', 'properties/1', 'UTC',
      now(), now(), 'success', '2026-09-04', '2026-08-08', 'final', 0, 0);
    RAISE EXCEPTION 'a backwards window was accepted' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO noticeos.signal_runs (workspace_id, run_id, asset_id, integration, credential_ref, property_ref, time_zone,
      started_at, finished_at, status, window_start, window_end, data_state, provisional_from, provider_rows, observation_count)
    VALUES (noticeos.current_workspace_id(), 'run-late', 'a.example', 'ga4', 'account-a', 'properties/1', 'UTC',
      now(), now(), 'success', '2026-08-08', '2026-09-04', 'includes-provisional', '2026-09-05', 0, 0);
    RAISE EXCEPTION 'a provisional day after the window was accepted' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- ACCEPTED: GA4 settles back from the window's end, so on a one-day window
  -- the first provisional day falls before the start.
  INSERT INTO noticeos.signal_runs (workspace_id, run_id, asset_id, integration, credential_ref, property_ref, time_zone,
    started_at, finished_at, status, window_start, window_end, data_state, provisional_from, provider_rows, observation_count)
  VALUES (noticeos.current_workspace_id(), 'run-one-day', 'a.example', 'ga4', 'account-a', 'properties/1', 'UTC',
    now(), now(), 'success', '2026-09-04', '2026-09-04', 'includes-provisional', '2026-09-02', 1, 0);
  -- REFUSED: an empty identifier.
  BEGIN
    INSERT INTO noticeos.signal_runs (workspace_id, run_id, asset_id, integration, credential_ref, property_ref,
      started_at, finished_at, status, window_start, window_end, data_state, provider_rows, observation_count)
    VALUES (noticeos.current_workspace_id(), '', 'a.example', 'ga4', 'account-a', 'properties/1',
      now(), now(), 'success', '2026-09-04', '2026-09-04', 'final', 0, 0);
    RAISE EXCEPTION 'an empty run id was accepted' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- REFUSED: an observation filed under another property's series, or under
  -- a run that failed. Each parent exists; they do not agree.
  SELECT series_id INTO fixture_series FROM noticeos.measurement_series
   WHERE asset_id = 'a.example' AND property_ref = 'properties/1' AND time_zone = 'UTC' AND metric = 'sessions';
  INSERT INTO noticeos.measurement_series (workspace_id, asset_id, integration, property_ref, time_zone, metric)
  VALUES (noticeos.current_workspace_id(), 'a.example', 'ga4', 'properties/9', 'UTC', 'sessions')
  RETURNING series_id INTO other_series;
  BEGIN
    INSERT INTO noticeos.signal_observations (workspace_id, run_seq, series_id, observed_date, value)
    SELECT noticeos.current_workspace_id(), run_seq, other_series, '2026-09-03', 5
      FROM noticeos.signal_runs WHERE run_id = 'run-1';
    RAISE EXCEPTION 'an observation joined another property''s series' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO noticeos.signal_runs (workspace_id, run_id, asset_id, integration, credential_ref, property_ref, time_zone,
    started_at, finished_at, status, window_start, window_end, data_state, provider_rows, observation_count,
    error_code, error_message)
  VALUES (noticeos.current_workspace_id(), 'run-failed', 'a.example', 'ga4', 'account-a', 'properties/1', 'UTC',
    now(), now(), 'error', '2026-08-08', '2026-09-04', 'final', 0, 0, 'ga4_http_500', 'provider error');
  BEGIN
    INSERT INTO noticeos.signal_observations (workspace_id, run_seq, series_id, observed_date, value)
    SELECT noticeos.current_workspace_id(), run_seq, fixture_series, '2026-09-03', 5
      FROM noticeos.signal_runs WHERE run_id = 'run-failed';
    RAISE EXCEPTION 'an observation was filed under a failed run' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- ─── Numbers a workspace hands out ──────────────────────────────────────────
-- Readers show flag_number, pulse_number, … and never the identity, which is
-- one sequence shared by every workspace. Each workspace counts its own.
DO $$
DECLARE
  numbered text[] := ARRAY[['assets', 'list_position'], ['pulses', 'pulse_number'], ['flags', 'flag_number'], ['annotations', 'annotation_number'],
                           ['research_log', 'research_number'], ['hygiene_checks', 'reading_number'],
                           ['reclamation_targets', 'target_number'], ['ledger_entries', 'entry_number'],
                           ['mediavine_daily', 'daily_number'], ['config_changes', 'change_number'],
                           ['job_runs', 'job_run_number']];
  ws text;
  i int;
  lowest bigint;
  b_flag record;
  b_before bigint;
  b_next bigint;
  added bigint[];
  n bigint;
BEGIN
  -- ACCEPTED: each workspace's first row of every numbered table is its
  -- number 1 (the fixture wrote one in each, A's first and then B's).
  FOREACH ws IN ARRAY ARRAY['0000000a-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-00000000000b'] LOOP
    PERFORM set_config('noticeos.workspace_id', ws, true);
    FOR i IN 1 .. array_length(numbered, 1) LOOP
      EXECUTE format('SELECT min(%I) FROM noticeos.%I', numbered[i][2], numbered[i][1]) INTO lowest;
      ASSERT lowest = 1, format('%s in workspace %s starts at %s, not 1', numbered[i][1], ws, lowest);
    END LOOP;
  END LOOP;
  -- B's alert is its number 1, though the shared identity counted A's first.
  SELECT flag_id, flag_number INTO b_flag FROM noticeos.flags ORDER BY flag_number LIMIT 1;
  ASSERT b_flag.flag_number = 1 AND b_flag.flag_id > 1, format('B''s first alert: %s', b_flag);

  -- ACCEPTED: A's writes leave B's next number where it was.
  SELECT max(annotation_number) INTO b_before FROM noticeos.annotations;
  PERFORM set_config('noticeos.workspace_id', '0000000a-0000-4000-8000-00000000000a', true);
  WITH written AS (
    INSERT INTO noticeos.annotations (workspace_id, asset_id, at, kind)
    SELECT noticeos.current_workspace_id(), 'a.example', now(), 'deploy' FROM generate_series(1, 3)
    RETURNING annotation_number)
  SELECT array_agg(annotation_number ORDER BY annotation_number) INTO added FROM written;
  ASSERT added[2] = added[1] + 1 AND added[3] = added[1] + 2, format('A numbers its rows one after another: %s', added);
  PERFORM set_config('noticeos.workspace_id', '0000000b-0000-4000-8000-00000000000b', true);
  INSERT INTO noticeos.annotations (workspace_id, asset_id, at, kind)
  VALUES (noticeos.current_workspace_id(), 'b.example', now(), 'deploy')
  RETURNING annotation_number INTO b_next;
  ASSERT b_next = b_before + 1, format('three annotations in A moved B''s next number from %s to %s', b_before + 1, b_next);
  -- ACCEPTED: B's counters are all B sees; A's are not among them.
  SELECT count(*) INTO n FROM noticeos.workspace_counters WHERE workspace_id <> noticeos.current_workspace_id();
  ASSERT n = 0, 'B saw another workspace''s counters';
  PERFORM set_config('noticeos.workspace_id', '0000000a-0000-4000-8000-00000000000a', true);

  -- ACCEPTED: a refused insert uses up no number.
  BEGIN
    INSERT INTO noticeos.annotations (workspace_id, asset_id, at, kind)
    VALUES (noticeos.current_workspace_id(), 'a.example', now(), 'not-a-kind');
    RAISE EXCEPTION 'an unknown annotation kind was accepted' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO noticeos.annotations (workspace_id, asset_id, at, kind)
  VALUES (noticeos.current_workspace_id(), 'a.example', now(), 'deploy')
  RETURNING annotation_number INTO n;
  ASSERT n = added[3] + 1, format('a refused insert used up a number: the next is %s, not %s', n, added[3] + 1);

  -- REFUSED: the application choosing a number, or changing one.
  BEGIN
    INSERT INTO noticeos.annotations (workspace_id, annotation_number, asset_id, at, kind)
    VALUES (noticeos.current_workspace_id(), 999, 'a.example', now(), 'deploy');
    RAISE EXCEPTION 'the application chose its own number' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE noticeos.flags SET flag_number = flag_number + 100;
    RAISE EXCEPTION 'the application renumbered an alert' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- REFUSED: a counter moving back, which would hand a number out twice.
  BEGIN
    UPDATE noticeos.workspace_counters SET last_number = 1 WHERE counter = 'annotation_number';
    RAISE EXCEPTION 'a counter moved back' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- REFUSED: A advancing B's counter; it is not there to change.
  UPDATE noticeos.workspace_counters SET last_number = last_number + 1
   WHERE workspace_id = '0000000b-0000-4000-8000-00000000000b';
  GET DIAGNOSTICS n = ROW_COUNT;
  ASSERT n = 0, 'A advanced B''s counter';
END $$;

-- The importer runs as the owner and keeps the numbers a legacy store handed
-- out (mapping.json `conversions`).
SET LOCAL ROLE noticeos_owner;
DO $$
BEGIN
  -- ACCEPTED: the owner brings a legacy number.
  INSERT INTO noticeos.annotations (workspace_id, annotation_number, asset_id, at, kind)
  VALUES (noticeos.current_workspace_id(), 500, 'a.example', '2025-01-01T00:00:00Z', 'external');
  -- REFUSED: a number another row of the workspace already has.
  BEGIN
    INSERT INTO noticeos.annotations (workspace_id, annotation_number, asset_id, at, kind)
    VALUES (noticeos.current_workspace_id(), 500, 'a.example', '2025-01-02T00:00:00Z', 'external');
    RAISE EXCEPTION 'one number was given to two annotations' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- ACCEPTED: the owner brings a site's place, as an importer brings an
  -- existing order.
  INSERT INTO noticeos.assets (workspace_id, asset_id, display_name, status, list_position)
  VALUES (noticeos.current_workspace_id(), 'imported.example', 'imported', 'live', 700);
END $$;
SET LOCAL ROLE noticeos_app;

-- ─── The order of sites ─────────────────────────────────────────────────────
-- Every list of sites is ordered by each site's place, list_position. The
-- same counter as the numbers above hands a new site its place; a move deals
-- the places of the sites it spans out again, in two steps, since a place is
-- unique row by row as an UPDATE runs.
DO $$
DECLARE
  first_place bigint;
  second_place bigint;
  counter_at bigint;
  n bigint;
BEGIN
  -- ACCEPTED: a new site takes the next place, past every place, the one the
  -- owner brought above included.
  INSERT INTO noticeos.assets (workspace_id, asset_id, display_name, status)
  VALUES (noticeos.current_workspace_id(), 'order-one.example', 'Order one', 'onboarding')
  RETURNING list_position INTO first_place;
  ASSERT first_place = 701, format('a new site took place %s, not the one after the imported 700', first_place);
  INSERT INTO noticeos.assets (workspace_id, asset_id, display_name, status)
  VALUES (noticeos.current_workspace_id(), 'order-two.example', 'Order two', 'onboarding')
  RETURNING list_position INTO second_place;
  ASSERT second_place = first_place + 1, format('the next new site took place %s', second_place);

  -- ACCEPTED: retiring a site keeps its place.
  UPDATE noticeos.assets SET status = 'retired', updated_at = now() WHERE asset_id = 'order-one.example'
  RETURNING list_position INTO n;
  ASSERT n = first_place, 'retiring a site moved it';

  -- REFUSED: the application choosing a new site's place.
  BEGIN
    INSERT INTO noticeos.assets (workspace_id, asset_id, display_name, status, list_position)
    VALUES (noticeos.current_workspace_id(), 'chosen.example', 'chosen', 'onboarding', 1000);
    RAISE EXCEPTION 'the application chose a new site''s place' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- REFUSED: two sites at one place, and a place before the first.
  BEGIN
    UPDATE noticeos.assets SET list_position = first_place WHERE asset_id = 'order-two.example';
    RAISE EXCEPTION 'two sites shared one place' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    UPDATE noticeos.assets SET list_position = 0 WHERE asset_id = 'order-two.example';
    RAISE EXCEPTION 'a site was placed before the first place' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- ACCEPTED: a move, in two steps: the span steps above every place the
  -- counter handed out, then each site takes its new place.
  SELECT last_number INTO counter_at FROM noticeos.workspace_counters WHERE counter = 'list_position' FOR UPDATE;
  UPDATE noticeos.assets SET list_position = list_position + counter_at
   WHERE list_position BETWEEN first_place AND second_place;
  UPDATE noticeos.assets SET list_position = CASE asset_id WHEN 'order-two.example' THEN first_place ELSE second_place END,
         updated_at = now()
   WHERE asset_id IN ('order-one.example', 'order-two.example');
  SELECT count(*) INTO n FROM noticeos.assets
   WHERE (asset_id, list_position) IN (('order-two.example', first_place), ('order-one.example', second_place));
  ASSERT n = 2, 'the move did not swap the two places';
  SELECT last_number INTO n FROM noticeos.workspace_counters WHERE counter = 'list_position';
  ASSERT n = counter_at, 'a move changed the counter';
END $$;
DO $$
DECLARE n bigint;
BEGIN
  -- ACCEPTED: the next number the store hands out is past the imported one.
  INSERT INTO noticeos.annotations (workspace_id, asset_id, at, kind)
  VALUES (noticeos.current_workspace_id(), 'a.example', now(), 'deploy')
  RETURNING annotation_number INTO n;
  ASSERT n = 501, format('after an imported 500 the store handed out %s', n);
END $$;

-- ─── Normal writers stay valid ──────────────────────────────────────────────
-- Each sanctioned mutation, made the way today's writers make it, by the
-- application role.
DO $$
DECLARE flag bigint; n bigint;
BEGIN
  -- An alert is acknowledged, a later reading is appended, and it resolves.
  SELECT flag_id INTO flag FROM noticeos.flags WHERE asset_id = 'a.example' ORDER BY flag_id LIMIT 1;
  UPDATE noticeos.flags SET disposition = 'ack', disposition_at = now(), ack_expiry = now() + interval '7 days'
   WHERE flag_id = flag;
  INSERT INTO noticeos.flag_evidence (workspace_id, flag_id, observed_at, severity, message, rule_inputs)
  VALUES (noticeos.current_workspace_id(), flag, now(), 'warn', 'still fewer views', '{"observed":3}');
  UPDATE noticeos.flags SET resolved_at = now() WHERE flag_id = flag;

  -- A same-day hygiene re-run replaces that day's reading.
  UPDATE noticeos.hygiene_checks SET observed_at = '2026-09-05T05:00:00Z', status = 'warn', value_num = 400,
         detail = '{"status":200}'
   WHERE asset_id = 'a.example' AND check_id = 'html-depth' AND observed_on = '2026-09-05';
  GET DIAGNOSTICS n = ROW_COUNT;
  ASSERT n = 1, 'a same-day hygiene re-run replaces its reading';

  -- A watch closes; the operator's settings are saved with their change record.
  UPDATE noticeos.watch_windows SET status = 'closed', outcome = 'inconclusive', closed_at = now(),
         outcome_note = 'no thresholds', last_checked_at = now()
   WHERE window_id = 'watch-1';
  UPDATE noticeos.config_documents SET body = E'{\n  "panels": [1]\n}\n', version = 2, updated_at = now(), updated_by = 'tower'
   WHERE document_key = 'tower';
  INSERT INTO noticeos.config_changes (workspace_id, document_key, ops, reason, actor, version_before, version_after, changed_at)
  VALUES (noticeos.current_workspace_id(), 'tower', '[{"op":"add","path":"/panels/0","value":1}]', 'save', 'tower', 1, 2, now());

  -- Dated summaries are upserted, the whole-workspace row included: a NULL
  -- site is one row per day, so the upsert finds it instead of adding another.
  INSERT INTO noticeos.alert_daily_counts (workspace_id, asset_id, day, observed_at, open, errors, warnings, median_open_age_hours)
  VALUES (noticeos.current_workspace_id(), NULL, '2026-09-05', now(), 2, 1, 1, 10)
  ON CONFLICT (workspace_id, asset_id, day) DO UPDATE
    SET observed_at = EXCLUDED.observed_at, open = EXCLUDED.open, errors = EXCLUDED.errors,
        warnings = EXCLUDED.warnings, median_open_age_hours = EXCLUDED.median_open_age_hours;
  SELECT count(*) INTO n FROM noticeos.alert_daily_counts WHERE asset_id IS NULL AND day = '2026-09-05';
  ASSERT n = 1, 'the whole-workspace row was upserted, not duplicated';

  -- An account-level capability names its target once (a NULL site is one
  -- value there), and its state is upserted by that target.
  FOR i IN 1..2 LOOP
    INSERT INTO noticeos.capability_targets (workspace_id, provider, connection_revision, capability, asset_id, target_id, family)
    VALUES (noticeos.current_workspace_id(), 'dataforseo', 'rev-1', 'account-credit', NULL, 'account', '')
    ON CONFLICT DO NOTHING;
    INSERT INTO noticeos.integration_capability_state (workspace_id, target_seq, attempt_id, started_at, finished_at,
      outcome, evidence_source, evidence_id)
    SELECT noticeos.current_workspace_id(), target_seq, 'attempt-' || i, now(), now(), 'success', 'archive_runs', 'dump-1'
      FROM noticeos.capability_targets WHERE capability = 'account-credit'
    ON CONFLICT (workspace_id, target_seq) DO UPDATE
      SET attempt_id = EXCLUDED.attempt_id, started_at = EXCLUDED.started_at, finished_at = EXCLUDED.finished_at;
  END LOOP;
  SELECT count(*) INTO n FROM noticeos.capability_targets WHERE capability = 'account-credit';
  ASSERT n = 1, 'an account-level target is one row';
  SELECT count(*) INTO n FROM noticeos.integration_capability_state s
    JOIN noticeos.capability_targets t USING (workspace_id, target_seq)
   WHERE t.capability = 'account-credit' AND s.attempt_id = 'attempt-2';
  ASSERT n = 1, 'an account-level state is one row per target, rewritten in place';

  -- Current state is replaced in place; coordination state comes and goes.
  INSERT INTO noticeos.counter_readings (workspace_id, asset_id, metric, value, observed_at)
  VALUES (noticeos.current_workspace_id(), 'a.example', 'signups', 43, now())
  ON CONFLICT (workspace_id, asset_id, metric) DO UPDATE SET value = EXCLUDED.value, observed_at = EXCLUDED.observed_at;
  UPDATE noticeos.integration_leases SET expires_at = now() + interval '5 minutes', auth_blocked = true;
  DELETE FROM noticeos.integration_leases;
  UPDATE noticeos.mediavine_state SET attempts = attempts + 1, next_attempt_at = now(), last_error = 'timeout';

  -- An unchanged task board re-stamps its photograph; old photographs are swept.
  UPDATE noticeos.task_snapshots SET captured_at = now();
  DELETE FROM noticeos.task_snapshots WHERE captured_at < now() - interval '7 days';
  DELETE FROM noticeos.job_runs WHERE started_at < now() - interval '30 days';

  -- A marked query is undone; a site is retired, its only exit.
  DELETE FROM noticeos.item_dispositions WHERE item_key = 'synthetic query';
  UPDATE noticeos.assets SET status = 'retired', updated_at = now() WHERE asset_id = 'a.example';

  -- REFUSED: deleting a site, even one with no history; and a second site
  -- on a domain another already has.
  INSERT INTO noticeos.assets (workspace_id, asset_id, display_name, status)
  VALUES (noticeos.current_workspace_id(), 'mistake.example', 'mistake', 'onboarding');
  BEGIN
    DELETE FROM noticeos.assets WHERE asset_id = 'mistake.example';
    RAISE EXCEPTION 'the application deleted a site' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO noticeos.assets (workspace_id, asset_id, domain, display_name, status)
    VALUES (noticeos.current_workspace_id(), 'twin.example', 'a.example', 'twin', 'onboarding');
    RAISE EXCEPTION 'two sites shared one domain' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

-- ─── Insight snapshots: the two newest stay, older ones move ────────────────
-- The site page reads a site's newest snapshot and the Wall's feed compares it
-- with the one before, so the two newest stay. The fixture
-- holds snapshot-0 (its move recorded), snapshot-1 and snapshot-2 for a.example.
DO $$
BEGIN
  INSERT INTO noticeos.asset_insight_snapshots (workspace_id, snapshot_id, asset_id, generated_at,
    source_archive_count, content_sha256, payload)
  VALUES (noticeos.current_workspace_id(), 'snapshot-old', 'a.example', '2026-09-03T13:00:00Z', 0, repeat('e', 64), '{"items":[]}');
  -- REFUSED: the application moving or removing a snapshot; that is the mover's,
  -- as noticeos_maint.
  BEGIN
    INSERT INTO noticeos.asset_insight_snapshot_moves (workspace_id, snapshot_id, asset_id, content_sha256, dataset_key, moved_at)
    VALUES (noticeos.current_workspace_id(), 'snapshot-old', 'a.example', repeat('e', 64), 'analytics/x.parquet', now());
    RAISE EXCEPTION 'the application recorded a move' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM noticeos.asset_insight_snapshots WHERE snapshot_id = 'snapshot-0';
    RAISE EXCEPTION 'the application removed a snapshot' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

SET LOCAL ROLE noticeos_maint;
DO $$
DECLARE n bigint; kept text; kept_hash text;
BEGIN
  -- REFUSED: moving either of a site's two newest snapshots.
  FOREACH kept IN ARRAY ARRAY['snapshot-2', 'snapshot-1'] LOOP
    SELECT content_sha256 INTO kept_hash FROM noticeos.asset_insight_snapshots
     WHERE workspace_id = noticeos.current_workspace_id() AND snapshot_id = kept;
    BEGIN
      INSERT INTO noticeos.asset_insight_snapshot_moves (workspace_id, snapshot_id, asset_id, content_sha256, dataset_key, moved_at)
      VALUES (noticeos.current_workspace_id(), kept, 'a.example', kept_hash, 'analytics/x.parquet', now());
      RAISE EXCEPTION '% was moved while one of the two newest', kept USING ERRCODE = 'ZT001';
    EXCEPTION WHEN check_violation THEN
      ASSERT SQLERRM LIKE '%two newest%', format('moving %s was refused for another reason: %s', kept, SQLERRM);
    END;
  END LOOP;
  -- REFUSED: a move whose hash is not the stored snapshot's.
  BEGIN
    INSERT INTO noticeos.asset_insight_snapshot_moves (workspace_id, snapshot_id, asset_id, content_sha256, dataset_key, moved_at)
    VALUES (noticeos.current_workspace_id(), 'snapshot-old', 'a.example', repeat('f', 64), 'analytics/x.parquet', now());
    RAISE EXCEPTION 'a move with the wrong hash was recorded' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  -- REFUSED: removing an older snapshot whose move is not recorded.
  BEGIN
    DELETE FROM noticeos.asset_insight_snapshots
     WHERE workspace_id = noticeos.current_workspace_id() AND snapshot_id = 'snapshot-old';
    RAISE EXCEPTION 'a snapshot left without its move recorded' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- ACCEPTED: the next-older snapshot, its move recorded, leaves. (Maintenance
  -- sees every workspace, so it names the one it means.)
  DELETE FROM noticeos.asset_insight_snapshots
   WHERE workspace_id = noticeos.current_workspace_id() AND snapshot_id = 'snapshot-0';
  GET DIAGNOSTICS n = ROW_COUNT;
  ASSERT n = 1, 'a moved snapshot older than the two newest may leave';
  -- REFUSED: removing either of the two newest, for that reason.
  FOREACH kept IN ARRAY ARRAY['snapshot-2', 'snapshot-1'] LOOP
    BEGIN
      DELETE FROM noticeos.asset_insight_snapshots
       WHERE workspace_id = noticeos.current_workspace_id() AND snapshot_id = kept;
      RAISE EXCEPTION '% was removed while one of the two newest', kept USING ERRCODE = 'ZT001';
    EXCEPTION WHEN check_violation THEN
      ASSERT SQLERRM LIKE '%two newest%', format('removing %s was refused for another reason: %s', kept, SQLERRM);
    END;
  END LOOP;
  ASSERT noticeos.insight_snapshot_is_kept(noticeos.current_workspace_id(), 'a.example', 'snapshot-2')
     AND noticeos.insight_snapshot_is_kept(noticeos.current_workspace_id(), 'a.example', 'snapshot-1')
     AND NOT noticeos.insight_snapshot_is_kept(noticeos.current_workspace_id(), 'a.example', 'snapshot-old'),
    'the two newest are the ones readers show';
END $$;
SET LOCAL ROLE noticeos_app;

-- A newer analysis arrives: the snapshot that was second-newest is now the
-- next-older, and may move and leave.
INSERT INTO noticeos.asset_insight_snapshots (workspace_id, snapshot_id, asset_id, generated_at,
  source_archive_count, content_sha256, payload)
VALUES (noticeos.current_workspace_id(), 'snapshot-3', 'a.example', '2026-09-07T13:00:00Z', 0, repeat('7', 64), '{"items":[]}');
SET LOCAL ROLE noticeos_maint;
DO $$
DECLARE n bigint;
BEGIN
  INSERT INTO noticeos.asset_insight_snapshot_moves (workspace_id, snapshot_id, asset_id, content_sha256, dataset_key, moved_at)
  VALUES (noticeos.current_workspace_id(), 'snapshot-1', 'a.example', repeat('c', 64), 'analytics/x.parquet', now());
  DELETE FROM noticeos.asset_insight_snapshots
   WHERE workspace_id = noticeos.current_workspace_id() AND snapshot_id = 'snapshot-1';
  GET DIAGNOSTICS n = ROW_COUNT;
  ASSERT n = 1, 'the former second-newest may leave once a newer one arrives and its move is recorded';
  ASSERT noticeos.insight_snapshot_is_kept(noticeos.current_workspace_id(), 'a.example', 'snapshot-3')
     AND noticeos.insight_snapshot_is_kept(noticeos.current_workspace_id(), 'a.example', 'snapshot-2'),
    'the two newest are now snapshot-3 and snapshot-2';
END $$;
SET LOCAL ROLE noticeos_app;

-- ─── History past its window moves to the analytical store ──────────────────
-- An old run and its observation, written by the application; the removals
-- are the maintenance role's.
DO $$
DECLARE old_series bigint;
BEGIN
  SELECT series_id INTO old_series FROM noticeos.measurement_series
   WHERE asset_id = 'a.example' AND property_ref = 'properties/1' AND time_zone = 'UTC' AND metric = 'sessions';
  INSERT INTO noticeos.signal_runs (workspace_id, run_id, asset_id, integration, credential_ref, property_ref, time_zone,
    started_at, finished_at, status, window_start, window_end, data_state, provider_rows, observation_count)
  VALUES (noticeos.current_workspace_id(), 'run-2024', 'a.example', 'ga4', 'account-a', 'properties/1', 'UTC',
    '2024-01-02T00:00:00Z', '2024-01-02T00:00:05Z', 'success', '2023-12-06', '2024-01-01', 'final', 28, 1);
  INSERT INTO noticeos.signal_observations (workspace_id, run_seq, series_id, observed_date, value)
  SELECT noticeos.current_workspace_id(), run_seq, old_series, '2024-01-01', 77
    FROM noticeos.signal_runs WHERE run_id = 'run-2024';
  -- REFUSED: the application removing history.
  BEGIN
    DELETE FROM noticeos.signal_observations WHERE observed_date = '2024-01-01';
    RAISE EXCEPTION 'the application removed an observation' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

SET LOCAL ROLE noticeos_maint;
DO $$
DECLARE n bigint;
BEGIN
  -- It sees every workspace: no row security binds it.
  SELECT count(DISTINCT workspace_id) INTO n FROM noticeos.assets;
  ASSERT n = 2, 'noticeos_maint reads across workspaces';
  -- REFUSED: removing an observation inside the window the store keeps, even
  -- one the export already covers.
  INSERT INTO noticeos.analytical_exports (workspace_id, table_name, exported_through, dataset_key, exported_at)
  VALUES ('0000000b-0000-4000-8000-00000000000b', 'signal_observations', '2026-12-31', 'analytics/b.parquet', now());
  BEGIN
    DELETE FROM noticeos.signal_observations
     WHERE workspace_id = '0000000b-0000-4000-8000-00000000000b' AND observed_date = '2026-09-04';
    RAISE EXCEPTION 'an observation inside its window was removed' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- REFUSED: removing an old run the export has not covered (only
  -- observations are exported for workspace A, through 2024-06-30).
  DELETE FROM noticeos.signal_observations WHERE observed_date = '2024-01-01';
  GET DIAGNOSTICS n = ROW_COUNT;
  ASSERT n = 1, 'an old observation the export covers may leave';
  BEGIN
    DELETE FROM noticeos.signal_runs WHERE run_id = 'run-2024';
    RAISE EXCEPTION 'an unexported run was removed' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- ACCEPTED once its export is recorded.
  INSERT INTO noticeos.analytical_exports (workspace_id, table_name, exported_through, dataset_key, exported_at)
  VALUES ('0000000a-0000-4000-8000-00000000000a', 'signal_runs', '2024-06-30', 'analytics/signal_runs/2024-h1.parquet', now());
  DELETE FROM noticeos.signal_runs WHERE run_id = 'run-2024';
  GET DIAGNOSTICS n = ROW_COUNT;
  ASSERT n = 1, 'an old run the export covers may leave';

  -- The sweeps it runs for every workspace.
  DELETE FROM noticeos.task_snapshots WHERE captured_at < now() - interval '7 days';
  DELETE FROM noticeos.job_runs WHERE started_at < now() - interval '90 days';

  -- REFUSED: anything else — changing a row, adding one, removing a site or money.
  BEGIN
    UPDATE noticeos.flags SET resolved_at = now();
    RAISE EXCEPTION 'noticeos_maint changed a row' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO noticeos.annotations (workspace_id, asset_id, at, kind)
    VALUES ('0000000a-0000-4000-8000-00000000000a', 'a.example', now(), 'deploy');
    RAISE EXCEPTION 'noticeos_maint wrote a row' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM noticeos.assets WHERE asset_id = 'mistake.example';
    RAISE EXCEPTION 'noticeos_maint deleted a site' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM noticeos.ledger_entries;
    RAISE EXCEPTION 'noticeos_maint removed money' USING ERRCODE = 'ZT001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
SET LOCAL ROLE noticeos_app;

ROLLBACK;
RESET ROLE;
