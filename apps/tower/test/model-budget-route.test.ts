// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { handleModelBudgetRequest, MODEL_BUDGET_PATH } from '../worker/model-budget-route';

const url = `https://tower.example${MODEL_BUDGET_PATH}`;
const request = (input: unknown = { modelOutputTokens: 16_384 }, headers: Record<string, string> = {}) => new Request(url, {
  method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(input),
});
describe('model generation budget route', () => {
  it('saves only the bounded non-secret budget without any discovery or credential payload', async () => {
    const setModelOutputTokens = vi.fn(async () => ({ ok: true as const }));
    const response = await handleModelBudgetRequest(request(), { setModelOutputTokens });
    expect(response.status).toBe(204);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(setModelOutputTokens).toHaveBeenCalledExactlyOnceWith({ modelOutputTokens: 16_384 });
    expect(await response.text()).toBe('');
  });

  it('refuses cross-origin, non-JSON, oversized and expanded inputs before any save', async () => {
    const setModelOutputTokens = vi.fn();
    const cases: [Request, number][] = [
      [new Request(url), 405], [request(undefined, { origin: 'https://other.example' }), 403],
      [request(undefined, { 'sec-fetch-site': 'cross-site' }), 403], [request(undefined, { 'content-type': 'text/plain' }), 415],
      [new Request(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{' }), 400],
      [request({ modelOutputTokens: 1023 }), 422], [request({ modelOutputTokens: 32_769 }), 422], [request({ modelOutputTokens: 8192.5 }), 422],
      [request({ modelOutputTokens: '8192' }), 422], [request({ modelOutputTokens: 8192, LOCAL_MODEL_API_TOKEN: 'synthetic-private' }), 422],
      [request({ modelOutputTokens: 8192, unknown: 'x'.repeat(1000) }), 400],
    ];
    for (const [input, status] of cases) expect((await handleModelBudgetRequest(input, { setModelOutputTokens })).status).toBe(status);
    expect(setModelOutputTokens).not.toHaveBeenCalled();
  });

  it.each([['store_required', 409], ['not_connected', 409], ['conflict', 409], ['key_missing', 503], ['not_supported', 403], ['validation', 422]] as const)('maps %s safely', async (error, status) => {
    const response = await handleModelBudgetRequest(request(), { setModelOutputTokens: async () => ({ ok: false, error }) });
    expect(response.status).toBe(status); expect(await response.json()).toEqual({ error: `model_budget_${error}` });
  });

  it('never returns internal credential details after a failed save', async () => {
    const response = await handleModelBudgetRequest(request(), { setModelOutputTokens: async () => { throw new Error('synthetic-private-endpoint-and-token'); } });
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('synthetic-private');
  });
});
