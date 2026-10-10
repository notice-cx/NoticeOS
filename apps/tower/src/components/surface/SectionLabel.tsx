import { type ReactNode } from "react";
import { Link } from "react-router-dom";
import { pillControlClass } from "@/components/ui/pill";
import { cn } from "@/lib/utils";

export interface SectionLabelAction {
  /** The words, arrow included — the caller says where it goes, so a panel's
   * "All →" and a section's "Queries, pages and the tracked panel →" are the
   * same slot rather than two conventions. */
  label: string;
  to?: string;
  onClick?: () => void;
}

/**
 * The eyebrow's type, for an eyebrow that is a label inside a control (a
 * panel toggle whose header is the button, where an `<h2>` is not allowed).
 * Everywhere else renders `SectionLabel` itself.
 */
export const eyebrowClass =
  "text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground";

export interface SectionLabelProps {
  /** One or two words. The section's question is the page's; this names the
   * section. */
  title: string;
  /** One sentence at most, and about what the section is — never how it works.
   * The mechanics belong in `About`. A panel's quiet count sits here too. */
  caption?: ReactNode;
  /** The section's one link out, "All →". */
  action?: SectionLabelAction;
  /** Goes on the heading, not the row: a section that labels itself with
   * `aria-labelledby` must point at the title, not at the title plus the
   * caption plus the link. Also what a tab bar or a skip link anchors to. */
  id?: string;
  /** The end of the row when what belongs there is not a link (an owner chip
   * on a Settings or Sources panel). A caller passing both gets the link first. */
  children?: ReactNode;
  className?: string;
}

/**
 * The desk's one section eyebrow: an 11px tracked uppercase title, one quiet
 * caption saying what the section is, and a link at the right that takes the
 * question elsewhere. `ListPanel` composes it as its header.
 */
export function SectionLabel({
  title,
  caption,
  action,
  id,
  children,
  className,
}: SectionLabelProps) {
  return (
    <div className={cn("flex flex-wrap items-baseline gap-x-2.5 gap-y-1", className)}>
      <h2 id={id} className={cn("m-0", eyebrowClass)}>
        {title}
      </h2>
      {caption ? (
        <span className="min-w-0 text-xs tabular-nums text-muted-foreground">{caption}</span>
      ) : null}
      {action ? <SectionAction action={action} /> : null}
      {children ? (
        <span className={cn("flex items-center gap-2", !action && "ms-auto")}>{children}</span>
      ) : null}
    </div>
  );
}

function SectionAction({ action }: { action: SectionLabelAction }) {
  // The 44px phone target is claimed from the row rather than added to it, so
  // the eyebrow row keeps its height.
  const chrome = cn(
    "ms-auto text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline",
    pillControlClass,
    "max-sm:-my-2.5 max-sm:inline-flex max-sm:items-center",
    "motion-safe:transition-colors",
  );
  if (action.to) {
    return (
      <Link to={action.to} className={chrome}>
        {action.label}
      </Link>
    );
  }
  return (
    <button type="button" onClick={action.onClick} className={chrome}>
      {action.label}
    </button>
  );
}
