import { cn } from "@/lib/utils";

/**
 * THE DESK'S TOGGLE-PILL CHROME, DECLARED ONCE (bead `ro-s4rg`).
 *
 * Eight hand-rolled toggles on this desk are not `<Button>` and never were —
 * /settings' replay asset picker and replay rule picker, the asset wizard's
 * segmented choices, the /assets and /work filter rows, the knob editor's
 * segmented control, the lifecycle stepper's chips and the tab strip. Each
 * wrote its own box, its own focus ring and its own pressed state, and the
 * copies were kept in step by hand: bead `ro-zmyq` added the phone thumb floor
 * to two of them, `ro-md80` had already put it on the tab strip, and the
 * wizard's, the two filter rows' and the knob editor's segments had none.
 * Nothing was broken — every one was at or above the floor on the routes those
 * beads measured — which is exactly why the next phone sweep would have found
 * whichever one it missed. The bead named six of the eight; the other two are
 * what a grep for the literal turns up, which is the argument for the guard
 * beside this file rather than for a longer list in a bead.
 *
 * This is the shape `ro-2qc6` used for field chrome, applied to the other
 * family of copies.
 *
 * FIVE EXPORTS, BECAUSE THE EIGHT SHARE FOUR DIFFERENT AMOUNTS. One string
 * would have to be cancelled at half its call sites, and a class you override
 * to nothing is worse than the literal it replaced:
 *
 *   - `pillControlClass` is the CONTROL CONTRACT — no native outline, a visible
 *     focus ring, a 44px box under a thumb. Every one of the eight a person can
 *     press reads it, whatever shape it draws. The tab strip is not a pill and
 *     takes only this.
 *   - `pillClass` is the BOX. The pill-shaped ones read it; the knob editor's
 *     segments do not, because their box belongs to the container they sit
 *     inside and a segment that re-declared a border would draw a second one.
 *   - `pillPickerStateClass` is the pair the bead describes — "a pressed state
 *     that swaps `border-transparent` for `border-border` plus
 *     `bg-foreground/10`, and an unpressed `hover:bg-muted`". A PICKER: the row
 *     is chrome until you look at it, so only the picked one has edges.
 *   - `pillChoiceClass` + `pillChoiceStateClass` are the other dialect, carried
 *     verbatim by three call sites. A CHOICE, not a picker: every option keeps
 *     its border so the row reads as a row of options before anything is
 *     picked, the selected one fills instead, and every option is bold so a
 *     click cannot reflow the row.
 *
 * TWO PAIRS AND NOT ONE, deliberately. Folding them together would be a visual
 * change dressed as consolidation — and the remaining three toggles each mean a
 * third thing by pressed (a stepper has three states rather than two, a tab
 * underlines, a toned knob segment paints the state's own meaning color), which
 * is why their states stay where they are drawn.
 *
 * THE STEPPER READS THE BOX AND NOT THE CONTRACT, also deliberately. Its chips
 * are `<span>`s in an `<ol>`: nothing to press, so nothing to fit a thumb and
 * no focus to ring. `ro-s4rg` names it as the one with no phone floor; the
 * answer is that it is not a control, and saying so in code is what keeps the
 * next sweep from adding one.
 *
 * STRINGS AND TWO PREDICATES, NOT A COMPONENT and not a `cva`, for the reasons
 * `./field.ts` writes down at length: the call sites are buttons and spans with
 * different prop shapes and `data-*` hooks their own tests select on, and a
 * variant per axis is the same eight strings with a keyword in front of each.
 * Callers vary the box through `cn(pillClass, …)` — tailwind-merge drops what
 * conflicts, so the axes that genuinely differ compose without a copy:
 *
 *   - shape:   `cn(pillClass, "rounded-full px-2.5")` — the stepper
 *   - weight:  `cn(pillClass, "font-medium")` when every state is bold
 *   - motion:  `cn(pillClass, "transition-colors")`
 *
 * A `.ts` and not a `.tsx`, which is what keeps it out of the component
 * registry honestly — `scripts/component-registry.test.mjs` walks `.tsx` files
 * because those render something, and this renders nothing.
 *
 * `test/pill-chrome.test.ts` fails if the literal reappears anywhere in src/.
 */

/**
 * What a hand-rolled toggle owes a person: no native outline, a ring it can be
 * found by, and 44px under a thumb. `max-sm:` only, so the desk's density is
 * untouched. Read by every pressable one of the eight — including the tab
 * strip, whose box is nothing like a pill's.
 */
export const pillControlClass =
  "outline-none max-sm:min-h-11 focus-visible:ring-[3px] focus-visible:ring-ring";

/**
 * The pill box itself. No color: the border's COLOR is state (see the two
 * state pairs below), only its width is chrome.
 */
export const pillClass = "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs";

/**
 * A PICKER's pressed/unpressed pair — /settings' two replay rows. Picked takes
 * the brand accent and tinted surface; unpicked keeps the
 * same box, spends its border on nothing, and answers a hover.
 */
export function pillPickerStateClass(picked: boolean): string {
  return picked
    ? "border-primary/30 bg-accent-soft font-medium text-primary"
    : "border-transparent text-muted-foreground hover:bg-muted";
}

/**
 * A CHOICE's box: rounder, roomier, always bold, and it moves. Composed rather
 * than written out, so the box and the contract still have one home — `cn`
 * resolves `rounded-md`/`px-2` against the shape below exactly as it does at a
 * call site.
 */
export const pillChoiceClass = cn(
  pillClass,
  pillControlClass,
  "whitespace-nowrap rounded-full px-2.5 font-medium transition-colors",
);

/**
 * A CHOICE's selected/unselected pair — the asset wizard's segmented choices
 * and the /assets and /work filter rows. Every option keeps a border, so the
 * row reads as a row of options before anything is chosen; the selected one
 * fills and quiets its own edge rather than being the only one to have one.
 */
export function pillChoiceStateClass(selected: boolean): string {
  return selected
    ? "border-primary/30 bg-accent-soft text-primary"
    : "border-border text-muted-foreground hover:bg-muted/60";
}
