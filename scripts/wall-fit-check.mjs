#!/usr/bin/env node
// Does the Wall still FIT the TV? Measures the LIVE Tower's /wall at the DietPi
// kiosk's exact CSS viewport (1920×1080) and fails when wall content spills past
// it on either axis. `--viewports laptops` measures the screens that draw the
// TV's layout scaled, 1280×720 to 1920×1080, one after another (bead
// ro-trai.31).
//
// Why this exists (bead ro-wb5d): the fit-at-1080 contract has broken twice on
// DATA growth alone — a sixth property began reporting and stacked column 5 past
// the fold, and DailyBars' nowrap week labels painted 7px past the viewport
// without moving a single element box. Neither is visible to the jsdom suite,
// which has no layout at all; only a real engine at the real geometry can see it.
//
// Why it does NOT read the document's scroll size: at TV geometry .wall-root
// clips to height:100vh/overflow:hidden (apps/tower/src/index.css — the accepted
// backstop, so the kiosk never grows a scrollbar), which makes the document
// report a perfect fit no matter how far content spills. This measures CONTENT:
//   · every element box under .wall-root, in page coordinates;
//   · every text run, through Range rects — the only way to see glyph overflow,
//     which moves no element box and so is invisible to a rect scan;
//   · .wall-root's own scrollWidth/scrollHeight (a clipping box still reports the
//     content it hides), plus the scrollWidth/scrollHeight-over-clientWidth delta
//     of any descendant whose own overflow is still visible.
//
// Overflow that an ancestor INSIDE the wall genuinely clips is not a leak — that
// is the fix — so every candidate rect is intersected with the padding box of
// each clipping ancestor below .wall-root. The wall-root clip itself is
// deliberately NOT applied: making it unnecessary is the whole point.
//
// Needs the live Tower and an installed testing browser, so this is an operator/agent tool and
// NOT part of `pnpm test`. See scripts/README.md.

import fs from "node:fs/promises";
import path from "node:path";
import { measureWallFit, wallFitVerdict } from "./wall-fit-measure.mjs";
import { resolveAuditBrowser } from "./audit-browser.mjs";
import { withChromePage } from "./surface-audit.mjs";

const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function pixels(name, fallback) {
  const value = Number(option(name, String(fallback)));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return Math.round(value);
}

/** The screens the TV's layout is drawn on, scaled (bead ro-trai.31,
 * docs/14-design.md § Laptop, tablet and phone): the 16:9 laptops, the
 * 16:10 MacBooks as Chrome leaves them, and the TV itself. */
const LAPTOP_VIEWPORTS = ["1280x720", "1366x768", "1440x900", "1470x830", "1512x860", "1728x1000", "1920x1080"];

if (args.includes("--help")) {
  console.log(`Measure whether the live Wall fits the TV's 1920×1080 viewport.

The Tower must be running (pnpm os:up, or apps/tower's dev server) and an installed
testing browser must be launchable. Exit 0 = fits, 1 = content spills past the viewport,
2 = could not measure (no Chrome, no Tower, wrong geometry).

Options:
  --url URL         wall url (default http://127.0.0.1:5173/wall)
  --width PX        viewport width (default 1920)
  --height PX       viewport height (default 1080)
  --viewports LIST  several screens, one after another, the worst exit wins:
                    comma-separated WxH; "laptops" in the list stands for the
                    screens that draw the TV's layout scaled (bead ro-trai.31):
                    ${LAPTOP_VIEWPORTS.join(", ")}
  --samples N       measurements to take; the WORST wins (default 3). Live
                    users and the feed land after first paint, so one snapshot is not the wall.
  --settle-ms MS    pause between samples (default 700)
  --ready-ms MS     how long to wait for wall data (default 30000)
  --strict          also fail on unclipped overflow that stays inside the
                    viewport — a leak one site away from the edge — and on
                    text a region cuts off sideways
  --screenshot PATH write a PNG of what was measured
  --json            print the raw measurement instead of the summary
  --chrome PATH     explicit browser override (default: installed journey Chromium)
`);
  process.exit(0);
}

const url = option("--url", "http://127.0.0.1:5173/wall");
const listed = option("--viewports", "");
const viewports = listed.split(",").filter(Boolean).flatMap((item) => (item === "laptops" ? LAPTOP_VIEWPORTS : [item])).map((size) => {
  const [w, h] = size.split("x").map(Number);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) throw new Error(`--viewports: "${size}" is not WxH`);
  return { width: Math.round(w), height: Math.round(h) };
});
if (viewports.length === 0) viewports.push({ width: pixels("--width", 1920), height: pixels("--height", 1080) });
const widest = viewports.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
const samples = pixels("--samples", 3);
const settleMs = pixels("--settle-ms", 700);
const readyMs = pixels("--ready-ms", 30000);
const strict = args.includes("--strict");
const asJson = args.includes("--json");
const screenshotPath = option("--screenshot", "");
const chromeOverride = option("--chrome", null);

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** What the page measures: the one function the Wall journeys run too
 * (scripts/wall-fit-measure.mts, bead ro-trai.12), serialized into the page. */
