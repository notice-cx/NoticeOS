import { useId } from 'react';
import { LoaderCircle, Play } from 'lucide-react';
import { useOwnerMutation, useTowerApi } from '@/lib/browser-context';
import { Button } from '@/components/ui/button';

export function RunWorkflow({ id, label, disabledReason, spendNotice, onComplete }: {
  id: string; label: string; disabledReason: string | null; spendNotice?: string; onComplete: (runId?: string) => Promise<void>;
}) {
  const noticeId = useId();
  const { runLocalJob } = useTowerApi();
  const mutation = useOwnerMutation({ mutationFn: () => runLocalJob(id, id === 'signal-dumps'),
    onSettled: (result) => onComplete(result?.runId), retry: false });
  const message = mutation.isPending ? 'This may take a few minutes.' : mutation.isError
    ? mutation.error.message : mutation.data?.outcome === 'running' ? disabledReason : mutation.data ? mutation.data.outcome === 'ran' ? 'Run completed.' : mutation.data.outcome === 'skipped' ? 'The job was skipped. Check its latest run.' : 'The job failed. Check its latest run.' : disabledReason;
  return <div className="flex max-w-sm flex-col items-start gap-2">
    {spendNotice && <p id={noticeId} className="text-xs text-muted-foreground">{spendNotice}</p>}
    <Button size="sm" disabled={Boolean(disabledReason) || mutation.isPending} aria-label={`Run ${label} now`} aria-describedby={spendNotice ? noticeId : undefined}
      onClick={() => mutation.mutate()}>
      {mutation.isPending ? <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
      {mutation.isPending ? 'Running…' : 'Run now'}
    </Button>
    {message && <p role={mutation.isError ? 'alert' : 'status'} data-status-for={`local-job:${id}`}
      className="text-xs text-muted-foreground">{message}</p>}
  </div>;
}
