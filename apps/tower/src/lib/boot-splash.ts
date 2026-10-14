import { useContext, useEffect } from "react";
import { QueryClientContext, type QueryClient } from "@tanstack/react-query";

/**
 * The boot splash: the Notice lockup that `index.html` draws over the app
 * before any script runs (its markup and style are there, so they apply before
 * the app's stylesheet arrives). It stays up while the session is checked and
 * the first screen's code and first reads arrive, then fades out over the
 * drawn screen. It never takes a click (`pointer-events: none`), so a fast
 * hand or a test can use the screen under it.
 *
 * Every way down goes through `dismissBootSplash`, which acts once.
 */
export const BOOT_SPLASH_ID = "boot-splash";

/** The fade `index.html` gives the splash on its way out (`[data-leaving]`). */
export const BOOT_SPLASH_FADE_MS = 240;

/** How long the first screen's reads may hold the splash after the screen
 * mounts. A slow or polling read is then drawn in the screen's own loading
 * state rather than behind the splash. */
export const BOOT_SPLASH_SETTLE_CAP_MS = 2_500;

/** No read in flight for this long counts as settled, so a read that starts
 * another when it lands (a dependent query) holds the splash through the gap. */
export const BOOT_SPLASH_QUIET_MS = 100;

/** The longest the splash covers the app, whatever else happens. */
export const BOOT_SPLASH_SAFETY_MS = 8_000;

/** Fade the splash out and remove it. Does nothing when it is gone or going. */
export function dismissBootSplash(doc: Document = document): void {
  const splash = doc.getElementById(BOOT_SPLASH_ID);
  if (!splash || splash.hasAttribute("data-leaving")) return;
  splash.setAttribute("data-leaving", "");
  setTimeout(() => splash.remove(), BOOT_SPLASH_FADE_MS);
}

/** The part of a QueryClient the splash reads. */
export type BootReads = Pick<QueryClient, "isFetching" | "getQueryCache">;

/**
 * Dismiss the splash once `reads` have nothing in flight, or after
 * `BOOT_SPLASH_SETTLE_CAP_MS` at most; with no client, at once. Call it when
 * the first screen has mounted: its reads have started by then. Returns a
 * cancel.
 */
export function dismissBootSplashWhenSettled(
  reads: BootReads | undefined,
  doc: Document = document,
): () => void {
  if (!doc.getElementById(BOOT_SPLASH_ID)) return () => {};
  if (!reads) {
    dismissBootSplash(doc);
    return () => {};
  }
  let quiet: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe = () => {};
  const cancel = () => {
    unsubscribe();
    clearTimeout(cap);
    clearTimeout(quiet);
  };
  const done = () => {
    cancel();
    dismissBootSplash(doc);
  };
  const check = () => {
    if (reads.isFetching() > 0) {
      clearTimeout(quiet);
      quiet = undefined;
    } else {
      quiet ??= setTimeout(done, BOOT_SPLASH_QUIET_MS);
    }
  };
  const cap = setTimeout(done, BOOT_SPLASH_SETTLE_CAP_MS);
  unsubscribe = reads.getQueryCache().subscribe(check);
  check();
  return cancel;
}

/** Start the safety limit; `main.tsx` calls it once, before the first render. */
export function armBootSplash(doc: Document = document): () => void {
  const timer = setTimeout(() => dismissBootSplash(doc), BOOT_SPLASH_SAFETY_MS);
  return () => clearTimeout(timer);
}

/**
 * For the root of a screen (the desk's shell, the Wall): once it has mounted,
 * dismiss the splash when its first reads settle. Outside a QueryClient
 * provider (a test drawing the shell alone) it dismisses at once.
 */
export function useBootSplashRelease(): void {
  const reads = useContext(QueryClientContext);
  useEffect(() => dismissBootSplashWhenSettled(reads), [reads]);
}

/** For a screen with nothing to wait for (sign-in, a failure): dismiss on mount. */
export function BootSplashDismiss(): null {
  useEffect(() => dismissBootSplash(), []);
  return null;
}
