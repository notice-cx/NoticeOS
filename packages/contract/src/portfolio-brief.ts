import { z } from 'zod';

export const PORTFOLIO_BRIEF_MAX_BYTES = 96_000;
export function portfolioBriefUtf8Bytes(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export interface PortfolioBriefFact {
  id: string;
  label: string;
  href: string;
  observedAt: string | null;
  period: { start: string; end: string } | null;
  data: Record<string, unknown>;
}

export interface PortfolioBriefEvidence {
  schemaVersion: 1;
  asOf: string;
  timeZone: string;
  facts: PortfolioBriefFact[];
  insightEvidenceIds: string[];
  limitations: string[];
  coverage: { assets: number; includedAssets: number; projects: number; readableProjects: number; omittedAlerts: number; omittedTasks: number };
}

const short = (max: number) => z.string().trim().min(1).max(max);
const instant = z.string().datetime({ offset: true });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const count = z.number().int().nonnegative();
export const portfolioBriefEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  asOf: instant,
  timeZone: short(100),
  facts: z.array(z.object({
    id: short(400), label: short(240),
    href: z.string().max(500).regex(/^\/(?!\/)[a-zA-Z0-9/_%?=&.#-]*$/),
    observedAt: instant.nullable(),
    period: z.object({ start: date, end: date }).strict().nullable(),
    data: z.record(z.string(), z.unknown()),
  }).strict()).max(260),
  insightEvidenceIds: z.array(short(400)).max(260),
  limitations: z.array(short(500)).max(20),
  coverage: z.object({ assets: count, includedAssets: count, projects: count, readableProjects: count, omittedAlerts: count, omittedTasks: count }).strict(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.facts.map(fact => fact.id)).size !== value.facts.length) ctx.addIssue({ code: 'custom', message: 'Evidence identifiers must be unique.' });
  const known = new Set(value.facts.map(fact => fact.id));
  if (new Set(value.insightEvidenceIds).size !== value.insightEvidenceIds.length || value.insightEvidenceIds.some(id => !known.has(id))) ctx.addIssue({ code: 'custom', message: 'Insight evidence must name distinct supplied facts.' });
  if (portfolioBriefUtf8Bytes(JSON.stringify(value)) > PORTFOLIO_BRIEF_MAX_BYTES) ctx.addIssue({ code: 'custom', message: 'The evidence packet is too large.' });
});
export const portfolioBriefResultSchema = z.object({
  headline: short(140).describe('At most 10 words. State the decision implication, not a dashboard total.'),
  assessment: short(500).describe('One complete sentence, at most 22 words. Do not repeat the insights.'),
  insights: z.array(z.object({
    observation: short(300).describe('One complete sentence, at most 24 words. Describe the changed relationship.'),
    why: short(240).describe('One complete sentence, at most 18 words. Explain the decision consequence.'),
    action: short(240).describe('One complete sentence, at most 18 words. Name the next verification or decision.'),
    evidenceIds: z.array(short(400)).min(1).max(6),
    confidence: z.enum(['high', 'medium', 'low']),
  }).strict()).max(2).describe('Zero to two useful findings. Return an empty array when insightEvidenceIds is empty.'),
}).strict().superRefine((value, ctx) => {
  const words = [value.headline, value.assessment, ...value.insights.flatMap(item => [item.observation, item.why, item.action])].join(' ').split(/\s+/).length;
  if (words > 180) ctx.addIssue({ code: 'custom', message: 'The briefing must contain at most 180 words.' });
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
  stale: boolean;
}
