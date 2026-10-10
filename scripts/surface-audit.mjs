#!/usr/bin/env node
// Does a desk surface still meet the design doc? Measures the live Tower's
// routes at the desk viewport (1440×900) and the phone viewport (390×844) and
// reports, per route, every acceptance line in `docs/14-design.md` a browser
// can see. Same shape as `scripts/wall-fit-check.mjs`: headless Chromium over
// the DevTools protocol, read-only against a live Tower on 5173, an operator
// tool rather than part of `pnpm test`.
//
// The page does no judging: `collectSurface` walks the DOM and returns plain
// descriptors — tag, attributes, ancestry, text, box. Every rule runs in node
// over those descriptors, so `surface-audit.test.mjs` drives the same functions
// over fixture descriptors.
//
// Exit 0 every route meets the doc; 1 offenders (named per route); 2 could not
// measure (no Chrome, no Tower, a route that never rendered).

import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAuditBrowser, withAuditBrowser } from "./audit-browser.mjs";

/** Where a route names one site's page. The audit fills it with `--asset`,
 * else with the first site the Tower's Sites page lists — never a site written
 * into this script. */
export const SITE_TOKEN = ":site";

/** The desk routes the design doc governs. `--routes` overrides. */
export const DEFAULT_ROUTES = [
  "/",
  "/assets",
  `/assets/${SITE_TOKEN}`,
  `/assets/${SITE_TOKEN}/growth`,
  `/assets/${SITE_TOKEN}/search`,
  "/alerts",
  "/tasks",
  "/financials",
  "/health",
  "/integrations",
  "/settings",
];

export const DEFAULT_URL = "http://127.0.0.1:5173";

/** "The first screen at 1440×900 answers the surface's one question." */
export const DESK_VIEWPORT = { name: "desk", width: 1440, height: 900 };
/** "Phone width (390) … the 44px floor holds." */
export const PHONE_VIEWPORT = { name: "phone", width: 390, height: 844 };

/** The touch floor, in CSS pixels. */
export const TOUCH_FLOOR = 44;

/** `--strict` only: a subtitle is "one sentence" and this long is a paragraph
 * wearing a subtitle's punctuation. */
export const SUBTITLE_MAX_CHARS = 120;

/** Sub-pixel slack. A control laid out at exactly 44px measures 43.99 often
 * enough that a hard `< 44` would report the floor broken by 0.01px. */
