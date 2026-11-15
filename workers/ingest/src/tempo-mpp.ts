import {
  TEMPO_MPP_MAINNET, TEMPO_MPP_TESTNET, readTempoMppSettings, TOWER_CONFIG_FILES,
  type TempoMppChain, type TempoMppSettings,
} from '@noticeos/contract/configuration';
import { TEMPO_MPP_SOURCE, tempoMppScope } from '@noticeos/contract/tempo-mpp';
import type { Transaction } from '@noticeos/postgres';
import { configDocumentKey } from '../../../scripts/config-documents.mjs';
import { readTempoRange, type TempoDelivery, type TempoScanCursor } from './tempo-mpp-rpc.js';

const integrationsKey = configDocumentKey(TOWER_CONFIG_FILES.integrations);
type Scan = { scope: string; cursor: TempoScanCursor };

async function settingsIn(tx: Transaction, writer = false): Promise<TempoMppSettings | null> {
  const [row] = await tx.query<{ settings: string | null }>(
    `SELECT body->'tempoMpp' AS settings FROM noticeos.config_documents WHERE document_key = $1${writer ? ' FOR SHARE' : ''}`,
    [integrationsKey],
  );
  return row?.settings ? readTempoMppSettings(JSON.parse(row.settings)) : null;
}

async function scanIn(tx: Transaction): Promise<Scan | undefined> {
  const [scan] = await tx.query<{ scope: string; nextBlock: string; logIndex: number }>(
    'SELECT scope, next_block::text AS "nextBlock", next_log_index AS "logIndex" FROM noticeos.tempo_mpp_scans',
  );
  return scan ? { scope: scan.scope, cursor: { block: Number(scan.nextBlock), logIndex: scan.logIndex } } : undefined;
}

function startOf(settings: TempoMppSettings, scope: string, scan: Scan | undefined): TempoScanCursor {
  return scan?.scope === scope ? scan.cursor : { block: settings.startBlock, logIndex: 0 };
}

async function lock(tx: Transaction): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`noticeos.tempo-mpp:${tx.workspaceId}`]);
}

async function noteScan(tx: Transaction, scope: string, cursor: TempoScanCursor, at: string, complete: boolean, failed: boolean) {
  await tx.execute(
    `INSERT INTO noticeos.tempo_mpp_scans AS held
       (workspace_id, scope, next_block, next_log_index, completed_at, last_attempt_at, failed)
     VALUES ($1, $2, $3, $4, CASE WHEN $6 THEN $5::timestamptz END, $5, $7)
     ON CONFLICT (workspace_id) DO UPDATE SET
       scope = excluded.scope, next_block = excluded.next_block, next_log_index = excluded.next_log_index,
       completed_at = COALESCE(excluded.completed_at, CASE WHEN held.scope = excluded.scope THEN held.completed_at END),
       last_attempt_at = excluded.last_attempt_at, failed = excluded.failed`,
    [tx.workspaceId, scope, cursor.block, cursor.logIndex, at, complete, failed],
  );
}

async function saveDeliveries(tx: Transaction, settings: TempoMppSettings, payments: TempoDelivery[], at: string) {
  if (payments.length === 0) return;
  await tx.execute(
    `INSERT INTO noticeos.tempo_mpp_payments
       (workspace_id, chain_id, transaction_hash, log_index, asset_id, token, wallet, memo, amount_base_units, settled_at, observed_at)
     SELECT $1, $2, p.hash, p."logIndex", a.asset_id, $3, $4, p.memo, p."baseUnits", p."settledAt", $5
     FROM jsonb_to_recordset($6::jsonb) AS p(hash text, "logIndex" integer, asset text, memo text, "baseUnits" numeric, "settledAt" timestamptz)
     JOIN noticeos.assets a ON a.asset_id = p.asset AND NOT a.is_os AND a.status <> 'retired'
     ON CONFLICT (workspace_id, chain_id, transaction_hash, log_index) DO NOTHING`,
    [tx.workspaceId, settings.chainId, settings.token.toLowerCase(), settings.wallet.toLowerCase(), at, JSON.stringify(payments)],
  );
}

