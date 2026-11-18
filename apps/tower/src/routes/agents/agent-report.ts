import { formatHours, type AgentStats } from '@noticeos/contract/agent-stats';
import type { AnswerFigure } from '@/components/surface/PageAnswer';
import { formatInt } from '@/lib/format';

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

export function agentReport(work: AgentStats): { answer: string; figures: AnswerFigure[] } {
  const outcome = agentOutcome(work);
  const headline = `${formatInt(outcome.count)} ${outcome.noun[outcome.count === 1 ? 0 : 1]} in 7 days`;
  const figures: AnswerFigure[] = [
    { label: 'In progress', value: formatInt(work.inHand), mark: 'agents-in-hand' },
    { label: 'Blocked', value: formatInt(work.blocked), tone: work.blocked > 0 ? 'text-warn' : undefined, mark: 'agents-blocked' },
    { label: 'Claim to close', value: work.medianHours === null ? 'not yet' : formatHours(work.medianHours), note: work.medianHours === null ? undefined : 'median', mark: 'agents-median' },
  ];
  return { answer: headline, figures };
}
