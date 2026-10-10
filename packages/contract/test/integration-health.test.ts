import { describe, expect, it } from 'vitest';
import { INTEGRATION_PROVIDERS } from '../src/integrations.js';
import { INTEGRATION_MONITORS, integrationCapabilityHealth, type IntegrationHealthScope, type IntegrationObservation } from '../src/integration-health.js';

const scope: IntegrationHealthScope = { workspace: 'local', provider: 'google', connection: 'revision-1', capability: 'ga4-realtime', asset: 'meadow.example', target: 'property-a', family: '' };
const nowMs = Date.parse('2026-09-11T00:00:00Z');
const observation = (outcome: 'failure' | 'success', startedAt = '2026-09-10T23:59:00Z'): IntegrationObservation => ({ scope, attemptId: `${outcome}:${startedAt}`, startedAt, finishedAt: startedAt, outcome, failure: outcome === 'failure' ? 'rate-limit' : null, code: outcome === 'failure' ? 'google-rate-limit' : null, nextAttemptAt: null });
const derive = (observations: IntegrationObservation[], extra: Partial<Parameters<typeof integrationCapabilityHealth>[0]> = {}) => integrationCapabilityHealth({ scope, connection: 'connected', covered: true, observerAvailable: true, trigger: 'demand', observations, requiredSince: '2026-09-10T23:58:00Z', nowMs, ...extra });

describe('integration monitoring coverage', () => {
  it('covers every connected provider explicitly', () => {
    expect(Object.keys(INTEGRATION_MONITORS).sort()).toEqual(INTEGRATION_PROVIDERS.map((provider) => provider.id).sort());
    const monitors = Object.values(INTEGRATION_MONITORS).flat();
    expect(new Set(monitors.map((item) => item.id)).size).toBe(monitors.length);
    for (const item of monitors) {
      expect(['scheduled', 'demand', 'event', 'setup']).toContain(item.trigger);
      expect(item.action.length).toBeGreaterThan(10);
    }
  });
  it('cannot describe live-only or delivery-success-only evidence as durable monitoring', () => {
    expect(INTEGRATION_MONITORS.google.find((item) => item.id === 'ga4-realtime')?.evidence).toBe('live-only');
    expect(INTEGRATION_MONITORS.discord[0]?.evidence).toBe('success-only');
  });
});

describe('capability-level health', () => {
  it('preserves a failure until the same capability succeeds, even after it goes stale', () => {
    expect(derive([observation('failure')], { requiredSince: '2026-09-10T23:59:59Z' }).state).toBe('failing');
    expect(derive([observation('failure'), observation('success', '2026-09-10T23:59:30Z')])).toMatchObject({ state: 'healthy', lastSuccessAt: '2026-09-10T23:59:30Z' });
  });
  it.each(['workspace', 'connection', 'capability', 'asset', 'target', 'family'] as const)('isolates recovery by %s', (key) => {
    const other = { ...observation('success', '2026-09-10T23:59:30Z'), scope: { ...scope, [key]: 'unrelated' } };
    expect(derive([observation('failure'), other]).state).toBe('failing');
  });
  it('rejects a delayed earlier success as proof of recovery', () => {
    const delayed = { ...observation('success', '2026-09-10T23:58:30Z'), finishedAt: '2026-09-10T23:59:45Z' };
    expect(derive([delayed, observation('failure')]).state).toBe('failing');
  });
  it('keeps last-success evidence ordered by attempt start even when responses arrive late', () => {
    const old = { ...observation('success', '2026-09-10T23:58:30Z'), finishedAt: '2026-09-10T23:59:45Z' };
    expect(derive([old, observation('success')]).lastSuccessAt).toBe('2026-09-10T23:59:00Z');
  });
  it('marks successful data stale against its own collection obligation', () => {
    expect(derive([observation('success')], { requiredSince: '2026-09-10T23:59:30Z' }).state).toBe('stale');
  });
  it('does not call missing instrumentation, future evidence, or a failed observer healthy', () => {
    expect(derive([observation('success')], { covered: false }).state).toBe('unmonitored');
    expect(derive([observation('success')], { observerAvailable: false }).state).toBe('unknown');
    expect(derive([observation('success', '2026-09-11T01:00:00Z')]).state).toBe('unknown');
  });
  it('distinguishes not configured, paused, never run, and event-driven idle', () => {
    expect(derive([], { connection: 'disconnected' }).state).toBe('disconnected');
    expect(derive([], { connection: 'paused' }).state).toBe('paused');
    expect(derive([]).state).toBe('never-run');
    expect(derive([], { trigger: 'event', requiredSince: null }).state).toBe('idle');
    expect(derive([], { trigger: 'event' }).state).toBe('never-run');
    expect(derive([observation('success')], { trigger: 'event' }).state).toBe('healthy');
    expect(derive([observation('success')], { requiredSince: null }).state).toBe('idle');
    expect(derive([observation('failure')], { trigger: 'event', requiredSince: null }).state).toBe('failing');
  });
});
