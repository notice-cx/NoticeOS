import { PORTFOLIO_BRIEF_ABSTENTION, portfolioBriefFactOpening, portfolioBriefResultSchema,
  type PortfolioBriefEvidence, type PortfolioBriefFact, type PortfolioBriefResult } from '@noticeos/contract/portfolio-brief';

export type BriefingResponseCode = 'briefing-format' | 'briefing-sources' | 'briefing-periods' | 'briefing-length' | 'empty-output';
export class BriefingResponseError extends Error {
  constructor(readonly code: BriefingResponseCode) { super(code); this.name = 'BriefingResponseError'; }
}

/** Short request-local references avoid asking a small model to copy internal IDs. */
export function portfolioBriefModelEvidence(evidence: PortfolioBriefEvidence): string {
  const eligible = new Set(evidence.insightEvidenceIds);
  return JSON.stringify({ asOf: evidence.asOf, timeZone: evidence.timeZone,
    sources: evidence.facts.map((fact, index) => ({ id: `S${index + 1}`, eligible: eligible.has(fact.id),
      domain: fact.domain, label: fact.label, timeframe: fact.comparison ?? fact.period ?? fact.basis ?? 'Background context', data: fact.data })),
    coverage: evidence.coverage, limitations: evidence.limitations, questions: evidence.context?.domains });
}

const fail = (code: BriefingResponseCode): never => { throw new BriefingResponseError(code); };
const clean = (value: string) => value.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\s+/g, ' ').trim();
const sentence = (value: string) => /[.!?]$/.test(value) ? value : `${value}.`;
type Card = { title: string; sources: string; observation: string; why: string; next: string };
type CardField = Exclude<keyof Card, 'title'>;
const fields: Record<string, CardField | 'headline' | 'summary'> = {
  headline: 'headline', summary: 'summary', sources: 'sources', source: 'sources', evidence: 'sources',
  observation: 'observation', why: 'why', 'why it matters': 'why', next: 'next', 'next step': 'next', action: 'next',
};

