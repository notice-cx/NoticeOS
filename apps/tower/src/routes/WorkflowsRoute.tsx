import { useDemoReadonly } from '@/lib/browser-context';
import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, Clock, GitBranch, Pencil, Search } from 'lucide-react';
import { WORKFLOW_DEFINITIONS, WORKFLOW_STATE_LABEL, installedWorkflows, workflowBasePath, type WorkflowSurface, workflowState, workflowRunAge, type WorkflowsPayload, type WorkflowDefinition, type WorkflowState } from '@shared/workflows';
import { SCHEDULES_WAITING, WORKFLOW_GROUPS, formatNextRun, utcRunReference, localTimezone, scheduleTimezone, scheduleFor, scheduleLabel, isCollectionJob, scheduleHref, type ScheduleOverrides } from '@shared/scheduled-jobs';
import { PageHeader } from '@/components/PageHeader';
import { ReadFailed } from '@/components/ReadFailed';
import { Tabs, TabPanel } from '@/components/Tabs';
import { PageAnswer } from '@/components/surface/PageAnswer';
import { WorkflowActivity, WorkflowRunTrigger, WorkflowScheduleTimeline, WorkflowStages, WorkflowStateLabel, workflowDuration } from '@/components/WorkflowVisuals';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { fieldClass } from '@/components/ui/field';
import { useWorkflows } from '@/hooks/useWorkflows';
import { useConfigWritable } from '@/hooks/useConfigWritable';
import { DEMO_READ_ONLY } from '@shared/demo-viewer';
import { useConnections } from '@/hooks/useConnections';
import { connectionState } from '@shared/integrations-page';
import { useNow } from '@/hooks/useNow';
import { cn } from '@/lib/utils';
import { HealthNavigation } from './health/HealthNavigation';
import { ScheduleEditor } from './workflows/ScheduleEditor';

const ATTENTION = new Set<WorkflowState>(['failed', 'unknown']);
const INACTIVE = new Set<WorkflowState>(['skipped', 'paused', 'never']);
const rank: Record<WorkflowState, number> = { failed: 0, unknown: 1, waiting: 2, running: 3, never: 4, skipped: 5, succeeded: 6, paused: 7 };

function RuntimeNotice({ data }: { data: WorkflowsPayload }) {
  if (data.runtimeFresh && !data.runtime?.error && data.historyAvailable && data.observationsFresh) return null;
  return <div role="status" data-status-for="system:scheduler" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warn/30 bg-warn/5 px-4 py-3 text-sm">
    <p>{!data.runtimeFresh ? 'Live operation is unconfirmed. The scheduler has not reported recently.' : !data.historyAvailable ? 'Execution history is unavailable. Workflow health cannot be confirmed.' : !data.observationsFresh ? 'Live execution observations are stale. Current workflow health is unconfirmed.' : data.runtime?.error === SCHEDULES_WAITING ? 'Saved schedules could not be read. Jobs are waiting for them.' : 'The scheduler could not refresh its settings. Previously confirmed schedules remain active.'}</p>
    <Link className="inline-flex min-h-8 items-center gap-1 font-medium underline underline-offset-4" to="/health">Check system health <ArrowUpRight className="size-3.5" aria-hidden /></Link>
  </div>;
}

/** The index's one sentence: how many need you (failed or unknown), else
 * that none do; the detail counts every other state once, in its label. */
export function workflowsAnswer(states: readonly WorkflowState[], noun: string): { answer: string; detail: string; mark: 'attention' | 'clear' | 'empty' } {
  const counts = new Map<WorkflowState, number>();
  for (const state of states) counts.set(state, (counts.get(state) ?? 0) + 1);
  const tally = (order: readonly WorkflowState[]) => order.filter((state) => counts.get(state)).map((state) => `${counts.get(state)} ${WORKFLOW_STATE_LABEL[state].toLowerCase()}`).join(' · ');
  if (states.length === 0) return { answer: `No ${noun} installed`, detail: '', mark: 'empty' };
  const attention = states.filter((state) => ATTENTION.has(state)).length;
  if (attention > 0) {
    return { answer: `${attention} of ${states.length} ${noun} need you`, detail: tally(['failed', 'unknown', 'running', 'waiting', 'succeeded', 'skipped', 'paused', 'never']), mark: 'attention' };
  }
  return { answer: `No ${noun} need you`, detail: tally(['running', 'waiting', 'succeeded', 'skipped', 'paused', 'never']), mark: 'clear' };
}

