import { useDemoReadonly } from '@/lib/browser-context';
import { StatusBanner } from "@/components/surface/StatusBanner";
import { CONFIG_READ_ONLY_FALLBACK, useConfigWritable } from "@/hooks/useConfigWritable";
import type { ConfigWritability } from "@/lib/api";
import { DEMO_READ_ONLY } from '@shared/demo-viewer';

/**
 * SAVES ARE PAUSED — SAID ONCE, FOR THE WHOLE SCREEN (bead `ro-p8qq`).
 *
 * When the deployment answers `writable: false` (the config store unreachable
 * or not ready, or a build that cannot write), that is one fact about the
 * DEPLOYMENT, not about each field — yet every editor used to print it under
 * itself: an asset's Settings tab said "Config store unreachable — saves
 * paused" five times on one screen. doc 21 principle 3b: one status per subject
 * per screen. So a page with editors renders this once at its top, its editors
 * pass `statesReadOnly={false}` and show only their lock.
 *
 * *Registry justification:* `StatusBanner` is the line; this is the one reading
 * that decides whether it is open and what it says, so the three pages that
 * stack editors (/settings, /financials, an asset's Settings tab) cannot word
 * the same state three ways. It renders nothing while saves work, because the
 * banner exists only while its state is open.
 *
 * `state` is for the component gallery, which shows the paused state without
 * pausing anything.
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
