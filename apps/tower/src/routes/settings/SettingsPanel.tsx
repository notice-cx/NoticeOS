import { Lock } from "lucide-react";
import { type ReactNode } from "react";
import { Panel, type PanelDataMarks } from "@/components/surface/Panel";
import { cn } from "@/lib/utils";

/** Portfolio Settings' prop names and stacked rows on the shared panel shell. */
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
} & PanelDataMarks) {
  return (
    <Panel
      id={id}
      title={title}
      count={caption}
      action={aside}
      bodyLayout="stack"
      className={cn("text-card-foreground", className)}
      {...marks}
    >
      {children}
    </Panel>
  );
}

/** A panel's saves-paused state, at the end of its header, for an editor whose
 * own heading the panel replaces. The page says why once (`SavesPaused`); the
 * panel shows the state as a lock, and says it to a screen reader. */
export function PanelLock(marks: PanelDataMarks) {
  return (
    <span className="inline-flex items-center text-muted-foreground" {...marks}>
      <Lock aria-hidden className="size-3.5" />
      <span className="sr-only">Saves paused</span>
    </span>
  );
}