function WorkflowsAnswer({ states, noun }: { states: readonly WorkflowState[]; noun: string }) {
  const answer = workflowsAnswer(states, noun);
  return <PageAnswer answer={answer.answer} detail={answer.detail || undefined} marks={{ 'data-workflows-answer': answer.mark }} />;
}

function NextRun({ workflow, data, showCadence = true }: { workflow: WorkflowDefinition; data: WorkflowsPayload; showCadence?: boolean }) {
  const saved = scheduleFor(workflow, data.overrides ?? {});
  const active = data.runtimeFresh ? data.runtime?.jobs.find((j) => j.id === workflow.id) : undefined;
  const pending = active && (saved.enabled !== active.enabled || saved.cron !== active.cron || scheduleTimezone(saved) !== scheduleTimezone(active));
  return <div className="space-y-1 text-xs tabular-nums">
    <span title={active?.nextRun ? utcRunReference(active.nextRun) : undefined} className={cn('block', !active && 'text-muted-foreground')}>{!active ? 'Unconfirmed' : !active.enabled ? 'No upcoming run' : active.nextRun ? formatNextRun(active.nextRun) : 'Not scheduled'}</span>
    {(pending || showCadence) && <span className={cn('block', pending ? 'text-warn' : 'text-muted-foreground')}>{pending ? 'Saved change pending' : active?.enabled ? scheduleLabel(active.cron, scheduleTimezone(active)) : '—'}</span>}
  </div>;
}

export default function WorkflowsRoute({ surface = 'workflow' }: { surface?: WorkflowSurface }) {
  const { id } = useParams();
  const location = useLocation();
  const definition = WORKFLOW_DEFINITIONS.find((workflow) => workflow.id === id);
  if (definition && definition.surface !== surface) return <Navigate replace to={`${workflowBasePath(definition.surface)}/${id}${location.search}`} />;
  return id && id !== 'schedule' ? <WorkflowDetail key={id} id={id} surface={surface} /> : <WorkflowIndex schedule={id === 'schedule'} surface={surface} />;
}

