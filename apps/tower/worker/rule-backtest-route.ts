// POST /api/alerts/backtest — "how often would this alert rule have fired in the
// last 30 days with these settings?" (bead `ro-u072`, docs/15 principle 1).
//
// READ-ONLY DESPITE THE VERB. It is a POST because the question's key is a whole
// settings object the operator is still typing, which does not survive a query
// string honestly — the same reasoning `POST /api/research-log/lookup` records
// in the ingest Worker. Nothing is written on either side of the binding: no
// flag, no disposition, no config value. Saving the settings the operator ends
// up choosing is a separate action through the D18 write lane.
//
// The answer is produced inside ingest, which owns the `pulses` read the seasonal
// baseline is assembled from. This route only carries the question across.

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
      // Every field is re-validated inside ingest, which is the authority on the
      // detector's own bounds. What crosses here is the operator's intent.
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
  // A refusal is an ANSWER the panel renders in place of a strip, so each one
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
