import { OS_TIME_ZONE, savedOsTimeZone } from '@noticeos/contract';
import { TOWER_CONFIG_FILES } from '@noticeos/contract/configuration';
import constants from '../../../config/constants.json' with { type: 'json' };
import defaults from '../../../config/integrations.json' with { type: 'json' };
import { revenueCalendarDate } from '../../../apps/tower/shared/daily-revenue.js';
import type { IntegrationsConfig } from '../../../apps/tower/shared/integrations.js';
import { isReady, monthRevenue } from '../../../apps/tower/shared/month-revenue.js';
import { readSites } from '../../../apps/tower/worker/asset-registry.js';
import { resolveMatrixSettings } from '../../../apps/tower/worker/config-source.js';
import { loadWallAssetRevenue } from '../../../apps/tower/worker/wall-asset-revenue.js';
import { loadWallLedger } from '../../../apps/tower/worker/wall-ledger.js';
import { getConfigDocuments } from './config-store.js';

export async function loadDiscordRevenueForecast(env: IngestEnv, now: Date) {
  const reads = await getConfigDocuments(env, [TOWER_CONFIG_FILES.constants, TOWER_CONFIG_FILES.integrations], { fresh: true });
  const stored = new Map(reads.filter(read => read.source === 'store').map(read => [read.file, read.body]));
  const osTimeZone = savedOsTimeZone(stored.get(TOWER_CONFIG_FILES.constants), OS_TIME_ZONE);
  const { integrations } = resolveMatrixSettings(stored, {
    monthlyCaps: { dataUsd: constants.monthly_caps.data_usd }, integrations: defaults as IntegrationsConfig,
    pullConfig: [], serpPanel: { assets: {} },
  });
  const period = revenueCalendarDate(now, osTimeZone).slice(0, 7);
  const [ledger, sites] = await Promise.all([loadWallLedger(env.STORE, period, osTimeZone), readSites(env.STORE)]);
  const assets = await loadWallAssetRevenue(env.STORE, ledger, sites.filter(site => site.isOs !== 1).map(site => site.id), {
    now, osTimeZone, integrations,
  });
  // Any reconciled row behind the Wall's net trend already clears firstRun.
  const month = monthRevenue({ ...ledger.portfolio, netTrend: [] }, [...assets.values()]);
  return {
    period: month?.period ?? period,
    total: month?.pace?.projected ?? null,
    byAsset: new Map([...assets].flatMap(([id, { revenueProjection }]) => isReady(revenueProjection)
      ? [[id, revenueProjection] as const] : [])),
  };
}

export type DiscordRevenueForecast = Awaited<ReturnType<typeof loadDiscordRevenueForecast>>;
