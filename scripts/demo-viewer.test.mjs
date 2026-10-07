import assert from 'node:assert/strict';
import test from 'node:test';
import { demoMcpRequestAllowed, demoRequestPolicy, demoViewerCapabilities, validateDemoViewer, viewerWritable } from './demo-viewer-policy.mjs';

const input = () => ({ version: 1, synthetic: true, release: '1'.repeat(40), scenarioHash: '2'.repeat(64),
  workspaceId: '11111111-1111-4111-8111-111111111111', cutoff: '2026-09-15T12:00:00.000Z', generatedAt: null });
const viewer = validateDemoViewer(input());
test('the descriptor is immutable, copies inputs and refuses unknown or malformed identity/provenance', () => {
  const raw = input(); const value = validateDemoViewer(raw); raw.release = '3'.repeat(40);
  assert.equal(value.release, '1'.repeat(40)); assert.equal(Object.isFrozen(value), true);
  for (const defect of [null, [], {}, { ...input(), synthetic: false }, { ...input(), version: 2 },
    { ...input(), release: 'main' }, { ...input(), scenarioHash: 'fake' }, { ...input(), workspaceId: 'another' },
    { ...input(), cutoff: '2026-02-30T12:00:00.000Z' }, { ...input(), generatedAt: 'today' },
    { ...input(), token: 'never-propagated' }, { ...input(), generatedAt: undefined }]) {
    assert.throws(() => validateDemoViewer(defect), /descriptor is invalid/u);
  }
  assert.equal(validateDemoViewer({ ...input(), generatedAt: '2026-09-16T00:00:00.000Z' }).generatedAt, '2026-09-16T00:00:00.000Z');
});
test('stored reads and both semantic POST readers remain available', () => {
  const paths = ['/api/health', '/api/wall', '/api/wall/feed', '/api/financials', '/api/settings', '/api/alerts/history',
    '/api/alerts/rules', '/api/task-source', '/api/work', '/api/integrations', '/api/integrations/health',
    '/api/integrations/providers', '/api/integrations/mediavine/status', '/api/scheduled-jobs', '/api/workflows',
    '/api/runner/ingest/api/config-documents', '/api/runner/ingest/api/job-runs',
    '/api/assets/example.com', '/api/assets/example%2Ecom', '/api/assets/os-a1b2', '/api/assets/example.com/decisions',
    '/api/assets/example.com/watch-query-history', '/api/tasks', '/api/tasks/projects', '/api/tasks/ex-example.1', '/api/ga4/realtime'];
  for (const path of paths) assert.equal(demoRequestPolicy(viewer, 'GET', path), 'read', path);
  for (const path of ['/api/mcp', '/api/alerts/backtest']) assert.equal(demoRequestPolicy(viewer, 'POST', path), 'read');
});
test('safe-looking GETs, runner events, unknown APIs and malformed targets refuse', () => {
  const paths = ['/api/calendar/upcoming', '/api/site-name', '/api/integrations/google/start',
    '/api/integrations/google/callback', '/api/integrations/google/properties', '/api/integrations/clarity/sites',
    '/api/integrations/clarity/test', '/api/integrations/import-env', '/api/runner/ingest', '/api/new-reader',
    '/cdn-cgi/handler/scheduled', '/api/assets/example%2Fcom', '/api/assets/example%252Fcom', '/api/assets/%',
    '/api/tasks/example-unsafe-id', '/api/tasks/ex-example/comments', '/api/assets/example.com/unknown'];
  for (const path of paths) assert.equal(demoRequestPolicy(viewer, 'GET', path), 'refuse', path);
});
test('every mutation method refuses even when a GET at that path is allowed', () => {
  const paths = ['/api/config', '/api/assets', '/api/assets/example.com', '/api/assets/example.com/decisions',
    '/api/assets/example.com/annotations', '/api/assets/example.com/watch-windows', '/api/flags/1', '/api/tasks',
    '/api/tasks/projects', '/api/tasks/ex-example', '/api/tasks/ex-example/close', '/api/gates/ex-gate/resolve',
    '/api/integrations/clarity/credential', '/api/integrations/clarity/expiry', '/api/integrations/clarity/connect',
    '/api/integrations/clarity/site-token', '/api/integrations/clarity/collect', '/api/integrations/mediavine/sync',
    '/api/integrations/mediavine/settings', '/api/runner/scheduled', '/api/health'];
  for (const path of paths) for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    assert.equal(demoRequestPolicy(viewer, method, path), 'refuse', `${method} ${path}`);
  }
});
test('capabilities preserve read availability without falsely advertising writes', () => {
  assert.equal(demoRequestPolicy(viewer, 'GET', '/api/config'), 'config-capability');
  assert.equal(demoRequestPolicy(viewer, 'GET', '/api/tasks/capabilities'), 'task-capability');
  assert.equal(demoRequestPolicy(viewer, 'GET', '/api/demo-viewer'), 'descriptor');
  assert.equal(viewerWritable(viewer, true), false);
  assert.equal(viewerWritable(null, true), true); assert.equal(viewerWritable(null, false), false);
});
test('ordinary installations retain their existing dispatch for all methods and paths', () => {
  for (const path of ['/api/new-reader', '/api/config', '/api/runner/scheduled', '/api/mcp']) {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(demoRequestPolicy(null, method, path), 'ordinary');
  }
});

