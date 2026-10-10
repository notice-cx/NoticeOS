import type { ReactNode } from "react";
import { eyebrowClass } from "@/components/surface/SectionLabel";
import { cn } from "@/lib/utils";

/**
 * A screen's one answer, first: one sentence at the display scale ("1 of 7
 * sites at risk"), a muted line under it, and at most three figures beside it,
 * each an eyebrow over a number. The sentence stays under twelve words (the UX
 * gate measures it).
 */
export interface AnswerFigure {
  label: string;
  value: string;
  /** A short unit or direction after the value: "est.", "↑ 12%". */
  note?: string;
  /** A token class for the value's ink (`text-financial-revenue`), never a hex. */
  tone?: string;
  /** A `data-*` hook for tests and the audit. */
  mark?: string;
}

export interface PageAnswerProps {
  /** The heading's id, for a section's `aria-labelledby`. */
  id?: string;
  /** The one sentence. */
  answer: ReactNode;
  /** Drawn before the sentence: a `StateChip` or a severity dot, when the
   * answer is a verdict with a colour. */
  mark?: ReactNode;
  /** One muted line under the sentence: when, since, what it counts. */
  detail?: ReactNode;
  /** At most three. */
  figures?: readonly AnswerFigure[];
  /** Anything that belongs at the line's end instead of figures (a range). */
  aside?: ReactNode;
  className?: string;
  /** `data-*` marks on the answer's root. */
  marks?: Record<`data-${string}`, string>;
}

export function PageAnswer({ id, answer, mark, detail, figures = [], aside, className, marks }: PageAnswerProps) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-x-6 gap-y-3", className)} data-page-answer="" {...marks}>
      <div className="flex min-w-0 flex-col gap-1">
        <h2 id={id} className="m-0 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[26px] font-bold leading-[1.1] tracking-[-0.03em] text-foreground max-sm:text-[22px]">
          {mark}
          <span className="min-w-0 [overflow-wrap:anywhere]">{answer}</span>
        </h2>
        {detail ? <span className="text-[13px] tabular-nums text-muted-foreground" data-page-answer-detail="">{detail}</span> : null}
      </div>
      {figures.length > 0 ? (
        <dl className="m-0 flex flex-wrap gap-x-6 gap-y-2 tabular-nums" data-page-answer-figures="">
          {figures.slice(0, 3).map((figure) => (
            <div key={figure.label} className="flex flex-col gap-0.5" {...(figure.mark ? { [`data-${figure.mark}`]: "" } : {})}>
              <dt className={eyebrowClass}>{figure.label}</dt>
              <dd className={cn("m-0 text-[22px] font-semibold leading-none tracking-[-0.02em]", figure.tone ?? "text-foreground")}>
                {figure.value}
                {figure.note ? <span className="ms-1.5 text-xs font-medium text-muted-foreground">{figure.note}</span> : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {aside}
    </div>
  );
}