const TOLERANCE = 0.5;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const option = (name, fallback) => {
    const index = argv.indexOf(name);
    if (index < 0) return fallback;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    return value;
  };
  const number = (name, fallback) => {
    const value = Number(option(name, String(fallback)));
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} must be a positive number`);
    }
    return Math.round(value);
  };

  /** Repeatable AND comma-separated, like `signals:collect --families`. */
  const routes = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== "--routes") continue;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("--routes requires a value");
    }
    for (const part of value.split(",")) {
      const route = part.trim();
      if (!route) continue;
      routes.push(route.startsWith("/") ? route : `/${route}`);
    }
  }

  return {
    url: option("--url", DEFAULT_URL).replace(/\/+$/, ""),
    routes: routes.length > 0 ? routes : [...DEFAULT_ROUTES],
    asset: option("--asset", null),
    strict: argv.includes("--strict"),
    json: argv.includes("--json"),
    help: argv.includes("--help"),
    settleMs: number("--settle-ms", 2500),
    readyMs: number("--ready-ms", 30000),
    chrome: option("--chrome", null),
  };
}

/**
 * The routes with `:site` filled in. With no site to audit (an installation
 * with none yet), the site pages are left out rather than measured empty.
 */
export function siteRoutes(routes, site) {
  if (site === null || site === undefined || site === "") {
    return routes.filter((route) => !route.includes(SITE_TOKEN));
  }
  return routes.map((route) => route.split(SITE_TOKEN).join(encodeURIComponent(site)));
}

/** The first site a list of page links names: `/assets/<id>` exactly, so a
 * tab (`/assets/<id>/growth`) or the index itself is never taken for one. */
export function firstListedSite(hrefs) {
  for (const href of Array.isArray(hrefs) ? hrefs : []) {
    const match = /^\/assets\/([^/?#]+)$/.exec(typeof href === "string" ? href : "");
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

// ---------------------------------------------------------------------------
// The rules. Pure functions over the descriptors `collectSurface` returns.
//
// A descriptor is:
//   { tag, attrs: {name: value}, text, rect: {top,left,width,height,bottom},
//     display, ancestors: [{tag, attrs}, …]  // nearest first, document order up
//     … plus per-kind extras noted on each rule.
// ---------------------------------------------------------------------------

/** Whitespace-collapsed text, the way a reader sees it rather than the way JSX
 * indented it. */
export function collapse(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function hasAttribute(node, name) {
  return Boolean(node?.attrs && Object.hasOwn(node.attrs, name));
}

/** The node itself and then every ancestor, nearest first. */
export function selfAndAncestors(node) {
  return [node, ...(node?.ancestors ?? [])];
}

/** Prose lives behind the one disclosure per screen, marked `[data-about]`. */
export function isInsideAbout(node) {
  return selfAndAncestors(node).some((step) => hasAttribute(step, "data-about"));
}

/** A subtree the audit is told to ignore — the kitchen sink demonstrating a
 * retired component, a deliberate prose page. */
export function isIgnored(node) {
  return selfAndAncestors(node).some((step) =>
    hasAttribute(step, "data-audit-ignore"),
  );
}

/**
 * Folded away inside a closed disclosure. Chrome hides a closed `<details>`
 * with `content-visibility` on the implicit slot rather than `display: none`,
 * so the subtree keeps a layout box and the descriptor's `visible` says yes.
 * The summary is not folded away: it is the visible line and a control a thumb
 * has to hit, so its own 44px floor is still measured.
 */
export function isInsideClosedDisclosure(node) {
  const chain = selfAndAncestors(node);
  for (let step = 0; step < chain.length; step++) {
    const parent = chain[step + 1];
    if (!parent || parent.tag !== "details") continue;
    if (hasAttribute(parent, "open")) continue;
    return chain[step]?.tag !== "summary";
  }
  return false;
}

/** Words whose trailing period ends an abbreviation, not a sentence. */
const ABBREVIATIONS = new Set([
  "e.g",
  "i.e",
  "etc",
  "vs",
  "no",
  "approx",
  "avg",
  "mr",
  "mrs",
  "ms",
  "dr",
  "inc",
  "ltd",
  "cf",
  "est",
  "min",
  "max",
  "a.m",
  "p.m",
]);

/**
 * How many sentences a reader sees. Not a parser — a counter tuned for the two
 * false positives that occur in this product's copy: decimals ("1.5 days",
 * "$12.40") and abbreviations ("e.g.", "28d avg."). A run with no terminator
 * at all is one sentence.
 */
export function sentenceCount(text) {
  const clean = collapse(text);
  if (!clean) return 0;
  let count = 0;
  for (let index = 0; index < clean.length; index++) {
    const character = clean[index];
    if (character !== "." && character !== "!" && character !== "?") continue;
    const before = clean[index - 1] ?? "";
    const after = clean[index + 1] ?? "";
    // 1.5 — a decimal point, never a full stop.
    if (character === "." && /\d/.test(before) && /\d/.test(after)) continue;
    // i.e / a.m — an interior period inside one token.
    if (character === "." && /[A-Za-z]/.test(before) && /[A-Za-z]/.test(after)) {
      continue;
    }
    if (index === clean.length - 1) {
      count++;
      continue;
    }
    if (after !== " ") continue;
    const rest = clean.slice(index + 1).trimStart();
    if (!rest) {
      count++;
      continue;
    }
    const word = clean.slice(0, index).split(" ").pop() ?? "";
    if (ABBREVIATIONS.has(word.toLowerCase())) continue;
    // A terminator followed by lowercase is mid-sentence punctuation, not a
    // sentence break.
    if (/^[“"'(\[A-Z0-9]/.test(rest)) count++;
  }
  return count === 0 ? 1 : count;
}

/**
 * "No paragraph longer than one sentence is visible by default outside
 * `About`." `--strict` adds the other half: a single-sentence run past
 * `SUBTITLE_MAX_CHARS` is prose with a full stop at the end of it.
 */
export function paragraphOffenders(paragraphs, options = {}) {
  const strict = Boolean(options.strict);
  const limit = options.subtitleMax ?? SUBTITLE_MAX_CHARS;
  const offenders = [];
  for (const node of paragraphs ?? []) {
    if (!node?.visible) continue;
    // The accessibility description has a layout box, but its clipped 1px
    // surface is not visible prose. Measured size preserves responsive
    // `not-sr-only` content when that same element becomes visible.
    if (selfAndAncestors(node).some((step) =>
      collapse(step?.attrs?.class).split(" ").includes("sr-only")
      && step.rect?.width <= 1 && step.rect?.height <= 1
    )) continue;
    if (isInsideClosedDisclosure(node)) continue;
    if (isInsideAbout(node) || isIgnored(node)) continue;
    const text = collapse(node.text);
    if (!text) continue;
    const sentences = sentenceCount(text);
    if (sentences > 1) {
      offenders.push({
        rule: "prose",
        sentences,
        chars: text.length,
        text: text.slice(0, 60),
        where: describe(node),
      });
      continue;
    }
    if (strict && text.length > limit) {
      offenders.push({
        rule: "long-subtitle",
        sentences,
        chars: text.length,
        text: text.slice(0, 60),
        where: describe(node),
      });
    }
  }
  return offenders;
}

/** Config-file paths belong on Settings and Sources. */
export const CONFIG_PATH_RE = /(^|[\s(])config\/[A-Za-z0-9._/-]+\.(json|md|yaml|yml)/;

/**
 * The two exempt surfaces: Settings (the page and the asset tab) and an
 * asset's Sources tab. Everything else is a view surface.
 */
export function isConfigSurfaceRoute(route) {
  const segments = String(route ?? "")
    .split("?")[0]
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
  return segments.includes("settings") || segments.includes("sources");
}

/**
 * "No owner chip or config path on a view surface." Three signatures:
 *   · `[data-owner-chip]` — the contract;
 *   · a `title` beginning "Owned by " — `OwnerChip.tsx`;
 *   · visible text naming a `config/…` file — the chip's own payload, and
 *     bare paths written into copy without a chip.
 * `[data-config-surface]` opts a subtree out where one legitimately shows the
 * register.
 */
/** Is this node the inside of a chip that has already been counted? */
export function isInsideOwnerChip(node) {
  return (node?.ancestors ?? []).some(
    (step) =>
      hasAttribute(step, "data-owner-chip") ||
      collapse(step.attrs?.title ?? "").startsWith("Owned by "),
  );
}

export function ownerChipOffenders(nodes, options = {}) {
  if (isConfigSurfaceRoute(options.route)) return [];
  const offenders = [];
  for (const node of nodes ?? []) {
    if (!node?.visible) continue;
    if (isInsideClosedDisclosure(node)) continue;
    if (isIgnored(node)) continue;
    if (
      selfAndAncestors(node).some((step) =>
        hasAttribute(step, "data-config-surface"),
      )
    ) {
      continue;
    }
    const text = collapse(node.text);
    const title = collapse(node.attrs?.title ?? "");
    let kind = null;
    if (hasAttribute(node, "data-owner-chip")) kind = "owner-chip";
    else if (title.startsWith("Owned by ")) kind = "owner-chip";
    else if (CONFIG_PATH_RE.test(text)) kind = "config-path";
    if (!kind) continue;
    // A chip renders its own path as text, so the chip and the span inside it
    // are ONE offence. Count the chip; drop what it contains.
    if (kind === "config-path" && isInsideOwnerChip(node)) continue;
    offenders.push({
      rule: kind,
      text: (text || title).slice(0, 60),
      where: describe(node),
    });
  }
  return offenders;
}

/** What counts as "its series" inside a KPI. */
const SPARK_TAGS = new Set(["svg", "canvas"]);

/**
 * "Every number that can have a series shows one." A `[data-kpi]` declares
 * itself as a number; the offender is the one with no `[data-spark]` (or bare
 * chart element) inside it and no declared reason why it has none.
 *
 * Two declared reasons. A point-in-time total with no history carries a
 * composition instead (`[data-composition]`: how the total divides) — a
 * declaration, not an exemption, since a number with a real series still has
 * to draw it. A payload that keeps no history yet declares the gap on itself
 * (`data-series="unavailable"`, the reason in `data-series-reason`); it is not
 * an offender, and {@link pendingSeries} lists it under the route.
 *
 * A KPI descriptor carries `sparks`: every descendant that could be the series
 * or the composition, so the judgement of what counts stays here.
 */
export function kpiOffenders(kpis) {
  const offenders = [];
  for (const node of kpis ?? []) {
    if (!node?.visible) continue;
    if (isInsideClosedDisclosure(node)) continue;
    if (isIgnored(node)) continue;
    if (node.attrs?.["data-series"] === "unavailable") continue;
    const hasSeries = (node.sparks ?? []).some((candidate) => {
      if (hasAttribute(candidate, "data-spark")) return true;
      if (hasAttribute(candidate, "data-sparkline")) return true;
      if (hasAttribute(candidate, "data-hero-chart")) return true;
      if (hasAttribute(candidate, "data-composition")) return true;
      return SPARK_TAGS.has(candidate.tag);
    });
    const sharedSeries = (node.relatedSeries ?? []).some((chart) =>
      chart.visible && !isInsideClosedDisclosure(chart) && hasAttribute(chart, "data-hero-chart")
    );
    if (hasSeries || sharedSeries) continue;
    offenders.push({
      rule: "kpi-without-spark",
      text: collapse(node.attrs?.["data-kpi"] || node.text).slice(0, 60),
      where: describe(node),
    });
  }
  return offenders;
}

/**
 * The numbers that have declared they have no series yet — informational,
 * never an offence. Separate from {@link kpiOffenders} because "what is wrong"
 * and "what is this surface still waiting on" are different questions.
 */
export function pendingSeries(kpis) {
  const pending = [];
  for (const node of kpis ?? []) {
    if (!node?.visible) continue;
    if (isIgnored(node)) continue;
    if (node.attrs?.["data-series"] !== "unavailable") continue;
    pending.push({
      label: collapse(node.attrs?.["data-kpi"] || node.text).slice(0, 60),
      reason: collapse(node.attrs?.["data-series-reason"] ?? "").slice(0, 120),
    });
  }
  return pending;
}

/**
 * At 390 every control a thumb has to hit measures at least 44px on both axes.
 * A link laid out `display: inline` is a word inside a sentence, not a
 * control. A checkbox or radio is measured through its `label`, the box a
 * thumb actually hits (`hitRect` on the descriptor).
 */
export function touchTargetOffenders(controls, options = {}) {
  const floor = options.floor ?? TOUCH_FLOOR;
  const offenders = [];
  for (const node of controls ?? []) {
    if (!node?.visible) continue;
    if (isInsideClosedDisclosure(node)) continue;
    if (isIgnored(node)) continue;
    if (node.display === "inline") continue;
    const rect = node.hitRect ?? node.rect ?? { width: 0, height: 0 };
    const width = rect.width ?? 0;
    const height = rect.height ?? 0;
    if (width <= 0 || height <= 0) continue;
    if (width >= floor - TOLERANCE && height >= floor - TOLERANCE) continue;
    offenders.push({
      rule: "touch-target",
      width: round(width),
      height: round(height),
      text: collapse(node.text || node.attrs?.["aria-label"] || node.tag).slice(
        0,
        60,
      ),
      where: describe(node),
    });
  }
  return offenders;
}

/**
 * "The first screen at 1440×900 answers the surface's one question without
 * scrolling." The declared hero is `[data-surface-hero]`; without one, the
 * hero is the union of the first `[data-kpi-strip]` and the first
 * `[data-hero-chart]`. A surface carrying none of the three has not declared
 * a hero, which is itself the offence.
 */
export function heroVerdict(hero, viewport) {
  const height = viewport?.height ?? DESK_VIEWPORT.height;
  if (!hero || !hero.found) {
    return {
      ok: false,
      reason: "no-hero",
      detail:
        "no [data-surface-hero], and no [data-kpi-strip] + [data-hero-chart] pair",
    };
  }
  const bottom = hero.bottom ?? 0;
  if (bottom > height + TOLERANCE) {
    return {
      ok: false,
      reason: "hero-below-fold",
      detail: `${hero.source} ends at ${round(bottom)}px, ${round(bottom - height)}px past the ${height}px first screen`,
      bottom: round(bottom),
      over: round(bottom - height),
    };
  }
  return { ok: true, reason: "fits", bottom: round(bottom), source: hero.source };
}

/** Every rule for one route, at the viewport each rule is written against. */
export function routeVerdict(measured, options = {}) {
  const strict = Boolean(options.strict);
  const desk = measured?.desk ?? null;
  const phone = measured?.phone ?? null;
  const route = measured?.route ?? options.route ?? "";
  const offenders = [];

  const hero = heroVerdict(desk?.hero, DESK_VIEWPORT);
  if (!hero.ok) {
    offenders.push({
      rule: hero.reason,
      text: hero.detail,
      where: desk?.hero?.source ?? "—",
    });
  }
  offenders.push(...paragraphOffenders(desk?.paragraphs, { strict }));
  offenders.push(...ownerChipOffenders(desk?.owners, { route }));
  offenders.push(...kpiOffenders(desk?.kpis));
  offenders.push(...touchTargetOffenders(phone?.controls));
  // Informational, not in `offenders`: it rides the verdict so the report can
  // say what the surface is waiting on without failing it.
  const pending = pendingSeries(desk?.kpis);

  const byRule = {};
  for (const offender of offenders) {
    byRule[offender.rule] = (byRule[offender.rule] ?? 0) + 1;
  }
  return {
    route,
    // Whole pixels: the page-height budget is stated in whole pixels.
    heights: {
      desk: desk ? Math.round(desk.pageHeight) : null,
      phone: phone ? Math.round(phone.pageHeight) : null,
    },
    hero,
    counts: {
      prose:
        (byRule.prose ?? 0) + (byRule["long-subtitle"] ?? 0),
      owners: (byRule["owner-chip"] ?? 0) + (byRule["config-path"] ?? 0),
      kpis: byRule["kpi-without-spark"] ?? 0,
      touch: byRule["touch-target"] ?? 0,
      pending: pending.length,
      total: offenders.length,
    },
    offenders,
    pending,
    ok: offenders.length === 0,
  };
}

/**
 * A reading with nothing in it. Every desk route draws a shell with nav links
 * and headings, so no controls and no text at all is the skeleton, never the
 * surface — the one failure mode the settle loop cannot see from outside.
 */
export function readEmpty(reading) {
  if (!reading) return true;
  const counts = reading.counts ?? {};
  return (counts.controls ?? 0) === 0 && (counts.paragraphs ?? 0) === 0;
}

/**
 * A reading of the skeleton rather than of the surface. The shell paints its
 * sidebar, nav and search box immediately, so a route still waiting on its
 * payload has controls and text and the settle loop believes it; what it lacks
 * shows up as a furthest painted edge exactly equal to the viewport height.
 * Exact equality rather than a threshold: a real surface that ends within a
 * pixel of the fold is a real surface.
 */
export function readSkeletal(reading) {
  if (readEmpty(reading)) return true;
  const viewportHeight = reading.viewport?.height;
  if (!Number.isFinite(viewportHeight)) return false;
  return Math.round(reading.pageHeight ?? 0) === Math.round(viewportHeight);
}

/** The run's verdict, so the caller does not re-derive it from the rows. */
export function summarize(verdicts) {
  const totals = { prose: 0, owners: 0, kpis: 0, touch: 0, hero: 0, pending: 0, total: 0 };
  for (const verdict of verdicts ?? []) {
    totals.prose += verdict.counts.prose;
    totals.owners += verdict.counts.owners;
    totals.kpis += verdict.counts.kpis;
    totals.touch += verdict.counts.touch;
    totals.pending += verdict.counts.pending ?? 0;
    if (!verdict.hero.ok) totals.hero += 1;
    totals.total += verdict.counts.total;
  }
  return {
    routes: (verdicts ?? []).length,
    failing: (verdicts ?? []).filter((verdict) => !verdict.ok).length,
    totals,
    ok: totals.total === 0,
  };
}

function round(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

/** A short, stable name for where an offender is, in offender output. */
export function describe(node) {
  if (!node) return "—";
  let out = node.tag ?? "?";
  const id = node.attrs?.id;
  if (id) return `${out}#${id}`;
  const classes = collapse(node.attrs?.class ?? "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2);
  if (classes.length > 0) out += `.${classes.join(".")}`;
  for (const [name, value] of Object.entries(node.attrs ?? {})) {
    if (!name.startsWith("data-")) continue;
    out += `[${name}${value ? `=${value.slice(0, 24)}` : ""}]`;
    break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The page side. Descriptors only — no judging happens here.
//
// Injected into Chrome through `Function.prototype.toString`, so it must be
// SELF-CONTAINED: no module-scope references, no imports. Everything it needs
// arrives in `options`.
// ---------------------------------------------------------------------------

export function collectSurface(options) {
  const doc = document;
  const win = window;
  const scrollX = win.scrollX;
  const scrollY = win.scrollY;
  const skipTags = new Set(options.skipProseTags);

  const attrsOf = (el) => {
    const out = {};
    for (const attribute of el.attributes) out[attribute.name] = attribute.value;
    return out;
  };
  const shallow = (el) => ({
    tag: el.tagName.toLowerCase(),
    attrs: attrsOf(el),
    ...(el.classList.contains("sr-only") ? { rect: boxOf(el) } : {}),
  });
  const ancestorsOf = (el) => {
    const out = [];
    for (
      let node = el.parentElement;
      node && out.length < 24;
      node = node.parentElement
    ) {
      out.push(shallow(node));
    }
    return out;
  };
  const textOf = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();
  const boxOf = (el) => {
    const rect = el.getBoundingClientRect();
    return {
      top: rect.top + scrollY,
      left: rect.left + scrollX,
      bottom: rect.bottom + scrollY,
      right: rect.right + scrollX,
      width: rect.width,
      height: rect.height,
    };
  };
  /* A closed disclosure hides its content, whatever the box says: Chrome uses
   * `content-visibility` on the implicit slot rather than `display: none`, so
   * `getBoundingClientRect()` returns a real rect for text nobody can see. The
   * summary is the exception: it is the visible line and a control, and its
   * own 44px floor is measured here.
   */
  const insideClosedDetails = (el) => {
    for (let node = el; node; node = node.parentElement) {
      const parent = node.parentElement;
      if (!parent || parent.tagName !== "DETAILS" || parent.open) continue;
      if (node.tagName === "SUMMARY") return false;
      return true;
    }
    return false;
  };
  /* Painted, not merely present: an unmounted tab panel and a display:none
   * drawer measure 0×0, which is exactly "not visible by default". The closed
   * disclosure is judged in node instead — `isInsideClosedDisclosure` over the
   * ancestry this descriptor already carries — because that is where the rules
   * live and where they can be tested. */
  const isVisible = (el) => {
    const style = win.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const describeNode = (el, extra) => ({
    tag: el.tagName.toLowerCase(),
    attrs: attrsOf(el),
    ancestors: ancestorsOf(el),
    text: textOf(el).slice(0, 400),
    rect: boxOf(el),
    display: win.getComputedStyle(el).display,
    visible: isVisible(el),
    ...(extra || {}),
  });

  /* 1 — paragraphs, as a reader sees them rather than as the JSX spelled them:
   * a block box with text in it. Walk the text nodes, attribute each to its
   * nearest non-inline ancestor, and every block that ends up with text is one
   * paragraph; inline children merge into their block, and a container whose
   * children are all blocks collects nothing. Walking text nodes rather than
   * elements keeps this linear. */
  const paragraphs = [];
  const blockText = new Map();
  const blockOrder = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.nodeValue && node.nodeValue.trim()
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    let block = null;
    let skipped = false;
    for (let el = node.parentElement; el; el = el.parentElement) {
      if (skipTags.has(el.tagName.toLowerCase())) {
        skipped = true;
        break;
      }
      const display = win.getComputedStyle(el).display;
      if (display === "inline" || display === "contents") continue;
      block = el;
      break;
    }
    if (skipped || !block) continue;
    if (!blockText.has(block)) {
      blockText.set(block, []);
      blockOrder.push(block);
    }
    blockText.get(block).push(node.nodeValue);
    if (blockOrder.length >= 800) break;
  }
  for (const block of blockOrder) {
    const text = blockText
      .get(block)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    paragraphs.push({ ...describeNode(block), text: text.slice(0, 400) });
    if (paragraphs.length >= 600) break;
  }

  /* 2 — owner chips and config paths. Chips first, then any leaf whose own text
   * names a config file. */
  const owners = [];
  const seenOwners = new Set();
  const addOwner = (el) => {
    if (seenOwners.has(el)) return;
    seenOwners.add(el);
    owners.push(describeNode(el));
  };
  for (const el of doc.querySelectorAll("[data-owner-chip], [title]")) {
    addOwner(el);
  }
  for (const el of doc.querySelectorAll("body *")) {
    if (el.children.length > 0) continue;
    if (/config\/[A-Za-z0-9._/-]+\.(json|md|yaml|yml)/.test(textOf(el))) {
      addOwner(el);
    }
    if (owners.length >= 300) break;
  }

  /* 3 — KPIs and the series each one does or does not carry. */
  const kpis = [];
  for (const el of doc.querySelectorAll("[data-kpi]")) {
    const sparks = [];
    for (const candidate of el.querySelectorAll(
      "svg, canvas, [data-spark], [data-sparkline], [data-hero-chart], [data-composition]",
    )) {
      sparks.push(shallow(candidate));
      if (sparks.length >= 8) break;
    }
    const relatedSeries = [];
    for (const id of (el.getAttribute("aria-details") ?? "").split(/\s+/).filter(Boolean)) {
      const target = doc.getElementById(id);
      if (!target) continue;
      const charts = target.matches("[data-hero-chart]") ? [target] : target.querySelectorAll("[data-hero-chart]");
      for (const chart of charts) relatedSeries.push(describeNode(chart));
    }
    kpis.push(describeNode(el, { sparks, relatedSeries }));
  }

  /* 4 — controls, for the 44px floor. */
  const controls = [];
  const controlSelector =
    'button, a[href], input, select, textarea, summary, [role="button"], [role="tab"], [role="switch"], [role="menuitem"], [role="option"], [role="checkbox"]';
  for (const el of doc.querySelectorAll(controlSelector)) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    let hitRect = null;
    if (tag === "input" && (type === "checkbox" || type === "radio")) {
      const label = el.closest("label");
      if (label) hitRect = boxOf(label);
    }
    if (tag === "input" && type === "hidden") continue;
    controls.push(describeNode(el, hitRect ? { hitRect } : {}));
    if (controls.length >= 600) break;
  }

  /* 5 — the declared hero. */
  const declared = doc.querySelector("[data-surface-hero]");
  let hero = { found: false, source: "none", bottom: 0 };
  if (declared) {
    hero = {
      found: true,
      source: "[data-surface-hero]",
      bottom: boxOf(declared).bottom,
      top: boxOf(declared).top,
    };
  } else {
    const strip = doc.querySelector("[data-kpi-strip]");
    const chart = doc.querySelector("[data-hero-chart]");
    if (strip || chart) {
      const boxes = [strip, chart].filter(Boolean).map(boxOf);
      hero = {
        found: true,
        source: [strip ? "[data-kpi-strip]" : null, chart ? "[data-hero-chart]" : null]
          .filter(Boolean)
          .join(" + "),
        bottom: Math.max(...boxes.map((box) => box.bottom)),
        top: Math.min(...boxes.map((box) => box.top)),
      };
    }
  }

  /* 6 — page height. The document's scroll size, floored by the furthest edge
   * anything actually paints, so a surface inside its own scroll container is
   * still measured by the content it holds rather than by the box around it. */
  let contentBottom = 0;
  for (const el of doc.querySelectorAll("body *")) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    // A closed disclosure's content keeps its layout box in current Chrome,
    // and a page's height is what a reader scrolls past. The cheap ancestor
    // walk rather than the whole of `isVisible`: this loop runs once per
    // element on the page.
    if (insideClosedDetails(el)) continue;
    const bottom = rect.bottom + scrollY;
    if (bottom > contentBottom) contentBottom = bottom;
  }
  /* The desk shell scrolls INSIDE `main`, so the document's own scroll size is
   * the viewport height on every route and says nothing. Every scroll region on
   * the page reports the content it hides, and the painted extent floors both. */
  let regionHeight = 0;
  for (const region of doc.querySelectorAll("main, [data-scroll-region]")) {
    if (region.scrollHeight > regionHeight) regionHeight = region.scrollHeight;
  }
  const pageHeight = Math.max(
    doc.documentElement.scrollHeight,
    doc.body.scrollHeight,
    regionHeight,
    contentBottom,
  );

  return {
    url: location.pathname + location.search,
    title: doc.title,
    viewport: {
      width: doc.documentElement.clientWidth,
      height: doc.documentElement.clientHeight,
    },
    pageHeight,
    scrollHeight: doc.documentElement.scrollHeight,
    contentBottom,
    hero,
    paragraphs,
    owners,
    kpis,
    controls,
    counts: {
      paragraphs: paragraphs.length,
      owners: owners.length,
      kpis: kpis.length,
      controls: controls.length,
    },
  };
}

