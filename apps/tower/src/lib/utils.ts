import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The type steps `index.css` adds to Tailwind's theme (`--text-*`): the TV's
 * ramp and its display steps, and the degraded mark's glyph. tailwind-merge
 * does not read the CSS theme, so a name it has never heard of — `text-wall-body`
 * — would be taken for a text COLOUR and dropped beside `text-muted-foreground`
 * (bead ro-trai.23). Listed here, each is a font SIZE, which conflicts only
 * with other sizes. `test/class-merge.test.ts` fails when `index.css` gains a
 * step this list does not name.
 */
export const THEME_TEXT_SIZES = [
  "wall-label",
  "wall-body",
  "wall-detail",
  "wall-micro",
  "wall-axis",
  "wall-stat",
  "wall-display",
  "wall-hero-sm",
  "wall-strip",
  "wall-strip-label",
  "wall-strip-countdown",
  "wall-strip-time",
  "wall-strip-brand",
  "wall-strip-emoji",
  "wall-list-label",
  "wall-list-line",
  "wall-list-meta",
  "wall-site-name",
  "wall-site-live",
  "wall-site-stat",
  "wall-site-label",
  "mark-degraded",
] as const;

const twMerge = extendTailwindMerge({ extend: { theme: { text: [...THEME_TEXT_SIZES] } } });

/** shadcn's class combiner: clsx for conditionals, tailwind-merge to dedupe. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
