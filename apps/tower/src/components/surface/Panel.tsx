import { type ReactNode, useId } from "react";
import { SectionLabel } from "@/components/surface/SectionLabel";
import { cn } from "@/lib/utils";

/** Marks owned by a panel's caller, for its tests and audits. */
export type PanelDataMarks = {
  [mark: `data-${string}`]: string | number | boolean | undefined;
};

export interface PanelProps extends PanelDataMarks {
  title: string;
  /** A count, age or short caption beside the heading. */
  count?: ReactNode;
  /** A scope chip, control or link at the end of the header. */
  action?: ReactNode;
  /** The section anchor; the accessible name points to its heading alone. */
  id?: string;
  /** Absent when the header's action is the whole panel. */
  children?: ReactNode;
  className?: string;
  /** Settings rows stack; other content retains normal block flow. */
  bodyLayout?: "block" | "stack";
}

/** A non-list section with the same header and spacing on both settings pages. */
export function Panel({
  title,
  count,
  action,
  id,
  children,
  className,
  bodyLayout = "block",
  ...marks
}: PanelProps) {
  const heading = useId();
  return (
    <section
      id={id}
      aria-labelledby={heading}
      className={cn("flex scroll-mt-4 flex-col rounded-[10px] border border-border bg-card", className)}
      {...marks}
    >
      <SectionLabel
        id={heading}
        title={title}
        caption={count}
        className={cn("px-4 pt-3", children ? "pb-2" : "items-center pb-3")}
      >
        {action}
      </SectionLabel>
      {children ? (
        <div className={cn("px-4 pb-4", bodyLayout === "stack" && "flex min-w-0 flex-col")}>
          {children}
        </div>
      ) : null}
    </section>
  );
}
