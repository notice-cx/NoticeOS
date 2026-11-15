import { ASSET_ID_MAX, ASSET_ID_RE, TEMPO_HASH } from '@noticeos/contract/configuration';
import { authenticateAsset } from '../auth.js';
import { json } from '../responses.js';
import { recordTempoSale, tempoChain } from '../tempo-mpp.js';
import { isTempoSaleProduct } from '../tempo-mpp-sales.js';

const MAX_BYTES = 4096;
const maxTokenAmount = (1n << 256n) - 1n;

export async function handleTempoMppSale(request: Request, env: IngestEnv): Promise<Response> {
  if (Number(request.headers.get('content-length')) > MAX_BYTES || !request.body) return json({ error: 'invalid_body' }, 400);
  const bodyReader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = '';
  let value: unknown;
  try {
    for (;;) {
      const chunk = await bodyReader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) {
        await bodyReader.cancel();
        return json({ error: 'payload_too_large' }, 413);
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    value = JSON.parse(body + decoder.decode());
  } catch {
    return json({ error: 'invalid_body' }, 400);
  } finally {
    bodyReader.releaseLock();
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return json({ error: 'unauthorized' }, 401);
  const { asset, chainId, hash, logIndex, baseUnits, product = null } = value as Record<string, unknown>;
  if (typeof asset !== 'string' || asset.length > ASSET_ID_MAX || !ASSET_ID_RE.test(asset) ||
      !(await authenticateAsset(request, env.ASSET_TOKENS, asset))) return json({ error: 'unauthorized' }, 401);
  if (!tempoChain(chainId) || typeof hash !== 'string' || !TEMPO_HASH.test(hash) ||
      typeof logIndex !== 'number' || !Number.isInteger(logIndex) || logIndex < 0 || logIndex > 2147483647 ||
      typeof baseUnits !== 'string' || !/^[1-9]\d{0,77}$/.test(baseUnits) || BigInt(baseUnits) > maxTokenAmount ||
      !isTempoSaleProduct(product)) {
    return json({ error: 'invalid_sale_record' }, 422);
  }
  const result = await recordTempoSale(env, { asset, chainId, hash: hash.toLowerCase(), logIndex, baseUnits, product });
  if (result === 'conflict') return json({ error: 'sale_record_conflict' }, 409);
  if (result === 'unmapped') return json({ error: 'tempo_asset_not_mapped' }, 422);
  return json({ ok: true, replayed: result === 'replayed' }, result === 'saved' ? 201 : 200);
}
