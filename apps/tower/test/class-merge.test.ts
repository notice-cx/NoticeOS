// The class combiner keeps every type step index.css adds (bead ro-trai.23).
// tailwind-merge took `text-wall-body` for a colour, so a call that also set a
// text colour silently dropped the size: every Wall feed line drew at whatever
// size it inherited. These read the theme itself, so a step added to index.css
// without teaching `cn` fails here rather than on the TV.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { THEME_TEXT_SIZES, cn } from "@/lib/utils";

const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/index.css"), "utf8");
/** Every `--text-<name>:` the theme declares, less its `--line-height` twins. */
const sizes = [...new Set([...css.matchAll(/--text-([a-z0-9-]+?):/g)].map((match) => match[1]!))].filter(
  (name) => !name.endsWith("-") && !name.includes("--"),
);
/** Every text colour the theme declares (`--color-<name>:`). */
const colours = [...new Set([...css.matchAll(/--color-([a-z0-9-]+):/g)].map((match) => match[1]!))];

describe("cn keeps the theme's type steps", () => {
  it("names exactly the type steps index.css declares", () => {
    expect(sizes.length).toBeGreaterThan(10);
    expect([...THEME_TEXT_SIZES].sort()).toEqual([...sizes].sort());
  });

  it("keeps the size and the colour when one call sets both, in either order", () => {
    expect(cn("text-wall-body", "text-muted-foreground")).toBe("text-wall-body text-muted-foreground");
    for (const size of sizes) {
      for (const colour of colours) {
        expect(cn(`text-${size}`, `text-${colour}`)).toBe(`text-${size} text-${colour}`);
        expect(cn(`text-${colour}`, `text-${size}`)).toBe(`text-${colour} text-${size}`);
      }
    }
  });

  it("still lets a later size replace an earlier one", () => {
    expect(cn("text-wall-body", "text-wall-stat")).toBe("text-wall-stat");
    expect(cn("text-sm", "text-wall-body")).toBe("text-wall-body");
    expect(cn("text-wall-micro", "text-xs")).toBe("text-xs");
  });

  it("keeps the TV size and the muted colour in the two calls bead ro-ujb9.96.12 measured", () => {
    // The old Wall card's report age: "No nightly report" lost its muted
    // colour, and "Nightly 12h ago" its TV size, when `cn` took the size for
    // a colour. That card left with ro-trai.20; the merge stays fixed for
    // every call site, here in the bead's own words.
    expect(cn("shrink-0 text-muted-foreground", "text-wall-body")).toBe("shrink-0 text-muted-foreground text-wall-body");
    expect(cn("shrink-0 tabular-nums", "text-wall-body", "text-muted-foreground")).toBe(
      "shrink-0 tabular-nums text-wall-body text-muted-foreground",
    );
  });

  it("draws the feed line and a chart caption at their own sizes", () => {
    // The two calls that lost their size (WallFeed's line, Spark's caption).
    expect(cn("line-clamp-2 text-wall-body", "text-muted-foreground")).toBe("line-clamp-2 text-wall-body text-muted-foreground");
    expect(cn("mt-1 text-wall-micro tabular-nums text-muted-foreground", false)).toBe(
      "mt-1 text-wall-micro tabular-nums text-muted-foreground",
    );
  });
});
