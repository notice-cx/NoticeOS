import { env } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { generateDemoScenario } from '../../../scripts/demo-scenario.mjs';
import { demoBankingReading } from '../../../scripts/demo-banking.mjs';
import { loadBanking } from '../../../apps/tower/worker/banking';
import { writeDemoBanking } from '../src/demo-banking';
import { listCredentialSummaries, putCredential } from '../src/credentials';
import { readIntegrationHealth } from '../src/integration-health-read';
import { getConfigDocument, seedConfigDocuments, forgetConfigCache } from '../src/config-store';
import { emptyTables, pgCount, reset } from './helpers';

const scenario = generateDemoScenario({ seed: 'banking-demo-store', cutoff: new Date(Math.floor(Date.now() / 86400000) * 86400000).toISOString(), release: 'a'.repeat(40) });
beforeEach(async () => { await reset(); vi.restoreAllMocks(); });
it('renders the ordinary Money reader from stored synthetic rows, without credentials, network reads or duplicate revenue', async () => {
  const reading = demoBankingReading(scenario, new Date().toISOString());
  await env.STORE.write(tx => tx.query(`INSERT INTO noticeos.integration_connections
    (workspace_id, connection_id, provider, scope, created_at, updated_at)
    VALUES ($1::uuid, $2::uuid, 'mercury', 'shared', $3::timestamptz, $3::timestamptz)`,
    [tx.workspaceId, reading.connectionId, reading.connectionUpdatedAt]));
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Synthetic banking must never fetch'));
  expect(await writeDemoBanking(env.STORE, reading)).toMatchObject({ outcome: 'ran', written: 1 });
  expect(await writeDemoBanking(env.STORE, reading)).toMatchObject({ written: 0 });
  const banking = await loadBanking(env.STORE);
  expect(banking).toMatchObject({ state: 'recorded', snapshot: { accounts: [{ name: 'Operating' }, { name: 'Tax reserve' }] } });
  expect(banking.snapshot?.transactions).toHaveLength(25);
  for (const table of ['connection_secrets', 'ledger_entries', 'revenue_observations']) {
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.${table}`)).toBe(0);
  }
  await emptyTables(['config_documents']); forgetConfigCache();
  const files = ['config/integrations.json', 'config/ga4-custom-dimensions.json', 'config/serp-panel.json'];
  const docs = await Promise.all(files.map(file => getConfigDocument(env, file)));
  await seedConfigDocuments(env, { actor: 'test', documents: Object.fromEntries(docs.map(doc => [doc.file, doc.body])) });
  const demo = { ...env, NOTICEOS_WORKSPACE_PROFILE: 'demo', NOTICEOS_DEMO_WORKSPACE_ID: await env.STORE.workspaceId() } as unknown as IngestEnv;
  expect((await listCredentialSummaries(demo)).summaries.find(summary => summary.provider === 'mercury')).toMatchObject({ source: 'demo', fields: [] });
  expect((await readIntegrationHealth(demo)).items.find(item => item.capability === 'mercury-banking')).toMatchObject({ state: 'healthy' });
  expect(fetchSpy).not.toHaveBeenCalled();
});
it('refuses to generate successful observations without the seeded connection or over a stored credential', async () => {
  const reading = demoBankingReading(scenario, new Date().toISOString());
  await expect(writeDemoBanking(env.STORE, reading)).rejects.toThrow('connection is unavailable');
  await putCredential(env, { provider: 'mercury', fields: { MERCURY_API_TOKEN: crypto.randomUUID() } });
  await expect(writeDemoBanking(env.STORE, reading)).rejects.toThrow('refuses stored credentials');
});