test('only the two exact private GET readers pass; neighboring runner paths and every other method refuse', () => {
  const reads = ['/api/runner/ingest/api/config-documents', '/api/runner/ingest/api/job-runs'];
  for (const path of reads) {
    assert.equal(demoRequestPolicy(viewer, 'GET', path), 'read');
    for (const method of ['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) assert.equal(demoRequestPolicy(viewer, method, path), 'refuse');
    for (const suffix of ['/', '/seed', '/apply', '%2Fseed']) assert.equal(demoRequestPolicy(viewer, 'GET', path + suffix), 'refuse');
  }
  for (const path of ['/api/runner/scheduled', '/api/runner/ingest/api/pulse', '/api/runner/ingest/healthz', '/api/runner/ingest/api/config-documents-other']) {
    assert.equal(demoRequestPolicy(viewer, 'GET', path), 'refuse');
  }
});

test('capabilities preserve real availability and provenance without inventing sources', () => {
  const source = { live: false, reason: 'read_only_deployment', sources: { 'config/beads.json': 'store' }, store: { ready: false } };
  assert.deepEqual(demoViewerCapabilities(viewer, '/api/tasks/capabilities', source), { ...source, writable: false });
  assert.equal(demoViewerCapabilities(null, '/api/config', source), source);
  assert.equal(demoViewerCapabilities(viewer, '/api/other', source), source);
  assert.throws(() => demoViewerCapabilities(viewer, '/api/config', null), /response is invalid/u);
});
test('MCP only accepts reviewed tool reads and transport methods in a demo', () => {
  for (const name of ['list_properties', 'property_report', 'research_lookup']) {
    assert.equal(demoMcpRequestAllowed(viewer, { jsonrpc: '2.0', method: 'tools/call', params: { name } }), true);
  }
  for (const value of [null, [], {}, { jsonrpc: '2.0', method: 'tools/call', params: { name: 'new_write_tool' } },
    { jsonrpc: '2.0', method: 'notifications/new-operation' }, { jsonrpc: '2.0', method: 'tools/call', params: null }]) {
    assert.equal(demoMcpRequestAllowed(viewer, value), false);
  }
  for (const method of ['initialize', 'server/discover', 'notifications/initialized', 'ping', 'tools/list']) {
    assert.equal(demoMcpRequestAllowed(viewer, { jsonrpc: '2.0', method }), true, method);
  }
  assert.equal(demoMcpRequestAllowed(null, { method: 'ordinary' }), true);
});