const MEASURE_SOURCE = `(${measureWallFit.toString()})()`;

function fail(message) {
  throw new Error(message);
}

/** Late data (GA4 realtime, a feed arrival) lands after
 * first paint, so a single frame is not the wall: content height moves between
 * samples. Worst sample per axis wins, the regions and site rows are read from
 * the TALLEST frame rather than the first one, and the offender lists are unioned
 * so a leak that only shows in one frame still gets named. */
function worstCase(list) {
  // By the PAINTED edge, not content.bottom: the wall-root clip floors every
  // sample's scrollHeight at 100vh, so content.bottom ties and would always hand
  // back the first frame — the one measured before late data landed.
  const tallest = list.reduce(
    (worst, take) => (take.tight.bottom > worst.tight.bottom ? take : worst),
    list[0],
  );
  const merged = {
    ...tallest,
    content: {
      right: Math.max(...list.map((take) => take.content.right)),
      bottom: Math.max(...list.map((take) => take.content.bottom)),
    },
    tight: {
      right: Math.max(...list.map((take) => take.tight.right)),
      bottom: Math.max(...list.map((take) => take.tight.bottom)),
    },
    spread: list.map((take) => ({
      right: take.tight.right,
      bottom: take.tight.bottom,
    })),
    offenders: { x: [], y: [] },
    ink: [],
    clipped: [],
  };
  const collect = (pick, key) => {
    const seen = new Map();
    for (const take of list) {
      for (const item of pick(take)) {
        const existing = seen.get(item.el + item.kind + item.axis);
        if (!existing || item[key] > existing[key]) seen.set(item.el + item.kind + item.axis, item);
      }
    }
    return [...seen.values()].sort((a, b) => b[key] - a[key]);
  };
  merged.offenders.x = collect((take) => take.offenders.x, "by");
  merged.offenders.y = collect((take) => take.offenders.y, "by");
  merged.ink = collect((take) => take.ink, "delta");
  merged.clipped = collect((take) => take.clipped ?? [], "delta");
  merged.worst = {
    x: merged.offenders.x[0] ?? null,
    y: merged.offenders.y[0] ?? null,
  };
  return merged;
}

/** One screen: navigate at its size, measure, report. Returns the exit code
 * this screen alone would give (0 fits, 1 does not). */