function WorkflowIndex({ schedule, surface }: { schedule: boolean; surface: WorkflowSurface }) {
  const system = surface === 'system';
  const base = workflowBasePath(surface);
  const noun = system ? 'operations' : 'workflows';
  const query = useWorkflows();
  const now = useNow(5_000);
  const [search, setSearch] = useSearchParams();
  const filter = search.get('state') ?? 'all';
  const term = search.get('q') ?? '';
  const group = search.get('group') ?? 'all';
  const sort = search.get('sort') ?? 'latest';
  const grouped = search.get('view') !== 'flat';
  const setFilter = (key: string, value: string) => { const next = new URLSearchParams(search); if (!value || value === 'all') next.delete(key); else next.set(key, value); setSearch(next, { replace: key === 'q' }); };
  const data = query.data ? { ...query.data, runtimeFresh: query.data.runtimeFresh && !query.isError && now - Date.parse(query.data.generatedAt) < 45_000 } : undefined;
  const definitions = installedWorkflows(data).filter((workflow) => workflow.surface === surface);
  const categories = WORKFLOW_GROUPS.filter((group) => definitions.some((workflow) => workflow.group === group.label));
  const all = data?.workflows.filter((summary) => definitions.some((workflow) => workflow.id === summary.id)).map((summary) => ({ summary, workflow: WORKFLOW_DEFINITIONS.find((w) => w.id === summary.id)!, state: workflowState(summary, data) })) ?? [];
  const rows = all.filter(({ workflow, state }) => (!term || [workflow.label, workflow.source ?? '', workflow.group, ...(workflow.keywords ?? [])].join(' ').toLowerCase().includes(term.toLowerCase())) && (group === 'all' || workflow.group === group) &&
    (filter === 'all' || filter === 'attention' && ATTENTION.has(state) || filter === 'inactive' && INACTIVE.has(state) || filter === state))
    .sort((a, b) => {
      const name = a.workflow.label.localeCompare(b.workflow.label);
      if (sort === 'name') return name;
      if (sort === 'attention') return rank[a.state] - rank[b.state] || name;
      if (sort === 'next') {
        const upcoming = (id: string) => {
          const job = data?.runtimeFresh ? data.runtime?.jobs.find((entry) => entry.id === id) : undefined;
          return job?.enabled && job.nextRun ? Date.parse(job.nextRun) : Infinity;
        };
        return (upcoming(a.workflow.id) - upcoming(b.workflow.id)) || name;
      }
      const latest = (row: typeof a) => Math.max(Date.parse(row.summary.active?.startedAt ?? '') || -Infinity, Date.parse(row.summary.latest?.startedAt ?? '') || -Infinity);
      return latest(b) - latest(a) || name;
    });
  const sections = grouped ? [...new Set(rows.map((row) => row.workflow.group))].map((label) => ({ label, items: rows.filter((row) => row.workflow.group === label) })) : [{ label: null, items: rows }];
  const tab = schedule ? 'schedule' : 'overview';
  const suffix = search.size ? `?${search}` : '';
  return <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 p-4 md:p-6">
    <PageHeader title={system ? 'System health' : 'Workflows'} actions={<span className="flex items-center gap-2 text-xs text-muted-foreground"><Clock className="size-3.5" aria-hidden />Times in {localTimezone()}</span>} />
    {system && <HealthNavigation />}
    <div id={system ? 'health-view-panel' : undefined} role={system ? 'tabpanel' : undefined} aria-labelledby={system ? 'health-view-operations' : undefined} className="space-y-6">
    {/* A failed first read is the desk's one failure state (bead `ro-ujb9.242`),
        never the read's own sentence. */}
    {!data ? query.isError ? <ReadFailed title={`Couldn't load ${noun}`} subject={`read:${noun}`} error={query.error} retrying={query.isFetching} onRetry={() => void query.refetch()} /> : <div className="py-12 text-sm text-muted-foreground">Loading workflows…</div> : <>
      <RuntimeNotice data={data} />
      {/* THE ONE ANSWER (D44) in place of four equal tiles: what needs you,
          else that nothing does, with the rest counted once in the states'
          own words. The tab above already names Background operations. */}
      <WorkflowsAnswer states={all.map((row) => row.state)} noun={noun} />
      <Tabs label={system ? 'Operation views' : 'Workflow views'} idBase="workflow-view" panelId="workflow-view-panel" tabs={[{ key: 'overview', to: `${base}${suffix}`, label: 'Activity', end: true }, { key: 'schedule', to: `${base}/schedule${suffix}`, label: 'Schedule', end: true }]} />
      <TabPanel idBase="workflow-view" id="workflow-view-panel" activeKey={tab}>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <label className="relative min-w-48 flex-1"><Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" aria-hidden /><span className="sr-only">Search {noun}</span><input className={cn(fieldClass, 'w-full pl-9')} value={term} placeholder={`Search ${noun}…`} onChange={(e) => setFilter('q', e.target.value)} /></label>
            <label><span className="sr-only">{system ? 'Operation' : 'Workflow'} state</span><select className={fieldClass} value={filter} onChange={(e) => setFilter('state', e.target.value)}><option value="all">All states</option><option value="attention">Needs attention</option><option value="failed">Failed</option><option value="running">Running</option><option value="succeeded">{WORKFLOW_STATE_LABEL.succeeded}</option><option value="inactive">Inactive</option></select></label>
            <label><span className="sr-only">{system ? 'Operation' : 'Workflow'} category</span><select className={fieldClass} value={group} onChange={(e) => setFilter('group', e.target.value)}><option value="all">All categories</option>{categories.map((g) => <option key={g.label}>{g.label}</option>)}</select></label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">Sort<select aria-label={`Sort ${noun}`} className={fieldClass} value={sort} onChange={(e) => setFilter('sort', e.target.value)}><option value="latest">Latest run</option><option value="attention">Needs attention</option><option value="next">Next run</option><option value="name">Name</option></select></label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">Group<select aria-label={`Group ${noun}`} className={fieldClass} value={grouped ? 'category' : 'flat'} onChange={(e) => setFilter('view', e.target.value)}><option value="category">Category</option><option value="flat">None</option></select></label>
          </div>
          {/* The key is the legend itself: three states, their glyphs and colours,
              over bars whose column header already says "Hourly activity". */}
          {schedule ? <p className="text-xs text-muted-foreground">Next 24 hours</p> : <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>Activity · Last 24 hours</span><span className="flex flex-wrap items-center gap-4"><WorkflowStateLabel state="succeeded" /><WorkflowStateLabel state="failed" /><WorkflowStateLabel state="skipped" label="Skipped / no runs" /></span></div>}
          <div className="overflow-hidden rounded-lg border border-border">
            <div className={cn('hidden items-center gap-5 border-b border-border bg-muted/30 px-4 py-3 text-xs font-medium text-muted-foreground lg:grid', schedule ? 'grid-cols-[minmax(14rem,1.4fr)_minmax(16rem,2fr)_11rem]' : 'grid-cols-[minmax(14rem,1.6fr)_6rem_minmax(10rem,1fr)_11rem]')}>
              <span>{system ? 'Operation' : 'Workflow'}</span>{!schedule && <span>State</span>}{schedule ? <span className="flex justify-between tabular-nums"><span>Now</span><span>+6h</span><span>+12h</span><span>+18h</span><span>+24h</span></span> : <span>Hourly activity</span>}<span>Next run · Local time</span>
            </div>
            <div className="divide-y divide-border">
              {sections.map(({ label, items }) => <section key={label ?? 'all'} aria-label={label ?? `All ${noun}`}>
                {label && <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/40 px-4 py-3">
                  <h2 className="text-sm font-semibold">{label} <span className="ml-1 text-xs font-normal text-muted-foreground tabular-nums">{items.length}</span></h2>
                  <div className="flex flex-wrap items-center gap-3 tabular-nums">{(['failed', 'unknown', 'running', 'succeeded', 'skipped', 'paused', 'never'] satisfies WorkflowState[]).map((state) => {
                    const total = items.filter((item) => item.state === state).length;
                    return total ? <WorkflowStateLabel key={state} state={state} label={`${total} ${WORKFLOW_STATE_LABEL[state].toLowerCase()}`} /> : null;
                  })}</div>
                </div>}
                <div className="divide-y divide-border">{items.map(({ summary, workflow, state }) => <div key={workflow.id} className={cn('grid items-center gap-x-5 gap-y-3 px-4 py-4 transition-colors hover:bg-muted/20 lg:py-5', schedule ? 'lg:grid-cols-[minmax(14rem,1.4fr)_minmax(16rem,2fr)_11rem]' : 'lg:grid-cols-[minmax(14rem,1.6fr)_6rem_minmax(10rem,1fr)_11rem]')}>
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"><Link to={`${base}/${workflow.id}`} className="inline-flex min-h-7 items-center gap-2 text-sm font-semibold outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"><GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />{workflow.label}</Link>{workflow.source && <Badge variant="outline" className="font-normal">{workflow.source}</Badge>}</div>
                {!schedule && <WorkflowStateLabel state={state} />}
                {schedule ? <WorkflowScheduleTimeline timezone={data.runtime?.jobs.find((j) => j.id === workflow.id)?.timezone} cron={data.runtime?.jobs.find((j) => j.id === workflow.id)?.cron ?? workflow.cron} enabled={Boolean(data.runtimeFresh && data.runtime?.jobs.find((j) => j.id === workflow.id)?.enabled)} now={now} name={workflow.label} /> : <div className="min-w-0"><WorkflowActivity history={summary.history} name={workflow.label} /><p className="text-xs text-muted-foreground tabular-nums">{summary.latest ? <Link to={`${base}/${workflow.id}?run=${encodeURIComponent(summary.latest.id)}`} title={utcRunReference(summary.latest.startedAt)} className="underline-offset-4 hover:underline"><time dateTime={summary.latest.startedAt}>{workflowRunAge(summary.latest.startedAt, now)}</time></Link> : 'No recorded runs'}</p></div>}
                <NextRun workflow={workflow} data={data} />
              </div>)}</div></section>)}
              {/* Nothing installed here is not a filter result: say so, and
                  lead to the operations that do run. */}
              {!rows.length && (definitions.length ? <p className="p-8 text-center text-sm text-muted-foreground">No {noun} match these filters.</p>
                : <div className="flex flex-col items-center gap-2 p-8 text-sm"><p className="text-muted-foreground">No {noun} run here yet.</p>
                  {!system && installedWorkflows(data).some((workflow) => workflow.surface === 'system') && <Link className="inline-flex min-h-8 items-center gap-1 font-medium underline underline-offset-4" to={workflowBasePath('system')}>Background operations <ArrowUpRight className="size-3.5" aria-hidden /></Link>}</div>)}
            </div>
          </div>
          <p className="text-xs text-muted-foreground tabular-nums">{rows.length} of {definitions.length} {noun}</p>
        </div>
      </TabPanel>
    </>}
    </div>
  </div>;
}

