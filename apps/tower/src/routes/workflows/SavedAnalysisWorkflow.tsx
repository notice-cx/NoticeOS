import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { AnalysisFinding, AnalysisResult, AnalysisRun, AnalysisRunbook } from '@shared/analysis-workflows';
import { ReadFailed } from '@/components/ReadFailed';
import { Button } from '@/components/ui/button';
import { fieldClass } from '@/components/ui/field';
import { useOwnerMutation, useTowerApi } from '@/lib/browser-context';
import { formatTimestamp } from '@/lib/format';
import { ANALYSIS_QUERY, analysisWorkflowHref, triggerLabel, useAnalysisRequestKey } from './analysis-workflow-links';
import { AnalysisRunAssignment } from './AnalysisRunAssignment';

const OUTCOME = { findings: 'Findings recorded', 'no-action': 'No action recommended', 'insufficient-evidence': 'Insufficient evidence', failed: 'Could not complete' };

export function RunbookSteps({ book, collapsed }: { book: AnalysisRunbook; collapsed?: boolean }) {
  const contents = <>
    <p className="text-sm">{book.question}</p>
    <ol className="list-decimal space-y-2 pl-5 text-sm">{book.steps.map(step => <li key={step.id}>
      <strong>{step.title}</strong><p className="text-muted-foreground">{step.instruction}</p>
    </li>)}</ol>
    <p className="text-sm text-muted-foreground">{book.output}</p>
  </>;
  return collapsed ? <details className="rounded-md border border-border p-3">
    <summary className="cursor-pointer text-sm font-medium">Review template steps</summary><div className="mt-3 space-y-3">{contents}</div>
  </details> : <section aria-label="Runbook steps" className="space-y-3 rounded-lg border border-border p-4">
    <h3 className="font-semibold">{book.title} steps <span className="text-sm font-normal text-muted-foreground">· Version {book.version}</span></h3>{contents}
  </section>;
}

