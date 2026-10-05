import { ArrowDown, ArrowRight, Check, Circle, CircleHelp, CircleX, Clock, Database, GitBranch, Hand, LoaderCircle, Pause, ShieldCheck, Slash, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Cron } from 'croner';
import { InfoTooltip } from './InfoTooltip';
import { cn } from '@/lib/utils';
import { WORKFLOW_STATE_LABEL, type WorkflowState, type WorkflowBucket, type WorkflowDefinition, type WorkflowRun } from '@shared/workflows';
import { formatClock, formatNextRun, utcRunReference, localTimezoneLabel } from '@shared/scheduled-jobs';
import type { WorkflowStepOutput, WorkflowOutputValue } from '@noticeos/contract';
import { Kpi, KpiStrip } from './surface/KpiStrip';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';

const STATE = {
  succeeded: { icon: Check, ink: 'text-healthy', fill: 'bg-healthy', border: 'border-healthy/35' },
  failed: { icon: CircleX, ink: 'text-error', fill: 'bg-error', border: 'border-error/50' },
  running: { icon: LoaderCircle, ink: 'text-primary', fill: 'bg-primary', border: 'border-primary/40' },
  skipped: { icon: Slash, ink: 'text-muted-foreground', fill: 'bg-muted-foreground/50', border: 'border-border' },
  paused: { icon: Pause, ink: 'text-muted-foreground', fill: 'bg-muted-foreground/40', border: 'border-border' },
  never: { icon: Circle, ink: 'text-muted-foreground', fill: 'bg-muted-foreground', border: 'border-border' },
  unknown: { icon: CircleHelp, ink: 'text-muted-foreground', fill: 'bg-muted-foreground', border: 'border-dashed border-border' },
  waiting: { icon: Clock, ink: 'text-warn', fill: 'bg-warn', border: 'border-warn/40' },
} as const;

export function WorkflowStateLabel({ state, label, className }: { state: WorkflowState; label?: string; className?: string }) {
  const { icon: Icon, ink } = STATE[state];
  return <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap', ink, className)}>
    <Icon aria-hidden className={cn('size-3.5 shrink-0', state === 'running' && 'motion-safe:animate-spin')} />{label ?? WORKFLOW_STATE_LABEL[state]}
  </span>;
}

/** A run a person started, not the schedule — the connect panel's Start
 * collecting (bead `ro-ujb9.96.7.19`). A glyph and one word beside the run's
 * state; a scheduled run carries nothing, which is what most runs are. */
export function WorkflowRunTrigger({ run }: { run: Pick<WorkflowRun, 'trigger'> }) {
  if (run.trigger?.kind !== 'manual') return null;
  return <span className="inline-flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap" data-run-trigger="manual">
    <Hand aria-hidden className="size-3.5 shrink-0" />Manual
  </span>;
}

export function WorkflowActivity({ history, name }: { history: WorkflowBucket[]; name: string }) {
  return <div className="flex h-9 w-full items-center gap-1" aria-label={`${name}: hourly execution history`}>
    {history.map((bucket) => {
      const total = bucket.succeeded + bucket.failed + bucket.skipped;
      const state = bucket.failed ? 'failed' : bucket.succeeded ? 'succeeded' : bucket.skipped ? 'skipped' : 'never';
      return <InfoTooltip key={bucket.at} label={`${name}, ${formatNextRun(bucket.at)} ${localTimezoneLabel(bucket.at)}`}
        className="h-9 min-h-0! min-w-0! flex-1 rounded-none no-underline max-sm:min-h-0! max-sm:min-w-0!"
        trigger={<span aria-hidden className={cn('w-full rounded-sm', total ? 'h-6' : 'h-1.5', STATE[state].fill)} />}>
        <p className="font-medium">{formatNextRun(bucket.at)} {localTimezoneLabel(bucket.at)}–{formatClock(Date.parse(bucket.at) + 3_600_000)} {localTimezoneLabel(Date.parse(bucket.at) + 3_600_000)}</p>
        <p className="text-muted-foreground">{utcRunReference(bucket.at)}</p><p className="tabular-nums">{total ? `${bucket.succeeded} succeeded · ${bucket.failed} failed · ${bucket.skipped} skipped` : 'No recorded runs in this hour.'}</p>
      </InfoTooltip>;
    })}
  </div>;
}

