import type { MediavineResult, MediavineSettings, MediavineStatus, MediavineSync } from '@noticeos/contract';
import { crossOrigin, isJsonRequest, JSON_HEADERS, jsonError } from './http';
// The account's sites are listed by the connect panel's own route (GET
// /api/integrations/mediavine/sites, site-discovery-route.ts, bead
// `ro-ujb9.96.7.6`); these are the site's revenue settings and sync.
export interface MediavineBinding {
  mediavineStatus(asset: string): Promise<MediavineStatus>;
  saveMediavineSettings(input: MediavineSettings): Promise<MediavineResult<MediavineStatus>>;
  syncMediavine(input: MediavineSync, originalProof?: Request): Promise<MediavineResult<MediavineStatus>>;
}
export async function handleMediavineRequest(request: Request, url: URL,
  ingest: MediavineBinding | Pick<MediavineBinding, 'syncMediavine'>): Promise<Response> {
  const action = url.pathname.slice('/api/integrations/mediavine/'.length);
  const method = action === 'status' ? 'GET' : action === 'settings' ? 'PUT' : 'POST';
  if (!['status', 'settings', 'sync'].includes(action)) return jsonError('not_found', 404);
  if (request.method !== method) return jsonError('method_not_allowed', 405);
  if (crossOrigin(request, url)) return jsonError('forbidden', 403);
  try {
    if (action === 'status') {
      if (!('mediavineStatus' in ingest)) return jsonError('not_found', 404);
      const asset = url.searchParams.get('asset');
      if (!asset || asset.length > 253) return jsonError('invalid_asset', 400);
      return Response.json({ ok: true, value: await ingest.mediavineStatus(asset) }, { headers: JSON_HEADERS });
    }
    if (!isJsonRequest(request)) return jsonError('unsupported_media_type', 415);
    const reader = request.body?.getReader();
    if (!reader) return jsonError('bad_request', 400);
    let text = ''; let bytes = 0; const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4096) { await reader.cancel(); return jsonError('body_too_large', 413); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    let body: unknown;
    try { body = JSON.parse(text) as unknown; } catch { return jsonError('bad_request', 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError('bad_request', 400);
    const fields = body as Record<string, unknown>;
    if (typeof fields.asset !== 'string' || fields.asset.length > 253) return jsonError('invalid_asset', 400);
    let result: MediavineResult<MediavineStatus>;
    if (action === 'settings') {
      if (!('saveMediavineSettings' in ingest)) return jsonError('not_found', 404);
      if (typeof fields.siteId !== 'string' || fields.siteId.length > 160 || typeof fields.enabled !== 'boolean') return jsonError('bad_request', 400);
      if (fields.holidayCalendar !== undefined && (typeof fields.holidayCalendar !== 'string' || !['none', 'US', 'CA', 'US,CA'].includes(fields.holidayCalendar))) return jsonError('bad_request', 400);
      result = await ingest.saveMediavineSettings({ asset: fields.asset, siteId: fields.siteId, enabled: fields.enabled, ...(fields.holidayCalendar === undefined ? {} : { holidayCalendar: fields.holidayCalendar as MediavineSettings['holidayCalendar'] }) });
    } else {
      if ((fields.start !== undefined && typeof fields.start !== 'string') || (fields.end !== undefined && typeof fields.end !== 'string')) return jsonError('bad_request', 400);
      result = await ingest.syncMediavine({ asset: fields.asset,
        ...(typeof fields.start === 'string' ? { start: fields.start } : {}),
        ...(typeof fields.end === 'string' ? { end: fields.end } : {}),
      });
    }
    return Response.json(result, { status: result.ok ? 200 : 422, headers: JSON_HEADERS });
  } catch {
    return jsonError('mediavine_unavailable', 503, { message: 'Mediavine settings are unavailable. Check NoticeOS’s database migrations and try again.' });
  }
}
