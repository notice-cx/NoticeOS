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
 * The eyebrow's TYPE, for the two places the eyebrow is a label inside a
 * control rather than a section's heading (bead `ro-78qo.39`): the panel
 * toggles on /financials and /health, where the header IS the button, and an
 * `<h2>` inside a `<button>` is not markup a browser accepts. Everywhere else
 * renders `SectionLabel` itself. Exported as a class the way `pillControlClass`
 * is, so the type is declared once whichever of the two shapes needs it.
 */
export const eyebrowClass =
  "text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground";

export interface SectionLabelProps {
  /** One or two words. The section's question is the page's; this names the
   * section. */
  title: string;
  /** One sentence at most, and about what the section IS — never how it works.
   * The mechanics belong in `About`. A panel's quiet count sits here too. */
  caption?: ReactNode;
  /** The section's one link out, doc 21's "All →". */
  action?: SectionLabelAction;
  /** Goes on the HEADING, not the row: a section that labels itself with
   * `aria-labelledby` must point at the title, not at the title plus the
   * caption plus the link. Also what a tab bar or a skip link anchors to. */
  id?: string;
  /** The end of the row when what belongs there is NOT a link — the owner chip
   * on a Settings or Sources panel is the standing case (doc 21 keeps chips to
   * those two surfaces). A caller passing both gets the link first. */
  children?: ReactNode;
  className?: string;
}

/**
 * THE EYEBROW EVERY DOC 21 SECTION OPENS WITH — AND THE DESK'S ONLY ONE.
 *
 * The mockup's `.section-lbl`: an 11px tracked uppercase title, one quiet
 * caption of at most a sentence saying what the section is, and, at the right, a
 * link that takes the question somewhere else. It replaces `SectionCard`'s
 * header — a card per section, each with a title, a paragraph and a chip, is the
 * shape doc 21 exists to end.
 *
 * *Registry justification (beads `ro-78qo.27`, `ro-78qo.33`):* it was built
 * beside the two asset tabs that first needed it, because two callers in one
 * folder is layout rather than vocabulary. Home's assets panel is the third
 * caller and the mockup puts the same header on every index page — at which
 * point a second local copy is the exact near-duplicate the registry exists to
 * prevent. `ListPanel` drew the same three parts as its own header and now
 * COMPOSES this one, so the product has a single eyebrow: the panel supplies
 * its card's padding through `className`, its quiet count through `caption` and
 * its "All →" through `action`, and its own props did not change.
 *
 * The caption is `tabular-nums` because most of them carry a count or a date,
 * and doc 21 asks for tabular digits wherever numbers align.
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
  // 16px of text against a 44px thumb: the target is CLAIMED from the row
  // rather than added to it (`OwnerChip`'s pattern, bead `ro-9smi`), so an
  // eyebrow row stays 24px on the desk and every phone press still lands on 44.
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