export function SavedAnalysisWorkflow({ id, runId, runbooks, writable, open }: {
  id: string;
  runId: string | null;
  runbooks: readonly AnalysisRunbook[];
  writable: boolean;
  open: (id: string, run?: string) => void;
}) {
  const api = useTowerApi();
  const cache = useQueryClient();
  const queryKey = [...ANALYSIS_QUERY, id];
  const query = useQuery({ queryKey, queryFn: ({ signal }) => api.fetchAnalysisWorkflow(id, signal), retry: false });
  const requestKey = useAnalysisRequestKey();
  const start = useOwnerMutation({
    mutationFn: (retryOf?: string) => {
      const body = retryOf ? { retryOf } : {};
      return api.startAnalysisRun(id, body, requestKey.for(body));
    },
    onSuccess: ({ run }) => {
      requestKey.confirmed();
      cache.setQueryData([...queryKey, run.id], { run });
      void cache.invalidateQueries({ queryKey });
      open(id, run.id);
    },
  });
  const pause = useOwnerMutation({ mutationFn: (body: { enabled: boolean; expectedVersion: number }) => api.setAnalysisWorkflowEnabled(id, body),
    onSettled: () => void cache.invalidateQueries({ queryKey: ANALYSIS_QUERY }),
  });

  if (query.isError) return <ReadFailed title="Couldn’t open workflow" subject="read:analysis-workflow" error={query.error} retrying={query.isFetching} onRetry={() => void query.refetch()} />;
  if (!query.data) return <p role="status" data-status-for="read:analysis-workflow" className="text-sm text-muted-foreground">Loading workflow…</p>;
  const { workflow, runs } = query.data;
  const book = runbooks.find(template => template.id === workflow.template);
  const error = start.error ?? pause.error;

  return <article aria-labelledby="workflow-name" className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-1"><h2 id="workflow-name" className="text-xl font-semibold">{workflow.name}</h2>
        <p className="text-sm text-muted-foreground">{triggerLabel(workflow.trigger)} · {workflow.enabled ? 'Enabled' : 'Paused'}</p></div>
      {writable ? <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => start.mutate(undefined)} disabled={!workflow.enabled || start.isPending || pause.isPending}>{start.isPending ? 'Starting…' : 'Start run'}</Button>
        <Button type="button" variant="outline" disabled={pause.isPending || start.isPending}
          onClick={() => pause.mutate({ enabled: !workflow.enabled, expectedVersion: workflow.version })}>{workflow.enabled ? 'Pause workflow' : 'Resume workflow'}</Button>
      </div> : null}
    </div>
    <ul aria-label="Selected assets" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
      {workflow.assetIds.map(asset => <li key={asset}><Link to={`/assets/${encodeURIComponent(asset)}`} className="underline underline-offset-4">{asset}</Link></li>)}
    </ul>
    {error ? <p role="alert" className="text-sm text-error">{error.message}</p> : null}
    {runId ? <AnalysisRunDetails key={runId} id={id} runId={runId} writable={writable}
      retry={writable && workflow.enabled ? () => start.mutate(runId) : undefined} starting={start.isPending} /> : book ? <RunbookSteps book={book} /> : null}
    <section aria-labelledby="workflow-run-history" className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="workflow-run-history" className="font-semibold">Run history</h3>
        {runId ? <Link className="text-sm underline underline-offset-4" to={analysisWorkflowHref(id)}>View workflow</Link> : null}
      </div>
      {runs.length ? <ul className="divide-y divide-border rounded-md border border-border bg-card">
        {runs.map(run => <li key={run.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2 text-sm">
          <Link className="font-medium underline-offset-4 hover:underline" aria-current={runId === run.id ? 'page' : undefined} to={analysisWorkflowHref(id, run.id)}>
            <time dateTime={run.createdAt}>{formatTimestamp(run.createdAt)}</time> · {run.source === 'weekly' ? 'Scheduled' : run.source === 'retry' ? 'Retry' : 'Manual'}</Link>
          <span className="text-muted-foreground">{run.outcome ? OUTCOME[run.outcome] : 'Awaiting result'}</span>
        </li>)}
      </ul> : <p className="text-sm text-muted-foreground">No runs recorded.</p>}
    </section>
  </article>;
}

function AnalysisRunDetails({ id, runId, writable, retry, starting }: { id: string; runId: string; writable: boolean; retry?: () => void; starting: boolean }) {
  const api = useTowerApi();
  const cache = useQueryClient();
  const queryKey = [...ANALYSIS_QUERY, id, runId];
  const query = useQuery({ queryKey, queryFn: ({ signal }) => api.fetchAnalysisRun(id, runId, signal), retry: false });
  const complete = useOwnerMutation({ mutationFn: (result: AnalysisResult) => api.completeAnalysisRun(id, runId, result),
    onMutate: () => cache.cancelQueries({ queryKey, exact: true }),
    onSuccess: (response) => {
      cache.setQueryData<{ run: AnalysisRun }>(queryKey, current => ({ run: {
        ...response.run, assignment: response.run.assignment === undefined ? current?.run.assignment : response.run.assignment,
      } }));
      void cache.invalidateQueries({ queryKey: [...ANALYSIS_QUERY, id], exact: true });
    },
    onSettled: () => { void cache.invalidateQueries({ queryKey, exact: true }); },
  });
  if (query.isError && !query.data) return <ReadFailed title="Couldn’t open run" subject="read:analysis-run" error={query.error} retrying={query.isFetching} onRetry={() => void query.refetch()} />;
  if (!query.data) return <p role="status" data-status-for="read:analysis-run" className="text-sm text-muted-foreground">Loading run…</p>;
  const { run } = query.data;

  return <section aria-label="Workflow run" className="space-y-4 border-y border-border py-5">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h3 className="font-semibold">Run · <time dateTime={run.createdAt}>{formatTimestamp(run.createdAt)}</time></h3>
        <p className="text-sm text-muted-foreground">{run.outcome ? OUTCOME[run.outcome] : 'Awaiting result'}</p></div>
      {retry && run.outcome === 'failed' ? <Button size="sm" variant="outline" onClick={retry} disabled={starting}>Retry run</Button> : null}
    </div>
    {run.retryOf ? <Link className="text-sm underline underline-offset-4" to={analysisWorkflowHref(id, run.retryOf)}>View original run</Link> : null}
    {run.result ? <RecordedResult run={run} result={run.result} /> : null}
    <RunbookSteps book={run.runbook} />
    <RunEvidence run={run} />
    <AnalysisRunAssignment run={run} writable={writable} />
    {writable && !run.result ? <ResultForm run={run} pending={complete.isPending} error={complete.error?.message} save={complete.mutate} /> : null}
  </section>;
}

