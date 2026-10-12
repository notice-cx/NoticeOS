import { Lock } from "lucide-react";
import { type ReactNode, useId } from "react";
import { SectionLabel } from "@/components/surface/SectionLabel";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** `data-*` marks a caller hangs on the panel for its own tests and audits. */
type DataMarks = { [mark: `data-${string}`]: string | number | boolean | undefined };

/**
 * One group of settings on a Settings tab, in the shell a site's Settings tab
 * draws its groups in, so the two settings pages read alike: a quiet eyebrow
 * naming the group, an optional caption for its window or count, the end of
 * the row for a scope chip or the group's one action, then the rows, divided
 * by hairlines. The tab names the section, so nothing here repeats it.
 */
export function SettingsPanel({
  id,
  title,
  caption,
  aside,
  children,
  className,
  ...marks
}: {
  /** An anchor a link can land on (`#clock`, `#budget`). */
  id?: string;
  title: string;
  caption?: ReactNode;
  aside?: ReactNode;
  /** Absent for a panel whose whole content is its header's action. */
  children?: ReactNode;
  className?: string;
} & DataMarks) {
  const heading = useId();
  return (
    <Card
      id={id}
      role="region"
      aria-labelledby={heading}
      className={cn("flex scroll-mt-4 flex-col", className)}
      {...marks}
    >
      <SectionLabel id={heading} title={title} caption={caption} className={cn("px-4 pt-3", children ? "pb-2" : "items-center pb-3")}>
        {aside}
      </SectionLabel>
      {children ? <div className="flex min-w-0 flex-col px-4 pb-4">{children}</div> : null}
    </Card>
  );
}

/** A panel's saves-paused state, at the end of its header, for an editor whose
 * own heading the panel replaces. The page says why once (`SavesPaused`); the
 * panel shows the state as a lock, and says it to a screen reader. */
export function PanelLock(marks: DataMarks) {
  return (
    <span className="inline-flex items-center text-muted-foreground" {...marks}>
      <Lock aria-hidden className="size-3.5" />
      <span className="sr-only">Saves paused</span>
    </span>
  );
}
