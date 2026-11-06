import { z } from 'zod';
import type { ConnectionFailure } from './integrations.js';

export const PORTFOLIO_BRIEF_MAX_BYTES = 96_000;
export const PORTFOLIO_BRIEF_CONTEXT_BYTES = 24_000;
export const PORTFOLIO_BRIEF_DOMAINS = ['finance', 'acquisition', 'product', 'delivery', 'outcomes', 'operations'] as const;
export type PortfolioBriefDomain = typeof PORTFOLIO_BRIEF_DOMAINS[number];
export function portfolioBriefUtf8Bytes(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export interface PortfolioBriefComparison {
  current: { start: string; end: string };
  previous: { start: string; end: string };
  timeZone: string;
}

/** The opening binds narrative comparisons to the saved reporting windows. */
export function portfolioBriefObservationOpening(comparison: PortfolioBriefComparison): string {
  const day = 86_400_000;
  const days = (window: PortfolioBriefComparison['current']) => (Date.parse(window.end) - Date.parse(window.start)) / day + 1;
  const month = (window: PortfolioBriefComparison['current']) => window.start.endsWith('-01') &&
    new Date(Date.parse(window.end) + day).toISOString().endsWith('-01T00:00:00.000Z') && window.start.slice(0, 7) === window.end.slice(0, 7);
  if (month(comparison.current) && month(comparison.previous)) {
    const format = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC',
      ...(comparison.current.start.slice(0, 4) !== comparison.previous.start.slice(0, 4) ? { year: 'numeric' as const } : {}) });
    return `In ${format.format(new Date(comparison.current.start))} versus ${format.format(new Date(comparison.previous.start))}, `;
  }
  if (Date.parse(comparison.current.start) - Date.parse(comparison.previous.end) === day) {
    const current = days(comparison.current);
    return `Over the latest ${current} ${current === 1 ? 'day' : 'days'} versus the previous ${days(comparison.previous)}, `;
  }
  return `From ${comparison.current.start} to ${comparison.current.end} versus ${comparison.previous.start} to ${comparison.previous.end}, `;
}

export interface PortfolioBriefFact {
  id: string;
  label: string;
  href: string;
  observedAt: string | null;
  period: { start: string; end: string } | null;
  comparison?: PortfolioBriefComparison;
  domain?: PortfolioBriefDomain;
  basis?: 'task-dependency' | 'current-state' | 'period-observation';
  data: Record<string, unknown>;
}

/** Current conditions have no invented before/after baseline. */
export function portfolioBriefFactOpening(fact: PortfolioBriefFact): string {
  if (fact.comparison) return portfolioBriefObservationOpening(fact.comparison);
  if (fact.basis === 'period-observation' && fact.period) {
    const days = (Date.parse(fact.period.end) - Date.parse(fact.period.start)) / 86_400_000 + 1;
    const end = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(fact.period.end));
    return days === 1 ? `On ${end}, ` : `Over the ${days} days ending ${end}, `;
  }
  return 'Currently, ';
}

export interface PortfolioBriefEvidence {
  schemaVersion: 1;
  asOf: string;
  timeZone: string;
  facts: PortfolioBriefFact[];
  insightEvidenceIds: string[];
  limitations: string[];
  coverage: { assets: number; includedAssets: number; projects: number; readableProjects: number; omittedAlerts: number; omittedTasks: number };
  context?: { maxBytes: number; domains: { domain: PortfolioBriefDomain; question: string; availableFacts: number; includedFacts: number; eligibleFacts: number; omittedFacts: number }[] };
}

