import { useCallback, useState, useSyncExternalStore } from "react";
import { readStored, storageKey } from "@/lib/browser-storage";

export type Theme = "dark" | "light";

/** Where the operator's theme choice survives a reload. Namespaced so it cannot
 * collide with anything else this origin stores (lib/browser-storage). */
export const THEME_STORAGE_NAME = "theme";
export const THEME_STORAGE_KEY = storageKey(THEME_STORAGE_NAME);

/**
 * Dark is the product's default (the Wall theme, and what `src/index.css`
 * defines on `:root`); light is the opt-in. A browser that refuses storage —
 * private mode, a locked-down profile — must still render the app, so every
 * read and write is guarded and the failure mode is the default theme rather
 * than a blank screen.
 */
function storedTheme(): Theme {
  try {
    return readStored(window.localStorage, THEME_STORAGE_NAME) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/**
 * The operator's theme choice, as state plus its one mutation.
 *
 * This hook does NOT touch the document: `AppShell` owns applying the `.light`
 * class, because the class has to come OFF when the shell unmounts. `/wall`
 * renders outside the shell and its tokens assume dark (the TV is an emissive
 * surface — doc 14), so a light desk must never leak onto the television.
 */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(storedTheme);

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === "dark" ? "light" : "dark";
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // A choice that cannot be persisted still applies for this session.
      }
      return next;
    });
  }, []);

  return { theme, toggle };
}

/** The theme the page is drawn in: `.light` on `<html>`, which `AppShell` owns. */
function appliedTheme(): Theme {
  return document.documentElement.classList.contains("light") ? "light" : "dark";
}

function watchAppliedTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

/**
 * The theme the page is DRAWN in right now, for what renders outside
 * `AppShell` — the toaster (bead `ro-ujb9.117`). It reads the document, not
 * the stored choice, so it follows a toggle the moment the shell applies it,
 * with no second copy of the state to drift, and it stays dark wherever the
 * shell is not (the Wall).
 */
export function useAppliedTheme(): Theme {
  return useSyncExternalStore(watchAppliedTheme, appliedTheme, () => "dark");
}
