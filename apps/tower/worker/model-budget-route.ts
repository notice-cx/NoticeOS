import type { SetModelOutputTokensInput, SetModelOutputTokensResult } from '@noticeos/contract';
import { MIN_LOCAL_MODEL_OUTPUT_TOKENS, MAX_LOCAL_MODEL_OUTPUT_TOKENS } from '@noticeos/contract/local-model-settings';
import { readBoundedJsonText } from '../../../scripts/bounded-json-body.mjs';
import { crossOrigin, isJsonRequest, jsonError } from './http';

export const MODEL_BUDGET_PATH = '/api/integrations/local-model/budget';
export interface ModelBudgetWriter {
  setModelOutputTokens?(input: SetModelOutputTokensInput): Promise<SetModelOutputTokensResult>;
}

export async function handleModelBudgetRequest(request: Request, ingest: ModelBudgetWriter): Promise<Response> {
  if (request.method !== 'PUT') return jsonError('method_not_allowed', 405);
  if (crossOrigin(request, new URL(request.url))) return jsonError('forbidden', 403);
  if (!isJsonRequest(request)) return jsonError('unsupported_media_type', 415);
  let input: unknown;
  try { input = JSON.parse(await readBoundedJsonText(request, 512)) as unknown; } catch { return jsonError('model_budget_validation', 400); }
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join(',') !== 'modelOutputTokens') return jsonError('model_budget_validation', 422);
  const value = (input as { modelOutputTokens: unknown }).modelOutputTokens;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_LOCAL_MODEL_OUTPUT_TOKENS || value > MAX_LOCAL_MODEL_OUTPUT_TOKENS) {
    return jsonError('model_budget_validation', 422, { field: 'modelOutputTokens', message: `Choose a whole number from ${MIN_LOCAL_MODEL_OUTPUT_TOKENS} to ${MAX_LOCAL_MODEL_OUTPUT_TOKENS}.` });
  }
  if (!ingest.setModelOutputTokens) return jsonError('model_budget_unavailable', 503);
  try {
    const result = await ingest.setModelOutputTokens({ modelOutputTokens: value });
    if (result.ok) return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    const status = result.error === 'validation' ? 422 : result.error === 'not_supported' ? 403 : result.error === 'key_missing' ? 503 : 409;
    return jsonError(`model_budget_${result.error}`, status);
  } catch { return jsonError('model_budget_unavailable', 503); }
}
