// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { portfolioBriefEvidenceSchema, type PortfolioBriefEvidence, type PortfolioBriefFact } from '@noticeos/contract/portfolio-brief';
import { packPortfolioBriefContext, PORTFOLIO_BRIEF_CONTEXT_BYTES } from '../worker/portfolio-brief-context';

const NOW = '2026-11-06T12:00:00Z';
const domains = ['finance', 'acquisition', 'product', 'delivery', 'outcomes', 'operations'] as const;
function fact(domain: typeof domains[number], owner: string, index: number, text = 'Synthetic observation.'): PortfolioBriefFact {
  return { id: `asset:${owner}:${domain}-${index}`, label: `${domain} observation`, href: '/assets', observedAt: NOW, period: null,
    domain, basis: 'current-state', data: { asset: owner, text } };
}
function packet(facts: PortfolioBriefFact[], eligible = facts.map(fact => fact.id)): PortfolioBriefEvidence {
  return { schemaVersion: 1, asOf: NOW, timeZone: 'UTC', facts, insightEvidenceIds: eligible,
    limitations: ['Synthetic sampled observations do not establish causation.'],
    coverage: { assets: 40, includedAssets: 40, projects: 2, readableProjects: 1, omittedAlerts: 3, omittedTasks: 4 } };
}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe('briefing context packing', () => {
  it('reserves all available domains, bounds Unicode bytes and keeps accurate omissions and citations', () => {
    const facts = domains.flatMap(domain => Array.from({ length: 30 }, (_, index) => fact(domain, `${index}.example`, index, '観測🙂'.repeat(100))));
    const input = packet(facts);
    const original = JSON.stringify(input);
    const packed = packPortfolioBriefContext(input);
    expect(bytes(packed)).toBeLessThanOrEqual(PORTFOLIO_BRIEF_CONTEXT_BYTES);
    expect(packed.facts.length).toBeLessThan(facts.length);
    expect(packed.coverage).toEqual(input.coverage);
    expect(packed.context!.domains).toHaveLength(6);
    for (const domain of packed.context!.domains) {
      expect(domain.availableFacts).toBe(30);
      expect(domain.includedFacts).toBeGreaterThan(0);
      expect(domain.omittedFacts).toBe(30 - domain.includedFacts);
      expect(domain.eligibleFacts).toBe(domain.includedFacts);
    }
    expect(packed.insightEvidenceIds.every(id => packed.facts.some(fact => fact.id === id))).toBe(true);
    expect(portfolioBriefEvidenceSchema.safeParse(packed).success).toBe(true);
    expect(JSON.stringify(input)).toBe(original);
  });

  it('prioritizes useful recent late-alphabet assets instead of filling the context from the first asset', () => {
    const old = Array.from({ length: 50 }, (_, index) => ({ ...fact('acquisition', 'a.example', index, 'x'.repeat(400)), observedAt: '2026-10-01T00:00:00Z' }));
    const late = fact('acquisition', 'z.example', 0, 'A current decision-relevant relationship.');
    const packed = packPortfolioBriefContext(packet([...old, late], [late.id]), 4_000);
    expect(packed.facts[0]!.id).toBe(late.id);
    expect(packed.insightEvidenceIds).toEqual([late.id]);
    expect(packed.facts.filter(fact => fact.id.startsWith('asset:a.example:')).length).toBeLessThan(old.length);
    expect(bytes(packed)).toBeLessThanOrEqual(4_000);
  });

  it('gives different assets turns even when the first owns many high-ranked observations', () => {
    const many = Array.from({ length: 30 }, (_, index) => fact('product', 'a.example', index, 'x'.repeat(500)));
    const other = fact('product', 'z.example', 0, 'Second asset evidence.');
    const packed = packPortfolioBriefContext(packet([...many, other]), 4_000);
    expect(packed.facts.some(fact => fact.id === other.id)).toBe(true);
    expect(packed.context!.domains.find(row => row.domain === 'product')!.availableFacts).toBe(31);
  });

  it('drops oversized facts atomically and includes smaller facts from that domain', () => {
    const huge = fact('finance', 'large.example', 0, '🙂'.repeat(10_000));
    const small = fact('finance', 'small.example', 0);
    const packed = packPortfolioBriefContext(packet([huge, small]));
    expect(packed.facts.map(fact => fact.id)).toEqual([small.id]);
    expect(packed.facts[0]!.data).toEqual(small.data);
    expect(packed.context!.domains.find(row => row.domain === 'finance')).toMatchObject({ availableFacts: 2, includedFacts: 1, eligibleFacts: 1, omittedFacts: 1 });
  });

  it('always lists unknown domains, infers conservative existing source domains and remains deterministic', () => {
    const facts: PortfolioBriefFact[] = [
      { id: 'asset:example.com:traffic', label: 'Traffic', href: '/assets', observedAt: NOW, period: null, data: {} },
      { id: 'asset:example.com:ledger', label: 'Ledger', href: '/financials', observedAt: NOW, period: null, data: {} },
      { id: 'task:example.com:ex-1', label: 'Task', href: '/tasks', observedAt: NOW, period: null, data: {} },
    ];
    const input = packet(facts, []);
    const first = packPortfolioBriefContext(input);
    expect(first).toEqual(packPortfolioBriefContext(input));
    expect(first.facts.map(fact => fact.domain)).toEqual(['finance', 'acquisition', 'delivery']);
    for (const domain of ['product', 'outcomes', 'operations']) expect(first.context!.domains.find(row => row.domain === domain))
      .toMatchObject({ availableFacts: 0, includedFacts: 0, eligibleFacts: 0, omittedFacts: 0 });
  });

  it('prioritizes an eligible explicit relationship over equally recent standalone facts', () => {
    const simple = fact('delivery', 'example.com', 0);
    const relationship = { ...fact('delivery', 'example.com', 1), id: 'task-dependency:example.com:ex-1', basis: 'task-dependency' as const };
    const packed = packPortfolioBriefContext(packet([simple, relationship]));
    expect(packed.facts[0]!.id).toBe(relationship.id);
  });

  it('rejects an impossible metadata budget and budgets outside the transport limit', () => {
    for (const budget of [0, -1, 96_001, NaN, 1.5]) expect(() => packPortfolioBriefContext(packet([]), budget)).toThrow(RangeError);
    expect(() => packPortfolioBriefContext(packet([]), 1)).toThrow('metadata exceeds');
  });
});
