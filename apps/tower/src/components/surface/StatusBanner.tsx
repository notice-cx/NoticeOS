import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Severity } from "@shared/wall";
import { ProgressRing } from "@/components/ProgressRing";
import { SeverityDot } from "@/components/SeverityDot";
import type { StatusSubject } from "@/components/StateChip";
import { pillControlClass } from "@/components/ui/pill";
import { cn } from "@/lib/utils";

export interface StatusBannerAction {
  label: string;
  to?: string;
  onClick?: () => void;
}

export interface StatusBannerProps {
  /** The banner exists only while its state is open. `false` renders nothing,
   * not a collapsed strip or a dismissed placeholder. */
  open?: boolean;
  /** The bold half: what state this is. Two or three words. */
  lead: string;
  /** What the state is about (`StatusSubject`), drawn as `data-status-for`. */
  subject: StatusSubject;
  /** One sentence. Anything longer belongs behind `About`. */
  children?: ReactNode;
  /** A discrete count of steps, drawn as the setup ring. */
  ring?: { done: number; total: number; title: string };
  /** The mark when there is no ring: a severity dot, which is what the rest of
   * the desk already uses for "this needs attention". */
  severity?: Severity | null;
  action?: StatusBannerAction;
  className?: string;
}

/**
 * One line at the top of a surface while something is open. It draws no
 * severity colour of its own: the mark carries the state and the sentence the
 * fact, so a banner never competes with the real alerts under it.
 */
export function StatusBanner({
  open = true,
  lead,
  subject,
  children,
  ring,
  severity = null,
  action,
  className,
}: StatusBannerProps) {
  if (!open) return null;

  return (
    <div
      role="status"
      data-status-for={subject}
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[10px] border border-border bg-card px-3 py-2 text-xs text-muted-foreground",
        className,
      )}
    >
      {ring ? (
        <ProgressRing done={ring.done} total={ring.total} title={ring.title} size="sm" />
      ) : (
        <SeverityDot severity={severity} size="md" />
      )}
      <span className="min-w-0">
        <span className="font-semibold text-foreground">{lead}</span>
        {children ? <span> · {children}</span> : null}
      </span>
      {action ? <BannerAction action={action} /> : null}
    </div>
  );
}

function BannerAction({ action }: { action: StatusBannerAction }) {
  // A claimed thumb target: the box grows under a finger and the negative
  // margin gives the height back.
  const chrome = cn(
    pillControlClass,
    "ms-auto text-xs text-muted-foreground hover:text-foreground motion-safe:transition-colors",
    "max-sm:-my-2.5 max-sm:inline-flex max-sm:items-center",
  );
  if (action.to) {
    return (
      <Link to={action.to} className={chrome}>
        {action.label} →
      </Link>
    );
  }
  return (
    <button type="button" onClick={action.onClick} className={chrome}>
      {action.label} →
    </button>
  );
}
