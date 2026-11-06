import type { DiscoverModelProviderInput, DiscoverModelProviderResult } from '@noticeos/contract';
import { JSON_HEADERS, crossOrigin, isJsonRequest, jsonError } from './http';

export const MODEL_DISCOVERY_PATH = '/api/integrations/local-model/models';

export interface ModelDiscoveryReader {
  discoverModelProvider(input: DiscoverModelProviderInput): Promise<DiscoverModelProviderResult>;
}

export async function handleModelDiscoveryRequest(request: Request, ingest: ModelDiscoveryReader): Promise<Response> {
  if (request.method !== 'POST') return jsonError('method_not_allowed', 405);
  if (crossOrigin(request, new URL(request.url))) return jsonError('forbidden', 403);
  if (!isJsonRequest(request)) return jsonError('unsupported_media_type', 415);
  // A candidate URL and token are never persisted by discovery; bound the body before parsing them.
  const reader = request.body?.getReader();
  if (!reader) return jsonError('bad_request', 400);
  let body = '';
  let bytes = 0;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16_384) return jsonError('request_too_large', 413);
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } catch { return jsonError('bad_request', 400); }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  let parsed: unknown;
  try { parsed = JSON.parse(body) as unknown; } catch { return jsonError('bad_request', 400); }
  const fields = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as { fields?: unknown }).fields : undefined;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)
      || Object.values(fields).some(value => typeof value !== 'string')) {
    return jsonError('invalid_credential', 422, { field: 'fields' });
  }
  try {
    const result = await ingest.discoverModelProvider({ fields: fields as Record<string, string> });
    return Response.json(result, { headers: JSON_HEADERS });
  } catch { return jsonError('model_discovery_failed', 503); }
}
