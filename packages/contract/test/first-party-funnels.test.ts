import { describe, expect, it } from 'vitest';
import { PulseEnvelope } from '../src/schema';
import { buildFirstPartyFunnelResult, readFirstPartyFunnelReport, readFirstPartyFunnelReports, type FirstPartyFunnelReceipt, type FirstPartyFunnelReport } from '../src/first-party-funnels.mjs';
import { journeyDefinitionId, journeyDefinitionsRefusal, readJourneyPeriod, readJourneySnapshot, type JourneyDefinition } from '../src/journeys.mjs';

const now = new Date('2026-11-10T12:00:00Z');
const definition: JourneyDefinition = { id: 'contribution', label: 'Contribution offer to payment', goal: 'One-time contribution', kind: 'funnel', source: 'first-party',
  status: 'active', version: 1, steps: [{ id: 'offer', label: 'Offer seen', alternatives: [] }, { id: 'checkout', label: 'Checkout opened', alternatives: [] }, { id: 'paid', label: 'Paid', alternatives: [] }] };
function report(date: string, counts: [number, number, number] = [100, 10, 2], change: Partial<FirstPartyFunnelReport> = {}): FirstPartyFunnelReport {
  return { schemaVersion: 1, source: 'first-party', journeyId: 'contribution', journeyVersion: 1, definitionId: 'offers-v1', date, timeZone: 'UTC', unit: 'offers',
    steps: [{ id: 'offer', count: counts[0] }, { id: 'checkout', count: counts[1] }, { id: 'paid', count: counts[2] }], ...change };
}
const day = (start: string, offset: number) => new Date(Date.parse(start) + offset * 86_400_000).toISOString().slice(0, 10);
const receipt = (reports: FirstPartyFunnelReport[], receivedAt = '2026-11-10T01:00:00Z'): FirstPartyFunnelReceipt => ({ generatedAt: receivedAt, receivedAt, reports });
/** Daily reports for the 56 settled days before 2026-11-10. */
const history = (counts?: [number, number, number]) => Array.from({ length: 56 }, (_, i) => report(day('2026-09-15', i), counts));
const users = (period: { steps: { users: number | null }[] } | null) => period?.steps.map(step => step.users);

describe('first-party funnel definitions', () => {
  it('accepts site-counted steps and refuses GA4 conditions or time limits on them', () => {
    expect(journeyDefinitionsRefusal([definition])).toBeNull();
    expect(journeyDefinitionsRefusal([{ ...definition, steps: [{ ...definition.steps[0], alternatives: [{ eventName: 'contribution_view' }] }, ...definition.steps.slice(1)] }])).toBe('Invalid journey step');
    expect(journeyDefinitionsRefusal([{ ...definition, steps: [definition.steps[0], { ...definition.steps[1], withinSeconds: 3600 }, definition.steps[2]] }])).toBe('Invalid journey transition duration');
    expect(journeyDefinitionsRefusal([{ ...definition, steps: [definition.steps[0]] }])).toBe('Invalid journey definition');
  });
  it('never fills a site-reported funnel from a stored GA4 snapshot', () => {
    const period = (kind: 'current7') => ({ kind, startDate: '2026-11-03', endDate: '2026-11-09', complete: true, quality: 'complete', steps: definition.steps.map(step => ({ id: step.id, users: 1 })) });
    expect(readJourneySnapshot({ source: 'ga4', countingUnit: 'activeUsers', generatedAt: null, definitions: [definition],
      funnels: [{ journeyId: definition.id, definitionId: journeyDefinitionId(definition), propertyId: '123', timeZone: 'UTC', identity: 'ga4-active-users',
        collectedAt: '2026-11-10T01:00:00Z', current7: period('current7'), prior7: null, current28: null, prior28: null, weekly: [] }],
      exploration: { state: 'unsupported', reason: 'Not collected.' } })).toBeNull();
  });
});

