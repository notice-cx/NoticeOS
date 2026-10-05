import type { CommandPaletteProps } from "@/components/CommandPalette";
import { RouteLoadFailure } from "@/components/RouteLoading";
import { lazyPart } from "@/lib/lazy-route";

/**
 * THE COMMAND PALETTE ARRIVES WHEN IT IS FIRST OPENED (bead `ro-ujb9.84`).
 *
 * The palette — cmdk, its dialog and the lists — used to ride in the desk
 * shell's own file, so every desk page downloaded it before anybody pressed ⌘K.
 * The shell now holds only what has to exist before the first press: the
 * shortcut test below and the button. Everything else is this lazy part, which
 * the shell draws from the first open onward (`AppShell`'s `PaletteLauncher`).
 *
 * This file must stay free of cmdk: it is what the shell imports. The palette
 * module is reached only through the dynamic import below, and the props type
 * is a type-only import that the build erases.
 */

/**
 * ⌘K / Ctrl+K, and nothing else.
 *
 * A bare letter is deliberately NOT a shortcut. The desk is full of filter
 * inputs and a global single-key binding would eat what the operator is typing;
 * requiring the modifier IS the guard, which is why an input, textarea or
 * contenteditable needs no special case here — an unmodified keystroke never
 * reaches this test at all.
 */
export function isPaletteShortcut(event: KeyboardEvent): boolean {
  return (event.key === "k" || event.key === "K") && (event.metaKey || event.ctrlKey);
}

/**
 * The modifier on its own, pressed down: the moment before a possible ⌘K. The
 * shell fetches the palette's code here, so the K usually finds it already
 * downloaded; if it is some other shortcut, the cost is one small file, once.
 */
export function isPaletteModifier(event: KeyboardEvent): boolean {
  return event.key === "Meta" || event.key === "Control";
}

type PaletteProps = Pick<CommandPaletteProps, "open" | "onOpenChange">;

/**
 * What the palette becomes when its code is gone (a tab opened before a rebuild
 * or restart): the shared message and explicit new-tab action, in a box
 * where the palette would have been, shown only while the
 * operator has it open.
 */
function PaletteLoadFailure({ open, onOpenChange }: PaletteProps) {
  if (!open) return null;
  return <RouteLoadFailure surface="palette" onDismiss={() => onOpenChange(false)} />;
}

const palette = lazyPart<CommandPaletteProps>(
  () => import("@/components/CommandPalette").then((module) => module.CommandPalette),
  { failure: PaletteLoadFailure },
);

/** The palette itself, fetched the first time it is drawn. Draw it inside a
 * `<Suspense>`, and only once the operator has asked for it. */
export const LazyCommandPalette = palette.Component;

/** Fetch the palette's code without opening it: true once it is here. Never
 * rejects. */
export const preloadCommandPalette = palette.preload;