async function bookSales(tx: Transaction, settings: TempoMppSettings, at: string) {
  if (settings.chainId !== TEMPO_MPP_MAINNET) return 0;
  return tx.execute(
    `INSERT INTO noticeos.revenue_observations
       (workspace_id, asset_id, source, account_ref, revenue_date, item_ref, amount_minor, currency, run_ref, recorded_at)
     SELECT p.workspace_id, p.asset_id, $2, p.wallet,
       (p.settled_at AT TIME ZONE 'UTC')::date, concat(p.chain_id, ':', p.transaction_hash, ':', p.log_index),
       (p.amount_base_units / 10000)::bigint, 'USD', $3, $4
     FROM noticeos.tempo_mpp_payments p
     JOIN noticeos.tempo_mpp_sale_records s USING (workspace_id, asset_id, chain_id, transaction_hash, log_index, amount_base_units)
     JOIN noticeos.assets a ON a.asset_id = p.asset_id AND NOT a.is_os AND a.status <> 'retired'
     WHERE p.chain_id = $1 AND p.token = $5 AND p.asset_id = ANY($6::text[])
       AND mod(p.amount_base_units, 10000) = 0 AND p.amount_base_units <= 90071992547409910000
       AND NOT EXISTS (
         SELECT 1 FROM noticeos.revenue_observations r WHERE r.source = 'tempo-mpp'
           AND r.item_ref = concat(p.chain_id, ':', p.transaction_hash, ':', p.log_index)
       )
     ON CONFLICT (workspace_id, item_ref) WHERE source = 'tempo-mpp' DO NOTHING`,
    [settings.chainId, TEMPO_MPP_SOURCE, crypto.randomUUID(), at, settings.token.toLowerCase(),
      [...new Set(settings.mappings.map(({ asset }) => asset))]],
  );
}

export async function runTempoMpp(env: IngestEnv, {
  fetchImpl = fetch, now = new Date(), deadline,
}: { fetchImpl?: typeof fetch; now?: Date; deadline?: AbortSignal } = {}) {
  const starting = await env.STORE.read(async (tx) => ({ settings: await settingsIn(tx), scan: await scanIn(tx) }));
  const { settings } = starting;
  if (!settings?.enabled) return { outcome: 'skipped', detail: 'Tempo MPP collection is off.' } as const;
  const at = now.toISOString();
  const scope = tempoMppScope(settings);
  const from = startOf(settings, scope, starting.scan);
  const unchanged = async (tx: Transaction) => {
    const current = await settingsIn(tx, true);
    if (!current?.enabled || tempoMppScope(current) !== scope) return false;
    const cursor = startOf(settings, scope, await scanIn(tx));
    return cursor.block === from.block && cursor.logIndex === from.logIndex;
  };
  const batch = await readTempoRange(settings, from, fetchImpl, deadline).catch(() => null);
  return env.STORE.write(async (tx) => {
    await lock(tx);
    if (!(await unchanged(tx))) return { outcome: 'skipped', detail: 'Tempo MPP settings or scan progress changed.' } as const;
    if (!batch) {
      await noteScan(tx, scope, from, at, false, true);
      return { outcome: 'failed', detail: 'Tempo MPP scan failed. The next scan will resume at the same block.' } as const;
    }
    await saveDeliveries(tx, settings, batch.payments, at);
    const recorded = await bookSales(tx, settings, at);
    await noteScan(tx, scope, batch.cursor, at, batch.complete, false);
    return { outcome: 'ran', detail: batch.complete ? 'Tempo MPP scan complete.' : 'Tempo MPP scan will continue.',
      matched: batch.payments.length, recorded } as const;
  });
}

export interface TempoSaleRecord {
  asset: string;
  chainId: TempoMppChain;
  hash: string;
  logIndex: number;
  baseUnits: string;
  product: string | null;
}

export async function recordTempoSale(env: IngestEnv, sale: TempoSaleRecord) {
  return env.STORE.write(async (tx) => {
    await lock(tx);
    const settings = await settingsIn(tx, true);
    if (settings?.chainId !== sale.chainId || !settings.mappings.some(({ asset }) => asset === sale.asset)) return 'unmapped';
    const args = [tx.workspaceId, sale.asset, sale.chainId, sale.hash, sale.logIndex, sale.baseUnits, sale.product];
    const changed = await tx.execute(
      `INSERT INTO noticeos.tempo_mpp_sale_records
         (workspace_id, asset_id, chain_id, transaction_hash, log_index, amount_base_units, product, recorded_at)
       SELECT $1, a.asset_id, $3, $4, $5, $6, $7, now()
         FROM noticeos.assets a WHERE a.asset_id = $2 AND NOT a.is_os AND a.status <> 'retired'
       ON CONFLICT (workspace_id, asset_id, chain_id, transaction_hash, log_index) DO NOTHING`, args,
    );
    if (changed === 0) {
      const [held] = await tx.query<{ identical: boolean }>(
        `SELECT amount_base_units = $6 AND product IS NOT DISTINCT FROM $7::text AS identical
         FROM noticeos.tempo_mpp_sale_records
         WHERE workspace_id = $1 AND asset_id = $2 AND chain_id = $3 AND transaction_hash = $4 AND log_index = $5`, args,
      );
      return held ? held.identical ? 'replayed' : 'conflict' : 'unmapped';
    }
    return 'saved';
  });
}

export function tempoChain(value: unknown): value is TempoMppChain {
  return value === TEMPO_MPP_MAINNET || value === TEMPO_MPP_TESTNET;
}
