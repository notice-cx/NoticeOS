// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type {
  RuleBacktest,
  RuleBacktestInput,
  RuleBacktestResult,
} from "@noticeos/contract";
import {
  handleRuleBacktestRequest,
  type RuleBacktester,
} from "../worker/rule-backtest-route";

const BACKTEST: RuleBacktest = {
  asset: "northwind.example",
  ruleId: "flow-poisson-low",
  metric: "signups",
  config: { alpha: 0.01, minBaselinePerDay: 3, lowVolumeWindowHours: 72 },
  windowDays: 2,
  firstDay: "2026-09-03",
  lastDay: "2026-09-04",
  days: [
    { date: "2026-09-03", state: "quiet", firings: [], stored: false },
    {
      date: "2026-09-04",
      state: "fired",
      firings: [{ metric: "signups", severity: "warn" }],
      stored: true,
    },
  ],
  wouldFire: 1,
  judged: 2,
  reported: 2,
  firedInStore: 1,
};

const BODY = {
  asset: "northwind.example",
  ruleId: "flow-poisson-low",
  metric: "signups",
  config: { alpha: 0.01, minBaselinePerDay: 3, lowVolumeWindowHours: 72 },
};

function request(body: unknown = BODY, init: RequestInit = {}) {
  return new Request("https://tower.local/api/alerts/backtest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

function ingest(
  impl: (input: RuleBacktestInput) => Promise<RuleBacktestResult> = async () => ({
    ok: true,
    backtest: BACKTEST,
  }),
) {
  return { backtestRule: vi.fn(impl) } satisfies RuleBacktester;
}

async function call(req: Request, api: RuleBacktester) {
  return handleRuleBacktestRequest(req, new URL(req.url), api);
}

describe("POST /api/alerts/backtest", () => {
  it("carries the question to ingest and answers with the replay", async () => {
    const api = ingest();
    const res = await call(request(), api);

    expect(res.status).toBe(200);
    expect(api.backtestRule).toHaveBeenCalledWith({
      asset: "northwind.example",
      ruleId: "flow-poisson-low",
      metric: "signups",
      config: { alpha: 0.01, minBaselinePerDay: 3, lowVolumeWindowHours: 72 },
    });
    expect(await res.json()).toEqual(BACKTEST);
  });

  it("scopes to the whole asset when no metric is named", async () => {
    const api = ingest();
    const { metric: _metric, ...noMetric } = BODY;
    await call(request(noMetric), api);
    expect(api.backtestRule).toHaveBeenCalledWith(
      expect.objectContaining({ metric: null }),
    );
  });

  it("refuses anything but a same-origin JSON POST", async () => {
    const api = ingest();
    const get = new Request("https://tower.local/api/alerts/backtest");
    expect((await call(get, api)).status).toBe(405);

    const cross = request(BODY, { headers: { "content-type": "application/json", origin: "https://evil.test" } });
    expect((await call(cross, api)).status).toBe(403);

    const plain = new Request("https://tower.local/api/alerts/backtest", {
      method: "POST",
      body: "{}",
    });
    expect((await call(plain, api)).status).toBe(415);

    expect((await call(request("{not json"), api)).status).toBe(400);
    expect((await call(request([1, 2, 3]), api)).status).toBe(400);
    expect(api.backtestRule).not.toHaveBeenCalled();
  });

  it("refuses a body with no asset or no rule before crossing the boundary", async () => {
    const api = ingest();
    expect((await call(request({ ruleId: "flow-poisson-low" }), api)).status).toBe(422);
    expect((await call(request({ asset: "northwind.example" }), api)).status).toBe(422);
    expect(api.backtestRule).not.toHaveBeenCalled();
  });

  // Each refusal is a different sentence in the panel, so each keeps its own
  // code and status rather than collapsing into one "could not load".
  it("passes a rule with no replay through as its own refusal", async () => {
    const api = ingest(async () => ({
      ok: false,
      error: "unsupported_rule",
      ruleId: "ingest-freshness",
    }));
    const res = await call(request({ ...BODY, ruleId: "ingest-freshness" }), api);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "unsupported_rule",
      ruleId: "ingest-freshness",
    });
  });

  it("answers 404 for an asset the store does not have", async () => {
    const api = ingest(async () => ({
      ok: false,
      error: "unknown_asset",
      asset: "ghost.site",
    }));
    const res = await call(request({ ...BODY, asset: "ghost.site" }), api);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown_asset", asset: "ghost.site" });
  });

  it("carries the detector's own field refusals back to the fields", async () => {
    const issues = [
      { path: "config.alpha", code: "range", message: "config.alpha must be greater than 0 and at most 1" },
    ];
    const api = ingest(async () => ({ ok: false, error: "validation", issues }));
    const res = await call(request({ ...BODY, config: { ...BODY.config, alpha: 0 } }), api);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "validation", issues });
  });

  it("keeps ingest failures opaque and visibly unavailable", async () => {
    const api = ingest(async () => {
      throw new Error("D1 detail that must not reach the browser");
    });
    const res = await call(request(), api);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "rule_backtest_unavailable" });
  });
});
