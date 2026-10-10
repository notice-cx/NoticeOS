import { cn } from "@/lib/utils";

/**
 * The desk's hand-rolled toggle chrome, declared once as strings (the call
 * sites are buttons and spans with different props):
 *
 *   - `pillControlClass`: the control contract every pressable toggle reads,
 *     including the tab strip, which is not a pill.
 *   - `pillClass`: the box. Knob-editor segments skip it because their
 *     container draws the border.
 *   - `pillPickerStateClass`: a picker, where only the picked option has edges.
 *   - `pillChoiceClass` + `pillChoiceStateClass`: a choice row, where every
 *     option keeps its border and is bold so a click cannot reflow the row.
 *
 * The lifecycle stepper reads the box but not the contract: its chips are not
 * controls. Vary the box with `cn(pillClass, …)`.
 * `test/pill-chrome.test.ts` fails if the literal reappears in src/.
 */

/** No native outline, a visible focus ring, and 44px under a thumb (below `sm` only). */
export const pillControlClass =
  "outline-none max-sm:min-h-11 focus-visible:ring-[3px] focus-visible:ring-ring";

/** The pill box. No colour: the border's colour is state. */
export const pillClass = "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs";

/** A picker's pressed pair: picked takes the accent, unpicked has no edge and answers a hover. */
export function pillPickerStateClass(picked: boolean): string {
  return picked
    ? "border-primary/30 bg-accent-soft font-medium text-primary"
    : "border-transparent text-muted-foreground hover:bg-muted";
}

/** A choice's box: rounder, roomier, always bold. */
export const pillChoiceClass = cn(
  pillClass,
  pillControlClass,
  "whitespace-nowrap rounded-full px-2.5 font-medium transition-colors",
);

/** A choice's selected pair: every option keeps a border; the selected one fills. */
export function pillChoiceStateClass(selected: boolean): string {
  return selected
    ? "border-primary/30 bg-accent-soft text-primary"
    : "border-border text-muted-foreground hover:bg-muted/60";
}
