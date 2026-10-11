/// <reference lib="dom" />
// wall-fit-measure.mts — what "does the Wall fit the TV?" measures, as one
// function a page runs.
//
// `pnpm audit:wall-fit` (scripts/wall-fit-check.mjs) runs it in a local Chrome
// against a live or fixture Tower; the Wall journeys in
// apps/tower/e2e/journeys.spec.ts run it in Playwright against the isolated
// fixture at every site count the contract budgets for (docs/14-design.md
// § Budget), so CI fails the day the Wall stops fitting 1920×1080. Both
// read this one function and `wallFitVerdict`, so the operator's tool and the
// gate can never disagree about what "fits" means.
//
// `measureWallFit` is serialized into the page (Playwright's evaluate, or the
// DevTools protocol's), so it must stay SELF-CONTAINED: no imports, no names
// from this module's scope, every helper declared inside it.
//
// What it measures, and why each (the long form is scripts/README.md § audit:wall-fit):
//   1. every element box under .wall-root — a region stacked past the fold;
//   2. every text run, through Range rects — glyph overflow, which moves no box;
//   3. .wall-root's own scroll size — what its 100vh clip hides;
//   4. unclipped ink overflow inside the Wall — the same bug one site from the edge;
//   5. text a region CUTS OFF sideways — a clip that hides a figure is no fix.
// Overflow an ancestor inside the Wall clips is not a leak; the wall-root clip
// itself is deliberately not applied, because making it unnecessary is the point.
// Then the budget: each region's box, each site row's height, the spare
// height under the rows, and whether the feed draws only whole rows.

export interface WallFitBox {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

export interface WallFitOffender {
  kind: string;
  el: string;
  by: number;
  right?: number;
  bottom?: number;
  text: string;
}

export interface WallFitLeak {
  el: string;
  axis: "x" | "y";
  delta: number;
  text: string;
}

export interface WallFitMeasurement {
  viewport: { width: number; height: number };
  tvMediaQuery: boolean;
  /** Which Wall the screen drew (`wallScreen`): the TV's layout or the
   * one-column stack, and the TV layout's scale — 1 on the TV, about 0.77 on
   * a 13-inch laptop. */
  layout: string | null;
  scale: number;
  rootClipped: boolean;
  /** How far content reaches, clip or no clip. */
  content: { right: number; bottom: number };
  /** The furthest edge anything actually paints. */
  tight: { right: number; bottom: number };
  worst: { x: WallFitOffender | null; y: WallFitOffender | null };
  offenders: { x: WallFitOffender[]; y: WallFitOffender[] };
  ink: WallFitLeak[];
  clipped: WallFitLeak[];
  /** The regions, where the Wall draws them. */
  regions: Record<"strip" | "revenue" | "needs" | "sites" | "feed", WallFitBox | null>;
  /** The site region: its tier, each row's height, and the height left under
   * the last row (null in the one-site tier, which draws tiles, not rows). */
  sites: { density: string | null; rows: { id: string; height: number }[]; spare: number | null };
  /** The feed: rows drawn, and whether the lowest one ends inside the column. */
  feed: { shown: number; lastRowWhole: boolean | null };
  counts: { elements: number; overX: number; overY: number; ink: number; clipped: number };
}

export function measureWallFit(): WallFitMeasurement | { error: string } {
  const TOLERANCE = 1;
  const root = document.querySelector(".wall-root");
  if (!root) return { error: "no .wall-root on the page" };
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const scrollLeft = window.scrollX;
  const scrollTop = window.scrollY;
  const round = (value: number) => Math.round(value * 10) / 10;
  const squash = (text: string | null) => (text ?? "").trim().replace(/\s+/g, " ");
  /* A laptop draws the TV's layout zoomed: an element's
   * rects are the screen's pixels, its own sizes (scroll, client, borders)
   * its own, which are the screen's over this zoom. */
  const zoomOf = (el: Element) => (el as Element & { currentCSSZoom?: number }).currentCSSZoom ?? 1;

  const describe = (el: Element) => {
    let out = el.tagName.toLowerCase();
    if (el.id) out += "#" + el.id;
    else if (el.classList.length) out += "." + [...el.classList].slice(0, 3).join(".");
    for (const attribute of el.attributes) {
      if (attribute.name.startsWith("data-")) {
        out += "[" + attribute.name + (attribute.value ? "=" + attribute.value.slice(0, 40) : "") + "]";
        break;
      }
    }
    return out;
  };
  const chain = (el: Element) => {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== root && parts.length < 4) {
      parts.unshift(describe(node));
      node = node.parentElement;
    }
    return parts.join(" > ");
  };