/** Tags whose text is never a paragraph. */
export const SKIP_PROSE_TAGS = [
  "script",
  "style",
  "title",
  "head",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "button",
  "a",
  "label",
  "option",
  "select",
  "textarea",
  "input",
  "code",
  "pre",
  "kbd",
  "svg",
  "path",
  "time",
  "th",
  "summary",
  "nav",
];

/** The expression evaluated in the page: one function, one JSON argument. */
export function measureExpression(options) {
  return `(${collectSurface.toString()})(${JSON.stringify(options)})`;
}

// ---------------------------------------------------------------------------
// The CLI. Everything below runs only when this file is the entry point.
// ---------------------------------------------------------------------------

const HELP = `Measure the live Tower's desk surfaces against docs/14-design.md.

The Tower must be running (pnpm os:up, or apps/tower's dev server) and a local
Chrome must be launchable. Read-only: it navigates and measures, nothing else.

Exit 0 = every route meets doc 14, 1 = offenders (named per route),
2 = could not measure (no Chrome, no Tower, a route that never rendered).

Options:
  --url URL         Tower origin (default ${DEFAULT_URL})
  --routes LIST     comma-separated routes; repeatable. Default:
                    ${DEFAULT_ROUTES.join(" ")}
  --asset ID        the site whose pages fill ${SITE_TOKEN} (default: the first site /assets lists)
  --strict          also flag one-sentence subtitles over ${SUBTITLE_MAX_CHARS} characters
  --json            print the raw measurement instead of the table
  --settle-ms MS    pause after a route stops growing (default 2500)
  --ready-ms MS     how long to wait for a route to render (default 30000)
  --chrome PATH     explicit browser override (default: installed journey Chromium)
`;

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Every DevTools operation is bounded, including navigation before settling. */
export async function connectDevTools(socket, { timeoutMs = 10_000 } = {}) {
  let id = 0;
  let failure;
  const pending = new Map();
  let connected, refused;
  const ready = new Promise((resolve, reject) => { connected = resolve; refused = reject; });
  const connecting = setTimeout(() => fail(new Error(`Chrome did not attach within ${timeoutMs}ms.`)), timeoutMs);
  function fail(error) {
    if (failure) return;
    failure = error;
    clearTimeout(connecting);
    refused(error);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    socket.close();
  }
  socket.onopen = () => { clearTimeout(connecting); connected(); };
  socket.onerror = () => fail(new Error("The Chrome DevTools connection failed."));
  socket.onclose = () => fail(new Error("The Chrome DevTools connection closed."));
  socket.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
      if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error();
    }
    catch { fail(new Error("Chrome returned an invalid DevTools response.")); return; }
    const request = pending.get(message.id);
    if (request) {
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(`Chrome rejected ${request.method}: ${message.error.message ?? "DevTools error"}`));
      else request.resolve(message);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (failure) { reject(failure); return; }
      const messageId = ++id;
      const timer = setTimeout(() => fail(new Error(`Chrome did not answer ${method} within ${timeoutMs}ms.`)), timeoutMs);
      pending.set(messageId, { resolve, reject, timer, method });
      try { socket.send(JSON.stringify({ id: messageId, method, params })); }
      catch { fail(new Error(`Could not send ${method} to Chrome.`)); }
    });
  const evaluate = async (expression) => {
    const response = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.result?.exceptionDetails) {
      const details = response.result.exceptionDetails;
      throw new Error(
        `page error: ${details.exception?.description ?? JSON.stringify(details)}`,
      );
    }
    return response.result?.result?.value;
  };
  await ready;
  return { send, evaluate, close: () => fail(new Error("The surface audit closed its Chrome connection.")) };
}

