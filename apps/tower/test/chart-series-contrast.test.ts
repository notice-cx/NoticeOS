// A CHART'S LINES AND KEYS ARE READABLE IN BOTH THEMES (bead ro-ujb9.12).
// Every colour a desk chart draws a series in must clear WCAG 2.2's 3:1 for
// graphics against the card it sits on (1.4.11), and every word of its key
// 4.5:1 (1.4.3). The financial trio — revenue, cost, net — must also stay
// apart from one another to the eye and under colour-blind simulation, with
// their line patterns as the second, colourless cue. Measured from the two
// stylesheets, so a token change that breaks a chart fails here first; the
// numbers are recorded in docs/14-ui-standards.md § Tokens.
import { describe, expect, it } from "vitest";
import { SERIES_TONE_CLASS } from "@/components/surface/Sparkline";
import { contrastRatio, distance, over, simulate, themeColours, type Theme } from "./palette";

const colour = themeColours();
const THEMES: Theme[] = ["dark", "light"];
const round = (value: number) => Math.round(value * 100) / 100;

/** The CSS variable behind each `SeriesTone`, read off its utility class
 * (`text-financial-revenue` → `--financial-revenue`), so a new tone is
 * measured the day it is added. */
const SERIES_TOKENS = Object.fromEntries(Object.entries(SERIES_TONE_CLASS).map(([tone, cls]) => {
  const name = cls.replace(/^text-/, "");
  return [tone, `--${name === "spark" ? "spark" : name}`];
}));

describe("chart series ink on the desk card", () => {
  for (const mode of THEMES) {
    it(`${mode}: every series tone clears 3:1 against the card`, () => {
      const card = colour(mode, "--card");
      const measured = Object.entries(SERIES_TOKENS).map(([tone, token]) => ({ tone, ratio: round(contrastRatio(colour(mode, token), card)) }));
      expect(measured.filter((one) => one.ratio < 3)).toEqual([]);
    });

    it(`${mode}: the key's words clear 4.5:1 and the reference line 3:1`, () => {
      const card = colour(mode, "--card");
      expect(contrastRatio(colour(mode, "--foreground"), card)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(colour(mode, "--muted-foreground"), card)).toBeGreaterThanOrEqual(4.5);
      // A reference (same weekday last week) is quiet ink at full strength:
      // thinner than the lead, never fainter than a graphic may be.
      expect(contrastRatio(colour(mode, "--spark"), card)).toBeGreaterThanOrEqual(3);
    });

    it(`${mode}: the daily values under an average stay visible but below the average`, () => {
      const card = colour(mode, "--card");
      for (const token of ["--foreground", "--search-bing", "--financial-revenue"]) {
        const lead = contrastRatio(colour(mode, token), card);
        const raw = contrastRatio(over(colour(mode, token), 0.5, card), card);
        expect(raw, token).toBeGreaterThan(1.5);
        expect(raw, token).toBeLessThan(lead);
      }
    });

    it(`${mode}: revenue, cost and net stay apart to the eye and to colour-blind vision`, () => {
      const trio = { currency: 'USD', revenue: "--financial-revenue", cost: "--financial-cost", net: "--foreground" } as const;
      const pairs = [["revenue", "cost"], ["revenue", "net"], ["cost", "net"]] as const;
      const measured = pairs.map(([a, b]) => {
        const x = colour(mode, trio[a]);
        const y = colour(mode, trio[b]);
        return {
          pair: `${a}/${b}`,
          normal: Math.round(distance(x, y) * 10) / 10,
          colourBlind: Math.round(Math.min(distance(simulate(x, "protan"), simulate(y, "protan")),
            distance(simulate(x, "deutan"), simulate(y, "deutan"))) * 10) / 10,
        };
      });
      // The validator's floors: 15 apart to the eye for series that meet on one
      // chart, and 6 colour-blind — legal because solid, dashed and dotted
      // carry the same distinction without colour.
      expect(measured.filter((one) => one.normal < 15 || one.colourBlind < 6)).toEqual([]);
    });
  }
});
