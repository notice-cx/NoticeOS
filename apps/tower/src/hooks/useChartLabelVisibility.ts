import { useLayoutEffect, useState, type RefObject } from "react";

/** Fit measured date labels without changing the chart's domain or type size.
 * Hidden candidates retain their boxes so resize and font loading can restore
 * them. Endpoints take priority; on very narrow charts the latest date wins. */
export function useChartLabelVisibility(
  axisRef: RefObject<HTMLElement | null>,
  revision: string,
): readonly string[] | null {
  const [visible, setVisible] = useState<readonly string[] | null>(null);
  useLayoutEffect(() => {
    const axis = axisRef.current;
    if (!axis) return;
    const labels = [...axis.querySelectorAll<HTMLElement>("[data-chart-label-candidate]")];
    const measure = () => {
      const frame = axis.getBoundingClientRect();
      if (frame.width <= 0) {
        setVisible(null);
        return;
      }
      // Wall editor previews scale the whole canvas. Compare in the same
      // coordinate space so the preview and the full-size TV choose alike.
      const scale = axis.offsetWidth > 0 ? frame.width / axis.offsetWidth : 1;
      const gap = 8 * scale;
      const bounds = labels.map((node) => ({
        key: node.dataset.chartLabelCandidate!, box: node.getBoundingClientRect(),
      })).filter(({ box }) => box.left >= frame.left - 0.5 * scale
        && box.right <= frame.right + 0.5 * scale);
      const first = bounds[0];
      const last = bounds.at(-1);
      const next: string[] = [];
      if (first && last) {
        if (first === last || first.box.right + gap > last.box.left) {
          next.push(last.key);
        } else {
          next.push(first.key);
          let right = first.box.right;
          for (const candidate of bounds.slice(1, -1)) {
            if (candidate.box.left < right + gap
              || candidate.box.right > last.box.left - gap) continue;
            next.push(candidate.key);
            right = candidate.box.right;
          }
          next.push(last.key);
        }
      }
      setVisible((current) => current?.length === next.length
        && current.every((key, index) => key === next[index]) ? current : next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(axis);
    labels.forEach((label) => observer.observe(label));
    return () => observer.disconnect();
  }, [axisRef, revision]);
  return visible;
}
