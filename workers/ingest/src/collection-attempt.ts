import type { WorkspaceStore } from '@noticeos/postgres';
import { healthScope, type HealthConnection } from './integration-health-context.js';
import { healthFailure, tryRecordIntegrationObservation } from './integration-health-store.js';

/** Captured separately from provider targets so copying or reconstructing a
 * target never changes which connection performed the collection. No secrets
 * belong here; this context is not part of reports or provider requests. Its
 * store is the collecting call's, where the result is recorded (bead
 * ro-ujb9.76.5.6). */
export interface CollectionMonitoring {
  readonly connection: Readonly<HealthConnection> | null;
  readonly store: WorkspaceStore;
  available: boolean;
}
export function beginCollection(store: WorkspaceStore, connection: HealthConnection | null): CollectionMonitoring {
  return { connection: connection === null ? null : Object.freeze({ ...connection }), store, available: connection !== null };
}
export function collectionMonitoring(monitoring: CollectionMonitoring): { monitoringAvailable?: false } {
  return monitoring.available ? {} : { monitoringAvailable: false };
}

interface CollectionTarget { asset: string; integration: string; propertyRef: string }
interface AttemptEvidence {
  id: string; startedAt: string; finishedAt: string; source: 'signal_runs' | 'signal_dump_runs';
  ok: boolean; code?: string; report?: string; reportDate?: string;
}
interface CollectedAttempt {
  target: CollectionTarget;
  attempt: AttemptEvidence;
  monitoring?: CollectionMonitoring;
}

/** Source persistence is authoritative. Its failure propagates and writes no
 * monitoring success. A monitoring failure leaves the saved source intact and
 * makes monitoring availability explicit on the collection's result. */
export async function persistCollectionAttempt(collected: CollectedAttempt, persist: () => Promise<unknown>): Promise<void> {
  await persist();
  await recordCollectedHealth(collected);
}

export async function recordCollectedHealth({ target, attempt, monitoring }: CollectedAttempt): Promise<boolean> {
  const connection = monitoring?.connection;
  if (!connection || !monitoring) return false;
  try {
    const capability = attempt.source === 'signal_runs' ? `${target.integration === 'bing-webmaster' ? 'bing' : target.integration}-daily`
      : target.integration === 'dataforseo' ? 'dataforseo-research' : target.integration === 'clarity' ? 'clarity-export' : `${target.integration === 'bing-webmaster' ? 'bing' : target.integration}-archive`;
    const family = attempt.source === 'signal_dump_runs' ? JSON.stringify([attempt.report, attempt.reportDate, '', '']) : '';
    const failure = attempt.ok ? null : healthFailure(attempt.code);
    const available = await tryRecordIntegrationObservation(monitoring.store, {
      scope: await healthScope(connection, capability, target.asset, target.propertyRef, family),
      attemptId: attempt.id, startedAt: attempt.startedAt, finishedAt: attempt.finishedAt,
      outcome: attempt.ok ? 'success' : 'failure', failure: failure?.failure ?? null,
      code: failure?.code ?? null, nextAttemptAt: null, evidenceSource: attempt.source, evidenceId: attempt.id,
    });
    if (!available) monitoring.available = false;
    return available;
  } catch {
    monitoring.available = false;
    console.warn(JSON.stringify({ event: 'integration_monitoring_unavailable', provider: connection.provider }));
    return false;
  }
}
