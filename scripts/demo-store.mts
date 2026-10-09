// Typed relational seed behind the native new-installation boundary.
import { generateDemoScenario, demoScenarioHash, shiftDemoDay, type DemoScenario, type DemoPulse } from './demo-scenario.mjs';
import type { Transaction } from '../packages/postgres/src/store.mjs';
import type { evaluatePulse as PulseEvaluator, MetricBaseline } from '../packages/contract/src/rules.js';
type Evaluator = typeof PulseEvaluator;
const HISTORY = ['assets', 'pulses', 'flags', 'annotations', 'ledger_entries', 'measurement_series', 'signal_runs', 'mediavine_sites', 'watch_windows', 'job_runs', 'task_snapshots', 'notifications', 'integration_connections'];

/** Existing rules, with four matching weekdays; no private threshold copy. */
export function demoPulseVerdicts(scenario: DemoScenario, pulse: DemoPulse, evaluatePulse: Evaluator) {
  const baselines: Record<string, MetricBaseline> = {};
  for (const metric of Object.keys(pulse.metrics)) {
    const dates = [7, 14, 21, 28].map(offset => shiftDemoDay(pulse.date, -offset));
    const readings = dates.map(date => scenario.pulses.find(p => p.asset === pulse.asset && p.date === date)?.metrics[metric]?.last24h);
    if (readings.every(value => value !== undefined)) baselines[metric] = { perDay: readings.reduce<number>((sum, value) => sum + value!, 0) / 4, source: 'same-weekday-4w', sampleSize: 4, comparisonDates: dates, windowHours: 24 };
  }
  return evaluatePulse(pulse, { baselineByMetric: baselines, requireHistoricalBaseline: true });
}

