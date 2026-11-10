// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { journeyDefinitionId, type JourneyDefinition } from '@noticeos/contract/journeys';
import type { FirstPartyFunnelReport } from '@noticeos/contract/first-party-funnels';
import { readAssetFirstPartyFunnels } from '../worker/asset-first-party-funnels';
import { createTestStore } from './postgres-store';
import { addSites } from './sites';
import { storeReport, storeReports } from './alert-rows';

const now = new Date('2026-11-10T12:00:00Z');
const funnel: JourneyDefinition = { id: 'contribution', label: 'Contribution offer to payment', goal: 'One-time contribution', kind: 'funnel', source: 'first-party', status: 'active', version: 1,
  steps: [{ id: 'offer', label: 'Offer seen', alternatives: [] }, { id: 'paid', label: 'Paid', alternatives: [] }] };
const day = (offset: number) => new Date(Date.parse('2026-11-03') + offset * 86_400_000).toISOString().slice(0, 10);
const report = (date: string, paid = 2): FirstPartyFunnelReport => ({ schemaVersion: 1, source: 'first-party', journeyId: 'contribution', journeyVersion: 1,
  definitionId: 'offers-v1', date, timeZone: 'UTC', unit: 'offers', steps: [{ id: 'offer', count: 100 }, { id: 'paid', count: paid }] });
const row = (date: string, reports: unknown, revision = 1) => ({ asset: 'example.com', date, revision, generatedAt: `${date}T01:00:00Z`, receivedAt: `${date}T0${revision}:00:00Z`,
  envelope: { asset: 'example.com', generatedAt: `${date}T01:00:00Z`, capabilities: [], metrics: {}, ...(reports === undefined ? {} : { firstPartyFunnels: reports }) } });

describe('asset stored first-party funnels', () => {
  it('builds the funnel from the newest stored report for each day of this asset', async () => {
    const f = await createTestStore();
    await addSites(f, [{ id: 'example.com', displayName: 'Example', status: 'live' }, { id: 'other.example', displayName: 'Other', status: 'live' }]);
    // Each day's report arrives in the next day's envelope.
    await storeReports(f.call, Array.from({ length: 7 }, (_, i) => row(day(i + 1), [report(day(i))])));
    await storeReport(f.call, row('2026-11-10', [report('2026-11-09', 7)], 2));
    await storeReport(f.call, row('2026-11-10', undefined, 3));
    await storeReport(f.call, { ...row('2026-11-10', [report('2026-11-08', 99)]), asset: 'other.example' });
    const [result] = await readAssetFirstPartyFunnels(f.call, 'example.com', [funnel], now);
    expect(result).toMatchObject({ journeyId: 'contribution', definitionId: journeyDefinitionId(funnel), identity: 'first-party', unit: 'offers' });
    expect(result?.current7?.steps).toEqual([{ id: 'offer', users: 700 }, { id: 'paid', users: 19 }]);
    expect(await readAssetFirstPartyFunnels(f.call, 'example.com', [{ ...funnel, status: 'planned' }], now)).toEqual([]);
  });
});
