import { evaluatePredictiveCounts, type RuleConfig } from '@noticeos/contract';
import type { Transaction } from '@noticeos/postgres';
import { appendReading, holdCondition, raiseAlertUnlessOpen, readOpenAlert, resolveOpen } from './alert-store.js';
import { countBaselinesFrom, isRetiredForAlert, seasonalHistorySpanDays } from './db.js';
import { readDailySignalTrend, type PanelSourceTrendRow } from './panel-source.js';
import { LIVE_SIGNAL_WINDOW_DAYS } from './signal-store.js';
import { shiftUtcDay, utcDay } from './shared.js';

const SOURCES = { 'bing-webmaster': 'Bing', gsc: 'Google Search Console' } as const;
const METRICS = ['clicks', 'impressions'] as const;
const SEARCH_TRAFFIC = 'search-traffic';

export async function checkSearchTraffic(
  env: Pick<IngestEnv, 'STORE'>,
  config: RuleConfig,
  nowMs = Date.now(),
): Promise<{ assets: number; raised: number; resolved: number }> {
  const at = new Date(nowMs).toISOString();
  const through = utcDay(at);
  const from = shiftUtcDay(through, -(seasonalHistorySpanDays(config) + LIVE_SIGNAL_WINDOW_DAYS));
  const integrations = Object.keys(SOURCES);
  const assets = await env.STORE.read((tx) => tx.query<{ asset: string }>(
    `SELECT a.asset_id AS asset FROM noticeos.assets AS a WHERE a.status <> 'retired' AND EXISTS (
       SELECT 1 FROM noticeos.signal_runs AS r WHERE r.asset_id = a.asset_id
        AND r.status = 'success' AND r.integration = ANY($1::text[]) AND r.window_end >= $2::date
     ) ORDER BY a.asset_id`, [integrations, from]));
  const result = { assets: assets.length, raised: 0, resolved: 0 };

  for (const { asset } of assets) {
    const changes = await env.STORE.write(async (tx) => {
      await holdCondition(tx, asset, SEARCH_TRAFFIC);
      if (await isRetiredForAlert(tx, asset)) return { raised: 0, resolved: 0 };
      const rows = await readDailySignalTrend(tx, asset, from, integrations, through);
      let raised = 0;
      let resolved = 0;
      for (const [integration, provider] of Object.entries(SOURCES)) {
        for (const metric of METRICS) {
          const change = await reconcileTraffic(tx, asset, integration, provider, metric, rows, config, at);
          raised += change.raised;
          resolved += change.resolved;
        }
      }
      return { raised, resolved };
    });
    result.raised += changes.raised;
    result.resolved += changes.resolved;
  }
  return result;
}

async function reconcileTraffic(
  tx: Transaction,
  asset: string,
  integration: string,
  provider: string,
  metric: string,
  rows: readonly PanelSourceTrendRow[],
  config: RuleConfig,
  at: string,
): Promise<{ raised: number; resolved: number }> {
  const section = rows.filter((row) => row.integration === integration && row.metric === metric && row.provisional === 0);
  const newest = section.at(-1);
  if (!newest) return { raised: 0, resolved: 0 };
  const daily = new Map(section.map(({ date, value }) => [date, value]));
  const title = `${provider} ${metric}`;
  const verdict = evaluatePredictiveCounts(metric,
    countBaselinesFrom((date) => daily.get(date), newest.date, newest.value, config), config);
  if (!verdict || verdict.outcome === 'not-applicable') return { raised: 0, resolved: 0 };
  const ruleId = `${SEARCH_TRAFFIC}-${integration}-${metric}`;
  const open = await readOpenAlert(tx, asset, ruleId);
  const previousDate = open?.ruleInputs && (JSON.parse(open.ruleInputs) as { observationEnd?: string } | null)?.observationEnd;
  if (previousDate && newest.date < previousDate) return { raised: 0, resolved: 0 };
  if (verdict.outcome === 'ok' && open) {
    return { raised: 0, resolved: await resolveOpen(tx, asset, ruleId, at) };
  }
  if (!verdict.flag) return { raised: 0, resolved: 0 };

  const { severity, kind } = verdict.flag;
  const start = shiftUtcDay(newest.date, 1 - Number(verdict.inputs.windowDays));
  const period = start === newest.date ? start : `${start} to ${newest.date}`;
  const message = `${title} fell below the expected range for ${period}. The reported count was ${verdict.inputs.observed}.`;
  const ruleInputs = JSON.stringify({ ...verdict.inputs, integration, observationStart: start, observationEnd: newest.date });
  if (!open) {
    const id = await raiseAlertUnlessOpen(tx, { asset, firedAt: at, severity, kind, metric: title, message, ruleId, ruleInputs });
    return { raised: id === null ? 0 : 1, resolved: 0 };
  }
  const [comparison] = await tx.query<{ changed: boolean }>('SELECT $1::jsonb IS DISTINCT FROM $2::jsonb AS changed',
    [open.ruleInputs, ruleInputs]);
  if (comparison?.changed) {
    await appendReading(tx, [open.flagId], { observedAt: at, severity, message, ruleInputs });
  }
  return { raised: 0, resolved: 0 };
}