function sourceFacts(value: string, evidence: PortfolioBriefEvidence): PortfolioBriefFact[] {
  const refs = value.match(/\bS[1-9]\d*\b/gi) ?? [];
  const remainder = value.replace(/\bS[1-9]\d*\b/gi, '').replace(/[\s,;\[\]`]+/g, '');
  if (!refs.length || refs.length > 6 || remainder) return fail('briefing-sources');
  const facts = [...new Set(refs.map(ref => Number(ref.slice(1))))].map(index => evidence.facts[index - 1]);
  if (facts.some(fact => !fact)) return fail('briefing-sources');
  return facts as PortfolioBriefFact[];
}

function sourceOpening(facts: PortfolioBriefFact[], eligible: Set<string>): string {
  const anchors = facts.filter(fact => eligible.has(fact.id));
  if (!anchors.length) return fail('briefing-sources');
  const comparisons = facts.filter(fact => fact.comparison);
  const observations = facts.filter(fact => fact.basis === 'period-observation');
  if (comparisons.length && observations.length) return fail('briefing-periods');
  if (comparisons.length) {
    const windows = new Set(comparisons.map(({ comparison: period }) => [period!.current.start, period!.current.end,
      period!.previous.start, period!.previous.end, period!.timeZone].join('|')));
    if (windows.size !== 1) return fail('briefing-periods');
    // Current context cannot turn an old comparison into eligible evidence.
    if (!comparisons.some(fact => eligible.has(fact.id))) return fail('briefing-sources');
    return portfolioBriefFactOpening(comparisons[0]!);
  }
  if (observations.length) {
    const windows = new Set(observations.map(fact => `${fact.period!.start}|${fact.period!.end}`));
    if (windows.size !== 1) return fail('briefing-periods');
    if (!observations.some(fact => eligible.has(fact.id))) return fail('briefing-sources');
    return portfolioBriefFactOpening(observations[0]!);
  }
  return portfolioBriefFactOpening(anchors[0]!);
}

function observationWithPeriod(observation: string, opening: string): string {
  if (observation.startsWith(opening)) return sentence(observation);
  // An explicit model-written period must agree; never conceal it under another prefix.
  if (/^(?:Currently\b|In \w+ versus\b|In \w+ \d{4} versus\b|Over the\b|During\b|On \w+ \d|From \d{4}-|(?:Last|This|Next) (?:week|month|quarter|year)\b)/i.test(observation)) return fail('briefing-periods');
  return `${opening}${sentence(observation)}`;
}

/** Parse presentation only. Source selection and timeframe checks stay application-owned. */
export function parsePortfolioBrief(text: string, evidence: PortfolioBriefEvidence): PortfolioBriefResult {
  let body = text.trim();
  // Some servers leave a reasoning block in content; it is never published as an answer.
  if (body.startsWith('<think>')) {
    const end = body.indexOf('</think>');
    if (end < 0) return fail('empty-output');
    body = body.slice(end + '</think>'.length).trim();
  }
  body = body.replace(/^```(?:markdown|md|text)?\s*\n([\s\S]*?)\n```$/i, '$1').trim();
  if (!body) return fail('empty-output');
  if (/<\/?(?:think|analysis)\b/i.test(body)) return fail('briefing-format');
  if (body.length > 12_000) return fail('briefing-length');
  if (/^(?:\*\*)?NO_INSIGHTS(?:\*\*)?[.!]?$/i.test(body)) return PORTFOLIO_BRIEF_ABSTENTION;
  const header = { headline: '', summary: '' };
  const cards: Card[] = [];
  let current: Card | undefined;
  let target: { record: Record<string, string>; field: string } | undefined;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^---+$/.test(line)) continue;
    const heading = /^#{2,3}\s+(.+?)\s*#*$/.exec(line);
    if (heading) {
      current = { title: clean(heading[1]!).replace(/^\d+[.)]\s+/, ''), sources: '', observation: '', why: '', next: '' };
      cards.push(current); target = undefined;
      if (cards.length > 3) return fail('briefing-length');
      continue;
    }
    const title = /^#\s+(.+?)\s*#*$/.exec(line);
    if (title && !current && !header.headline) { header.headline = clean(title[1]!); target = undefined; continue; }
    const label = /^(?:[-*]\s+)?(?:\*\*|__)?(Headline|Summary|Sources?|Evidence|Observation|Why(?: it matters)?|Next(?: step)?|Action)(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.*)$/i.exec(line);
    if (label) {
      const field = fields[label[1]!.toLowerCase()]!;
      const record = field === 'headline' || field === 'summary' ? current ? undefined : header : current;
      if (!record || (record as Record<string, string>)[field]) return fail('briefing-format');
      (record as Record<string, string>)[field] = label[2]!;
      target = { record, field };
    } else if (target) {
      target.record[target.field] += ` ${line}`;
    } else if (!current && header.headline && !header.summary) {
      header.summary = line; target = { record: header, field: 'summary' };
    } else return fail('briefing-format');
  }
  if (!clean(header.headline) || !clean(header.summary) || !cards.length) return fail('briefing-format');
  const eligible = new Set(evidence.insightEvidenceIds);
  const insights = cards.map(card => {
    if (Object.values(card).some(value => !clean(value))) return fail('briefing-format');
    const cited = sourceFacts(clean(card.sources), evidence);
    const opening = sourceOpening(cited, eligible);
    return { title: clean(card.title), observation: observationWithPeriod(clean(card.observation), opening),
      why: sentence(clean(card.why)), action: sentence(clean(card.next)), evidenceIds: cited.map(fact => fact.id) };
  });
  const result = portfolioBriefResultSchema.safeParse({ headline: clean(header.headline), assessment: sentence(clean(header.summary)), insights });
  if (!result.success) return fail('briefing-length');
  return result.data;
}
