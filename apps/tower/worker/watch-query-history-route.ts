// GET /api/assets/:id/watch-query-history — one exact query and metric for an
// open query-scoped watch composer. One asset's GSC query archive can hold tens
// of thousands of rows, so the asset payload never carries it.

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
