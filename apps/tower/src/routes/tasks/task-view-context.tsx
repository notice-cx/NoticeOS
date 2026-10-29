import type { ViewId } from '@shared/views';
import { TASK_MEASURABILITY_LABELS } from '@noticeos/contract/task-card';
import { TASK_BLOCKING_DEPENDENCIES } from '@noticeos/contract/task-gate';
import { useView } from '@/hooks/useView';
import { cardOf } from '@/lib/task-ranking';
import type { BoardTask } from '@/lib/task-board-read';
import { formatInt, formatUsd } from '@/lib/format';
import { eyebrowClass } from '@/components/surface/SectionLabel';

export interface TaskViewFact { label: string; value: string }

/** Coverage describes the listed records, never the unreturned task history. */
export function taskViewFacts(view: ViewId, tasks: readonly BoardTask[]): { title: string; facts: TaskViewFact[] } | null {
  const cards = tasks.flatMap(task => { const card = cardOf(task); return card ? [card] : []; });
  const n = (value: number) => formatInt(value);
  switch (view) {
    case 'growth': return { title: 'Measurement plans', facts: [
      { label: 'Cohort or holdout', value: n(cards.filter(card => card.measurability !== 'unmeasured').length) },
      { label: 'Unmeasured or no plan', value: n(tasks.length - cards.filter(card => card.measurability !== 'unmeasured').length) },
      { label: 'Shortest signal estimate', value: cards.length ? `${Math.min(...cards.map(card => card.daysToSignal))} days` : 'Not recorded' },
    ] };
    case 'revenue': return { title: 'Recorded task estimates', facts: [
      { label: 'Predicted value / month', value: cards.length ? formatUsd(cards.reduce((sum, card) => sum + card.valuePerMonth, 0)) : 'Not recorded' },
      { label: 'Review time', value: cards.length ? `${n(cards.reduce((sum, card) => sum + card.reviewMinutes, 0))} min` : 'Not recorded' },
      { label: 'Tasks without estimates', value: n(tasks.length - cards.length) },
    ] };
    case 'delivery': {
      const dependencies = tasks.flatMap(task => task.dependencies ?? []).filter(edge => TASK_BLOCKING_DEPENDENCIES.includes(edge.type));
      const known = dependencies.filter(edge => Boolean(edge.status?.trim()) && edge.status !== 'unknown');
      const open = known.filter(edge => edge.status !== 'closed').length;
      const complete = tasks.every(task => task.dependencies !== undefined) && known.length === dependencies.length;
      return { title: 'Delivery and verification', facts: [
        { label: 'In progress', value: n(tasks.filter(task => task.status === 'in_progress').length) },
        { label: 'Open dependencies', value: complete ? n(open) : open > 0 ? `${n(open)} known · incomplete` : 'Unknown' },
        { label: 'Done criteria recorded', value: n(tasks.filter(task => Boolean(task.acceptance?.trim())).length) },
      ] };
    }
    case 'reliability': return { title: 'Blocked work and evidence gaps', facts: [
      { label: 'Blocked', value: n(tasks.filter(task => task.status === 'blocked').length) },
      { label: 'Without done criteria', value: n(tasks.filter(task => task.acceptance !== undefined && !task.acceptance.trim()).length) },
      { label: 'Criteria unavailable', value: n(tasks.filter(task => task.acceptance === undefined).length) },
    ] };
    case 'overview': return null;
  }
}

export function TaskViewContext({ tasks, complete = true, decision = false }: { tasks: readonly BoardTask[]; complete?: boolean; decision?: boolean }) {
  const { view } = useView();
  const summary = taskViewFacts(view.id, tasks);
  if (!summary) return null;
  const card = decision && tasks[0] ? cardOf(tasks[0]) : null;
  return <section className="space-y-3 border-y border-border py-4" aria-label={summary.title} data-task-view-context={view.id}>
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className={eyebrowClass}>{summary.title}</h2>
      <span className="text-xs text-muted-foreground">{decision ? 'Selected task' : `${formatInt(tasks.length)} listed task records${complete ? '' : ' · incomplete read'}`}</span>
    </div>
    <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3 tabular-nums">{summary.facts.map(fact => <div key={fact.label}>
      <dt className="text-xs text-muted-foreground">{fact.label}</dt><dd className="m-0 mt-1 text-lg font-semibold">{fact.value}</dd>
    </div>)}</dl>
    {card && view.id === 'growth' ? <p className="m-0 text-sm text-muted-foreground">{TASK_MEASURABILITY_LABELS[card.measurability]}{card.note ? ` · ${card.note}` : ''}</p> : null}
    {view.id === 'revenue' ? <p className="m-0 text-xs text-muted-foreground">Predictions are task estimates. Actual revenue and agent costs are not recorded here.</p> : null}
    {(view.id === 'delivery' || view.id === 'reliability') && tasks.some(task => task.acceptance === undefined || task.dependencies === undefined) ? <p className="m-0 text-xs text-muted-foreground">Some listed records omit done criteria or dependencies. Open a task for its available evidence.</p> : null}
  </section>;
}