/** One application-role transaction. Caller owns a proven new development DB. */
export async function fillDemo(tx: Transaction, scenario: DemoScenario, { evaluatePulse, developmentProfile }: { evaluatePulse: Evaluator; developmentProfile: { setting: string; value: string } }) {
  const canonical = generateDemoScenario(scenario.manifest);
  if (demoScenarioHash(canonical) !== demoScenarioHash(scenario)) throw new Error('Demo facts differ from their declared scenario.');
  if (typeof evaluatePulse !== 'function') throw new Error('The released pulse evaluator is required.');
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('noticeos.dev-seed', 0))");
  const [profile] = await tx.query('SELECT current_setting($1, true) AS profile', [developmentProfile.setting]);
  if (profile?.profile !== developmentProfile.value) throw new Error('Demo seed refuses a database not marked for development.');
  const [held] = await tx.query(`SELECT ${HISTORY.map(table => `(SELECT count(*) FROM noticeos.${table})::int AS ${table}`).join(', ')}`);
  if (!held || HISTORY.some(table => held[table] !== 0)) throw new Error('Demo seed refuses a workspace already holding data.');
  const ws = tx.workspaceId;
  for (const asset of scenario.assets) {
    await tx.execute(`INSERT INTO noticeos.assets (workspace_id, asset_id, domain, display_name, status, sense_only, is_os, created_at, updated_at)
      VALUES ($1::uuid, $2, $3, $4, $5, true, $6, $7::timestamptz, $7::timestamptz)`, [ws, asset.id, asset.domain, asset.name, asset.status, asset.isOs === true, asset.createdAt]);
  }
  const now = scenario.manifest.cutoff;
  for (const asset of scenario.assets.filter(a => !a.isOs)) {
    const daily = scenario.daily.filter(d => d.asset === asset.id);
    for (const integration of ['ga4', 'gsc']) {
      const metrics = integration === 'ga4' ? { sessions: 'sessions', active_users: 'activeUsers', page_views: 'pageViews', event_count: 'eventCount' } : { clicks: 'clicks', impressions: 'impressions', ctr: 'ctr', position: 'position' };
      const observed = integration === 'ga4' ? daily.filter(day => !day.reportMissing) : daily;
      const property = `demo-${asset.prefix}-${integration}`;
      const provisional = integration === 'ga4' ? shiftDemoDay(scenario.manifest.referenceDate, -3) : null;
      const [run] = await tx.query<{ run_seq: bigint }>(`INSERT INTO noticeos.signal_runs (workspace_id, run_id, asset_id, integration, credential_ref, property_ref, time_zone,
        started_at, finished_at, status, window_start, window_end, data_state, provisional_from, provider_rows, observation_count)
        VALUES ($1::uuid, $2, $3, $4, 'synthetic-demo', $5, $6, $7::timestamptz, $7::timestamptz, 'success', $8::date, $9::date, $10, $11::date, $12, $13) RETURNING run_seq`,
        [ws, `demo-${asset.prefix}-${integration}`, asset.id, integration, property, scenario.manifest.providerTimeZone, now, daily[0]!.date, daily.at(-1)!.date, provisional === null ? 'final' : 'includes-provisional', provisional, observed.length, observed.length * 4]);
      for (const [metric, field] of Object.entries(metrics)) {
        const [series] = await tx.query<{ series_id: bigint }>(`INSERT INTO noticeos.measurement_series (workspace_id, asset_id, integration, property_ref, time_zone, metric)
          VALUES ($1::uuid, $2, $3, $4, $5, $6) RETURNING series_id`, [ws, asset.id, integration, property, scenario.manifest.providerTimeZone, metric]);
        await tx.execute(`INSERT INTO noticeos.signal_observations (workspace_id, run_seq, series_id, observed_date, value)
          SELECT $1::uuid, $2::bigint, $3::bigint, v.date, v.value FROM unnest($4::date[], $5::float8[]) AS v(date, value)`, [ws, run!.run_seq, series!.series_id, observed.map(d => d.date), observed.map(d => d[field as keyof Pick<typeof d, 'sessions' | 'activeUsers' | 'pageViews' | 'eventCount' | 'clicks' | 'impressions' | 'ctr' | 'position'>])]);
      }
    }
  }
  const entries = new Map<string, bigint>();
  for (const row of scenario.ledger) {
    const [written] = await tx.query<{ entry_id: bigint }>(`INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, amount_minor, currency, source, booking_state, supersedes_id, note, recorded_at, external_id, coverage_start, coverage_end, coverage_complete)
      VALUES ($1::uuid, $2, $3, $4::date, $5, $6::bigint, $7, $8, $9, $10::bigint, $11, $12::timestamptz, $13, $14::date, $15::date, $16) RETURNING entry_id`, [ws, row.kind, row.asset, `${row.period}-01`, row.family, row.minor, row.currency, row.source, row.state, row.supersedes ? entries.get(row.supersedes)! : null, row.note, row.recordedAt, `demo:${row.key}`, row.coverageStart ?? null, row.coverageEnd ?? null, row.coverageComplete ?? null]);
    entries.set(row.key, written!.entry_id);
  }
  // The ad network's daily estimates reported by the cutoff, as one synthetic
  // history run per site; the hosted scheduler's ad revenue lane continues it.
  for (const site of scenario.manifest.adSites) {
    const days = scenario.adRevenue.filter(day => day.asset === site.asset);
    if (days.length === 0) continue;
    await tx.execute('INSERT INTO noticeos.mediavine_sites (workspace_id, site_id, asset_id) VALUES ($1::uuid, $2, $3)', [ws, site.siteId, site.asset]);
    const total = days.reduce((sum, day) => sum + day.minor, 0);
    const [run] = await tx.query<{ run_seq: bigint }>(`INSERT INTO noticeos.mediavine_runs (workspace_id, run_id, asset_id, site_id, start_date, end_date, attempted_at, outcome, summary_minor, daily_minor, difference_minor)
      VALUES ($1::uuid, $2, $3, $4, $5::date, $6::date, $7::timestamptz, 'success', $8::bigint, $8::bigint, 0) RETURNING run_seq`,
    [ws, `${site.siteId}-history`, site.asset, site.siteId, days[0]!.date, days.at(-1)!.date, days.at(-1)!.recordedAt, total]);
    await tx.execute(`INSERT INTO noticeos.mediavine_daily (workspace_id, run_seq, asset_id, site_id, report_date, amount_minor, recorded_at)
      SELECT $1::uuid, $2::bigint, $3, $4, v.date, v.minor, v.recorded FROM unnest($5::date[], $6::bigint[], $7::timestamptz[]) AS v(date, minor, recorded)`,
    [ws, run!.run_seq, site.asset, site.siteId, days.map(day => day.date), days.map(day => day.minor), days.map(day => day.recordedAt)]);
  }
  const reports = new Map<string, bigint>();
  for (const pulse of scenario.pulses) {
    const envelope = { asset: pulse.asset, generatedAt: pulse.generatedAt, capabilities: pulse.capabilities, metrics: pulse.metrics };
    const [written] = await tx.query<{ pulse_id: bigint }>(`INSERT INTO noticeos.pulses (workspace_id, asset_id, pulse_date, generated_at, received_at, capabilities, envelope)
      VALUES ($1::uuid, $2, $3::date, $4::timestamptz, $4::timestamptz, $5::jsonb, $6::json) RETURNING pulse_id`, [ws, pulse.asset, pulse.date, pulse.generatedAt, JSON.stringify(pulse.capabilities), JSON.stringify(envelope)]);
    reports.set(`${pulse.asset}/${pulse.date}`, written!.pulse_id);
  }
  const { repair, problem } = scenario.manifest.stories;
  for (const story of [{ asset: repair.asset, date: repair.findingDate, resolvedAt: repair.annotationAt }, { asset: problem.asset, date: problem.date, resolvedAt: null }]) {
    const pulse = scenario.pulses.find(p => p.asset === story.asset && p.date === story.date)!;
    for (const verdict of demoPulseVerdicts(scenario, pulse, evaluatePulse)) {
      if (verdict.outcome !== 'fired' || !verdict.flag) continue;
      await tx.execute(`INSERT INTO noticeos.flags (workspace_id, asset_id, pulse_id, fired_at, severity, kind, metric, message, rule_id, rule_inputs, resolved_at)
        VALUES ($1::uuid, $2, $3::bigint, $4::timestamptz, $5, $6, $7, $8, $9, $10::jsonb, $11::timestamptz)`, [ws, story.asset, reports.get(`${story.asset}/${story.date}`)!, pulse.generatedAt, verdict.flag.severity, verdict.flag.kind, verdict.flag.metric, verdict.flag.message, verdict.ruleId, JSON.stringify(verdict.inputs), story.resolvedAt]);
    }
  }
  await tx.execute(`INSERT INTO noticeos.annotations (workspace_id, asset_id, at, kind, ref, note, created_at)
    VALUES ($1::uuid, $2, $3::timestamptz, 'deploy', $4, 'Synthetic navigation repair.', $3::timestamptz)`, [ws, repair.asset, repair.annotationAt, repair.ref]);
  await tx.execute(`INSERT INTO noticeos.watch_windows (workspace_id, window_id, asset_id, ref_kind, ref, metric_integration, metric, registered_at, baseline_start, baseline_end, check_offsets, thresholds, note, created_at, readback_bead)
    VALUES ($1::uuid, $2, $3, 'annotation', $4, 'ga4', 'sessions', $5::timestamptz, $6::date, $7::date, ARRAY[28], $8::jsonb, 'Synthetic comparison; no causal revenue claim.', $5::timestamptz, $9)`, [ws, repair.watchId, repair.asset, repair.ref, repair.registeredAt, repair.baselineStart, repair.baselineEnd, JSON.stringify({ ship: { direction: 'up', min_delta_pct: 10 }, kill: { direction: 'down', min_delta_pct: 10 } }), repair.readbackTaskId]);
  // The recipe site's shipped change and its still-counting comparison.
  const { ship } = scenario.manifest;
  await tx.execute(`INSERT INTO noticeos.annotations (workspace_id, asset_id, at, kind, ref, note, created_at)
    VALUES ($1::uuid, $2, $3::timestamptz, 'deploy', $4, 'Synthetic faster recipe pages; no live deployment.', $3::timestamptz)`, [ws, ship.asset, ship.annotationAt, ship.ref]);
  await tx.execute(`INSERT INTO noticeos.watch_windows (workspace_id, window_id, asset_id, ref_kind, ref, metric_integration, metric, registered_at, baseline_start, baseline_end, check_offsets, thresholds, note, created_at, readback_bead)
    VALUES ($1::uuid, $2, $3, 'annotation', $4, 'ga4', 'sessions', $5::timestamptz, $6::date, $7::date, $8::int[], $9::jsonb, 'Synthetic comparison; no causal revenue claim.', $5::timestamptz, $10)`, [ws, ship.watchId, ship.asset, ship.ref, ship.registeredAt, ship.baselineStart, ship.baselineEnd, ship.checkOffsets, JSON.stringify({ ship: { direction: 'up', min_delta_pct: 10 }, kill: { direction: 'down', min_delta_pct: 10 } }), ship.readbackTaskId]);
  return { assets: scenario.assets.length, daily: scenario.daily.length, pulses: scenario.pulses.length, ledger: scenario.ledger.length, adDays: scenario.adRevenue.length, watchStatus: 'registered' };
}
