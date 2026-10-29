import { describe, expect, it } from 'vitest';
import { taskViewFacts } from '@/routes/tasks/task-view-context';
import { workflowEvidenceValues } from '@/routes/workflows/workflow-view';
import { taskBodyOrder, taskSectionOrder } from '@/routes/tasks/task-section-order';
import type { BoardTask } from '@/lib/task-board-read';
import type { WorkflowRun } from '@shared/workflows';
import { liveTask } from './tasks-next-fixtures';

const task = (overrides: Partial<BoardTask> = {}): BoardTask => ({ ...liveTask(), project: 'example.com', ...overrides });

describe('purpose evidence facts', () => {
  it('uses recorded predictions and measurement coverage, with missing criteria kept unknown', () => {
    const rows = [task({ card: { valuePerMonth: 300, likelihood: 0.5, reviewMinutes: 12, daysToSignal: 21, measurability: 'holdout' }, acceptance: 'Verify the holdout', dependencies: [] }), task({ card: null, acceptance: undefined, dependencies: undefined })];
    expect(taskViewFacts('growth', rows)?.facts).toEqual([
      { label: 'Cohort or holdout', value: '1' }, { label: 'Unmeasured or no plan', value: '1' }, { label: 'Shortest signal estimate', value: '21 days' },
    ]);
    expect(taskViewFacts('revenue', rows)?.facts).toEqual([
      { label: 'Predicted value / month', value: '$300' }, { label: 'Review time', value: '12 min' }, { label: 'Tasks without estimates', value: '1' },
    ]);
    expect(taskViewFacts('reliability', rows)?.facts).toContainEqual({ label: 'Criteria unavailable', value: '1' });
    expect(taskViewFacts('reliability', rows)?.facts).toContainEqual({ label: 'Without done criteria', value: '0' });
    expect(taskViewFacts('revenue', [task({ card: null })])?.facts[0]?.value).toBe('Not recorded');
  });


  it('counts only known open dependencies and distinguishes missing coverage from a true zero', () => {
    const edge = (status: string | null) => ({ id: `dependency-${status}`, type: 'blocks', title: null, status });
    const dependencies = (rows: BoardTask[]) => taskViewFacts('delivery', rows)?.facts.find(fact => fact.label === 'Open dependencies')?.value;
    expect(dependencies([task({ dependencies: [edge('open'), edge('closed'), edge(null), edge('unknown')] }), task({ dependencies: undefined })])).toBe('1 known · incomplete');
    expect(dependencies([task({ dependencies: undefined })])).toBe('Unknown');
    expect(dependencies([task({ dependencies: [edge(null)] })])).toBe('Unknown');
    expect(dependencies([task({ dependencies: [] })])).toBe('0');
    expect(dependencies([task({ dependencies: [edge('closed')] })])).toBe('0');
    expect(dependencies([task({ dependencies: [edge('open'), edge('closed')] })])).toBe('1');
  });

  it('retains every detail section while promoting dependencies and verification', () => {
    expect(taskSectionOrder('delivery').slice(0, 2)).toEqual(['dependencies', 'progress']);
    expect(taskBodyOrder('reliability')[0]).toBe('acceptance');
    expect([...taskSectionOrder('reliability')].sort()).toEqual([...taskSectionOrder('overview')].sort());
  });

  it('selects only explicitly denominated financial outputs without interpreting their labels', () => {
    const recorded = { key: 'estimate', label: 'Provider estimate', value: 4.25, unit: 'USD' as const };
    const sessions = { key: 'sessions', label: 'Sessions', value: 30 };
    const run: WorkflowRun = { id: 'test-run', workflowId: 'test', definitionVersion: 1, startedAt: '2026-10-01T12:00:00Z', state: 'succeeded', steps: [
      { id: 'measure', attempt: 1, startedAt: '2026-10-01T12:00:00Z', state: 'succeeded', output: { version: 1, metrics: [sessions, recorded], fields: [], items: [], totalItems: 0, truncated: false } },
    ] };
    expect(workflowEvidenceValues('revenue', run)).toEqual([recorded]);
    expect(workflowEvidenceValues('growth', run)).toEqual([sessions, recorded]);
    expect(workflowEvidenceValues('revenue', { ...run, steps: null })).toEqual([]);
  });
});
