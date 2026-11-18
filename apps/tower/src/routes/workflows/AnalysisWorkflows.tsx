import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { AnalysisRunbook, CreateAnalysisWorkflow } from '@shared/analysis-workflows';
import { PageHeader } from '@/components/PageHeader';
import { ReadFailed } from '@/components/ReadFailed';
import { Button } from '@/components/ui/button';
import { fieldClass } from '@/components/ui/field';
import { useWall } from '@/hooks/useWall';
import { useBrowserContext, useOwnerMutation, useTowerApi } from '@/lib/browser-context';
import { SavedAnalysisWorkflow, RunbookSteps } from './SavedAnalysisWorkflow';
import { ANALYSIS_QUERY, WEEKDAYS, analysisWorkflowHref, triggerLabel, useAnalysisRequestKey } from './analysis-workflow-links';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const MAX_ASSETS = 8;

export function AnalysisWorkflows() {
  const [search, setSearch] = useSearchParams();
  const workflow = search.get('workflow');
  const run = search.get('run');
  const valid = (workflow === null || UUID.test(workflow)) && (run === null || (workflow !== null && UUID.test(run)));
  const { workspaceRole } = useBrowserContext();
  const writable = workspaceRole === 'owner' || workspaceRole === 'operator';
  const [creating, setCreating] = useState(false);
  const api = useTowerApi();
  const query = useQuery({ queryKey: ANALYSIS_QUERY, enabled: valid, queryFn: ({ signal }) => api.fetchAnalysisWorkflows(signal), retry: false });
  const runbooks = query.data?.runbooks ?? [];
  const open = (id: string, runId?: string) => {
    const next = new URLSearchParams({ workflow: id });
    if (runId) next.set('run', runId);
    setSearch(next);
  };

  return <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 p-4 md:p-6">
    <PageHeader title="Workflows" />
    <nav aria-label="Workflow destinations" className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
      {workflow || run ? <Link to="/workflows" className="underline underline-offset-4">All workflows</Link> : null}
      <Link to="/health/operations" className="underline underline-offset-4">Background operations</Link>
      <Link to="/workflows?activity=1" className="underline underline-offset-4">Workflow activity</Link>
      <Link to="/settings/notifications" className="underline underline-offset-4">Notifications</Link>
    </nav>
    {!valid ? <p role="status" className="text-sm text-muted-foreground">This workflow or run link is invalid.</p>
      : workflow ? <SavedAnalysisWorkflow key={workflow} id={workflow} runId={run} runbooks={runbooks} writable={writable} open={open} />
        : query.isError ? <ReadFailed title="Couldn’t load analysis workflows" subject="read:analysis-workflows" error={query.error} retrying={query.isFetching} onRetry={() => void query.refetch()} />
          : !query.data ? <p role="status" className="text-sm text-muted-foreground">Loading workflows…</p> : <>
            {creating && writable ? <NewAnalysisWorkflow runbooks={runbooks} onCancel={() => setCreating(false)} onCreated={(id) => {
              setCreating(false);
              open(id);
            }} /> : <section aria-labelledby="saved-workflows" className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 id="saved-workflows" className="text-lg font-semibold">Saved workflows</h2>
                {writable && runbooks.length > 0 ? <Button onClick={() => setCreating(true)}>Create workflow</Button> : null}
              </div>
              {query.data.workflows.length > 0 ? <ul className="divide-y divide-border rounded-lg border border-border bg-card">
                {query.data.workflows.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <div><Link className="font-medium underline-offset-4 hover:underline" to={analysisWorkflowHref(item.id)}>{item.name}</Link>
                    <p className="text-sm text-muted-foreground">{runbooks.find(book => book.id === item.template)?.title} · {triggerLabel(item.trigger)}</p></div>
                  <span className="text-sm text-muted-foreground">{item.enabled ? 'Enabled' : 'Paused'}</span>
                </li>)}
              </ul> : <p className="text-sm text-muted-foreground">{writable ? 'Choose a template to review saved search or AI visibility reports for your assets.' : 'A workspace owner or operator can create a workflow.'}</p>}
            </section>}
          </>}
  </div>;
}

