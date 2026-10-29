import type { ViewId } from '@shared/views';
import { formatHours, type AgentStats } from '@noticeos/contract/agent-stats';
import type { AnswerFigure } from '@/components/surface/PageAnswer';
import { formatInt } from '@/lib/format';

export type AgentSection = 'velocity' | 'workers' | 'ranking' | 'leaders' | 'evidence';
export const AGENT_SECTION_ORDER: Readonly<Record<ViewId, readonly AgentSection[]>> = {
  overview: ['velocity', 'workers', 'ranking', 'leaders', 'evidence'],
  growth: ['evidence', 'velocity', 'workers', 'ranking', 'leaders'],
  revenue: ['evidence', 'workers', 'velocity', 'ranking', 'leaders'],
  delivery: ['workers', 'velocity', 'evidence', 'ranking', 'leaders'],
  reliability: ['workers', 'evidence', 'velocity', 'ranking', 'leaders'],
};

export function agentViewPresentation(view: ViewId, work: AgentStats): { answer: string; evidence: string; figures: AnswerFigure[] } {
  const closed = `${formatInt(work.week)} ${work.week === 1 ? 'task' : 'tasks'} closed in 7 days`;
  const figures: AnswerFigure[] = [
    { label: 'In progress', value: formatInt(work.inHand), mark: 'agents-in-hand' },
    { label: 'Blocked', value: formatInt(work.blocked), tone: work.blocked > 0 ? 'text-warn' : undefined, mark: 'agents-blocked' },
    { label: 'Claim to close', value: work.medianHours === null ? 'not yet' : formatHours(work.medianHours), note: work.medianHours === null ? undefined : 'median', mark: 'agents-median' },
  ];
  switch (view) {
    case 'delivery': return { answer: `${formatInt(work.inHand)} ${work.inHand === 1 ? 'task' : 'tasks'} in progress`, figures: [figures[2]!, figures[1]!, { label: 'Closed, 7 days', value: formatInt(work.week) }], evidence: 'Check done criteria and close evidence before shipping. A closed task does not confirm an outcome.' };
    case 'reliability': return { answer: `${formatInt(work.blocked)} ${work.blocked === 1 ? 'task' : 'tasks'} blocked`, figures: [figures[1]!, figures[0]!, figures[2]!], evidence: 'Blocked counts record task status. Verification failures and failure rates are not included in these statistics.' };
    case 'growth': return { answer: closed, figures, evidence: 'Task closes measure work completed. Visitor journeys, measurement plans and growth outcomes require the task and asset evidence.' };
    case 'revenue': return { answer: 'Agent cost and return are unmeasured', figures: [{ label: 'Agent cost', value: 'Not recorded' }, { label: 'Realized value', value: 'Not recorded' }, { label: 'Closed, 7 days', value: formatInt(work.week) }], evidence: 'These statistics record activity and claim-to-close time. They contain no agent spend or attributed revenue.' };
    case 'overview': return { answer: closed, figures, evidence: 'Open a task to review its done criteria, verification and close evidence.' };
  }
}