function RunEvidence({ run }: { run: AnalysisRun }) {
  const { evidence } = run;
  return <section aria-label="Run evidence" className="space-y-3 rounded-lg border border-border p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">Evidence saved with this run</h3>
      <time className="text-sm text-muted-foreground" dateTime={evidence.asOf}>{formatTimestamp(evidence.asOf)}</time></div>
    {evidence.coverage.length ? <ul className="space-y-2 text-sm">{evidence.coverage.map((item, index) => <li key={`${item.assetId}:${item.source}:${index}`}>
      <strong>{item.assetId} · {item.source}</strong> <span className="text-muted-foreground">· {item.status === 'available' ? 'Available' : item.status === 'limited' ? 'Limited' : 'Unavailable'}</span>
      {item.detail ? <p>{item.detail}</p> : null}</li>)}</ul> : null}
    {evidence.citations.length ? <ul className="divide-y divide-border rounded-md border border-border">{evidence.citations.map(citation => <li key={citation.id} className="space-y-1 px-3 py-2 text-sm">
      <p className="font-medium">{citation.label} · {citation.assetId}</p>
      <p className="text-muted-foreground">{citation.source} · <time dateTime={citation.observedAt}>{citation.observedAt.length === 10 ? citation.observedAt : formatTimestamp(citation.observedAt)}</time></p>
      <dl className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums">{citation.readings.map(({ label, value }, index) => <div key={`${label}:${index}`} className="flex gap-1"><dt>{label}</dt><dd className="font-medium">{value === null ? 'Unavailable' : typeof value === 'boolean' ? value ? 'Yes' : 'No' : value}</dd></div>)}</dl>
      {citation.note ? <p className="text-muted-foreground">{citation.note}</p> : null}
      {citation.href.startsWith('/assets/') && !citation.href.includes('\\') ? <Link className="underline underline-offset-4" to={citation.href}>Open asset report</Link> : null}
    </li>)}</ul> : <p className="text-sm text-muted-foreground">This run has no saved report evidence.</p>}
    <Link className="inline-flex min-h-8 items-center text-sm underline underline-offset-4" to="/health/operations">Check background operations</Link>
  </section>;
}

function RecordedResult({ run, result }: { run: AnalysisRun; result: AnalysisResult }) {
  const citations = new Map(run.evidence.citations.map(citation => [citation.id, citation.label]));
  return <section aria-label="Recorded result" className="space-y-2 rounded-lg border border-border bg-card p-4">
    <h3 className="font-semibold">{OUTCOME[result.outcome]}</h3>
    <p className="whitespace-pre-wrap text-sm">{result.summary}</p>
    {result.findings.length ? <ul className="space-y-2">{result.findings.map((finding, index) => <li key={index} className="border-t border-border pt-2 text-sm">
      <p className="font-medium">{finding.title}</p><p className="whitespace-pre-wrap">{finding.detail}</p>
      <p className="text-muted-foreground">{finding.citationIds.map(id => citations.get(id)).filter(Boolean).join(' · ')}</p>
    </li>)}</ul> : null}
  </section>;
}

