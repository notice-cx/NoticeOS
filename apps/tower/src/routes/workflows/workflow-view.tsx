import type { ViewId } from '@shared/views';
import type { WorkflowRun, WorkflowState } from '@shared/workflows';
import type { WorkflowOutputValue } from '@noticeos/contract';
import type { AnswerFigure } from '@/components/surface/PageAnswer';
import { eyebrowClass } from '@/components/surface/SectionLabel';
import { formatInt, formatUsd } from '@/lib/format';

export function workflowDefaultSort(view: ViewId): 'latest' | 'attention' | 'next' {
  return view === 'reliability' ? 'attention' : view === 'delivery' ? 'next' : 'latest';
}

export function workflowViewFigures(view: ViewId, states: readonly WorkflowState[]): AnswerFigure[] {
  const count = (...wanted: WorkflowState[]) => formatInt(states.filter(state => wanted.includes(state)).length);
  switch (view) {
    case 'overview': return [];
    case 'growth': return [{ label: 'Succeeded', value: count('succeeded') }, { label: 'No recorded run', value: count('never') }, { label: 'Unconfirmed', value: count('unknown') }];
    case 'revenue': return [{ label: 'Running', value: count('running') }, { label: 'Failed', value: count('failed') }, { label: 'Cost and return', value: 'See run evidence' }];
    case 'delivery': return [{ label: 'Running', value: count('running') }, { label: 'Awaiting approval', value: count('waiting') }, { label: 'Succeeded', value: count('succeeded') }];
    case 'reliability': return [{ label: 'Failed', value: count('failed'), tone: 'text-error' }, { label: 'Unconfirmed', value: count('unknown') }, { label: 'Paused', value: count('paused') }];
  }
}

function outputValues(run: WorkflowRun | null): WorkflowOutputValue[] {
  return (run?.steps ?? []).flatMap(step => step.output ? [...step.output.metrics, ...step.output.fields, ...step.output.items.flatMap(item => item.fields.map(value => ({ ...value, label: `${item.label} · ${value.label}` })))] : []);
}
export function workflowEvidenceValues(view: ViewId, run: WorkflowRun | null): WorkflowOutputValue[] {
  const values = outputValues(run);
  return view === 'revenue' ? values.filter(value => value.unit === 'USD') : values;
}
function valueLabel(value: WorkflowOutputValue): string {
  return value.unit === 'USD' && (typeof value.value === 'number' || typeof value.value === 'string' && /^-?\d+(\.\d+)?$/.test(value.value))
    ? formatUsd(Number(value.value), { cents: true }) : String(value.value);
}

/** Keep recorded output labels: a USD amount alone proves neither cost nor return. */
export function WorkflowViewEvidence({ view, run }: { view: ViewId; run: WorkflowRun | null }) {
  if (view === 'overview') return null;
  const steps = run?.steps ?? [];
  const values = workflowEvidenceValues(view, run);
  const failed = steps.filter(step => step.state === 'failed');
  const title = view === 'growth' ? 'Measurement evidence' : view === 'revenue' ? 'Recorded financial evidence' : view === 'delivery' ? 'Delivery progress' : 'Failure and verification evidence';
  return <section className="space-y-3 rounded-lg border border-border p-4" aria-label={title} data-workflow-view-evidence={view}>
    <h2 className={eyebrowClass}>{title}</h2>
    {view === 'reliability' || view === 'delivery' ? <dl className="m-0 flex flex-wrap gap-x-8 gap-y-3 tabular-nums">
      {[{ label: 'Observed stages', value: run?.steps ? formatInt(steps.length) : 'Unavailable' }, { label: 'Succeeded', value: run?.steps ? formatInt(steps.filter(step => step.state === 'succeeded').length) : 'Unknown' }, { label: 'Failed', value: run?.steps ? formatInt(failed.length) : 'Unknown' }].map(fact => <div key={fact.label}><dt className="text-xs text-muted-foreground">{fact.label}</dt><dd className="m-0 mt-1 text-lg font-semibold">{fact.value}</dd></div>)}
    </dl> : null}
    {values.length > 0 ? <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3 text-sm">{values.slice(0, 6).map((value, index) => <div key={`${value.key}:${index}`}><dt className="text-muted-foreground">{value.label}</dt><dd className="m-0 font-semibold tabular-nums">{valueLabel(value)}</dd></div>)}</dl> : null}
    {view === 'growth' ? <p className="m-0 text-xs text-muted-foreground">{values.length ? 'Recorded run outputs. Successful execution does not establish growth or measured lift.' : 'No measurement outputs recorded for this run. Successful execution does not establish growth or measured lift.'}</p> : null}
    {view === 'revenue' && values.length === 0 ? <p className="m-0 text-sm text-muted-foreground">No financial amounts recorded for this run. Workflow cost and return are unmeasured.</p> : null}
    {view === 'reliability' && failed.length > 0 ? <ul className="m-0 space-y-1 pl-4 text-sm text-error">{failed.map(step => <li key={`${step.id}:${step.attempt}`}>{step.summary ?? `${step.id}: failed`}</li>)}</ul> : null}
  </section>;
}