describe('first-party funnel reports', () => {
  const envelope = (firstPartyFunnels: unknown) => ({ asset: 'example.com', generatedAt: '2026-11-10T01:00:00Z', capabilities: [], metrics: {}, firstPartyFunnels });
  it('travel in the existing report envelope', () => {
    expect(PulseEnvelope.parse(envelope([report('2026-11-09')])).firstPartyFunnels).toEqual([report('2026-11-09')]);
  });
  it.each([
    { steps: [{ id: 'offer', count: 10 }, { id: 'checkout', count: 11 }] },
    { steps: [{ id: 'offer', count: 10 }, { id: 'offer', count: 1 }] },
    { steps: [{ id: 'offer', count: 10 }] },
    { steps: [{ id: 'offer', count: 1.5 }, { id: 'paid', count: 1 }] },
    { unit: '' }, { timeZone: 'Unknown/Zone' }, { journeyVersion: 0 }, { visitorId: 'secret' },
  ])('refuses a report a funnel cannot show %j', change => {
    expect(readFirstPartyFunnelReport({ ...report('2026-11-09'), ...change })).toBeNull();
    expect(PulseEnvelope.safeParse(envelope([{ ...report('2026-11-09'), ...change }])).success).toBe(false);
  });
  it('refuses a day that has not ended in its own time zone and a day sent twice', () => {
    const tokyo = report('2026-11-09', undefined, { timeZone: 'Asia/Tokyo' });
    expect(readFirstPartyFunnelReports([tokyo], '2026-11-09T14:59:59Z')).toBeNull();
    expect(readFirstPartyFunnelReports([tokyo], '2026-11-09T15:00:00Z')).toEqual([tokyo]);
    expect(readFirstPartyFunnelReports([report('2026-11-09'), report('2026-11-09')])).toBeNull();
  });
});

describe('first-party funnel periods', () => {
  it('adds daily counts into the same complete periods a GA4 funnel shows', () => {
    const result = buildFirstPartyFunnelResult(definition, [receipt(history())], now)!;
    expect(result).toMatchObject({ identity: 'first-party', propertyId: null, unit: 'offers', timeZone: 'UTC', definitionId: journeyDefinitionId(definition) });
    expect(result.current7).toMatchObject({ startDate: '2026-11-03', endDate: '2026-11-09', quality: 'complete' });
    expect(users(result.current7)).toEqual([700, 70, 14]);
    expect(users(result.prior7)).toEqual([700, 70, 14]);
    expect(users(result.current28)).toEqual([2800, 280, 56]);
    expect(result.prior28).toMatchObject({ startDate: '2026-09-15', quality: 'complete' });
    for (const period of [result.current7, result.prior7, result.current28, result.prior28, ...result.weekly]) expect(readJourneyPeriod(period)).not.toBeNull();
  });
  it('lists weeks from the first reported week, Monday to Sunday', () => {
    const { weekly } = buildFirstPartyFunnelResult(definition, [receipt(history())], now)!;
    expect(weekly.map(week => week.startDate)).toEqual(['2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02']);
    expect(weekly[0]).toMatchObject({ quality: 'unavailable', reason: 'The asset reported 6 of 7 days.' });
    expect(users(weekly.at(-1)!)).toEqual([700, 70, 14]);
  });
  it('replaces a resent day instead of adding to it', () => {
    const corrected = receipt([report('2026-11-09', [100, 10, 5])], '2026-11-10T06:00:00Z');
    expect(users(buildFirstPartyFunnelResult(definition, [receipt(history()), corrected], now)!.current7)).toEqual([700, 70, 17]);
  });
  it('shows no counts for a period with a missing day or a counting change', () => {
    const missing = buildFirstPartyFunnelResult(definition, [receipt(history().filter(r => r.date !== '2026-11-05'))], now)!;
    expect(missing.current7).toMatchObject({ quality: 'unavailable', reason: 'The asset reported 6 of 7 days.' });
    expect(users(missing.current7)).toEqual([null, null, null]);
    expect(missing.prior7?.quality).toBe('complete');
    const changed = buildFirstPartyFunnelResult(definition, [receipt([...history().filter(r => r.date !== '2026-11-05'), report('2026-11-05', undefined, { definitionId: 'offers-v2' })])], now)!;
    expect(changed.current7?.quality).toBe('unavailable');
  });
  it('leaves a day unavailable when its newest report belongs to another definition version', () => {
    const older = receipt([report('2026-11-05', undefined, { journeyVersion: 2 })], '2026-11-10T06:00:00Z');
    expect(buildFirstPartyFunnelResult(definition, [receipt(history()), older], now)!.current7?.quality).toBe('unavailable');
    expect(buildFirstPartyFunnelResult({ ...definition, version: 3 }, [receipt(history())], now)).toBeNull();
  });
  it('waits for the site’s declared reporting delay before counting a day', () => {
    const result = buildFirstPartyFunnelResult({ ...definition, reportingLagDays: 3 }, [receipt(history())], now)!;
    expect(result.current7).toMatchObject({ startDate: '2026-11-01', endDate: '2026-11-07', quality: 'complete' });
  });
});
