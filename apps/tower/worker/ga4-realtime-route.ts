// Live traffic is read by ingest; the browser receives only its snapshot.
import { JSON_HEADERS, jsonError } from './http';

export interface Ga4RealtimeReader {
  ga4Realtime(originalProof?: Request): Promise<unknown>;
}
export async function handleGa4RealtimeRequest(request: Request,
  ingest: Ga4RealtimeReader): Promise<Response> {
  if (request.method !== 'GET') return jsonError('method_not_allowed', 405);
  try {
    return Response.json(await ingest.ga4Realtime(), { headers: JSON_HEADERS });
  } catch {
    // A failed poll retains the browser's last-good reading, never invented zero.
    return jsonError('ga4_realtime_unavailable', 503);
  }
}
