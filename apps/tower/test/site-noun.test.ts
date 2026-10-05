import { describe, expect, it } from "vitest";
import { siteCount, siteNoun } from "@shared/site-noun";

describe("the count of sites (D31, beads ro-ujb9.142 and ro-ujb9.130)", () => {
  it("says site for exactly one and sites for every other count", () => {
    expect(siteCount(1)).toBe("1 site");
    expect(siteCount(2)).toBe("2 sites");
    expect(siteCount(0)).toBe("0 sites");
    expect(siteNoun(1)).toBe("site");
    expect(siteNoun(12)).toBe("sites");
  });
});
