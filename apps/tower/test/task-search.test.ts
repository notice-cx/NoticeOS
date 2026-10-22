// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { taskSearch } from '@/lib/task-search';
import { readTaskBoard, type TaskBoardFilters } from '@/lib/task-board-read';
import { searchBoard, searchSnapshot, SEARCH_PROJECT, SEARCH_TARGET } from './task-word-search-fixture';

const filters: TaskBoardFilters = { project: 'all', status: 'all', priority: 'all', label: '', assignee: 'all' };
const read = (picks: Partial<TaskBoardFilters> = {}, scope: string | null = null) => readTaskBoard({
  snapshot: searchSnapshot(), capabilities: { live: true, reason: null }, scope,
  reads: new Map([[SEARCH_PROJECT, { data: searchBoard(), isError: false, error: null }]]),
  filters: { ...filters, ...picks },
});

describe('task title/id search', () => {
  const task = { title: 'Repair API: retry (v2)', id: 'ex-249.1' };
  it.each(['', '  \t\n', 'REPAIR', '  retry \t api:  ', '(V2) API:', 'EX-249.1', 'ex-249.1 REPAIR'])('matches literal terms: %j', query => {
    expect(taskSearch(query)(task)).toBe(true);
  });
  it.each(['api!', '(v3)', 'repair absent', 'description-only', 'ex-249.2', '.*'])('rejects missing literal terms: %j', query => {
    expect(taskSearch(query)(task)).toBe(false);
  });
  it('searches all 250 available tasks before display pagination', () => {
    expect(read().rows).toHaveLength(250);
    expect(read().rows.slice(0, 25).some(task => task.id === SEARCH_TARGET)).toBe(false);
    expect(read({ q: 'API: (V2)' }).rows.map(task => task.id)).toEqual([SEARCH_TARGET]);
    expect(read({ q: SEARCH_TARGET.toUpperCase() }).rows.map(task => task.id)).toEqual([SEARCH_TARGET]);
    expect(read({ q: 'description-only' }).rows).toEqual([]);
  });
  it('composes with all five filters and never widens a scoped project', () => {
    const picks = { q: 'retry API:', project: SEARCH_PROJECT, status: 'open', priority: 'normal', label: 'review', assignee: 'Ada' };
    expect(read(picks).rows.map(task => task.id)).toEqual([SEARCH_TARGET]);
    for (const mismatch of [{ project: 'other.example' }, { status: 'closed' }, { priority: 'top' }, { label: 'absent' }, { assignee: 'Bea' }]) {
      expect(read({ ...picks, ...mismatch }).rows).toEqual([]);
    }
    expect(read({ ...picks, project: 'other.example' }, SEARCH_PROJECT).rows.map(task => task.id)).toEqual([SEARCH_TARGET]);
    expect(read(picks, 'other.example').rows).toEqual([]);
  });
});
