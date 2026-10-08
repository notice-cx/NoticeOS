import { useEffect } from "react";
import { useDemoReadonly } from "@/lib/browser-context";

const PRODUCT = "NoticeOS";
/** The title the page shipped with (index.html, or the demo's head): Home
 * keeps it, because it describes the product rather than one screen. */
const shipped = typeof document === "undefined" ? PRODUCT : document.title;

/** What a tab, a bookmark, history and a search result call this page: its
 * own heading, then the product. The demo says it is one. */
export function documentTitle(page: string | null, demo: boolean): string {
  if (page === null) return shipped;
  return `${page} · ${demo ? `${PRODUCT} demo` : PRODUCT}`;
}

export function useDocumentTitle(page: string | null): void {
  const demo = useDemoReadonly();
  useEffect(() => {
    document.title = documentTitle(page, demo);
  }, [page, demo]);
}
