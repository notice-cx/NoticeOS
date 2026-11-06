import { describe, expect, it } from 'vitest';
import { portfolioBriefEvidenceSchema, portfolioBriefObservationOpening, portfolioBriefResultSchema, type PortfolioBriefEvidence } from '../src/portfolio-brief.js';

const comparison = { current: { start: '2026-10-30', end: '2026-11-05' }, previous: { start: '2026-10-23', end: '2026-10-29' }, timeZone: 'Europe/Paris' };
const evidence = (): PortfolioBriefEvidence => ({ schemaVersion: 1, asOf: '2026-11-06T12:00:00Z', timeZone: 'UTC',
  facts: [{ id: 'comparison', label: 'Example comparison', href: '/assets/example.com', observedAt: null, period: null,
    comparison: { ...comparison, current: { ...comparison.current }, previous: { ...comparison.previous } }, data: {} }],
  insightEvidenceIds: ['comparison'], limitations: [],
  coverage: { assets: 1, includedAssets: 1, projects: 0, readableProjects: 0, omittedAlerts: 0, omittedTasks: 0 },
});

describe('briefing comparison periods', () => {
  it.each(['2026-13-45', '2026-02-29', '2026-04-31', '2026-2-03'])('rejects invalid calendar date %s', value => {
    const packet = evidence();
    packet.facts[0]!.comparison!.current.end = value;
    expect(portfolioBriefEvidenceSchema.safeParse(packet).success).toBe(false);
  });

  it('accepts leap days and preserves ordering validation', () => {
    const packet = evidence();
    packet.facts[0]!.comparison = { current: { start: '2024-02-29', end: '2024-03-06' }, previous: { start: '2024-02-22', end: '2024-02-28' }, timeZone: 'UTC' };
    expect(portfolioBriefEvidenceSchema.safeParse(packet).success).toBe(true);
    packet.facts[0]!.comparison!.previous.end = '2024-02-29';
    expect(portfolioBriefEvidenceSchema.safeParse(packet).success).toBe(false);
  });

  it('counts calendar days across clock changes and keeps both durations explicit', () => {
    expect(portfolioBriefObservationOpening(comparison)).toBe('Over the latest 7 days versus the previous 7, ');
    expect(portfolioBriefObservationOpening({ ...comparison, current: { start: '2026-10-30', end: '2026-10-30' } }))
      .toBe('Over the latest 1 day versus the previous 7, ');
  });

  it('anchors separate nonadjacent windows instead of calling them latest and previous days', () => {
    expect(portfolioBriefObservationOpening({ ...comparison, previous: { start: '2025-10-30', end: '2025-11-05' } }))
      .toBe('From 2026-10-30 to 2026-11-05 versus 2025-10-30 to 2025-11-05, ');
  });

  it.each(['Traffic increased.', 'Over the latest 7 days, traffic increased.', 'Compared with the previous 7, traffic increased.'])('rejects missing measurement period or baseline: %s', observation => {
    expect(portfolioBriefResultSchema.safeParse({ headline: 'Check traffic quality', assessment: 'A closer comparison would support the next decision.', insights: [{
      observation, why: 'The cause is not yet established.', action: 'Compare traffic and revenue breakdowns.', evidenceIds: ['comparison'], confidence: 'medium',
    }] }).success).toBe(false);
  });
});
