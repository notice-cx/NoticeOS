/**
 * THE DESK'S FIELD CHROME, DECLARED ONCE (bead `ro-2qc6`).
 *
 * Every `<input>`, `<select>` and `<textarea>` an operator types into on the
 * desk wears this box. It existed as ~28 literal copies across 13 files —
 * three of them as a route-local `SELECT_CLASS` whose comment said it was "the
 * same string /alerts, /assets and /settings carry". A comment is not a
 * mechanism: keeping them identical was manual, and bead `ro-md80` had to add
 * one utility (`max-sm:min-h-11`, the phone thumb floor) to all of them at once
 * by scripted replace, because editing some and not others would have left the
 * desk with two field heights on a phone for no reason a reader could see.
 *
 * A STRING, NOT A COMPONENT, and not a `cva` either. The call sites are three
 * different elements with three different prop shapes, half of them carrying
 * `data-*` hooks their own tests select on; a `<Field>` wrapper would have to
 * forward all of that, and a `cva` would need a variant for every axis below —
 * which is the same eighteen strings with a keyword in front of each. What is
 * actually shared is one box, so one box is what is declared. `buttonVariants`
 * beside this file is the precedent for chrome exported as classes.
 *
 * HOW A CALL SITE VARIES IT: `cn(fieldClass, …)`. tailwind-merge drops the
 * class it conflicts with, so the four axes that genuinely differ compose
 * without a second copy of the base —
 *
 *   - width:      `cn(fieldClass, "w-full")`, `"w-64 max-w-full"`, `"min-w-0 flex-1"`
 *   - type:       `cn(fieldClass, "font-mono text-xs")`, `"text-xs tabular-nums"`
 *   - room:       `cn(fieldClass, "py-1.5")` for a full-width composer field
 *   - validity:   `cn(fieldClass, error ? "border-error" : null)`
 *
 * THE PHONE FLOOR AND THE DISABLED DIM ARE IN THE BASE, deliberately. Both were
 * present on most copies and missing from a handful, and in both cases the
 * handful was drift rather than a decision — a field an operator cannot hit on
 * a phone, or one that stays bright while its Save is in flight, is a defect
 * wherever it appears. `max-sm:` only, so the desk's density is untouched.
 *
 * A `.ts` and not a `.tsx`, which is also what keeps it out of the component
 * registry honestly: `scripts/component-registry.test.mjs` walks `.tsx` files
 * because those are the ones that render something, and this renders nothing.
 * REGISTRY.md carries its row anyway, beside the primitives it dresses.
 *
 * `test/field-chrome.test.ts` fails if the literal reappears anywhere in src/.
 */
export const fieldClass =
  "rounded-md border border-input bg-background px-2 py-1 text-sm outline-none max-sm:min-h-11 focus-visible:ring-[3px] focus-visible:ring-ring disabled:opacity-60";
