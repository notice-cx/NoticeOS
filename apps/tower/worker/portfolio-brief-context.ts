import { PORTFOLIO_BRIEF_CONTEXT_BYTES, PORTFOLIO_BRIEF_MAX_BYTES, portfolioBriefUtf8Bytes, type PortfolioBriefDomain, type PortfolioBriefEvidence, type PortfolioBriefFact } from '@noticeos/contract/portfolio-brief';

type Domain = PortfolioBriefDomain;
const QUESTIONS: Record<Domain, string> = {
  finance: 'Which revenue or cost changes alter the next spending decision?',
  acquisition: 'What changed in demand or acquisition performance?',
  product: 'Where are usage, conversion or reliability limiting customer value?',
  delivery: 'Which decisions or dependencies constrain useful progress?',
  outcomes: 'What results support continuing, changing or stopping work?',
  operations: 'Which failures or coverage gaps threaten execution or confidence?',
};
const DOMAINS = Object.keys(QUESTIONS) as Domain[];
export { PORTFOLIO_BRIEF_CONTEXT_BYTES };
type ContextFact = PortfolioBriefFact;
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const bytes = (value: unknown) => portfolioBriefUtf8Bytes(JSON.stringify(value));

function domainOf(fact: ContextFact): Domain {
  if (fact.domain && DOMAINS.includes(fact.domain)) return fact.domain;
  if (fact.id.endsWith(':ledger') || fact.id.endsWith(':traffic-revenue')) return 'finance';
  if (fact.id.endsWith(':traffic') || fact.id === 'portfolio:traffic-divergence') return 'acquisition';
  if (fact.id.startsWith('task:') || fact.id.startsWith('task-dependency:') || fact.id.startsWith('work:')) return 'delivery';
  if (fact.id.endsWith(':signals') && fact.data.product) return 'product';
  if (fact.id.endsWith(':signals') && fact.data.watches) return 'outcomes';
  return 'operations';
}
function ownerOf(fact: ContextFact): string {
  const match = /^(?:asset|task|task-dependency):(.+):[^:]+$/u.exec(fact.id);
  return match?.[1] ?? (typeof fact.data.asset === 'string' ? fact.data.asset : typeof fact.data.project === 'string' ? fact.data.project : 'portfolio');
}
function relationship(fact: ContextFact): boolean {
  return fact.basis === 'task-dependency' || fact.id.endsWith(':traffic-revenue') || fact.id === 'portfolio:traffic-divergence';
}

/** Each domain and asset gets a turn before another can consume the remaining budget. */
export function packPortfolioBriefContext(evidence: PortfolioBriefEvidence, maxBytes = PORTFOLIO_BRIEF_CONTEXT_BYTES): PortfolioBriefEvidence {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > PORTFOLIO_BRIEF_MAX_BYTES) throw new RangeError('Invalid briefing context budget.');
  const eligible = new Set(evidence.insightEvidenceIds);
  const compare = (a: ContextFact, b: ContextFact) => Number(eligible.has(b.id)) - Number(eligible.has(a.id))
    || Number(relationship(b)) - Number(relationship(a))
    || (Date.parse(b.observedAt ?? '') || 0) - (Date.parse(a.observedAt ?? '') || 0)
    || order(a.id, b.id);
  const queues = new Map<Domain, ContextFact[]>();
  for (const domain of DOMAINS) {
    const groups = new Map<string, ContextFact[]>();
    for (const source of evidence.facts) {
      if (domainOf(source) !== domain) continue;
      const fact = { ...source, domain };
      const owner = ownerOf(fact);
      const held = groups.get(owner) ?? [];
      held.push(fact); groups.set(owner, held);
    }
    const owners = [...groups.entries()].map(([owner, facts]) => ({ owner, facts: facts.sort(compare) }))
      .sort((a, b) => compare(a.facts[0]!, b.facts[0]!) || order(a.owner, b.owner));
    const queue: ContextFact[] = [];
    while (owners.some(owner => owner.facts.length)) for (const owner of owners) {
      const fact = owner.facts.shift(); if (fact) queue.push(fact);
    }
    queues.set(domain, queue);
  }
  const selected: ContextFact[] = [];
  const included = new Set<string>();
  const packet = (): PortfolioBriefEvidence => ({ ...evidence, facts: [...selected],
    insightEvidenceIds: evidence.insightEvidenceIds.filter(id => included.has(id)),
    context: { maxBytes, domains: DOMAINS.map(domain => {
      const facts = selected.filter(fact => fact.domain === domain);
      const availableFacts = queues.get(domain)!.length;
      return { domain, question: QUESTIONS[domain], availableFacts, includedFacts: facts.length,
        eligibleFacts: facts.filter(fact => eligible.has(fact.id)).length, omittedFacts: availableFacts - facts.length };
    }) },
  });
  const baseBytes = bytes(packet());
  if (baseBytes > maxBytes) throw new RangeError('Briefing metadata exceeds the context budget.');
  const available = DOMAINS.filter(domain => queues.get(domain)!.length > 0);
  const quota = Math.floor((maxBytes - baseBytes) / Math.max(1, available.length));
  function include(fact: ContextFact): boolean {
    if (included.has(fact.id) || selected.length >= 260) return false;
    selected.push(fact); included.add(fact.id);
    if (bytes(packet()) <= maxBytes) return true;
    selected.pop(); included.delete(fact.id); return false;
  }
  for (const domain of available) {
    let spent = 0;
    for (const fact of queues.get(domain)!) {
      const cost = bytes(fact) + (eligible.has(fact.id) ? bytes(fact.id) : 0) + 2;
      if (spent + cost <= quota && include(fact)) spent += cost;
    }
  }
  // Reuse unused domain allocations without allowing one asset to consume every turn.
  const remaining = new Map(available.map(domain => [domain, queues.get(domain)!.filter(fact => !included.has(fact.id))]));
  while ([...remaining.values()].some(queue => queue.length)) for (const domain of available) {
    const fact = remaining.get(domain)!.shift(); if (fact) include(fact);
  }
  return packet();
}
