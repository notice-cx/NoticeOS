import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { AnalysisAssignment, AnalysisRun } from '@shared/analysis-workflows';
import { TASK_PROJECTS_PATH } from '@shared/tasks';
import { Button } from '@/components/ui/button';
import { fieldClass } from '@/components/ui/field';
import { useOwnerMutation, useTowerApi } from '@/lib/browser-context';
import { taskPath } from '@/lib/task-path';
import { ANALYSIS_QUERY } from './analysis-workflow-links';

function AssignedAnalysisTask({ assignment }: { assignment: AnalysisAssignment & { taskId: string } }) {
  const api = useTowerApi();
  const projects = useQuery({ queryKey: ['task-projects'], queryFn: ({ signal }) => api.fetchTaskProjects(signal),
    staleTime: 15_000, retry: false });
  const project = projects.data?.find(item => item.projectId === assignment.projectId);
  if (!project) return <p className="text-sm text-muted-foreground">
    {projects.isPending ? 'Loading assigned task…' : 'The assigned task project is unavailable.'}
  </p>;
  return <Link className="inline-flex min-h-8 items-center text-sm underline underline-offset-4"
    to={taskPath(assignment.taskId, project.logicalKey)}>View assigned task</Link>;
}

export function AnalysisRunAssignment({ run, writable }: { run: AnalysisRun; writable: boolean }) {
  const api = useTowerApi();
  const cache = useQueryClient();
  const queryKey = [...ANALYSIS_QUERY, run.workflowId, run.id];
  const assignment = run.assignment ?? null;
  const awaitingResult = !run.result && !run.retryOf;
  const canAssign = writable && awaitingResult && assignment === null;
  const [selected, setSelected] = useState('');
  const projects = useQuery({ queryKey: [...ANALYSIS_QUERY, 'assignment-projects'], enabled: canAssign,
    queryFn: ({ signal }) => api.fetchAnalysisAssignmentProjects(signal), retry: false });
  const names = projects.data?.projects ?? [];
  const project = (names.length === 1 ? names[0] : names.find(item => item.projectId === selected)) ?? null;
  const submit = useOwnerMutation({
    onMutate: () => cache.cancelQueries({ queryKey, exact: true }),
    mutationFn: (projectId: string | null) => projectId === null
      ? api.reconcileAnalysisAssignment(run.workflowId, run.id)
      : api.assignAnalysisRun(run.workflowId, run.id, projectId),
    onSuccess: ({ assignment }) => cache.setQueryData<{ run: AnalysisRun }>(queryKey, current => current ? { run: { ...current.run, assignment } } : current),
    onError: () => void cache.invalidateQueries({ queryKey, exact: true }),
  });
  if (!assignment && !awaitingResult) return null;

  return <section aria-label="Analysis assignment" className="space-y-2 rounded-lg border border-border p-4">
    <h3 className="font-semibold">Analysis assignment</h3>
    {assignment?.taskId ? <AssignedAnalysisTask assignment={{ ...assignment, taskId: assignment.taskId }} />
      : assignment ? <div className="space-y-2">
        <p role="status" data-status-for="task:analysis-assignment" className="text-sm text-muted-foreground">
          {assignment.deliveryStartedAt ? 'The task has not been confirmed.' : 'The task has not been sent.'}
        </p>
        {writable && (awaitingResult || assignment.deliveryStartedAt) ? <Button type="button" size="sm" variant="outline"
          disabled={submit.isPending} onClick={() => submit.mutate(assignment.deliveryStartedAt ? null : assignment.projectId)}>
          {assignment.deliveryStartedAt ? 'Check assignment' : 'Retry assignment'}
        </Button> : null}
      </div> : !canAssign ? <p className="text-sm text-muted-foreground">A workspace owner or operator can assign this analysis.</p>
        : projects.isError ? <div className="flex flex-wrap items-center gap-2 text-sm"><p>Couldn’t load task projects.</p><Button type="button" size="sm" variant="outline" onClick={() => void projects.refetch()}>Try again</Button></div>
          : !projects.data ? <p role="status" data-status-for="read:analysis-task-projects" className="text-sm text-muted-foreground">Loading task projects…</p>
            : names.length === 0 ? <p className="text-sm">Set up a writable project in <Link className="underline underline-offset-4" to={TASK_PROJECTS_PATH}>Task projects</Link> to assign this analysis.</p>
              : <div className="space-y-2">
                {names.length === 1 ? <p className="text-sm text-muted-foreground">Project · {project?.displayName}</p> : <label className="grid max-w-md gap-1 text-sm">Task project
                  <select className={fieldClass} value={selected} onChange={event => setSelected(event.target.value)} disabled={submit.isPending}>
                    <option value="">Choose a project</option>{names.map(item => <option key={item.projectId} value={item.projectId}>{item.displayName}</option>)}
                  </select>
                </label>}
                <p className="text-sm text-muted-foreground">Creates a task for review. The run stays open for a result.</p>
                <Button type="button" size="sm" variant="outline" disabled={!project || submit.isPending} onClick={() => { if (project) submit.mutate(project.projectId); }}>
                  {submit.isPending ? 'Assigning…' : 'Assign analysis'}
                </Button>
              </div>}
    {submit.isError ? <p role="alert" className="text-sm text-error">{submit.error.message}</p> : null}
  </section>;
}
