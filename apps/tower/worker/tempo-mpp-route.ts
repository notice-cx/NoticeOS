import { readTempoMppSettings, TOWER_CONFIG_FILES } from '@noticeos/contract/configuration';
import { TEMPO_MPP_SOURCE, tempoMppScope, type TempoMppSetup, type TempoMppPayment } from '@noticeos/contract/tempo-mpp';
import { javascriptInstant, type WorkspaceStore } from '@noticeos/postgres';
import { configDocumentKey } from '../../../scripts/config-documents.mjs';
import { JSON_HEADERS, jsonError } from './http';

const PAGE_SIZE = 30;

export async function handleTempoMppSetup(request: Request, store: WorkspaceStore): Promise<Response> {
  if (request.method !== 'GET') return jsonError('method_not_allowed', 405);
  const rawPage = new URL(request.url).searchParams.get('page') ?? '1';
  if (!/^\d{1,7}$/.test(rawPage) || Number(rawPage) < 1) return jsonError('invalid_page', 400);
  const offset = (Number(rawPage) - 1) * PAGE_SIZE;
  const payload = await store.read(async (tx): Promise<TempoMppSetup> => {
    const [config] = await tx.query<{ settings: string | null }>(
      "SELECT body->'tempoMpp' AS settings FROM noticeos.config_documents WHERE document_key = $1",
      [configDocumentKey(TOWER_CONFIG_FILES.integrations)],
    );
    const settings = config?.settings ? readTempoMppSettings(JSON.parse(config.settings)) : null;
    const assets = await tx.query<{ id: string; name: string | null }>(
      "SELECT asset_id AS id, display_name AS name FROM noticeos.assets WHERE NOT is_os AND status <> 'retired' ORDER BY list_position",
    );
    const [progress] = settings ? await tx.query<{ lastAttemptAt: string; completedAt: string | null; failed: boolean; nextBlock: string }>(
      `SELECT last_attempt_at AS "lastAttemptAt", completed_at AS "completedAt", failed, next_block::text AS "nextBlock"
       FROM noticeos.tempo_mpp_scans WHERE scope = $1`, [tempoMppScope(settings)],
    ) : [];
    const payments = await tx.query<TempoMppPayment>(
      `SELECT p.chain_id AS "chainId", p.transaction_hash AS hash, p.log_index AS "logIndex", p.asset_id AS asset,
              p.amount_base_units::text AS "baseUnits", p.settled_at AS "settledAt", s.product,
              CASE WHEN s.asset_id IS NULL THEN 'unmatched'
                   WHEN mod(p.amount_base_units, 10000) <> 0 OR p.amount_base_units > 90071992547409910000 THEN 'amount-not-supported'
                   WHEN p.chain_id = 42431 THEN 'test-payment'
                   WHEN r.item_ref IS NULL THEN 'pending' ELSE 'recorded' END AS state
       FROM noticeos.tempo_mpp_payments p
       LEFT JOIN noticeos.tempo_mpp_sale_records s USING (workspace_id, asset_id, chain_id, transaction_hash, log_index, amount_base_units)
       LEFT JOIN noticeos.revenue_observations r ON r.workspace_id = p.workspace_id AND r.source = $1
         AND r.item_ref = concat(p.chain_id, ':', p.transaction_hash, ':', p.log_index)
       ORDER BY p.settled_at DESC, p.transaction_hash, p.log_index LIMIT $2 OFFSET $3`,
      [TEMPO_MPP_SOURCE, PAGE_SIZE + 1, offset],
    );
    return {
      settings,
      assets: assets.map(({ id, name }) => ({ id, name: name || id })),
      scan: progress ? { ...progress, lastAttemptAt: javascriptInstant(progress.lastAttemptAt),
        completedAt: progress.completedAt ? javascriptInstant(progress.completedAt) : null, nextBlock: Number(progress.nextBlock) } : null,
      payments: payments.slice(0, PAGE_SIZE).map(payment => ({ ...payment, settledAt: javascriptInstant(payment.settledAt) })),
      hasMore: payments.length > PAGE_SIZE,
    };
  });
  return Response.json(payload, { headers: JSON_HEADERS });
}
