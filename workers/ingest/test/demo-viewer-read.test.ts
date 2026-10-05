import { describe, expect, it, vi } from 'vitest';
import { demoRequestPolicy, validateDemoViewer } from '../../../scripts/demo-viewer-policy.mjs';
import { handleConfigDocuments } from '../src/routes/config-documents.js';
import { handleManualJobRuns } from '../src/routes/job-runs.js';

const viewer = validateDemoViewer({ version: 1, synthetic: true, release: '1'.repeat(40), scenarioHash: '2'.repeat(64),
  workspaceId: '11111111-1111-4111-8111-111111111111', cutoff: '2026-09-15T12:00:00.000Z', generatedAt: null });

describe('demo stored reads retain the ingest operator guard', () => {
  it('missing and invalid operator authorization refuse before opening a store or binding', async () => {
    const otherAccess = vi.fn(() => { throw new Error('An unauthorized demo read reached a store or binding'); });
    const env = new Proxy({ OPERATOR_TOKEN: 'synthetic-operator' } as IngestEnv, {
      get(target, key) { return key === 'OPERATOR_TOKEN' ? target.OPERATOR_TOKEN : otherAccess(); },
    });
    for (const [path, handle] of [['/api/config-documents?bodies=1', handleConfigDocuments],
      ['/api/job-runs?trigger=manual', handleManualJobRuns]] as const) {
      expect(demoRequestPolicy(viewer, 'GET', `/api/runner/ingest${path.split('?')[0]}`)).toBe('read');
      for (const authorization of [null, 'Basic synthetic-operator', 'Bearer wrong-operator']) {
        const request = new Request(`https://ingest.example${path}`, { headers: authorization ? { authorization } : {} });
        const response = await handle(request, env);
        expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: 'unauthorized' });
      }
    }
    expect(otherAccess).not.toHaveBeenCalled();
  });
});
