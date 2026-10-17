import type { CSSProperties } from "react";

/**
 * Where a drag will land, drawn before the drop: a line in the accent colour
 * and a short label on it ("Above Sites"). The caller draws it only where the
 * drop is allowed, so the line shows exactly what will happen and no refusal
 * is needed (docs/14-design.md, the TV editor). The TV editor's preview and
 * the Sites page's Arrange both draw this one line; each places it.
 */
export function DropLine({
  box,
  label,
  labelStyle,
  marks,
}: {
  /** The line's own box, inside a positioned parent. */
  box: CSSProperties;
  label: string;
  /** Where the label sits against the line. */
  labelStyle: CSSProperties;
  /** `data-*` attributes a test or a journey finds the line by. */
  marks?: Readonly<Record<`data-${string}`, string | undefined>>;
}) {
  return (
    <div aria-hidden {...marks} className="pointer-events-none absolute z-30 rounded-full bg-primary" style={box}>
      <span
        className="absolute whitespace-nowrap rounded-md bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground"
        style={labelStyle}
      >
        {label}
      </span>
    </div>
  );
}
