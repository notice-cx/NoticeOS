import { useMemo, useSyncExternalStore } from 'react';
import { useBrowserRuntime } from './browser-context';

export type TaskReviewField = 'comment' | 'done-evidence';
interface Draft {
  readonly text: string;
  readonly revision: number;
  readonly pending: number | null;
}
const EMPTY: Draft = Object.freeze({ text: '', revision: 0, pending: null });

/** Cache entries retain only this runtime's drafts until its cache is cleared.
 * Revisions distinguish edits even when the operator types the same text again. */
export function useTaskReviewDraft(project: string | null, id: string, field: TaskReviewField) {
  const runtime = useBrowserRuntime();
  const key = useMemo(() => {
    const queryKey = ['task-review-draft', project, id, field] as const;
    runtime.queries.getQueryCache().build<Draft>(runtime.queries, {
      queryKey, initialData: EMPTY, gcTime: Infinity,
    });
    return queryKey;
  }, [runtime, project, id, field]);
  const read = () => runtime.queries.getQueryData<Draft>(key) ?? EMPTY;
  const data = useSyncExternalStore(
    (notify) => runtime.queries.getQueryCache().subscribe(notify), read, read,
  );
  const change = runtime.guard((text: string) => {
    if (project === null) return;
    const current = read();
    runtime.queries.setQueryData<Draft>(key, { ...current, text, revision: current.revision + 1 });
  });
  return {
    text: data.text,
    pending: data.pending !== null,
    available: project !== null,
    change,
    discard: () => change(''),
    begin: runtime.guard(() => {
      const current = read();
      if (project === null || current.pending !== null || !current.text.trim()) return null;
      runtime.queries.setQueryData<Draft>(key, { ...current, pending: current.revision });
      return {
        text: current.text.trim(),
        // The captured key and lifetime cannot follow a later route or owner.
        settle: runtime.guard((confirmed: boolean) => {
          const latest = read();
          if (latest.pending !== current.revision) return;
          runtime.queries.setQueryData<Draft>(key, {
            text: confirmed && latest.revision === current.revision ? '' : latest.text,
            revision: latest.revision + 1,
            pending: null,
          });
          return true;
        }),
      };
    }),
  };
}
