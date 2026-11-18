import { METERED_BUDGET_SQL, meteredBudgetParams } from '@noticeos/contract';
import type { Transaction, WorkspaceStore } from '@noticeos/postgres';
import { dataForSeoConnectionMatches, type DataForSeoConnectionPin } from '../../../scripts/customer-collection-policy.mjs';
import { sha256Hex } from './shared.js';

const budgetName = 'noticeos.dataforseo-budget';

const CAN_SPEND_SQL = `${METERED_BUDGET_SQL}
SELECT cap > 0 AND spent + held + $7::numeric <= cap AS allowed FROM budget`;

async function canSpend(tx: Transaction, nowMs: number, reserveUsd: number, capUsd: number, requireSavedCap: boolean): Promise<boolean> {
  if (!Number.isFinite(capUsd) || capUsd <= 0 || !Number.isFinite(reserveUsd) || reserveUsd <= 0) return false;
  const [result] = await tx.query<{ allowed: boolean }>(CAN_SPEND_SQL, [
    ...meteredBudgetParams(new Date(nowMs), capUsd, requireSavedCap), reserveUsd,
  ]);
  return result?.allowed === true;
}

async function serializeBudget(tx: Transaction): Promise<void> {
  // Keep the lock only for checking and recording money. Provider I/O starts
  // after commit, so a lost Worker leaves durable evidence of possible spend.
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${budgetName}:${tx.workspaceId}`]);
}

export function canReserveDataForSeo(store: WorkspaceStore, nowMs: number, reserveUsd: number, capUsd: number, requireSavedCap = false): Promise<boolean> {
  return store.read(tx => canSpend(tx, nowMs, reserveUsd, capUsd, requireSavedCap));
}

export const customerDataForSeoRequestKey = (requestKey: string) => sha256Hex(`customer:${requestKey}`);

export type DataForSeoReservation = { kind: 'reserved'; attemptId: string; reservedAtMs: number }
  | { kind: 'budget_exhausted' | 'dataforseo_uncertain' | 'dataforseo_already_purchased' | 'dataforseo_approval_changed' };

export async function reserveDataForSeo(store: WorkspaceStore, input: {
  asset: string; requestKey: string; requestClock: () => number; reserveUsd: number; capUsd: number; fenceUnsettled: boolean;
  requireSavedCap?: boolean; approvedCredential?: DataForSeoConnectionPin;
}): Promise<DataForSeoReservation> {
  // Both profiles check unresolved or completed customer purchases. Standalone
  // still repairs its own interrupted work through the existing retry paths.
  const customerKey = await customerDataForSeoRequestKey(input.requestKey);
  const blockedKeys = input.fenceUnsettled ? [customerKey, input.requestKey] : [customerKey];
  const recordedKey = input.fenceUnsettled ? customerKey : input.requestKey;
  return store.write(async tx => {
    await serializeBudget(tx);
    if (input.approvedCredential && !await dataForSeoConnectionMatches(tx, input.approvedCredential)) {
      return { kind: 'dataforseo_approval_changed' };
    }
    const [blocked] = await tx.query<{ completed: boolean }>(`SELECT provider_completed AS completed FROM noticeos.dataforseo_request_charges
      WHERE request_key=ANY($1::text[]) AND (provider_cost_usd IS NULL OR provider_completed)
      ORDER BY provider_completed DESC LIMIT 1`, [blockedKeys]);
    if (blocked) {
      return { kind: blocked.completed ? 'dataforseo_already_purchased' : 'dataforseo_uncertain' };
    }
    const reservedAtMs = input.requestClock();
    if (!await canSpend(tx, reservedAtMs, input.reserveUsd, input.capUsd, input.requireSavedCap === true)) return { kind: 'budget_exhausted' };
    const attemptId = crypto.randomUUID();
    await tx.execute(`INSERT INTO noticeos.dataforseo_request_charges
      (workspace_id, attempt_id, asset_id, request_key, reserved_at, reserve_usd)
      VALUES ($1::uuid, $2::uuid, $3, $4, $5::timestamptz, $6::numeric)`, [
      tx.workspaceId, attemptId, input.asset, recordedKey, new Date(reservedAtMs).toISOString(), input.reserveUsd,
    ]);
    return { kind: 'reserved', attemptId, reservedAtMs };
  });
}

export function settleDataForSeo(store: WorkspaceStore, attemptId: string, costUsd: number, providerCompleted = false): Promise<void> {
  return store.write(async tx => {
    await serializeBudget(tx);
    const matched = await tx.execute(`UPDATE noticeos.dataforseo_request_charges SET provider_cost_usd=$2::numeric,provider_completed=$3::boolean
      WHERE attempt_id=$1::uuid AND provider_cost_usd IS NULL`, [attemptId, costUsd, providerCompleted]);
    if (matched !== 1) throw new Error('DataForSEO reservation could not be settled.');
  });
}
