import type { ViewId } from '@shared/views';
import { formatHours, type AgentStats } from '@noticeos/contract/agent-stats';
import type { AnswerFigure } from '@/components/surface/PageAnswer';
import { formatInt } from '@/lib/format';

export type AgentSection = 'velocity' | 'workers' | 'ranking' | 'leaders';
export const AGENT_SECTION_ORDER: Readonly<Record<ViewId, readonly AgentSection[]>> = {
  overview: ['velocity', 'workers', 'ranking', 'leaders'],
  growth: ['velocity', 'workers', 'ranking', 'leaders'],
  revenue: ['workers', 'velocity', 'ranking', 'leaders'],
  delivery: ['workers', 'velocity', 'ranking', 'leaders'],
  reliability: ['workers', 'velocity', 'ranking', 'leaders'],
};

export function agentViewPresentation(view: ViewId, work: AgentStats): { answer: string; figures: AnswerFigure[] } {
  const closed = `${formatInt(work.week)} ${work.week === 1 ? 'task' : 'tasks'} closed in 7 days`;
  const figures: AnswerFigure[] = [
    { label: 'In progress', value: formatInt(work.inHand), mark: 'agents-in-hand' },
    { label: 'Blocked', value: formatInt(work.blocked), tone: work.blocked > 0 ? 'text-warn' : undefined, mark: 'agents-blocked' },
    { label: 'Claim to close', value: work.medianHours === null ? 'not yet' : formatHours(work.medianHours), note: work.medianHours === null ? undefined : 'median', mark: 'agents-median' },
  ];
  switch (view) {
    case 'delivery': return { answer: `${formatInt(work.inHand)} ${work.inHand === 1 ? 'task' : 'tasks'} in progress`, figures: [figures[2]!, figures[1]!, { label: 'Closed, 7 days', value: formatInt(work.week) }] };
    case 'reliability': return { answer: `${formatInt(work.blocked)} ${work.blocked === 1 ? 'task' : 'tasks'} blocked`, figures: [figures[0]!, figures[2]!, { label: 'Closed, 7 days', value: formatInt(work.week) }] };
    case 'growth': return { answer: closed, figures };
    case 'revenue': return { answer: 'Agent cost and return are unmeasured', figures: [figures[0]!, figures[2]!, { label: 'Closed, 7 days', value: formatInt(work.week) }] };
    case 'overview': return { answer: closed, figures };
  }
}
