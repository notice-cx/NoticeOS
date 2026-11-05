import type { WorkspaceStore } from '@noticeos/postgres';
import type { DemoBankingReading } from '../../../scripts/demo-banking.mjs';
import { mercurySnapshotSchema } from '@noticeos/contract/banking-schema';
import { healthConnection, observeIntegration } from './integration-health-context.js';
import { persistMercuryReading, MERCURY_CAPABILITY } from './mercury.js';

/** Private simulator adapter; the caller supplies the fixed admitted demo store. */
export async function writeDemoBanking(store: WorkspaceStore, reading: DemoBankingReading): Promise<{ outcome: 'ran'; written: number }> {
  const snapshot = mercurySnapshotSchema.parse(reading.snapshot);
  const written = await store.write(async tx => {
    const [real] = await tx.query(`SELECT 1 FROM noticeos.connection_secrets s
      JOIN noticeos.integration_connections c USING (workspace_id, connection_id) WHERE c.provider = 'mercury' LIMIT 1`);
    if (real) throw new Error('Synthetic banking refuses stored credentials.');
    const saved = await persistMercuryReading(tx, { id: reading.connectionId, updatedAt: reading.connectionUpdatedAt }, snapshot, reading.at, reading.id);
    if (!saved) {
      const [existing] = await tx.query(`SELECT 1 FROM noticeos.mercury_readings
        WHERE reading_id = $1::uuid AND connection_id = $2::uuid AND payload = $3::jsonb`,
        [reading.id, reading.connectionId, JSON.stringify(snapshot)]);
      if (!existing) throw new Error('Synthetic bank connection is unavailable.');
    }
    return saved;
  });
  const env = { STORE: store, NOTICEOS_WORKSPACE_PROFILE: 'demo', NOTICEOS_DEMO_WORKSPACE_ID: await store.workspaceId() } as unknown as IngestEnv;
  const health = await healthConnection(env, 'mercury');
  await observeIntegration(env, health, { capability: MERCURY_CAPABILITY, attemptId: reading.id, observedAt: reading.at, ok: true });
  return { outcome: 'ran', written };
}
