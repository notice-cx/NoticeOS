import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from './render';
import { demoDocumentUrl, demoFetch, demoVisitBase, demoVisitUrl } from '@/lib/demo-visit';
import { validateDemoViewer } from '../shared/demo-viewer';
import { WallStrip } from '@/components/wall/WallStrip';
import type { SystemBand } from '../shared/wall';
const descriptor = validateDemoViewer({ version: 1, synthetic: true, release: '1'.repeat(40), scenarioHash: '2'.repeat(64), workspaceId: '11111111-1111-4111-8111-111111111111', cutoff: '2026-09-30T00:00:00.000Z', generatedAt: '2026-10-01T00:00:00.000Z' });
const A = 'a'.repeat(32), B = 'b'.repeat(32);
afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });
describe('local replay document transport', () => {
  it('keeps ordinary and standalone viewer URLs unchanged', () => {
    expect(demoVisitBase(`/visit/${A}/wall`)).toBe('/');
    expect(demoVisitUrl('/api/wall')).toBe('/api/wall'); expect(demoDocumentUrl('/')).toBe('/');
    vi.stubGlobal('__DEMO_VIEWER__', descriptor);
    expect(demoVisitBase('/wall')).toBe('/'); expect(demoDocumentUrl('/')).toBe('/');
  });
  it('uses the current document visit rather than a shared browser cookie or stored latest generation', async () => {
    vi.stubGlobal('__DEMO_VIEWER__', descriptor);
    const options = { signal: new AbortController().signal }; const fetch = vi.fn(async () => Response.json({ ok: true })); vi.stubGlobal('fetch', fetch);
    for (const id of [A, B, A]) {
      window.history.replaceState(null, '', `/visit/${id}/wall`);
      expect(demoVisitBase()).toBe(`/visit/${id}`); expect(demoDocumentUrl('/')).toBe(`/visit/${id}/`);
      await demoFetch('/api/wall?selected=example', options);
      expect(fetch).toHaveBeenLastCalledWith(`/visit/${id}/api/wall?selected=example`, options);
    }
    expect(demoDocumentUrl('https://example.com')).toBe('https://example.com');
    expect(demoDocumentUrl('//example.com')).toBe('//example.com');
    expect(demoVisitUrl('/generation/own/module')).toBe('/generation/own/module');
  });
  it('preserves the expired response instead of requesting the current generation', async () => {
    vi.stubGlobal('__DEMO_VIEWER__', descriptor); window.history.replaceState(null, '', `/visit/${A}/wall`);
    const expired = Response.json({ error: 'demo_visit_expired' }, { status: 410 }); const fetch = vi.fn(async () => expired); vi.stubGlobal('fetch', fetch);
    expect(await demoFetch('/api/wall')).toBe(expired); expect(fetch).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledWith(`/visit/${A}/api/wall`, undefined);
  });
  it('the actual Wall Home anchor retains its document visit while ordinary Home remains unchanged', () => {
    const props = { system: {} as SystemBand, assets: [], nowMs: Date.parse('2026-10-01T00:00:00.000Z') };
    const view = render(<WallStrip {...props} />); expect(screen.getByRole('link', { name: /NoticeOS/i })).toHaveAttribute('href', '/');
    vi.stubGlobal('__DEMO_VIEWER__', descriptor); window.history.replaceState(null, '', `/visit/${A}/wall`); view.rerender(<WallStrip {...props} />);
    expect(screen.getByRole('link', { name: /NoticeOS/i })).toHaveAttribute('href', `/visit/${A}/`);
  });
});
