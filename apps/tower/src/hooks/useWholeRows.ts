import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * How many leading children of `list` fit inside its box whole; Infinity when
 * all do. The caller hides the rest, so a TV never shows half a row. Measured
 * again whenever the list or any row changes size.
 */
export function useWholeRows(list: RefObject<HTMLElement | null>, rows: readonly unknown[]): number {
  const [fit, setFit] = useState<number>(Infinity);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    const measure = () => {
      const bottom = element.getBoundingClientRect().bottom;
      const children = [...element.children] as HTMLElement[];
      const cut = children.findIndex((child) => child.getBoundingClientRect().bottom > bottom + 0.5);
      setFit(cut === -1 ? Infinity : cut);
    };
    measure();
    // The list and every row: a row that grows after this effect (an arriving
    // feed row opens its height over 240 ms) pushes the rows below it down.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [list, rows]);
  return fit;
}