export function workflowDuration(start: string, end?: string): string {
  if (!end) return 'In progress';
  const ms = Math.max(0, Date.parse(end) - Date.parse(start));
  return ms < 1000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 60_000).toFixed(1)} min`;
}

export function WorkflowStages({ definition, run, fresh = true }: { definition: WorkflowDefinition; run: WorkflowRun | null; fresh?: boolean }) {
  const [selected, setSelected] = useState<string | null>(null);
  const firstFailure = run?.steps?.find((s) => s.state === 'failed')?.id;
  const selectedId = selected ?? firstFailure ?? definition.stages[0]?.id;
  const stage = definition.stages.find((s) => s.id === selectedId) ?? definition.stages[0]!;
  const attempts = run?.steps?.filter((s) => s.id === stage.id) ?? [];
  const levels = new Map<string, number>();
  for (const item of definition.stages) levels.set(item.id, item.after.length ? Math.max(...item.after.map((id) => levels.get(id) ?? 0)) + 1 : 0);
  const groups = Array.from({ length: Math.max(...levels.values()) + 1 }, (_, i) => definition.stages.filter((s) => levels.get(s.id) === i));
  const kindIcon = { collection: Database, storage: Database, check: ShieldCheck, task: GitBranch, llm: Sparkles, tool: GitBranch, approval: ShieldCheck };
  return <div className="space-y-4">
    {run?.state === 'running' && fresh && !definition.local && <p className="text-sm text-muted-foreground">The collection is running. Individual stage results arrive when the worker responds.</p>}
    {run?.state === 'running' && !fresh && <p className="text-sm text-muted-foreground">Live stage progress is unconfirmed.</p>}
    <div className="grid gap-5">
      <div className="min-w-0 overflow-x-auto rounded-lg border border-border bg-muted/20 p-5">
        <div className="flex min-h-48 flex-col items-stretch justify-center gap-3 md:flex-row md:items-center">
          {groups.map((group, index) => <div key={index} className="contents">
            {index > 0 && <><ArrowRight className="hidden size-5 shrink-0 text-muted-foreground md:block" aria-hidden /><ArrowDown className="mx-auto size-4 text-muted-foreground md:hidden" aria-hidden /></>}
            <div className="flex min-w-0 flex-1 flex-col gap-3">
              {group.map((item) => {
                const step = run?.steps?.filter((s) => s.id === item.id).at(-1);
                const state = step?.state === 'running' && (run?.finishedAt || !fresh) ? 'unknown' : step?.state ?? 'unknown';
                const Icon = kindIcon[item.kind];
                return <button key={item.id} type="button" aria-pressed={stage.id === item.id} onClick={() => setSelected(item.id)}
                  className={cn('flex min-h-28 w-full min-w-32 flex-col items-start gap-3 rounded-md border bg-card p-4 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring', STATE[state].border, stage.id === item.id && 'ring-1 ring-ring')}>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground"><Icon className="size-3.5" aria-hidden />{item.kind === 'llm' ? 'Model' : item.kind === 'collection' ? 'Collect' : item.kind === 'storage' ? 'Store' : item.kind === 'check' ? 'Check' : 'Task'}</span>
                  <span className="text-sm font-medium leading-snug">{item.label}</span>
                  <WorkflowStateLabel state={state} label={!step ? 'Not observed' : undefined} />
                </button>;
              })}
            </div>
          </div>)}
        </div>
      </div>
      <aside className="min-w-0 space-y-3 rounded-lg border border-border p-4" aria-label="Stage details">
        <h3 className="text-sm font-semibold">{stage.label}</h3>
        <p className="text-sm leading-relaxed text-muted-foreground">{stage.description}</p>
        {!attempts.length ? <p className="text-xs text-muted-foreground">No execution evidence was recorded for this stage.</p> : attempts.map((attempt) => <div key={attempt.attempt} className="space-y-2 border-t border-border pt-3">
          <WorkflowStateLabel state={attempt.state === 'running' && (run?.finishedAt || !fresh) ? 'unknown' : attempt.state} />
          {attempts.length > 1 && <p className="text-xs tabular-nums">Attempt {attempt.attempt}</p>}
          <p className="text-sm">{attempt.summary}</p>
          <dl className="space-y-1 text-xs tabular-nums"><div className="flex justify-between gap-3"><dt className="text-muted-foreground">Started</dt><dd title={utcRunReference(attempt.startedAt)}>{formatNextRun(attempt.startedAt)}</dd></div><div className="flex justify-between gap-3"><dt className="text-muted-foreground">Duration</dt><dd>{!fresh && !attempt.finishedAt ? 'Unconfirmed' : workflowDuration(attempt.startedAt, attempt.finishedAt)}</dd></div></dl>
          <WorkflowStepOutputView output={attempt.output} pending={attempt.state === 'running' && fresh} />
        </div>)}
      </aside>
    </div>
  </div>;
}

function outputValue(field: WorkflowOutputValue): string {
  if (typeof field.value === 'boolean') return field.value ? 'Yes' : 'No';
  if (typeof field.value === 'number') return new Intl.NumberFormat('en', field.unit === 'USD' ? { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 } : { maximumFractionDigits: 6 }).format(field.value);
  return field.value;
}

function OutputFields({ fields }: { fields: WorkflowOutputValue[] }) {
  return <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">{fields.map((field) => <div key={field.key} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"><dt className="text-muted-foreground">{field.label}</dt><dd className="break-all font-medium tabular-nums">{outputValue(field)}</dd></div>)}</dl>;
}

export function WorkflowStepOutputView({ output, pending = false }: { output?: WorkflowStepOutput; pending?: boolean }) {
  return <section className="space-y-4 pt-4" aria-label="Step output">
    <div className="flex items-center justify-between gap-3"><h4 className="text-sm font-semibold">Output</h4>{output && output.totalItems > 0 && <span className="text-xs text-muted-foreground tabular-nums">{output.totalItems} results</span>}</div>
    {!output ? <p className="text-sm text-muted-foreground">{pending ? 'Output will appear when this step finishes.' : 'Output was not captured for this execution.'}</p> : <>
      {output.metrics.length > 0 && <KpiStrip columns={Math.min(output.metrics.length, 4)}>{output.metrics.map((metric) => <Kpi key={metric.key} label={metric.label} value={outputValue(metric)} caption="This execution" valueTone={['failed', 'projectsFailed'].includes(metric.key) && Number(metric.value) > 0 ? 'error' : ['succeeded', 'projectsRead'].includes(metric.key) && Number(metric.value) > 0 ? 'healthy' : 'default'} />)}</KpiStrip>}
      {output.fields.length > 0 && <OutputFields fields={output.fields} />}
      {output.items.length > 0 && <Table stacked aria-label="Output results"><TableHeader><TableRow><TableHead>Item</TableHead><TableHead>Result</TableHead><TableHead>Details</TableHead></TableRow></TableHeader><TableBody>{output.items.map((item, index) => <TableRow key={`${item.label}-${index}`}><TableCell label="Item" className="font-medium">{item.label}</TableCell><TableCell label="Result"><WorkflowStateLabel state={item.state} /></TableCell><TableCell label="Details"><OutputFields fields={item.fields} /></TableCell></TableRow>)}</TableBody></Table>}
      {output.truncated && <p className="text-xs text-muted-foreground tabular-nums">Showing {output.items.length} of {output.totalItems} results. The execution captured a bounded sample.</p>}
      <details className="border-t border-border pt-3"><summary className="cursor-pointer text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">Captured data</summary><pre className="mt-3 max-h-96 overflow-auto rounded-md bg-muted/40 p-3 text-xs tabular-nums">{JSON.stringify(output, null, 2)}</pre></details>
    </>}
  </section>;
}

export function WorkflowScheduleTimeline({ cron, timezone = 'UTC', now, enabled, name }: { cron: string; timezone?: string; now: number; enabled: boolean; name: string }) {
  const minute = Math.floor(now / 60_000) * 60_000;
  const slots = useMemo(() => {
    const buckets: Date[][] = Array.from({ length: 24 }, () => []);
    if (enabled) {
      const timer = new Cron(cron, { timezone, paused: true });
      let cursor = new Date(minute);
      for (let count = 0; count < 1440; count++) {
        const date = timer.nextRun(cursor);
        if (!date || date.getTime() >= minute + 24 * 3_600_000) break;
        buckets[Math.floor((date.getTime() - minute) / 3_600_000)]?.push(date);
        cursor = date;
      }
      timer.stop();
    }
    return buckets;
  }, [cron, timezone, enabled, minute]);
  return <div className="flex h-10 items-center gap-1" aria-label={`${name}: next 24 hours`}>
    {slots.map((dates, i) => <InfoTooltip key={i} label={`${name}, next ${i + 1} hours`} className="h-10 min-h-0! min-w-0! flex-1 no-underline max-sm:min-h-0! max-sm:min-w-0!"
      trigger={<span aria-hidden className={cn('w-full rounded-sm border', dates.length ? 'h-5 border-foreground/30 bg-foreground/15' : 'h-1 border-border bg-muted')} />}>
      <p className="font-medium tabular-nums">{dates.length} scheduled {dates.length === 1 ? 'run' : 'runs'} in this hour</p>
      {dates.slice(0, 3).map((d) => <p key={d.toISOString()} className="tabular-nums">{formatNextRun(d.toISOString())} {localTimezoneLabel(d.toISOString())}<span className="block text-muted-foreground">{utcRunReference(d.toISOString())}</span></p>)}
      {dates.length > 3 && <p>Repeats through this hour.</p>}
    </InfoTooltip>)}
  </div>;
}
