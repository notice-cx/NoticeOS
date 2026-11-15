import type { TempoMppChain } from '@noticeos/contract/configuration';
import { TEMPO_MPP_SALE_LOOKUP_PATH } from '@noticeos/contract/tempo-mpp';
import { tokenFor } from './pull.js';
import type { TempoDelivery } from './tempo-mpp-rpc.js';

export interface TempoSaleRecord {
  asset: string;
  chainId: TempoMppChain;
  hash: string;
  logIndex: number;
  baseUnits: string;
  product: string | null;
}

export type TempoSaleKey = Pick<TempoDelivery, 'asset' | 'hash' | 'logIndex' | 'baseUnits'>;

// Asset IDs may also be slugs. Only a DNS name can supply a pull endpoint.
const ASSET_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
const MAX_BODY_BYTES = 4096;

export function tempoSaleTokens(assetTokens: string | undefined, assets: Iterable<string>) {
  const tokens = new Map<string, string>();
  for (const asset of assets) {
    const token = ASSET_HOST.test(asset) && tokenFor(assetTokens, asset);
    if (token) tokens.set(asset, token);
  }
  return tokens;
}

export function isTempoSaleProduct(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && !value.includes('\0') &&
    value.trim() === value && value.length > 0 && value.length <= 120);
}

async function saleBody(response: Response): Promise<Record<string, unknown> | null> {
  if (response.status !== 200 || Number(response.headers.get('content-length')) > MAX_BODY_BYTES) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) return null;
      text += decoder.decode(value, { stream: true });
    }
    const body: unknown = JSON.parse(text + decoder.decode());
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function pullTempoSales(
  chainId: TempoMppChain, keys: TempoSaleKey[], tokens: Map<string, string>, fetchImpl: typeof fetch, deadline?: AbortSignal,
) {
  const batchDeadline = AbortSignal.any([AbortSignal.timeout(8_000), ...(deadline ? [deadline] : [])]);
  const candidates = new Map<string, TempoSaleKey>();
  for (const key of keys) {
    if (tokens.has(key.asset)) candidates.set(`${key.asset}:${key.hash}:${key.logIndex}`, key);
  }
  const sales: TempoSaleRecord[] = [];
  const pending = candidates.values();
  async function pull() {
    for (const key of pending) {
      if (batchDeadline.aborted) return;
      const signal = AbortSignal.any([batchDeadline, AbortSignal.timeout(2_000)]);
      const url = new URL(TEMPO_MPP_SALE_LOOKUP_PATH, `https://${key.asset}`);
      url.search = new URLSearchParams({ chainId: String(chainId), hash: key.hash, logIndex: String(key.logIndex) }).toString();
      try {
        const response = await fetchImpl(url.href, {
          method: 'GET',
          headers: { authorization: `Bearer ${tokens.get(key.asset)}`, accept: 'application/json' },
          redirect: 'manual',
          signal,
        });
        const sale = await saleBody(response);
        if (sale && sale.asset === key.asset && sale.chainId === chainId && sale.hash === key.hash &&
            sale.logIndex === key.logIndex && sale.baseUnits === key.baseUnits && isTempoSaleProduct(sale.product)) {
          sales.push({ ...key, chainId, product: sale.product });
        }
      } catch {
        // The transfer stays eligible for a later pull.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(candidates.size, 4) }, pull));
  return sales;
}
