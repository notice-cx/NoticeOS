import { describe, expect, it } from 'vitest';
import { portfolioBriefEvidenceSchema, portfolioBriefFactOpening, portfolioBriefObservationOpening, portfolioBriefResultSchema, type PortfolioBriefEvidence } from '../src/portfolio-brief.js';

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

  it('names accounting months rather than calling an earlier calendar month the latest days', () => {
    expect(portfolioBriefObservationOpening({ current: { start: '2026-10-01', end: '2026-10-31' }, previous: { start: '2026-09-01', end: '2026-09-30' }, timeZone: 'UTC' }))
      .toBe('In October versus September, ');
  });

  it.each(['Traffic increased.', 'Over the latest 7 days, traffic increased.', 'Compared with the previous 7, traffic increased.'])('rejects missing measurement period or baseline: %s', observation => {
    expect(portfolioBriefResultSchema.safeParse({ headline: 'Check traffic quality', assessment: 'A closer comparison would support the next decision.', insights: [{
      title: 'Review acquisition', observation, why: 'The cause is not yet established.', action: 'Compare traffic and revenue breakdowns.', evidenceIds: ['comparison'], confidence: 'medium',
    }] }).success).toBe(false);
  });
});

describe('briefing observation context', () => {
  it('accepts a dated operational relationship without inventing comparison periods', () => {
    const packet = evidence();
    packet.facts = [{ id: 'decision', domain: 'delivery', basis: 'task-dependency', label: 'A decision and its dependencies', href: '/tasks', observedAt: packet.asOf, period: null, data: {} }];
    packet.insightEvidenceIds = ['decision'];
    expect(portfolioBriefEvidenceSchema.safeParse(packet).success).toBe(true);
    expect(portfolioBriefFactOpening(packet.facts[0]!)).toBe('Currently, ');
    packet.facts[0]!.observedAt = null;
    expect(portfolioBriefEvidenceSchema.safeParse(packet).success).toBe(false);
  });

  it('keeps a product observation tied to its own source window', () => {
    const packet = evidence();
    packet.facts = [{ id: 'product', domain: 'product', basis: 'period-observation', label: 'Checkout', href: '/assets/example.com', observedAt: packet.asOf, period: { start: '2026-10-30', end: '2026-11-05' }, data: {} }];
    packet.insightEvidenceIds = ['product'];
    expect(portfolioBriefEvidenceSchema.safeParse(packet).success).toBe(true);
    expect(portfolioBriefFactOpening(packet.facts[0]!)).toBe('Over the 7 days ending Nov 5, ');
    packet.facts[0]!.period = null;
    expect(portfolioBriefEvidenceSchema.safeParse(packet).success).toBe(false);
  });

  it('allows three explained findings, but rejects a fourth and oversized prose', () => {
    const insight = { title: 'Review the next decision', observation: `Currently, ${'observed '.repeat(45)}relationships need review.`,
      why: 'The connection changes which work deserves attention first.', action: 'Review the recorded blocker before choosing the next task.', evidenceIds: ['decision'], confidence: 'medium' };
    const result = { headline: 'Focus on decisions holding up progress', assessment: 'The observations support a focused review before starting more work.', insights: [insight, insight, insight] };
    expect(portfolioBriefResultSchema.safeParse(result).success).toBe(true);
    expect(portfolioBriefResultSchema.safeParse({ ...result, insights: [...result.insights, insight] }).success).toBe(false);
    const verbose = { ...insight, why: 'context '.repeat(45).trim() + '.', action: 'action '.repeat(45).trim() + '.' };
    expect(portfolioBriefResultSchema.safeParse({ ...result, insights: [verbose, verbose, verbose] }).success).toBe(false);
  });
});