export async function connectAuditPage(port) {
  const target = await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent("about:blank")}`,
    { method: "PUT", signal: AbortSignal.timeout(10_000) },
  );
  if (!target.ok) throw new Error(`Chrome refused a new tab: ${target.status}`);
  const { webSocketDebuggerUrl } = await target.json();
  return connectDevTools(new WebSocket(webSocketDebuggerUrl));
}

/** The audit owns only this browser and profile, even when attach/read fails. */
export async function withChromePage(binary, viewport, read, { attach = connectAuditPage, ...options } = {}) {
  return withAuditBrowser(binary, viewport, read, { ...options, attach });
}

/**
 * A route is ready when React has mounted and the surface has stopped
 * changing. The fingerprint is the element count beside the tallest scroll
 * region, not `document.scrollHeight`: the desk shell scrolls inside `main`,
 * so the document's scroll size is the viewport height on every route. Four
 * equal samples, not two: a route pauses between its skeleton and its data
 * for as long as the store takes to answer, and the quiet window has to be
 * longer than the pause; `readEmpty` is the backstop when it is not.
 */
const FINGERPRINT = `(() => {
  let region = 0;
  for (const el of document.querySelectorAll('main, [data-scroll-region]')) {
    if (el.scrollHeight > region) region = el.scrollHeight;
  }
  return document.querySelectorAll('*').length + ':' + Math.max(region, document.documentElement.scrollHeight);
})()`;

/**
 * The mark that says a route has drawn its own content, not just the shell.
 * A route that never grows one is still measured and still reported
 * `no-hero`; a wait that turned a real missing hero into a hang would be worse
 * than the bug it fixes.
 */
const HERO_PRESENT = `(() => !!document.querySelector('[data-surface-hero], [data-kpi-strip], [data-hero-chart]'))()`;

async function settle(page, options) {
  const deadline = Date.now() + options.readyMs;
  let mounted = false;
  while (Date.now() < deadline) {
    await wait(200);
    mounted = await page.evaluate(
      `(() => { const root = document.querySelector('#root'); return document.readyState === 'complete' && !!root && root.children.length > 0 && !!document.querySelector('main'); })()`,
    );
    if (mounted) break;
  }
  if (!mounted) return false;
  // Mounted is not rendered: the fingerprint below can settle on a skeleton
  // that has a `main`, a nav and a search box. Wait for the surface to declare
  // itself first, and give up quietly, because a route with no hero is a
  // finding rather than an error.
  while (Date.now() < deadline) {
    if (await page.evaluate(HERO_PRESENT)) break;
    await wait(200);
  }
  let previous = "";
  let stable = 0;
  for (let attempt = 0; attempt < 30 && Date.now() < deadline; attempt++) {
    await wait(options.settleMs);
    const fingerprint = await page.evaluate(FINGERPRINT);
    if (fingerprint === previous) {
      stable += 1;
      if (stable >= 3) return true;
    } else {
      stable = 0;
      previous = fingerprint;
    }
  }
  return true;
}

/** Every link the page's main region holds, as written. */
const SITE_LINKS = `(() => [...document.querySelectorAll('main a[href^="/assets/"]')].map((a) => a.getAttribute('href')))()`;

/** The first site the Tower's Sites page lists, or null once it has had
 * `readyMs` to render one. */
async function listedSite(page, options) {
  await page.send("Page.navigate", { url: `${options.url}/assets` });
  const deadline = Date.now() + options.readyMs;
  while (Date.now() < deadline) {
    await wait(200);
    const site = firstListedSite(await page.evaluate(SITE_LINKS));
    if (site !== null) return site;
  }
  return null;
}

function bar(count) {
  if (count === 0) return "·";
  return String(count);
}

function formatTable(verdicts) {
  const lines = [];
  const width = Math.max(
    5,
    ...verdicts.map((verdict) => verdict.route.length),
  );
  lines.push(
    `${"route".padEnd(width)}  ${"desk px".padStart(8)}  ${"phone px".padStart(8)}  hero  prose  chips  no-spark  <44px`,
  );
  for (const verdict of verdicts) {
    const hero = verdict.hero.ok ? " ok " : "OVER";
    lines.push(
      `${verdict.route.padEnd(width)}  ${String(verdict.heights.desk ?? "?").padStart(8)}  ${String(verdict.heights.phone ?? "?").padStart(8)}  ${hero}  ${bar(verdict.counts.prose).padStart(5)}  ${bar(verdict.counts.owners).padStart(5)}  ${bar(verdict.counts.kpis).padStart(8)}  ${bar(verdict.counts.touch).padStart(5)}`,
    );
  }
  return lines.join("\n");
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(HELP);
    return;
  }

  try { options.chrome = await resolveAuditBrowser(options.chrome); }
  catch (error) { console.error(error.message); process.exitCode = 2; return; }

  const measured = new Map();
  const unmeasurable = [];
  const collectOptions = { skipProseTags: SKIP_PROSE_TAGS };
  // Resolved once, on the first viewport's page, so both viewports measure the
  // same site.
  let routes = options.routes.some((route) => route.includes(SITE_TOKEN))
    ? null
    : options.routes;

  for (const viewport of [DESK_VIEWPORT, PHONE_VIEWPORT]) {
    try {
      await withChromePage(options.chrome, viewport, async (page) => {
        // The override, not --window-size, is what guarantees the CSS viewport:
        // headless Chrome shaves browser UI off the window it was asked for, and
        // the desk's phone layout is a viewport media query.
        await page.send("Emulation.setDeviceMetricsOverride", {
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: 1,
          mobile: viewport.name === "phone",
        });
        await page.send("Runtime.enable");
        await page.send("Page.enable");

        if (routes === null) {
          const site = options.asset ?? (await listedSite(page, options));
          if (site === null) {
            console.error(`No site is listed on ${options.url}/assets, so the site pages are skipped. Pass --asset <id> to choose one.`);
          }
          routes = siteRoutes(options.routes, site);
        }

        for (const route of routes) {
          const target = `${options.url}${route}`;
          await page.send("Page.navigate", { url: target });
          const ready = await settle(page, options);
          if (!ready) {
            unmeasurable.push(`${route} never rendered at ${viewport.width}px`);
            continue;
          }
          let reading;
          try {
            reading = await page.evaluate(measureExpression(collectOptions));
            // A skeleton the settle loop believed — nothing on the page, or
            // nothing past the fold. Wait it out once more rather than
            // recording it.
            if (readSkeletal(reading)) {
              await settle(page, options);
              reading = await page.evaluate(measureExpression(collectOptions));
            }
          } catch (error) {
            unmeasurable.push(`${route} at ${viewport.width}px: ${error.message}`);
            continue;
          }
          if (readEmpty(reading)) {
            unmeasurable.push(
              `${route} at ${viewport.width}px rendered no content (still loading, or the route errored)`,
            );
            continue;
          }
          const entry = measured.get(route) ?? { route };
          entry[viewport.name] = reading;
          measured.set(route, entry);
        }

      });
    } catch (error) {
      console.error(`Could not measure at ${viewport.width}px: ${error.message}`);
      process.exitCode ||= 2;
      return;
    }
  }

  if (unmeasurable.length > 0) {
    console.error(
      `Could not measure ${unmeasurable.length} route/viewport pair(s). Is the Tower running (pnpm os:up)?`,
    );
    for (const reason of unmeasurable) console.error(`  ${reason}`);
    process.exitCode = 2;
    return;
  }

  const verdicts = routes.map((route) =>
    routeVerdict(measured.get(route) ?? { route }, {
      route,
      strict: options.strict,
    }),
  );
  const summary = summarize(verdicts);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          url: options.url,
          strict: options.strict,
          viewports: [DESK_VIEWPORT, PHONE_VIEWPORT],
          summary,
          verdicts,
          measured: Object.fromEntries(measured),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `Surface audit — ${options.url} · desk ${DESK_VIEWPORT.width}×${DESK_VIEWPORT.height}, phone ${PHONE_VIEWPORT.width}×${PHONE_VIEWPORT.height}${options.strict ? " · strict" : ""}`,
    );
    console.log("");
    console.log(formatTable(verdicts));
    // What each surface is still waiting on, above the offenders and separate
    // from them: these routes pass.
    for (const verdict of verdicts) {
      if (!verdict.pending?.length) continue;
      console.log(
        `\n${verdict.route} — ${verdict.pending.length} number(s) declare no series yet: ` +
          verdict.pending.map((one) => one.label).join(", "),
      );
      for (const one of verdict.pending) {
        if (one.reason) console.log(`  ${one.label.padEnd(18)}${one.reason}`);
      }
    }
    for (const verdict of verdicts) {
      if (verdict.ok) continue;
      console.log(`\n${verdict.route} — ${verdict.counts.total} offender(s):`);
      for (const offender of verdict.offenders.slice(0, 12)) {
        const size =
          offender.rule === "touch-target"
            ? `  ${offender.width}×${offender.height}px`
            : "";
        console.log(`  ${offender.rule.padEnd(18)}${offender.where}${size}`);
        if (offender.text) console.log(`    “${offender.text}”`);
      }
      if (verdict.offenders.length > 12) {
        console.log(`  … and ${verdict.offenders.length - 12} more (--json for all)`);
      }
    }
    console.log(
      `\n${summary.ok ? "MEETS doc 14" : "DOES NOT MEET doc 14"} — ${summary.failing} of ${summary.routes} route(s) with offenders: ` +
        `${summary.totals.hero} hero, ${summary.totals.prose} prose, ${summary.totals.owners} chip/path, ${summary.totals.kpis} number without a series, ${summary.totals.touch} under ${TOUCH_FLOOR}px.` +
        (summary.totals.pending
          ? ` ${summary.totals.pending} number(s) declare no series yet.`
          : ""),
    );
  }

  process.exitCode = summary.ok ? 0 : 1;
}

const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  await main();
}
