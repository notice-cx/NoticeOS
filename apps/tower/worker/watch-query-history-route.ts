// GET /api/assets/:id/watch-query-history — the narrow on-demand read behind a
// query-scoped watch composer (bead `ro-5e8.8`).
//
// The asset payload must stay bounded: one asset's retained GSC query
// archive can contain tens of thousands of rows. The Tower therefore asks
// ingest for one exact query and metric only while that composer is open. R2
// stays canonical, the browser sees no bucket binding, and the query series
// crosses the same private Service Binding as registration.

import {
  WATCH_QUERY_MAX_CHARS,
  WATCH_SERIES,
  type WatchQueryHistory,
  type WatchQueryHistoryInput,
} from "@noticeos/contract";
import { watchQueryHistoryRange } from "@noticeos/contract/watch-series";
import { JSON_HEADERS, crossOrigin, jsonError } from "./http";

export interface WatchQueryHistoryReader {
  watchQueryHistory(input: WatchQueryHistoryInput, originalProof?: Request): Promise<WatchQueryHistory>;
}

export async function handleWatchQueryHistoryRequest(
  request: Request,
  url: URL,
  ingest: WatchQueryHistoryReader,
  asset: string,
  nowMs: number = Date.now(),
): Promise<Response> {
  if (request.method !== "GET") return jsonError("method_not_allowed", 405);
  if (crossOrigin(request, url)) return jsonError("forbidden", 403);

  const query = url.searchParams.get("query")?.trim() ?? "";
  const metric = url.searchParams.get("metric")?.trim() ?? "";
  const measurable = WATCH_SERIES.some(
    (series) => series.integration === "gsc" && series.metric === metric,
  );
  if (!query || query.length > WATCH_QUERY_MAX_CHARS || !measurable) {
    return jsonError("invalid_watch_query_history", 422);
  }

  const range = watchQueryHistoryRange(nowMs);
  try {
    const history = await ingest.watchQueryHistory({
      asset,
      metric,
      query,
      ...range,
    });
    return Response.json(history, { headers: JSON_HEADERS });
  } catch {
    return jsonError("watch_query_history_unavailable", 503);
  }
}
