// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { handleModelDiscoveryRequest, MODEL_DISCOVERY_PATH } from '../worker/model-discovery-route';

const url = `https://tower.example${MODEL_DISCOVERY_PATH}`;
const fields = { LOCAL_MODEL_BASE_URL: 'https://models.example/api/v1', LOCAL_MODEL_API_TOKEN: 'private-test-token' };
const request = (body: unknown = { fields }, headers: Record<string, string> = {}) =>
  new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('model discovery route', () => {
  it('forwards unsaved connection details and returns only discovered models without caching', async () => {
    const discoverModelProvider = vi.fn(async () => ({ ok: true as const, models: ['example-model'] }));
    const response = await handleModelDiscoveryRequest(request(), { discoverModelProvider });
    expect(discoverModelProvider).toHaveBeenCalledWith({ fields });
    expect(await response.json()).toEqual({ ok: true, models: ['example-model'] });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('preserves safe provider failures and hides transport exception details', async () => {
    const discovery = { discoverModelProvider: vi.fn(async () => ({ ok: false as const, failure: { kind: 'access' as const, status: 401 } })) };
    expect(await (await handleModelDiscoveryRequest(request(), discovery)).json()).toEqual({ ok: false, failure: { kind: 'access', status: 401 } });
    const response = await handleModelDiscoveryRequest(request(), { discoverModelProvider: async () => { throw new Error(fields.LOCAL_MODEL_API_TOKEN); } });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(fields.LOCAL_MODEL_API_TOKEN);
  });

  it('rejects cross-origin, non-JSON and malformed requests before discovery', async () => {
    const discoverModelProvider = vi.fn();
    const cases: [Request, number][] = [
      [new Request(url), 405],
      [request(undefined, { origin: 'https://other.example' }), 403],
      [request(undefined, { 'sec-fetch-site': 'cross-site' }), 403],
      [request(undefined, { 'content-type': 'text/plain' }), 415],
      [new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }), 400],
      [request({ fields: [] }), 422],
      [request({ fields: { LOCAL_MODEL_BASE_URL: 123 } }), 422],
      [request({ fields: { LOCAL_MODEL_API_TOKEN: 'x'.repeat(16_384) } }), 413],
    ];
    for (const [input, status] of cases) expect((await handleModelDiscoveryRequest(input, { discoverModelProvider })).status).toBe(status);
    expect(discoverModelProvider).not.toHaveBeenCalled();
  });
});