const short = (max: number) => z.string().trim().min(1).max(max);
const instant = z.string().datetime({ offset: true });
const date = z.iso.date();
const period = z.object({ start: date, end: date }).strict();
const comparison = z.object({ current: period, previous: period, timeZone: short(100) }).strict().superRefine((value, ctx) => {
  if (value.previous.start > value.previous.end || value.current.start > value.current.end || value.previous.end >= value.current.start) ctx.addIssue({ code: 'custom', message: 'Comparison periods must be ordered and separate.' });
});
const count = z.number().int().nonnegative();
export const portfolioBriefEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  asOf: instant,
  timeZone: short(100),
  facts: z.array(z.object({
    id: short(400), label: short(240),
    href: z.string().max(500).regex(/^\/(?!\/)[a-zA-Z0-9/_%?=&.#-]*$/),
    observedAt: instant.nullable(),
    period: period.nullable(),
    comparison: comparison.optional(),
    domain: z.enum(PORTFOLIO_BRIEF_DOMAINS).optional(),
    basis: z.enum(['task-dependency', 'current-state', 'period-observation']).optional(),
    data: z.record(z.string(), z.unknown()),
  }).strict()).max(260),
  insightEvidenceIds: z.array(short(400)).max(260),
  limitations: z.array(short(500)).max(20),
  coverage: z.object({ assets: count, includedAssets: count, projects: count, readableProjects: count, omittedAlerts: count, omittedTasks: count }).strict(),
  context: z.object({ maxBytes: z.number().int().positive().max(PORTFOLIO_BRIEF_MAX_BYTES), domains: z.array(z.object({
    domain: z.enum(PORTFOLIO_BRIEF_DOMAINS), question: short(240), availableFacts: count, includedFacts: count, eligibleFacts: count, omittedFacts: count,
  }).strict()).max(PORTFOLIO_BRIEF_DOMAINS.length) }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.facts.map(fact => fact.id)).size !== value.facts.length) ctx.addIssue({ code: 'custom', message: 'Evidence identifiers must be unique.' });
  const known = new Set(value.facts.map(fact => fact.id));
  if (new Set(value.insightEvidenceIds).size !== value.insightEvidenceIds.length || value.insightEvidenceIds.some(id => !known.has(id))) ctx.addIssue({ code: 'custom', message: 'Insight evidence must name distinct supplied facts.' });
  for (const fact of value.facts) {
    if (fact.period && fact.period.start > fact.period.end) ctx.addIssue({ code: 'custom', message: 'Observation periods must be ordered.' });
    if (fact.basis && (fact.observedAt === null || fact.comparison || (fact.basis === 'period-observation' ? fact.period === null : fact.period !== null))) ctx.addIssue({ code: 'custom', message: 'Observation basis must match its source time context.' });
  }
  if (value.insightEvidenceIds.some(id => { const fact = value.facts.find(fact => fact.id === id); return !fact?.comparison && !fact?.basis; })) ctx.addIssue({ code: 'custom', message: 'Insight evidence must include comparison periods or a dated observation basis.' });
  if (portfolioBriefUtf8Bytes(JSON.stringify(value)) > PORTFOLIO_BRIEF_MAX_BYTES) ctx.addIssue({ code: 'custom', message: 'The evidence packet is too large.' });
  if (value.context && portfolioBriefUtf8Bytes(JSON.stringify(value)) > value.context.maxBytes) ctx.addIssue({ code: 'custom', message: 'The evidence exceeds its model context budget.' });
});
export const portfolioBriefResultSchema = z.object({
  headline: short(110).describe('At most 10 words. One clear priority, without numeric results or joined clauses.'),
  assessment: short(220).describe('One short, direct sentence setting the priority. No numeric results or joined clauses.'),
  insights: z.array(z.object({
    title: short(90).describe('A short decision-focused heading, at most 8 words.'),
    observation: short(800).regex(/^(?:Currently|In [A-Z][a-z]+(?: \d{4})? versus [A-Z][a-z]+(?: \d{4})?|Over the [1-9]\d* days ending [A-Z][a-z]{2} [1-9]\d?|On [A-Z][a-z]{2} [1-9]\d?|Over the latest [1-9]\d* days? versus the previous [1-9]\d*|From \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2} versus \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}), \S/,
      'The observation must open with its measurement period and comparison baseline.')
      .describe('Up to three short sentences, one idea each. Begin with the exact source-derived opening. Use numerals and omit data-processing terminology.'),
    why: short(400).describe('One short sentence explaining the decision consequence without repeating the observation.'),
    action: short(400).describe('One short instruction for a concrete next step. A check must distinguish explanations without assuming any occurred.'),
    evidenceIds: z.array(short(400)).min(1).max(6),
    confidence: z.enum(['high', 'medium', 'low']),
  }).strict()).max(3).describe('Zero to three useful findings. Do not fill slots. Return an empty array when insightEvidenceIds is empty.'),
}).strict().superRefine((value, ctx) => {
  const words = [value.headline, value.assessment, ...value.insights.flatMap(item => [item.title, item.observation, item.why, item.action])].join(' ').split(/\s+/).length;
  if (words > 360) ctx.addIssue({ code: 'custom', message: 'The briefing must contain at most 360 words.' });
  const sentences = [value.assessment, ...value.insights.flatMap(item => [item.observation, item.why, item.action])];
  if (sentences.some(sentence => !/[.!?]$/.test(sentence))) ctx.addIssue({ code: 'custom', message: 'Briefing sentences must end with punctuation.' });
});
export type PortfolioBriefResult = z.infer<typeof portfolioBriefResultSchema>;
export const portfolioBriefResponseSchema = z.toJSONSchema(portfolioBriefResultSchema);

export const PORTFOLIO_BRIEF_ABSTENTION: PortfolioBriefResult = {
  headline: 'No additional conclusion is supported',
  assessment: 'Current records do not provide enough comparable observations for useful guidance.',
  insights: [],
};

export interface PortfolioBrief {
  result: PortfolioBriefResult;
  generatedAt: string;
  evidenceAsOf: string;
  model: string | null;
  sources: Omit<PortfolioBriefFact, 'data'>[];
  limitations: string[];
}

export interface PortfolioBriefRead {
  state: 'disconnected' | 'awaiting' | 'ready' | 'unavailable' | 'unsupported';
  briefing: PortfolioBrief | null;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  error: string | null;
  failure?: ConnectionFailure;
  stale: boolean;
}