function NewAnalysisWorkflow({ runbooks, onCancel, onCreated }: { runbooks: readonly AnalysisRunbook[]; onCancel: () => void; onCreated: (id: string) => void }) {
  const api = useTowerApi();
  const cache = useQueryClient();
  const wall = useWall();
  const [template, setTemplate] = useState(runbooks[0]?.id);
  const book = runbooks.find(item => item.id === template);
  const [name, setName] = useState(book?.title ?? '');
  const [assetIds, setAssetIds] = useState<string[]>([]);
  const [weekly, setWeekly] = useState(false);
  const [weekday, setWeekday] = useState(1);
  const [time, setTime] = useState('09:00');
  const timeZone = wall.data?.osTimeZone;
  const requestKey = useAnalysisRequestKey();
  const save = useOwnerMutation({
    mutationFn: (value: CreateAnalysisWorkflow) => api.createAnalysisWorkflow(value, requestKey.for(value)),
    onSuccess: ({ workflow }) => {
      void cache.invalidateQueries({ queryKey: ANALYSIS_QUERY });
      onCreated(workflow.id);
    },
  });
  const assets = wall.data?.assets.filter(asset => asset.status !== 'retired') ?? [];
  const selected = assets.filter(asset => assetIds.includes(asset.id)).map(asset => asset.id);
  const canSave = !!book && !!name.trim() && selected.length > 0 && (!weekly || (!!timeZone && /^\d\d:\d\d$/u.test(time)));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave || !template || save.isPending) return;
    const [hour = 0, minute = 0] = time.split(':').map(Number);
    save.mutate({ name: name.trim(), template, assetIds: selected, trigger: weekly && timeZone ? { kind: 'weekly', weekday, hour, minute, timeZone } : { kind: 'manual' } });
  }

  return <form className="max-w-3xl space-y-5 rounded-lg border border-border bg-card p-4 md:p-5" onSubmit={submit} aria-label="Create workflow">
    <h2 className="text-lg font-semibold">Create workflow</h2>
    <div className="grid gap-3 md:grid-cols-2">
      <label className="grid gap-1 text-sm">Template <select required className={fieldClass} value={template} onChange={event => {
        const next = runbooks.find(item => item.id === event.target.value);
        if (!next) return;
        if (name === book?.title || !name.trim()) setName(next.title);
        setTemplate(next.id);
      }}>{runbooks.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      <label className="grid gap-1 text-sm">Workflow name * <input required className={fieldClass} maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label>
    </div>
    {book ? <>
      <RunbookSteps book={book} collapsed />
      {book.inputs?.length ? <p className="text-sm text-muted-foreground">Reports used · {book.inputs.join(' · ')}</p> : null}
    </> : null}
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Assets</legend>
      {wall.isError ? <div className="flex items-center gap-2 text-sm"><span>Couldn’t load assets.</span><Button type="button" variant="outline" size="sm" onClick={() => void wall.refetch()}>Try again</Button></div> :
        !wall.data ? <p role="status" className="text-sm text-muted-foreground">Loading assets…</p> : !assets.length ? <p className="text-sm"><Link className="underline" to="/assets">Add an asset</Link> before creating a workflow.</p> :
          <div className="grid gap-1 sm:grid-cols-2">{assets.map(asset => <label key={asset.id} className="flex min-h-8 items-center gap-2 text-sm">
            <input type="checkbox" value={asset.id} checked={assetIds.includes(asset.id)} disabled={selected.length >= MAX_ASSETS && !assetIds.includes(asset.id)}
              onChange={event => setAssetIds(event.target.checked ? [...assetIds, asset.id] : assetIds.filter(id => id !== asset.id))} />{asset.displayName}
          </label>)}</div>}
      {assets.length > MAX_ASSETS ? <p className="text-sm text-muted-foreground">Select up to {MAX_ASSETS} assets.</p> : null}
    </fieldset>
    <div className="flex flex-wrap items-end gap-3">
      <label className="grid gap-1 text-sm">Trigger <select className={fieldClass} value={weekly ? 'weekly' : 'manual'} onChange={event => setWeekly(event.target.value === 'weekly')}>
        <option value="manual">Manual</option><option value="weekly">Weekly</option>
      </select></label>
      {weekly ? <>
        <label className="grid gap-1 text-sm">Day <select className={fieldClass} value={weekday} onChange={event => setWeekday(Number(event.target.value))}>
          {WEEKDAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}
        </select></label>
        <label className="grid gap-1 text-sm">Time * <input type="time" required className={fieldClass} value={time} onChange={event => setTime(event.target.value)} /></label>
        <p className="self-center text-sm text-muted-foreground">{timeZone ?? 'Workspace time zone unavailable'}</p>
      </> : null}
    </div>
    {save.isError ? <p role="alert" className="text-sm text-error">{save.error.message}</p> : null}
    <div className="flex gap-2">
      <Button type="submit" disabled={!canSave || save.isPending}>{save.isPending ? 'Saving…' : 'Save workflow'}</Button>
      <Button type="button" variant="ghost" onClick={onCancel} disabled={save.isPending}>Cancel</Button>
    </div>
  </form>;
}
