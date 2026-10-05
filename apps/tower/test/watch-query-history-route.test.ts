import { describe, expect, it, vi } from "vitest";
import type {
  WatchQueryHistory,
  WatchQueryHistoryInput,
} from "@noticeos/contract";
import {
  handleWatchQueryHistoryRequest,
  type WatchQueryHistoryReader,
} from "../worker/watch-query-history-route";

const NOW = Date.parse("2026-08-04T18:00:00.000Z");
const HISTORY: WatchQueryHistory = {
  integration: "gsc",
  metric: "clicks",
  query: "high protein meal plan",
  firstDay: "2026-02-06",
  values: [
    ...Array.from({ length: 177 }, () => null),
    10,
    null,
    12,
  ],
  archiveFirstDay: "2026-07-25",
  archiveLastDay: "2026-08-03",
  archiveDays: 10,
  observedDays: 2,
  recordedChanges: {
    firstDay: "2026-02-06",
    lastDay: "2026-08-04",
    days: ["2026-07-31"],
    complete: true,
  },
};

function request(query = "high protein meal plan", metric = "clicks") {
  const params = new URLSearchParams({ query, metric });
  return new Request(
    `https://tower.local/api/assets/meals.example/watch-query-history?${params}`,
  );
}

function reader(
  impl: (input: WatchQueryHistoryInput) => Promise<WatchQueryHistory> = async () =>
    HISTORY,
) {
  return { watchQueryHistory: vi.fn(impl) } satisfies WatchQueryHistoryReader;
}

describe("GET /api/assets/:id/watch-query-history", () => {
  it("asks ingest for one exact query over the bounded calibration horizon", async () => {
    const ingest = reader();
    const req = request();
    const res = await handleWatchQueryHistoryRequest(
      req,
      new URL(req.url),
      ingest,
      "meals.example",
      NOW,
    );

    expect(res.status).toBe(200);
    expect(ingest.watchQueryHistory).toHaveBeenCalledWith({
      asset: "meals.example",
      metric: "clicks",
      query: "high protein meal plan",
      first_day: "2026-02-06",
      last_day: "2026-08-04",
    });
    expect(await res.json()).toEqual(HISTORY);
  });

  it("refuses a non-GSC watch metric before crossing the service boundary", async () => {
    const ingest = reader();
    const req = request("high protein meal plan", "sessions");
    const res = await handleWatchQueryHistoryRequest(
      req,
      new URL(req.url),
      ingest,
      "meals.example",
      NOW,
    );
    expect(res.status).toBe(422);
    expect(ingest.watchQueryHistory).not.toHaveBeenCalled();
  });

  it("keeps ingest failures opaque and visibly unavailable", async () => {
    const ingest = reader(async () => {
      throw new Error("R2 detail that must not reach the browser");
    });
    const req = request();
    const res = await handleWatchQueryHistoryRequest(
      req,
      new URL(req.url),
      ingest,
      "meals.example",
      NOW,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "watch_query_history_unavailable" });
  });
});
