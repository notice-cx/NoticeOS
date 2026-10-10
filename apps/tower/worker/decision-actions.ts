// The operator's dismissal or acceptance of one item on a site's page
// (`noticeos.item_dispositions`): display state, keyed by the item's own text
// key, never joined to anything.

import { javascriptInstant, type WorkspaceStore } from "@noticeos/postgres";
import { recordMutation, type MutationActor } from "@noticeos/postgres/mutation-audit";
import type {
  AssetDecision,
  DecisionKind,
  DecisionStatus,
} from "../shared/asset-detail";

export const DECISION_KINDS: readonly DecisionKind[] = ["query", "finding"];
/** The whole write vocabulary, and the whole read vocabulary. */
export const DECISION_STATUSES: readonly DecisionStatus[] = [
  "marked",
  "dismissed",
];

/** The column's CHECK bounds, mirrored so the route rejects an over-long key
 * with a validation error rather than a 500 from the constraint. */
export const DECISION_KEY_MAX = 512;
export const DECISION_NOTE_MAX = 2000;

export interface DecisionInput {
  kind: DecisionKind;
  key: string;
  status: DecisionStatus;
  note?: string | null;
}

export function isDecisionKind(value: unknown): value is DecisionKind {
  return DECISION_KINDS.includes(value as DecisionKind);
}

export function isDecisionStatus(value: unknown): value is DecisionStatus {
  return DECISION_STATUSES.includes(value as DecisionStatus);
}

/** One stored disposition as the store returns it: instants in its form. */
type DispositionRow = {
  kind: DecisionKind;
  key: string;
  status: DecisionStatus;
  decidedAt: string;
  updatedAt: string;
};

/** The columns every read returns, in the contract's names. */
const DISPOSITION_COLUMNS = `kind, item_key AS "key", status, decided_at AS "decidedAt", updated_at AS "updatedAt"`;

function asDecision(row: DispositionRow): AssetDecision {
  return { ...row, decidedAt: javascriptInstant(row.decidedAt), updatedAt: javascriptInstant(row.updatedAt) };
}

/**
 * Record what the operator decided about one query or one finding.
 *
 * The write is an UPSERT on the (asset, kind, key) grain, and it is honest
 * about time: `decided_at` keeps the FIRST judgement, while `updated_at` moves
 * only when the status or note actually changes — so repeating a decision is
 * idempotent rather than a fresh event. Nothing here touches the evidence the
 * decision was made about.
 */
export async function recordDecision(
  store: WorkspaceStore,
  asset: string,
  { kind, key, status, note = null }: DecisionInput,
  nowIso: string,
  actor: MutationActor | null = null,
): Promise<AssetDecision | null> {
  const row = await store.write(async (tx) => {
    // Set and clear serialize on the same identity, including an absent row.
    // Concurrent identical decisions retain one event and their first time.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `noticeos.decision:${tx.workspaceId}:${JSON.stringify([asset, kind, key])}`,
    ]);
    const [prior] = await tx.query<{ status: DecisionStatus; note: string | null }>(
      `SELECT status, note FROM noticeos.item_dispositions
        WHERE asset_id = $1 AND kind = $2 AND item_key = $3 FOR UPDATE`, [asset, kind, key],
    );
    const [written] = await tx.query<DispositionRow>(
      `INSERT INTO noticeos.item_dispositions AS d
              (workspace_id, asset_id, kind, item_key, status, decided_at, updated_at, note)
            VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $6::timestamptz, $7)
       ON CONFLICT (workspace_id, asset_id, kind, item_key) DO UPDATE
            SET status = excluded.status,
                note = excluded.note,
                updated_at = CASE
                  WHEN d.status = excluded.status
                   AND d.note IS NOT DISTINCT FROM excluded.note
                  THEN d.updated_at
                  ELSE excluded.updated_at
                END
         RETURNING ${DISPOSITION_COLUMNS}`,
      [tx.workspaceId, asset, kind, key, status, nowIso, note],
    );
    if (written && (!prior || prior.status !== status || prior.note !== note)) {
      await recordMutation(tx, actor, { event: 'decision.set', assetId: asset,
        subject: { kind, key, status } });
    }
    return written;
  });
  return row ? asDecision(row) : null;
}

/**
 * Clear one decision — the findings "Restore". The row is deleted rather than
 * given an `open` status, because absence is what "untouched" means here.
 * Clearing something already untouched is a no-op success, never an error: the
 * operator asked for a state, and that state is what they get.
 */
export async function clearDecision(
  store: WorkspaceStore,
  asset: string,
  kind: DecisionKind,
  key: string,
  actor: MutationActor | null = null,
): Promise<{ removed: boolean }> {
  const removed = await store.write(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `noticeos.decision:${tx.workspaceId}:${JSON.stringify([asset, kind, key])}`,
    ]);
    const count = await tx.execute(
      `DELETE FROM noticeos.item_dispositions
        WHERE asset_id = $1 AND kind = $2 AND item_key = $3`,
      [asset, kind, key],
    );
    if (count > 0) await recordMutation(tx, actor, { event: 'decision.clear', assetId: asset,
      subject: { kind, key } });
    return count;
  });
  return { removed: removed > 0 };
}

/**
 * Every decision recorded for one asset, newest activity first, filtered to
 * `DECISION_STATUSES` so the read is the vocabulary the route accepts. Ties:
 * the key byte by byte, then the order the rows were written.
 */
export async function loadDecisions(
  store: WorkspaceStore,
  asset: string,
): Promise<AssetDecision[]> {
  const rows = await store.read((tx) =>
    tx.query<DispositionRow>(
      `SELECT ${DISPOSITION_COLUMNS}
         FROM noticeos.item_dispositions
        WHERE asset_id = $1
          AND status = ANY($2::text[])
        ORDER BY updated_at DESC, item_key COLLATE "C", disposition_id`,
      [asset, [...DECISION_STATUSES]],
    ),
  );
  return rows.map(asDecision);
}
