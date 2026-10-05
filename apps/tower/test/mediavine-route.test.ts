import { describe, expect, it, vi } from 'vitest';
import { handleMediavineRequest, type MediavineBinding } from '../worker/mediavine-route';

function binding(): MediavineBinding {
  return {
    mediavineStatus: vi.fn<MediavineBinding['mediavineStatus']>().mockRejectedValue(new Error('No fixture status')),
    saveMediavineSettings: vi.fn<MediavineBinding['saveMediavineSettings']>().mockResolvedValue({ ok: false, message: 'Paused.' }),
    syncMediavine: vi.fn<MediavineBinding['syncMediavine']>().mockResolvedValue({ ok: false, message: 'Wait 15 minutes.' }),
  };
}
async function request(ingest: MediavineBinding, path: string, init: RequestInit = {}) {
  const url = new URL(`http://localhost/api/integrations/mediavine/${path}`);
  return handleMediavineRequest(new Request(url, init), url, ingest);
}
describe('Mediavine UI boundary', () => {
  it('status reads never trigger collection', async () => {
    const ingest = binding();
    await request(ingest, 'status?asset=example.test');
    expect(ingest.mediavineStatus).toHaveBeenCalledWith('example.test');
    expect(ingest.syncMediavine).not.toHaveBeenCalled();
  });
  it('leaves the account\'s site list to the connect panel\'s route (bead ro-ujb9.96.7.6)', async () => {
    const ingest = binding();
    expect((await request(ingest, 'sites', { method: 'POST' })).status).toBe(404);
    expect((await request(ingest, 'sites')).status).toBe(404);
  });
  it('refuses cross-origin and malformed or oversized writes before calling ingest', async () => {
    const ingest = binding();
    expect((await request(ingest, 'sync', { method: 'POST', headers: { origin: 'https://another.test', 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    for (const [body, status] of [['{', 400], ['x'.repeat(4097), 413]] as const) {
      expect((await request(ingest, 'sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status).toBe(status);
    }
    expect(ingest.syncMediavine).not.toHaveBeenCalled();
  });
  it('passes explicit dates and returns a refusal without retrying', async () => {
    const ingest = binding();
    const body = { asset: 'example.test', start: '2026-09-01', end: '2026-09-08' };
    const response = await request(ingest, 'sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(422);
    expect(ingest.syncMediavine).toHaveBeenCalledExactlyOnceWith(body);
    expect(await response.json()).toEqual({ ok: false, message: 'Wait 15 minutes.' });
  });
});
