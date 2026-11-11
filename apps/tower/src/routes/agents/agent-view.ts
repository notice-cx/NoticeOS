import type { ViewId } from '@shared/views';
import { formatHours, type AgentStats } from '@noticeos/contract/agent-stats';
import type { AnswerFigure } from '@/components/surface/PageAnswer';
import { formatInt } from '@/lib/format';

export type AgentSection = 'velocity' | 'workers';
export const AGENT_SECTION_ORDER: Readonly<Record<ViewId, readonly AgentSection[]>> = {
  overview: ['velocity', 'workers'],
  growth: ['velocity', 'workers'],
  revenue: ['workers', 'velocity'],
  delivery: ['workers', 'velocity'],
  reliability: ['workers', 'velocity'],
};

/** The changes shipped in the last 7 days, or null where they are not
 * measured. An Ntasks older than these counts answers no field at all. */
export function shippedOf(work: AgentStats): number | null {
  return work.shipped ?? null;
}

/** The week's outcome and the week before's: changes shipped where the task
 * source records merges, else tasks closed. */
export function agentOutcome(work: AgentStats): { count: number; before: number; noun: [string, string] } {
  const shipped = shippedOf(work);
  return shipped === null
    ? { count: work.week, before: work.lastWeek, noun: ['task closed', 'tasks closed'] }
    : { count: shipped, before: work.shippedLastWeek ?? 0, noun: ['change shipped', 'changes shipped'] };
}

export function agentViewPresentation(view: ViewId, work: AgentStats): { answer: string; figures: AnswerFigure[] } {
  const outcome = agentOutcome(work);
  const headline = `${formatInt(outcome.count)} ${outcome.noun[outcome.count === 1 ? 0 : 1]} in 7 days`;
  const closed: AnswerFigure = { label: 'Closed, 7 days', value: formatInt(work.week), mark: 'agents-closed' };
  const count = shippedOf(work);
  const shipped: AnswerFigure = count === null ? closed : { label: 'Shipped, 7 days', value: formatInt(count), mark: 'agents-shipped' };
  const figures: AnswerFigure[] = [
    { label: 'In progress', value: formatInt(work.inHand), mark: 'agents-in-hand' },
    { label: 'Blocked', value: formatInt(work.blocked), tone: work.blocked > 0 ? 'text-warn' : undefined, mark: 'agents-blocked' },
    { label: 'Claim to close', value: work.medianHours === null ? 'not yet' : formatHours(work.medianHours), note: work.medianHours === null ? undefined : 'median', mark: 'agents-median' },
  ];
  switch (view) {
    case 'delivery': return { answer: `${formatInt(work.inHand)} ${work.inHand === 1 ? 'task' : 'tasks'} in progress`, figures: [figures[2]!, figures[1]!, shipped] };
    case 'reliability': return { answer: `${formatInt(work.blocked)} ${work.blocked === 1 ? 'task' : 'tasks'} blocked`, figures: [figures[0]!, figures[2]!, shipped] };
    case 'revenue': return { answer: 'Agent cost and return are unmeasured', figures: [figures[0]!, figures[2]!, shipped] };
    case 'growth':
    case 'overview': return { answer: headline, figures };
  }
}
