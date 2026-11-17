import type { ConnectionHealthSnapshot } from "@shared/connection-status";
import { formatTimestamp } from "@/lib/format";

const LABEL = {
  saved: "Health checked",
  stale: "Stale health check",
  error: "Health refresh failed",
  unknown: "Health unknown",
} as const;

export function WallHealthStamp({ snapshot, timeZone, className = 'text-wall-strip-label' }: {
  snapshot: ConnectionHealthSnapshot; timeZone?: string; className?: string;
}) {
  return <span className={`${className} tabular-nums text-muted-foreground`} data-health-snapshot={snapshot.state}>
    {LABEL[snapshot.state]}
    {snapshot.checkedAt ? <> · <time dateTime={snapshot.checkedAt}>{formatTimestamp(snapshot.checkedAt, timeZone)}</time></> : null}
  </span>;
}