  /* Clipping happens at the padding box, so that is the rect to intersect. */
  const paddingBox = (el: Element) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const zoom = zoomOf(el);
    return {
      left: rect.left + parseFloat(style.borderLeftWidth || "0") * zoom,
      right: rect.right - parseFloat(style.borderRightWidth || "0") * zoom,
      top: rect.top + parseFloat(style.borderTopWidth || "0") * zoom,
      bottom: rect.bottom - parseFloat(style.borderBottomWidth || "0") * zoom,
    };
  };

  /* What of this rect actually PAINTS, given every clipping ancestor below the
   * wall root; null when an ancestor hides it completely. */
  const visiblePart = (rect: DOMRect, fromElement: Element) => {
    let left = rect.left, right = rect.right, top = rect.top, bottom = rect.bottom;
    for (let node: Element | null = fromElement; node && node !== root; node = node.parentElement) {
      const style = getComputedStyle(node);
      const clipsX = style.overflowX !== "visible";
      const clipsY = style.overflowY !== "visible";
      if (!clipsX && !clipsY) continue;
      const box = paddingBox(node);
      if (clipsX) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
      if (clipsY) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
      if (right - left <= 0 || bottom - top <= 0) return null;
    }
    return { left, right, top, bottom };
  };

  const overX: WallFitOffender[] = [];
  const overY: WallFitOffender[] = [];
  /* The furthest edge anything PAINTS: .wall-root's scrollHeight never drops
   * below its own 100vh, so it shows a fit but never by how much. */
  const tight = { right: 0, bottom: 0 };
  const consider = (rect: DOMRect, fromElement: Element, kind: string, text: string) => {
    const painted = visiblePart(rect, fromElement);
    if (!painted) return;
    const right = painted.right + scrollLeft;
    const bottom = painted.bottom + scrollTop;
    tight.right = Math.max(tight.right, right);
    tight.bottom = Math.max(tight.bottom, bottom);
    if (right > vw + TOLERANCE) overX.push({ kind, el: chain(fromElement), right: round(right), by: round(right - vw), text: text.slice(0, 48) });
    if (bottom > vh + TOLERANCE) overY.push({ kind, el: chain(fromElement), bottom: round(bottom), by: round(bottom - vh), text: text.slice(0, 48) });
  };

  /* 1 — element boxes. */
  const elements = [...root.querySelectorAll("*")];
  for (const el of elements) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    consider(rect, el, "box", squash(el.textContent));
  }

  /* 2 — text runs: a nowrap label paints outside its cell without changing
   * any element box; a Range over the text node reports where glyphs land. */
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const tag = node.parentElement ? node.parentElement.tagName.toLowerCase() : "";
      if (tag === "script" || tag === "style" || tag === "title") return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    range.selectNodeContents(node);
    const text = squash(node.nodeValue);
    for (const rect of range.getClientRects()) {
      if (rect.width === 0 && rect.height === 0) continue;
      consider(rect, node.parentElement!, "text", text);
    }
  }
  range.detach();

  /* 3 — the wall root's own content extent: the clipping box still reports
   * what it hides, which the document's scroll size cannot. */
  const rootRect = root.getBoundingClientRect();
  const rootStyle = getComputedStyle(root);
  const scale = zoomOf(root);
  const rootContentRight = rootRect.left + (parseFloat(rootStyle.borderLeftWidth || "0") + root.scrollWidth) * scale + scrollLeft;
  const rootContentBottom = rootRect.top + (parseFloat(rootStyle.borderTopWidth || "0") + root.scrollHeight) * scale + scrollTop;
  if (rootContentRight > vw + TOLERANCE) {
    overX.push({ kind: "root-scroll", el: ".wall-root", right: Math.round(rootContentRight), by: Math.round(rootContentRight - vw), text: "wall-root scrollWidth" });
  }
  if (rootContentBottom > vh + TOLERANCE) {
    overY.push({ kind: "root-scroll", el: ".wall-root", bottom: Math.round(rootContentBottom), by: Math.round(rootContentBottom - vh), text: "wall-root scrollHeight" });
  }

  /* 4 — unclipped ink overflow anywhere inside the wall, unless an ancestor
   * inside the wall clips that axis (which is what a fix looks like). */
  const ink: WallFitLeak[] = [];
  const containedOn = (el: Element, axis: "x" | "y") => {
    for (let node = el.parentElement; node && node !== root; node = node.parentElement) {
      const style = getComputedStyle(node);
      if ((axis === "x" ? style.overflowX : style.overflowY) !== "visible") return true;
    }
    return false;
  };
  /* How far past its box an element's content reaches, in the screen's pixels
   * (the Wall's own pixels times its zoom on a laptop). No allowance for
   * rounding. */
  const past = (el: Element, scroll: number, client: number) => Math.max(0, scroll - client) * zoomOf(el);
  for (const el of elements) {
    const style = getComputedStyle(el);
    if (style.display === "inline" || style.display === "contents" || style.display === "none") continue;
    const spillX = past(el, el.scrollWidth, el.clientWidth);
    const spillY = past(el, el.scrollHeight, el.clientHeight);
    if (style.overflowX === "visible" && !containedOn(el, "x") && spillX > TOLERANCE && el.clientWidth > 0) {
      ink.push({ el: chain(el), axis: "x", delta: round(spillX), text: squash(el.textContent).slice(0, 48) });
    }
    if (style.overflowY === "visible" && !containedOn(el, "y") && spillY > TOLERANCE && el.clientHeight > 0) {
      ink.push({ el: chain(el), axis: "y", delta: round(spillY), text: squash(el.textContent).slice(0, 48) });
    }
  }

  /* 5 — text a region cuts off sideways: a box that
   * clips its own overflow never spills, so 1–4 read "AUG ↑$12…" as fixed.
   * Designed truncation (text-overflow: ellipsis) is a choice, and is not. */
  const clipped: WallFitLeak[] = [];
  const clipWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const clipRange = document.createRange();
  for (let node = clipWalker.nextNode(); node; node = clipWalker.nextNode()) {
    const text = (node.nodeValue || "").trim();
    const parent = node.parentElement;
    if (!text || !parent || parent.closest("svg, script, style, title, .sr-only")) continue;
    // Responsive selectors can apply screen-reader-only clipping without
    // putting a literal .sr-only class on the element or its descendants.
    let accessibleOnly = false;
    for (let el: Element | null = parent; el && el !== root; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (style.clip === "rect(0px, 0px, 0px, 0px)" || style.clipPath === "inset(50%)") accessibleOnly = true;
    }
    if (accessibleOnly) continue;
    clipRange.selectNodeContents(node);
    for (const rect of clipRange.getClientRects()) {
      if (rect.width === 0) continue;
      let left = rect.left, right = rect.right, designed = false;
      for (let el: Element | null = parent; el && el !== root; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (style.textOverflow === "ellipsis") designed = true;
        if (style.overflowX === "visible") continue;
        const box = paddingBox(el);
        left = Math.max(left, box.left);
        right = Math.min(right, box.right);
      }
      const cut = Math.max(rect.right - right, left - rect.left);
      if (cut > TOLERANCE && !designed) clipped.push({ el: chain(parent), axis: "x", delta: round(cut), text: squash(text).slice(0, 48) });
    }
  }
  clipRange.detach();
  clipped.sort((a, b) => b.delta - a.delta);

  /* The budget (docs/14-design.md § Budget): the regions, the rows, the
   * room under them, and the feed's whole rows. */
  const boxOf = (selector: string): WallFitBox | null => {
    const el = root.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      top: Math.round(r.top + scrollTop), bottom: Math.round(r.bottom + scrollTop),
      left: Math.round(r.left + scrollLeft), right: Math.round(r.right + scrollLeft),
      width: Math.round(r.width), height: Math.round(r.height),
    };
  };
  const region = root.querySelector("[data-wall-sites]");
  const density = region ? region.getAttribute("data-site-density") : null;
  const rowEls = region ? [...region.querySelectorAll("[data-site-row]")] : [];
  const rows = rowEls.map((row) => ({ id: row.getAttribute("data-site-row") || "", height: Math.round(row.getBoundingClientRect().height) }));
  const lastRow = rowEls.at(-1);
  const spare = region && lastRow && density !== "focus"
    ? Math.round(region.getBoundingClientRect().bottom - lastRow.getBoundingClientRect().bottom)
    : null;
  const list = root.querySelector("[data-wall-feed] ol");
  const shown = list ? [...list.children].filter((row) => getComputedStyle(row).visibility !== "hidden") : [];
  const lowest = shown.at(-1);
  const lastRowWhole = list && lowest ? Math.round(lowest.getBoundingClientRect().bottom) <= Math.round(list.getBoundingClientRect().bottom) : null;

  const worstOf = (list: WallFitOffender[]) => list.reduce<WallFitOffender | null>((worst, item) => (worst === null || item.by > worst.by ? item : worst), null);
  overX.sort((a, b) => b.by - a.by);
  overY.sort((a, b) => b.by - a.by);
  ink.sort((a, b) => b.delta - a.delta);
  return {
    viewport: { width: vw, height: vh },
    tvMediaQuery: matchMedia("(min-width: 1800px) and (min-height: 900px)").matches,
    layout: root.getAttribute("data-wall-layout"),
    scale: Math.round(scale * 1000) / 1000,
    rootClipped: rootStyle.overflow === "hidden" || rootStyle.overflowY === "hidden",
    content: {
      right: Math.round(Math.max(rootContentRight, ...overX.map((item) => item.right ?? 0), 0)),
      bottom: Math.round(Math.max(rootContentBottom, ...overY.map((item) => item.bottom ?? 0), 0)),
    },
    tight: { right: Math.round(tight.right), bottom: Math.round(tight.bottom) },
    worst: { x: worstOf(overX), y: worstOf(overY) },
    offenders: { x: overX.slice(0, 8), y: overY.slice(0, 8) },
    ink: ink.slice(0, 8),
    clipped: clipped.slice(0, 8),
    regions: {
      strip: boxOf("[data-wall-strip]"),
      revenue: boxOf("[data-wall-revenue]"),
      needs: boxOf("[data-wall-needs]"),
      sites: boxOf("[data-wall-sites]"),
      feed: boxOf("[data-wall-feed]"),
    },
    sites: { density, rows, spare },
    feed: { shown: shown.length, lastRowWhole },
    counts: { elements: elements.length, overX: overX.length, overY: overY.length, ink: ink.length, clipped: clipped.length },
  };
}

export interface WallFitVerdict {
  /** Nothing reaches past the viewport on either axis. */
  fits: boolean;
  overWidth: number;
  overHeight: number;
  /** `--strict`: also nothing painting outside its own box, and no text cut off. */
  clean: boolean;
}

/** The one reading of a measurement both the fit tool and the journeys use. */
export function wallFitVerdict(measured: WallFitMeasurement): WallFitVerdict {
  const overWidth = measured.content.right - measured.viewport.width;
  const overHeight = measured.content.bottom - measured.viewport.height;
  return {
    fits: overWidth <= 0 && overHeight <= 0,
    overWidth,
    overHeight,
    clean: measured.ink.length === 0 && measured.clipped.length === 0,
  };
}
