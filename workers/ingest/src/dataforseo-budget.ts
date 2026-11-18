import { METERED_ARCHIVE_COST, METERED_DATA_PROVIDER, RESEARCH_COLLECTOR_ACTOR, meteredSpendBounds } from '@noticeos/contract';
import type { Transaction, WorkspaceStore } from '@noticeos/postgres';
import { dataForSeoConnectionMatches, type DataForSeoConnectionPin } from '../../../scripts/customer-collection-policy.mjs';
import { sha256Hex } from './shared.js';

const budgetName = 'noticeos.dataforseo-budget';

// Older archives and ad-hoc logged purchases still count. New archives retain
// their reported costs and identify the share held by individual attempts.
const CAN_SPEND_SQL = `WITH used AS (
  SELECT coalesce((SELECT sum(${METERED_ARCHIVE_COST})
    FROM noticeos.archive_runs WHERE integration=$5 AND requested_at >= $1 AND requested_at < $2), 0)
  + coalesce((SELECT sum(cost_usd) FROM noticeos.research_log
    WHERE provider=$5 AND actor <> $6 AND bought_at >= $1 AND bought_at < $2), 0)
  + coalesce((SELECT sum(coalesce(provider_cost_usd, reserve_usd)) FROM noticeos.dataforseo_request_charges
    WHERE reserved_at >= $1 AND reserved_at < $2), 0) AS usd
), saved AS (
  SELECT CASE WHEN jsonb_typeof(body::jsonb #> '{monthly_caps,data_usd}') = 'number'
    THEN (body::jsonb #>> '{monthly_caps,data_usd}')::numeric END AS cap
  FROM noticeos.config_documents WHERE document_key='constants'
)
SELECT usd + $3::numeric <= least($4::numeric, (SELECT cap FROM saved))
  AND (NOT $7::boolean OR (SELECT cap FROM saved) > 0) AS allowed FROM used`;

async function canSpend(tx: Transaction, nowMs: number, reserveUsd: number, capUsd: number, requireSavedCap: boolean): Promise<boolean> {
  if (!Number.isFinite(capUsd) || capUsd <= 0 || !Number.isFinite(reserveUsd) || reserveUsd <= 0) return false;
  const [result] = await tx.query<{ allowed: boolean }>(CAN_SPEND_SQL, [
    ...meteredSpendBounds(new Date(nowMs)), reserveUsd, capUsd, METERED_DATA_PROVIDER, RESEARCH_COLLECTOR_ACTOR, requireSavedCap,
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

export type DataForSeoReservation = { kind: 'reserved'; attemptId: string; reservedAtMs: number }
  | { kind: 'budget_exhausted' | 'dataforseo_uncertain' | 'dataforseo_approval_changed' };

export async function reserveDataForSeo(store: WorkspaceStore, input: {
  asset: string; requestKey: string; requestClock: () => number; reserveUsd: number; capUsd: number; fenceUnsettled: boolean;
  requireSavedCap?: boolean; approvedCredential?: DataForSeoConnectionPin;
}): Promise<DataForSeoReservation> {
  // Both profiles check unresolved customer purchases. Standalone still
  // repairs its own interrupted work through the existing retry paths.
  const customerKey = await sha256Hex(`customer:${input.requestKey}`);
  const blockedKeys = input.fenceUnsettled ? [customerKey, input.requestKey] : [customerKey];
  const recordedKey = input.fenceUnsettled ? customerKey : input.requestKey;
  return store.write(async tx => {
    await serializeBudget(tx);
    if (input.approvedCredential && !await dataForSeoConnectionMatches(tx, input.approvedCredential)) {
      return { kind: 'dataforseo_approval_changed' };
    }
    if ((await tx.query(`SELECT 1 FROM noticeos.dataforseo_request_charges
        WHERE request_key=ANY($1::text[]) AND provider_cost_usd IS NULL LIMIT 1`, [blockedKeys])).length > 0) {
      return { kind: 'dataforseo_uncertain' };
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

export function settleDataForSeo(store: WorkspaceStore, attemptId: string, costUsd: number): Promise<void> {
  return store.write(async tx => {
    await serializeBudget(tx);
    const matched = await tx.execute(`UPDATE noticeos.dataforseo_request_charges SET provider_cost_usd=$2::numeric
      WHERE attempt_id=$1::uuid AND provider_cost_usd IS NULL`, [attemptId, costUsd]);
    if (matched !== 1) throw new Error('DataForSEO reservation could not be settled.');
  });
}
