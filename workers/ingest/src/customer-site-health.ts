import { TOWER_CONFIG_FILES } from '@noticeos/contract/configuration';
import defaults from '../../../config/integrations.json' with { type: 'json' };
import constants from '../../../config/constants.json' with { type: 'json' };
import { resolveMatrixSettings } from '../../../apps/tower/worker/config-source.js';
import { recordTodaysConnectionCounts } from '../../../apps/tower/worker/connection-status-daily.js';
import { recordTodaysSourceHistory } from '../../../apps/tower/worker/integrations-payload.js';
import type { IntegrationsConfig } from '../../../apps/tower/shared/integrations.js';
import { selectedCustomerSite, siteCheckAddress, type CustomerCollectionPolicy } from '../../../scripts/customer-collection-policy.mjs';
import { getConfigDocuments } from './config-store.js';
import { listCredentialSummaries } from './credentials.js';
import { readIntegrationHealth } from './integration-health-read.js';
import { eligibleAssets, runHygieneChecks, runUptimeChecks } from './hygiene.js';
import { runSiteIcons } from './site-icons.js';

export async function recordCustomerHealthHistory(env: IngestEnv, nowMs: number) {
  const files = [TOWER_CONFIG_FILES.constants, TOWER_CONFIG_FILES.integrations, TOWER_CONFIG_FILES.pull, TOWER_CONFIG_FILES.serpPanel];
  const reads = await getConfigDocuments(env, files);
  const settings = resolveMatrixSettings(new Map(reads.map(read => [read.file, read.body])), {
    monthlyCaps: { dataUsd: constants.monthly_caps.data_usd }, integrations: defaults as IntegrationsConfig,
    pullConfig: [], serpPanel: { assets: {} },
  });
  const now = new Date(nowMs);
  const counts = await recordTodaysConnectionCounts({
    integrationHealth: () => readIntegrationHealth(env, nowMs), listCredentialSummaries: () => listCredentialSummaries(env),
  }, env.STORE, now);
  const history = await recordTodaysSourceHistory(env.STORE, { ...settings, now });
  return { connectionCounts: counts.outcome, sourceRows: history.written };
}

/** A sitemap or a redirect can point outside the asset's approved origins. Check every hop before sending. */
function scopedSiteFetch(origins: string[], fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const initial = new Request(input, init);
    let url = new URL(initial.url);
    for (let hops = 0; hops <= 4; hops++) {
      if (!siteCheckAddress(url, origins) || initial.method !== 'GET') throw new Error('Site check address is unavailable.');
      const response = await fetchImpl(url.href, { method: 'GET', headers: initial.headers, redirect: 'manual', signal: initial.signal });
      if (initial.redirect !== 'follow' || ![301, 302, 303, 307, 308].includes(response.status)) return response;
      const target = response.headers.get('location');
      if (!target) return response;
      await response.body?.cancel();
      url = new URL(target, url);
    }
    throw new Error('Site check redirect limit reached.');
  };
}

export async function runCustomerSiteCheck(env: IngestEnv, policy: CustomerCollectionPolicy, workspaceId: string,
  asset: string, job: 'hygiene' | 'freshness', fetchImpl: typeof fetch) {
  const site = (await eligibleAssets(env)).find(row => row.asset === asset);
  const approved = site && selectedCustomerSite(policy, workspaceId, asset, site.domain);
  if (!site || !approved) return { outcome: 'skipped' };
  const options = { assets: [site], fetchImpl: scopedSiteFetch(approved.origins, fetchImpl) };
  if (job === 'freshness') {
    const result = await runUptimeChecks(env, options);
    return { attempted: result.checked, failed: result.failed.length };
  }
  const checks = await runHygieneChecks(env, options);
  const icons = await runSiteIcons(env, options);
  return { attempted: checks.assets + icons.assets, failed: checks.failed.length + icons.failed.length };
}
