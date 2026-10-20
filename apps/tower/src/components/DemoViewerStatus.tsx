import { demoViewer, type DemoViewerDescriptor } from '@shared/demo-viewer';
import { ageMs, formatAge } from '@shared/freshness';
import { useNow } from '@/hooks/useNow';
import { formatCalendarDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useVerifiedDemoMode } from '@/lib/browser-context';
import { useTowerApi } from '@/lib/browser-context';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/** One demo identity and real generation age, on the desk and the Wall. */
export function DemoViewerStatus({ className, viewer = demoViewer(), nowMs, viewSwitch }: {
  className?: string;
  /** Presentation-only gallery input; never changes the application policy. */
  viewer?: DemoViewerDescriptor | null;
  nowMs?: number;
  /** Drawn at the bar's end; below the facts on a phone, so they stay on screen. */
  viewSwitch?: ReactNode;
}) {
  const hostedDemo = useVerifiedDemoMode();
  if (hostedDemo) return <HostedDemoStatus className={className} nowMs={nowMs} viewSwitch={viewSwitch} />;
  if (viewer === null) return null;
  return <ViewerStatusFacts viewer={viewer} className={className} nowMs={nowMs} viewSwitch={viewSwitch} />;
}
function SwitchSlot({ children }: { children?: ReactNode }) {
  if (children === undefined || children === null) return null;
  return <div className="max-sm:basis-full sm:ms-auto">{children}</div>;
}
function HostedDemoStatus({ className, nowMs, viewSwitch }: { className?: string; nowMs?: number; viewSwitch?: ReactNode }) {
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
    <SwitchSlot>{viewSwitch}</SwitchSlot>
  </div>;
}
function ViewerStatusFacts({ viewer, className, nowMs, viewSwitch }: { viewer: DemoViewerDescriptor; className?: string; nowMs?: number; viewSwitch?: ReactNode }) {
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
      <SwitchSlot>{viewSwitch}</SwitchSlot>
    </div>
  );
}
