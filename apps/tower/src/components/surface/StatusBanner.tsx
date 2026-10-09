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
  /** The banner exists only while its state is open. `false` renders NOTHING —
   * not a collapsed strip, not a dismissed placeholder — because doc 14's
   * contract is that it "disappears when it closes". */
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
 * ONE LINE, WHILE SOMETHING IS OPEN (doc 14).
 *
 * *Registry justification:* it replaces the asset page's Setup checklist
 * SECTION — a full card with a heading, a paragraph and a list of steps sitting
 * above the charts on every visit, long after the operator had read it. The
 * checklist itself keeps its home on Sources; what belongs at the top of a view
 * surface is the one line that says the asset is still being set up and where to
 * finish. It draws no severity colour of its own: the mark carries the state and
 * the sentence carries the fact, so a banner cannot become a fifth alarm colour
 * competing with the real alerts under it.
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
  // The same claimed thumb target the panel headers use (bead `ro-9smi`): the
  // box grows under a finger, the negative margin gives the height back.
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
