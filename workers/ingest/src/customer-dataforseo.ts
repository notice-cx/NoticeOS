import { workspaceProfile } from '../../../scripts/product-env.mjs';
import { readCollectorConfigs } from './config-store.js';
import { dataForSeoMonthlyCap, runDataForSeoDumps, runDataForSeoRecovery, type SerpPanelConfig } from './dataforseo-dumps.js';
import type { LaneRegister } from './lane-mapping.js';

/** Called by the private paid scheduling binding after its workspace grant. */
export async function runCustomerDataForSeo(env: IngestEnv, input: {
  job: 'dataforseo' | 'dataforseo-recovery';
  assets: readonly string[];
  approvedMonthlyCapUsd: number;
  signal: AbortSignal;
}, { fetchImpl = fetch, nowMs }: { fetchImpl?: typeof fetch; nowMs?: number } = {}) {
  const { job, assets, approvedMonthlyCapUsd, signal } = input;
  if (workspaceProfile(env) !== 'hosted' || !['dataforseo', 'dataforseo-recovery'].includes(job)
    || assets.length === 0 || !Number.isFinite(approvedMonthlyCapUsd) || approvedMonthlyCapUsd <= 0) {
    throw new Error('Paid DataForSEO schedule is unavailable.');
  }
  signal.throwIfAborted();
  const { documents, sources, storedConstants } = await readCollectorConfigs(env, ['config/constants.json', 'config/integrations.json', 'config/serp-panel.json']);
  const saved = dataForSeoMonthlyCap(storedConstants, 0);
  if (!Number.isFinite(saved) || saved <= 0) throw new Error('Save a positive monthly data cap before scheduling paid DataForSEO.');
  const options = {
    fetchImpl, nowMs, signal, scheduledAssets: assets, fenceUnsettled: true as const,
    monthlyCapUsd: Math.min(approvedMonthlyCapUsd, saved), configSources: sources,
    laneRegister: documents['config/integrations.json'] as LaneRegister | undefined,
    serpPanelConfig: documents['config/serp-panel.json'] as SerpPanelConfig | undefined,
  };
  return job === 'dataforseo-recovery' ? runDataForSeoRecovery(env, options) : runDataForSeoDumps(env, options);
}