function WorkflowDetail({ id, surface }: { id: string; surface: WorkflowSurface }) {
  const demoReadonly = useDemoReadonly();
  const base = workflowBasePath(surface);
  const breadcrumb = surface === 'system' ? [{ label: 'System health', to: '/health' }, { label: 'Background operations', to: base }] : [{ label: 'Workflows', to: base }];
  const [search, setSearch] = useSearchParams();
  const runId = search.get('run') ?? undefined;
  const query = useWorkflows(runId);
  const now = useNow(5_000);
  const definition = WORKFLOW_DEFINITIONS.find((w) => w.id === id);
  const [editing, setEditing] = useState<{ overrides: ScheduleOverrides | null } | null>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const writable = useConfigWritable();
  const { credentials } = useConnections();
  const data = query.data ? { ...query.data, runtimeFresh: query.data.runtimeFresh && !query.isError && now - Date.parse(query.data.generatedAt) < 45_000 } : undefined;
  const summary = data?.workflows.find((w) => w.id === id);
  const defaultRun = summary?.active ?? summary?.latest;
  useEffect(() => {
    if (!runId && defaultRun) { const next = new URLSearchParams(search); next.set('run', defaultRun.id); setSearch(next, { replace: true }); }
  }, [runId, defaultRun?.id, search, setSearch]);
  const selected = runId ? data?.selectedRun?.workflowId === id && data.selectedRun.id === runId ? data.selectedRun : null : defaultRun ?? null;
  if (!definition) return <div className="p-6"><PageHeader title="Workflow not found" breadcrumb={breadcrumb} /></div>;
  const saved = data ? scheduleFor(definition, data.overrides ?? {}) : null;
  const collection = isCollectionJob(definition);
  // A connection's panel opens from `?connect=` while it is connected and not
  // failing (IntegrationsRoute's `panelTarget`).
  const scheduleLink = collection ? scheduleHref(definition, (provider) => {
    const credential = credentials?.get(provider);
    if (!credential) return false;
    const state = connectionState(credential);
    return state !== 'not-connected' && state !== 'failing';
  }) : null;
  return <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 p-4 md:p-6">
    <PageHeader title={definition.label} description={definition.source} breadcrumb={breadcrumb}
      actions={summary && data ? <WorkflowStateLabel state={workflowState(summary, data)} /> : undefined} />
    {!data && query.isError ? <ReadFailed title={`Couldn't load this ${surface === 'system' ? 'operation' : 'workflow'}`} subject={`read:${surface === 'system' ? 'operation' : 'workflow'}`} error={query.error} retrying={query.isFetching} onRetry={() => void query.refetch()} />
      : !data || !summary ? <p className="text-sm text-muted-foreground">Loading workflow…</p> : <>
      <RuntimeNotice data={data} />
      <div className="flex flex-wrap items-start justify-between gap-4 border-y border-border py-4">
        <div className="flex flex-wrap gap-x-10 gap-y-3"><div><p className="mb-1 text-xs text-muted-foreground">Schedule · Local time</p><p className="text-sm font-medium tabular-nums">{saved?.enabled ? scheduleLabel(saved.cron, scheduleTimezone(saved)) : 'Paused'}</p></div><div><p className="mb-1 text-xs text-muted-foreground">Next execution</p><NextRun workflow={definition} data={data} showCadence={false} /></div><div><p className="mb-1 text-xs text-muted-foreground">Category</p><p className="text-sm">{definition.group}</p></div></div>
        {/* A COLLECTION'S SCHEDULE IS EDITED WITH THE COLLECTION (beads
            `ro-ujb9.96.7.12`, `ro-ujb9.96.7.28`): on the Manage panel of a
            connection that feeds it, or in Settings → Data collection for one
            no connection feeds (`scheduleHref`). This page keeps the runner's
            view above — saved schedule, next run, a change still pending — and
            links there; a collection nothing is connected for has no link.
            Every other job's one editor is still this one. */}
        {collection ? (
          scheduleLink ? (
            <Button asChild variant="outline" size="sm">
              <Link to={scheduleLink} data-schedule-settings-link><Pencil className="size-3.5" aria-hidden />{scheduleLink.startsWith('/settings') ? 'Edit in Settings' : 'Edit in Integrations'}</Link>
            </Button>
          ) : null
        ) : (
          <Button ref={editButton} variant="outline" size="sm" disabled={Boolean(editing) || !writable.writable || query.isError} onClick={() => setEditing({ overrides: data.overrides })}><Pencil className="size-3.5" aria-hidden />Edit schedule</Button>
        )}
      </div>
      {!collection && editing && <ScheduleEditor job={definition} overrides={editing.overrides} writable={writable.writable && !query.isError}
        onReload={async () => { const fresh = await query.refetch(); setEditing({ overrides: fresh.data?.overrides ?? null }); }}
        onClose={() => { setEditing(null); requestAnimationFrame(() => editButton.current?.focus()); }} />}
      {!collection && !writable.writable && !(demoReadonly && writable.reason === DEMO_READ_ONLY) && <p className="text-sm text-muted-foreground">{writable.reason}</p>}
      <section className="space-y-4" aria-label="Workflow execution">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-base font-semibold">Execution stages</h2><label className="flex items-center gap-2 text-xs text-muted-foreground">Run<select className={cn(fieldClass, 'max-w-full tabular-nums')} value={runId ?? ''} onChange={(e) => { const next = new URLSearchParams(search); next.set('run', e.target.value); setSearch(next); }}>
          {!runId && <option value="">No recorded run</option>}
          {summary.active && <option value={summary.active.id}>Running now</option>}
          {runId && !summary.runs.some((r) => r.id === runId) && summary.active?.id !== runId && <option value={runId}>{selected ? formatNextRun(selected.startedAt) : 'Requested run unavailable'}</option>}
          {summary.runs.map((run) => <option key={run.id} value={run.id} title={utcRunReference(run.startedAt)}>{formatNextRun(run.startedAt)} · {WORKFLOW_STATE_LABEL[run.state]}{run.trigger?.kind === 'manual' ? ' · Manual' : ''}</option>)}
        </select></label></div>
        {selected ? <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground tabular-nums"><WorkflowStateLabel state={selected.state === 'running' && (!data.runtimeFresh || !data.observationsFresh) ? 'unknown' : selected.state} /><time dateTime={selected.startedAt} title={utcRunReference(selected.startedAt)}>{formatNextRun(selected.startedAt)}</time><WorkflowRunTrigger run={selected} /><span>{workflowDuration(selected.startedAt, selected.finishedAt)}</span><span>{selected.definitionVersion ? `Version ${selected.definitionVersion}` : 'Version unavailable'}</span></div> : runId ? query.isPlaceholderData ? <p role="status" data-status-for={`workflow-run:${runId}`} className="text-sm text-muted-foreground">Loading execution…</p> : <p className="text-sm text-warn">This run is not in the retained execution history.</p> : null}
        <WorkflowStages key={selected?.id ?? 'definition'} definition={definition} run={selected ?? null} fresh={data.runtimeFresh && data.observationsFresh} />
      </section>
      <section className="space-y-3" aria-label="Recent runs"><div className="flex items-center justify-between"><h2 className="text-base font-semibold">Recent runs</h2><span className="text-xs text-muted-foreground">Latest 10 · Local time</span></div>
        <div className="divide-y divide-border rounded-lg border border-border">{summary.runs.slice(0, 10).map((run) => <Link key={run.id} to={`${base}/${id}?run=${encodeURIComponent(run.id)}`} className={cn('grid min-h-14 grid-cols-[minmax(0,1fr)_auto_3.5rem] items-center gap-3 px-4 py-3 outline-none hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring', selected?.id === run.id && 'bg-muted/40')} data-workflow-run={run.id}><span className="flex flex-wrap items-center gap-x-3 gap-y-1"><time dateTime={run.startedAt} title={utcRunReference(run.startedAt)} className="text-sm tabular-nums">{formatNextRun(run.startedAt)}</time><WorkflowRunTrigger run={run} /></span><WorkflowStateLabel state={run.state} /><span className="text-right text-xs text-muted-foreground tabular-nums">{workflowDuration(run.startedAt, run.finishedAt)}</span></Link>)}{!summary.runs.length && <p className="p-5 text-sm text-muted-foreground">No recorded runs for this workflow.</p>}</div>
      </section>
    </>}
  </div>;
}
