import { render } from './render';
import { describe, expect, it } from 'vitest';
import type { CredentialSummary, Ga4RealtimeAsset, IntegrationHealthItem } from '@noticeos/contract';
import type { ConnectionReads } from '@shared/connection-status';
import { LiveUsers } from '@/components/wall/LiveUsers';
import { WALL_FIXTURE_NOW, wallFixturePayload, wallFixtureRealtime } from '../e2e/wall-fixture';

const NOW = Date.parse(WALL_FIXTURE_NOW);
const asset = () => structuredClone(wallFixturePayload().assets[0]!);
const snapshot = () => wallFixtureRealtime().assets.find(reading => reading.asset === asset().id)!;
const credential: CredentialSummary = {
  provider: 'google', source: 'store', fields: [], assetsHeld: [], missingFields: [], auth: 'oauth',
  metadata: null, keyVersion: 1, createdAt: WALL_FIXTURE_NOW, updatedAt: WALL_FIXTURE_NOW,
  lastUsedAt: WALL_FIXTURE_NOW, lastOkAt: WALL_FIXTURE_NOW, lastError: null,
};
const health = (state: IntegrationHealthItem['state']): IntegrationHealthItem => ({
  id: 'live-read', provider: 'google', capability: 'ga4-realtime', label: 'Realtime traffic', asset: asset().id,
  detail: null, report: null, reportDate: null, state, lastAttemptAt: WALL_FIXTURE_NOW,
  lastSuccessAt: state === 'healthy' ? WALL_FIXTURE_NOW : null, nextAttemptAt: null,
  failure: state === 'failing' ? 'network' : null, code: state === 'failing' ? 'network' : null,
  action: 'Review the property connection.', coverage: 'monitored',
});
const reads = (items: IntegrationHealthItem[] = []): ConnectionReads => ({ credentials: new Map([['google', credential]]), items });

describe('live traffic eligibility', () => {
  it('hides a retained reading after Google is disconnected even when the card still reads live', () => {
    const { container } = render(<LiveUsers asset={asset()} snapshot={snapshot()} reconnecting={false} nowMs={NOW}
      connections={{ credentials: new Map(), items: [] }} />);
    expect(container.querySelector('[data-live]')).toHaveAttribute('data-live', 'none');
    expect(container.querySelector('[data-live-count]')).toBeNull();
  });

  it.each(['collecting', 'healthy'] as const)('uses current %s monitoring instead of the card setup state', state => {
    const site = asset();
    site.dataSources = [{ id: 'ga4', label: 'Google Analytics', state: 'needs-setup', observedAt: null, mapped: true }];
    const { container } = render(<LiveUsers asset={site} snapshot={snapshot()} reconnecting={false} nowMs={NOW}
      connections={reads(state === 'healthy' ? [health(state)] : [])} />);
    expect(container.querySelector('[data-live-count]')).toHaveAttribute('data-value', '50');
  });

  it('keeps a successful reading through a monitored failure and preserves its observed age', () => {
    const good = wallFixtureRealtime(0).assets.find(reading => reading.asset === asset().id)!;
    const site = asset();
    const { container, rerender } = render(<LiveUsers asset={site} snapshot={good} reconnecting={false} nowMs={NOW} connections={reads([health('healthy')])} />);
    const failure: Ga4RealtimeAsset = { asset: site.id, status: 'error', activeUsers5m: null, activeUsers30m: null,
      hourlyActiveUsers: null, observedAt: WALL_FIXTURE_NOW, errorCode: 'ga4_network' };
    rerender(<LiveUsers asset={site} snapshot={failure} reconnecting={false} nowMs={NOW + 4 * 60_000} connections={reads([health('failing')])} />);
    expect(container.querySelector('[data-live]')).toHaveAttribute('data-live', 'failed');
    expect(container.querySelector('[data-live-count]')).toHaveAttribute('data-value', '50');
    expect(container.querySelector('[data-live-age]')).toHaveTextContent(/^4m$/);
  });
});
