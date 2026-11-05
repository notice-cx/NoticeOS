import { BANK_ACTIVITY_DISPLAY_LIMIT, mercurySnapshotSchema, type BankingPayload } from '@noticeos/contract/banking';
import { javascriptInstant, type WorkspaceStore } from '@noticeos/postgres';

/** A read never contacts Mercury; disconnected and replaced keys expose no old data. */
export async function loadBanking(store: WorkspaceStore): Promise<BankingPayload> {
  try {
    return await store.read(async tx => {
      const [reading] = await tx.query<{ observed_at: string | null; payload: string | null }>(
        `SELECT r.observed_at, r.payload FROM noticeos.integration_connections c
         LEFT JOIN LATERAL (
           SELECT observed_at, payload FROM noticeos.mercury_readings
            WHERE workspace_id = c.workspace_id AND connection_id = c.connection_id
              AND connection_updated_at = c.updated_at
            ORDER BY observed_at DESC, reading_id DESC LIMIT 1
         ) r ON true WHERE c.provider = 'mercury'`);
      if (!reading) return { state: 'not-connected', observedAt: null, snapshot: null };
      if (reading.payload === null || reading.observed_at === null) return { state: 'awaiting', observedAt: null, snapshot: null };
      const snapshot = mercurySnapshotSchema.parse(JSON.parse(reading.payload));
      // A bounded UI response; the stored observation retains the full read.
      snapshot.transactions.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id));
      snapshot.transactions = snapshot.transactions.slice(0, BANK_ACTIVITY_DISPLAY_LIMIT);
      return { state: 'recorded', observedAt: javascriptInstant(reading.observed_at), snapshot };
    });
  } catch { return { state: 'unavailable', observedAt: null, snapshot: null }; }
}
