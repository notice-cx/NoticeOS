import { Check } from "lucide-react";
import type { AssetStatus } from "@shared/asset-detail";
import { pillClass } from "@/components/ui/pill";
import { cn } from "@/lib/utils";

export interface StepperStep {
  key: string;
  label: string;
}

export interface StepperProps {
  steps: StepperStep[];
  /** Index of the current step. Steps before it read as done, after as upcoming.
   * -1 means the current state is off the happy path (see `terminal`). */
  activeIndex: number;
  /** A distinct terminal state off the happy path (e.g. "retired"): the whole
   * path renders muted and this chip carries the emphasis instead. */
  terminal?: { label: string } | null;
  className?: string;
}

/**
 * A horizontal lifecycle stepper (doc 15 principle 10: an asset's lifecycle
 * stage, made visible). Deliberately MONOCHROME — severity color is reserved for
 * needs-attention (doc 10 principle 3); progress is neutral. Done steps fill,
 * the current step gets a ring + bold label, upcoming steps stay muted. A
 * terminal state (retired) mutes the path and highlights its own chip.
 */
export function Stepper({ steps, activeIndex, terminal = null, className }: StepperProps) {
  const muted = terminal != null;
  return (
    <ol className={cn("flex flex-wrap items-center gap-1", className)}>
      {steps.map((step, i) => {
        const done = !muted && i < activeIndex;
        const current = !muted && i === activeIndex;
        return (
          <li key={step.key} className="flex items-center gap-1">
            {i > 0 ? (
              <span
                aria-hidden
                className={cn("h-px w-5", done || current ? "bg-foreground/40" : "bg-border")}
              />
            ) : null}
            <span
              aria-current={current ? "step" : undefined}
              /* The pill box from `ui/pill.ts` and DELIBERATELY NOT its control
                 contract (bead `ro-s4rg`): these are `<span>`s in an `<ol>`.
                 There is nothing to press, so nothing to fit a thumb and no
                 focus to ring — which is the answer to `ro-s4rg`'s observation
                 that the tab strip carries the phone floor and this does not.
                 Three states rather than two, so the pressed pair stays here. */
              className={cn(
                pillClass,
                "rounded-full px-2.5 font-medium",
                current && "border-foreground bg-foreground/10 text-foreground",
                done && "border-transparent bg-muted text-foreground",
                !done && !current && "border-border text-muted-foreground",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "inline-flex size-3.5 items-center justify-center rounded-full text-[9px]",
                  done && "bg-foreground text-background",
                  current && "border border-foreground",
                  !done && !current && "border border-border",
                )}
              >
                {done ? <Check className="size-2.5" /> : null}
              </span>
              {step.label}
            </span>
          </li>
        );
      })}
      {terminal ? (
        <li className="flex items-center gap-1">
          <span aria-hidden className="h-px w-5 bg-border" />
          <span
            aria-current="step"
            className={cn(
              pillClass,
              "rounded-full border-foreground bg-foreground/10 px-2.5 font-medium text-foreground",
            )}
          >
            {terminal.label}
          </span>
        </li>
      ) : null}
    </ol>
  );
}

/** The asset onboarding lifecycle (db/0001 assets.status), as a stepper spec.
 * `retired` is off the happy path — rendered as a distinct terminal chip. */
const LIFECYCLE: StepperStep[] = [
  { key: "pre-launch", label: "Pre-launch" },
  { key: "onboarding", label: "Onboarding" },
  { key: "baselining", label: "Baselining" },
  { key: "live", label: "Live" },
];

export function lifecycleStepper(status: AssetStatus): {
  steps: StepperStep[];
  activeIndex: number;
  terminal: { label: string } | null;
} {
  if (status === "retired") {
    return { steps: LIFECYCLE, activeIndex: -1, terminal: { label: "Retired" } };
  }
  return {
    steps: LIFECYCLE,
    activeIndex: LIFECYCLE.findIndex((s) => s.key === status),
    terminal: null,
  };
}
