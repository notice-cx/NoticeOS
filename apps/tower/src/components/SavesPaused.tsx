import { useDemoReadonly } from '@/lib/browser-context';
import { StatusBanner } from "@/components/surface/StatusBanner";
import { CONFIG_READ_ONLY_FALLBACK, useConfigWritable } from "@/hooks/useConfigWritable";
import type { ConfigWritability } from "@/lib/api";
import { DEMO_READ_ONLY } from '@shared/demo-viewer';

/**
 * Saves are paused, said once for the whole screen. `writable: false` is a
 * fact about the deployment, not each field, so a page with editors renders
 * this at its top and its editors pass `statesReadOnly={false}`. `state` lets
 * the gallery show the paused state without pausing anything.
 */
export function SavesPaused({
  state,
  className,
}: {
  state?: Pick<ConfigWritability, "writable" | "reason">;
  className?: string;
}) {
  const demoReadonly = useDemoReadonly();
  const live = useConfigWritable();
  const { writable, reason } = state ?? live;
  if (writable || (!state && demoReadonly && reason === DEMO_READ_ONLY)) return null;
  return (
    <div data-saves-paused className={className}>
      <StatusBanner lead="Saves paused" subject="config:saves" severity="warn">
        {reason ?? CONFIG_READ_ONLY_FALLBACK}
      </StatusBanner>
    </div>
  );
}
