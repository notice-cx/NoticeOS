import { demoViewer, type DemoViewerDescriptor } from '@shared/demo-viewer';
import { ageMs, formatAge } from '@shared/freshness';
import { useNow } from '@/hooks/useNow';
import { formatCalendarDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useVerifiedDemoMode } from '@/lib/browser-context';
import { useTowerApi } from '@/lib/browser-context';
import { useQuery } from '@tanstack/react-query';

/** One demo identity and real generation age, on the desk and the Wall. */
export function DemoViewerStatus({ className, viewer = demoViewer(), nowMs }: {
  className?: string;
  /** Presentation-only gallery input; never changes the application policy. */
  viewer?: DemoViewerDescriptor | null;
  nowMs?: number;
}) {
  const hostedDemo = useVerifiedDemoMode();
  if (hostedDemo) return <HostedDemoStatus className={className} nowMs={nowMs} />;
  if (viewer === null) return null;
  return <ViewerStatusFacts viewer={viewer} className={className} nowMs={nowMs} />;
}
function HostedDemoStatus({ className, nowMs }: { className?: string; nowMs?: number }) {
  const { fetchDemoPresentation } = useTowerApi();
  const facts = useQuery({ queryKey: ['demo-presentation'], queryFn: ({ signal }) => fetchDemoPresentation(signal),
    refetchInterval: 60_000, refetchIntervalInBackground: false, staleTime: 30_000 });
  const clock = useNow();
  const generatedAt = facts.data?.generatedAt ?? null;
  const age = ageMs(nowMs ?? clock, generatedAt);
  return <div role="status" data-status-for="mode:demo" data-demo-viewer
    className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2 text-xs text-muted-foreground', className)}>
    <span className="font-medium text-foreground">Synthetic demo · Read only</span>
    {facts.data?.through ? <span>Scenario through {formatCalendarDate(facts.data.through)}</span> : null}
    <span title={generatedAt ?? undefined}>{age === null ? 'Generation time unknown' : `Generated ${formatAge(age)} ago`}</span>
  </div>;
}
function ViewerStatusFacts({ viewer, className, nowMs }: { viewer: DemoViewerDescriptor; className?: string; nowMs?: number }) {
  const clock = useNow();
  const now = nowMs ?? clock;
  const age = ageMs(now, viewer.generatedAt);
  return (
    <div role="status" data-status-for="mode:demo" data-demo-viewer className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2 text-xs text-muted-foreground', className)}>
      <span className="font-medium text-foreground">Synthetic demo · Read only</span>
      <span>Scenario through {formatCalendarDate(viewer.cutoff.slice(0, 10))}</span>
      <span title={viewer.generatedAt ?? undefined}>
        {age === null ? 'Generation time unknown' : `Generated ${formatAge(age)} ago`}
      </span>
    </div>
  );
}