async function checkAt(page, { width, height }) {
  // The override, not --window-size, is what guarantees the CSS viewport: headless
  // Chrome shaves browser UI off the window it was asked for, and the wall's
  // geometry gates are viewport media queries. Set before navigating so the first
  // layout is already the screen's.
  await page.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.send("Page.navigate", { url });

  let ready = false;
  let readyError = "";
  for (let waited = 0; waited < readyMs; waited += 250) {
    await wait(250);
    ready = await page
      .evaluate(
        // D28's widgets, drawn by the canvas once the payload arrived (epic
        // ro-trai; the header row left the Wall with bead ro-trai.11).
        `!!document.querySelector('[data-wall-canvas]') && document.querySelectorAll('[data-wall-strip], [data-wall-revenue], [data-wall-needs], [data-wall-sites], [data-wall-feed]').length > 0`,
      )
      .catch((error) => {
        readyError = error.message;
        return false;
      });
    if (ready) break;
  }
  if (!ready) {
    fail(
      `The wall never rendered its data at ${url} within ${readyMs}ms. Is the Tower running (pnpm os:up)?${readyError ? `\n${readyError}` : ""}`,
    );
  }
  await wait(settleMs);

  const takes = [];
  for (let sample = 0; sample < samples; sample++) {
    if (sample > 0) await wait(settleMs);
    const measured = await page.evaluate(MEASURE_SOURCE).catch((error) => {
      fail(error.message);
    });
    if (measured?.error) fail(measured.error);
    takes.push(measured);
  }

  if (screenshotPath) {
    const shot = await page.send("Page.captureScreenshot", { format: "png" });
    if (shot.result?.data) {
      // One file per screen when there are several: wall.png → wall-1470x830.png.
      const file = viewports.length > 1 ? screenshotPath.replace(/(\.png)?$/i, `-${width}x${height}.png`) : screenshotPath;
      await fs.writeFile(path.resolve(file), Buffer.from(shot.result.data, "base64"));
    }
  }

  const report = worstCase(takes);
  const verdict = wallFitVerdict(report);
  const { fits, overWidth, overHeight } = verdict;
  const inkLeaks = report.ink.length;
  const clippedRuns = report.clipped.length;

  if (asJson) {
    console.log(JSON.stringify({ url, samples, fits, report }, null, 2));
  } else {
    const axis = (name, edge, budget, over) =>
      `  ${name.padEnd(12)}painted ${String(edge).padStart(5)}px  budget ${budget}px  ${over > 0 ? `OVER by ${over}px` : `${budget - edge}px spare`}`;
    console.log(
      `Wall fit at ${report.viewport.width}×${report.viewport.height} — ${url} (${samples} samples, worst wins)`,
    );
    console.log(
      axis(
        "horizontal",
        overWidth > 0 ? report.content.right : report.tight.right,
        report.viewport.width,
        overWidth,
      ),
    );
    console.log(
      axis(
        "vertical",
        overHeight > 0 ? report.content.bottom : report.tight.bottom,
        report.viewport.height,
        overHeight,
      ),
    );
    console.log(
      `  spread      ${report.spread.map((take) => `${take.right}×${take.bottom}`).join("  ")}`,
    );
    // Which Wall this screen drew (bead ro-trai.31): the TV's layout, scaled on
    // a laptop or a landscape tablet, or one column on a portrait screen.
    if (report.layout === "tv" && report.scale < 1) {
      console.log(`  layout      the TV's, scaled to ${Math.round(report.scale * 1000) / 10} %`);
    } else if (report.layout === "stack") {
      console.log("  layout      one column (a portrait tablet or a phone)");
    } else if (!report.tvMediaQuery) {
      console.log("  note        the TV geometry media query did NOT match at this size");
    }
    for (const [name, offenders] of [
      ["horizontal", report.offenders.x],
      ["vertical", report.offenders.y],
    ]) {
      if (offenders.length === 0) continue;
      console.log(`\n${offenders.length} ${name} offender(s), worst first:`);
      for (const item of offenders.slice(0, 6)) {
        const edge = item.right ?? item.bottom;
        console.log(`  +${String(item.by).padStart(5)}px at ${edge}px  ${item.kind.padEnd(11)} ${item.el}`);
        if (item.text) console.log(`             “${item.text}”`);
      }
    }
    if (inkLeaks > 0) {
      console.log(
        `\n${inkLeaks} element(s) paint outside their own box without being clipped${strict ? " (--strict: this fails)" : " (inside the viewport, so not a fit failure yet)"}:`,
      );
      for (const item of report.ink.slice(0, 6)) {
        console.log(`  ${item.axis} +${item.delta}px  ${item.el}`);
        if (item.text) console.log(`             “${item.text}”`);
      }
    }
    if (clippedRuns > 0) {
      console.log(
        `\n${clippedRuns} text run(s) a region cuts off sideways${strict ? " (--strict: this fails)" : " (inside the viewport, so not a fit failure yet)"}:`,
      );
      for (const item of report.clipped.slice(0, 6)) {
        console.log(`  x -${item.delta}px  ${item.el}`);
        if (item.text) console.log(`             “${item.text}”`);
      }
    }
    // Actual occupancy, not a prediction: optional totals and flexible rows
    // make the current row heights unsuitable as a future capacity estimate.
    const box = (b) => (b ? `${b.top}–${b.bottom} (${b.height} px)` : "not drawn");
    console.log("\nD28 regions, tallest frame:");
    for (const name of ["strip", "revenue", "needs", "sites", "feed"]) {
      console.log(`  ${name.padEnd(8)}${box(report.regions[name])}`);
    }
    const { density, rows, spare } = report.sites;
    if (density === "focus") {
      console.log(`  site rows   one site, in depth (tiles, no rows)`);
    } else if (rows.length > 0) {
      console.log(`  site rows   ${rows.length} × ${[...new Set(rows.map((row) => row.height))].join("/")} px (${density}), ${spare} px spare under them`);
    }
    if (report.feed.lastRowWhole !== null) {
      console.log(`  feed        ${report.feed.shown} rows, ${report.feed.lastRowWhole ? "the lowest whole" : "the lowest CUT OFF"}`);
    }
    console.log(
      `\n${fits ? "FITS" : "DOES NOT FIT"} — the TV clip in apps/tower/src/index.css is ${fits ? "unnecessary at this data" : "all that keeps the kiosk scrollbar-free"}.`,
    );
  }

  if (!fits) return 1;
  if (strict && (inkLeaks > 0 || clippedRuns > 0)) return 1;
  return 0;
}

try {
  const chromeBinary = await resolveAuditBrowser(chromeOverride);
  const worst = await withChromePage(chromeBinary, widest, async page => {
    await page.send("Runtime.enable");
    await page.send("Page.enable");
    let worst = 0;
    for (const [index, viewport] of viewports.entries()) {
      if (index > 0 && !asJson) console.log("");
      worst = Math.max(worst, await checkAt(page, viewport));
    }
    return worst;
  });
  if (viewports.length > 1 && !asJson) {
    console.log(`\n${worst === 0 ? "EVERY SCREEN FITS" : "A SCREEN DOES NOT FIT"} — ${viewports.map(v => `${v.width}×${v.height}`).join(", ")}`);
  }
  process.exitCode = worst;
} catch (error) {
  console.error(error.message);
  process.exitCode ||= 2;
}