const blankFinding = (): AnalysisFinding => ({ title: '', detail: '', citationIds: [] });

function ResultForm({ run, pending, error, save }: { run: AnalysisRun; pending: boolean; error?: string; save: (result: AnalysisResult) => void }) {
  const [outcome, setOutcome] = useState<AnalysisResult['outcome'] | ''>('');
  const [summary, setSummary] = useState('');
  const [findings, setFindings] = useState<AnalysisFinding[]>([blankFinding()]);
  const citations = run.evidence.citations;
  const withFindings = outcome === 'findings';
  const valid = !!outcome && !!summary.trim() && (!withFindings || findings.every(finding => !!finding.title.trim() && !!finding.detail.trim() && finding.citationIds.length > 0));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!outcome || !valid || pending) return;
    save({ outcome, summary: summary.trim(), findings: withFindings ? findings.map(finding => ({ ...finding, title: finding.title.trim(), detail: finding.detail.trim() })) : [] });
  }
  function updateFinding(index: number, change: Partial<AnalysisFinding>) {
    setFindings(items => items.map((item, itemIndex) => itemIndex === index ? { ...item, ...change } : item));
  }

  return <form aria-label="Record result" className="space-y-3 rounded-lg border border-border bg-card p-4" onSubmit={submit}>
    <h3 className="font-semibold">Record result</h3>
    <label className="grid gap-1 text-sm">Outcome * <select required className={fieldClass} value={outcome} onChange={event => setOutcome(event.target.value as AnalysisResult['outcome'] | '')}>
      <option value="">Choose a result</option>
      <option value="no-action">No action recommended</option><option value="findings" disabled={citations.length === 0}>Findings</option>
      <option value="insufficient-evidence">Insufficient evidence</option><option value="failed">Could not complete</option>
    </select></label>
    <label className="grid gap-1 text-sm">Summary * <textarea required rows={3} maxLength={2000} className={fieldClass} value={summary} onChange={event => setSummary(event.target.value)} /></label>
    {withFindings ? <div className="space-y-3">{findings.map((finding, index) => <fieldset key={index} className="space-y-2 rounded-md border border-border p-3">
      <legend className="text-sm font-medium">Finding {index + 1}</legend>
      <label className="grid gap-1 text-sm">Title * <input required maxLength={160} className={fieldClass} value={finding.title} onChange={event => updateFinding(index, { title: event.target.value })} /></label>
      <label className="grid gap-1 text-sm">Finding and next step * <textarea required rows={3} maxLength={1000} className={fieldClass} value={finding.detail} onChange={event => updateFinding(index, { detail: event.target.value })} /></label>
      <fieldset className="grid gap-1"><legend className="text-sm font-medium">Evidence</legend>{citations.map(citation => <label key={citation.id} className="flex min-h-8 items-center gap-2 text-sm">
        <input type="checkbox" checked={finding.citationIds.includes(citation.id)} disabled={finding.citationIds.length >= 12 && !finding.citationIds.includes(citation.id)}
          onChange={event => updateFinding(index, { citationIds: event.target.checked ? [...finding.citationIds, citation.id] : finding.citationIds.filter(id => id !== citation.id) })} />{citation.label} · {citation.assetId}</label>)}</fieldset>
      {findings.length > 1 ? <Button type="button" variant="ghost" size="sm" onClick={() => setFindings(current => current.filter((_, itemIndex) => itemIndex !== index))}>Remove finding {index + 1}</Button> : null}
    </fieldset>)}{findings.length < 3 ? <Button type="button" variant="outline" size="sm" onClick={() => setFindings(current => [...current, blankFinding()])}>Add finding</Button> : null}</div> : null}
    {error ? <p role="alert" className="text-sm text-error">{error}</p> : null}
    <Button type="submit" disabled={!valid || pending}>{pending ? 'Saving…' : 'Save result'}</Button>
  </form>;
}
