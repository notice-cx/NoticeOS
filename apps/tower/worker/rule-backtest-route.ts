// POST /api/alerts/backtest — how often this alert rule would have fired in the
// last 30 days with these settings. Read-only despite the verb: the key is a
// whole settings object that does not fit a query string. Ingest computes the
// answer; nothing is written.

import type { RuleBacktestInput, RuleBacktestResult } from "@noticeos/contract";
import { JSON_HEADERS, crossOrigin, isJsonRequest, jsonError } from "./http";

export interface RuleBacktester {
  backtestRule(input: RuleBacktestInput, originalProof?: Request): Promise<RuleBacktestResult>;
}

export async function handleRuleBacktestRequest(
  request: Request,
  url: URL,
  ingest: RuleBacktester,
): Promise<Response> {
  if (request.method !== "POST") return jsonError("method_not_allowed", 405);
  if (crossOrigin(request, url)) return jsonError("forbidden", 403);
  if (!isJsonRequest(request)) return jsonError("unsupported_media_type", 415);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("bad_request", 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return jsonError("bad_request", 400);
  }

  const input = body as Partial<RuleBacktestInput>;
  if (typeof input.asset !== "string" || typeof input.ruleId !== "string") {
    return jsonError("invalid_backtest_request", 422);
  }

  let result: RuleBacktestResult;
  try {
    result = await ingest.backtestRule({
      asset: input.asset,
      ruleId: input.ruleId,
      // Ingest re-validates every field against the detector's bounds.
      config: input.config as RuleBacktestInput["config"],
      metric: input.metric ?? null,
      ...(typeof input.through === "string" ? { through: input.through } : {}),
    });
  } catch {
    // Keep store/internal detail behind the service boundary. The panel renders
    // "the replay did not answer" and keeps the settings the operator typed.
    return jsonError("rule_backtest_unavailable", 503);
  }

  if (result.ok) {
    return Response.json(result.backtest, { headers: JSON_HEADERS });
  }
  // A refusal is an answer the panel renders in place of a strip, so each one
  // keeps its own code and its own status: a rule with no replay is not a
  // malformed request, and neither is an asset the store has never heard of.
  if (result.error === "unknown_asset") {
    return jsonError("unknown_asset", 404, { asset: result.asset });
  }
  if (result.error === "unsupported_rule") {
    return jsonError("unsupported_rule", 422, { ruleId: result.ruleId });
  }
  return jsonError("validation", 422, { issues: result.issues });
}
